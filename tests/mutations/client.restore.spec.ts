import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StorageAdapter } from '../../src/core/contracts';
import { backends } from './backends';
import { browser, dump, hex, restore, settle, world, type World } from './harness';

const BACKENDS = await backends();

describe.each(BACKENDS.map((backend) => [backend.name, backend] as const))('restores on %s', (_name, backend) => {
  let w: World;

  beforeEach(async () => {
    w = await world(backend);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await w.close();
  });

  it('detects a restore by its epoch when the counter has passed the old cookie, and pushes again what the dump lacks with the same ids', async () => {
    const a = await browser(w);
    const b = await browser(w);
    await a.join();
    await b.join();
    await a.save([{ id: hex(1), value: 'one' }]);
    await settle(a, b);
    const older = await dump(w);
    await a.save([{ id: hex(1), value: 'one' }, { id: hex(2), value: 'two, acknowledged' }]);
    await settle(a);
    a.transport.offline = true;
    await a.save([{ id: hex(1), value: 'one' }, { id: hex(2), value: 'two, acknowledged' }, { id: hex(3), value: 'three, pending' }]);
    await restore(w, older);
    // B recovers and moves the restored counter well past A's old cookie
    await settle(b);
    for (let n = 10; n < 15; n += 1) {
      await b.save([...(await b.blocks()), { id: hex(n), value: `b ${n}` }]);
      await settle(b);
    }
    a.transport.offline = false;
    await settle(a, b);
    const expected = ['b 10', 'b 11', 'b 12', 'b 13', 'b 14', 'one', 'three, pending', 'two, acknowledged'];
    expect(await a.values()).toEqual(expected);
    expect(await b.values()).toEqual(expected);
    const ids = await w.opened.adapter.all<{ mutation_id: unknown }>(`SELECT mutation_id FROM ${w.opened.prefix}results WHERE client_id = ? ORDER BY mutation_id`, [(await a.client.context())?.clientId]);
    expect(ids.map((row) => Number(row.mutation_id))).toEqual([1, 2, 3]);
  });

  it('removes an unchanged downloaded row when a replayed deletion fence tombstones it, and never sends it again', async () => {
    const a = await browser(w);
    const b = await browser(w);
    await a.join();
    await b.join();
    await b.save([{ id: hex(1), value: 'to be deleted' }]);
    await settle(b, a);
    const withRow = await dump(w);
    await b.save([]);
    await settle(b);
    const deleting = (await w.opened.adapter.all<{ rev_client: string; rev_mutation: unknown }>(`SELECT rev_client, rev_mutation FROM ${w.opened.prefix}rows WHERE id = ?`, [hex(1)]))[0];
    b.transport.offline = true;
    await restore(w, withRow);
    expect(await w.server.replayTombstone({ scope: w.scope, group: w.group, id: hex(1), revision: { client: deleting.rev_client, mutation: String(Number(deleting.rev_mutation)) }, deletedAt: '2026-10-15T10:00:00.000Z' })).toBe('written');
    await settle(a);
    expect(await a.values()).toEqual([]);
    expect((await a.client.snapshot()).kept).toEqual([]);
    expect((await w.opened.adapter.all<{ state: string }>(`SELECT state FROM ${w.opened.prefix}rows WHERE id = ?`, [hex(1)]))[0].state).toBe('tombstone');
  });

  it("keeps the healthy local block beside a differing restored row until the account's copy matches it", async () => {
    const a = await browser(w);
    const b = await browser(w);
    await a.save([{ id: hex(1), value: 'old' }]);
    await a.join();
    await settle(a);
    await b.join();
    const older = await dump(w);
    await a.save([{ id: hex(1), value: 'new' }]);
    await settle(a, b);
    a.transport.offline = true;
    await restore(w, older);
    await settle(b);
    expect((await b.client.snapshot()).kept).toMatchObject([{ id: hex(1), value: 'new', reason: 'differs' }]);
    expect(await b.values()).toEqual(['new']);
    a.transport.offline = false;
    await settle(a, b);
    expect((await b.client.snapshot()).kept).toEqual([]);
    expect(await b.values()).toEqual(['new']);
  });

  it('retires a client whose journal has a hole and keeps the values only its pending mutations held', async () => {
    const a = await browser(w);
    await a.join();
    await a.save([{ id: hex(1), value: 'one' }]);
    await settle(a);
    const older = await dump(w);
    await a.save([{ id: hex(1), value: 'one' }, { id: hex(2), value: 'two' }]);
    await settle(a);
    a.transport.offline = true;
    await a.save([{ id: hex(1), value: 'one' }, { id: hex(2), value: 'two' }, { id: hex(3), value: 'three' }]);
    await a.adapter.run('DELETE FROM sync_journal WHERE mutation_id = 2');
    await restore(w, older);
    a.transport.offline = false;
    await settle(a);
    const snapshot = await a.client.snapshot();
    expect(snapshot.membership.state).toBe('retired');
    expect(await a.values()).toEqual(['one', 'three', 'two']);
    expect(await a.client.push()).toEqual({ kind: 'idle' });
    expect(await a.join()).toEqual({ kind: 'applied' });
    await settle(a);
    expect(await a.values()).toEqual(['one', 'three', 'two']);
  });

  it('keeps a value the account refused before the dump when the recovery pull acknowledges the refusal', async () => {
    const narrow = await world(backend, { policy: { maxRows: 1 } });
    try {
      const a = await browser(narrow);
      await a.save([{ id: hex(1), value: 'one' }]);
      await a.join();
      await settle(a);
      // the full account refuses the second row; the dump holds the refusal, and the restore lands before a's next pull
      await a.save([{ id: hex(1), value: 'one' }, { id: hex(2), value: 'two' }]);
      expect(await a.client.push()).toEqual({ kind: 'sent' });
      await restore(narrow, await dump(narrow));
      await settle(a);
      expect(await a.values()).toEqual(['one', 'two']);
      const snapshot = await a.client.snapshot();
      expect(snapshot.kept).toMatchObject([{ id: hex(2), value: 'two', reason: 'full' }]);
      expect(snapshot.membership).toMatchObject({ state: 'joined', recovering: false });
      expect(snapshot.pending).toBe(0);
    } finally {
      await narrow.close();
    }
  });
});
