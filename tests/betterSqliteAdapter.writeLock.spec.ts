import { describe, expect, it, afterEach } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StorageAdapter } from '../src/core/contracts';

// Two processes writing one SQLite file through the better-sqlite3 adapter, as
// two containers write one per-world memory file. A transaction that reads and
// then writes must not lose its write to the other process's transaction.
//
// With a deferred BEGIN both transactions start as readers. When the first
// commits a write, the second one's read snapshot is out of date and its write
// fails at once with SQLITE_BUSY_SNAPSHOT: SQLite does not call the busy handler
// for a read transaction that asks to become a write transaction
// (https://www.sqlite.org/rescode.html#busy_snapshot,
// https://www.sqlite.org/lang_transaction.html,
// https://www.sqlite.org/c3ref/busy_handler.html). BEGIN IMMEDIATE takes the
// write lock first, so the second transaction waits under the busy timeout,
// then reads the committed value and writes after it.

const require = createRequire(import.meta.url);

const betterSqliteAvailable = ((): boolean => {
  try {
    const dir = path.dirname(require.resolve('better-sqlite3'));
    return [
      path.join(dir, '..', 'build', 'Release', 'better_sqlite3.node'),
      path.join(dir, '..', 'build', 'better_sqlite3.node'),
      path.join(dir, '..', 'prebuilds'),
    ].some((p) => fs.existsSync(p));
  } catch {
    return false;
  }
})();

const viteNode = (): string => require.resolve('vite-node/vite-node.mjs');
const childScript = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'better-sqlite-writer-child.ts');

interface Writer {
  /** Resolves once the child printed a line starting with `prefix`; rejects after `ms`. */
  waitFor(prefix: string, ms: number): Promise<string>;
  send(line: string): void;
  exited: Promise<{ code: number | null; output: string }>;
  kill(): void;
}

