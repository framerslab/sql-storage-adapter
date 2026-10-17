import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import initSqlJs from 'sql.js';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { IndexedDbAdapter } from '../src/adapters/indexedDbAdapter';

// durability: 'commit' saves a write to IndexedDB before the call that made it
// resolves; flush() saves every write made so far. These specs run on
// fake-indexeddb with setInterval faked and never advanced, so the auto-save
// tick never fires: whatever is stored was stored by the call itself.

const STORE = 'sqliteDb';

/** Reads the image the adapter last stored, through a connection of its own. */
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

/** The labels in the stored image's items table, or null when nothing is stored yet. */
const storedLabels = async (dbName: string): Promise<string[] | null> => {
  const image = await readStoredImage(dbName);
  if (!image) return null;
  const SQL = await initSqlJs();
  const db = new SQL.Database(image);
  try {
    const result = db.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'items'");
    if (!result.length) return [];
    const rows = db.exec('SELECT label FROM items ORDER BY id');
    return rows.length ? rows[0].values.map(([label]) => String(label)) : [];
  } finally {
    db.close();
  }
};

/** A PRAGMA's value in the stored image, or null when nothing is stored yet. */
const storedPragma = async (dbName: string, name: string): Promise<unknown> => {
  const image = await readStoredImage(dbName);
  if (!image) return null;
  const SQL = await initSqlJs();
  const db = new SQL.Database(image);
  try {
    return db.exec(`PRAGMA ${name}`)[0]?.values?.[0]?.[0] ?? null;
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

describe('IndexedDbAdapter durability', () => {
  const opened: IndexedDbAdapter[] = [];

  const openAdapter = async (
    dbName: string,
    durability: 'commit' | 'interval' = 'commit',
  ): Promise<IndexedDbAdapter> => {
    const adapter = new IndexedDbAdapter({ dbName, durability, saveIntervalMs: 1_000 });
    opened.push(adapter);
    await adapter.open();
    return adapter;
  };

  const openWithItems = async (dbName: string, durability: 'commit' | 'interval' = 'commit'): Promise<IndexedDbAdapter> => {
    const adapter = await openAdapter(dbName, durability);
    await adapter.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL)');
    return adapter;
  };

  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  });

  afterEach(async () => {
    for (const adapter of opened.splice(0)) {
      try {
        await adapter.close();
      } catch {
        // A spec may leave the adapter closed or failing.
      }
    }
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe("durability: 'commit'", () => {
    it('stores a run() before it resolves', async () => {
      const adapter = await openWithItems('commit-run');
      expect(await storedLabels('commit-run')).toEqual([]);

      await adapter.run('INSERT INTO items (label) VALUES (?)', ['stored']);

      expect(await storedLabels('commit-run')).toEqual(['stored']);
    });

    it('stores an exec() before it resolves', async () => {
      const adapter = await openWithItems('commit-exec');

      await adapter.exec("INSERT INTO items (label) VALUES ('one'); INSERT INTO items (label) VALUES ('two')");

      expect(await storedLabels('commit-exec')).toEqual(['one', 'two']);
    });

    it('stores a write made through all(), as INSERT ... RETURNING is, before it resolves', async () => {
      const adapter = await openWithItems('commit-returning');

      const rows = await adapter.all<{ id: number }>('INSERT INTO items (label) VALUES (?) RETURNING id', ['returned']);

      expect(rows).toEqual([{ id: 1 }]);
      expect(await storedLabels('commit-returning')).toEqual(['returned']);
    });

    // SQLite's change counter, total_changes(), counts no PRAGMA: an assignment
    // to a header field changes the image all the same.
    it('stores PRAGMA user_version and application_id set through get() and all() before they resolve', async () => {
      const adapter = await openWithItems('commit-pragma-header');
      expect(await storedPragma('commit-pragma-header', 'user_version')).toBe(0);

      await adapter.get('PRAGMA user_version = 3');
      expect(await storedPragma('commit-pragma-header', 'user_version')).toBe(3);

      await adapter.all('PRAGMA main.application_id = 42');
      expect(await storedPragma('commit-pragma-header', 'application_id')).toBe(42);

      await adapter.get('PRAGMA user_version(4)');
      expect(await storedPragma('commit-pragma-header', 'user_version')).toBe(4);
    });

    it('writes nothing to IndexedDB for PRAGMA reads and connection settings through get() and all()', async () => {
      const adapter = await openWithItems('commit-pragma-reads');
      const puts = vi.spyOn(IDBObjectStore.prototype, 'put');
      try {
        expect((await adapter.all<{ name: string }>('PRAGMA table_info(items)')).map((column) => column.name)).toEqual([
          'id',
          'label',
        ]);
        await adapter.all('PRAGMA index_list(items)');
        expect(await adapter.get('PRAGMA user_version')).toEqual({ user_version: 0 });
        await adapter.get('PRAGMA foreign_keys = ON');
        await adapter.get('PRAGMA cache_size = 500');

        expect(puts).not.toHaveBeenCalled();
      } finally {
        puts.mockRestore();
      }
    });

    it('stores a transaction before transaction() resolves, and nothing of one that rolls back', async () => {
      const adapter = await openWithItems('commit-transaction');

      await adapter.transaction(async (trx) => {
        await trx.run('INSERT INTO items (label) VALUES (?)', ['first']);
        await trx.run('INSERT INTO items (label) VALUES (?)', ['second']);
      });
      expect(await storedLabels('commit-transaction')).toEqual(['first', 'second']);

      await expect(
        adapter.transaction(async (trx) => {
          await trx.run('INSERT INTO items (label) VALUES (?)', ['doomed']);
          throw new Error('roll back');
        }),
      ).rejects.toThrow('roll back');
      expect(await storedLabels('commit-transaction')).toEqual(['first', 'second']);
    });

    it('stores every one of several writes made at once by the time each resolves', async () => {
      const adapter = await openWithItems('commit-concurrent');

      await Promise.all(
        ['a', 'b', 'c', 'd', 'e'].map(async (label) => {
          await adapter.run('INSERT INTO items (label) VALUES (?)', [label]);
          expect(await storedLabels('commit-concurrent')).toContain(label);
        }),
      );

      expect(await storedLabels('commit-concurrent')).toEqual(['a', 'b', 'c', 'd', 'e']);
    });

    it("lets a caller's BEGIN resolve at once and stores its rows when COMMIT resolves", async () => {
      const adapter = await openWithItems('commit-begin');

      await adapter.run('BEGIN');
      await adapter.run('INSERT INTO items (label) VALUES (?)', ['inside']);
      expect(await storedLabels('commit-begin')).toEqual([]);

      await adapter.run('COMMIT');
      expect(await storedLabels('commit-begin')).toEqual(['inside']);
    });

    it('stores a write made just before a transaction() began once that transaction commits', async () => {
      const adapter = await openWithItems('commit-before-transaction');
      const inside = deferred();
      const finish = deferred();

      const write = adapter.run('INSERT INTO items (label) VALUES (?)', ['before']);
      const transaction = adapter.transaction(async (trx) => {
        inside.resolve();
        await finish.promise;
        await trx.run('INSERT INTO items (label) VALUES (?)', ['inside']);
      });
      await inside.promise;
      finish.resolve();

      await Promise.all([write, transaction]);
      expect(await storedLabels('commit-before-transaction')).toEqual(['before', 'inside']);
    });

    describe('a save that IndexedDB aborts', () => {
      let originalPut: typeof IDBObjectStore.prototype.put;

      beforeEach(() => {
        originalPut = IDBObjectStore.prototype.put;
      });

      afterEach(() => {
        IDBObjectStore.prototype.put = originalPut;
      });

      it('rejects the write whose save aborted after its put succeeded, and the next save stores it', async () => {
        const adapter = await openWithItems('commit-abort');
        IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
          const request = originalPut.apply(this, args);
          request.addEventListener('success', () => this.transaction.abort());
          return request;
        };

        await expect(adapter.run('INSERT INTO items (label) VALUES (?)', ['unsure'])).rejects.toBeDefined();
        expect(await storedLabels('commit-abort')).toEqual([]);

        IDBObjectStore.prototype.put = originalPut;
        await adapter.run('INSERT INTO items (label) VALUES (?)', ['next']);
        expect(await storedLabels('commit-abort')).toEqual(['unsure', 'next']);
      });
    });
  });

  // sql.js's export(), which every save runs, closes the connection and opens
  // it again, which resets the settings a caller made on the connection.
  describe('what a save keeps', () => {
    it('keeps foreign_keys and the other connection settings a caller made across saves', async () => {
      const adapter = await openAdapter('pragmas-kept');
      await adapter.exec('PRAGMA foreign_keys = ON');
      await adapter.exec('PRAGMA recursive_triggers = ON');
      await adapter.exec(
        'CREATE TABLE parents (id INTEGER PRIMARY KEY); ' +
          'CREATE TABLE children (id INTEGER PRIMARY KEY, parent INTEGER NOT NULL REFERENCES parents (id))',
      );
      await adapter.run('INSERT INTO parents (id) VALUES (?)', [1]);

      await expect(adapter.run('INSERT INTO children (id, parent) VALUES (?, ?)', [1, 99])).rejects.toThrow(/FOREIGN KEY/);
      expect(await adapter.get('PRAGMA foreign_keys')).toEqual({ foreign_keys: 1 });
      expect(await adapter.get('PRAGMA recursive_triggers')).toEqual({ recursive_triggers: 1 });
    });

    it('refuses to import bytes that are not a SQLite database, and keeps its own', async () => {
      const adapter = await openWithItems('import-refused', 'interval');
      await adapter.run('INSERT INTO items (label) VALUES (?)', ['kept']);

      await expect(adapter.importDatabase(new TextEncoder().encode('not a database file, just text'))).rejects.toThrow(
        /not a SQLite database/,
      );

      expect((await adapter.all<{ label: string }>('SELECT label FROM items')).map((row) => row.label)).toEqual(['kept']);
    });
  });

  describe("durability: 'interval', the default", () => {
    it('saves on the tick, not before', async () => {
      const adapter = await openWithItems('interval-tick', 'interval');

      await adapter.run('INSERT INTO items (label) VALUES (?)', ['waits']);
      expect(await storedLabels('interval-tick')).toBeNull();

      vi.advanceTimersByTime(1_000);
      await settle();
      expect(await storedLabels('interval-tick')).toEqual(['waits']);
    });

    it('saves a write made through all() outside a transaction on the next tick', async () => {
      const adapter = await openWithItems('interval-returning', 'interval');
      vi.advanceTimersByTime(1_000);
      await settle();
      expect(await storedLabels('interval-returning')).toEqual([]);

      await adapter.all('INSERT INTO items (label) VALUES (?) RETURNING id', ['returned']);
      vi.advanceTimersByTime(1_000);
      await settle();

      expect(await storedLabels('interval-returning')).toEqual(['returned']);
    });
  });

  // close() saves only what is unsaved. A PRAGMA user_version set through get()
  // after everything else was stored must still reach IndexedDB.
  it('keeps PRAGMA user_version set through get() across close() and open()', async () => {
    const adapter = await openWithItems('interval-pragma', 'interval');
    await adapter.flush();
    await adapter.get('PRAGMA user_version = 7');
    await adapter.close();

    const reopened = await openAdapter('interval-pragma', 'interval');
    expect(await reopened.get('PRAGMA user_version')).toEqual({ user_version: 7 });
  });

  describe('flush()', () => {
    it('stores the writes made so far, with no tick', async () => {
      const adapter = await openWithItems('flush-writes', 'interval');
      await adapter.run('INSERT INTO items (label) VALUES (?)', ['one']);
      await adapter.run('INSERT INTO items (label) VALUES (?)', ['two']);
      expect(await storedLabels('flush-writes')).toBeNull();

      await adapter.flush();

      expect(await storedLabels('flush-writes')).toEqual(['one', 'two']);
    });

    it('resolves when nothing is waiting to be saved', async () => {
      const adapter = await openAdapter('flush-nothing', 'interval');

      await expect(adapter.flush()).resolves.toBeUndefined();
    });

    it('waits for an open transaction() to commit, then stores it', async () => {
      const adapter = await openWithItems('flush-transaction', 'interval');
      const inside = deferred();
      const finish = deferred();
      const transaction = adapter.transaction(async (trx) => {
        await trx.run('INSERT INTO items (label) VALUES (?)', ['inside']);
        inside.resolve();
        await finish.promise;
      });
      await inside.promise;

      let flushed = false;
      const flush = adapter.flush().then(() => {
        flushed = true;
      });
      await settle();
      expect(flushed).toBe(false);

      finish.resolve();
      await Promise.all([transaction, flush]);
      expect(await storedLabels('flush-transaction')).toEqual(['inside']);
    });

    it("refuses while a caller's BEGIN is open, which it cannot save without ending", async () => {
      const adapter = await openWithItems('flush-begin', 'interval');
      await adapter.run('BEGIN');
      await adapter.run('INSERT INTO items (label) VALUES (?)', ['inside']);

      await expect(adapter.flush()).rejects.toThrow(/BEGIN/);

      await adapter.run('COMMIT');
      await adapter.flush();
      expect(await storedLabels('flush-begin')).toEqual(['inside']);
    });
  });
});
