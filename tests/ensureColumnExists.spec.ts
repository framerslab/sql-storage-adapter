import { describe, expect, it, afterAll, beforeAll } from 'vitest';
import {
  createDatabase,
  createPostgresAdapter,
  createSqlJsAdapter,
  ensureColumnExists,
  type StorageAdapter,
} from '../src/index.js';

// ensureColumnExists adds a column when a table lacks it and does nothing when
// it has it, on PostgreSQL (CI's service, when POSTGRES_TEST_URL names it),
// better-sqlite3 and sql.js, and refuses names that are not identifiers.

const POSTGRES_TEST_URL = process.env.POSTGRES_TEST_URL;

const engines: Array<[string, () => Promise<StorageAdapter>]> = [
  ['better-sqlite3', () => createDatabase({ type: 'memory' })],
  [
    'sql.js',
    async () => {
      const adapter = createSqlJsAdapter();
      await adapter.open();
      return adapter;
    },
  ],
];
if (POSTGRES_TEST_URL) {
  engines.push([
    'PostgreSQL',
    async () => {
      const adapter = createPostgresAdapter(POSTGRES_TEST_URL);
      await adapter.open();
      return adapter;
    },
  ]);
}

describe.each(engines)('ensureColumnExists on %s', (_engine, openAdapter) => {
  let db: StorageAdapter;
  const table = `columns_${Math.random().toString(36).slice(2, 8)}`;

  beforeAll(async () => {
    db = await openAdapter();
    await db.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY)`);
  });

  afterAll(async () => {
    await db.exec(`DROP TABLE IF EXISTS ${table}`).catch(() => undefined);
    await db.close();
  });

  it('adds a missing column once, and the column takes values', async () => {
    expect(await ensureColumnExists(db, table, 'label', "TEXT NOT NULL DEFAULT 'none'")).toBe(true);
    expect(await ensureColumnExists(db, table, 'label', "TEXT NOT NULL DEFAULT 'none'")).toBe(false);

    await db.run(`INSERT INTO ${table} (id) VALUES (?)`, [1]);
    expect(await db.get(`SELECT label FROM ${table} WHERE id = ?`, [1])).toEqual({ label: 'none' });
  });

  it('refuses a table or column name that is not an identifier', async () => {
    await expect(ensureColumnExists(db, `${table}; DROP TABLE x`, 'c', 'TEXT')).rejects.toThrow(/identifier/);
    await expect(ensureColumnExists(db, table, 'c) ; --', 'TEXT')).rejects.toThrow(/identifier/);
  });
});
