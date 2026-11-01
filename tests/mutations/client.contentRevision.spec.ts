import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IndexedDbAdapter } from '../../src/adapters/indexedDbAdapter';
import { upgradeClientTables } from '../../src/features/sync/mutations/client';
import { packMutations, requestBytes } from '../../src/features/sync/mutations/packing';
import type { RowComposer, RowPolicy } from '../../src/features/sync/mutations/rows';
import { MutationServer } from '../../src/features/sync/mutations/server';
import { createSqlGroup, dropSqlGroup } from '../../src/features/sync/mutations/sqlStore';
import { PROTOCOL, type PushRequest } from '../../src/features/sync/mutations/wire';
import { backends } from './backends';
import { browser, hex, settle, world, type Browser, type World } from './harness';

const BACKENDS = await backends();

/** "content|tag,tag", as the rows suite reads it. */
const composer: RowComposer = {
  contentOf: (value) => value.split('|')[0] ?? '',
  compose: (current, content, change) => {
    const [base = '', list = ''] = current.split('|');
    let tags = list === '' ? [] : list.split(',');
    if (change !== null) {
      const { add, remove } = JSON.parse(change) as { add: string[]; remove: string[] };
      tags = tags.filter((tag) => !remove.includes(tag));
      for (const tag of add) if (!tags.includes(tag)) tags.push(tag);
    }
    return `${content ?? base}|${tags.join(',')}`;
  },
  deltaOf: (before, after) => {
    const was = (before.split('|')[1] ?? '').split(',').filter((tag) => tag !== '');
    const now = (after.split('|')[1] ?? '').split(',').filter((tag) => tag !== '');
    const add = now.filter((tag) => !was.includes(tag));
    const remove = was.filter((tag) => !now.includes(tag));
    return add.length === 0 && remove.length === 0 ? null : JSON.stringify({ add, remove });
  },
  sameClaim: (current, incoming) => current === incoming,
};

/** The rows suite's naming: a copy names its content and keeps its tags, so a delta still lands on the copy's tag list. */
const policy: Partial<RowPolicy> = {
  composer,
  copyValue: (value) => {
    const [text = '', tags = ''] = value.split('|');
    return `${text} (copy)|${tags}`;
  },
};

/** The pending mutations a browser holds. */
async function pendingOf(b: Browser): Promise<Array<{ name: string; args: Record<string, unknown> }>> {
  return (await b.adapter.all<{ name: string; args: string }>('SELECT name, args FROM sync_pending ORDER BY mutation_id')).map((row) => ({ name: row.name, args: JSON.parse(row.args) as Record<string, unknown> }));
}

