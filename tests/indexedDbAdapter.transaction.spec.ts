import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import initSqlJs from 'sql.js';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
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
      // The pattern Quarry's plugin API and frame.dev's block database use.
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

    it('tries again when its transaction aborts after the put succeeded', async () => {
      const adapter = await openWithItems('save-abort');
      await adapter.run('INSERT INTO items (label) VALUES (?)', ['kept']);

      IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
        const request = originalPut.apply(this, args);
        request.addEventListener('success', () => this.transaction.abort());
        return request;
      };
      tick();
      expect(await storedLabels('save-abort')).toBeNull();

      IDBObjectStore.prototype.put = originalPut;
      tick();
      expect(await storedLabels('save-abort')).toEqual(['kept']);
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
  });
});
