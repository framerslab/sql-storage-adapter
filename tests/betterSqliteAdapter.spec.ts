import { describe, expect, it, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

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
});