describe.each(BACKENDS.map((backend) => [backend.name, backend] as const))('content revisions through the client, the server on %s', (_name, backend) => {
  let w: World;
  const open = (): Promise<Browser> => browser(w, { clientPolicy: policy });

  beforeEach(async () => {
    w = await world(backend, { policy });
  });
  afterEach(async () => {
    await w.close();
  });

  /** Two browsers claim one id with different text: a's lands, and b keeps its own aside as occupied, out of its page. */
  const occupiedClaim = async (): Promise<{ a: Browser; b: Browser; id: string }> => {
    const a = await open();
    const b = await open();
    await a.join();
    await b.join();
    await a.client.save({ rows: [{ id: hex(7), value: 'copy|', claim: true }], write: async () => undefined });
    await settle(a);
    await b.client.save({ rows: [{ id: hex(7), value: 'copy|x', claim: true }], write: async () => undefined });
    await settle(b, a);
    const kept = (await b.client.snapshot()).kept;
    expect(kept.map((row) => [row.reason, row.value])).toEqual([['occupied', 'copy|x']]);
    expect(await b.values()).toEqual(['copy|']);
    return { a, b, id: kept[0]!.id };
  };

  it.each(['tags', 'content'] as const)('lands a tags-only save and a content save from one base when the %s push comes first', async (first) => {
    const a = await open();
    await a.join();
    await a.save([{ id: hex(1), value: 'text|' }]);
    await settle(a);
    const b = await open();
    await b.join();
    await a.save([{ id: hex(1), value: 'text|budget' }]);
    await b.save([{ id: hex(1), value: 'new text|' }]);
    const [one, two] = first === 'tags' ? [a, b] : [b, a];
    await one.client.push();
    await two.client.push();
    await settle(a, b);
    expect(await a.values()).toEqual(['new text|budget']);
    expect(await b.values()).toEqual(['new text|budget']);
    expect((await a.client.snapshot()).kept).toEqual([]);
    expect((await b.client.snapshot()).kept).toEqual([]);
  });

  it('plans an amend: a delta alone for a tags-only save, content and its base for a content save', async () => {
    const a = await open();
    await a.join();
    await a.save([{ id: hex(1), value: 'text|' }]);
    await settle(a);
    await a.save([{ id: hex(1), value: 'text|budget' }]);
    await a.save([{ id: hex(1), value: 'other|budget' }]);
    const [tags, text] = await pendingOf(a);
    expect(tags).toMatchObject({ name: 'amend', args: { content: null, delta: JSON.stringify({ add: ['budget'], remove: [] }) } });
    expect(text).toMatchObject({ name: 'amend', args: { content: 'other', delta: null } });
    expect(text!.args.expectedContent).toEqual(tags!.args.expectedContent);
  });

  it('keeps three dependent pending edits on their conflict copy in rebase and on the server', async () => {
    const a = await open();
    await a.join();
    await a.save([{ id: hex(1), value: 'text|' }]);
    await settle(a);
    const b = await open();
    await b.join();
    await a.save([{ id: hex(1), value: 'theirs|' }]);
    await settle(a);
    await b.save([{ id: hex(1), value: 'mine|' }]);
    await b.save([{ id: hex(1), value: 'mine|x' }]);
    await b.save([{ id: hex(1), value: 'mine|x,y' }]);
    await b.client.pull(); // replay all three over the other browser's content
    const rebased = (await b.client.snapshot()).visible;
    expect(rebased.find((row) => row.id === hex(1))?.value).toBe('theirs|');
    const copy = rebased.find((row) => row.id !== hex(1));
    expect(copy?.value.endsWith('|x,y')).toBe(true);
    await settle(b, a);
    for (const client of [a, b]) {
      const visible = (await client.client.snapshot()).visible;
      expect(visible.find((row) => row.id === hex(1))?.value).toBe('theirs|');
      expect(visible.find((row) => row.id === copy!.id)?.value).toBe(copy!.value);
      expect(visible).toHaveLength(2);
    }
  });

  it('rebases a delete through its identical claim no-op using the existing whole revision', async () => {
    const a = await open();
    const b = await open();
    await a.join();
    await b.join();
    await a.save([{ id: hex(1), value: 'text|' }]);
    await settle(a);
    await b.client.save({ rows: [{ id: hex(1), value: 'text|', claim: true }], write: async () => undefined });
    await b.save([]);
    await b.client.pull();
    expect((await b.client.snapshot()).visible).toEqual([]);
    await settle(b, a);
    expect(await a.values()).toEqual([]);
    expect((await b.client.snapshot()).kept).toEqual([]);
  });

  it.each([
    ['push-first', 'different'], ['pull-first', 'different'],
    ['push-first', 'edited'], ['pull-first', 'edited'],
    ['push-first', 'tombstone'], ['pull-first', 'tombstone'],
  ] as const)('keeps an occupied claim and its dependent value with %s and %s', async (order, occupied) => {
    const a = await open();
    let b = await open();
    await a.join();
    await b.join();
    await a.client.save({ rows: [{ id: hex(7), value: 'copy|', claim: true }], write: async () => undefined });
    await settle(a);
    if (occupied === 'edited') await a.save([{ id: hex(7), value: 'edited|' }]);
    if (occupied === 'tombstone') await a.save([]);
    await settle(a);
    const serverValue = occupied === 'tombstone' ? undefined : occupied === 'edited' ? 'edited|' : 'copy|';
    await b.client.save({ rows: [{ id: hex(7), value: 'copy|x', claim: true }], write: async () => undefined });
    await b.client.save({ rows: [{ id: hex(7), value: 'copy|x,y' }], write: async () => undefined });
    if (order === 'pull-first') {
      await b.client.pull();
      expect((await b.client.snapshot()).visible.find((row) => row.id === hex(7))?.value).toBe(serverValue);
      b = b.reopen();
      await b.client.open();
    }
    await settle(b, a);
    const snapshot = await b.client.snapshot();
    expect(snapshot.visible.filter((row) => row.id === hex(7)).map((row) => row.value)).toEqual(serverValue === undefined ? [] : [serverValue]);
    expect(snapshot.kept.map((row) => [row.reason, row.value])).toEqual([['occupied', 'copy|x,y']]);
    expect((await w.opened.adapter.all<{ id: string }>(`SELECT id FROM ${w.opened.prefix}rows`)).map((row) => row.id)).toEqual([hex(7)]);
    expect(snapshot.pending).toBe(0);
    await settle(b);
    expect((await b.client.snapshot()).kept).toEqual(snapshot.kept);
    const visible = (await b.client.snapshot()).visible.map(({ id, value }) => ({ id, value }));
    await b.client.save({ rows: [...visible, { id: hex(8), value: 'unrelated|' }], write: async () => undefined });
    await settle(b, a);
    const reloaded = b.reopen();
    await reloaded.client.open();
    expect((await reloaded.client.snapshot()).kept).toEqual(snapshot.kept);
    expect((await reloaded.client.snapshot()).pending).toBe(0);
  });

  it('retires a protocol 1 queue on upgrade: its pending values kept for recovery, a new client id, the next push of protocol 2', async () => {
    const a = await open();
    await a.join();
    await a.save([{ id: hex(9), value: 'archived|' }]);
    await settle(a);
    await a.save([]);
    await settle(a); // the earlier payload is in the journal alone, acknowledged
    await a.save([{ id: hex(1), value: 'one|' }, { id: hex(2), value: 'two|' }]);
    const before = (await a.client.snapshot()).membership;
    const journal = await a.adapter.all('SELECT mutation_id, name, args, incoming_value FROM sync_journal WHERE client_id = ? ORDER BY mutation_id', [before.clientId]);
    await a.adapter.run('UPDATE sync_membership SET protocol = 1');
    const reloaded = a.reopen();
    await reloaded.client.open();
    const after = await reloaded.client.snapshot();
    expect(after.pending).toBe(0);
    expect(after.membership.clientId).not.toBe(before.clientId);
    // only the pending values: an acknowledged one is the account's, and stays in the journal alone
    expect(after.kept.map((row) => [row.reason, row.value]).sort()).toEqual([['recovery', 'one|'], ['recovery', 'two|']]);
    expect(await a.adapter.all('SELECT mutation_id, name, args, incoming_value FROM sync_journal WHERE client_id = ? ORDER BY mutation_id', [before.clientId])).toEqual(journal);
    expect((await a.adapter.all<{ incoming_value: string | null }>('SELECT incoming_value FROM sync_journal WHERE client_id = ?', [before.clientId])).map((record) => record.incoming_value)).toContain('archived|');
    expect(await a.adapter.get('SELECT protocol, next_mutation_id FROM sync_retired_clients WHERE client_id = ?', [before.clientId])).toMatchObject({ protocol: 1, next_mutation_id: before.nextMutationId });
    expect(Number((await a.adapter.get<{ protocol: unknown }>('SELECT protocol FROM sync_membership'))?.protocol)).toBe(PROTOCOL);
    await reloaded.client.open();
    expect((await reloaded.client.snapshot()).membership.clientId).toBe(after.membership.clientId);
    const sent: PushRequest[] = [];
    const push = reloaded.transport.push.bind(reloaded.transport);
    reloaded.transport.push = async (request) => {
      sent.push(request);
      return push(request);
    };
    await reloaded.save([{ id: hex(3), value: 'three|' }]);
    await reloaded.client.push();
    expect(sent.map((request) => request.protocol)).toEqual([PROTOCOL]);
    expect(sent.every((request) => request.clientId === after.membership.clientId)).toBe(true);
    expect(await a.adapter.all('SELECT mutation_id, name, args, incoming_value FROM sync_journal WHERE client_id = ? ORDER BY mutation_id', [before.clientId])).toEqual(journal);
  });

  it('hands the page what retiring a protocol 1 queue changes, so a restored recovery row stays through the next save', async () => {
    const a = await open();
    await a.join();
    await a.save([{ id: hex(1), value: 'one|' }]);
    await a.adapter.run('UPDATE sync_membership SET protocol = 1');
    const reloaded = a.reopen();
    await reloaded.client.open();
    const snapshot = await reloaded.client.snapshot();
    // the page holds what the client shows: the unsent value aside under its recovery id
    expect((await reloaded.blocks()).map(({ id, value }) => [id, value])).toEqual(snapshot.visible.map(({ id, value }) => [id, value]));
    const [kept] = snapshot.kept;
    expect(kept).toMatchObject({ reason: 'recovery', value: 'one|' });
    expect(await reloaded.client.restoreKept(kept!.id)).toBe(true);
    await reloaded.save(await reloaded.blocks());
    await settle(reloaded);
    expect(await reloaded.values()).toEqual(['one|']);
    expect(await w.opened.adapter.all(`SELECT id, state FROM ${w.opened.prefix}rows`)).toEqual([{ id: kept!.id, state: 'live' }]);
  });

  it('takes a whole snapshot when a joined protocol 1 page upgrades, so a row a tags-only amend changed meanwhile has the account\'s content revision', async () => {
    const a = await open();
    const b = await open();
    await a.join();
    await b.join();
    await a.save([{ id: hex(1), value: 'text|' }]);
    await settle(a, b);
    await a.save([{ id: hex(1), value: 'text|budget' }]);
    await settle(a, b);
    const [account] = (await a.client.snapshot()).visible;
    expect(account!.contentRevision).not.toEqual(account!.revision);
    // b as a protocol 1 page holds the row: its whole revision alone, the content revision a protocol 1 pull leaves out
    await b.adapter.run('UPDATE sync_rows SET content_client = NULL, content_mutation = NULL');
    await b.adapter.run('UPDATE sync_results SET content_client = NULL, content_mutation = NULL');
    await b.adapter.run('UPDATE sync_membership SET protocol = 1');
    const reloaded = b.reopen();
    await reloaded.client.open();
    expect((await reloaded.client.snapshot()).pending).toBe(0);
    await reloaded.client.pull();
    expect((await reloaded.client.snapshot()).visible.map((row) => [row.id, row.contentRevision])).toEqual([[hex(1), account!.contentRevision]]);
  });

  it.each(['push-first', 'pull-first'] as const)('keeps the full local block after a tags-only edit is refused removed with %s', async (order) => {
    const a = await open();
    await a.join();
    await a.save([{ id: hex(1), value: 'important text|' }]);
    await settle(a);
    const b = await open();
    await b.join();
    await b.save([{ id: hex(1), value: 'important text|budget' }]);
    await a.save([]);
    await settle(a);
    if (order === 'pull-first') await b.client.pull();
    const reloaded = b.reopen();
    await reloaded.client.open();
    await settle(reloaded);
    const snapshot = await reloaded.client.snapshot();
    expect(snapshot.kept.map((row) => [row.reason, row.value])).toContainEqual(['removed', 'important text|budget']);
    expect(snapshot.pending).toBe(0);
    expect((await a.client.snapshot()).visible).toEqual([]);
  });

  it('stops sending when the server answers protocol_changed, keeping its pending change', async () => {
    const a = await open();
    await a.join();
    w.server = new MutationServer({ ...w.options, protocols: [3] });
    await a.save([{ id: hex(1), value: 'one|' }]);
    expect(await a.client.push()).toEqual({ kind: 'blocked' });
    const snapshot = await a.client.snapshot();
    expect([snapshot.membership.sends, snapshot.pending]).toEqual(['malformed', 1]);
  });

  it('stops sending when a pull is answered protocol_changed, keeping its pending change', async () => {
    const a = await open();
    await a.join();
    await a.save([{ id: hex(1), value: 'one|' }]);
    w.server = new MutationServer({ ...w.options, protocols: [3] });
    expect(await a.client.pull()).toEqual({ kind: 'blocked' });
    const snapshot = await a.client.snapshot();
    expect([snapshot.membership.sends, snapshot.pending]).toEqual(['malformed', 1]);
    expect(await a.client.push()).toEqual({ kind: 'idle' });
  });

  it('answers blocked to a join refused protocol_changed, and leaves the membership off for a newer page', async () => {
    w.server = new MutationServer({ ...w.options, protocols: [3] });
    const a = await open();
    expect(await a.join()).toEqual({ kind: 'blocked' });
    expect((await a.client.snapshot()).membership.state).toBe('off');
  });

  it.each(['edited', 'unchanged'] as const)('keeps a change made on a claim that replayed as a no-op with the claim, the other page\'s row %s', async (other) => {
    const a = await open();
    const b = await open();
    await a.join();
    await b.join();
    await a.client.save({ rows: [{ id: hex(7), value: 'copy|', claim: true }], write: async () => undefined });
    await settle(a);
    await b.client.save({ rows: [{ id: hex(7), value: 'copy|', claim: true }], write: async () => undefined });
    await b.client.pull(); // the claim replays as a no-op over the same value from a
    await b.client.save({ rows: [{ id: hex(7), value: 'copy|x' }], write: async () => undefined });
    if (other === 'edited') {
      await a.save([{ id: hex(7), value: 'edited|' }]);
      await settle(a);
    }
    await settle(b, a);
    const snapshot = await b.client.snapshot();
    expect(snapshot.pending).toBe(0);
    if (other === 'edited') {
      // the claim is refused occupied, and the change made on it goes aside with it, not onto the other page's row
      expect((await a.client.snapshot()).visible.map((row) => row.value)).toEqual(['edited|']);
      expect(snapshot.kept.map((row) => [row.reason, row.value])).toEqual([['occupied', 'copy|x']]);
    } else {
      expect((await a.client.snapshot()).visible.map((row) => row.value)).toEqual(['copy|x']);
      expect(snapshot.kept).toEqual([]);
      expect(snapshot.visible.map((row) => row.value)).toEqual(['copy|x']);
    }
  });

  it('keeps a change made on a claim the account took over other tags with the whole value the page saved, when the claim is refused occupied', async () => {
    // a claim of the same content is the claim's own, whatever its tags
    const loose: Partial<RowPolicy> = { ...policy, composer: { ...composer, sameClaim: (current, incoming) => composer.contentOf(current) === composer.contentOf(incoming) } };
    await w.close();
    w = await world(backend, { policy: loose });
    const a = await browser(w, { clientPolicy: loose });
    const b = await browser(w, { clientPolicy: loose });
    await a.join();
    await b.join();
    await a.client.save({ rows: [{ id: hex(7), value: 'text|server', claim: true }], write: async () => undefined });
    await settle(a);
    await b.client.save({ rows: [{ id: hex(7), value: 'text|local', claim: true }], write: async () => undefined });
    await b.client.pull(); // the claim replays as a no-op over a's value, whose tags the page now shows
    expect((await b.client.snapshot()).visible.map((row) => row.value)).toEqual(['text|server']);
    await b.client.save({ rows: [{ id: hex(7), value: 'text|server,x' }], write: async () => undefined });
    await a.save([{ id: hex(7), value: 'other|server' }]);
    await settle(a);
    await settle(b, a);
    const snapshot = await b.client.snapshot();
    expect(snapshot.kept.map((row) => [row.reason, row.value])).toEqual([['occupied', 'text|server,x']]);
    expect(snapshot.pending).toBe(0);
  });

  it('joins and pulls in protocol 2: a server that takes protocol 2 alone answers them, and the join holds the content revision', async () => {
    w.server = new MutationServer({ ...w.options, protocols: [PROTOCOL] });
    const a = await open();
    expect(await a.join()).toEqual({ kind: 'applied' });
    await a.save([{ id: hex(1), value: 'text|' }]);
    await settle(a);
    await a.save([{ id: hex(1), value: 'text|budget' }]);
    await settle(a);
    const [mine] = (await a.client.snapshot()).visible;
    expect(mine).toMatchObject({ id: hex(1), value: 'text|budget' });
    expect(mine!.contentRevision).not.toEqual(mine!.revision);
    const b = await open();
    expect(await b.join()).toEqual({ kind: 'applied' });
    expect((await b.client.snapshot()).visible).toEqual([{ ...mine!, source: 'canonical' }]);
    expect(await b.client.pull()).toEqual({ kind: 'applied' });
  });

  it('previews a save as the save plans it: a tag list in another order is no change, a tags-only change one edit', async () => {
    const a = await open();
    await a.join();
    await a.save([{ id: hex(1), value: 'text|x,y' }]);
    await settle(a);
    expect(await a.client.preview([{ id: hex(1), value: 'text|y,x' }])).toEqual({ creates: 0, edits: 0, deletes: 0 });
    expect((await a.save([{ id: hex(1), value: 'text|y,x' }])).issued).toBe(0);
    expect(await a.client.preview([{ id: hex(1), value: 'text|y,x,z' }])).toEqual({ creates: 0, edits: 1, deletes: 0 });
    expect(await a.client.preview([{ id: hex(1), value: 'text|x,y' }, { id: hex(2), value: 'claimed|', claim: true }])).toEqual({ creates: 1, edits: 0, deletes: 0 });
  });

  it('edits a row the account cannot read at its revision with the whole new text, though the save plans amends', async () => {
    const a = await open();
    await a.join();
    await a.save([{ id: hex(1), value: 'healthy|' }]);
    await settle(a);
    // the account's copy becomes unreadable at a new version, as a lost key or a moved value would leave it
    await w.opened.adapter.run(`UPDATE ${w.opened.prefix}rows SET stored = ?, version = 99 WHERE id = ?`, ['garbage', hex(1)]);
    await w.opened.adapter.run(`UPDATE ${w.opened.prefix}groups SET version = 99 WHERE scope = ?`, [w.scope]);
    await settle(a);
    expect((await a.client.snapshot()).kept).toMatchObject([{ id: hex(1), value: 'healthy|', reason: 'unreadable' }]);
    await a.save([{ id: hex(1), value: 'healthy, edited|budget' }]);
    expect((await pendingOf(a)).map((mutation) => mutation.name)).toEqual(['edit']);
    await settle(a);
    expect((await a.client.snapshot()).kept).toEqual([]);
    const fresh = await open();
    await fresh.join();
    expect(await fresh.values()).toEqual(['healthy, edited|budget']);
  });

  it('changes a row kept too long at its revision with the whole new text, so no tag it added is lost', async () => {
    const a = await open();
    await a.join();
    await a.save([{ id: hex(1), value: 'text|' }]);
    await settle(a);
    await a.save([{ id: hex(1), value: `${'x'.repeat(30_000)}|budget` }]);
    expect((await a.client.snapshot()).kept).toMatchObject([{ id: hex(1), reason: 'too_long' }]);
    expect(await pendingOf(a)).toEqual([]);
    await a.save([{ id: hex(1), value: 'short|budget,more' }]);
    expect((await pendingOf(a)).map((mutation) => mutation.name)).toEqual(['edit']);
    await settle(a);
    expect(await a.values()).toEqual(['short|budget,more']);
    expect((await a.client.snapshot()).kept).toEqual([]);
  });

  it('keeps a row kept too long when a save only reorders its tags, a change the composer counts as none', async () => {
    const a = await open();
    await a.join();
    await a.save([{ id: hex(1), value: 'text|' }]);
    await settle(a);
    const long = 'x'.repeat(30_000);
    await a.save([{ id: hex(1), value: `${long}|budget,more` }]);
    expect((await a.client.snapshot()).kept.map((row) => [row.reason, row.value === `${long}|budget,more`])).toEqual([['too_long', true]]);
    await a.save([{ id: hex(1), value: `${long}|more,budget` }]);
    // the page keeps the long text, never the account's older value written back over it
    expect((await a.values()).map((value) => value === `${long}|more,budget`)).toEqual([true]);
    expect((await a.client.snapshot()).kept.map((row) => [row.reason, row.value === `${long}|more,budget`])).toEqual([['too_long', true]]);
    expect(await pendingOf(a)).toEqual([]);
  });

  it('repairs a row the account cannot read when a save only reorders its tags', async () => {
    const a = await open();
    await a.join();
    await a.save([{ id: hex(1), value: 'healthy|x,y' }]);
    await settle(a);
    await w.opened.adapter.run(`UPDATE ${w.opened.prefix}rows SET stored = ?, version = 99 WHERE id = ?`, ['garbage', hex(1)]);
    await w.opened.adapter.run(`UPDATE ${w.opened.prefix}groups SET version = 99 WHERE scope = ?`, [w.scope]);
    await settle(a);
    expect((await a.client.snapshot()).kept).toMatchObject([{ id: hex(1), value: 'healthy|x,y', reason: 'unreadable' }]);
    await a.save([{ id: hex(1), value: 'healthy|y,x' }]);
    expect((await pendingOf(a)).map((mutation) => mutation.name)).toEqual(['edit']);
    await settle(a);
    expect((await a.client.snapshot()).kept).toEqual([]);
    expect(await a.values()).toEqual(['healthy|y,x']);
  });

  it('keeps the text of an amend the account refuses as stale once it cannot open the row, though no pull resends the row', async () => {
    const a = await open();
    await a.join();
    await a.save([{ id: hex(1), value: 'old|' }]);
    await settle(a);
    await a.save([{ id: hex(1), value: 'new|' }]);
    expect((await pendingOf(a)).map((mutation) => mutation.name)).toEqual(['amend']);
    // the account can no longer open its copy, as a lost key leaves it, and the row's version stays as it was
    await w.opened.adapter.run(`UPDATE ${w.opened.prefix}rows SET stored = ? WHERE id = ?`, ['garbage', hex(1)]);
    await settle(a);
    const snapshot = await a.client.snapshot();
    expect(snapshot.pending).toBe(0);
    expect(await a.values()).toEqual(['new|']);
    expect(snapshot.kept.map((row) => [row.id, row.value])).toEqual([[hex(1), 'new|']]);
  });

  it('keeps a second save of a refused amend\'s value under the reason of the first refusal, as the page showed it', async () => {
    await w.close();
    w = await world(backend, { policy: { ...policy, maxRows: 1 } });
    const a = await browser(w, { clientPolicy: { ...policy, maxRows: 1 } });
    const b = await browser(w, { clientPolicy: { ...policy, maxRows: 1 } });
    await a.join();
    await b.join();
    await a.save([{ id: hex(1), value: 'text|' }]);
    await settle(a, b);
    await a.save([{ id: hex(1), value: 'theirs|' }]);
    await settle(a);
    await b.save([{ id: hex(1), value: 'mine|' }]);
    await b.client.pull(); // replayed over theirs, the change is a copy the full account refuses, shown beside the row
    const copy = (await b.client.snapshot()).visible.find((row) => row.id !== hex(1));
    expect(copy?.value).toBe('mine|');
    await b.save([{ id: hex(1), value: 'theirs|' }, { id: copy!.id, value: 'mine, more|' }]);
    await settle(b, a);
    const snapshot = await b.client.snapshot();
    expect(await b.values()).toEqual(['mine, more|', 'theirs|']);
    expect(snapshot.kept.map((row) => [row.id, row.value, row.reason])).toEqual([[copy!.id, 'mine, more|', 'full']]);
    expect(snapshot.pending).toBe(0);
  });

  it('hands the page a restored occupied claim, so its next save keeps it', async () => {
    const { a, b, id } = await occupiedClaim();
    expect(await b.client.restoreKept(id)).toBe(true);
    expect(await b.values()).toEqual(['copy|', 'copy|x']);
    await b.save(await b.blocks());
    await settle(b, a);
    expect(await b.values()).toEqual(['copy|', 'copy|x']);
    expect((await b.client.snapshot()).kept).toEqual([]);
    expect((await a.client.snapshot()).visible.map((row) => row.value).sort()).toEqual(['copy|', 'copy|x']);
  });

  it('keeps an occupied claim aside when the group goes and through the next join, until it is restored', async () => {
    const { b, id } = await occupiedClaim();
    const kept = (await b.client.snapshot()).kept;
    await dropSqlGroup(w.opened.adapter, w.opened.prefix, w.scope);
    expect(await b.client.pull()).toEqual({ kind: 'off' });
    expect((await b.client.snapshot()).kept).toEqual(kept);
    expect((await b.client.backedUp(await b.blocks())).unbacked).toContainEqual({ id, value: 'copy|x' });
    w.group = hex(0x6411);
    await createSqlGroup(w.opened.adapter, w.opened.prefix, w.scope, w.group);
    expect(await b.join()).toEqual({ kind: 'applied' });
    await settle(b);
    expect((await b.client.snapshot()).kept).toEqual(kept);
    expect(await b.client.restoreKept(id)).toBe(true);
    await settle(b);
    expect(await b.values()).toEqual(['copy|', 'copy|x']);
    expect((await b.client.snapshot()).kept).toEqual([]);
  });

  it('keeps an occupied claim aside when the browser declines the group and joins it again', async () => {
    const { b } = await occupiedClaim();
    const kept = (await b.client.snapshot()).kept;
    await b.client.decline(w.group);
    expect(await b.join()).toEqual({ kind: 'applied' });
    expect((await b.client.snapshot()).kept).toEqual(kept);
  });

  it('counts an occupied claim as not backed up, so a removal is not confirmed over it', async () => {
    const { b, id } = await occupiedClaim();
    await b.client.beginRemoval();
    expect(await b.client.backedUp(await b.blocks())).toMatchObject({ checked: true, reason: null, unbacked: [{ id, value: 'copy|x' }] });
  });

  it.each([
    ['rows', 'content_client'], ['rows', 'content_mutation'],
    ['results', 'content_client'], ['results', 'content_mutation'], ['rows', null],
  ] as const)('resumes the client upgrade with only %s.%s added', async (table, column) => {
    const adapter = new IndexedDbAdapter({ memoryOnly: true });
    await adapter.open();
    await adapter.exec('CREATE TABLE sync_membership (scope TEXT PRIMARY KEY, state TEXT NOT NULL)');
    await adapter.exec('CREATE TABLE sync_rows (scope TEXT NOT NULL, id TEXT NOT NULL, state TEXT NOT NULL, value TEXT, rev_client TEXT NOT NULL, rev_mutation INTEGER NOT NULL, version INTEGER NOT NULL, PRIMARY KEY (scope, id))');
    await adapter.exec('CREATE TABLE sync_results (scope TEXT NOT NULL, client_id TEXT NOT NULL, mutation_id INTEGER NOT NULL, outcome TEXT NOT NULL, reason TEXT, target_id TEXT NOT NULL, PRIMARY KEY (scope, client_id, mutation_id))');
    await adapter.exec('CREATE TABLE sync_journal (scope TEXT NOT NULL, grp TEXT NOT NULL, client_id TEXT NOT NULL, mutation_id INTEGER NOT NULL, name TEXT NOT NULL, args TEXT NOT NULL, PRIMARY KEY (scope, grp, client_id, mutation_id))');
    await adapter.run("INSERT INTO sync_membership (scope, state) VALUES ('s', 'joined')");
    await adapter.run("INSERT INTO sync_rows VALUES ('s', ?, 'live', 'v', ?, 3, 3)", [hex(1), hex(0xa)]);
    if (column !== null) await adapter.run(`ALTER TABLE sync_${table} ADD COLUMN ${column} ${column === 'content_client' ? 'TEXT' : 'INTEGER'}`);
    await upgradeClientTables(adapter, 'sync_');
    await upgradeClientTables(adapter, 'sync_');
    const row = await adapter.get<{ content_client: string; content_mutation: unknown }>('SELECT content_client, content_mutation FROM sync_rows');
    expect([row?.content_client, Number(row?.content_mutation)]).toEqual([hex(0xa), 3]);
    expect(await adapter.all('SELECT content_client, content_mutation FROM sync_results WHERE 1 = 0')).toEqual([]);
    expect(Number((await adapter.get<{ protocol: unknown }>('SELECT protocol FROM sync_membership'))?.protocol)).toBe(1);
  });
});

describe('packing a protocol 2 push', () => {
  it('counts the whole envelope, the protocol included, at every byte limit', () => {
    const envelope = { group: hex(1), epoch: hex(2), clientId: hex(3), protocol: PROTOCOL };
    const mutations = Array.from({ length: 12 }, (_, index) => ({ id: String(index + 1), name: 'create', args: { id: hex(index + 10), value: 'v'.repeat(index * 7) } }));
    for (let maxBytes = 300; maxBytes <= 1500; maxBytes += 1) {
      for (const batch of packMutations(envelope, mutations, { maxMutations: 50, maxBytes })) {
        if (batch.length > 1) expect(requestBytes({ ...envelope, mutations: batch })).toBeLessThanOrEqual(maxBytes);
      }
    }
  });
});
