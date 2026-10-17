import { describe, expect, it, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IDBFactory } from 'fake-indexeddb';
import { IndexedDbAdapter, createDatabase, createSqlJsAdapter, type StorageAdapter } from '../src/index.js';

// User-defined SQL functions on the SQLite adapters: registerFunction() makes a
// JavaScript function callable from SQL on better-sqlite3, sql.js and
// IndexedDB, and keeps it when sql.js reopens its connection (a save to a
// file, an export, an import).

type WithFunctions = StorageAdapter & {
  registerFunction(name: string, fn: (...args: unknown[]) => unknown, options?: { deterministic?: boolean }): void;
};

describe('registerFunction on the SQLite adapters', () => {
  const opened: StorageAdapter[] = [];
  const dirs: string[] = [];

  afterEach(async () => {
    for (const db of opened.splice(0)) await db.close().catch(() => undefined);
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('calls a JavaScript function from SQL on better-sqlite3', async () => {
    const db = (await createDatabase({ type: 'memory' })) as WithFunctions;
    opened.push(db);
    db.registerFunction('double_it', (value) => Number(value) * 2, { deterministic: true });

    expect(await db.get('SELECT double_it(21) AS v')).toEqual({ v: 42 });
  });

  it('keeps the function across the saves that reopen a sql.js connection', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'functions-'));
    dirs.push(dir);
    const db = createSqlJsAdapter() as WithFunctions;
    opened.push(db);
    await db.open({ filePath: path.join(dir, 'app.sqlite3') });
    db.registerFunction('shout', (value) => `${String(value).toUpperCase()}!`);

    await db.exec('CREATE TABLE notes (body TEXT)');
    await db.run('INSERT INTO notes (body) VALUES (?)', ['hi']);

    expect(await db.get('SELECT shout(body) AS loud FROM notes')).toEqual({ loud: 'HI!' });
  });

  it('keeps the function across an IndexedDB export and import', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    const db = new IndexedDbAdapter({ dbName: `functions_${Math.random().toString(36).slice(2)}`, autoSave: false }) as unknown as WithFunctions;
    opened.push(db);
    await db.open();
    db.registerFunction('plus_one', (value) => Number(value) + 1);

    const image = (db as unknown as IndexedDbAdapter).exportDatabase();
    expect(await db.get('SELECT plus_one(1) AS v')).toEqual({ v: 2 });
    await (db as unknown as IndexedDbAdapter).importDatabase(image);
    expect(await db.get('SELECT plus_one(2) AS v')).toEqual({ v: 3 });
  });

  it('refuses a function name that is not an identifier', async () => {
    const db = (await createDatabase({ type: 'memory' })) as WithFunctions;
    opened.push(db);

    expect(() => db.registerFunction('bad name;', () => 1)).toThrow(/identifier/);
  });
});