const startWriter = (file: string): Writer => {
  const proc: ChildProcessWithoutNullStreams = spawn(process.execPath, [viteNode(), childScript], {
    env: { ...process.env, SQLITE_WRITER_FILE: file },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  const listeners = new Set<() => void>();
  const onData = (chunk: Buffer): void => {
    output += chunk.toString();
    for (const listener of [...listeners]) listener();
  };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  const exited = new Promise<{ code: number | null; output: string }>((resolve) => {
    proc.on('exit', (code) => resolve({ code, output }));
  });
  return {
    waitFor: (prefix, ms) =>
      new Promise((resolve, reject) => {
        const check = (): boolean => {
          const line = output.split('\n').find((l) => l.startsWith(prefix));
          if (line === undefined) return false;
          clearTimeout(timer);
          listeners.delete(onLine);
          resolve(line);
          return true;
        };
        const onLine = (): void => {
          check();
        };
        const timer = setTimeout(() => {
          listeners.delete(onLine);
          reject(new Error(`no "${prefix}" line within ${ms} ms; output so far:\n${output}`));
        }, ms);
        if (!check()) listeners.add(onLine);
      }),
    send: (line) => {
      proc.stdin.write(`${line}\n`);
    },
    exited,
    kill: () => {
      if (proc.exitCode === null) proc.kill('SIGKILL');
    },
  };
};

describe.skipIf(!betterSqliteAvailable)('BetterSqliteAdapter write transactions on a shared file', () => {
  const dirs: string[] = [];
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  const tempFile = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sql-adapter-write-lock-'));
    dirs.push(dir);
    return path.join(dir, 'memory.sqlite3');
  };

  const openCounters = async (secondTimeoutMs = 2_000, journalMode: 'WAL' | 'DELETE' = 'WAL') => {
    const { createBetterSqliteAdapter } = await import('../src/index.js');
    const file = tempFile();
    const first = createBetterSqliteAdapter(file, { busyTimeoutMs: 2_000 });
    const second = createBetterSqliteAdapter(file, { busyTimeoutMs: secondTimeoutMs });
    await first.open();
    cleanups.push(() => first.close());
    await first.exec(`
      PRAGMA journal_mode = ${journalMode};
      CREATE TABLE counter (id INTEGER PRIMARY KEY, n INTEGER NOT NULL);
      INSERT INTO counter (id, n) VALUES (1, 0);
    `);
    await second.open();
    cleanups.push(() => second.close());
    return { first, second };
  };

  const holdWriteLock = (adapter: StorageAdapter, ms: number) => {
    let begun!: () => void;
    const ready = new Promise<void>((resolve) => {
      begun = resolve;
    });
    const done = adapter.transaction(async (trx) => {
      begun();
      await new Promise((resolve) => setTimeout(resolve, ms));
      await trx.run('UPDATE counter SET n = n + 1 WHERE id = 1');
    });
    return { ready, done };
  };

  // Holds the write lock until release() is called. The holder commits in
  // microtasks after release(), before any timer of a statement waiting for it.
  const holdUntilReleased = (adapter: StorageAdapter) => {
    let begun!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      begun = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const done = adapter.transaction(async () => {
      begun();
      await released;
    });
    return { ready, release, done };
  };

  it('lets a second adapter\'s write outside a transaction wait without stopping the open transaction', async () => {
    const { first, second } = await openCounters();
    const { ready, done } = holdWriteLock(first, 200);
    await ready;

    try {
      await expect(second.run('UPDATE counter SET n = n + 10 WHERE id = 1')).resolves.toMatchObject({ changes: 1 });
    } finally {
      await done;
    }
    expect(await second.get('SELECT n FROM counter WHERE id = 1')).toEqual({ n: 11 });
    expect(await second.get('PRAGMA busy_timeout')).toEqual({ timeout: 2_000 });
  });

  it('fails a write outside a transaction with SQLITE_BUSY once the busy timeout passes, without holding the event loop', async () => {
    const { first, second } = await openCounters(300);
    const { ready, done } = holdWriteLock(first, 1_000);
    await ready;

    let ticks = 0;
    const interval = setInterval(() => { ticks += 1; }, 20);
    const started = performance.now();
    try {
      await expect(second.run('UPDATE counter SET n = n + 10 WHERE id = 1')).rejects.toMatchObject({ code: 'SQLITE_BUSY' });
      const elapsed = performance.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(275);
      expect(elapsed).toBeLessThan(1_000);
      expect(ticks).toBeGreaterThan(2);
      expect(await second.get('PRAGMA busy_timeout')).toEqual({ timeout: 300 });
    } finally {
      clearInterval(interval);
      await done;
    }
    expect(await second.get('SELECT n FROM counter WHERE id = 1')).toEqual({ n: 1 });
  });

  it.each(['get', 'all'] as const)('retries a write with RETURNING through %s outside a transaction', async (method) => {
    const { first, second } = await openCounters();
    const { ready, done } = holdWriteLock(first, 200);
    await ready;

    try {
      const row = { n: 11 };
      await expect(second[method]('UPDATE counter SET n = n + 10 WHERE id = 1 RETURNING n'))
        .resolves.toEqual(method === 'get' ? row : [row]);
    } finally {
      await done;
    }
  });

  it('retries get with RETURNING when a rollback-journal reader blocks the commit', async () => {
    const { first, second } = await openCounters(2_000, 'DELETE');
    let read!: () => void;
    const ready = new Promise<void>((resolve) => {
      read = resolve;
    });
    const done = first.transaction(async (trx) => {
      await trx.get('SELECT n FROM counter WHERE id = 1');
      read();
      await new Promise((resolve) => setTimeout(resolve, 200));
    }, { readOnly: true });
    await ready;

    try {
      await expect(second.get('UPDATE counter SET n = n + 10 WHERE id = 1 RETURNING n')).resolves.toEqual({ n: 10 });
    } finally {
      await done;
    }
    expect(await second.get('SELECT n FROM counter WHERE id = 1')).toEqual({ n: 10 });
  });

  it('retries an exec script when SQLITE_BUSY occurs before any changes', async () => {
    const { first, second } = await openCounters();
    const { ready, done } = holdWriteLock(first, 200);
    await ready;

    try {
      await second.exec('SELECT n FROM counter; UPDATE counter SET n = n + 10; UPDATE counter SET n = n + 100;');
    } finally {
      await done;
    }
    expect(await second.get('SELECT n FROM counter WHERE id = 1')).toEqual({ n: 111 });
  });

  it('runs the statements of an exec script once each when a later one waits after the temp database changed', async () => {
    const { first, second } = await openCounters();
    await second.exec('CREATE TEMP TABLE log (n INTEGER);');
    const { ready, done } = holdWriteLock(first, 200);
    await ready;

    try {
      await second.exec('INSERT INTO log (n) VALUES (1); UPDATE counter SET n = n + 10;');
    } finally {
      await done;
    }
    expect(await second.all('SELECT n FROM log')).toEqual([{ n: 1 }]);
    expect(await second.get('SELECT n FROM counter WHERE id = 1')).toEqual({ n: 11 });
  });

  it('runs the statements of an exec script once each when a later one waits after the schema changed', async () => {
    const { first, second } = await openCounters();
    const { ready, done } = holdWriteLock(first, 200);
    await ready;

    try {
      // Run again from the start, the CREATE would fail: the table exists.
      await second.exec('CREATE TEMP TABLE log (n INTEGER); UPDATE counter SET n = n + 10;');
    } finally {
      await done;
    }
    expect(await second.all('SELECT n FROM log')).toEqual([]);
    expect(await second.get('SELECT n FROM counter WHERE id = 1')).toEqual({ n: 11 });
  });

  it('waits for the lock at the BEGIN IMMEDIATE of an exec script', async () => {
    const { first, second } = await openCounters();
    const { ready, done } = holdWriteLock(first, 200);
    await ready;

    try {
      await second.exec('BEGIN IMMEDIATE; UPDATE counter SET n = n + 10 WHERE id = 1; COMMIT;');
    } finally {
      await done;
    }
    expect(await second.get('SELECT n FROM counter WHERE id = 1')).toEqual({ n: 11 });
  });

  it('waits on timers for a write in an exec script after a PRAGMA whose comment names the busy timeout', async () => {
    const { first, second } = await openCounters();
    const { ready, done } = holdWriteLock(first, 200);
    await ready;

    try {
      await second.exec('PRAGMA foreign_keys = ON /* not busy_timeout */; UPDATE counter SET n = n + 10 WHERE id = 1;');
    } finally {
      await done;
    }
    expect(await second.get('SELECT n FROM counter WHERE id = 1')).toEqual({ n: 11 });
    expect(await second.get('PRAGMA busy_timeout')).toEqual({ timeout: 2_000 });
  });

  it('runs a script that creates a trigger whole', async () => {
    const { second } = await openCounters();
    await second.exec(`
      CREATE TABLE event (id INTEGER PRIMARY KEY);
      CREATE TRIGGER event_count AFTER INSERT ON event BEGIN UPDATE counter SET n = n + 1 WHERE id = 1; END;
      INSERT INTO event DEFAULT VALUES;
    `);
    expect(await second.get('SELECT n FROM counter WHERE id = 1')).toEqual({ n: 1 });
  });

  it('runs one adapter\'s statements outside a transaction in the order issued while one waits for the lock', async () => {
    const { first, second } = await openCounters();
    const held = holdUntilReleased(first);
    await held.ready;

    const add = second.run('UPDATE counter SET n = n + 10 WHERE id = 1');
    held.release();
    await held.done;
    // The lock is free, and the first write still waits for its timer.
    const double = second.run('UPDATE counter SET n = n * 2 WHERE id = 1');
    const read = second.get('SELECT n FROM counter WHERE id = 1');

    await Promise.all([add, double]);
    await expect(read).resolves.toEqual({ n: 20 });
    expect(await second.get('SELECT n FROM counter WHERE id = 1')).toEqual({ n: 20 });
  });

  it('begins the adapter\'s own transaction after its earlier write that waits for the lock, and does not fail that write', async () => {
    const { first, second } = await openCounters(300);
    const held = holdUntilReleased(first);
    await held.ready;

    const add = second.run('UPDATE counter SET n = n + 10 WHERE id = 1');
    const seen = second.transaction(async (trx) => {
      const row = await trx.get('SELECT n FROM counter WHERE id = 1');
      // Longer than the busy timeout of the write issued before it.
      await new Promise((resolve) => setTimeout(resolve, 500));
      return row;
    });
    held.release();
    await held.done;

    await expect(add).resolves.toMatchObject({ changes: 1 });
    await expect(seen).resolves.toEqual({ n: 10 });
  });

  it('keeps a busy timeout set by SQL', async () => {
    const { second } = await openCounters();
    expect(await second.get('SELECT timeout FROM pragma_busy_timeout')).toEqual({ timeout: 2_000 });
    await second.exec('SELECT 1; PRAGMA /* timeout for the connection */ main."busy_timeout" = 0;');
    expect(await second.get('PRAGMA busy_timeout')).toEqual({ timeout: 0 });
    await second.get('; PRAGMA busy_timeout = 300');
    expect(await second.get('PRAGMA main.busy_timeout')).toEqual({ timeout: 300 });
  });

  it('keeps both writes when another process reads and writes the same row during an open transaction', async () => {
    const { createBetterSqliteAdapter } = await import('../src/index.js');
    const file = tempFile();
    const adapter = createBetterSqliteAdapter(file);
    await adapter.open();
    cleanups.push(() => adapter.close());
    await adapter.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE counter (id INTEGER PRIMARY KEY, n INTEGER NOT NULL);
      INSERT INTO counter (id, n) VALUES (1, 0);
    `);

    const writer = startWriter(file);
    cleanups.push(() => writer.kill());
    await writer.waitFor('ready', 30_000);

    await adapter.transaction(async (trx) => {
      const row = await trx.get<{ n: number }>('SELECT n FROM counter WHERE id = 1');
      writer.send('go');
      // With a deferred BEGIN the other process reads the same value now. With
      // BEGIN IMMEDIATE its transaction waits for this one's write lock and
      // reads nothing until this one commits.
      await writer.waitFor('read ', 1_500).catch(() => undefined);
      await trx.run('UPDATE counter SET n = ? WHERE id = 1', [Number(row?.n) + 1]);
    });
    writer.send('committed');

    const ended = await writer.exited;
    expect(ended.code, ended.output).toBe(0);
    expect(ended.output).toContain('read 1');
    expect(await adapter.get('SELECT n FROM counter WHERE id = 1')).toEqual({ n: 2 });
  }, 60_000);

  it('runs a transaction on a read-only connection', async () => {
    const { createBetterSqliteAdapter } = await import('../src/index.js');
    const file = tempFile();
    const writer = createBetterSqliteAdapter(file);
    await writer.open();
    await writer.exec('CREATE TABLE notes (body TEXT); INSERT INTO notes (body) VALUES (\'kept\');');
    await writer.close();

    const reader = createBetterSqliteAdapter(file);
    await reader.open({ readOnly: true });
    cleanups.push(() => reader.close());
    const rows = await reader.transaction((trx) => trx.all<{ body: string }>('SELECT body FROM notes'));
    expect(rows).toEqual([{ body: 'kept' }]);

    // A batch there begins too, and refuses its write as an operation's error,
    // not as a BEGIN that failed (index -1).
    const batch = await reader.batch!([{ statement: "INSERT INTO notes (body) VALUES ('refused')" }]);
    expect(batch.successful).toBe(0);
    expect(batch.errors?.map((e) => e.index)).toEqual([0]);
  });

  it('runs a transaction and a batch on a connection under PRAGMA query_only', async () => {
    const { createBetterSqliteAdapter } = await import('../src/index.js');
    const adapter = createBetterSqliteAdapter(tempFile());
    await adapter.open();
    cleanups.push(() => adapter.close());
    await adapter.exec("CREATE TABLE notes (body TEXT); INSERT INTO notes (body) VALUES ('kept'); PRAGMA query_only = ON;");

    // SQLite refuses BEGIN IMMEDIATE there with SQLITE_READONLY, as it refuses
    // any write; the transaction reads, as it does on a read-only connection.
    const rows = await adapter.transaction((trx) => trx.all<{ body: string }>('SELECT body FROM notes'));
    expect(rows).toEqual([{ body: 'kept' }]);

    const batch = await adapter.batch!([{ statement: "INSERT INTO notes (body) VALUES ('refused')" }]);
    expect(batch.successful).toBe(0);
    expect(batch.errors?.map((e) => e.index)).toEqual([0]);
  });

  it('lets another connection write while a transaction opened with readOnly reads', async () => {
    const { createBetterSqliteAdapter } = await import('../src/index.js');
    const file = tempFile();
    const reader = createBetterSqliteAdapter(file, { busyTimeoutMs: 2_000 });
    const writer = createBetterSqliteAdapter(file, { busyTimeoutMs: 250 });
    await reader.open();
    await writer.open();
    cleanups.push(() => reader.close(), () => writer.close());
    await reader.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE notes (body TEXT);
      INSERT INTO notes (body) VALUES ('kept');
    `);

    let read!: () => void;
    const hasRead = new Promise<void>((resolve) => {
      read = resolve;
    });
    const reading = (reader.transaction as (fn: (trx: StorageAdapter) => Promise<unknown>, options: unknown) => Promise<unknown>).call(
      reader,
      async (trx: StorageAdapter) => {
        const rows = await trx.all<{ body: string }>('SELECT body FROM notes');
        read();
        // A long read, as an export or a sync pull streaming to a slow reader is.
        await new Promise((resolve) => setTimeout(resolve, 300));
        return rows;
      },
      { readOnly: true },
    );
    await hasRead;

    // In WAL a reader holds no lock a writer needs. This write can finish
    // while the reader's callback still has its transaction open.
    await expect(writer.run("INSERT INTO notes (body) VALUES ('added')")).resolves.toMatchObject({ changes: 1 });
    expect(await reading).toEqual([{ body: 'kept' }]);
    expect(await writer.all('SELECT body FROM notes ORDER BY rowid')).toEqual([{ body: 'kept' }, { body: 'added' }]);
  }, 15_000);

  it('refuses a write in a transaction opened with readOnly, and leaves the connection as it was', async () => {
    const { createBetterSqliteAdapter } = await import('../src/index.js');
    const adapter = createBetterSqliteAdapter(tempFile());
    await adapter.open();
    cleanups.push(() => adapter.close());
    await adapter.exec('CREATE TABLE notes (body TEXT);');
    const readOnlyTransaction = (fn: (trx: StorageAdapter) => Promise<unknown>): Promise<unknown> =>
      (adapter.transaction as (fn: (trx: StorageAdapter) => Promise<unknown>, options: unknown) => Promise<unknown>).call(adapter, fn, { readOnly: true });

    // PostgreSQL refuses a write in a READ ONLY transaction; this adapter
    // refuses it too, rather than letting it fail later as a lost write.
    await expect(readOnlyTransaction((trx) => trx.run("INSERT INTO notes (body) VALUES ('refused')"))).rejects.toThrow(/readonly/i);
    await expect(adapter.run("INSERT INTO notes (body) VALUES ('kept')")).resolves.toMatchObject({ changes: 1 });
    expect(await adapter.all('SELECT body FROM notes')).toEqual([{ body: 'kept' }]);

    // A connection the caller set to query_only keeps the setting.
    await adapter.exec('PRAGMA query_only = ON;');
    expect(await readOnlyTransaction((trx) => trx.all('SELECT body FROM notes'))).toEqual([{ body: 'kept' }]);
    const row = await adapter.get<Record<string, number>>('PRAGMA query_only');
    expect(Object.values(row ?? {})).toEqual([1]);
  });

  it('lets a second adapter on the same file in this process wait for an open transaction without stopping it', async () => {
    const { createBetterSqliteAdapter } = await import('../src/index.js');
    const file = tempFile();
    const first = createBetterSqliteAdapter(file, { busyTimeoutMs: 2_000 });
    const second = createBetterSqliteAdapter(file, { busyTimeoutMs: 2_000 });
    await first.open();
    await second.open();
    cleanups.push(() => first.close(), () => second.close());
    await first.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE counter (id INTEGER PRIMARY KEY, n INTEGER NOT NULL);
      INSERT INTO counter (id, n) VALUES (1, 0);
    `);

    let begun!: () => void;
    const firstBegun = new Promise<void>((resolve) => {
      begun = resolve;
    });
    const firstDone = first.transaction(async (trx) => {
      begun();
      // Work outside the database: the callback needs the event loop to reach
      // its write and the COMMIT that lets the second adapter in.
      await new Promise((resolve) => setTimeout(resolve, 200));
      await trx.run('UPDATE counter SET n = n + 1 WHERE id = 1');
    });
    await firstBegun;

    // A wait in SQLite's busy handler would sleep the thread for the whole
    // busy timeout, so the first callback could not go on, and the second
    // adapter's transaction and batch would each fail with SQLITE_BUSY.
    const secondDone = second.transaction((trx) => trx.run('UPDATE counter SET n = n + 10 WHERE id = 1'));
    const batch = second.batch!([{ statement: 'UPDATE counter SET n = n + 100 WHERE id = 1' }]);

    await firstDone;
    await secondDone;
    expect(await batch).toMatchObject({ successful: 1, failed: 0 });
    expect(await second.get('SELECT n FROM counter WHERE id = 1')).toEqual({ n: 111 });
  }, 15_000);

  it('waits 5,000 ms for a locked file by default', async () => {
    const { createBetterSqliteAdapter } = await import('../src/index.js');
    const adapter = createBetterSqliteAdapter(tempFile());
    await adapter.open();
    cleanups.push(() => adapter.close());
    const row = await adapter.get<Record<string, number>>('PRAGMA busy_timeout');
    expect(Object.values(row ?? {})).toEqual([5000]);
  });

  it('takes the wait for a locked file from busyTimeoutMs', async () => {
    const { createBetterSqliteAdapter } = await import('../src/index.js');
    const adapter = createBetterSqliteAdapter(tempFile(), { busyTimeoutMs: 250 });
    await adapter.open();
    cleanups.push(() => adapter.close());
    const row = await adapter.get<Record<string, number>>('PRAGMA busy_timeout');
    expect(Object.values(row ?? {})).toEqual([250]);
  });
});
