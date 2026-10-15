import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import initSqlJs from 'sql.js';
import { IDBFactory } from 'fake-indexeddb';
import { IndexedDbAdapter, IndexedDbConflictError, type IndexedDbLockManager } from '../src/adapters/indexedDbAdapter';

// Two tabs of one site share its IndexedDB database. Each IndexedDbAdapter holds
// a whole sql.js image in memory and writes it back whole, so without
// coordination the tab that saves last overwrites the other's writes. With
// crossTab, each statement and transaction runs under a Web Lock on the
// database, on the newest stored image, and is stored before the lock is let
// go; a version stamp stored beside the image tells a tab that another has
// saved. Where the browser has no Web Locks, the stamp alone keeps both tabs'
// writes: a statement that finds another tab saved first runs again on the
// newer image, and a transaction is refused with IndexedDbConflictError.
//
// Here two adapters over one fake IndexedDB stand for two tabs. The lock
// manager below grants one exclusive lock per name at a time, in the order
// asked, as the Web Locks API does; tests/browser/ runs the same coordination
// on the browsers' own IndexedDB and Web Locks.

const STORE = 'sqliteDb';

/** A lock manager with the Web Locks API's exclusive mode: one holder per name, waiters in order. */
const createLockManager = (): IndexedDbLockManager & { requests: string[] } => {
  const tails = new Map<string, Promise<void>>();
  const requests: string[] = [];
  return {
    requests,
    request<T>(name: string, _options: { mode: 'exclusive' }, callback: () => Promise<T>): Promise<T> {
      requests.push(name);
      const previous = tails.get(name) ?? Promise.resolve();
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      tails.set(
        name,
        previous.then(() => released),
      );
      return previous.then(() => callback()).finally(() => release());
    },
  };
};

/** Reads the image stored in IndexedDB, through a connection of its own. */
const readStoredImage = (dbName: string): Promise<Uint8Array | null> =>
  new Promise((resolve, reject) => {
    const open = indexedDB.open(dbName, 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).get('db');
      request.onsuccess = () => resolve((request.result as Uint8Array | undefined) ?? null);
      request.onerror = () => reject(request.error);
      tx.oncomplete = () => db.close();
    };
  });

/** The labels in the stored image's items table, in id order. */
const storedLabels = async (dbName: string): Promise<string[]> => {
  const image = await readStoredImage(dbName);
  if (!image) return [];
  const SQL = await initSqlJs();
  const db = new SQL.Database(image);
  try {
    const rows = db.exec('SELECT label FROM items ORDER BY id');
    return rows.length ? rows[0].values.map(([label]) => String(label)) : [];
  } finally {
    db.close();
  }
};

/** A promise and the function that settles it. */
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

