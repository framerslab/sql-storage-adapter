import { describe, expect, it, afterAll, afterEach, beforeAll, vi } from 'vitest';
import pg from 'pg';
import {
  PostgresAdapter,
  createDatabase,
  createPostgresAdapter,
  exportData,
  resolveStorageAdapter,
  type StorageAdapter,
} from '../src/index.js';

// A segment on PostgreSQL is a schema of its own: every connection of the
// adapter's pool starts with search_path set to the segment, then public, so the
// tables a segment creates land in its schema and extension types installed in
// public (pgvector's vector) still resolve. CI's Postgres service is the
// pgvector image, so the vector extension can be installed.

const POSTGRES_TEST_URL = process.env.POSTGRES_TEST_URL;

/** A name no other run of this suite uses: lower-case letters and digits. */
const unique = (prefix: string): string => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;

/** Lets the pool's events arrive, for a bounded time. */
const until = async (done: () => boolean, timeoutMs = 5_000): Promise<void> => {
  const started = Date.now();
  while (!done() && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(done()).toBe(true);
};

describe.skipIf(!POSTGRES_TEST_URL)('PostgreSQL segments', () => {
  const url = POSTGRES_TEST_URL as string;
  const schemas: string[] = [];
  const opened: StorageAdapter[] = [];
  let admin: StorageAdapter;

  const segmentAdapter = async (segment: string, extra: Record<string, unknown> = {}): Promise<StorageAdapter> => {
    schemas.push(segment);
    const adapter = createPostgresAdapter({ connectionString: url, segment, ...extra });
    opened.push(adapter);
    await adapter.open();
    return adapter;
  };

  const currentSchema = async (adapter: StorageAdapter): Promise<string> =>
    (await adapter.get<{ schema: string }>('SELECT current_schema() AS schema'))?.schema ?? '';

  /** The schemas that hold a table of this name, among the segment's and public. */
  const schemasHolding = async (table: string, segment: string): Promise<string[]> =>
    (
      await admin.all<{ table_schema: string }>(
        "SELECT table_schema FROM information_schema.tables WHERE table_name = ? AND table_schema IN (?, 'public') ORDER BY table_schema",
        [table, segment],
      )
    ).map((row) => row.table_schema);

  beforeAll(async () => {
    admin = createPostgresAdapter(url);
    await admin.open();
  });

  afterEach(async () => {
    for (const adapter of opened.splice(0)) {
      await adapter.close().catch(() => undefined);
    }
  });

  afterAll(async () => {
    for (const schema of schemas) {
      await admin.exec(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
    }
    await admin.close();
  });

  it('creates the schema on open and makes it the current schema', async () => {
    const segment = unique('seg');
    const adapter = await segmentAdapter(segment);

    expect(await currentSchema(adapter)).toBe(segment);
    const found = await admin.get<{ name: string }>('SELECT nspname AS name FROM pg_namespace WHERE nspname = ?', [segment]);
    expect(found?.name).toBe(segment);
  });

  it('puts the tables it creates in its schema, not in public', async () => {
    const segment = unique('seg');
    const table = unique('items');
    const adapter = await segmentAdapter(segment);

    await adapter.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, label TEXT NOT NULL)`);
    await adapter.run(`INSERT INTO ${table} (id, label) VALUES (?, ?)`, [1, 'in the segment']);

    expect(await schemasHolding(table, segment)).toEqual([segment]);
    expect(await admin.all(`SELECT label FROM "${segment}".${table}`)).toEqual([{ label: 'in the segment' }]);
  });

  it('runs a transaction in its schema', async () => {
    const segment = unique('seg');
    const table = unique('items');
    const adapter = await segmentAdapter(segment);
    await adapter.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, label TEXT NOT NULL)`);

    await adapter.transaction(async (trx) => {
      await trx.run(`INSERT INTO ${table} (id, label) VALUES (?, ?)`, [1, 'committed']);
    });

    expect(await admin.all(`SELECT label FROM "${segment}".${table}`)).toEqual([{ label: 'committed' }]);
  });

  it('keeps the rows of two segments with the same table apart', async () => {
    const table = unique('items');
    const first = await segmentAdapter(unique('seg'));
    const second = await segmentAdapter(unique('seg'));

    for (const [adapter, label] of [
      [first, 'first'],
      [second, 'second'],
    ] as const) {
      await adapter.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, label TEXT NOT NULL)`);
      await adapter.run(`INSERT INTO ${table} (id, label) VALUES (?, ?)`, [1, label]);
    }

    expect(await first.all(`SELECT label FROM ${table}`)).toEqual([{ label: 'first' }]);
    expect(await second.all(`SELECT label FROM ${table}`)).toEqual([{ label: 'second' }]);
  });

  it('finds a table of the segment before a table of the same name in public', async () => {
    const segment = unique('seg');
    const table = unique('items');
    await admin.exec(`CREATE TABLE public.${table} (id INTEGER PRIMARY KEY, label TEXT NOT NULL)`);
    await admin.run(`INSERT INTO public.${table} (id, label) VALUES (?, ?)`, [1, 'the host']);
    try {
      const adapter = await segmentAdapter(segment);
      await adapter.exec(`CREATE TABLE IF NOT EXISTS ${table} (id INTEGER PRIMARY KEY, label TEXT NOT NULL)`);
      await adapter.run(`INSERT INTO ${table} (id, label) VALUES (?, ?)`, [1, 'the segment']);

      expect(await schemasHolding(table, segment)).toEqual(['public', segment].sort());
      expect(await adapter.all(`SELECT label FROM ${table}`)).toEqual([{ label: 'the segment' }]);
      expect(await admin.all(`SELECT label FROM public.${table}`)).toEqual([{ label: 'the host' }]);
    } finally {
      await admin.exec(`DROP TABLE IF EXISTS public.${table}`);
    }
  });

  it('resolves the vector type and its operators through public in two segments', async () => {
    await admin.exec('CREATE EXTENSION IF NOT EXISTS vector SCHEMA public');
    const table = unique('embeddings');
    const first = await segmentAdapter(unique('seg'));
    const second = await segmentAdapter(unique('seg'));

    for (const adapter of [first, second]) {
      // Run through the segment, an unqualified CREATE EXTENSION finds the one in public and installs nothing.
      await adapter.exec('CREATE EXTENSION IF NOT EXISTS vector');
      await adapter.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, embedding vector(3) NOT NULL)`);
      await adapter.run(`INSERT INTO ${table} (id, embedding) VALUES (?, ?), (?, ?)`, [1, '[1,2,3]', 2, '[9,9,9]']);
      const nearest = await adapter.get<{ id: number }>(`SELECT id FROM ${table} ORDER BY embedding <-> ? LIMIT 1`, ['[1,2,4]']);
      expect(nearest).toEqual({ id: 1 });
    }

    const extension = await admin.get<{ schema: string }>(
      "SELECT extnamespace::regnamespace::text AS schema FROM pg_extension WHERE extname = 'vector'",
    );
    expect(extension?.schema).toBe('public');
  });

  // An extension is one per database. Unqualified, CREATE EXTENSION installs a
  // relocatable one (pgvector's vector, citext) into the current schema, which on
  // a segment is the segment: every other segment and the host would then miss
  // its types. The adapter installs it into public, as it would without a segment.
  describe('on a database that has no extensions yet', () => {
    let database: string;
    let freshUrl: string;
    const freshAdapters: StorageAdapter[] = [];

    const freshAdapter = async (segment?: string): Promise<StorageAdapter> => {
      const adapter = createPostgresAdapter(segment ? { connectionString: freshUrl, segment } : freshUrl);
      freshAdapters.push(adapter);
      await adapter.open();
      return adapter;
    };

    /** The schema an installed extension's objects are in. */
    const extensionSchema = async (adapter: StorageAdapter, name: string): Promise<string | undefined> =>
      (
        await adapter.get<{ schema: string }>(
          'SELECT extnamespace::regnamespace::text AS schema FROM pg_extension WHERE extname = ?',
          [name],
        )
      )?.schema;

    beforeAll(async () => {
      database = unique('fresh');
      await admin.exec(`CREATE DATABASE ${database}`);
      const parsed = new URL(url);
      parsed.pathname = `/${database}`;
      freshUrl = parsed.toString();
    });

    afterAll(async () => {
      for (const adapter of freshAdapters.splice(0)) {
        await adapter.close().catch(() => undefined);
      }
      await admin.exec(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    });

    it('installs an extension that a segment creates without a schema into public, where a second segment and the host find it', async () => {
      const first = await freshAdapter(unique('seg'));
      await first.exec('CREATE EXTENSION IF NOT EXISTS vector');

      const host = await freshAdapter();
      expect(await extensionSchema(host, 'vector')).toBe('public');

      const second = await freshAdapter(unique('seg'));
      await second.exec('CREATE TABLE embeddings (id INTEGER PRIMARY KEY, embedding vector(3) NOT NULL)');
      await second.run('INSERT INTO embeddings (id, embedding) VALUES (?, ?)', [1, '[1,2,3]']);
      expect(await second.get('SELECT id FROM embeddings ORDER BY embedding <-> ? LIMIT 1', ['[1,2,4]'])).toEqual({ id: 1 });

      await host.exec('CREATE TABLE public.host_embeddings (embedding vector(3))');
    });

    it('installs one inside a transaction into public and keeps the rest of the transaction in the segment', async () => {
      const segment = unique('seg');
      const adapter = await freshAdapter(segment);

      await adapter.transaction(async (trx) => {
        await trx.exec('CREATE EXTENSION IF NOT EXISTS citext');
        await trx.exec('CREATE TABLE after_extension (id INTEGER PRIMARY KEY, name citext)');
      });

      const host = await freshAdapter();
      expect(await extensionSchema(host, 'citext')).toBe('public');
      expect(
        await host.all<{ table_schema: string }>(
          "SELECT table_schema FROM information_schema.tables WHERE table_name = 'after_extension'",
        ),
      ).toEqual([{ table_schema: segment }]);
    });

    // withConnection() hands its callback one connection: the statement runs
    // in a transaction of its own outside the callback's transactions, and
    // inside one the callback began.
    it('installs an extension a held connection creates without a schema into public, outside a transaction and inside one', async () => {
      const segment = unique('seg');
      const adapter = new PostgresAdapter({ connectionString: freshUrl, segment });
      freshAdapters.push(adapter);
      await adapter.open();

      const schemas = await adapter.withConnection(async (connection) => {
        const schema = async (): Promise<string | undefined> =>
          (await connection.get<{ schema: string }>('SELECT current_schema() AS schema'))?.schema;
        const seen = [await schema()];
        await connection.exec('CREATE EXTENSION IF NOT EXISTS isn');
        seen.push(await schema());
        await connection.run('BEGIN');
        await connection.exec('CREATE EXTENSION IF NOT EXISTS ltree');
        await connection.exec('CREATE TABLE held_rows (id INTEGER PRIMARY KEY, path ltree)');
        await connection.run('COMMIT');
        seen.push(await schema());
        return seen;
      });

      expect(schemas).toEqual([segment, segment, segment]);
      const host = await freshAdapter();
      expect(await extensionSchema(host, 'isn')).toBe('public');
      expect(await extensionSchema(host, 'ltree')).toBe('public');
      expect(
        await host.all<{ table_schema: string }>(
          "SELECT table_schema FROM information_schema.tables WHERE table_name = 'held_rows'",
        ),
      ).toEqual([{ table_schema: segment }]);
    });

    it('leaves an extension where a statement that names a schema puts it', async () => {
      const segment = unique('seg');
      const adapter = await freshAdapter(segment);

      await adapter.exec(`CREATE EXTENSION IF NOT EXISTS hstore SCHEMA ${segment}`);

      const host = await freshAdapter();
      expect(await extensionSchema(host, 'hstore')).toBe(segment);
    });

    // IF NOT EXISTS finds the extension wherever it is, so a segment that asks
    // for one installed in another segment's schema gets no error, and its types
    // do not resolve: the adapter says where it is and how to move it.
    it('warns when an extension a segment asks for is installed in a schema its search_path does not reach', async () => {
      const owner = unique('seg');
      const first = await freshAdapter(owner);
      await first.exec(`CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA ${owner}`);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const other = await freshAdapter(unique('seg'));
        await other.exec('CREATE EXTENSION IF NOT EXISTS pg_trgm');

        const messages = warn.mock.calls.map(([message]) => String(message));
        expect(messages.some((message) => message.includes('pg_trgm') && message.includes(owner))).toBe(true);
        expect(messages.some((message) => message.includes('ALTER EXTENSION'))).toBe(true);
      } finally {
        warn.mockRestore();
      }
    });
  });

  // pg reads PGOPTIONS only when a connection has no startup options of its own,
  // and a segment gives every connection one: the adapter keeps what PGOPTIONS
  // says beside its search_path.
  it('keeps the startup options PGOPTIONS gives, beside its search_path', async () => {
    vi.stubEnv('PGOPTIONS', '-c statement_timeout=4321');
    try {
      const segment = unique('seg');
      const adapter = await segmentAdapter(segment);

      expect(await currentSchema(adapter)).toBe(segment);
      expect(await adapter.get('SHOW statement_timeout')).toEqual({ statement_timeout: '4321ms' });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // PostgreSQL leaves out of the search_path, without a word, a schema the role
  // has no USAGE privilege on. A segment whose schema another role made would
  // then run its statements in public: open() refuses it instead.
  describe('on a schema another role made', () => {
    const role = unique('seg_role');
    // A role made on CI's own service for these specs, and dropped after them.
    const rolePassword = 'segment-role';
    let roleUrl: string;

    const roleAdapter = (segment: string): StorageAdapter => {
      schemas.push(segment);
      const adapter = createPostgresAdapter({ connectionString: roleUrl, segment });
      opened.push(adapter);
      return adapter;
    };

    beforeAll(async () => {
      await admin.exec(`CREATE ROLE ${role} LOGIN PASSWORD '${rolePassword}'`);
      const parsed = new URL(url);
      parsed.username = role;
      parsed.password = rolePassword;
      roleUrl = parsed.toString();
    });

    afterAll(async () => {
      // Drops what the role owns here and takes back what it was granted, so the role can go.
      await admin.exec(`DROP OWNED BY ${role}`).catch(() => undefined);
      await admin.exec(`DROP ROLE IF EXISTS ${role}`);
    });

    it('refuses to open on an existing schema the role has no USAGE on, and holds no pool', async () => {
      const segment = unique('seg');
      await admin.exec(`CREATE SCHEMA ${segment}`);
      const adapter = roleAdapter(segment);

      await expect(adapter.open()).rejects.toThrow(/is not the current schema/);
      expect((adapter as PostgresAdapter).getPool()).toBeNull();
    });

    it('opens on that schema once the role has USAGE and CREATE on it, and creates its tables there', async () => {
      const segment = unique('seg');
      await admin.exec(`CREATE SCHEMA ${segment}`);
      await admin.exec(`GRANT USAGE, CREATE ON SCHEMA ${segment} TO ${role}`);
      const adapter = roleAdapter(segment);
      await adapter.open();

      expect(await currentSchema(adapter)).toBe(segment);
      await adapter.exec('CREATE TABLE role_items (id INTEGER PRIMARY KEY)');
      expect(await schemasHolding('role_items', segment)).toEqual([segment]);
    });
  });

  it('starts every connection of its pool in the segment, a replaced connection too', async () => {
    const segment = unique('seg');
    const applicationName = unique('app');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const adapter = await segmentAdapter(segment, { max: 1, application_name: applicationName });
      expect(await currentSchema(adapter)).toBe(segment);

      // The server ends the pool's one connection; the pool reports it and opens another.
      await admin.all('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = ?', [applicationName]);
      await until(() => warn.mock.calls.length > 0);

      expect(await currentSchema(adapter)).toBe(segment);
    } finally {
      warn.mockRestore();
    }
  });

  it('returns to the segment after RESET and DISCARD ALL, which restore the startup setting', async () => {
    const segment = unique('seg');
    const adapter = await segmentAdapter(segment, { max: 1 });

    await adapter.exec('SET search_path TO public');
    expect(await currentSchema(adapter)).toBe('public');
    await adapter.exec('RESET search_path');
    expect(await currentSchema(adapter)).toBe(segment);

    await adapter.exec('SET search_path TO public');
    await adapter.exec('DISCARD ALL');
    expect(await currentSchema(adapter)).toBe(segment);
  });

  it('answers a parameterised read from its schema', async () => {
    const segment = unique('seg');
    const table = unique('items');
    const adapter = await segmentAdapter(segment);
    await adapter.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, label TEXT NOT NULL)`);
    await adapter.run(`INSERT INTO ${table} (id, label) VALUES (?, ?), (?, ?)`, [1, 'one', 2, 'two']);

    expect(await adapter.get(`SELECT label FROM ${table} WHERE id = ?`, [2])).toEqual({ label: 'two' });
    expect(await adapter.get(`SELECT label FROM ${table} WHERE id = @id`, { id: 1 })).toEqual({ label: 'one' });
  });

  it("exports the segment's tables only, with their own columns", async () => {
    const segment = unique('seg');
    const table = unique('items');
    const hostOnly = unique('host_only');
    await admin.exec(`CREATE TABLE public.${table} (other_column TEXT)`);
    await admin.exec(`CREATE TABLE public.${hostOnly} (id INTEGER)`);
    try {
      const adapter = await segmentAdapter(segment);
      await adapter.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, label TEXT NOT NULL)`);
      await adapter.run(`INSERT INTO ${table} (id, label) VALUES (?, ?)`, [1, 'exported']);

      const exported = await exportData(adapter);

      expect(Object.keys(exported.data)).toEqual([table]);
      expect(exported.data[table]).toEqual([{ id: 1, label: 'exported' }]);
      expect(exported.schema?.[0].columns.map((column) => column.name)).toEqual(['id', 'label']);
    } finally {
      await admin.exec(`DROP TABLE IF EXISTS public.${table}`);
      await admin.exec(`DROP TABLE IF EXISTS public.${hostOnly}`);
    }
  });

  it('opens a segment through createDatabase({ url, segment })', async () => {
    const segment = unique('seg');
    schemas.push(segment);
    const adapter = await createDatabase({ url, segment });
    opened.push(adapter);

    expect(adapter.kind).toBe('postgres');
    expect(await currentSchema(adapter)).toBe(segment);
  });

  // The segment an IndexedDB candidate's options name is the browser's: a
  // server tried after it keeps the schemas its own options choose.
  it('opens a postgres candidate tried after an IndexedDB candidate that asked for a segment outside it, and makes no schema', async () => {
    const segment = unique('seg');
    schemas.push(segment);
    // Node has no indexedDB, so the IndexedDB candidate fails.
    const adapter = await resolveStorageAdapter({
      priority: ['indexeddb', 'postgres'],
      indexedDb: { segment },
      postgres: { connectionString: url },
      quiet: true,
    });
    opened.push(adapter);

    expect(adapter.kind).toBe('postgres');
    expect(await currentSchema(adapter)).not.toBe(segment);
    const found = await admin.get<{ name: string }>('SELECT nspname AS name FROM pg_namespace WHERE nspname = ?', [segment]);
    expect(found ?? null).toBeNull();
  });

  it('refuses a segment with a pool of the caller, whose connections it cannot start', async () => {
    const pool = new pg.Pool({ connectionString: url });
    try {
      expect(() => createPostgresAdapter({ pool, segment: unique('seg') })).toThrow(/segment/);
    } finally {
      await pool.end();
    }
  });

  it('refuses a segment with a connection string that sets its own startup options', () => {
    const withOptions = `${url}${url.includes('?') ? '&' : '?'}options=${encodeURIComponent('-c search_path=other')}`;

    expect(() => createPostgresAdapter({ connectionString: withOptions, segment: unique('seg') })).toThrow(/options/);
  });

  it('refuses a segment name it cannot use', () => {
    expect(() => createPostgresAdapter({ connectionString: url, segment: 'Bad Name' })).toThrow(/segment/i);
    expect(() => createPostgresAdapter({ connectionString: url, segment: 'pg_catalog' })).toThrow(/segment/i);
    expect(() => createPostgresAdapter({ connectionString: url, segment: 'public' })).toThrow(/segment/i);
  });
});
