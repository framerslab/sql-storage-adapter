import 'fake-indexeddb/auto';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IndexedDbAdapter } from '../../src/adapters/indexedDbAdapter';
import { packMutations, requestBytes } from '../../src/features/sync/mutations/packing';
import { memoryTabLock } from '../../src/features/sync/mutations/tabLock';
import { SyncUnavailable } from '../../src/features/sync/mutations/transport';
import { backends } from './backends';
import { browser, hex, settle, world, type Browser, type World } from './harness';

const BACKENDS = await backends();

/** The pending mutation ids the browser's database holds. */
async function pendingIds(b: Browser): Promise<number[]> {
  return (await b.adapter.all<{ mutation_id: number }>('SELECT mutation_id FROM sync_pending ORDER BY mutation_id')).map((row) => Number(row.mutation_id));
}

describe.each(BACKENDS.map((backend) => [backend.name, backend] as const))('the client against a server on %s', (_name, backend) => {
  let w: World;

  beforeEach(async () => {
    w = await world(backend);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await w.close();
  });

  it('joins with three rows, hands them to an empty second browser, and converges creates, edits and deletes', async () => {
    const a = await browser(w);
    await a.save([{ id: null, value: 'alpha' }, { id: null, value: 'beta' }, { id: null, value: 'gamma' }]);
    expect(await a.join()).toEqual({ kind: 'applied' });
    expect((await a.blocks()).every((block) => block.id !== null)).toBe(true);
    await settle(a);
    const b = await browser(w);
    expect(await b.join()).toEqual({ kind: 'applied' });
    expect(await b.values()).toEqual(['alpha', 'beta', 'gamma']);
    const held = await b.blocks();
    const named = (value: string) => held.find((block) => block.value === value) as { id: string; value: string };
    // alpha edited, beta deleted, gamma kept, delta added
    await b.save([{ ...named('alpha'), value: 'alpha, edited' }, named('gamma'), { id: hex(0x77), value: 'delta' }]);
    await settle(b, a);
    expect(await a.values()).toEqual(['alpha, edited', 'delta', 'gamma']);
    expect(await b.values()).toEqual(['alpha, edited', 'delta', 'gamma']);
  });

  it('allocates mutation ids that rise across a reload and a second tab, whatever the clock says', async () => {
    const a = await browser(w);
    await a.join();
    await a.save([{ id: hex(1), value: 'one' }, { id: hex(2), value: 'two' }]);
    expect(await pendingIds(a)).toEqual([1, 2]);
    vi.spyOn(Date, 'now').mockReturnValue(0);
    const reloaded = a.reopen();
    await reloaded.save([...(await a.blocks()), { id: hex(3), value: 'three' }]);
    const tab = a.reopen();
    await tab.save([...(await a.blocks()), { id: hex(4), value: 'four' }]);
    expect(await pendingIds(a)).toEqual([1, 2, 3, 4]);
  });

  it('never moves canonical state back: a lost push answer applies once, and an old pull answer is dropped with the pending edit made meanwhile kept', async () => {
    const a = await browser(w);
    const b = await browser(w);
    await a.save([{ id: hex(1), value: 'one' }]);
    await a.join();
    await settle(a);
    await b.join();
    a.transport.dropNextPushAnswer();
    await a.save([{ id: hex(1), value: 'one' }, { id: hex(2), value: 'two' }]);
    await expect(a.client.push()).rejects.toBeInstanceOf(SyncUnavailable);
    expect(await a.client.push()).toEqual({ kind: 'sent' });
    await b.save([{ id: hex(1), value: 'one, from b' }, ...(await b.blocks()).filter((block) => block.id !== hex(1))]);
    await settle(b);
    const held = a.transport.holdNextPull();
    const old = a.client.pull();
    // the held answer read the server before this newer pull, which applies first
    await a.save([...(await a.blocks()), { id: hex(3), value: 'three, pending' }]);
    const newer = await a.client.pull();
    expect(newer).toEqual({ kind: 'applied' });
    held.release();
    expect(await old).toEqual({ kind: 'stale' });
    expect(await a.values()).toEqual(['one, from b', 'three, pending', 'two']);
    expect((await a.client.snapshot()).pending).toBe(1);
    await settle(a, b);
    expect(await b.values()).toEqual(['one, from b', 'three, pending', 'two']);
    const results = await w.opened.adapter.all<{ outcome: string }>(`SELECT outcome FROM ${w.opened.prefix}results WHERE mutation_id = 2 AND client_id = ?`, [(await a.client.context())?.clientId]);
    expect(results.map((row) => row.outcome)).toEqual(['applied']);
  });

  it('carries forty values of 30,000 code units, escapes and multibyte text included, in several pushes within the byte limit', async () => {
    const a = await browser(w);
    await a.join();
    const value = (n: number): string => `${String(n).padStart(5, '0')}${'\u00e9\u4e2d"\\\n'.repeat(6000)}`.slice(0, 30_000);
    const blocks = Array.from({ length: 40 }, (_, index) => ({ id: hex(index + 1), value: value(index) }));
    await a.save(blocks);
    await settle(a);
    expect(a.transport.pushes).toBeGreaterThanOrEqual(2);
    const b = await browser(w);
    await b.join();
    expect((await b.blocks()).length).toBe(40);
    expect(await b.values()).toEqual(blocks.map((block) => block.value).sort());
  });

  it('splits a push the server refuses as too large, in order with its ids, and keeps a mutation refused alone pending with sends stopped', async () => {
    const a = await browser(w);
    await a.join();
    await a.save(Array.from({ length: 6 }, (_, index) => ({ id: hex(index + 1), value: 'x'.repeat(1000) })));
    a.transport.tooLargeOver = 2600;
    expect(await a.client.push()).toEqual({ kind: 'sent' });
    expect(a.transport.pushes).toBeGreaterThanOrEqual(3);
    await a.client.pull();
    expect((await a.client.snapshot()).pending).toBe(0);
    await a.save([...(await a.blocks()), { id: hex(7), value: 'y'.repeat(3000) }]);
    expect(await a.client.push()).toEqual({ kind: 'blocked' });
    const blocked = await a.client.snapshot();
    expect(blocked.membership.sends).toBe('size_error');
    expect(await pendingIds(a)).toEqual([7]);
    expect(await a.client.push()).toEqual({ kind: 'idle' });
    a.transport.tooLargeOver = null;
    await a.client.reopenSends();
    await settle(a);
    expect((await a.client.snapshot()).pending).toBe(0);
    expect((await w.opened.adapter.all(`SELECT id FROM ${w.opened.prefix}rows WHERE id = ?`, [hex(7)])).length).toBe(1);
  });

  it('keeps a value too long for the account in its browser without an id, and moves a value the server refused to the kept rows', async () => {
    const a = await browser(w, { clientPolicy: { maxUnits: 40 } });
    await a.join();
    const result = await a.save([{ id: hex(1), value: 'x'.repeat(41) }, { id: hex(2), value: 'fits' }]);
    expect(result.tooLong).toEqual([hex(1)]);
    expect(await pendingIds(a)).toEqual([1]);
    const narrowServer = await world(backend, { policy: { maxRows: 1 } });
    try {
      const c = await browser(narrowServer);
      await c.join();
      await c.save([{ id: hex(1), value: 'one' }, { id: hex(2), value: 'two' }]);
      await settle(c);
      const snapshot = await c.client.snapshot();
      expect(snapshot.kept).toMatchObject([{ id: hex(2), value: 'two', reason: 'full' }]);
      expect(await c.values()).toEqual(['one', 'two']);
    } finally {
      await narrowServer.close();
    }
  });

  it('converges in either order when two browsers edit one revision offline: the original, one copy, and a dependent edit on the copy', async () => {
    for (const order of [['a', 'b'], ['b', 'a']] as const) {
      const fresh = await world(backend);
      try {
        const a = await browser(fresh);
        const b = await browser(fresh);
        await a.save([{ id: hex(1), value: 'shared' }]);
        await a.join();
        await settle(a);
        await b.join();
        a.transport.offline = true;
        b.transport.offline = true;
        await a.save([{ id: hex(1), value: 'from a' }]);
        await a.save([{ id: hex(1), value: 'from a, again' }]);
        await b.save([{ id: hex(1), value: 'from b' }]);
        a.transport.offline = false;
        b.transport.offline = false;
        const [first, second] = order[0] === 'a' ? [a, b] : [b, a];
        await first.client.push();
        await second.client.push();
        await settle(a, b);
        const winner = order[0] === 'a' ? 'from a, again' : 'from b';
        const copy = order[0] === 'a' ? 'from b (copy)' : 'from a, again (copy)';
        expect(await a.values()).toEqual([winner, copy].sort());
        expect(await b.values()).toEqual([winner, copy].sort());
      } finally {
        await fresh.close();
      }
    }
  });

  it('commits a save whole or not at all when the durable write fails, and a second tab sees one or the other', async () => {
    // master's adapter opens the page's own indexedDB: a factory of this test's is stubbed in, as master's durability spec does
    vi.stubGlobal('indexedDB', new IDBFactory());
    const database = new IndexedDbAdapter({ dbName: 'client-durable', durability: 'commit' });
    const lock = memoryTabLock();
    const a = await browser(w, { adapter: database, lock });
    await a.join();
    await a.save([{ id: hex(1), value: 'kept' }]);
    const put = IDBObjectStore.prototype.put;
    let aborted = false;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<typeof put>) {
      const request = put.apply(this, args);
      if (!aborted) {
        aborted = true;
        request.addEventListener('success', () => this.transaction.abort());
      }
      return request;
    });
    await expect(a.save([{ id: hex(1), value: 'kept' }, { id: hex(2), value: 'lost' }])).rejects.toThrow();
    vi.restoreAllMocks();
    expect(await a.values()).toEqual(['kept']);
    expect(await pendingIds(a)).toEqual([1]);
    const otherTab = new IndexedDbAdapter({ dbName: 'client-durable', durability: 'commit' });
    await otherTab.open();
    expect((await otherTab.all<{ value: string }>('SELECT value FROM test_blocks')).map((row) => row.value)).toEqual(['kept']);
    expect((await otherTab.all('SELECT mutation_id FROM sync_pending')).length).toBe(1);
    await otherTab.close();
    await database.close();
    vi.unstubAllGlobals();
  });

  it('under crossTab with rollbackRefusedSaves, a statement another part of the page queued behind a refused save runs on the stored image and stores nothing of the save', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    const database = new IndexedDbAdapter({ dbName: 'client-cross-tab', crossTab: { locks: null, rollbackRefusedSaves: true } });
    const a = await browser(w, { adapter: database, lock: memoryTabLock() });
    await database.exec('CREATE TABLE IF NOT EXISTS test_side (value TEXT NOT NULL)');
    await a.join();
    await a.save([{ id: hex(1), value: 'kept' }]);
    const put = IDBObjectStore.prototype.put;
    const side: { queued?: Promise<unknown> } = {};
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<typeof put>) {
      const request = put.apply(this, args);
      if (side.queued === undefined) {
        // another part of the page writes the same database, outside the client's lock, while the save holds the adapter
        side.queued = database.run('INSERT INTO test_side (value) VALUES (?)', ['outside the lock']);
        request.addEventListener('success', () => this.transaction.abort());
      }
      return request;
    });
    await expect(a.save([{ id: hex(1), value: 'kept' }, { id: hex(2), value: 'lost' }])).rejects.toThrow();
    await side.queued;
    vi.restoreAllMocks();
    expect(await a.values()).toEqual(['kept']);
    expect(await pendingIds(a)).toEqual([1]);
    const otherTab = new IndexedDbAdapter({ dbName: 'client-cross-tab', durability: 'commit' });
    await otherTab.open();
    expect((await otherTab.all<{ value: string }>('SELECT value FROM test_blocks')).map((row) => row.value)).toEqual(['kept']);
    expect((await otherTab.all('SELECT mutation_id FROM sync_pending')).length).toBe(1);
    expect(await otherTab.all('SELECT value FROM test_side')).toEqual([{ value: 'outside the lock' }]);
    await otherTab.close();
    await database.close();
    vi.unstubAllGlobals();
  });

  it('follows a no-op to the revision it recorded: same-text creates made offline under ids the account holds, then a delete and an edit, converge with no copy', async () => {
    const a = await browser(w);
    await a.join();
    const b = await browser(w);
    await b.join();
    await settle(a, b);
    b.transport.offline = true;
    await a.save([{ id: hex(1), value: 'v' }, { id: hex(2), value: 'y' }]);
    await settle(a);
    // b, offline, imports the same two rows under the same ids (a derived id, say), deletes one and edits the other
    await b.save([{ id: hex(1), value: 'v' }, { id: hex(2), value: 'y' }]);
    await b.save([{ id: hex(2), value: 'y, edited here' }]);
    b.transport.offline = false;
    await settle(b, a);
    expect(await a.values()).toEqual(['y, edited here']);
    expect(await b.values()).toEqual(['y, edited here']);
    const results = await w.opened.adapter.all<{ outcome: string; rev_client: string }>(`SELECT outcome, rev_client FROM ${w.opened.prefix}results WHERE client_id = ? ORDER BY mutation_id`, [(await b.client.context())?.clientId]);
    expect(results.map((row) => row.outcome)).toEqual(['noop', 'noop', 'applied', 'applied']);
    expect(results.slice(0, 2).map((row) => row.rev_client)).toEqual([(await a.client.context())?.clientId, (await a.client.context())?.clientId]);
    expect((await b.client.snapshot()).kept).toEqual([]);
  });
});

describe('packing', () => {
  it('packs by the exact UTF-8 bytes of the request, envelope included, and keeps the ids in order', () => {
    const envelope = { group: hex(1), epoch: hex(2), clientId: hex(3) };
    const mutations = Array.from({ length: 30 }, (_, index) => ({ id: String(index + 1), name: 'create', args: { id: hex(index + 10), value: `\u00e9"\\\u2028${'\u4e2d'.repeat(200)}` } }));
    const batches = packMutations(envelope, mutations, { maxMutations: 50, maxBytes: 5000 });
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat().map((mutation) => mutation.id)).toEqual(mutations.map((mutation) => mutation.id));
    for (const batch of batches) expect(requestBytes({ ...envelope, mutations: batch })).toBeLessThanOrEqual(5000);
    expect(packMutations(envelope, mutations, { maxMutations: 7, maxBytes: 10_000_000 }).map((batch) => batch.length)).toEqual([7, 7, 7, 7, 2]);
  });
});
