import { describe, expect, it, afterAll, afterEach, beforeAll, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import {
  IndexedDbAdapter,
  createDatabase,
  createPostgresAdapter,
  createSqlJsAdapter,
  type StorageAdapter,
} from '../src/index.js';

// Placeholders are read the way the database reads SQL: a `?`, `@name` or `$1`
// inside a string literal, a quoted identifier, a dollar-quoted string or a
// comment is text. On PostgreSQL, `??` is the jsonb `?` operator, `?|` and `?&`
// are operators, a statement that already uses `$n` is sent as written, and a
// statement run without parameters keeps its `?`. On SQLite, `$1`, `$2`, ...
// bind from a positional array as they do on PostgreSQL. The Postgres specs run
// when POSTGRES_TEST_URL names a server (CI starts a Postgres service for them).

const POSTGRES_TEST_URL = process.env.POSTGRES_TEST_URL;

/** A name no other run of this suite uses. */
const unique = (prefix: string): string => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;

describe.skipIf(!POSTGRES_TEST_URL)('placeholders on PostgreSQL', () => {
  let db: StorageAdapter;
  const table = unique('placeholders');

  beforeAll(async () => {
    db = createPostgresAdapter(POSTGRES_TEST_URL as string);
    await db.open();
    await db.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, label TEXT NOT NULL)`);
  });

  afterAll(async () => {
    await db.exec(`DROP TABLE IF EXISTS ${table}`).catch(() => undefined);
    await db.close();
  });

  it('stores a ? inside a string literal as text', async () => {
    await db.run(`INSERT INTO ${table} (id, label) VALUES (?, 'What should this week hold?')`, [1]);

    expect(await db.get(`SELECT label FROM ${table} WHERE id = ?`, [1])).toEqual({
      label: 'What should this week hold?',
    });
  });

  it("keeps a backslash-escaped quote in an E'' string from ending it early", async () => {
    expect(await db.get(`SELECT E'it\\'s ?' AS t, ?::int AS v`, [3])).toEqual({ t: "it's ?", v: 3 });
  });

  it('leaves a ? in a quoted identifier and a dollar-quoted string alone', async () => {
    expect(await db.get(`SELECT ?::int AS "what?", $q$Why? $1 @name$q$ AS t`, [1])).toEqual({
      'what?': 1,
      t: 'Why? $1 @name',
    });
  });

  it('leaves placeholders in comments alone, positional and named', async () => {
    expect(await db.get(`SELECT ?::int AS v -- why? @who\n`, [5])).toEqual({ v: 5 });
    expect(await db.get('SELECT @a::int AS v /* @b ? */', { a: 7, b: 8 })).toEqual({ v: 7 });
  });

  it("does not rewrite an email address in a literal when named parameters are passed", async () => {
    expect(await db.get(`SELECT 'team@example.com' AS email, @example::int AS v`, { example: 9 })).toEqual({
      email: 'team@example.com',
      v: 9,
    });
  });

  it('sends a statement without parameters as written, so the jsonb ? operator works', async () => {
    expect(await db.get(`SELECT '{"a":1}'::jsonb ? 'a' AS has`)).toEqual({ has: true });
  });

  it('reads ?? as the jsonb ? operator when the statement has ? placeholders', async () => {
    expect(await db.get(`SELECT ?::jsonb ?? 'a' AS has, ?::int AS v`, ['{"a":1}', 4])).toEqual({ has: true, v: 4 });
  });

  it('leaves the jsonb ?| and ?& operators alone, and binds a ? followed by ||', async () => {
    expect(
      await db.get(`SELECT ?::jsonb ?| array['a','z'] AS any_key, ?::jsonb ?& array['a','b'] AS all_keys, ?||'x'::text AS t`, [
        '{"a":1}',
        '{"a":1,"b":2}',
        'a',
      ]),
    ).toEqual({ any_key: true, all_keys: true, t: 'ax' });
  });

  it('sends a statement that already uses $n placeholders as written, its ? operator included', async () => {
    expect(await db.get(`SELECT $1::jsonb ? 'a' AS has, $2::int AS v`, ['{"a":1}', 6])).toEqual({ has: true, v: 6 });
  });
});

/** The SQLite-family adapters these specs run on: better-sqlite3, sql.js and IndexedDB (fake-indexeddb). */
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
      const adapter = new IndexedDbAdapter({ dbName: unique('placeholders'), autoSave: false });
      await adapter.open();
      return adapter;
    },
  ],
];

describe.each(sqliteAdapters)('placeholders on SQLite (%s)', (name, openAdapter) => {
  let db: StorageAdapter;

  afterEach(async () => {
    await db?.close().catch(() => undefined);
    vi.unstubAllGlobals();
  });

  it('binds $1, $2 from a positional array, out of order and repeated', async () => {
    db = await openAdapter();
    if (name === 'better-sqlite3') expect(db.kind).toBe('better-sqlite3');

    expect(await db.get('SELECT $2 AS b, $1 AS a, $2 AS b2', ['A', 'B'])).toEqual({ b: 'B', a: 'A', b2: 'B' });
  });

  it('writes and reads rows with $n placeholders', async () => {
    db = await openAdapter();
    await db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL)');

    await db.run('INSERT INTO items (id, label) VALUES ($1, $2)', [1, 'one']);
    await db.run('UPDATE items SET label = $2 WHERE id = $1', [1, 'uno']);

    expect(await db.all('SELECT id, label FROM items WHERE id = $1', [1])).toEqual([{ id: 1, label: 'uno' }]);
  });

  it('leaves $1 in a string literal and a JSON path alone', async () => {
    db = await openAdapter();

    expect(await db.get(`SELECT '$1' AS t, $1 AS v, json_extract('{"a":{"b":2}}', '$.a.b') AS j`, [5])).toEqual({
      t: '$1',
      v: 5,
      j: 2,
    });
  });

  it('refuses a statement that mixes ? and $n placeholders', async () => {
    db = await openAdapter();

    await expect(db.get('SELECT ? AS a, $1 AS b', [1])).rejects.toThrow(/\?.*\$n|\$n.*\?/);
  });
});
