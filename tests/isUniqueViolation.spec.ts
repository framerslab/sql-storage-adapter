import { describe, expect, it, afterAll, afterEach, beforeAll, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import {
  IndexedDbAdapter,
  createDatabase,
  createPostgresAdapter,
  createSqlJsAdapter,
  isUniqueViolation,
  type StorageAdapter,
} from '../src/index.js';

// isUniqueViolation() reads a unique or primary-key violation from any
// adapter: PostgreSQL's SQLSTATE 23505, better-sqlite3's extended codes, and
// the "UNIQUE constraint failed" message sql.js and the Capacitor plugin give.
// The Postgres specs run when POSTGRES_TEST_URL names a server (CI starts a
// Postgres service for them).

const POSTGRES_TEST_URL = process.env.POSTGRES_TEST_URL;

/** A name no other run of this suite uses. */
const unique = (prefix: string): string => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;

/** The error a call rejects with. */
const failure = async (call: Promise<unknown>): Promise<unknown> => {
  try {
    await call;
  } catch (error) {
    return error;
  }
  throw new Error('the call did not fail');
};

describe('isUniqueViolation on values that are not database errors', () => {
  it('is false for null, a string, a plain object and an unrelated error', () => {
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation('UNIQUE constraint failed: t.id')).toBe(false);
    expect(isUniqueViolation({})).toBe(false);
    expect(isUniqueViolation(new Error('connection refused'))).toBe(false);
  });

  it('does not loop on an error whose cause is itself', () => {
    const error = new Error('outer') as Error & { cause?: unknown };
    error.cause = error;
    expect(isUniqueViolation(error)).toBe(false);
  });
});

describe.skipIf(!POSTGRES_TEST_URL)('isUniqueViolation on PostgreSQL', () => {
  let db: StorageAdapter;
  const table = unique('unique_violation');

  beforeAll(async () => {
    db = createPostgresAdapter(POSTGRES_TEST_URL as string);
    await db.open();
    await db.exec(
      `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, email TEXT UNIQUE, label TEXT NOT NULL, parent INTEGER REFERENCES ${table} (id))`,
    );
    await db.run(`INSERT INTO ${table} (id, email, label) VALUES (1, 'a@example.com', 'one')`);
  });

  afterAll(async () => {
    await db.exec(`DROP TABLE IF EXISTS ${table}`).catch(() => undefined);
    await db.close();
  });

  it('is true for a duplicate in a unique column and a duplicate primary key', async () => {
    expect(isUniqueViolation(await failure(db.run(`INSERT INTO ${table} (id, email, label) VALUES (2, 'a@example.com', 'two')`)))).toBe(true);
    expect(isUniqueViolation(await failure(db.run(`INSERT INTO ${table} (id, email, label) VALUES (1, 'b@example.com', 'dup')`)))).toBe(true);
  });

  it('is true inside a transaction and through an error that wraps it as its cause', async () => {
    const error = await failure(
      db.transaction((trx) => trx.run(`INSERT INTO ${table} (id, email, label) VALUES (3, 'a@example.com', 'three')`)),
    );
    expect(isUniqueViolation(error)).toBe(true);
    expect(isUniqueViolation(new Error('saving the user failed', { cause: error }))).toBe(true);
  });

  it('is false for a NOT NULL, a foreign key and a syntax error', async () => {
    expect(isUniqueViolation(await failure(db.run(`INSERT INTO ${table} (id, email) VALUES (4, 'c@example.com')`)))).toBe(false);
    expect(isUniqueViolation(await failure(db.run(`INSERT INTO ${table} (id, label, parent) VALUES (5, 'five', 99)`)))).toBe(false);
    expect(isUniqueViolation(await failure(db.run('INSERT INTO nowhere VALUES (1'))) ).toBe(false);
  });
});

/** The SQLite-family adapters these specs run on. */
const sqliteAdapters: Array<[string, () => Promise<StorageAdapter>]> = [
  ['better-sqlite3', () => createDatabase({ type: 'memory' })],
  [
    'sql.js',
    async () => {
      const adapter = createSqlJsAdapter();
      await adapter.open();
      return adapter;
    },
  ],
  [
    'IndexedDB',
    async () => {
      vi.stubGlobal('indexedDB', new IDBFactory());
      const adapter = new IndexedDbAdapter({ dbName: unique('unique_violation'), autoSave: false });
      await adapter.open();
      return adapter;
    },
  ],
];

describe.each(sqliteAdapters)('isUniqueViolation on SQLite (%s)', (_name, openAdapter) => {
  let db: StorageAdapter;

  afterEach(async () => {
    await db?.close().catch(() => undefined);
    vi.unstubAllGlobals();
  });

  it('is true for a duplicate in a unique column and a duplicate primary key, and false for NOT NULL', async () => {
    db = await openAdapter();
    await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT UNIQUE, label TEXT NOT NULL)');
    await db.exec('CREATE TABLE tags (name TEXT PRIMARY KEY, label TEXT)');
    await db.run("INSERT INTO users (id, email, label) VALUES (1, 'a@example.com', 'one')");
    await db.run("INSERT INTO tags (name, label) VALUES ('red', 'one')");

    expect(isUniqueViolation(await failure(db.run("INSERT INTO users (id, email, label) VALUES (2, 'a@example.com', 'two')")))).toBe(true);
    expect(isUniqueViolation(await failure(db.run("INSERT INTO users (id, email, label) VALUES (1, 'b@example.com', 'dup')")))).toBe(true);
    expect(isUniqueViolation(await failure(db.run("INSERT INTO tags (name, label) VALUES ('red', 'two')")))).toBe(true);
    expect(isUniqueViolation(await failure(db.run("INSERT INTO users (id, email) VALUES (3, 'c@example.com')")))).toBe(false);
  });
});
