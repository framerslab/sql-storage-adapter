import { describe, expect, it, afterAll, beforeAll } from 'vitest';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PostgresAdapter, createPostgresAdapter, type StorageAdapter } from '../src/index.js';

// Pool control on the Postgres adapter: withConnection() holds one connection
// for a callback, getPoolStats() counts the pool, transaction() takes an
// isolation level, read-only and deferrable modes, and allowExitOnIdle lets
// Node exit while the pool is idle. The specs that need a server run when
// POSTGRES_TEST_URL names one (CI starts a Postgres service for them).

const POSTGRES_TEST_URL = process.env.POSTGRES_TEST_URL;

/** A Postgres URL nothing listens on. */
const UNREACHABLE_URL = 'postgresql://adapter:adapter@127.0.0.1:1/unreachable';

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

describe('PostgresAdapter pool control without a server', () => {
  it('reports no pool stats before open()', () => {
    expect(new PostgresAdapter({ connectionString: UNREACHABLE_URL }).getPoolStats()).toBeNull();
  });

  it('refuses withConnection() before open()', async () => {
    await expect(new PostgresAdapter(UNREACHABLE_URL).withConnection(async () => 1)).rejects.toThrow(/not opened/);
  });

  it('refuses an isolation level it does not know before it begins, so nothing reaches the SQL', async () => {
    const adapter = new PostgresAdapter(UNREACHABLE_URL);

    await expect(
      adapter.transaction(async () => 1, { isolationLevel: 'serializable; DROP TABLE users' as never }),
    ).rejects.toThrow(/isolation level/);
    await expect(adapter.transaction(async () => 1, { isolationLevel: 'constructor' as never })).rejects.toThrow(
      /isolation level/,
    );
  });
});