/** Lets queued work, fake-indexeddb's included, run for a while. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 25; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

describe('IndexedDbAdapter across tabs', () => {
  const opened: IndexedDbAdapter[] = [];

  const labels = async (adapter: IndexedDbAdapter): Promise<string[]> =>
    (await adapter.all<{ label: string }>('SELECT label FROM items ORDER BY id')).map((row) => row.label);

  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory());
  });

  afterEach(async () => {
    for (const adapter of opened.splice(0)) {
      try {
        await adapter.close();
      } catch {
        // A spec may leave the adapter closed or failing.
      }
    }
    vi.unstubAllGlobals();
  });

  describe('with Web Locks', () => {
    let locks: ReturnType<typeof createLockManager>;

    /** Opens a tab on `dbName`; the first one makes the items table. */
    const openTab = async (dbName: string): Promise<IndexedDbAdapter> => {
      const adapter = new IndexedDbAdapter({ dbName, crossTab: { locks } });
      opened.push(adapter);
      await adapter.open();
      await adapter.exec('CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, label TEXT NOT NULL)');
      return adapter;
    };

    beforeEach(() => {
      locks = createLockManager();
    });

    it("keeps both tabs' writes when each tab loaded the database before the other wrote", async () => {
      const first = await openTab('two-tabs');
      const second = await openTab('two-tabs');

      await first.run('INSERT INTO items (label) VALUES (?)', ['from the first tab']);
      await second.run('INSERT INTO items (label) VALUES (?)', ['from the second tab']);

      expect(await storedLabels('two-tabs')).toEqual(['from the first tab', 'from the second tab']);
      expect(await labels(first)).toEqual(['from the first tab', 'from the second tab']);
      expect(locks.requests.length).toBeGreaterThan(0);
    });

    it('stores a write before it resolves, with no tick', async () => {
      const tab = await openTab('stored-at-once');

      await tab.run('INSERT INTO items (label) VALUES (?)', ['stored']);

      expect(await storedLabels('stored-at-once')).toEqual(['stored']);
    });

    it('lets a tab read what another tab stored after it opened', async () => {
      const reader = await openTab('read-visibility');
      const writer = await openTab('read-visibility');

      await writer.run('INSERT INTO items (label) VALUES (?)', ['written in another tab']);

      expect(await labels(reader)).toEqual(['written in another tab']);
    });

    it('keeps every write when two tabs write at the same time', async () => {
      const first = await openTab('interleaved');
      const second = await openTab('interleaved');

      await Promise.all([
        ...Array.from({ length: 10 }, (_, i) => first.run('INSERT INTO items (label) VALUES (?)', [`first ${i}`])),
        ...Array.from({ length: 10 }, (_, i) => second.run('INSERT INTO items (label) VALUES (?)', [`second ${i}`])),
      ]);

      const stored = await storedLabels('interleaved');
      expect(stored).toHaveLength(20);
      expect([...stored].sort()).toEqual(
        [...Array.from({ length: 10 }, (_, i) => `first ${i}`), ...Array.from({ length: 10 }, (_, i) => `second ${i}`)].sort(),
      );
    });

    it("holds another tab's write until a transaction commits, and keeps both", async () => {
      const first = await openTab('transaction-holds');
      const second = await openTab('transaction-holds');
      const inside = deferred();
      const finish = deferred();

      const transaction = first.transaction(async (trx) => {
        await trx.run('INSERT INTO items (label) VALUES (?)', ['in the transaction']);
        inside.resolve();
        await finish.promise;
        await trx.run('INSERT INTO items (label) VALUES (?)', ['also in the transaction']);
      });
      await inside.promise;

      let written = false;
      const write = second.run('INSERT INTO items (label) VALUES (?)', ['from the other tab']).then(() => {
        written = true;
      });
      await settle();
      expect(written).toBe(false);

      finish.resolve();
      await Promise.all([transaction, write]);
      expect(await storedLabels('transaction-holds')).toEqual([
        'in the transaction',
        'also in the transaction',
        'from the other tab',
      ]);
    });

    it("stores nothing of a transaction that rolls back, and keeps the other tab's write", async () => {
      const first = await openTab('rollback-across');
      const second = await openTab('rollback-across');
      const inside = deferred();
      const finish = deferred();

      const transaction = first
        .transaction(async (trx) => {
          await trx.run('INSERT INTO items (label) VALUES (?)', ['rolled back']);
          inside.resolve();
          await finish.promise;
          throw new Error('roll back');
        })
        .catch((error: Error) => error.message);
      await inside.promise;
      const write = second.run('INSERT INTO items (label) VALUES (?)', ['kept']);

      finish.resolve();
      expect(await transaction).toBe('roll back');
      await write;
      expect(await storedLabels('rollback-across')).toEqual(['kept']);
      expect(await labels(first)).toEqual(['kept']);
    });

    it('sees what an adapter without crossTab saved', async () => {
      const tab = await openTab('mixed');
      const plain = new IndexedDbAdapter({ dbName: 'mixed', autoSave: false });
      opened.push(plain);
      await plain.open();
      await plain.run('INSERT INTO items (label) VALUES (?)', ['saved by a plain adapter']);
      await plain.flush();

      expect(await labels(tab)).toEqual(['saved by a plain adapter']);
    });
  });

  describe('without Web Locks', () => {
    /** Opens a tab on `dbName` that coordinates by the version stamp alone. */
    const openTab = async (dbName: string): Promise<IndexedDbAdapter> => {
      const adapter = new IndexedDbAdapter({ dbName, crossTab: { locks: null } });
      opened.push(adapter);
      await adapter.open();
      await adapter.exec('CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, label TEXT NOT NULL)');
      return adapter;
    };

    it("keeps every write when two tabs write at the same time", async () => {
      const first = await openTab('no-locks-interleaved');
      const second = await openTab('no-locks-interleaved');

      await Promise.all([
        ...Array.from({ length: 10 }, (_, i) => first.run('INSERT INTO items (label) VALUES (?)', [`first ${i}`])),
        ...Array.from({ length: 10 }, (_, i) => second.run('INSERT INTO items (label) VALUES (?)', [`second ${i}`])),
      ]);

      const stored = await storedLabels('no-locks-interleaved');
      expect(stored).toHaveLength(20);
      expect(await labels(first)).toHaveLength(20);
    });

    it('refuses a transaction another tab saved over, stores nothing of it, and a retry keeps both', async () => {
      const first = await openTab('no-locks-conflict');
      const second = await openTab('no-locks-conflict');

      const refused = await first
        .transaction(async (trx) => {
          await trx.run('INSERT INTO items (label) VALUES (?)', ['lost the race']);
          // Without Web Locks nothing holds the other tab back while this callback runs.
          await second.run('INSERT INTO items (label) VALUES (?)', ['saved first']);
        })
        .then(
          () => null,
          (error: unknown) => error,
        );

      expect(refused).toBeInstanceOf(IndexedDbConflictError);
      expect((refused as Error).name).toBe('IndexedDbConflictError');
      expect(await storedLabels('no-locks-conflict')).toEqual(['saved first']);
      expect(await labels(first)).toEqual(['saved first']);

      await first.transaction(async (trx) => {
        await trx.run('INSERT INTO items (label) VALUES (?)', ['retried']);
      });
      expect(await storedLabels('no-locks-conflict')).toEqual(['saved first', 'retried']);
    });

    it('runs without Web Locks, and says so once, when the browser has none', async () => {
      vi.stubGlobal('navigator', {});
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const first = new IndexedDbAdapter({ dbName: 'no-web-locks', crossTab: true });
        const second = new IndexedDbAdapter({ dbName: 'no-web-locks', crossTab: true });
        opened.push(first, second);
        await first.open();
        await second.open();
        await first.exec('CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, label TEXT NOT NULL)');
        await first.run('INSERT INTO items (label) VALUES (?)', ['first']);
        await second.run('INSERT INTO items (label) VALUES (?)', ['second']);

        expect(await storedLabels('no-web-locks')).toEqual(['first', 'second']);
        const lockWarnings = warn.mock.calls.filter(([message]) => String(message).includes('Web Locks'));
        expect(lockWarnings.length).toBeGreaterThanOrEqual(1);
        expect(lockWarnings.length).toBeLessThanOrEqual(2);
      } finally {
        warn.mockRestore();
      }
    });
  });
});
