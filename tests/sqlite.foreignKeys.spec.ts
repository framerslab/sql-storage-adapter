import { describe, expect, it, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IDBFactory } from 'fake-indexeddb';
import {
  IndexedDbAdapter,
  createDatabase,
  createSqlJsAdapter,
  resolveStorageAdapter,
  type StorageAdapter,
} from '../src/index.js';

// `foreignKeys: true` turns SQLite's foreign-key enforcement on when a SQLite
// adapter opens, and keeps it on across what reopens a sql.js connection: a
// save to a file or to IndexedDB, an export and an import. Without it SQLite
// leaves enforcement off, as before.

const SCHEMA = `
  CREATE TABLE parents (id INTEGER PRIMARY KEY);
  CREATE TABLE children (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parents (id));
`;

/** Whether the connection enforces foreign keys now. */
const enforced = async (db: StorageAdapter): Promise<boolean> =>
  (await db.get<{ foreign_keys: number }>('PRAGMA foreign_keys'))?.foreign_keys === 1;

/** Whether a child row whose parent does not exist is refused. */
const refusesOrphan = async (db: StorageAdapter, id: number): Promise<boolean> => {
  try {
    await db.run('INSERT INTO children (id, parent_id) VALUES (?, ?)', [id, 999]);
    return false;
  } catch (error) {
    if (/FOREIGN KEY constraint failed/.test(String(error))) return true;
    throw error;
  }
};

describe('foreignKeys on the SQLite adapters', () => {
  const opened: StorageAdapter[] = [];
  const dirs: string[] = [];

  const keep = (db: StorageAdapter): StorageAdapter => {
    opened.push(db);
    return db;
  };

  const tempFile = (name: string): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreign-keys-'));
    dirs.push(dir);
    return path.join(dir, name);
  };

  afterEach(async () => {
    for (const db of opened.splice(0)) await db.close().catch(() => undefined);
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('turns enforcement on for better-sqlite3 through createDatabase, and leaves it off without the option', async () => {
    const on = keep(await createDatabase({ type: 'memory', foreignKeys: true }));
    const off = keep(await createDatabase({ type: 'memory' }));
    await on.exec(SCHEMA);
    await off.exec(SCHEMA);

    expect(on.kind).toBe('better-sqlite3');
    expect(await enforced(on)).toBe(true);
    expect(await refusesOrphan(on, 1)).toBe(true);
    expect(await enforced(off)).toBe(false);
    expect(await refusesOrphan(off, 1)).toBe(false);
  });

  it('takes the option through resolveStorageAdapter openOptions', async () => {
    const db = keep(
      await resolveStorageAdapter({
        priority: ['better-sqlite3'],
        filePath: tempFile('app.sqlite3'),
        openOptions: { foreignKeys: true },
        quiet: true,
      }),
    );
    await db.exec(SCHEMA);

    expect(await refusesOrphan(db, 1)).toBe(true);
  });

  it('keeps enforcement on for sql.js across the saves that reopen its connection', async () => {
    const db = keep(createSqlJsAdapter());
    await db.open({ filePath: tempFile('app.sqlite3'), foreignKeys: true });
    await db.exec(SCHEMA);
    await db.run('INSERT INTO parents (id) VALUES (?)', [1]);
    await db.run('INSERT INTO children (id, parent_id) VALUES (?, ?)', [1, 1]);

    expect(await enforced(db)).toBe(true);
    expect(await refusesOrphan(db, 2)).toBe(true);
  });

  it('takes the option through createDatabase for sql.js', async () => {
    const db = keep(await createDatabase({ priority: ['sqljs'], file: tempFile('app.sqlite3'), foreignKeys: true }));
    await db.exec(SCHEMA);

    expect(db.kind).toBe('sqljs');
    expect(await refusesOrphan(db, 1)).toBe(true);
  });

  it('keeps enforcement on for IndexedDB across an export and an import', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    const db = new IndexedDbAdapter({ dbName: `foreign_keys_${Math.random().toString(36).slice(2)}`, autoSave: false });
    keep(db);
    await db.open({ foreignKeys: true });
    await db.exec(SCHEMA);

    const image = db.exportDatabase();
    expect(await enforced(db)).toBe(true);
    expect(await refusesOrphan(db, 1)).toBe(true);

    await db.importDatabase(image);
    expect(await enforced(db)).toBe(true);
    expect(await refusesOrphan(db, 2)).toBe(true);
  });
});
