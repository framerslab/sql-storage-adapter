import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDatabase,
  createPostgresAdapter,
  createSqlJsAdapter,
  createStorageFeatures,
  exportAsSQL,
  importFromSQL,
  migrateAdapter,
  type StorageAdapter,
} from '../src/index.js';

// migrateAdapter between engines: the target table gets the target engine's
// types, defaults it can run, the source's primary key, and an identity column
// that takes the source's ids, with its sequence moved past them. Runs against
// better-sqlite3, sql.js and PostgreSQL (CI's service, when POSTGRES_TEST_URL
// names it).

const POSTGRES_TEST_URL = process.env.POSTGRES_TEST_URL;

const unique = (prefix: string): string => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;

describe('migrateAdapter from SQLite to SQLite', () => {
  it('keeps the table as SQLite created it: its primary key, AUTOINCREMENT, UNIQUE and CHECK', async () => {
    const source = await createDatabase({ type: 'memory' });
    const target = createSqlJsAdapter();
    await target.open();
    try {
      await source.exec(
        'CREATE TABLE accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, credits INTEGER NOT NULL DEFAULT 0 CHECK (credits >= 0))',
      );
      await source.run('INSERT INTO accounts (id, email, credits) VALUES (?, ?, ?)', [2, 'a@example.test', 5]);
      await source.run('INSERT INTO accounts (id, email, credits) VALUES (?, ?, ?)', [7, 'b@example.test', 0]);

      const result = await migrateAdapter(source, target);
      expect(result.errors).toBeUndefined();
      expect(result.rowsImported).toBe(2);

      await target.run('INSERT INTO accounts (email) VALUES (?)', ['c@example.test']);
      expect(await target.get('SELECT id, credits FROM accounts WHERE email = ?', ['c@example.test'])).toEqual({ id: 8, credits: 0 });
      await expect(target.run('INSERT INTO accounts (email) VALUES (?)', ['a@example.test'])).rejects.toThrow(/UNIQUE constraint failed/);
      await expect(target.run('INSERT INTO accounts (email, credits) VALUES (?, ?)', ['d@example.test', -1])).rejects.toThrow(
        /CHECK constraint failed/,
      );
    } finally {
      await source.close();
      await target.close();
    }
  });
});

describe('the SQL export on SQLite', () => {
  it('loads into another database with its blobs, leaving the generated column to SQLite', async () => {
    const source = await createDatabase({ type: 'memory' });
    const target = createSqlJsAdapter();
    await target.open();
    try {
      await source.exec(
        'CREATE TABLE files (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, data BLOB, size INTEGER GENERATED ALWAYS AS (length(data)) STORED)',
      );
      await source.run('INSERT INTO files (name, data) VALUES (?, ?)', ['a.bin', Buffer.from([0, 1, 254])]);

      const loaded = await importFromSQL(target, await exportAsSQL(source));
      expect(loaded.errors).toBeUndefined();

      const row = await target.get<{ id: number; name: string; data: Uint8Array; size: number }>('SELECT id, name, data, size FROM files');
      expect(row).toMatchObject({ id: 1, name: 'a.bin', size: 3 });
      expect(Array.from(row?.data ?? [])).toEqual([0, 1, 254]);
    } finally {
      await source.close();
      await target.close();
    }
  });
});

describe('an identity column that takes explicit ids', () => {
  const engines: Array<[string, () => Promise<StorageAdapter>]> = [['better-sqlite3', () => createDatabase({ type: 'memory' })]];
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

  it.each(engines)('on %s, autoIncrementPrimaryKey({ acceptExplicitIds }) and syncIdentitySequence', async (_engine, open) => {
    const db = await open();
    const table = unique('explicit_ids');
    try {
      const dialect = createStorageFeatures(db).dialect;
      await db.exec(`CREATE TABLE ${table} (id ${dialect.autoIncrementPrimaryKey({ acceptExplicitIds: true })}, label TEXT)`);
      await db.run(`INSERT INTO ${table} (id, label) VALUES (?, ?)`, [41, 'explicit']);

      const sync = dialect.syncIdentitySequence(table, 'id');
      if (sync) await db.get(sync);
      await db.run(`INSERT INTO ${table} (label) VALUES (?)`, ['generated']);

      expect(await db.all(`SELECT id, label FROM ${table} ORDER BY id`)).toEqual([
        { id: 41, label: 'explicit' },
        { id: 42, label: 'generated' },
      ]);
    } finally {
      await db.exec(`DROP TABLE IF EXISTS ${table}`).catch(() => undefined);
      await db.close();
    }
  });
});

