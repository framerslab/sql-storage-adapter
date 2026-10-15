import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import initSqlJs from 'sql.js';
import { IDBDatabase, IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { IndexedDbAdapter } from '../src/adapters/indexedDbAdapter';

// IndexedDbAdapter runs SQL on sql.js and writes the whole database image to
// IndexedDB from an interval timer. These specs run it on fake-indexeddb, an
// implementation of the IndexedDB specification for Node. Only setInterval and
// clearInterval are faked, so each spec fires the auto-save tick exactly where
// it needs one; fake-indexeddb schedules its own work with setImmediate, which
// stays real.

const STORE = 'sqliteDb';
const SAVE_INTERVAL_MS = 1_000;

/** Reads the image the adapter last stored, through a connection of its own. */
const readStoredImage = (dbName: string): Promise<Uint8Array | null> =>
  new Promise((resolve, reject) => {
    const open = indexedDB.open(dbName, 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      // Created after any save the adapter has started, so it reads once that save finishes.
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
    const result = db.exec('SELECT label FROM items ORDER BY id');
    return result.length ? result[0].values.map(([label]) => String(label)) : [];
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

/** Lets queued work run until `done` holds, for a bounded number of turns. */
const until = async (done: () => boolean): Promise<void> => {
  for (let i = 0; i < 100 && !done(); i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  expect(done()).toBe(true);
};

/** Fires the auto-save interval once. */
const tick = (): void => {
  vi.advanceTimersByTime(SAVE_INTERVAL_MS);
};

describe('IndexedDbAdapter transactions and saving', () => {
  const opened: IndexedDbAdapter[] = [];

  const openAdapter = async (dbName: string): Promise<IndexedDbAdapter> => {
    const adapter = new IndexedDbAdapter({ dbName, saveIntervalMs: SAVE_INTERVAL_MS });
    opened.push(adapter);
    await adapter.open();
    return adapter;
  };

  const openWithItems = async (dbName: string): Promise<IndexedDbAdapter> => {
    const adapter = await openAdapter(dbName);
    await adapter.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL)');
    return adapter;
  };

  const labels = async (adapter: IndexedDbAdapter): Promise<string[]> =>
    (await adapter.all<{ label: string }>('SELECT label FROM items ORDER BY id')).map((row) => row.label);

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

  describe('the auto-save tick and an open transaction', () => {
    it('commits a transaction whole when a tick fires while it awaits, and saves none of it early', async () => {
      const adapter = await openWithItems('tick-commit');
      tick();
      expect(await storedLabels('tick-commit')).toEqual([]);

      await adapter.transaction(async (trx) => {
        await trx.run('INSERT INTO items (label) VALUES (?)', ['first']);
        tick();
        expect(await storedLabels('tick-commit')).toEqual([]);
        await trx.run('INSERT INTO items (label) VALUES (?)', ['second']);
      });

      expect(await labels(adapter)).toEqual(['first', 'second']);
      tick();
      expect(await storedLabels('tick-commit')).toEqual(['first', 'second']);
    });

    it('rolls a transaction back whole when it throws after a tick, and nothing of it is stored', async () => {
      const adapter = await openWithItems('tick-rollback');

      await expect(
        adapter.transaction(async (trx) => {
          await trx.run('INSERT INTO items (label) VALUES (?)', ['doomed']);
          tick();
          await settle();
          await trx.run('INSERT INTO items (label) VALUES (?)', ['also doomed']);
          throw new Error('roll back');
        }),
      ).rejects.toThrow('roll back');

      expect(await labels(adapter)).toEqual([]);
      await adapter.close();
      const reopened = await openAdapter('tick-rollback');
      expect(await labels(reopened)).toEqual([]);
    });

    it("keeps a caller's own BEGIN open across a tick and saves its rows after COMMIT", async () => {
      // Hosts that manage their own transactions through exec() do this.
      const adapter = await openWithItems('caller-begin');
      tick();

      await adapter.exec('BEGIN TRANSACTION');
      await adapter.run('INSERT INTO items (label) VALUES (?)', ['a']);
      tick();
      expect(await storedLabels('caller-begin')).toEqual([]);
      await adapter.run('INSERT INTO items (label) VALUES (?)', ['b']);
      await adapter.exec('COMMIT');

      tick();
      expect(await storedLabels('caller-begin')).toEqual(['a', 'b']);
    });

    it("keeps the committed rows when it closes with a caller's transaction still open", async () => {
      const adapter = await openWithItems('close-open');
      await adapter.run('INSERT INTO items (label) VALUES (?)', ['committed']);
      await adapter.run('BEGIN');
      await adapter.run('INSERT INTO items (label) VALUES (?)', ['never committed']);

      await adapter.close();

      const reopened = await openAdapter('close-open');
      expect(await labels(reopened)).toEqual(['committed']);
    });

    it('saves a transaction whose writes went through all(), as INSERT ... RETURNING does', async () => {
      const adapter = await openWithItems('returning');
      tick();
      expect(await storedLabels('returning')).toEqual([]);

      const rows = await adapter.transaction((trx) =>
        trx.all<{ id: number }>('INSERT INTO items (label) VALUES (?) RETURNING id', ['returned']),
      );
      expect(rows).toEqual([{ id: 1 }]);

      tick();
      expect(await storedLabels('returning')).toEqual(['returned']);
    });

    it('refuses exportDatabase() while a transaction is open instead of ending it', async () => {
      const adapter = await openWithItems('export-open');

      await adapter.transaction(async (trx) => {
        await trx.run('INSERT INTO items (label) VALUES (?)', ['inside']);
        expect(() => adapter.exportDatabase()).toThrow(/transaction is open/);
        await trx.run('INSERT INTO items (label) VALUES (?)', ['still inside']);
      });

      expect(await labels(adapter)).toEqual(['inside', 'still inside']);
      expect(adapter.exportDatabase()).toBeInstanceOf(Uint8Array);
    });
  });

  describe('overlapping transactions', () => {
    it('runs two overlapping transactions one after the other, and both commit', async () => {
      const adapter = await openWithItems('overlap');
      const firstStarted = deferred();
      const firstCanFinish = deferred();
      const order: string[] = [];

      const first = adapter.transaction(async (trx) => {
        order.push('first:start');
        await trx.run('INSERT INTO items (label) VALUES (?)', ['first']);
        firstStarted.resolve();
        await firstCanFinish.promise;
        await trx.run('INSERT INTO items (label) VALUES (?)', ['first again']);
        order.push('first:end');
      });
      await Promise.race([firstStarted.promise, first]);

      const second = adapter.transaction(async (trx) => {
        order.push('second:start');
        await trx.run('INSERT INTO items (label) VALUES (?)', ['second']);
        order.push('second:end');
      });
      await settle();
      expect(order).toEqual(['first:start']);

      firstCanFinish.resolve();
      await Promise.all([first, second]);

      expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
      expect(await labels(adapter)).toEqual(['first', 'first again', 'second']);
    });

    it('starts the next transaction after one that rolls back', async () => {
      const adapter = await openWithItems('overlap-rollback');
      const firstStarted = deferred();
      const firstCanFinish = deferred();

      const first = adapter
        .transaction(async (trx) => {
          await trx.run('INSERT INTO items (label) VALUES (?)', ['rolled back']);
          firstStarted.resolve();
          await firstCanFinish.promise;
          throw new Error('roll back');
        })
        .catch((error: Error) => error.message);
      await Promise.race([firstStarted.promise, first]);

      const second = adapter.transaction(async (trx) => {
        await trx.run('INSERT INTO items (label) VALUES (?)', ['kept']);
      });

      firstCanFinish.resolve();
      expect(await first).toBe('roll back');
      await second;
      expect(await labels(adapter)).toEqual(['kept']);
    });

    it("runs the callback's handle statements and a nested transaction in the open transaction", async () => {
      const adapter = await openWithItems('nested');

      await expect(
        adapter.transaction(async (trx) => {
          await trx.run('INSERT INTO items (label) VALUES (?)', ['outer']);
          await trx.transaction(async (nested) => {
            await nested.run('INSERT INTO items (label) VALUES (?)', ['nested']);
          });
          throw new Error('roll back');
        }),
      ).rejects.toThrow('roll back');

      expect(await labels(adapter)).toEqual([]);
    });
  });

  // The adapter has one connection, so a statement another caller issues while
  // a transaction's callback awaits would otherwise run inside that transaction.
  describe('statements from outside an open transaction', () => {
    it('makes a write wait for the transaction to end, so it survives the rollback', async () => {
      const adapter = await openWithItems('outside-write');
      const started = deferred();
      const outsideWork = deferred();
      const transaction = adapter
        .transaction(async (trx) => {
          await trx.run('INSERT INTO items (label) VALUES (?)', ['inside']);
          started.resolve();
          // The callback waits on work outside the database.
          await outsideWork.promise;
          throw new Error('roll back');
        })
        .catch((error: Error) => error.message);
      await Promise.race([started.promise, transaction]);

      let written = false;
      const write = adapter.run('INSERT INTO items (label) VALUES (?)', ['outside']).then(() => {
        written = true;
      });
      await settle();
      expect(written).toBe(false);

      outsideWork.resolve();
      expect(await transaction).toBe('roll back');
      await write;
      expect(await labels(adapter)).toEqual(['outside']);
    });

    it('does not let a read see rows the transaction has not committed', async () => {
      const adapter = await openWithItems('outside-read');
      const started = deferred();
      const finish = deferred();
      const transaction = adapter
        .transaction(async (trx) => {
          await trx.run('INSERT INTO items (label) VALUES (?)', ['uncommitted']);
          started.resolve();
          await finish.promise;
          throw new Error('roll back');
        })
        .catch(() => undefined);
      await Promise.race([started.promise, transaction]);

      const read = labels(adapter);
      await settle();
      finish.resolve();
      await transaction;
      expect(await read).toEqual([]);
    });
  });

  // all() and get() run INSERT, UPDATE and DELETE ... RETURNING too, and such a
  // write must reach IndexedDB like one made through run().
  describe('writes through all() and get() outside a transaction', () => {
    it('saves an INSERT ... RETURNING run through all() on the next tick', async () => {
      const adapter = await openWithItems('all-returning');
      tick();
      expect(await storedLabels('all-returning')).toEqual([]);

      const rows = await adapter.all<{ id: number }>('INSERT INTO items (label) VALUES (?) RETURNING id', ['returned']);
      expect(rows).toEqual([{ id: 1 }]);

      tick();
      expect(await storedLabels('all-returning')).toEqual(['returned']);
    });

    it('saves an UPDATE ... RETURNING run through get() when it closes', async () => {
      const adapter = await openWithItems('get-returning');
      await adapter.run('INSERT INTO items (label) VALUES (?)', ['before']);
      tick();
      expect(await storedLabels('get-returning')).toEqual(['before']);

      // A comment ahead of the statement does not hide the write.
      const row = await adapter.get<{ label: string }>(
        '/* rename */ UPDATE items SET label = ? WHERE id = 1 RETURNING label',
        ['after'],
      );
      expect(row).toEqual({ label: 'after' });

      await adapter.close();
      const reopened = await openAdapter('get-returning');
      expect(await labels(reopened)).toEqual(['after']);
    });

    it('saves a WITH ... INSERT run through all()', async () => {
      const adapter = await openWithItems('with-insert');
      tick();
      expect(await storedLabels('with-insert')).toEqual([]);

      await adapter.all(
        "WITH incoming(label) AS (VALUES ('from a common table expression')) " +
          'INSERT INTO items (label) SELECT label FROM incoming RETURNING id',
      );

      tick();
      expect(await storedLabels('with-insert')).toEqual(['from a common table expression']);
    });
  });

  // sql.js's export() closes and reopens the connection, which sets every
  // PRAGMA back to its default. Each save, exportDatabase() and
  // importDatabase() goes through it.
  describe('connection settings across a save', () => {
    const childParents = async (adapter: IndexedDbAdapter): Promise<number[]> =>
      (await adapter.all<{ parent_id: number }>('SELECT parent_id FROM child ORDER BY parent_id')).map(
        (row) => row.parent_id,
      );

    it('keeps PRAGMA foreign_keys on after a save, an export and an import', async () => {
      const adapter = await openAdapter('foreign-keys');
      await adapter.exec('PRAGMA foreign_keys = ON');
      await adapter.exec(
        'CREATE TABLE parent (id INTEGER PRIMARY KEY);' +
          'CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent (id) ON DELETE CASCADE);' +
          'INSERT INTO parent (id) VALUES (1), (2), (3);' +
          'INSERT INTO child (parent_id) VALUES (1), (2), (3);',
      );

      // The tick's save exports the image.
      tick();
      expect(await readStoredImage('foreign-keys')).not.toBeNull();
      expect(await adapter.get('PRAGMA foreign_keys')).toEqual({ foreign_keys: 1 });
      await adapter.run('DELETE FROM parent WHERE id = 1');
      expect(await childParents(adapter)).toEqual([2, 3]);

      adapter.exportDatabase();
      expect(await adapter.get('PRAGMA foreign_keys')).toEqual({ foreign_keys: 1 });

      await adapter.importDatabase(adapter.exportDatabase());
      expect(await adapter.get('PRAGMA foreign_keys')).toEqual({ foreign_keys: 1 });
      await adapter.run('DELETE FROM parent WHERE id = 2');
      expect(await childParents(adapter)).toEqual([3]);
    });

    it('keeps PRAGMA foreign_keys = OFF run after foreignKeys: true at open, across a save', async () => {
      // SQLite's procedure for changing a table turns enforcement off around the rebuild.
      const adapter = new IndexedDbAdapter({ dbName: 'foreign-keys-off', saveIntervalMs: SAVE_INTERVAL_MS });
      opened.push(adapter);
      await adapter.open({ foreignKeys: true });
      expect(await adapter.get('PRAGMA foreign_keys')).toEqual({ foreign_keys: 1 });

      await adapter.exec('PRAGMA foreign_keys = OFF');
      tick();
      expect(await readStoredImage('foreign-keys-off')).not.toBeNull();

      expect(await adapter.get('PRAGMA foreign_keys')).toEqual({ foreign_keys: 0 });
    });

    it('keeps PRAGMA secure_delete = FAST, which reads back as 2', async () => {
      const adapter = await openAdapter('secure-delete');
      await adapter.exec('PRAGMA secure_delete = FAST');
      expect(await adapter.get('PRAGMA secure_delete')).toEqual({ secure_delete: 2 });

      adapter.exportDatabase();

      expect(await adapter.get('PRAGMA secure_delete')).toEqual({ secure_delete: 2 });
    });
  });

  describe('importDatabase()', () => {
    it('refuses bytes that are not a SQLite database, and keeps its database in memory and in IndexedDB', async () => {
      const adapter = await openWithItems('import-garbage');
      await adapter.run('INSERT INTO items (label) VALUES (?)', ['kept']);
      tick();
      expect(await storedLabels('import-garbage')).toEqual(['kept']);

      await expect(
        adapter.importDatabase(new TextEncoder().encode('these bytes are not a database')),
      ).rejects.toThrow(/not a SQLite database/);

      expect(await labels(adapter)).toEqual(['kept']);
      await adapter.close();
      const reopened = await openAdapter('import-garbage');
      expect(await labels(reopened)).toEqual(['kept']);
    });

    it('refuses a SQLite image cut short, which SQLite reads as damaged', async () => {
      const source = await openWithItems('import-cut-source');
      await source.transaction(async (trx) => {
        for (let i = 0; i < 400; i += 1) {
          await trx.run('INSERT INTO items (label) VALUES (?)', [`row ${i} `.padEnd(200, '.')]);
        }
      });
      const image = source.exportDatabase();
      expect(image.length).toBeGreaterThan(16_384);

      const adapter = await openWithItems('import-cut');
      await adapter.run('INSERT INTO items (label) VALUES (?)', ['kept']);
      await expect(adapter.importDatabase(image.slice(0, 8_192))).rejects.toThrow(/damaged/);

      expect(await labels(adapter)).toEqual(['kept']);
    });

    it('imports an empty image as an empty database', async () => {
      const source = await openAdapter('import-empty-source');
      const empty = source.exportDatabase();

      const adapter = await openWithItems('import-empty');
      await adapter.importDatabase(empty);

      expect(await adapter.all("SELECT name FROM sqlite_master WHERE type = 'table'")).toEqual([]);
    });
  });

  // IndexedDB fires a request's success before its transaction commits, and a
  // transaction can still abort after that (a quota error at commit).
  describe('a save to IndexedDB', () => {
    let originalPut: typeof IDBObjectStore.prototype.put;

    beforeEach(() => {
      originalPut = IDBObjectStore.prototype.put;
    });

    afterEach(() => {
      IDBObjectStore.prototype.put = originalPut;
    });

    it('reports a save whose transaction aborts after the put succeeded once, and saves on the next tick', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const adapter = await openWithItems('save-abort');
        await adapter.run('INSERT INTO items (label) VALUES (?)', ['kept']);

        IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
          const request = originalPut.apply(this, args);
          request.addEventListener('success', () => this.transaction.abort());
          return request;
        };
        tick();
        expect(await storedLabels('save-abort')).toBeNull();
        // The adapter learns of the abort from its transaction's abort event,
        // which can arrive after another connection's read has finished; until
        // then the save is in progress and a tick starts no other.
        await until(() => warn.mock.calls.length > 0);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0][0])).toContain('"save-abort"');

        IDBObjectStore.prototype.put = originalPut;
        tick();
        expect(await storedLabels('save-abort')).toEqual(['kept']);
        expect(warn).toHaveBeenCalledTimes(1);
      } finally {
        warn.mockRestore();
      }
    });

    it('saves an imported database before importDatabase() resolves, with no tick', async () => {
      const source = await openWithItems('import-source');
      await source.run('INSERT INTO items (label) VALUES (?)', ['imported']);
      const image = source.exportDatabase();

      const adapter = await openAdapter('import-target');
      await adapter.importDatabase(image);

      expect(await storedLabels('import-target')).toEqual(['imported']);
      expect(await labels(adapter)).toEqual(['imported']);
    });

    it('closes once when close() is called twice at once, and keeps the rows', async () => {
      const adapter = await openWithItems('double-close');
      await adapter.run('INSERT INTO items (label) VALUES (?)', ['kept']);

      await Promise.all([adapter.close(), adapter.close()]);

      const reopened = await openAdapter('double-close');
      expect(await labels(reopened)).toEqual(['kept']);
    });

    it('saves a write that lands while a save is in flight with the next save', async () => {
      const adapter = await openWithItems('save-race');
      await adapter.run('INSERT INTO items (label) VALUES (?)', ['before']);

      let wroteDuringSave = false;
      IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
        const request = originalPut.apply(this, args);
        if (!wroteDuringSave) {
          wroteDuringSave = true;
          // The image is exported before put is called, so this write is not in it.
          void adapter.run('INSERT INTO items (label) VALUES (?)', ['during the save']);
        }
        return request;
      };
      tick();
      expect(await storedLabels('save-race')).toEqual(['before']);

      tick();
      expect(await storedLabels('save-race')).toEqual(['before', 'during the save']);
    });

    it('writes nothing to IndexedDB for reads through all() and get(), WITH queries included', async () => {
      const adapter = await openWithItems('reads-only');
      await adapter.run('INSERT INTO items (label) VALUES (?)', ['kept']);
      tick();
      expect(await storedLabels('reads-only')).toEqual(['kept']);

      let puts = 0;
      IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
        puts += 1;
        return originalPut.apply(this, args);
      };
      expect(await labels(adapter)).toEqual(['kept']);
      expect(await adapter.get('SELECT count(*) AS n FROM items')).toEqual({ n: 1 });
      expect(await adapter.all('WITH recent AS (SELECT label FROM items) SELECT label FROM recent')).toEqual([
        { label: 'kept' },
      ]);
      tick();
      await settle();

      expect(puts).toBe(0);
    });

    it('lets a save still running finish before an import saves, so the imported image is the one stored', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const originalTransaction = IDBDatabase.prototype.transaction;
      try {
        const source = await openWithItems('overlap-source');
        await source.run('INSERT INTO items (label) VALUES (?)', ['imported']);
        const image = source.exportDatabase();
        await source.close();

        const adapter = await openWithItems('overlap');
        await adapter.run('INSERT INTO items (label) VALUES (?)', ['older']);

        let puts = 0;
        IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
          puts += 1;
          return originalPut.apply(this, args);
        };
        // The tick's save finds the object store gone once, as when another tab
        // deletes the database, so it reopens IndexedDB and tries again while
        // the import runs.
        let failed = false;
        IDBDatabase.prototype.transaction = function (
          this: IDBDatabase,
          ...args: Parameters<IDBDatabase['transaction']>
        ) {
          if (!failed && args[1] === 'readwrite') {
            failed = true;
            throw new DOMException('The object store was not found.', 'NotFoundError');
          }
          return originalTransaction.apply(this, args);
        };

        tick();
        await adapter.importDatabase(image);
        await until(() => puts === 2);
        await settle();

        expect(await storedLabels('overlap')).toEqual(['imported']);
        expect(await labels(adapter)).toEqual(['imported']);
      } finally {
        IDBDatabase.prototype.transaction = originalTransaction;
        warn.mockRestore();
      }
    });
  });
});
