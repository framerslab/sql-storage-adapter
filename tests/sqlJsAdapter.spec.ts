import { describe, expect, it, beforeEach, afterEach } from 'vitest';

describe('SqlJsAdapter', () => {
  let SqlJsAdapter: typeof import('../src/adapters/sqlJsAdapter.js').SqlJsAdapter;
  let adapter: InstanceType<typeof SqlJsAdapter>;

  beforeEach(async () => {
    const mod = await import('../src/adapters/sqlJsAdapter.js');
    SqlJsAdapter = mod.SqlJsAdapter;
    adapter = new SqlJsAdapter({ file: ':memory:' });
    await adapter.open();
  });

  afterEach(async () => {
    try {
      await adapter.close();
    } catch {
      /* already closed */
    }
  });

  it('creates tables and inserts rows', async () => {
    await adapter.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
    await adapter.run('INSERT INTO t (name) VALUES (?)', ['hello']);
    const rows = await adapter.all<{ id: number; name: string }>('SELECT * FROM t');
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('hello');
  });

  it('exec() handles multi-statement DDL', async () => {
    // This is the critical fix — exec() must run ALL statements, not just the first
    await adapter.exec(`
      CREATE TABLE IF NOT EXISTS table_a (id TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS table_b (id TEXT PRIMARY KEY, ref TEXT);
      CREATE TABLE IF NOT EXISTS table_c (
        id TEXT PRIMARY KEY,
        special_col TEXT,
        created_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_c_special ON table_c(special_col);
    `);

    // Verify all three tables exist
    const tables = await adapter.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    );
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain('table_a');
    expect(tableNames).toContain('table_b');
    expect(tableNames).toContain('table_c');

    // Verify the special_col column exists on table_c
    const cols = await adapter.all<{ name: string }>('PRAGMA table_info(table_c)');
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain('id');
    expect(colNames).toContain('special_col');
    expect(colNames).toContain('created_at');

    // Verify the index was created
    const indexes = await adapter.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='table_c'"
    );
    expect(indexes.some((idx) => idx.name === 'idx_c_special')).toBe(true);
  });

  it('exec() with many tables matches foundation DB pattern', async () => {
    // Simulates the wilds.ai foundation DB DDL pattern: 10+ tables in one exec()
    await adapter.exec(`
      CREATE TABLE IF NOT EXISTS companions (
        companion_id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        slug TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_companions_slug
        ON companions(account_id, slug);

      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        blueprint_id TEXT
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS blueprints (
        blueprint_id TEXT PRIMARY KEY,
        world_name TEXT,
        genres TEXT,
        visibility TEXT NOT NULL DEFAULT 'public'
      );

      CREATE TABLE IF NOT EXISTS guest_identities (
        guest_id TEXT PRIMARY KEY,
        ip_hash TEXT,
        created_at_ms INTEGER NOT NULL,
        last_seen_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_guest_ip ON guest_identities(ip_hash);

      CREATE TABLE IF NOT EXISTS usage_events (
        id TEXT PRIMARY KEY,
        actor_id TEXT NOT NULL,
        action TEXT NOT NULL
      );
    `);

    const tables = await adapter.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    );
    const names = tables.map((t) => t.name);
    expect(names).toContain('companions');
    expect(names).toContain('sessions');
    expect(names).toContain('messages');
    expect(names).toContain('blueprints');
    expect(names).toContain('guest_identities');
    expect(names).toContain('usage_events');

    // Verify ip_hash column exists (this was the original bug)
    const cols = await adapter.all<{ name: string }>('PRAGMA table_info(guest_identities)');
    expect(cols.map((c) => c.name)).toContain('ip_hash');

    // Verify we can query ip_hash without error
    const result = await adapter.all(
      'SELECT guest_id FROM guest_identities WHERE ip_hash = ?',
      ['abc']
    );
    expect(result).toHaveLength(0);
  });

  it('run() executes single statements', async () => {
    await adapter.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    const result = await adapter.run('INSERT INTO t (v) VALUES (?)', ['test']);
    expect(result.changes).toBe(1);
  });

  it('get() returns single row or undefined', async () => {
    await adapter.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    await adapter.run('INSERT INTO t (v) VALUES (?)', ['found']);

    const row = await adapter.get<{ v: string }>('SELECT v FROM t WHERE id = 1');
    expect(row?.v).toBe('found');

    const missing = await adapter.get('SELECT v FROM t WHERE id = 999');
    expect(missing).toBeFalsy();
  });

  it('transaction commits on success', async () => {
    await adapter.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');

    await adapter.transaction(async (trx) => {
      await trx.run('INSERT INTO t (v) VALUES (?)', ['a']);
      await trx.run('INSERT INTO t (v) VALUES (?)', ['b']);
    });

    const rows = await adapter.all('SELECT * FROM t');
    expect(rows).toHaveLength(2);
  });

  it('transaction rolls back on error', async () => {
    await adapter.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)');

    try {
      await adapter.transaction(async (trx) => {
        await trx.run('INSERT INTO t (v) VALUES (?)', ['ok']);
        throw new Error('deliberate failure');
      });
    } catch {
      /* expected */
    }

    const rows = await adapter.all('SELECT * FROM t');
    expect(rows).toHaveLength(0);
  });

  it('runs overlapping top-level transaction callbacks in FIFO order', async () => {
    await adapter.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)');

    let signalFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      signalFirstStarted = resolve;
    });
    let releaseFirst!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const callbackOrder: string[] = [];

    const first = adapter.transaction(async (trx) => {
      callbackOrder.push('first:start');
      signalFirstStarted();
      await trx.run('INSERT INTO t (v) VALUES (?)', ['first']);
      await firstCanFinish;
      callbackOrder.push('first:end');
    });

    await firstStarted;
    const second = adapter.transaction(async (trx) => {
      callbackOrder.push('second:start');
      await trx.run('INSERT INTO t (v) VALUES (?)', ['second']);
      callbackOrder.push('second:end');
    });

    await Promise.resolve();
    expect(callbackOrder).toEqual(['first:start']);

    releaseFirst();
    await Promise.all([first, second]);

    expect(callbackOrder).toEqual([
      'first:start',
      'first:end',
      'second:start',
      'second:end',
    ]);
    const rows = await adapter.all<{ v: string }>('SELECT v FROM t ORDER BY id');
    expect(rows.map((row) => row.v)).toEqual(['first', 'second']);
  });

  it('starts the next queued transaction after an overlapping callback rolls back', async () => {
    await adapter.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)');

    let signalFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      signalFirstStarted = resolve;
    });
    let releaseFirst!: () => void;
    const firstCanFail = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const firstResult = adapter
      .transaction(async (trx) => {
        signalFirstStarted();
        await trx.run('INSERT INTO t (v) VALUES (?)', ['rolled-back']);
        await firstCanFail;
        throw new Error('first transaction failed');
      })
      .then(
        () => null,
        (error: unknown) => error,
      );

    await firstStarted;
    const second = adapter.transaction(async (trx) => {
      await trx.run('INSERT INTO t (v) VALUES (?)', ['committed']);
    });

    releaseFirst();
    const [firstError] = await Promise.all([firstResult, second]);

    expect(firstError).toBeInstanceOf(Error);
    expect((firstError as Error).message).toBe('first transaction failed');
    const rows = await adapter.all<{ v: string }>('SELECT v FROM t ORDER BY id');
    expect(rows.map((row) => row.v)).toEqual(['committed']);
  });

  it('reuses the outer transaction for nested transaction callbacks', async () => {
    await adapter.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)');

    await expect(
      adapter.transaction(async (trx) => {
        await trx.run('INSERT INTO t (v) VALUES (?)', ['outer']);
        await trx.transaction(async (nestedTrx) => {
          await nestedTrx.run('INSERT INTO t (v) VALUES (?)', ['nested']);
          throw new Error('nested failure');
        });
      }),
    ).rejects.toThrow('nested failure');

    const rows = await adapter.all('SELECT * FROM t');
    expect(rows).toHaveLength(0);
  });

  it('close() prevents further operations', async () => {
    await adapter.close();
    await expect(adapter.all('SELECT 1')).rejects.toThrow();
  });
});

