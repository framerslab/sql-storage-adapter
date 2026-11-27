import { describe, expect, it, afterEach, vi } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BatchResult, StorageAdapter } from '../src/core/contracts';

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

const startWriter = (file: string, env: Record<string, string> = {}): Writer => {
  const proc: ChildProcessWithoutNullStreams = spawn(process.execPath, [viteNode(), childScript], {
    env: { ...process.env, SQLITE_WRITER_FILE: file, ...env },
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
    return { first, second, file };
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
    const held = holdUntilReleased(first);
    await held.ready;

    // The clock and the retry timers move only when the test moves them, and
    // the lock stays held throughout.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      let settled = false;
      const outcome = second.run('UPDATE counter SET n = n + 10 WHERE id = 1').then(
        () => { settled = true; return null; },
        (error: unknown) => { settled = true; return error; },
      );
      let otherTimerRan = false;
      setTimeout(() => { otherTimerRan = true; }, 100);

      // The tries at 0, 1, 3, 8, ... 228 ms all fail; the next is at 300 ms.
      await vi.advanceTimersByTimeAsync(299);
      expect(otherTimerRan).toBe(true);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await expect(outcome).resolves.toMatchObject({ code: 'SQLITE_BUSY' });
    } finally {
      vi.useRealTimers();
      held.release();
      await held.done;
    }
    expect(await second.get('PRAGMA busy_timeout')).toEqual({ timeout: 300 });
    expect(await second.get('SELECT n FROM counter WHERE id = 1')).toEqual({ n: 0 });
  });

  it.each(['get', 'all'] as const)('waits on timers for a write with RETURNING through %s outside a transaction', async (method) => {
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

  it('fails get with RETURNING and keeps nothing when a rollback-journal reader holds the commit past the busy timeout', async () => {
    const { first, second } = await openCounters(300, 'DELETE');
    let read!: () => void;
    const ready = new Promise<void>((resolve) => {
      read = resolve;
    });
    const done = first.transaction(async (trx) => {
      await trx.get('SELECT n FROM counter WHERE id = 1');
      read();
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }, { readOnly: true });
    await ready;

    try {
      // The write takes the lock and runs; its COMMIT waits for the reader in
      // SQLite's busy handler, which holds this thread, so the reader here
      // cannot end before the busy timeout runs out. No row of the write
      // SQLite rolled back comes back.
      await expect(second.get('UPDATE counter SET n = n + 10 WHERE id = 1 RETURNING n')).rejects.toMatchObject({ code: 'SQLITE_BUSY' });
    } finally {
      await done;
    }
    expect(await second.get('SELECT n FROM counter WHERE id = 1')).toEqual({ n: 0 });
  });

  it('calls a registered function in a write once when a rollback-journal reader in another process holds its commit', async () => {
    const { second, file } = await openCounters(5_000, 'DELETE');
    const reader = startWriter(file, { SQLITE_WRITER_READ_ONLY: '1', SQLITE_WRITER_COMMIT_AFTER_MS: '400' });
    cleanups.push(() => reader.kill());
    await reader.waitFor('ready', 30_000);
    let calls = 0;
    second.registerFunction!('bump', () => {
      calls += 1;
      return 1;
    });
    reader.send('go');
    // The other process holds a read from here and ends it by itself 400 ms on.
    await reader.waitFor('read ', 10_000);

    await expect(second.run('UPDATE counter SET n = n + bump() WHERE id = 1')).resolves.toMatchObject({ changes: 1 });
    expect(calls).toBe(1);
    const ended = await reader.exited;
    expect(ended.code, ended.output).toBe(0);
    expect(await second.get('SELECT n FROM counter WHERE id = 1')).toEqual({ n: 1 });
  }, 60_000);

  it('waits on timers for an exec script of one write, then runs it once', async () => {
    const { first, second } = await openCounters();
    const { ready, done } = holdWriteLock(first, 200);
    await ready;

    try {
      await second.exec('UPDATE counter SET n = n + 10 WHERE id = 1;');
    } finally {
      await done;
    }
    expect(await second.get('SELECT n FROM counter WHERE id = 1')).toEqual({ n: 11 });
  });

  it('runs a script or a statement that begins its own transaction as SQLite runs it', async () => {
    const { second } = await openCounters();

    // Inside a transaction the adapter began, this BEGIN would fail.
    await second.exec('BEGIN IMMEDIATE; UPDATE counter SET n = n + 10 WHERE id = 1; COMMIT;');
    await second.run('/* opened by the caller */ ; BEGIN IMMEDIATE');
    await second.run('UPDATE counter SET n = n + 10 WHERE id = 1');
    await second.run('COMMIT');
    expect(await second.get('SELECT n FROM counter WHERE id = 1')).toEqual({ n: 20 });
  });

  it('runs a script with a PRAGMA as SQLite runs it, outside a transaction', async () => {
    const { second } = await openCounters();

    // Inside a transaction SQLite would leave foreign keys as they were.
    await second.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE parent (id INTEGER PRIMARY KEY);
      CREATE TABLE child (parent_id INTEGER REFERENCES parent (id));
    `);
    expect(await second.get('PRAGMA foreign_keys')).toEqual({ foreign_keys: 1 });
    await expect(second.run('INSERT INTO child (parent_id) VALUES (7)')).rejects.toThrow(/FOREIGN KEY constraint failed/);
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

    try {
      await expect(add).resolves.toMatchObject({ changes: 1 });
      await expect(seen).resolves.toEqual({ n: 10 });
    } finally {
      // The transaction ends before the adapters close.
      await seen.catch(() => undefined);
    }
  });

  it.each(['transaction', 'batch'] as const)('runs a %s issued while a write waits for the lock before the statements issued after it', async (kind) => {
    const { first, second } = await openCounters();
    const held = holdUntilReleased(first);
    await held.ready;

    const add = second.run('UPDATE counter SET n = n + 10 WHERE id = 1');
    const double = 'UPDATE counter SET n = n * 2 WHERE id = 1';
    const doubled = kind === 'transaction'
      ? second.transaction((trx) => trx.run(double))
      : second.batch!([{ statement: double }]);
    // Issued in the same turn as the transaction or batch, after it.
    const read = second.get('SELECT n FROM counter WHERE id = 1');
    const addOne = second.run('UPDATE counter SET n = n + 1 WHERE id = 1');
    held.release();
    await held.done;

    await Promise.all([add, doubled, addOne]);
    await expect(read).resolves.toEqual({ n: 20 });
    expect(await second.get('SELECT n FROM counter WHERE id = 1')).toEqual({ n: 21 });
  });

  it('waits on timers for a write whose comment names the busy timeout', async () => {
    const { first, second } = await openCounters();
    const { ready, done } = holdWriteLock(first, 200);
    await ready;

    try {
      await expect(second.run('UPDATE counter /* not PRAGMA busy_timeout */ SET n = n + 10 WHERE id = 1'))
        .resolves.toMatchObject({ changes: 1 });
    } finally {
      await done;
    }
    expect(await second.get('SELECT n FROM counter WHERE id = 1')).toEqual({ n: 11 });
  });

  it('stores the busy timeout as set when a write reads it through a view', async () => {
    const { second } = await openCounters();
    await second.exec(`
      CREATE TABLE settings_log (timeout INTEGER);
      CREATE VIEW live_settings AS SELECT timeout FROM pragma_busy_timeout;
    `);

    await second.run('INSERT INTO settings_log SELECT timeout FROM live_settings');
    expect(await second.all('SELECT timeout FROM settings_log')).toEqual([{ timeout: 2_000 }]);
    expect(await second.get('SELECT timeout FROM live_settings')).toEqual({ timeout: 2_000 });
  });

  it('stores the busy timeout as set when a write reads it through a view another connection created', async () => {
    const { first, second } = await openCounters();
    await second.exec('CREATE TABLE settings_log (timeout INTEGER);');
    // This adapter has written since it opened, before the view existed.
    await second.run('UPDATE counter SET n = n WHERE id = 1');
    await first.exec('CREATE VIEW live_settings AS SELECT timeout FROM pragma_busy_timeout;');

    await second.run('INSERT INTO settings_log SELECT timeout FROM live_settings');
    expect(await second.all('SELECT timeout FROM settings_log')).toEqual([{ timeout: 2_000 }]);
  });

  it('waits on timers for a write after a view that read the busy timeout is dropped', async () => {
    const { first, second } = await openCounters();
    await second.exec('CREATE VIEW live_settings AS SELECT timeout FROM pragma_busy_timeout;');
    await second.run('UPDATE counter SET n = n WHERE id = 1');
    await second.exec('DROP VIEW live_settings;');
    const { ready, done } = holdWriteLock(first, 200);
    await ready;

    try {
      await expect(second.run('UPDATE counter SET n = n + 10 WHERE id = 1')).resolves.toMatchObject({ changes: 1 });
    } finally {
      await done;
    }
    expect(await second.get('SELECT n FROM counter WHERE id = 1')).toEqual({ n: 11 });
  });

  it('runs statements issued while a caller\'s own BEGIN is open in the order issued, one a function issued among them', async () => {
    const { first, second } = await openCounters();
    let deferred: Promise<unknown> | undefined;
    second.registerFunction!('defer_write', () => {
      queueMicrotask(() => {
        deferred = second.run('UPDATE counter SET n = 2 WHERE id = 1');
      });
      return null;
    });
    const held = holdUntilReleased(first);
    await held.ready;

    const waiting = second.run('UPDATE counter SET n = n + 10 WHERE id = 1');
    const begun = second.exec('BEGIN; SELECT defer_write();');
    const one = second.run('UPDATE counter SET n = 1 WHERE id = 1');
    held.release();
    await held.done;

    await Promise.all([waiting, begun, one]);
    await deferred;
    await second.exec('COMMIT');
    // The function's write was issued after `one`, so it runs after it.
    expect(await second.get('SELECT n FROM counter WHERE id = 1')).toEqual({ n: 2 });
  });

  it('ends an exec script at an embedded NUL character, as better-sqlite3 does', async () => {
    const { second } = await openCounters();
    await second.exec('CREATE TABLE seen (n INTEGER);');

    await second.exec('INSERT INTO seen (n) VALUES (1);\u0000;INSERT INTO seen (n) VALUES (2);');
    expect(await second.all('SELECT n FROM seen')).toEqual([{ n: 1 }]);
  });

  it('runs an exec script that ends in a comment left open', async () => {
    const { second } = await openCounters();
    await second.exec('CREATE TABLE seen (n INTEGER);');

    await second.exec('INSERT INTO seen (n) VALUES (1); /* ');
    expect(await second.all('SELECT n FROM seen')).toEqual([{ n: 1 }]);
  });

  it('keeps what a failed write outside a transaction did before it failed, as autocommit does', async () => {
    const { first, second } = await openCounters();
    await second.exec('CREATE TABLE tag (name TEXT PRIMARY KEY);');

    await expect(second.exec("INSERT INTO tag (name) VALUES ('a'); INSERT INTO tag (name) VALUES ('a');"))
      .rejects.toThrow(/UNIQUE constraint failed/);
    await expect(second.run("INSERT OR FAIL INTO tag (name) SELECT column1 FROM (VALUES ('b'), ('a'), ('c'))"))
      .rejects.toThrow(/UNIQUE constraint failed/);
    // Committed: the other connection reads them, and the next write commits on its own.
    expect(await first.all('SELECT name FROM tag ORDER BY name')).toEqual([{ name: 'a' }, { name: 'b' }]);
    await second.run("INSERT INTO tag (name) VALUES ('d')");
    expect(await first.all('SELECT name FROM tag ORDER BY name')).toEqual([{ name: 'a' }, { name: 'b' }, { name: 'd' }]);
  });

  it('runs an exec script of one read without taking the write lock', async () => {
    const { first, second } = await openCounters(300);
    const { ready, done } = holdWriteLock(first, 1_000);
    await ready;

    try {
      const started = performance.now();
      await second.exec('SELECT n FROM counter WHERE id = 1;');
      expect(performance.now() - started).toBeLessThan(250);
    } finally {
      await done;
    }
  });

  it('writes main at once while another connection holds an attached database\'s exclusive lock', async () => {
    const { createBetterSqliteAdapter } = await import('../src/index.js');
    const { second } = await openCounters(300);
    const auxFile = tempFile();
    const aux = createBetterSqliteAdapter(auxFile);
    await aux.open();
    cleanups.push(() => aux.close());
    await aux.exec('CREATE TABLE note (body TEXT);');
    await second.exec(`ATTACH DATABASE '${auxFile}' AS aux;`);
    expect(await second.all('SELECT name FROM aux.sqlite_master')).toEqual([{ name: 'note' }]);

    // In rollback-journal mode an exclusive lock keeps other connections from reading the file too.
    await aux.exec('BEGIN EXCLUSIVE;');
    try {
      expect(await second.get('PRAGMA busy_timeout')).toEqual({ timeout: 300 });
      const started = performance.now();
      await expect(second.run('UPDATE counter SET n = n + 10 WHERE id = 1')).resolves.toMatchObject({ changes: 1 });
      expect(performance.now() - started).toBeLessThan(250);
    } finally {
      await aux.exec('COMMIT;');
    }
    expect(await second.get('SELECT n FROM counter WHERE id = 1')).toEqual({ n: 10 });
  });

  it.each(['transaction', 'batch'] as const)('refuses a %s queued behind an open transaction once the adapter has closed, whatever file it opened since', async (kind) => {
    const { createBetterSqliteAdapter } = await import('../src/index.js');
    const { second } = await openCounters();
    const other = tempFile();
    const setup = createBetterSqliteAdapter(other);
    await setup.open();
    await setup.exec('CREATE TABLE counter (id INTEGER PRIMARY KEY, n INTEGER NOT NULL); INSERT INTO counter (id, n) VALUES (1, 0);');
    await setup.close();

    const held = holdUntilReleased(second);
    await held.ready;
    const add = 'UPDATE counter SET n = n + 100 WHERE id = 1';
    const queued = kind === 'transaction' ? second.transaction((trx) => trx.run(add)) : second.batch!([{ statement: add }]);
    const outcomes = Promise.allSettled([held.done, queued]);
    await second.close();
    await second.open({ filePath: other });
    held.release();

    const [, later] = await outcomes;
    expect(later.status).toBe('rejected');
    // The connection is to the other file now, which the work was not issued on.
    expect(await second.get('SELECT n FROM counter WHERE id = 1')).toEqual({ n: 0 });
  });

  it('runs a write once, after it waited for the lock, when a registered function in it throws an error that carries the code SQLITE_BUSY', async () => {
    const { first, second } = await openCounters();
    let calls = 0;
    second.registerFunction!('refuse', () => {
      calls += 1;
      throw Object.assign(new Error('the upstream is busy'), { code: 'SQLITE_BUSY' });
    });
    const held = holdUntilReleased(first);
    await held.ready;
    // The write's first try for the lock fails; the holder commits when the
    // write sets its first retry timer.
    const setTimer = globalThis.setTimeout;
    let waited = false;
    const timers = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: () => void, ms?: number) => {
      if (ms === 1 && !waited) {
        waited = true;
        held.release();
      }
      return setTimer(handler, ms);
    }) as typeof setTimeout);

    try {
      await expect(second.run('UPDATE counter SET n = refuse() WHERE id = 1')).rejects.toThrow('the upstream is busy');
    } finally {
      timers.mockRestore();
      held.release();
      await held.done;
    }
    expect(waited).toBe(true);
    expect(calls).toBe(1);
    expect(await second.get('SELECT n FROM counter WHERE id = 1')).toEqual({ n: 0 });
  });

  it('binds the values a write was issued with when it runs after waiting for the lock', async () => {
    const { first, second } = await openCounters();
    await second.exec('CREATE TABLE notes (body TEXT, bytes BLOB);');
    const held = holdUntilReleased(first);
    await held.ready;

    const waitedValues: unknown[] = ['waited', Buffer.from('waited')];
    const waited = second.run('INSERT INTO notes (body, bytes) VALUES (?, ?)', waitedValues);
    const queuedValues = { body: 'queued', bytes: Buffer.from('queued') };
    const queued = second.run('INSERT INTO notes (body, bytes) VALUES (@body, @bytes)', queuedValues);
    // The caller uses its array, its object and its buffers again while the writes wait.
    (waitedValues[1] as Buffer).write('reused');
    waitedValues[0] = 'reused';
    queuedValues.bytes.write('reused');
    queuedValues.body = 'reused';
    held.release();
    await held.done;

    await Promise.all([waited, queued]);
    expect(await second.all('SELECT body, CAST(bytes AS TEXT) AS bytes FROM notes ORDER BY rowid')).toEqual([
      { body: 'waited', bytes: 'waited' },
      { body: 'queued', bytes: 'queued' },
    ]);
  });

  it.each([
    ['a no-break space', String.fromCharCode(0xa0)],
    ['a byte-order mark', String.fromCharCode(0xfeff)],
  ])('hands a name that ends in %s to SQLite as written in an exec script', async (_what, last) => {
    const { second } = await openCounters();
    await second.exec(`CREATE TABLE ledger (n INTEGER); CREATE TABLE "ledger${last}" (n INTEGER);`);

    // SQLite reads the character as part of the name: this drops the second table.
    await second.exec(`DROP TABLE ledger${last};`);
    expect(await second.all("SELECT name FROM sqlite_master WHERE name LIKE 'ledger%'")).toEqual([{ name: 'ledger' }]);
  });

  it('waits in an exec script for a WAL checkpoint that another process\'s write transaction holds off', async () => {
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

    const writer = startWriter(file, { SQLITE_WRITER_COMMIT_AFTER_MS: '500' });
    cleanups.push(() => writer.kill());
    await writer.waitFor('ready', 30_000);
    writer.send('go');
    // The other process holds the write lock from here and commits by itself 500 ms on.
    await writer.waitFor('read ', 10_000);

    // With the busy timeout at 0 SQLite answers this in a row (busy = 1) and
    // leaves the log as it is, and exec() has no row to read.
    await adapter.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    expect(fs.statSync(`${file}-wal`).size).toBe(0);

    const ended = await writer.exited;
    expect(ended.code, ended.output).toBe(0);
    expect(await adapter.get('SELECT n FROM counter WHERE id = 1')).toEqual({ n: 1 });
  }, 60_000);

  it('tries a waiting write again when its retry timer fires after the busy timeout has passed', async () => {
    const { first, second } = await openCounters(300);
    const held = holdUntilReleased(first);
    await held.ready;

    const add = second.run('UPDATE counter SET n = n + 10 WHERE id = 1');
    held.release();
    await held.done;
    // The lock is free. The thread is busy past the write's busy timeout, so
    // its first retry timer fires late.
    const until = performance.now() + 400;
    while (performance.now() < until) {
      // Busy on purpose.
    }

    await expect(add).resolves.toMatchObject({ changes: 1 });
    expect(await second.get('SELECT n FROM counter WHERE id = 1')).toEqual({ n: 10 });
  });

  it('refuses a write queued behind a waiting write once the adapter has closed, whatever file it opened since', async () => {
    const { createBetterSqliteAdapter } = await import('../src/index.js');
    const { first, second } = await openCounters(5_000);
    const other = tempFile();
    const setup = createBetterSqliteAdapter(other);
    await setup.open();
    await setup.exec('CREATE TABLE counter (id INTEGER PRIMARY KEY, n INTEGER NOT NULL); INSERT INTO counter (id, n) VALUES (1, 0);');
    await setup.close();

    const held = holdUntilReleased(first);
    await held.ready;
    // Resolves when the waiting write sets a 100 ms retry timer: nothing of it
    // runs for that long, which leaves time to close and open.
    const setTimer = globalThis.setTimeout;
    let longWait!: () => void;
    const waitsLong = new Promise<void>((resolve) => {
      longWait = resolve;
    });
    const timers = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: () => void, ms?: number) => {
      if (ms === 100) longWait();
      return setTimer(handler, ms);
    }) as typeof setTimeout);

    try {
      const waiting = second.run('UPDATE counter SET n = n + 10 WHERE id = 1');
      const queued = second.run('UPDATE counter SET n = n + 100 WHERE id = 1');
      const outcomes = Promise.allSettled([waiting, queued]);
      await waitsLong;
      await second.close();
      await second.open({ filePath: other });

      const [waited, later] = await outcomes;
      expect(waited.status).toBe('rejected');
      expect(later.status).toBe('rejected');
      // The connection is to the other file now, which neither write was issued on.
      expect(await second.get('SELECT n FROM counter WHERE id = 1')).toEqual({ n: 0 });
    } finally {
      timers.mockRestore();
      held.release();
      await held.done;
    }
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

  it('runs each statement of an exec script of more than one in its own autocommit, as SQLite runs it', async () => {
    const { second } = await openCounters();
    await second.exec('PRAGMA foreign_keys = ON;');
    await second.exec(`
      CREATE TABLE parent (id INTEGER PRIMARY KEY);
      CREATE TABLE child (parent_id INTEGER REFERENCES parent (id) DEFERRABLE INITIALLY DEFERRED);
      CREATE TABLE entry (x INTEGER);
      CREATE TRIGGER entry_block BEFORE INSERT ON entry WHEN NEW.x = 2 BEGIN SELECT RAISE(ROLLBACK, 'blocked'); END;
    `);

    // The first INSERT commits on its own and fails its deferred foreign key;
    // the second never runs.
    await expect(second.exec('INSERT INTO child (parent_id) VALUES (7); INSERT INTO parent (id) VALUES (7);'))
      .rejects.toThrow(/FOREIGN KEY constraint failed/);
    expect(await second.all('SELECT parent_id FROM child')).toEqual([]);
    expect(await second.all('SELECT id FROM parent')).toEqual([]);

    // The first INSERT has committed when the second one's trigger rolls back.
    await expect(second.exec('INSERT INTO entry (x) VALUES (1); INSERT INTO entry (x) VALUES (2);')).rejects.toThrow('blocked');
    expect(await second.all('SELECT x FROM entry')).toEqual([{ x: 1 }]);
  });

  it('runs a batch through the handle of an ended transaction after the transaction open now, not in it', async () => {
    const { second } = await openCounters();
    await second.exec('CREATE TABLE seen (n INTEGER);');
    let ended: StorageAdapter | undefined;
    await second.transaction(async (trx) => {
      ended = trx;
    });

    let pending: Promise<BatchResult> | undefined;
    await expect(second.transaction(async () => {
      pending = ended!.batch!([{ statement: 'INSERT INTO seen (n) VALUES (1)' }]);
      throw new Error('undone');
    })).rejects.toThrow('undone');

    await expect(pending).resolves.toMatchObject({ successful: 1, failed: 0 });
    expect(await second.all('SELECT n FROM seen')).toEqual([{ n: 1 }]);
  });

  it('throws the COMMIT\'s error when a failed write cannot commit', async () => {
    const { first, second } = await openCounters(300, 'DELETE');
    await second.exec('CREATE TABLE entry (id INTEGER PRIMARY KEY); INSERT INTO entry (id) VALUES (2);');
    let read!: () => void;
    const reading = new Promise<void>((resolve) => {
      read = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const done = first.transaction(async (trx) => {
      await trx.get('SELECT id FROM entry');
      read();
      await released;
    }, { readOnly: true });
    await reading;

    try {
      // Row 1 goes in and row 2 fails, which OR FAIL keeps row 1 through; the
      // COMMIT then waits out the busy timeout for the reader and fails.
      await expect(second.run('INSERT OR FAIL INTO entry (id) VALUES (1), (2)')).rejects.toMatchObject({ code: 'SQLITE_BUSY' });
    } finally {
      release();
      await done;
    }
    expect(await second.all('SELECT id FROM entry ORDER BY id')).toEqual([{ id: 2 }]);
  });

  it.each([
    ['a write its first keyword names', 'INSERT INTO counter (id, n) VALUES (2, 0)'],
    ['a write that begins with WITH', 'WITH v (id) AS (VALUES (2)) INSERT INTO counter (id, n) SELECT id, 0 FROM v'],
  ])('waits on timers before it prepares %s while another connection holds the exclusive lock', async (_what, write) => {
    const { createBetterSqliteAdapter } = await import('../src/index.js');
    const { first, file } = await openCounters(2_000, 'DELETE');
    // A connection that has not read the schema: preparing a statement reads
    // it, which the exclusive lock holds off.
    const fresh = createBetterSqliteAdapter(file, { busyTimeoutMs: 1_000 });
    await fresh.open();
    cleanups.push(() => fresh.close());
    await first.exec('BEGIN EXCLUSIVE;');

    // The holder commits when the write sets its first retry timer.
    let committed: Promise<void> | undefined;
    const setTimer = globalThis.setTimeout;
    const timers = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: () => void, ms?: number) => {
      if (ms === 1 && !committed) committed = first.exec('COMMIT;');
      return setTimer(handler, ms);
    }) as typeof setTimeout);
    try {
      await expect(fresh.run(write)).resolves.toMatchObject({ changes: 1 });
    } finally {
      timers.mockRestore();
      await (committed ?? first.exec('COMMIT;'));
    }
    expect(await fresh.get('SELECT COUNT(*) AS rows FROM counter')).toEqual({ rows: 2 });
  });

  it('leaves the adapter as it was when close() is refused', async () => {
    const { second } = await openCounters();
    let refusal: unknown;
    second.registerFunction!('close_now', () => {
      // better-sqlite3 refuses to close a connection while it runs a statement.
      second.close().catch((error: unknown) => {
        refusal = error;
      });
      return 1;
    });
    let tried!: () => void;
    const closeTried = new Promise<void>((resolve) => {
      tried = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });

    const outer = second.transaction(async (trx) => {
      await trx.get('SELECT close_now() AS value');
      tried();
      await released;
      await trx.run('UPDATE counter SET n = n + 1 WHERE id = 1');
    });
    await closeTried;
    // Issued outside the open transaction: it waits for that one to end.
    const later = second.transaction((trx) => trx.run('UPDATE counter SET n = n * 10 WHERE id = 1'));
    release();

    const [outerOutcome, laterOutcome] = await Promise.allSettled([outer, later]);
    expect(outerOutcome.status).toBe('fulfilled');
    expect(laterOutcome).toMatchObject({ status: 'fulfilled', value: { changes: 1 } });
    expect(refusal).toBeInstanceOf(Error);
    expect(await second.get('SELECT n FROM counter WHERE id = 1')).toEqual({ n: 10 });
  });

  it('leaves changes() at 0 when a write fails at its COMMIT, as autocommit does', async () => {
    const { second } = await openCounters();
    await second.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE parent (id INTEGER PRIMARY KEY);
      CREATE TABLE child (parent_id INTEGER REFERENCES parent (id) DEFERRABLE INITIALLY DEFERRED);
    `);

    await expect(second.run('INSERT INTO child (parent_id) VALUES (7)')).rejects.toThrow(/FOREIGN KEY constraint failed/);
    expect(await second.get('SELECT changes() AS n')).toEqual({ n: 0 });
    expect(await second.all('SELECT parent_id FROM child')).toEqual([]);
  });

  it('runs EXPLAIN and an exec script of no statement at once while another connection holds the write lock', async () => {
    const { first, second } = await openCounters(0);
    const held = holdUntilReleased(first);
    await held.ready;

    try {
      const plan = await second.all('EXPLAIN UPDATE counter SET n = 1 WHERE id = 1');
      expect(plan.length).toBeGreaterThan(0);
      await second.exec('');
      await second.exec(' -- nothing to run\n');
    } finally {
      held.release();
      await held.done;
    }
    expect(await second.get('SELECT n FROM counter WHERE id = 1')).toEqual({ n: 0 });
  });

  it('creates a temp table at once while another connection holds the write lock', async () => {
    const { first, second } = await openCounters(0);
    const held = holdUntilReleased(first);
    await held.ready;

    try {
      await second.run('CREATE TEMP TABLE scratch (x INTEGER)');
      await second.run('/* local */ CREATE TEMPORARY TABLE scratch_two (x INTEGER)');
      await second.exec('CREATE TEMP VIEW scratch_view AS SELECT x FROM scratch;');
    } finally {
      held.release();
      await held.done;
    }
    expect(await second.all('SELECT name FROM temp.sqlite_master ORDER BY name')).toEqual([
      { name: 'scratch' },
      { name: 'scratch_two' },
      { name: 'scratch_view' },
    ]);
  });

  it('binds a named value that is an own property the object does not enumerate', async () => {
    const { second } = await openCounters();
    await second.exec('CREATE TABLE notes (body TEXT);');
    const values = Object.defineProperty({}, 'body', { value: 'kept' });

    await expect(second.run('INSERT INTO notes (body) VALUES (@body)', values)).resolves.toMatchObject({ changes: 1 });
    expect(await second.all('SELECT body FROM notes')).toEqual([{ body: 'kept' }]);
  });

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
