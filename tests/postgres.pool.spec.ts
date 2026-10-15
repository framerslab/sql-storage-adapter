import { describe, expect, it, afterAll, beforeAll, vi } from 'vitest';
import pg from 'pg';
import { PostgresAdapter, createDatabase, createPostgresAdapter, type StorageAdapter } from '../src/index.js';

// The Postgres adapter can run on a pool its caller made: it leaves that pool
// open on close() unless told it owns it, reports the pool's errors to onError,
// and hands its pool back through getPool().

const POSTGRES_TEST_URL = process.env.POSTGRES_TEST_URL;

/** A Postgres URL nothing listens on. */
const UNREACHABLE_URL = 'postgresql://adapter:adapter@127.0.0.1:1/unreachable';

describe('PostgresAdapter open() that cannot connect', () => {
  it('ends the pool it made and holds none, so close() has nothing left to end', async () => {
    const adapter = new PostgresAdapter({ connectionString: UNREACHABLE_URL, connectionTimeoutMillis: 2_000 });

    await expect(adapter.open()).rejects.toThrow();

    expect(adapter.getPool()).toBeNull();
    await expect(adapter.close()).resolves.toBeUndefined();
  });
});

/** A name no other run of this suite uses. */
const unique = (prefix: string): string => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;

/** Waits for `done`, for a bounded time. */
const until = async (done: () => boolean, timeoutMs = 5_000): Promise<void> => {
  const started = Date.now();
  while (!done() && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(done()).toBe(true);
};

describe.skipIf(!POSTGRES_TEST_URL)('PostgresAdapter and a pool of its caller', () => {
  const url = POSTGRES_TEST_URL as string;
  let admin: StorageAdapter;

  /** Ends, from the server's side, the connections of one application name. */
  const terminate = async (applicationName: string): Promise<void> => {
    await admin.all('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = ?', [applicationName]);
  };

  beforeAll(async () => {
    admin = createPostgresAdapter(url);
    await admin.open();
  });

  afterAll(async () => {
    await admin.close();
  });

  it('runs on the pool it was given, from the start, and leaves it open on close()', async () => {
    const pool = new pg.Pool({ connectionString: url, max: 2 });
    try {
      const adapter = createPostgresAdapter({ pool });
      expect(await adapter.get('SELECT 1 AS one')).toEqual({ one: 1 });

      await adapter.open();
      expect(await adapter.transaction((trx) => trx.get('SELECT 2 AS two'))).toEqual({ two: 2 });
      await adapter.close();

      expect(pool.ended).toBe(false);
      expect((await pool.query('SELECT 3 AS three')).rows).toEqual([{ three: 3 }]);
    } finally {
      await pool.end();
    }
  });

  it('opens again on the same pool after close()', async () => {
    const pool = new pg.Pool({ connectionString: url, max: 1 });
    try {
      const adapter = createPostgresAdapter({ pool });
      await adapter.close();
      await adapter.open();

      expect(await adapter.get('SELECT 1 AS one')).toEqual({ one: 1 });
      await adapter.close();
    } finally {
      await pool.end();
    }
  });

  it('ends a pool it was told it owns, once, however often close() is called', async () => {
    const pool = new pg.Pool({ connectionString: url, max: 1 });
    const adapter = createPostgresAdapter({ pool, ownsPool: true });
    await adapter.get('SELECT 1 AS one');

    await adapter.close();
    await adapter.close();

    expect(pool.ended).toBe(true);
    await expect(adapter.open()).rejects.toThrow(/ended/);
  });

  it('closes without error a pool it owns that its caller has already ended', async () => {
    const pool = new pg.Pool({ connectionString: url, max: 1 });
    const adapter = createPostgresAdapter({ pool, ownsPool: true });
    await adapter.get('SELECT 1 AS one');

    await pool.end();

    await expect(adapter.close()).resolves.toBeUndefined();
    expect(pool.ended).toBe(true);
  });

  it('hands back its pool through getPool()', async () => {
    const pool = new pg.Pool({ connectionString: url, max: 1 });
    try {
      expect(new PostgresAdapter({ pool }).getPool()).toBe(pool);
    } finally {
      await pool.end();
    }

    const own = new PostgresAdapter({ connectionString: url, max: 1 });
    expect(own.getPool()).toBeNull();
    await own.open();
    const made = own.getPool();
    expect(made).not.toBeNull();
    expect((await made!.query('SELECT 4 AS four')).rows).toEqual([{ four: 4 }]);
    await own.close();
    expect(own.getPool()).toBeNull();
  });

  it("reports an error on an idle connection of its own pool to onError, and goes on", async () => {
    const applicationName = unique('adapter_on_error');
    const errors: Error[] = [];
    const adapter = createPostgresAdapter({
      connectionString: url,
      max: 1,
      application_name: applicationName,
      onError: (error) => errors.push(error),
    });
    await adapter.open();
    try {
      await adapter.get('SELECT 1 AS one');

      await terminate(applicationName);
      await until(() => errors.length > 0);

      expect(errors[0]).toBeInstanceOf(Error);
      expect(await adapter.get('SELECT 2 AS two')).toEqual({ two: 2 });
    } finally {
      await adapter.close();
    }
  });

  it('keeps the process up when an idle connection of its own pool fails and no onError was given', async () => {
    const applicationName = unique('adapter_default_listener');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const adapter = createPostgresAdapter({ connectionString: url, max: 1, application_name: applicationName });
    try {
      await adapter.open();
      await adapter.get('SELECT 1 AS one');

      // Without a listener, node-postgres's pool would raise this as an uncaught error and end the process.
      await terminate(applicationName);
      await until(() => warn.mock.calls.length > 0);

      expect(String(warn.mock.calls[0][0])).toContain('PostgreSQL');
      expect(await adapter.get('SELECT 2 AS two')).toEqual({ two: 2 });
    } finally {
      await adapter.close();
      warn.mockRestore();
    }
  });

  it('puts onError on a pool of its caller and takes it off again on close()', async () => {
    const pool = new pg.Pool({ connectionString: url, max: 1 });
    try {
      const before = pool.listenerCount('error');
      const adapter = createPostgresAdapter({ pool, onError: () => undefined });
      expect(pool.listenerCount('error')).toBe(before + 1);

      await adapter.close();
      expect(pool.listenerCount('error')).toBe(before);
    } finally {
      await pool.end();
    }
  });

  it("puts no listener of its own on a caller's pool when no onError is given", async () => {
    const pool = new pg.Pool({ connectionString: url, max: 1 });
    try {
      const before = pool.listenerCount('error');
      const adapter = createPostgresAdapter({ pool });

      expect(pool.listenerCount('error')).toBe(before);
      await adapter.close();
    } finally {
      await pool.end();
    }
  });

  it('refuses connection settings it cannot apply to a pool of its caller', async () => {
    const pool = new pg.Pool({ connectionString: url, max: 1 });
    try {
      expect(() => createPostgresAdapter({ pool, connectionString: url })).toThrow(/connectionString/);
      expect(() => createPostgresAdapter({ pool, max: 5, statement_timeout: 1000 })).toThrow(/max, statement_timeout/);
    } finally {
      await pool.end();
    }
  });

  it('chooses Postgres for createDatabase({ postgres: { pool } }) and leaves the pool open', async () => {
    const pool = new pg.Pool({ connectionString: url, max: 1 });
    try {
      const adapter = await createDatabase({ postgres: { pool } });
      expect(adapter.kind).toBe('postgres');
      expect(await adapter.get('SELECT 1 AS one')).toEqual({ one: 1 });

      await adapter.close();
      expect(pool.ended).toBe(false);
    } finally {
      await pool.end();
    }
  });

  // Hosts written against 0.6 hand the adapter their Pool by setting its pool
  // field, which is null until open(); the adapter then runs on that Pool and
  // ends it on close(). This keeps them working until they pass { pool }.
  it('keeps running on a Pool a 0.6 host wrote into its pool field, and ends it on close()', async () => {
    const adapter = createPostgresAdapter({ connectionString: url, max: 1 });
    const pool = new pg.Pool({ connectionString: url, max: 1 });

    expect(Reflect.get(adapter, 'pool')).toBeNull();
    expect(Reflect.set(adapter, 'pool', pool)).toBe(true);
    expect(await adapter.get('SELECT 1 AS one')).toEqual({ one: 1 });

    await adapter.close();
    expect(pool.ended).toBe(true);
  });
});
