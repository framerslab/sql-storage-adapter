import { describe, expect, it, afterEach, vi } from 'vitest';
import type { StorageAdapter } from '../src/core/contracts';
import type { StorageResolutionOptions } from '../src/core/resolver';
import { connectDatabase, createDatabase, createMemoryDatabase } from '../src/core/database';

// createDatabase() chooses the adapter priority and hands it to the resolver.
// These specs read what it hands over: the resolver is a stub here, so no
// database opens. tests/createDatabase.postgres.spec.ts opens real ones.

const { handedOver } = vi.hoisted(() => ({ handedOver: [] as StorageResolutionOptions[] }));

vi.mock('../src/core/resolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/resolver')>();
  return {
    ...actual,
    resolveStorageAdapter: vi.fn(async (options: StorageResolutionOptions) => {
      handedOver.push(options);
      return { open: async () => undefined } as unknown as StorageAdapter;
    }),
  };
});

const POSTGRES_URL = 'postgresql://app@db.internal:5432/app';

describe('createDatabase - adapter priority', () => {
  const last = (): StorageResolutionOptions => handedOver[handedOver.length - 1];

  afterEach(() => {
    handedOver.length = 0;
    vi.unstubAllGlobals();
  });

  it('chooses Postgres alone on Node for a URL, and passes the Postgres options on with it', async () => {
    await createDatabase({ url: POSTGRES_URL, postgres: { max: 4, ssl: true, statement_timeout: 5000 } });

    expect(last().priority).toEqual(['postgres']);
    expect(last().postgres).toEqual({ connectionString: POSTGRES_URL, max: 4, ssl: true, statement_timeout: 5000 });
  });

  it('chooses Postgres alone on Node for a pool of the caller', async () => {
    const pool = { query: async () => ({ rows: [], rowCount: 0 }) };

    await createDatabase({ postgres: { pool } as never });

    expect(last().priority).toEqual(['postgres']);
  });

  it('chooses Postgres alone on Node for options that name a host, database and user', async () => {
    await connectDatabase({ host: 'db.internal', database: 'app', user: 'app' });

    expect(last().priority).toEqual(['postgres']);
  });

  it('keeps the local default on Node when the Postgres options name no server', async () => {
    await createDatabase({ postgres: { connectionString: undefined } });

    expect(last().priority).toEqual(['better-sqlite3', 'sqljs']);
  });

  it('chooses IndexedDB, then sql.js, in a browser, and no Postgres for a URL it cannot reach', async () => {
    vi.stubGlobal('window', { document: {} });

    await createDatabase({ url: POSTGRES_URL });
    expect(last().priority).toEqual(['indexeddb', 'sqljs']);

    await createDatabase();
    expect(last().priority).toEqual(['indexeddb', 'sqljs']);
  });

  it('keeps an in-memory database in memory in a browser, which IndexedDB would keep', async () => {
    vi.stubGlobal('window', { document: {} });

    await createDatabase({ file: ':memory:' });
    expect(last().priority).toEqual(['sqljs']);

    await createMemoryDatabase();
    expect(last().priority).toEqual(['sqljs']);
  });

  it('chooses the native SQLite plugin, then IndexedDB, in a Capacitor app, as the resolver does', async () => {
    vi.stubGlobal('window', { document: {}, Capacitor: { isNativePlatform: () => true } });

    await createDatabase();

    expect(last().priority).toEqual(['capacitor', 'indexeddb', 'sqljs']);
  });

  it('hands the IndexedDB options and the segment to the resolver in a browser', async () => {
    vi.stubGlobal('window', { document: {} });

    await createDatabase({ indexedDb: { dbName: 'notes', durability: 'commit' }, segment: 'agentos' });

    expect(last().indexedDb).toEqual({ dbName: 'notes', durability: 'commit' });
    expect(last().segment).toBe('agentos');
  });

  it('keeps sql.js on Deno', async () => {
    vi.stubGlobal('Deno', {});

    await createDatabase({ url: POSTGRES_URL });

    expect(last().priority).toEqual(['sqljs']);
  });

  it('leaves an explicit priority or type as it is', async () => {
    await createDatabase({ url: POSTGRES_URL, priority: ['better-sqlite3'] });
    expect(last().priority).toEqual(['better-sqlite3']);

    await createDatabase({ url: POSTGRES_URL, type: 'sqlite' });
    expect(last().priority).toEqual(['better-sqlite3']);
  });

  it('keeps the local default on Node for a connection string that is not a PostgreSQL URL', async () => {
    // DATABASE_URL holds such strings in projects that run SQLite through
    // Prisma (file:./dev.db) or name another database.
    for (const url of ['file:./dev.db', 'sqlite:///var/data/app.db', 'mysql://app@db.internal/app']) {
      await createDatabase({ url });
      expect(last().priority, url).toEqual(['better-sqlite3', 'sqljs']);
    }

    await createDatabase({ postgres: { connectionString: 'file:./dev.db', max: 4 } });
    expect(last().priority).toEqual(['better-sqlite3', 'sqljs']);
  });

  it('chooses Postgres for postgres:// and postgresql:// URLs, in any case', async () => {
    for (const url of ['postgres://app@db.internal/app', 'POSTGRESQL://app@db.internal/app']) {
      await createDatabase({ url });
      expect(last().priority, url).toEqual(['postgres']);
    }
  });
});

describe('connectDatabase', () => {
  const last = (): StorageResolutionOptions => handedOver[handedOver.length - 1];

  afterEach(() => {
    handedOver.length = 0;
    vi.unstubAllGlobals();
  });

  it('refuses a configuration that names no server, before it opens anything', async () => {
    // connectDatabase(process.env.DATABASE_URL) or connectDatabase({ connectionString:
    // process.env.DATABASE_URL }) with the variable unset.
    for (const config of [{ connectionString: undefined }, { connectionString: '' }, {}]) {
      await expect(connectDatabase(config)).rejects.toThrow(/no PostgreSQL server/);
    }
    await expect(connectDatabase('')).rejects.toThrow(/no PostgreSQL server/);
    await expect(connectDatabase(undefined as unknown as string)).rejects.toThrow(/no PostgreSQL server/);

    expect(handedOver).toEqual([]);
  });

  it('asks for PostgreSQL alone for any connection string, in any runtime', async () => {
    await connectDatabase('socket:/var/run/postgresql?db=app');
    expect(last().priority).toEqual(['postgres']);

    vi.stubGlobal('window', { document: {} });
    await connectDatabase(POSTGRES_URL);
    expect(last().priority).toEqual(['postgres']);
  });
});
