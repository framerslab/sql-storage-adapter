import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSqlGroup, dropSqlGroup } from '../../src/features/sync/mutations/sqlStore';
import { backends } from './backends';
import { browser, hex, settle, world, type World } from './harness';

const BACKENDS = await backends();

/** Turns the scope off and on: a new group, as an off and an on make. */
async function offAndOn(w: World, next: number): Promise<void> {
  await dropSqlGroup(w.opened.adapter, w.opened.prefix, w.scope);
  w.group = hex(next);
  await createSqlGroup(w.opened.adapter, w.opened.prefix, w.scope, w.group);
}

const EXAMPLES = ['## Quarter\nNumbers.', '## Atlas\nStatus.', '## Exam\nGuidance.'];

describe.each(BACKENDS.map((backend) => [backend.name, backend] as const))('joining on %s', (_name, backend) => {
  let w: World;

  beforeEach(async () => {
    w = await world(backend);
  });

  afterEach(async () => {
    await w.close();
  });

  it('merges identical unmarked blocks once and keeps a differing block of the same id as a copy', async () => {
    const a = await browser(w);
    await a.save(EXAMPLES.map((value) => ({ id: null, value })));
    await a.join();
    await settle(a);
    const ids = (await a.blocks()).map((block) => block.id as string);
    const b = await browser(w);
    // B holds two of the examples unmarked, and its own text under the third one's id
    await b.save([{ id: null, value: EXAMPLES[0] }, { id: null, value: EXAMPLES[2] }, { id: ids[1], value: '## Atlas\nOther status.' }]);
    await b.join();
    await settle(b, a);
    const expected = [...EXAMPLES, '## Atlas\nOther status. (copy)'].sort();
    expect(await b.values()).toEqual(expected);
    expect(await a.values()).toEqual(expected);
    expect(await w.opened.adapter.all(`SELECT id FROM ${w.opened.prefix}rows`)).toHaveLength(4);
  });

  it("adopts the account's value for a block unchanged since the off, and sends no deletion made while off", async () => {
    const a = await browser(w);
    await a.save([{ id: null, value: 'kept' }, { id: null, value: 'changed later' }]);
    await a.join();
    await settle(a);
    const [kept, changed] = await a.blocks();
    await offAndOn(w, 0x6410);
    expect(await a.client.push()).toEqual({ kind: 'idle' });
    expect(await a.client.pull()).toEqual({ kind: 'off' });
    expect(await a.values()).toEqual(['changed later', 'kept']);
    // while off, A deletes "kept"; another browser joins the new group with both rows, one of them changed
    await a.save([changed]);
    const c = await browser(w);
    await c.save([{ id: kept.id, value: 'kept' }, { id: changed.id, value: 'changed later, by c' }]);
    await c.join();
    await settle(c);
    await a.join();
    await settle(a, c);
    expect(await a.values()).toEqual(['changed later, by c', 'kept']);
    expect(await c.values()).toEqual(['changed later, by c', 'kept']);
  });

  it('declines with no pull or push, and keeps the group it declined so a new one asks again', async () => {
    const b = await browser(w);
    await b.save([{ id: null, value: 'mine' }]);
    await b.client.decline(w.group);
    const snapshot = await b.client.snapshot();
    expect(snapshot.membership).toMatchObject({ state: 'declined', declinedGroup: w.group });
    await b.save([{ id: null, value: 'mine' }, { id: null, value: 'more' }]);
    // a save sends nothing by itself, so the sends are driven here: a declined client answers idle and never reaches the transport
    expect(await b.client.push()).toEqual({ kind: 'idle' });
    expect(await b.client.pull()).toEqual({ kind: 'idle' });
    expect(b.transport.pulls + b.transport.pushes).toBe(0);
    expect((await b.client.snapshot()).pending).toBe(0);
  });

  it("keeps an old group's text when its push is refused, and an old answer cannot clear the new membership", async () => {
    const a = await browser(w);
    await a.save([{ id: hex(1), value: 'x' }]);
    await a.join();
    await settle(a);
    const old = await a.client.context();
    a.transport.offline = true;
    await a.save([{ id: hex(1), value: 'x, edited offline' }]);
    await offAndOn(w, 0x6411);
    a.transport.offline = false;
    expect(await a.client.push()).toEqual({ kind: 'off' });
    expect(await a.values()).toEqual(['x, edited offline']);
    await a.join();
    await a.save([{ id: hex(1), value: 'x, edited offline' }, { id: hex(2), value: 'new' }]);
    if (old === null) throw new Error('no context');
    expect(await a.client.leave(old)).toEqual({ kind: 'stale' });
    const now = await a.client.snapshot();
    expect(now.membership).toMatchObject({ state: 'joined', group: w.group });
    expect(now.pending).toBeGreaterThan(0);
  });
});