// Separate describe block — these tests use a FILE-BACKED adapter to
// exercise the `persistIfNeeded` path that the `:memory:` tests above
// can't reach. Bug fixed in this slice: `run()`'s unconditional
// persist-after-write called `db.export()` inside an open transaction,
// which silently committed (or rolled back) the partially-built tx
// before the matching adapter-level COMMIT / ROLLBACK fired. File-
// backed tests are required to reproduce because persistIfNeeded
// is a no-op when no filePath is set.
describe('SqlJsAdapter — file-backed transaction semantics', () => {
  let SqlJsAdapter: typeof import('../src/adapters/sqlJsAdapter.js').SqlJsAdapter;
  let adapter: InstanceType<typeof SqlJsAdapter>;
  let tmpFile: string;

  beforeEach(async () => {
    const { default: pathMod } = await import('node:path');
    const { default: osMod } = await import('node:os');
    tmpFile = pathMod.join(
      osMod.tmpdir(),
      `sqljs-adapter-tx-${process.pid}-${Math.random().toString(36).slice(2)}.sqlite`,
    );
    const mod = await import('../src/adapters/sqlJsAdapter.js');
    SqlJsAdapter = mod.SqlJsAdapter;
    adapter = new SqlJsAdapter();
    await adapter.open({ filePath: tmpFile });
    await adapter.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)');
  });

  afterEach(async () => {
    try { await adapter.close(); } catch { /* already closed */ }
    const { promises: fsp } = await import('node:fs');
    await fsp.rm(tmpFile, { force: true }).catch(() => {});
  });

  it('transaction(fn) rolls back inserts when fn throws (file-backed)', async () => {
    // Pre-fix: adapter.run() inside fn() persists each INSERT via
    // db.export(), which closes the tx at the SQLite level. The
    // matching ROLLBACK in the catch path fires against an already-
    // closed tx and is silently swallowed by the adapter's COMMIT-
    // failure tolerance. Net result: the row stays in-memory AND on
    // disk. This test asserts a real rollback semantic.
    try {
      await adapter.transaction(async (trx) => {
        await trx.run('INSERT INTO t (v) VALUES (?)', ['should-rollback']);
        throw new Error('boom');
      });
    } catch {
      /* expected */
    }
    const rows = await adapter.all('SELECT * FROM t');
    expect(rows).toHaveLength(0);
  });

  it('transaction(fn) commits and persists writes (file-backed)', async () => {
    await adapter.transaction(async (trx) => {
      await trx.run('INSERT INTO t (v) VALUES (?)', ['a']);
      await trx.run('INSERT INTO t (v) VALUES (?)', ['b']);
    });
    // Close + reopen to confirm the writes hit disk.
    await adapter.close();
    const reopen = new SqlJsAdapter();
    await reopen.open({ filePath: tmpFile });
    const rows = await reopen.all<{ v: string }>('SELECT v FROM t ORDER BY id');
    expect(rows.map((r) => r.v)).toEqual(['a', 'b']);
    await reopen.close();
  });

  it('manual BEGIN/COMMIT via adapter.run() commits + persists (staff-ticket usage)', async () => {
    // Mirrors how the wilds-ai staff-ticket-store wraps multi-writes.
    await adapter.run('BEGIN TRANSACTION');
    await adapter.run('INSERT INTO t (v) VALUES (?)', ['x']);
    await adapter.run('INSERT INTO t (v) VALUES (?)', ['y']);
    await adapter.run('COMMIT');
    // Reopen from disk to verify persistence.
    await adapter.close();
    const reopen = new SqlJsAdapter();
    await reopen.open({ filePath: tmpFile });
    const rows = await reopen.all<{ v: string }>('SELECT v FROM t ORDER BY id');
    expect(rows.map((r) => r.v)).toEqual(['x', 'y']);
    await reopen.close();
  });

  it('manual BEGIN/INSERT/ROLLBACK via adapter.run() leaves no rows behind', async () => {
    await adapter.run('BEGIN TRANSACTION');
    await adapter.run('INSERT INTO t (v) VALUES (?)', ['nope']);
    await adapter.run('ROLLBACK');
    await adapter.close();
    const reopen = new SqlJsAdapter();
    await reopen.open({ filePath: tmpFile });
    const rows = await reopen.all('SELECT * FROM t');
    expect(rows).toHaveLength(0);
    await reopen.close();
  });
});
