import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { IndexedDbAdapter, type IndexedDbLockManager } from '../src/adapters/indexedDbAdapter';

// reload() puts the stored image in place of the one in memory, whatever the
// version stamp says: the roll-back of a durable commit IndexedDB refused, and
// the way a connection without crossTab reads what another has stored. With
// crossTab, rollbackRefusedSaves does the roll-back inside the lock, before a
// statement queued behind the refused one runs.

/** A lock manager with the Web Locks API's exclusive mode: one holder per name, the waiters in the order they asked. */
const createLockManager = (): IndexedDbLockManager => {
  const turns = new Map<string, Promise<unknown>>();
  return {
    request<T>(name: string, _options: { mode: 'exclusive' }, callback: () => Promise<T>): Promise<T> {
      const turn = (turns.get(name) ?? Promise.resolve()).then(() => callback());
      turns.set(
        name,
        turn.catch(() => undefined),
      );
      return turn;
    },
  };
};

/** A promise and the function that settles it. */
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

describe('IndexedDbAdapter.reload()', () => {
  const opened: IndexedDbAdapter[] = [];
  let originalPut: typeof IDBObjectStore.prototype.put;
  let originalGet: typeof IDBObjectStore.prototype.get;
  /** How many reads abortNextSave(true) has aborted. */
  let abortedReads = 0;

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

  /**
   * The next IndexedDB transaction that puts is aborted after its first put succeeded; the saves after it store. With
   * `andTheNextRead`, the next transaction that reads after that put is aborted too, after its first read succeeded.
   */
  const abortNextSave = (andTheNextRead = false): void => {
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
      IDBObjectStore.prototype.put = originalPut;
      if (andTheNextRead) {
        IDBObjectStore.prototype.get = function (this: IDBObjectStore, ...getArgs: Parameters<IDBObjectStore['get']>) {
          IDBObjectStore.prototype.get = originalGet;
          abortedReads += 1;
          const read = originalGet.apply(this, getArgs);
          read.addEventListener('success', () => this.transaction.abort());
          return read;
        };
      }
      const request = originalPut.apply(this, args);
      request.addEventListener('success', () => this.transaction.abort());
      return request;
    };
  };

  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    originalPut = IDBObjectStore.prototype.put;
    originalGet = IDBObjectStore.prototype.get;
    abortedReads = 0;
  });

  afterEach(async () => {
    IDBObjectStore.prototype.put = originalPut;
    IDBObjectStore.prototype.get = originalGet;
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

  describe('with crossTab.rollbackRefusedSaves', () => {
    it('puts the stored image back inside the lock, so a statement queued behind a refused transaction neither reads nor stores its write', async () => {
      const adapter = await openTab('rollback-queued', { crossTab: { locks: createLockManager(), rollbackRefusedSaves: true } });
      await adapter.run('INSERT INTO items (label) VALUES (?)', ['stored']);
      const inside = deferred();
      const finish = deferred();
      abortNextSave();
      const refused = adapter
        .transaction(async (trx) => {
          await trx.run('INSERT INTO items (label) VALUES (?)', ['refused']);
          inside.resolve();
          await finish.promise;
        })
        .then(
          () => null,
          (error: unknown) => error,
        );
      await inside.promise;
      // Queued on the lock while the transaction holds it, before its refusal reaches the caller.
      const queuedRead = adapter.all<{ label: string }>('SELECT label FROM items ORDER BY id');
      const queuedWrite = adapter.run('INSERT INTO items (label) VALUES (?)', ['queued']);
      finish.resolve();
      expect(await refused).toBeInstanceOf(Error);
      expect((await queuedRead).map((row) => row.label)).toEqual(['stored']);
      await queuedWrite;
      expect(await adapter.reload()).toBe(false);
      const reader = await openTab('rollback-queued');
      expect(await labels(reader)).toEqual(['stored', 'queued']);
    });

    it('gives up the write of a refused statement or import, and the next statement stores only its own', async () => {
      const adapter = await openTab('rollback-statement', { crossTab: { locks: null, rollbackRefusedSaves: true } });
      await adapter.run('INSERT INTO items (label) VALUES (?)', ['stored']);
      abortNextSave();
      await expect(adapter.run('INSERT INTO items (label) VALUES (?)', ['refused'])).rejects.toBeDefined();
      expect(await labels(adapter)).toEqual(['stored']);

      const source = new IndexedDbAdapter({ memoryOnly: true });
      opened.push(source);
      await source.open();
      await source.exec(
        "CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL); INSERT INTO items (label) VALUES ('imported');",
      );
      abortNextSave();
      await expect(adapter.importDatabase(source.exportDatabase())).rejects.toBeDefined();
      expect(await labels(adapter)).toEqual(['stored']);

      await adapter.run('INSERT INTO items (label) VALUES (?)', ['next']);
      const reader = await openTab('rollback-statement');
      expect(await labels(reader)).toEqual(['stored', 'next']);
    });

    it('never stores a refused write it could not read back at once: the next statement reads the stored image first, and close() stores nothing', async () => {
      const adapter = await openTab('rollback-unread', { crossTab: { locks: null, rollbackRefusedSaves: true } });
      await adapter.run('INSERT INTO items (label) VALUES (?)', ['stored']);

      abortNextSave(true);
      await expect(adapter.run('INSERT INTO items (label) VALUES (?)', ['refused'])).rejects.toBeDefined();
      IDBObjectStore.prototype.get = originalGet;
      expect(abortedReads).toBe(1);
      await adapter.run('INSERT INTO items (label) VALUES (?)', ['next']);
      expect(await labels(adapter)).toEqual(['stored', 'next']);

      abortNextSave(true);
      await expect(adapter.run('INSERT INTO items (label) VALUES (?)', ['refused again'])).rejects.toBeDefined();
      IDBObjectStore.prototype.get = originalGet;
      expect(abortedReads).toBe(2);
      await adapter.close();
      const reader = await openTab('rollback-unread');
      expect(await labels(reader)).toEqual(['stored', 'next']);
    });
  });
});
