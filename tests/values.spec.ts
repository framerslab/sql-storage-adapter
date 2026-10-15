import { describe, expect, it, afterAll, afterEach, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import {
  IndexedDbAdapter,
  createDatabase,
  createPostgresAdapter,
  createSqlJsAdapter,
  type StorageAdapter,
} from '../src/index.js';

// Values in and out. The SQLite adapters bind a boolean as 1 or 0, a Date as
// its ISO 8601 text, an array or a plain object as JSON text, and undefined as
// NULL, as positional and as named values. On PostgreSQL, `typeParsers` sets,
// per pool, how int8, numeric, DATE and json/jsonb come back; without it pg's
// defaults hold. The Postgres specs run when POSTGRES_TEST_URL names a server
// (CI starts a Postgres service for them).

const POSTGRES_TEST_URL = process.env.POSTGRES_TEST_URL;

const AT = new Date('2026-10-15T12:34:56.789Z');

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
      const adapter = new IndexedDbAdapter({ dbName: `values_${Math.random().toString(36).slice(2)}`, autoSave: false });
      await adapter.open();
      return adapter;
    },
  ],
];

describe.each(sqliteAdapters)('values bound on SQLite (%s)', (_name, openAdapter) => {
  let db: StorageAdapter;

  afterEach(async () => {
    await db?.close().catch(() => undefined);
    vi.unstubAllGlobals();
  });

  it('binds booleans, Dates, arrays, objects and undefined from a positional array', async () => {
    db = await openAdapter();
    await db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, flag INTEGER, off INTEGER, at TEXT, list TEXT, meta TEXT, missing TEXT)');

    await db.run('INSERT INTO items (id, flag, off, at, list, meta, missing) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      1,
      true,
      false,
      AT,
      [1, 'two'],
      { a: 1, b: [true] },
      undefined,
    ]);

    expect(await db.get('SELECT flag, off, at, list, meta, missing FROM items WHERE id = 1')).toEqual({
      flag: 1,
      off: 0,
      at: '2026-10-15T12:34:56.789Z',
      list: '[1,"two"]',
      meta: '{"a":1,"b":[true]}',
      missing: null,
    });
    expect(await db.get("SELECT json_extract(meta, '$.a') AS a FROM items WHERE id = 1")).toEqual({ a: 1 });
  });

  it('binds them from named parameters and keeps blobs as bytes', async () => {
    db = await openAdapter();
    await db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, flag INTEGER, at TEXT, bytes BLOB)');

    await db.run('INSERT INTO items (id, flag, at, bytes) VALUES (@id, @flag, @at, @bytes)', {
      id: 2,
      flag: true,
      at: AT,
      bytes: new Uint8Array([1, 2, 3]),
    });

    const row = await db.get<{ flag: number; at: string; bytes: Uint8Array }>('SELECT flag, at, bytes FROM items WHERE id = 2');
    expect(row?.flag).toBe(1);
    expect(row?.at).toBe('2026-10-15T12:34:56.789Z');
    expect(Array.from(row!.bytes)).toEqual([1, 2, 3]);
  });

  it('refuses an Invalid Date instead of storing NULL or the text "Invalid Date"', async () => {
    db = await openAdapter();
    await db.exec('CREATE TABLE items (at TEXT)');

    await expect(db.run('INSERT INTO items (at) VALUES (?)', [new Date('not a date')])).rejects.toThrow(/Invalid Date/);
  });
});

describe.skipIf(!POSTGRES_TEST_URL)('values read on PostgreSQL', () => {
  const url = POSTGRES_TEST_URL as string;
  const SELECT =
    "SELECT 9007199254740993::int8 AS big, 42::int8 AS small, 1.5::numeric AS n, DATE '2026-10-15' AS d, '{\"a\":1}'::jsonb AS j";
  const opened: StorageAdapter[] = [];

  const open = async (typeParsers?: Record<string, string>): Promise<StorageAdapter> => {
    const db = createPostgresAdapter({ connectionString: url, max: 1, ...(typeParsers ? { typeParsers } : {}) } as never);
    await db.open();
    opened.push(db);
    return db;
  };

  afterAll(async () => {
    for (const db of opened.splice(0)) await db.close().catch(() => undefined);
  });

  it("keeps pg's defaults without typeParsers", async () => {
    const row = await (await open()).get<Record<string, unknown>>(SELECT);

    expect(row?.big).toBe('9007199254740993');
    expect(row?.n).toBe('1.5');
    expect(row?.d).toBeInstanceOf(Date);
    expect(row?.j).toEqual({ a: 1 });
  });

  it('reads int8 as bigint, numeric as a number, DATE as its text and json as text when asked', async () => {
    const db = await open({ int8: 'bigint', numeric: 'number', date: 'string', json: 'string' });
    const row = await db.get<Record<string, unknown>>(SELECT);

    expect(row?.big).toBe(9007199254740993n);
    expect(row?.small).toBe(42n);
    expect(row?.n).toBe(1.5);
    expect(row?.d).toBe('2026-10-15');
    expect(row?.j).toBe('{"a": 1}');
  });

  it("reads int8 as a number when asked, and refuses one past Number's safe range", async () => {
    const db = await open({ int8: 'number' });

    expect(await db.get('SELECT 42::int8 AS small')).toEqual({ small: 42 });
    await expect(db.get('SELECT 9007199254740993::int8 AS big')).rejects.toThrow(/safe/);
  });

  it('takes typeParsers through createDatabase', async () => {
    const db = await createDatabase({ url, postgres: { typeParsers: { int8: 'bigint' } } as never });
    opened.push(db);

    expect(await db.get('SELECT 7::int8 AS v')).toEqual({ v: 7n });
  });

  it('refuses a typeParsers value it does not know when it opens', async () => {
    await expect(open({ int8: 'float' })).rejects.toThrow(/typeParsers\.int8/);
  });
});
