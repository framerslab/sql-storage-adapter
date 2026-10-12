import { describe, expect, it, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import { createRequire } from 'module';
import * as path from 'path';
import * as os from 'os';
import type { StorageAdapter } from '../src/core/contracts';

// Check if better-sqlite3 native bindings are available
const checkBetterSqliteAvailable = (): boolean => {
  try {
    // Check if the binding file exists in any of the expected locations
    const betterSqlitePath = require.resolve('better-sqlite3');
    const betterSqliteDir = path.dirname(betterSqlitePath);
    const possibleBindings = [
      path.join(betterSqliteDir, '..', 'build', 'Release', 'better_sqlite3.node'),
      path.join(betterSqliteDir, '..', 'build', 'better_sqlite3.node'),
      path.join(betterSqliteDir, '..', 'prebuilds'),
    ];
    return possibleBindings.some(p => fs.existsSync(p));
  } catch {
    return false;
  }
};

const betterSqliteAvailable = checkBetterSqliteAvailable();

describe.skipIf(!betterSqliteAvailable)('BetterSqliteAdapter', () => {
  // Dynamic import to avoid loading the native module during collection
  let createBetterSqliteAdapter: typeof import('../src/index.js').createBetterSqliteAdapter;

  const testDirs: string[] = [];

  afterEach(() => {
    // Clean up test directories
    for (const dir of testDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
    testDirs.length = 0;
  });

  describe('directory creation', () => {
    it('should create parent directory if it does not exist', async () => {
      const { createBetterSqliteAdapter } = await import('../src/index.js');

      const tempDir = path.join(os.tmpdir(), `sql-adapter-test-${Date.now()}`);
      const dbPath = path.join(tempDir, 'nested', 'db.sqlite');
      testDirs.push(tempDir);

      // Ensure directory doesn't exist
      expect(fs.existsSync(tempDir)).toBe(false);

      const adapter = createBetterSqliteAdapter(dbPath);
      await adapter.open();

      // Verify directory was created
      expect(fs.existsSync(path.dirname(dbPath))).toBe(true);
      expect(fs.existsSync(dbPath)).toBe(true);

      await adapter.close();
    });

    it('should work with existing directory', async () => {
      const { createBetterSqliteAdapter } = await import('../src/index.js');

      const tempDir = path.join(os.tmpdir(), `sql-adapter-test-${Date.now()}`);
      const dbPath = path.join(tempDir, 'db.sqlite');
      testDirs.push(tempDir);

      // Create directory first
      fs.mkdirSync(tempDir, { recursive: true });
      expect(fs.existsSync(tempDir)).toBe(true);

      const adapter = createBetterSqliteAdapter(dbPath);
      await adapter.open();

      expect(fs.existsSync(dbPath)).toBe(true);

      await adapter.close();
    });

    it('should not attempt directory creation for :memory: database', async () => {
      const { createBetterSqliteAdapter } = await import('../src/index.js');

      const adapter = createBetterSqliteAdapter(':memory:');
      await adapter.open();

      // Should open successfully without any directory creation
      await adapter.exec('CREATE TABLE test (id INTEGER PRIMARY KEY)');
      await adapter.run('INSERT INTO test (id) VALUES (1)');
      const result = await adapter.get<{ id: number }>('SELECT id FROM test WHERE id = 1');
      expect(result?.id).toBe(1);

      await adapter.close();
    });
  });

  describe('transaction serialization', () => {
    it('runs overlapping top-level transaction callbacks in FIFO order', async () => {
      const { createBetterSqliteAdapter } = await import('../src/index.js');
      const adapter = createBetterSqliteAdapter(':memory:');
      await adapter.open();
      await adapter.exec('CREATE TABLE events (id INTEGER PRIMARY KEY, label TEXT NOT NULL)');

      let signalFirstStarted!: () => void;
      const firstStarted = new Promise<void>((resolve) => {
        signalFirstStarted = resolve;
      });
      let releaseFirst!: () => void;
      const firstCanFinish = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const callbackOrder: string[] = [];

      const first = adapter.transaction(async (trx) => {
        callbackOrder.push('first:start');
        signalFirstStarted();
        await trx.run('INSERT INTO events (label) VALUES (?)', ['first']);
        await firstCanFinish;
        callbackOrder.push('first:end');
      });

      await firstStarted;
      const second = adapter.transaction(async (trx) => {
        callbackOrder.push('second:start');
        await trx.run('INSERT INTO events (label) VALUES (?)', ['second']);
        callbackOrder.push('second:end');
      });

      await Promise.resolve();
      expect(callbackOrder).toEqual(['first:start']);

      releaseFirst();
      await Promise.all([first, second]);

      expect(callbackOrder).toEqual([
        'first:start',
        'first:end',
        'second:start',
        'second:end',
      ]);
      const rows = await adapter.all<{ label: string }>('SELECT label FROM events ORDER BY id');
      expect(rows.map((row) => row.label)).toEqual(['first', 'second']);
      await adapter.close();
    });

    it('reuses the outer transaction for nested transaction callbacks', async () => {
      const { createBetterSqliteAdapter } = await import('../src/index.js');
      const adapter = createBetterSqliteAdapter(':memory:');
      await adapter.open();
      await adapter.exec('CREATE TABLE events (id INTEGER PRIMARY KEY, label TEXT NOT NULL)');

      await expect(
        adapter.transaction(async (trx) => {
          await trx.run('INSERT INTO events (label) VALUES (?)', ['outer']);
          await trx.transaction(async (nestedTrx) => {
            await nestedTrx.run('INSERT INTO events (label) VALUES (?)', ['nested']);
            throw new Error('nested failure');
          });
        }),
      ).rejects.toThrow('nested failure');

      const rows = await adapter.all('SELECT * FROM events');
      expect(rows).toHaveLength(0);
      await adapter.close();
    });
  });

  // The adapter has one connection, so a statement another caller issues while
  // a transaction's callback awaits would run inside that transaction.
  describe('statements from outside an open transaction', () => {
    const openWithLedger = async (): Promise<StorageAdapter> => {
      const { createBetterSqliteAdapter } = await import('../src/index.js');
      const adapter = createBetterSqliteAdapter(':memory:');
      await adapter.open();
      await adapter.exec('CREATE TABLE ledger (id INTEGER PRIMARY KEY, label TEXT NOT NULL)');
      return adapter;
    };

    /** A promise and the function that settles it. */
    const deferred = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((settle) => {
        resolve = settle;
      });
      return { promise, resolve };
    };

    const labels = async (adapter: StorageAdapter): Promise<string[]> =>
      (await adapter.all<{ label: string }>('SELECT label FROM ledger ORDER BY id')).map((row) => row.label);

    it('waits for the transaction to end and survives its rollback', async () => {
      const adapter = await openWithLedger();
      const started = deferred();
      const outsideWork = deferred();
      const transaction = adapter
        .transaction(async (trx) => {
          await trx.run('INSERT INTO ledger (label) VALUES (?)', ['inside']);
          started.resolve();
          // The callback waits on work outside the database.
          await outsideWork.promise;
          throw new Error('roll back');
        })
        .catch((error: Error) => error.message);

      await started.promise;
      let written = false;
      const write = adapter.run('INSERT INTO ledger (label) VALUES (?)', ['outside']).then(() => {
        written = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(written).toBe(false);

      outsideWork.resolve();
      expect(await transaction).toBe('roll back');
      await write;
      expect(await labels(adapter)).toEqual(['outside']);
      await adapter.close();
    });

    it('does not read rows the transaction has not committed', async () => {
      const adapter = await openWithLedger();
      const started = deferred();
      const finish = deferred();
      const transaction = adapter
        .transaction(async (trx) => {
          await trx.run('INSERT INTO ledger (label) VALUES (?)', ['uncommitted']);
          started.resolve();
          await finish.promise;
          throw new Error('roll back');
        })
        .catch(() => undefined);

      await started.promise;
      const read = labels(adapter);
      finish.resolve();
      await transaction;
      expect(await read).toEqual([]);
      await adapter.close();
    });

    it('runs a statement the callback issues through the adapter inside the transaction', async () => {
      const adapter = await openWithLedger();
      await expect(
        adapter.transaction(async () => {
          await adapter.run('INSERT INTO ledger (label) VALUES (?)', ['through the adapter']);
          throw new Error('roll back');
        }),
      ).rejects.toThrow('roll back');
      expect(await labels(adapter)).toEqual([]);
      await adapter.close();
    });

    it("admits the handle's statements whatever async context runs them", async () => {
      const adapter = await openWithLedger();
      const { AsyncResource } = await import('async_hooks');
      // Made before the transaction, so code it runs carries no transaction context.
      const outsideResource = new AsyncResource('outside-work');
      await adapter.transaction(async (trx) => {
        await outsideResource.runInAsyncScope(() =>
          trx.run('INSERT INTO ledger (label) VALUES (?)', ['through the handle']),
        );
      });
      expect(await labels(adapter)).toEqual(['through the handle']);
      await adapter.close();
    });

    it("admits a nested handle's statements whatever async context runs them", async () => {
      const adapter = await openWithLedger();
      const { AsyncResource } = await import('async_hooks');
      const outsideResource = new AsyncResource('outside-work');
      await adapter.transaction(async () => {
        await adapter.transaction(async (inner) => {
          await outsideResource.runInAsyncScope(() =>
            inner.run('INSERT INTO ledger (label) VALUES (?)', ['nested, through the handle']),
          );
        });
      });
      expect(await labels(adapter)).toEqual(['nested, through the handle']);
      await adapter.close();
    });

    it('joins the open transaction when the callback calls transaction() on the adapter', async () => {
      const adapter = await openWithLedger();
      await adapter.transaction(async (trx) => {
        await trx.run('INSERT INTO ledger (label) VALUES (?)', ['outer']);
        await adapter.transaction(async (inner) => {
          await inner.run('INSERT INTO ledger (label) VALUES (?)', ['inner']);
        });
      });
      expect(await labels(adapter)).toEqual(['outer', 'inner']);
      await adapter.close();
    });
  });

  // better-sqlite3 13 is built for Node-API 10. On a runtime without it the binding
  // loads inside `new Database()` and the process crashes, which no catch can stop,
  // so the adapter refuses to open and the resolver goes on to the next adapter.
  describe('on a runtime without Node-API 10', () => {
    const installedMajor = (() => {
      try {
        const pkg = createRequire(import.meta.url)('better-sqlite3/package.json') as { version: string };
        return Number(pkg.version.split('.')[0]);
      } catch {
        return 0;
      }
    })();
    const runtimeWithNodeApi = (napi: string): NodeJS.Process =>
      Object.create(process, {
        versions: { value: { ...process.versions, napi }, enumerable: true },
      }) as NodeJS.Process;

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it.skipIf(installedMajor < 13)('refuses to open better-sqlite3 13, and the resolver falls back to sql.js', async () => {
      const { createBetterSqliteAdapter, resolveStorageAdapter } = await import('../src/index.js');
      const tempDir = path.join(os.tmpdir(), `sql-adapter-napi-${Date.now()}`);
      testDirs.push(tempDir);
      vi.stubGlobal('process', runtimeWithNodeApi('9'));

      await expect(createBetterSqliteAdapter(':memory:').open()).rejects.toThrow('needs Node-API 10');

      const adapter = await resolveStorageAdapter({
        priority: ['better-sqlite3', 'sqljs'],
        filePath: path.join(tempDir, 'app.sqlite3'),
        quiet: true,
      });
      expect(adapter.kind).toBe('sqljs');
      await adapter.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
      await adapter.close();
    });

    it.skipIf(!(Number(process.versions.napi) >= 10))('opens better-sqlite3 on a runtime with Node-API 10', async () => {
      const { createBetterSqliteAdapter } = await import('../src/index.js');
      vi.stubGlobal('process', runtimeWithNodeApi('10'));

      const adapter = createBetterSqliteAdapter(':memory:');
      await adapter.open();
      expect(await adapter.get<{ one: number }>('SELECT 1 AS one')).toEqual({ one: 1 });
      await adapter.close();
    });
  });
});