describe.skipIf(!POSTGRES_TEST_URL)('migrateAdapter to and from PostgreSQL', () => {
  const url = POSTGRES_TEST_URL as string;
  let pg: StorageAdapter;
  const tables: string[] = [];
  const schemas: string[] = [];

  beforeAll(async () => {
    pg = createPostgresAdapter(url);
    await pg.open();
  });

  afterAll(async () => {
    for (const table of tables) await pg.exec(`DROP TABLE IF EXISTS ${table}`).catch(() => undefined);
    for (const schema of schemas) await pg.exec(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
    await pg.close();
  });

  const columnTypes = async (db: StorageAdapter, table: string) =>
    db.all<{ name: string; type: string; identity: string }>(
      `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attidentity AS identity
       FROM pg_attribute a
       WHERE a.attrelid = to_regclass(quote_ident(current_schema()) || '.' || quote_ident(?)) AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY a.attnum`,
      [table],
    );

  const primaryKey = async (db: StorageAdapter, table: string) =>
    (
      await db.all<{ name: string }>(
        `SELECT kcu.column_name AS name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON kcu.constraint_schema = tc.constraint_schema AND kcu.constraint_name = tc.constraint_name
         WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = current_schema() AND tc.table_name = ?
         ORDER BY kcu.ordinal_position`,
        [table],
      )
    ).map((row) => row.name);

  it('creates PostgreSQL types, defaults, the primary key and an identity that took the SQLite ids', async () => {
    const sqlite = await createDatabase({ type: 'memory' });
    const table = unique('notes');
    tables.push(table);
    try {
      await sqlite.exec(`CREATE TABLE ${table} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        body BLOB,
        score REAL,
        pinned BOOLEAN NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_ms INTEGER,
        meta JSON
      )`);
      await sqlite.run(
        `INSERT INTO ${table} (id, title, body, score, pinned, created_at, updated_ms, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [5, 'first', Buffer.from([1, 2, 3]), 1.5, 1, '2026-10-16 12:00:00', 1760000000000, '{"a":1}'],
      );
      await sqlite.run(`INSERT INTO ${table} (id, title, pinned) VALUES (?, ?, ?)`, [9, 'second', 0]);

      const result = await migrateAdapter(sqlite, pg);
      expect(result.errors).toBeUndefined();
      expect(result.rowsImported).toBe(2);

      expect((await columnTypes(pg, table)).map(({ name, type }) => [name, type])).toEqual([
        ['id', 'integer'],
        ['title', 'text'],
        ['body', 'bytea'],
        ['score', 'double precision'],
        ['pinned', 'boolean'],
        ['created_at', 'timestamp with time zone'],
        ['updated_ms', 'bigint'],
        ['meta', 'jsonb'],
      ]);
      expect((await columnTypes(pg, table))[0].identity).toBe('d');
      expect(await primaryKey(pg, table)).toEqual(['id']);

      const rows = await pg.all<Record<string, unknown>>(
        `SELECT id, title, body, score, pinned, created_at, updated_ms, meta FROM ${table} ORDER BY id`,
      );
      expect(rows[0]).toMatchObject({ id: 5, title: 'first', score: 1.5, pinned: true, meta: { a: 1 } });
      expect(Buffer.from(rows[0].body as Uint8Array)).toEqual(Buffer.from([1, 2, 3]));
      // SQLite keeps CURRENT_TIMESTAMP's text in UTC; it arrives as that instant.
      expect((rows[0].created_at as Date).toISOString()).toBe('2026-10-16T12:00:00.000Z');
      expect(String(rows[0].updated_ms)).toBe('1760000000000');
      expect(rows[1]).toMatchObject({ id: 9, title: 'second', pinned: false });

      const added = await pg.get<{ id: number; pinned: boolean; created_at: Date | null }>(
        `INSERT INTO ${table} (title) VALUES (?) RETURNING id, pinned, created_at`,
        ['third'],
      );
      expect(added?.id).toBe(10);
      expect(added?.pinned).toBe(false);
      expect(added?.created_at).toBeInstanceOf(Date);

      // A second run onto the same rows: ignore keeps them, replace updates them.
      const ignored = await migrateAdapter(sqlite, pg, { onConflict: 'ignore' });
      expect(ignored.errors).toBeUndefined();
      expect(ignored.rowsImported).toBe(0);
      await sqlite.run(`UPDATE ${table} SET title = ? WHERE id = ?`, ['first, edited', 5]);
      const replaced = await migrateAdapter(sqlite, pg, { onConflict: 'replace' });
      expect(replaced.errors).toBeUndefined();
      expect(await pg.all(`SELECT id, title FROM ${table} ORDER BY id`)).toEqual([
        { id: 5, title: 'first, edited' },
        { id: 9, title: 'second' },
        { id: 10, title: 'third' },
      ]);
    } finally {
      await sqlite.close();
    }
  });

  it('copies into a table the target already has, whose identity is GENERATED ALWAYS (skipSchema)', async () => {
    const sqlite = await createDatabase({ type: 'memory' });
    const table = unique('tags');
    tables.push(table);
    try {
      await sqlite.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, label TEXT NOT NULL)`);
      await sqlite.run(`INSERT INTO ${table} (id, label) VALUES (?, ?)`, [4, 'four']);
      await sqlite.run(`INSERT INTO ${table} (id, label) VALUES (?, ?)`, [6, 'six']);
      const dialect = createStorageFeatures(pg).dialect;
      await pg.exec(`CREATE TABLE ${table} (id ${dialect.autoIncrementPrimaryKey()}, label TEXT NOT NULL)`);

      const result = await migrateAdapter(sqlite, pg, { skipSchema: true });
      expect(result.errors).toBeUndefined();
      expect(result.rowsImported).toBe(2);
      expect(await pg.all(`SELECT id, label FROM ${table} ORDER BY id`)).toEqual([
        { id: 4, label: 'four' },
        { id: 6, label: 'six' },
      ]);
      expect(await pg.get(`INSERT INTO ${table} (label) VALUES (?) RETURNING id`, ['seven'])).toEqual({ id: 7 });
    } finally {
      await sqlite.close();
    }
  });

  it('creates SQLite types and defaults from PostgreSQL, with the identity as INTEGER PRIMARY KEY', async () => {
    const table = unique('people');
    tables.push(table);
    await pg.exec(`CREATE TABLE ${table} (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      name VARCHAR(40) NOT NULL DEFAULT 'none',
      active BOOLEAN NOT NULL DEFAULT true,
      tags TEXT[],
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      doc JSONB
    )`);
    await pg.exec(`INSERT INTO ${table} (id, name, active, tags, created_at, doc) OVERRIDING SYSTEM VALUE VALUES
      (3, 'ada', true, ARRAY['x', 'y'], '2026-10-16T12:00:00Z', '{"k": 1}'::jsonb),
      (7, 'bob', false, NULL, '2026-10-16T13:00:00Z', NULL)`);
    const sqlite = await createDatabase({ type: 'memory' });
    try {
      const result = await migrateAdapter(pg, sqlite, { tables: [table] });
      expect(result.errors).toBeUndefined();
      expect(result.rowsImported).toBe(2);

      expect(await sqlite.all(`SELECT id, name, active, tags, created_at, doc FROM ${table} ORDER BY id`)).toEqual([
        { id: 3, name: 'ada', active: 1, tags: '["x","y"]', created_at: '2026-10-16T12:00:00.000Z', doc: '{"k":1}' },
        { id: 7, name: 'bob', active: 0, tags: null, created_at: '2026-10-16T13:00:00.000Z', doc: null },
      ]);

      await sqlite.run(`INSERT INTO ${table} (tags) VALUES (?)`, ['[]']);
      const added = await sqlite.get<{ id: number; name: string; active: number; created_at: string }>(
        `SELECT id, name, active, created_at FROM ${table} WHERE id > 7`,
      );
      expect(added).toMatchObject({ id: 8, name: 'none', active: 1 });
      expect(added?.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    } finally {
      await sqlite.close();
    }
  });

  it('maps SQLite defaults to PostgreSQL, and names the one it cannot', async () => {
    const sqlite = await createDatabase({ type: 'memory' });
    const table = unique('defaults');
    tables.push(table);
    try {
      await sqlite.exec(`CREATE TABLE ${table} (
        id TEXT PRIMARY KEY,
        stamp_text TEXT DEFAULT (datetime('now')),
        iso_text TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        day DATE DEFAULT (date('now')),
        at_epoch INTEGER DEFAULT (unixepoch()),
        flag BOOLEAN DEFAULT 'true',
        note TEXT DEFAULT 'it''s',
        salt TEXT DEFAULT (lower(hex(randomblob(2))))
      )`);

      const result = await migrateAdapter(sqlite, pg);
      expect(result.errors).toBeUndefined();
      expect(result.warnings).toEqual([expect.stringContaining(`${table}.salt`)]);

      const row = await pg.get<Record<string, unknown>>(`INSERT INTO ${table} (id) VALUES ('a') RETURNING *`);
      expect(row?.stamp_text).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      expect(row?.iso_text).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(row?.day).toBeInstanceOf(Date);
      expect(Math.abs(Number(row?.at_epoch) - Date.now() / 1000)).toBeLessThan(300);
      expect(row).toMatchObject({ flag: true, note: "it's", salt: null });
    } finally {
      await sqlite.close();
    }
  });

  it('maps PostgreSQL defaults to SQLite, and names the identity and generated columns it made plain', async () => {
    const table = unique('pg_defaults');
    tables.push(table);
    await pg.exec(`CREATE TABLE ${table} (
      id TEXT PRIMARY KEY,
      token UUID DEFAULT gen_random_uuid(),
      day DATE DEFAULT CURRENT_DATE,
      at_time TIME DEFAULT LOCALTIME,
      n INTEGER DEFAULT -1,
      label TEXT DEFAULT 'x'::text,
      seq_no BIGINT GENERATED BY DEFAULT AS IDENTITY,
      doubled INTEGER GENERATED ALWAYS AS (n * 2) STORED
    )`);
    await pg.exec(`INSERT INTO ${table} (id) VALUES ('a')`);
    const sqlite = await createDatabase({ type: 'memory' });
    try {
      const result = await migrateAdapter(pg, sqlite, { tables: [table] });
      expect(result.errors).toBeUndefined();
      expect(result.warnings).toEqual([expect.stringContaining(`${table}.seq_no`), expect.stringContaining(`${table}.doubled`)]);
      expect(await sqlite.get(`SELECT id, n, label, seq_no, doubled FROM ${table}`)).toEqual({ id: 'a', n: -1, label: 'x', seq_no: 1, doubled: -2 });

      await sqlite.run(`INSERT INTO ${table} (id) VALUES ('b')`);
      const row = await sqlite.get<Record<string, unknown>>(`SELECT * FROM ${table} WHERE id = 'b'`);
      expect(row?.token).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(row?.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(row?.at_time).toMatch(/^\d{2}:\d{2}:\d{2}$/);
      expect(row).toMatchObject({ n: -1, label: 'x', seq_no: null });
    } finally {
      await sqlite.close();
    }
  });

  it('writes a PostgreSQL SQL export that loads into another schema', async () => {
    const sourceSchema = unique('dump_src');
    const targetSchema = unique('dump_dst');
    schemas.push(sourceSchema, targetSchema);
    const source = createPostgresAdapter({ connectionString: url, segment: sourceSchema });
    const target = createPostgresAdapter({ connectionString: url, segment: targetSchema });
    await source.open();
    await target.open();
    try {
      await source.exec(`CREATE TABLE docs (
        id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        title TEXT NOT NULL,
        tags TEXT[],
        meta JSONB,
        raw BYTEA,
        done BOOLEAN NOT NULL DEFAULT false,
        title_length INTEGER GENERATED ALWAYS AS (length(title)) STORED
      )`);
      await source.exec(`INSERT INTO docs (title, tags, meta, raw, done) VALUES
        ('it''s "quoted"', ARRAY['a', 'b "c"', NULL], '{"k": [1, 2]}', '\\x0102ff', true),
        ('second', NULL, NULL, NULL, false)`);

      const loaded = await importFromSQL(target, await exportAsSQL(source));
      expect(loaded.errors).toBeUndefined();
      expect(await target.all('SELECT id, title, tags, meta, raw, done, title_length FROM docs ORDER BY id')).toEqual([
        { id: 1, title: `it's "quoted"`, tags: ['a', 'b "c"', null], meta: { k: [1, 2] }, raw: Buffer.from([1, 2, 255]), done: true, title_length: 13 },
        { id: 2, title: 'second', tags: null, meta: null, raw: null, done: false, title_length: 6 },
      ]);
      expect(await target.get(`INSERT INTO docs (title) VALUES ('third') RETURNING id`)).toEqual({ id: 3 });
    } finally {
      await source.close();
      await target.close();
    }
  });

  it('copies between PostgreSQL schemas: exact types, a serial as an identity, a generated column regenerated', async () => {
    const sourceSchema = unique('migrate_src');
    const targetSchema = unique('migrate_dst');
    schemas.push(sourceSchema, targetSchema);
    const source = createPostgresAdapter({ connectionString: url, segment: sourceSchema });
    const target = createPostgresAdapter({ connectionString: url, segment: targetSchema });
    await source.open();
    await target.open();
    try {
      await source.exec(`CREATE TABLE items (
        id SERIAL PRIMARY KEY,
        sku VARCHAR(20) NOT NULL,
        price NUMERIC(10,2) NOT NULL DEFAULT 0,
        qty INTEGER[],
        total NUMERIC GENERATED ALWAYS AS (price * 2) STORED
      )`);
      await source.exec(`INSERT INTO items (sku, price, qty) VALUES ('a', 1.25, ARRAY[1, 2]), ('b', 3.50, NULL)`);

      const result = await migrateAdapter(source, target);
      expect(result.errors).toBeUndefined();
      expect(result.rowsImported).toBe(2);

      expect((await columnTypes(target, 'items')).map(({ name, type }) => [name, type])).toEqual([
        ['id', 'integer'],
        ['sku', 'character varying(20)'],
        ['price', 'numeric(10,2)'],
        ['qty', 'integer[]'],
        ['total', 'numeric'],
      ]);
      expect(await target.all('SELECT id, sku, price, qty, total FROM items ORDER BY id')).toEqual([
        { id: 1, sku: 'a', price: '1.25', qty: [1, 2], total: '2.50' },
        { id: 2, sku: 'b', price: '3.50', qty: null, total: '7.00' },
      ]);
      expect(await target.get(`INSERT INTO items (sku) VALUES ('c') RETURNING id`)).toEqual({ id: 3 });
      expect(await target.get('UPDATE items SET price = 10 WHERE id = 1 RETURNING total')).toEqual({ total: '20.00' });
    } finally {
      await source.close();
      await target.close();
    }
  });
});
