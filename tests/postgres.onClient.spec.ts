import { describe, expect, it, afterAll, beforeAll } from 'vitest';
import pg from 'pg';
import { PostgresAdapter, createPostgresAdapter, type StorageAdapter } from '../src/index.js';

// onClient(client) runs the adapter's calls on a Postgres client the caller
// already holds, such as one inside a transaction an ORM opened over the same
// pool: the calls see the caller's uncommitted writes, take no connection of
// the pool, release nothing, and leave the transaction to the caller. The
// specs that need a server run when POSTGRES_TEST_URL names one (CI starts a
// Postgres service for them).

const POSTGRES_TEST_URL = process.env.POSTGRES_TEST_URL;

/** A Postgres URL nothing listens on. */
const UNREACHABLE_URL = 'postgresql://adapter:adapter@127.0.0.1:1/unreachable';

/** A name no other run of this suite uses. */
const unique = (prefix: string): string => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;

describe('PostgresAdapter.onClient() without a server', () => {
  it('runs on the client it is given and never on a pool, before the adapter opens', async () => {
    const sent: Array<{ text: string; values?: unknown[] }> = [];
    const client = {
      query: async (text: string, values?: unknown[]) => {
        sent.push({ text, values });
        return { rows: [{ id: 7, label: 'seven' }], rowCount: 1 };
      },
    };
    const bound = new PostgresAdapter(UNREACHABLE_URL).onClient(client);

    expect(await bound.get('SELECT id, label FROM t WHERE id = ?', [7])).toEqual({ id: 7, label: 'seven' });
    expect(sent).toEqual([{ text: 'SELECT id, label FROM t WHERE id = $1', values: [7] }]);
  });

  it('refuses transaction() and batch(), since the caller owns the transaction, and sends nothing', async () => {
    const sent: string[] = [];
    const bound = new PostgresAdapter(UNREACHABLE_URL).onClient({
      query: async (text: string) => {
        sent.push(text);
        return { rows: [] };
      },
    });

    await expect(bound.transaction(async () => 1)).rejects.toThrow(/caller/);
    await expect(bound.batch!([{ statement: 'SELECT 1' }])).rejects.toThrow(/caller/);
    expect(sent).toEqual([]);
    expect(bound.capabilities.has('transactions')).toBe(false);
    expect(bound.capabilities.has('batch')).toBe(false);
  });

  it('refuses a segmented adapter, whose statements would run outside the segment on a client it did not start', () => {
    const adapter = new PostgresAdapter({ connectionString: UNREACHABLE_URL, segment: 'agentos' });
    expect(() => adapter.onClient({ query: async () => ({ rows: [] }) })).toThrow(/segment/);
  });
});

describe.skipIf(!POSTGRES_TEST_URL)('PostgresAdapter.onClient() on a held client', () => {
  const url = POSTGRES_TEST_URL as string;
  let setup: StorageAdapter;
  const table = unique('on_client_spec');

  beforeAll(async () => {
    setup = createPostgresAdapter(url);
    await setup.open();
    await setup.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, label TEXT NOT NULL)`);
  });

  afterAll(async () => {
    await setup.exec(`DROP TABLE IF EXISTS ${table}`).catch(() => undefined);
    await setup.close();
  });

  it('reads a row the caller wrote in its own open transaction, on a pool of one held connection', async () => {
    // The ORM's pool, which the adapter runs on too: one connection, which the caller holds.
    const pool = new pg.Pool({ connectionString: url, max: 1 });
    const adapter = new PostgresAdapter({ pool });
    await adapter.open();
    const client = await pool.connect();
    let released = 0;
    const release = client.release.bind(client);
    client.release = (...args: Parameters<typeof client.release>) => {
      released += 1;
      return release(...args);
    };
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO ${table} (id, label) VALUES ($1, $2)`, [1, 'uncommitted']);

      const bound = adapter.onClient(client);
      expect(await bound.get(`SELECT id, label FROM ${table} WHERE id = ?`, [1])).toEqual({ id: 1, label: 'uncommitted' });
      await bound.run(`UPDATE ${table} SET label = ? WHERE id = ?`, ['through the adapter', 1]);
      expect(await bound.all(`SELECT label FROM ${table}`)).toEqual([{ label: 'through the adapter' }]);
      await bound.exec(`INSERT INTO ${table} (id, label) VALUES (2, 'two'); INSERT INTO ${table} (id, label) VALUES (3, 'three');`);

      // No second connection was taken or asked for, and the caller's one is still checked out.
      expect(adapter.getPoolStats()).toEqual({ total: 1, idle: 0, waiting: 0 });
      await bound.close();
      expect(released).toBe(0);
      expect(adapter.getPoolStats()).toEqual({ total: 1, idle: 0, waiting: 0 });

      // Another session does not see the writes, which are the caller's transaction's to commit or roll back.
      expect(await setup.all(`SELECT id FROM ${table}`)).toEqual([]);
      await client.query('ROLLBACK');
      expect(await bound.all(`SELECT id FROM ${table}`)).toEqual([]);
    } finally {
      client.release = release;
      client.release();
      await pool.end();
    }
  });

  it('commits with the caller: what the bound adapter wrote is there once the caller commits', async () => {
    const pool = new pg.Pool({ connectionString: url, max: 1 });
    const adapter = new PostgresAdapter({ pool });
    await adapter.open();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await adapter.onClient(client).run(`INSERT INTO ${table} (id, label) VALUES (?, ?)`, [10, 'committed']);
      await client.query('COMMIT');
    } finally {
      client.release();
      await pool.end();
    }
    expect(await setup.get(`SELECT label FROM ${table} WHERE id = ?`, [10])).toEqual({ label: 'committed' });
    await setup.run(`DELETE FROM ${table} WHERE id = ?`, [10]);
  });
});
