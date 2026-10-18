import { describe, expect, it, afterAll, beforeAll, vi } from 'vitest';
import { PostgresAdapter, createPostgresAdapter, type StorageAdapter } from '../src/index.js';

// When a transaction's connection breaks, transaction() keeps the callback's
// own error, puts the failed ROLLBACK's error beside it, and closes the broken
// connection instead of returning it to the pool. A connection the server
// closes while a callback holds it, between statements, does not end the
// process. A transaction's handle used after its transaction ended runs on the
// pool, not on a connection another caller may hold. These specs run when
// POSTGRES_TEST_URL names a server (CI starts a Postgres service for them).

const POSTGRES_TEST_URL = process.env.POSTGRES_TEST_URL;

/** A name no other run of this suite uses. */
const unique = (prefix: string): string => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;

describe.skipIf(!POSTGRES_TEST_URL)('PostgresAdapter when a transaction connection breaks', () => {
  const url = POSTGRES_TEST_URL as string;
  const opened: StorageAdapter[] = [];
  let other: StorageAdapter;
  const table = unique('transaction_errors');

  const openAdapter = async (max: number): Promise<PostgresAdapter> => {
    const adapter = new PostgresAdapter({ connectionString: url, max });
    await adapter.open();
    opened.push(adapter);
    return adapter;
  };

  const backendPid = async (db: StorageAdapter): Promise<number> =>
    (await db.get<{ pid: number }>('SELECT pg_backend_pid() AS pid'))!.pid;

  /** Ends a backend from another connection and waits until the server has let it go. */
  const terminate = async (pid: number): Promise<void> => {
    await other.get('SELECT pg_terminate_backend($1)', [pid]);
    const started = Date.now();
    while (Date.now() - started < 5_000) {
      const row = await other.get('SELECT 1 AS alive FROM pg_stat_activity WHERE pid = $1', [pid]);
      if (!row) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`backend ${pid} did not end`);
  };

  beforeAll(async () => {
    other = createPostgresAdapter(url);
    await other.open();
    await other.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, label TEXT NOT NULL)`);
  });

  afterAll(async () => {
    for (const adapter of opened.splice(0)) await adapter.close().catch(() => undefined);
    await other.exec(`DROP TABLE IF EXISTS ${table}`).catch(() => undefined);
    await other.close();
  });

  it('keeps the callback error when ROLLBACK fails, with the ROLLBACK error beside it, and closes the broken connection', async () => {
    const adapter = await openAdapter(1);
    const failure = new Error('the callback failed');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let pid = 0;

    try {
      const thrown = await adapter
        .transaction(async (trx) => {
          pid = await backendPid(trx);
          await terminate(pid);
          throw failure;
        })
        .catch((error: unknown) => error);

      expect(thrown).toBe(failure);
      expect((thrown as { rollbackError?: unknown }).rollbackError).toBeInstanceOf(Error);
      expect(warn.mock.calls.some((call) => String(call[0]).includes('ROLLBACK'))).toBe(true);
    } finally {
      warn.mockRestore();
    }

    // The pool replaced the broken connection.
    expect(await adapter.transaction((trx) => backendPid(trx))).not.toBe(pid);
    expect(adapter.getPoolStats()).toMatchObject({ total: 1 });
  });

  it('keeps the COMMIT error when the connection breaks before COMMIT, with the ROLLBACK error beside it', async () => {
    const adapter = await openAdapter(1);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const thrown = await adapter
        .transaction(async (trx) => {
          await trx.run(`INSERT INTO ${table} (id, label) VALUES (1, 'never committed')`);
          await terminate(await backendPid(trx));
        })
        .catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as { rollbackError?: unknown }).rollbackError).toBeInstanceOf(Error);
      expect((thrown as { rollbackError?: unknown }).rollbackError).not.toBe(thrown);
    } finally {
      vi.restoreAllMocks();
    }

    expect(await other.all(`SELECT id FROM ${table} WHERE id = 1`)).toEqual([]);
    expect(await adapter.get('SELECT 1 AS one')).toEqual({ one: 1 });
  });

  it('goes on when the server closes the connection a withConnection() callback holds, between statements', async () => {
    const adapter = await openAdapter(1);
    let pid = 0;

    const result = await adapter.withConnection(async (connection) => {
      pid = await backendPid(connection);
      await terminate(pid);
      // Let the client read the server's notice that the connection is closing.
      await new Promise((resolve) => setTimeout(resolve, 100));
      return 'done';
    });

    expect(result).toBe('done');
    expect(await adapter.withConnection((connection) => backendPid(connection))).not.toBe(pid);
  });

  it('runs a handle used after its transaction ended on the pool, not inside the transaction that holds its old connection', async () => {
    const adapter = await openAdapter(1);
    let stale!: StorageAdapter;
    await adapter.transaction(async (trx) => {
      stale = trx;
    });

    let late!: Promise<unknown>;
    await adapter
      .transaction(async (trx) => {
        // The pool's one connection is this transaction's: the old handle's
        // connection, now another caller's.
        await trx.run(`INSERT INTO ${table} (id, label) VALUES (10, 'rolled back')`);
        late = stale.run(`INSERT INTO ${table} (id, label) VALUES (11, 'late')`);
        await new Promise((resolve) => setTimeout(resolve, 100));
        throw new Error('roll this transaction back');
      })
      .catch(() => undefined);
    await late;

    expect(await other.all(`SELECT id FROM ${table} WHERE id IN (10, 11) ORDER BY id`)).toEqual([{ id: 11 }]);
  });

  it('opens a new transaction from a handle used after its transaction ended', async () => {
    const adapter = await openAdapter(2);
    let stale!: StorageAdapter;
    await adapter.transaction(async (trx) => {
      stale = trx;
    });

    await expect(
      stale.transaction(async (trx) => {
        await trx.run(`INSERT INTO ${table} (id, label) VALUES (20, 'rolled back')`);
        throw new Error('roll back');
      }),
    ).rejects.toThrow('roll back');

    expect(await other.all(`SELECT id FROM ${table} WHERE id = 20`)).toEqual([]);
  });

  it('rejects a transaction that PostgreSQL rolled back at its COMMIT, as a statement in it failed', async () => {
    // Each callback caught the duplicate's error and went on. PostgreSQL answers the COMMIT of an aborted
    // transaction with ROLLBACK and no error, so the transaction resolved with nothing written.
    const adapter = await openAdapter(1);
    await other.run(`INSERT INTO ${table} (id, label) VALUES (30, 'taken')`);
    const swallowing = async (trx: StorageAdapter, id: number): Promise<string> => {
      await trx.run(`INSERT INTO ${table} (id, label) VALUES ($1, 'first')`, [id]);
      await trx.run(`INSERT INTO ${table} (id, label) VALUES (30, 'again')`).catch(() => undefined);
      return 'committed';
    };

    const outcome = await adapter.transaction((trx) => swallowing(trx, 31)).catch((caught: unknown) => caught);
    expect(outcome).toBeInstanceOf(Error);
    expect(String((outcome as Error).message)).toMatch(/rolled back/i);

    const held = await adapter
      .withConnection((connection) => connection.transaction((trx) => swallowing(trx, 32)))
      .catch((caught: unknown) => caught);
    expect(held).toBeInstanceOf(Error);
    expect(String((held as Error).message)).toMatch(/rolled back/i);

    expect(await other.all(`SELECT id FROM ${table} WHERE id IN (31, 32)`)).toEqual([]);
    expect(await adapter.transaction(async (trx) => trx.get<{ one: number }>('SELECT 1 AS one'))).toEqual({ one: 1 });
  });
});
