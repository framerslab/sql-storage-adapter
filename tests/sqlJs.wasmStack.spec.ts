import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import initSqlJs from 'sql.js';
import { IDBFactory } from 'fake-indexeddb';
import { SqlJsAdapter } from '../src/adapters/sqlJsAdapter';
import { IndexedDbAdapter } from '../src/adapters/indexedDbAdapter';

// sql.js up to 1.14.1 takes 16 bytes of its fixed 5 MB WebAssembly stack on
// every Database.exec() call and never gives them back (fixed in sql.js 1.14.2,
// sql-js/sql.js 548980814). Once the stack runs out, SQLite writes over the
// heap: "memory access out of bounds", errors such as "ou" where "out of
// memory" was meant, and a resolver that finds sql.js "not available". A
// consumer whose lockfile holds 1.14.1 (wilds-ai, 1 November 2026) hit that in
// one test file after the save path began reading the connection's settings
// before and after each export, some 35 exec() calls a save. These specs run
// the adapters on sql.js 1.14.1 and read the stack pointer the module exports
// (stackSave) before and after the writes and saves: the adapters' own work
// must leave it where it was.
vi.mock('sql.js', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  return { default: require('sql.js-1.14.1') };
});

const WRITES = 40;

describe('the sql.js adapters leave the WebAssembly stack where it was (sql.js 1.14.1)', () => {
  it('runs on sql.js 1.14.1', async () => {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const { version } = require('sql.js-1.14.1/package.json') as { version: string };
    expect(version).toBe('1.14.1');
  });

  describe('SqlJsAdapter with a file', () => {
    const opened: SqlJsAdapter[] = [];
    const dirs: string[] = [];

    afterEach(async () => {
      for (const adapter of opened.splice(0)) await adapter.close();
      for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
    });

    const openWithItems = async (): Promise<SqlJsAdapter> => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqljs-wasm-stack-'));
      dirs.push(dir);
      const adapter = new SqlJsAdapter();
      opened.push(adapter);
      await adapter.open({ filePath: path.join(dir, 'app.sqlite3') });
      await adapter.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL)');
      await adapter.run('PRAGMA cache_size = -4000');
      return adapter;
    };

    it('saves after run() without taking stack', async () => {
      const SQL = await initSqlJs();
      const adapter = await openWithItems();
      const before = SQL.stackSave();
      for (let i = 0; i < WRITES; i += 1) {
        await adapter.run('INSERT INTO items (label) VALUES (?)', [`run-${i}`]);
      }
      expect(SQL.stackSave()).toBe(before);
      expect((await adapter.get<{ n: number }>('SELECT count(*) AS n FROM items'))?.n).toBe(WRITES);
    });

    it('saves after a writing all() and after a transaction() without taking stack', async () => {
      const SQL = await initSqlJs();
      const adapter = await openWithItems();
      const before = SQL.stackSave();
      for (let i = 0; i < WRITES; i += 1) {
        await adapter.all('INSERT INTO items (label) VALUES (?) RETURNING id', [`all-${i}`]);
        await adapter.all("UPDATE items SET label = label || '!' WHERE id = ?", [i + 1]);
        await adapter.transaction(async (trx) => {
          await trx.run('INSERT INTO items (label) VALUES (?)', [`trx-${i}`]);
        });
      }
      expect(SQL.stackSave()).toBe(before);
      expect((await adapter.get<{ n: number }>('SELECT count(*) AS n FROM items'))?.n).toBe(WRITES * 2);
    });

    it('keeps the connection settings across the saves it makes', async () => {
      const adapter = await openWithItems();
      for (let i = 0; i < WRITES; i += 1) {
        await adapter.run('INSERT INTO items (label) VALUES (?)', [`setting-${i}`]);
      }
      expect((await adapter.get<{ cache_size: number }>('PRAGMA cache_size'))?.cache_size).toBe(-4000);
    });
  });

  describe("IndexedDbAdapter with durability: 'commit'", () => {
    const opened: IndexedDbAdapter[] = [];

    beforeEach(() => {
      vi.stubGlobal('indexedDB', new IDBFactory());
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    });

    afterEach(async () => {
      for (const adapter of opened.splice(0)) await adapter.close();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    it('stores after run() and a writing all() without taking stack', async () => {
      const SQL = await initSqlJs();
      const adapter = new IndexedDbAdapter({ dbName: 'wasm-stack', durability: 'commit', saveIntervalMs: 1_000 });
      opened.push(adapter);
      await adapter.open();
      await adapter.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL)');
      const before = SQL.stackSave();
      for (let i = 0; i < WRITES; i += 1) {
        await adapter.run('INSERT INTO items (label) VALUES (?)', [`idb-${i}`]);
        await adapter.all('INSERT INTO items (label) VALUES (?) RETURNING id', [`idb-all-${i}`]);
      }
      expect(SQL.stackSave()).toBe(before);
      expect((await adapter.get<{ n: number }>('SELECT count(*) AS n FROM items'))?.n).toBe(WRITES * 2);
    });
  });
});