describe.skipIf(!POSTGRES_TEST_URL)('PostgresAdapter pool control', () => {
  const url = POSTGRES_TEST_URL as string;
  const opened: StorageAdapter[] = [];
  let other: StorageAdapter;
  const table = unique('connection_spec');

  /** An open adapter on a pool of `max` connections, closed after the suite. */
  const openAdapter = async (max: number): Promise<PostgresAdapter> => {
    const adapter = new PostgresAdapter({ connectionString: url, max });
    await adapter.open();
    opened.push(adapter);
    return adapter;
  };

  const backendPid = async (db: StorageAdapter): Promise<number> =>
    (await db.get<{ pid: number }>('SELECT pg_backend_pid() AS pid'))!.pid;

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

  describe('withConnection()', () => {
    it('runs every statement of its callback on one connection, which keeps session settings', async () => {
      const adapter = await openAdapter(4);

      const seen = await adapter.withConnection(async (connection) => {
        const first = await backendPid(connection);
        await connection.run(`SET application_name = 'with_connection_spec'`);
        const second = await backendPid(connection);
        const name = await connection.get<{ application_name: string }>('SHOW application_name');
        return { first, second, name: name?.application_name };
      });

      expect(seen.second).toBe(seen.first);
      expect(seen.name).toBe('with_connection_spec');
    });

    it('keeps a temporary table for the callback, which other connections do not see', async () => {
      const adapter = await openAdapter(2);
      const temp = unique('temp_rows');

      const rows = await adapter.withConnection(async (connection) => {
        await connection.exec(`CREATE TEMPORARY TABLE ${temp} (n INTEGER); INSERT INTO ${temp} (n) VALUES (1), (2);`);
        const seen = await connection.all<{ n: number }>(`SELECT n FROM ${temp} ORDER BY n`);
        await expect(other.all(`SELECT n FROM ${temp}`)).rejects.toMatchObject({ code: '42P01' });
        await connection.exec(`DROP TABLE ${temp}`);
        return seen;
      });

      expect(rows).toEqual([{ n: 1 }, { n: 2 }]);
    });

    it('holds a session advisory lock against other connections until the callback unlocks it', async () => {
      const adapter = await openAdapter(2);
      const key = Math.floor(Math.random() * 1_000_000_000);
      const tryLock = async (): Promise<boolean> => {
        const row = await other.get<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [key]);
        if (row?.locked) await other.get('SELECT pg_advisory_unlock($1)', [key]);
        return row?.locked === true;
      };

      const whileHeld = await adapter.withConnection(async (connection) => {
        await connection.get('SELECT pg_advisory_lock($1)', [key]);
        const held = await tryLock();
        await connection.get('SELECT pg_advisory_unlock($1)', [key]);
        return held;
      });

      expect(whileHeld).toBe(false);
      expect(await tryLock()).toBe(true);
    });

    it('returns the connection to the pool when the callback resolves', async () => {
      const adapter = await openAdapter(1);

      const first = await adapter.withConnection((connection) => backendPid(connection));
      const second = await adapter.withConnection((connection) => backendPid(connection));

      expect(second).toBe(first);
    });

    it('closes the connection when the callback throws, and rethrows the callback error itself', async () => {
      const adapter = await openAdapter(1);
      const failure = new Error('callback failed');
      let pid = 0;

      const thrown = await adapter
        .withConnection(async (connection) => {
          pid = await backendPid(connection);
          await connection.run(`SET application_name = 'left_behind'`);
          throw failure;
        })
        .catch((error: unknown) => error);

      expect(thrown).toBe(failure);
      const next = await adapter.withConnection((connection) => backendPid(connection));
      expect(next).not.toBe(pid);
      expect((await adapter.get<{ application_name: string }>('SHOW application_name'))?.application_name).not.toBe(
        'left_behind',
      );
    });

    // pg reports a connection's transaction status from 8.21 (getTransactionStatus).
    it.skipIf(typeof pg.Client.prototype.getTransactionStatus !== 'function')(
      'closes the connection and rejects when the callback returns inside a transaction it began, whose writes are rolled back',
      async () => {
        const adapter = await openAdapter(1);
        let pid = 0;

        await expect(
          adapter.withConnection(async (connection) => {
            pid = await backendPid(connection);
            await connection.run('BEGIN');
            await connection.run(`INSERT INTO ${table} (id, label) VALUES (1, 'open')`);
          }),
        ).rejects.toThrow(/open transaction/);

        expect(await other.all(`SELECT id FROM ${table} WHERE id = 1`)).toEqual([]);
        expect(await adapter.withConnection((connection) => backendPid(connection))).not.toBe(pid);
      },
    );

    it('runs transactions on its connection: commits, rolls back, and refuses one inside another', async () => {
      const adapter = await openAdapter(2);

      await adapter.withConnection(async (connection) => {
        const pid = await backendPid(connection);
        const inside = await connection.transaction(async (trx) => {
          await trx.run(`INSERT INTO ${table} (id, label) VALUES (2, 'committed')`);
          return backendPid(trx);
        });
        expect(inside).toBe(pid);

        await expect(
          connection.transaction(async (trx) => {
            await trx.run(`INSERT INTO ${table} (id, label) VALUES (3, 'rolled back')`);
            throw new Error('roll it back');
          }),
        ).rejects.toThrow('roll it back');

        await connection.transaction(async () => {
          await expect(connection.transaction(async () => undefined)).rejects.toThrow(/already open/);
        });
      });

      expect(await other.all(`SELECT id FROM ${table} WHERE id IN (2, 3) ORDER BY id`)).toEqual([{ id: 2 }]);
    });

    it('refuses statements on its connection after the callback has ended', async () => {
      const adapter = await openAdapter(1);

      const connection = await adapter.withConnection(async (held) => held);

      await expect(connection.get('SELECT 1 AS one')).rejects.toThrow(/withConnection/);
    });
  });

  describe('getPoolStats()', () => {
    it('counts the connections it holds, the idle ones and the callers waiting for one', async () => {
      const adapter = await openAdapter(1);
      expect(adapter.getPoolStats()).toEqual({ total: 1, idle: 1, waiting: 0 });

      let release!: () => void;
      const held = adapter.withConnection(() => new Promise<void>((resolve) => (release = resolve)));
      await until(() => adapter.getPoolStats()?.idle === 0);
      expect(adapter.getPoolStats()).toEqual({ total: 1, idle: 0, waiting: 0 });

      const queued = adapter.get('SELECT 1 AS one');
      await until(() => adapter.getPoolStats()?.waiting === 1);

      release();
      await held;
      expect(await queued).toEqual({ one: 1 });
      expect(adapter.getPoolStats()).toEqual({ total: 1, idle: 1, waiting: 0 });

      await adapter.close();
      expect(adapter.getPoolStats()).toBeNull();
    });
  });

  describe('transaction() options', () => {
    const setting = async (db: StorageAdapter, name: string): Promise<string> =>
      (await db.get<Record<string, string>>(`SHOW ${name}`))![name];

    it('begins at the isolation level it is given', async () => {
      const adapter = await openAdapter(2);

      expect(await adapter.transaction((trx) => setting(trx, 'transaction_isolation'))).toBe('read committed');
      for (const level of ['read uncommitted', 'read committed', 'repeatable read', 'serializable'] as const) {
        expect(await adapter.transaction((trx) => setting(trx, 'transaction_isolation'), { isolationLevel: level })).toBe(
          level,
        );
      }
    });

    it('begins read-only and deferrable when asked, and a read-only transaction refuses writes', async () => {
      const adapter = await openAdapter(2);

      const modes = await adapter.transaction(
        async (trx) => ({
          readOnly: await setting(trx, 'transaction_read_only'),
          deferrable: await setting(trx, 'transaction_deferrable'),
        }),
        { isolationLevel: 'serializable', readOnly: true, deferrable: true },
      );
      expect(modes).toEqual({ readOnly: 'on', deferrable: 'on' });

      const refused = await adapter
        .transaction((trx) => trx.run(`INSERT INTO ${table} (id, label) VALUES (4, 'read only')`), { readOnly: true })
        .catch((error: { code?: string }) => error);
      expect(refused).toMatchObject({ code: '25006' });
    });

    it('begins read-write when asked, over a session default of read-only', async () => {
      const adapter = await openAdapter(1);

      await adapter.withConnection(async (connection) => {
        await connection.run('SET default_transaction_read_only = on');
        await expect(
          connection.transaction((trx) => trx.run(`INSERT INTO ${table} (id, label) VALUES (5, 'default')`)),
        ).rejects.toMatchObject({ code: '25006' });
        await connection.transaction(
          (trx) => trx.run(`INSERT INTO ${table} (id, label) VALUES (5, 'read write')`),
          { readOnly: false, deferrable: false },
        );
        await connection.run('RESET default_transaction_read_only');
      });

      expect(await other.all(`SELECT label FROM ${table} WHERE id = 5`)).toEqual([{ label: 'read write' }]);
    });

    it('takes the same options on a held connection', async () => {
      const adapter = await openAdapter(1);

      const level = await adapter.withConnection((connection) =>
        connection.transaction((trx) => setting(trx, 'transaction_isolation'), { isolationLevel: 'repeatable read' }),
      );

      expect(level).toBe('repeatable read');
    });
  });

  describe('allowExitOnIdle', () => {
    const require = createRequire(import.meta.url);
    const viteNode = require.resolve('vite-node/vite-node.mjs');
    const child = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'postgres-idle-child.ts');

    /** Runs the child; resolves with how it ended, or 'running' once `waitMs` passed after its query. */
    const runChild = (allowExitOnIdle: boolean, waitMs: number): Promise<{ ended: 'exited' | 'running'; code: number | null; output: string }> =>
      new Promise((resolve, reject) => {
        const proc = spawn(process.execPath, [viteNode, child], {
          env: { ...process.env, ALLOW_EXIT_ON_IDLE: allowExitOnIdle ? '1' : '0' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        let timer: NodeJS.Timeout | undefined;
        const onData = (chunk: Buffer): void => {
          output += chunk.toString();
          if (!timer && output.includes('queried')) {
            timer = setTimeout(() => {
              proc.kill('SIGKILL');
              resolve({ ended: 'running', code: null, output });
            }, waitMs);
          }
        };
        proc.stdout.on('data', onData);
        proc.stderr.on('data', onData);
        proc.on('error', reject);
        proc.on('exit', (code) => {
          if (timer) clearTimeout(timer);
          resolve({ ended: 'exited', code, output });
        });
      });

    it('lets the process exit while the pool is idle and open', async () => {
      const result = await runChild(true, 8_000);

      expect(result.output).toContain('queried');
      expect(result).toMatchObject({ ended: 'exited', code: 0 });
    }, 30_000);

    it('without it, the idle connection keeps the process running', async () => {
      const result = await runChild(false, 3_000);

      expect(result.output).toContain('queried');
      expect(result.ended).toBe('running');
    }, 30_000);
  });
});
