import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { IndexedDbAdapter } from '../src/adapters/indexedDbAdapter';

// reload() puts the stored image in place of the one in memory, whatever the
// version stamp says: the roll-back of a durable commit IndexedDB refused, and
// the way a connection without crossTab reads what another has stored.

describe('IndexedDbAdapter.reload()', () => {
  const opened: IndexedDbAdapter[] = [];
  let originalPut: typeof IDBObjectStore.prototype.put;

  const openTab = async (dbName: string, options: ConstructorParameters<typeof IndexedDbAdapter>[0] = {}): Promise<IndexedDbAdapter> => {
    const adapter = new IndexedDbAdapter({ dbName, durability: 'commit', ...options });
    opened.push(adapter);
    await adapter.open();
    await adapter.exec('CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, label TEXT NOT NULL)');
    return adapter;
  };

  const labels = async (adapter: IndexedDbAdapter): Promise<string[]> =>
    (await adapter.all<{ label: string }>('SELECT label FROM items ORDER BY id')).map((row) => row.label);

  /** From the next put on, every IndexedDB transaction that puts is aborted after the put succeeded. */
  const abortSaves = (): void => {
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
      const request = originalPut.apply(this, args);
      request.addEventListener('success', () => this.transaction.abort());
      return request;
    };
  };

  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    originalPut = IDBObjectStore.prototype.put;
  });

  afterEach(async () => {
    IDBObjectStore.prototype.put = originalPut;
    for (const adapter of opened.splice(0)) {
      await adapter.close().catch(() => undefined);
    }
    vi.unstubAllGlobals();
  });

  it('puts the memory image back to the stored one after a commit IndexedDB aborted, under crossTab', async () => {
    const adapter = await openTab('reload-abort', { crossTab: { locks: null } });
    await adapter.run('INSERT INTO items (label) VALUES (?)', ['stored']);
    abortSaves();
    await expect(
      adapter.transaction(async (trx) => {
        await trx.run('INSERT INTO items (label) VALUES (?)', ['refused']);
      }),
    ).rejects.toBeDefined();
    IDBObjectStore.prototype.put = originalPut;
    expect(await adapter.reload()).toBe(true);
    expect(await labels(adapter)).toEqual(['stored']);
    const reader = await openTab('reload-abort');
    expect(await labels(reader)).toEqual(['stored']);
  });

  it('stores a refused write at the next coordinated statement when nothing reloads first, which is why a caller reloads in its catch', async () => {
    const adapter = await openTab('reload-next', { crossTab: { locks: null } });
    await adapter.run('INSERT INTO items (label) VALUES (?)', ['stored']);
    abortSaves();
    await expect(adapter.run('INSERT INTO items (label) VALUES (?)', ['refused'])).rejects.toBeDefined();
    IDBObjectStore.prototype.put = originalPut;
    expect(await labels(adapter)).toEqual(['stored', 'refused']);
    const reader = await openTab('reload-next');
    expect(await labels(reader)).toEqual(['stored', 'refused']);
  });

  it('reads what another connection stored, and answers false once the memory image is the stored one', async () => {
    const reader = await openTab('reload-other');
    const writer = await openTab('reload-other', { crossTab: { locks: null } });
    await writer.run('INSERT INTO items (label) VALUES (?)', ['from the other tab']);
    expect(await labels(reader)).toEqual([]);
    expect(await reader.reload()).toBe(true);
    expect(await labels(reader)).toEqual(['from the other tab']);
    expect(await reader.reload()).toBe(false);
  });

  it('refuses while a transaction begun with BEGIN is open, and waits for an open transaction() to end', async () => {
    const adapter = await openTab('reload-begin');
    await adapter.run('BEGIN');
    await expect(adapter.reload()).rejects.toThrow('reload() cannot replace');
    await adapter.run('ROLLBACK');
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const open = adapter.transaction(async (trx) => {
      await trx.run('INSERT INTO items (label) VALUES (?)', ['inside']);
      await held;
      order.push('transaction ends');
    });
    const reloading = adapter.reload().then((changed) => order.push(`reload ${changed ? 'replaced' : 'kept'}`));
    release();
    await Promise.all([open, reloading]);
    expect(order).toEqual(['transaction ends', 'reload kept']);
    expect(await labels(adapter)).toEqual(['inside']);
  });
});
