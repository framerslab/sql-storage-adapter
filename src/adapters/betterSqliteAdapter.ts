import path from 'path';

/**
 * Internal environment flags - evaluated at module load but side-effect free.
 * We deliberately avoid throwing here so that bundlers (Vite, Webpack, etc.)
 * can safely include this module in a dependency graph for tree-shaking
 * without immediately exploding in browser builds. Any actual attempt to
 * OPEN the adapter in a browser will produce a clear runtime error.
 */
const isBrowser = typeof window !== 'undefined' && typeof window.document !== 'undefined';

// We do NOT import 'url' or perform top-level dynamic imports; this keeps the
// file side-effect free and friendly to ESM + pre-bundling analyzers.
// Path resolution is simplified to process.cwd() relative resolution.

import type { StorageAdapter, StorageOpenOptions, StorageParameters, StorageRunResult, StorageCapability, StorageTransactionOptions, BatchOperation, BatchResult } from '../core/contracts';
import { normaliseParameters } from '../shared/parameterUtils';
import { firstKeyword } from '../shared/queryWrites';
import { integersAsBigInt, toSqliteStatement } from '../shared/sqlPlaceholders';
import { sqliteStatementSpans } from '../shared/splitSqlStatements';
import { checkFunctionName, type SqlFunction, type SqlFunctionOptions } from '../shared/sqlFunctions';
import {
  createSerializedTransactionRunner,
  createSharedConnectionTransactionAdapter,
} from '../shared/serializedTransaction';
import {
  createConnectionGate,
  whenAdmitted,
  type ConnectionGate,
  type TransactionContextStore,
} from '../shared/connectionGate';
import { segmentFilePath, validateSegment } from '../shared/segment';

/** Options of the better-sqlite3 adapter. */
export interface BetterSqliteAdapterOptions {
  /**
   * A database file of its own: the segment goes into the file's name, before
   * its extension (`app.sqlite3` becomes `app-agentos.sqlite3`), for the
   * default path and for a path given to `open()`. `:memory:` stays as it is.
   */
  segment?: string;
  /**
   * How long a statement waits for another connection's lock on the file
   * before it fails with `SQLITE_BUSY`, in milliseconds: better-sqlite3's
   * `timeout`, which sets SQLite's busy timeout. Default 5000. A transaction
   * waits this long at its `BEGIN IMMEDIATE` for another connection's write
   * transaction to end.
   */
  busyTimeoutMs?: number;
}

/** The busy timeout when `busyTimeoutMs` is not given, in milliseconds. */
const DEFAULT_BUSY_TIMEOUT_MS = 5000;

/**
 * The waits between tries for another connection's write lock, in
 * milliseconds: those of SQLite's own busy handler (sqliteDefaultBusyCallback).
 * The last repeats until the busy timeout passes.
 */
const BUSY_RETRY_DELAYS_MS = [1, 2, 5, 10, 15, 20, 25, 25, 25, 50, 50, 100];

/** A SQLite error's code (`SQLITE_BUSY`, `SQLITE_READONLY`, ...), or '' for anything else. */
const sqliteCode = (error: unknown): string => {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' ? code : '';
};

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const pauseBeforeBusyRetry = (attempt: number, left: number): Promise<void> =>
  pause(Math.min(BUSY_RETRY_DELAYS_MS[Math.min(attempt, BUSY_RETRY_DELAYS_MS.length - 1)], left));

const readBusyTimeout = (db: BetterSqliteDatabase): number =>
  Math.max(0, Number(db.pragma('busy_timeout', { simple: true })) || 0);

/**
 * Whether SQL names the busy timeout (`PRAGMA busy_timeout`, `main.busy_timeout`,
 * `pragma_busy_timeout`). Such a statement runs with the connection's setting as
 * it stands, so it neither reads nor keeps the 0 a retry sets for its tries.
 */
const namesBusyTimeout = (sql: string): boolean => /busy_timeout/i.test(sql);

/**
 * Whether a script creates a trigger. A trigger's body holds semicolons of its
 * own, where the statement splitter would cut it, so such a script runs whole.
 */
const createsTrigger = (script: string): boolean =>
  /\btrigger\b/i.test(script) && sqliteStatementSpans(script).some(({ start, end }) => {
    const statement = script.slice(start, end);
    const keyword = firstKeyword(statement);
    return (keyword === 'CREATE' || keyword === 'EXPLAIN') && /\btrigger\b/i.test(statement);
  });

/** One try of a statement without SQLite's busy handler: its value, or the SQLITE_BUSY that stopped it. */
type BusyTry<T> = { ok: true; value: T } | { ok: false; error: unknown };

/**
 * Runs `attempt` once with SQLite's busy timeout at 0, then sets `busyTimeout`
 * back. A SQLITE_BUSY that leaves no transaction open comes back for a retry:
 * SQLite took no lock, or rolled the statement back when its commit was busy.
 * Any other error is thrown.
 */
const tryWithoutBusyHandler = <T>(db: BetterSqliteDatabase, attempt: () => T, busyTimeout: number): BusyTry<T> => {
  if (busyTimeout > 0) db.pragma('busy_timeout = 0');
  try {
    return { ok: true, value: attempt() };
  } catch (error) {
    if (!sqliteCode(error).startsWith('SQLITE_BUSY') || db.inTransaction) throw error;
    return { ok: false, error };
  } finally {
    if (busyTimeout > 0 && db.open) db.pragma(`busy_timeout = ${busyTimeout}`);
  }
};

/**
 * The first row of a statement that writes and returns rows, stepped to its
 * end, keeping that row alone. A commit that fails with SQLITE_BUSY throws here;
 * the driver's get() would return the row of a write SQLite rolled back.
 */
const firstRowStepped = (stmt: BetterSqliteStatement, args: unknown[] | Record<string, unknown>): unknown => {
  let first: unknown;
  let seen = false;
  for (const row of stmt.iterate(args)) {
    if (!seen) {
      first = row;
      seen = true;
    }
  }
  return first;
};

/** The result of a batch that `error` stopped at its BEGIN or its COMMIT: none of its operations was kept. */
const failedBatch = (operations: BatchOperation[], error: unknown): BatchResult => ({
  successful: 0,
  failed: operations.length,
  errors: [{ index: -1, error: error instanceof Error ? error : new Error(String(error)) }],
});

type BetterSqliteModule = typeof import('better-sqlite3');
type BetterSqliteDatabase = import('better-sqlite3').Database;
type BetterSqliteStatement = import('better-sqlite3').Statement<unknown[], unknown>;

/** The loaded better-sqlite3, with the version of the package it was loaded from. */
interface LoadedBetterSqlite {
  module: BetterSqliteModule;
  version: string | undefined;
}

/** The version of the better-sqlite3 that `require` resolves; undefined when it cannot be read. */
const versionOf = (require: NodeRequire): string | undefined => {
  try {
    const pkg = require('better-sqlite3/package.json') as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Lazy loader for better-sqlite3 to keep the dependency optional.
 *
 * This allows the package to work even when better-sqlite3 isn't installed,
 * falling back to other adapters gracefully.
 */
/**
 * Lazy loader for the optional native `better-sqlite3` dependency.
 *
 * Strategy:
 * 1. Attempt ESM dynamic import (works when the package is installed and
 *    supports ESM resolution).
 * 2. Fallback to CommonJS require via createRequire for environments where
 *    only the CJS entry is available.
 * 3. On failure, return null so the resolver can gracefully fall back to a
 *    different adapter (e.g., sql.js) instead of crashing.
 */
const loadBetterSqlite = async (): Promise<LoadedBetterSqlite | null> => {
  const { createRequire } = await import('module');
  try {
    // Attempt ESM import first (pnpm hoists as ESM-compatible). Its version is
    // read from the same place, this module's directory.
    const imported = (await import('better-sqlite3')) as unknown as BetterSqliteModule;
    return { module: imported, version: versionOf(createRequire(import.meta.url)) };
  } catch {
    try {
      // Fallback to CJS require. Use createRequire relative to process.cwd()
      // to avoid depending on url.fileURLToPath in browser bundles; the
      // version comes from the package this require loaded.
      const require = createRequire(path.join(process.cwd(), 'noop.js'));
      return { module: require('better-sqlite3') as unknown as BetterSqliteModule, version: versionOf(require) };
    } catch {
      // Intentionally silent — the resolver handles fallback logging.
      return null;
    }
  }
};

/**
 * Why the installed better-sqlite3 cannot run on this runtime, or null when it
 * can. better-sqlite3 13 and later are built for Node-API 10, which Node.js
 * 22.14+ and 23.6+ provide (Electron 35+, whose Node is 22.14). On an older
 * runtime the binding loads inside `new Database()` and the process crashes
 * (https://github.com/WiseLibs/better-sqlite3/issues/1514), which no catch can
 * stop, so the adapter refuses to open instead and the resolver moves on.
 *
 * @param version - The installed better-sqlite3 version, when it is known.
 * @param nodeApi - The runtime's `process.versions.napi`.
 */
const betterSqliteRuntimeRefusal = (version: string | undefined, nodeApi: string | undefined): string | null => {
  const major = Number(version?.split('.')[0]);
  if (!(major >= 13)) {
    return null;
  }
  const api = Number(nodeApi);
  if (api >= 10) {
    return null;
  }
  const has = Number.isFinite(api) && api > 0 ? `Node-API ${api}` : 'no Node-API version';
  return (
    `better-sqlite3 ${version} needs Node-API 10 (Node.js 22.14+ or 23.6+, Electron 35+), and this runtime has ${has}. ` +
    'Install better-sqlite3 12 for this runtime, or choose another adapter.'
  );
};

/**
 * Node's AsyncLocalStorage for the connection gate, or null where it cannot be
 * loaded (the gate then admits every statement at once). Loaded when the
 * adapter opens, like the native module, so that browser bundles never import
 * a Node built-in.
 */
const loadTransactionContext = async (): Promise<TransactionContextStore | null> => {
  try {
    const { AsyncLocalStorage } = await import('async_hooks');
    return new AsyncLocalStorage<symbol>();
  } catch {
    return null;
  }
};

const normaliseRowId = (rowId: number | bigint | null | undefined): string | number | null => {
  if (rowId === null || rowId === undefined) {
    return null;
  }
  return typeof rowId === 'bigint' ? rowId.toString() : rowId;
};

/**
 * Native SQLite adapter using better-sqlite3.
 *
 * ## Performance Characteristics
 * - Synchronous operations (unique among adapters)
 * - ~100,000 simple queries/second on modern hardware
 * - Efficient for single-writer, multiple-reader scenarios
 *
 * ## Limitations
 * - Single writer at a time
 * - Opens the file in its own journal mode: no `journal_mode` pragma is set, so a file made by this adapter runs SQLite's
 *   default rollback journal unless the caller set WAL on it; a reader holding a read transaction (a backup, an inspection)
 *   can therefore make a writer's commit wait out the busy timeout (`busyTimeoutMs`, 5,000 ms) and fail `SQLITE_BUSY`
 * - `transaction()` and `batch()` begin with `BEGIN IMMEDIATE` (plain `BEGIN` on a read-only connection or one under
 *   `PRAGMA query_only`), so a transaction takes the write lock before its first read and waits out the busy timeout
 *   for another connection's write transaction. A deferred `BEGIN` would start as a reader, and its first write would
 *   fail at once with `SQLITE_BUSY` (or `SQLITE_BUSY_SNAPSHOT` in WAL) once another connection had written, since
 *   SQLite does not call the busy handler for a reader asking to become a writer. The wait at `BEGIN` and for a
 *   statement outside a transaction runs on timers and leaves the event loop free. A statement inside a transaction
 *   the caller began with `BEGIN` through `run()` or `exec()`, one that names `busy_timeout`, and a script that
 *   creates a trigger wait in SQLite's busy handler, which holds the thread
 * - A transaction that only reads takes the write lock too, so a long one on a writable connection holds other
 *   connections' writes, unless it is begun with `transaction(fn, { readOnly: true })`: that one begins with a plain
 *   `BEGIN`, takes no write lock, and refuses a write inside it with `SQLITE_READONLY`
 * - No network access (local files only)
 * - Platform-specific native binaries required
 *
 * ## When to Use
 * - Desktop applications (Electron, Node.js)
 * - Development and testing
 * - Single-user applications
 * - When synchronous operations are needed
 *
 * ## Graceful Degradation
 * - Falls back to sql.js if native module unavailable
 */
/**
 * Native SQLite adapter backed by the `better-sqlite3` module.
 *
 * Features:
 * - Synchronous & high-performance local storage
 * - WAL support, prepared statements, batched writes
 * - Graceful degradation when the native module is absent
 *
 * Browser Safety:
 * This class can be imported in browser bundles without immediate failure.
 * A runtime error is only thrown if `open()` is invoked in a browser context.
 */
export class BetterSqliteAdapter implements StorageAdapter {
  public readonly kind = 'better-sqlite3';
  public readonly capabilities: ReadonlySet<StorageCapability> = new Set<StorageCapability>([
    'sync',         // Unique: supports synchronous operations
    'transactions', // Full ACID transaction support
    'wal',          // Write-Ahead Logging for better concurrency
    'locks',        // OS-level file locking prevents corruption
    'persistence',  // File-based storage survives restarts
    'prepared',     // Prepared statements for performance
    'batch'         // Efficient batch operations
  ]);

  private module: BetterSqliteModule | null = null;
  private db: BetterSqliteDatabase | null = null;
  private preparedStatements = new Map<string, BetterSqliteStatement>();
  private readonly runSerializedTransaction = createSerializedTransactionRunner();
  /**
   * Holds statements from outside an open transaction until it ends, so they
   * neither join it nor read what it has not committed. open() gives it Node's
   * AsyncLocalStorage, which tells the transaction's own statements apart.
   */
  private gate: ConnectionGate = createConnectionGate(null);
  /**
   * Settles when the last top-level statement, script, transaction or batch
   * that waits for another connection's lock, or waits behind one that does,
   * has run; null when none waits. Later top-level work runs after it, so an
   * adapter's work runs in the order it was issued, as it did when the wait
   * held the thread.
   */
  private lockWaits: Promise<void> | null = null;
  private readonly segment: string | undefined;
  private readonly busyTimeoutMs: number;
  /** Whether the open connection is read-only: its transactions begin with a plain BEGIN. */
  private readOnly = false;

  /**
   * Creates a new better-sqlite3 adapter instance.
   *
   * @param defaultFilePath - Absolute path to the SQLite database file.
   *                         Will be created if it doesn't exist.
   * @param options - The adapter's segment and busy timeout.
   * @throws {Error} When `options.segment` is not a name a segment can take.
   */
  constructor(private readonly defaultFilePath: string, options: BetterSqliteAdapterOptions = {}) {
    this.segment = options.segment === undefined ? undefined : validateSegment(options.segment);
    this.busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  }

  /**
   * Open (or no-op if already open) the underlying native database.
   *
   * Throws a descriptive error if called in a browser environment.
   */
  public async open(options?: StorageOpenOptions): Promise<void> {
    if (this.db) {
      return;
    }

    if (isBrowser) {
      throw new Error('[StorageAdapter] better-sqlite3 adapter cannot be opened in a browser environment.');
    }

    const loaded = await loadBetterSqlite();
    if (!loaded) {
      throw new Error('better-sqlite3 module is not available. Install it or choose another adapter.');
    }
    const refusal = betterSqliteRuntimeRefusal(loaded.version, process.versions?.napi);
    if (refusal) {
      throw new Error(refusal);
    }
    this.module = loaded.module;

    // Handle ESM/CJS interop for better-sqlite3 constructor
    const moduleReference = this.module as BetterSqliteModule & { default?: BetterSqliteModule };
    const DatabaseCtor = moduleReference.default ?? moduleReference;
    const resolvedPath = segmentFilePath(options?.filePath ?? this.defaultFilePath, this.segment);

    // Ensure parent directory exists (skip for :memory: and file: URIs)
    if (resolvedPath !== ':memory:' && !resolvedPath.startsWith('file:')) {
      const fs = await import('fs');
      const parentDir = path.dirname(resolvedPath);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }
    }

    const readOnly = options?.readOnly === true;
    const databaseOptions = readOnly
      ? { readonly: true, timeout: this.busyTimeoutMs }
      : { timeout: this.busyTimeoutMs };
    this.gate = createConnectionGate(await loadTransactionContext());
    this.db = new DatabaseCtor(resolvedPath, databaseOptions);
    this.readOnly = readOnly;
    if (options?.foreignKeys !== undefined) {
      this.db.exec(`PRAGMA foreign_keys = ${options.foreignKeys ? 'ON' : 'OFF'}`);
    }
  }

  public async run(statement: string, parameters?: StorageParameters): Promise<StorageRunResult> {
    return this.runStatement(statement, parameters);
  }

  public async get<T = unknown>(statement: string, parameters?: StorageParameters): Promise<T | null> {
    return this.getStatement<T>(statement, parameters);
  }

  public async all<T>(statement: string, parameters?: StorageParameters): Promise<T[]> {
    return this.allStatement<T>(statement, parameters);
  }

  public async exec(script: string): Promise<void> {
    return this.execScript(script);
  }

  private runStatement(statement: string, parameters?: StorageParameters, token?: symbol): Promise<StorageRunResult> {
    return this.executePrepared(statement, parameters, (stmt, args) => {
      const result = stmt.run(args);
      return { changes: result.changes, lastInsertRowid: normaliseRowId(result.lastInsertRowid) };
    }, token);
  }

  private getStatement<T>(statement: string, parameters?: StorageParameters, token?: symbol): Promise<T | null> {
    return this.executePrepared(statement, parameters, (stmt, args, retryOnBusy) => {
      const row = retryOnBusy && stmt.reader && !stmt.readonly ? firstRowStepped(stmt, args) : stmt.get(args);
      return (row as T) ?? null;
    }, token);
  }

  private allStatement<T>(statement: string, parameters?: StorageParameters, token?: symbol): Promise<T[]> {
    return this.executePrepared(statement, parameters, (stmt, args) => stmt.all(args) as T[], token);
  }

  /**
   * Runs one statement once the gate admits it. A statement outside a
   * transaction waits for another connection's lock on timers, behind any
   * earlier top-level work of this adapter that waits; `queued` marks the
   * statement's own turn in that line.
   */
  private executePrepared<T>(
    statement: string,
    parameters: StorageParameters | undefined,
    execute: (stmt: BetterSqliteStatement, args: unknown[] | Record<string, unknown>, retryOnBusy: boolean) => T,
    token?: symbol,
    queued = false,
  ): Promise<T> {
    return whenAdmitted<T>(this.gate, () => {
      this.ensureOpen();
      const db = this.db!;
      const topLevel = !this.readOnly && !db.inTransaction && this.gate.openToken() === null;
      if (topLevel && !queued && this.lockWaits !== null) {
        return this.afterLockWaits(() => this.executePrepared(statement, parameters, execute, token, true));
      }
      const prepared = toSqliteStatement(statement, parameters);
      const { named, positional } = normaliseParameters(integersAsBigInt(prepared.parameters));
      const args = named ?? positional ?? [];
      const cached = this.preparedStatements.get(prepared.statement);
      const work = (retryOnBusy: boolean) => execute(cached ?? this.prepareInternal(prepared.statement), args, retryOnBusy);

      // A statement can return rows and still write, as INSERT RETURNING does.
      // A cold prepare retries too: preparing reads the schema, which can be locked.
      if (!topLevel || (cached?.reader && cached.readonly) || namesBusyTimeout(prepared.statement)) {
        return work(false);
      }
      const ran = this.retryOnBusy(db, () => work(true));
      return queued ? ran : this.holdLaterWork(ran);
    }, token);
  }

  /**
   * Runs a script once the gate admits it. Outside a transaction its
   * statements run one at a time, as SQLite's exec() runs them, so a statement
   * that waits for another connection's lock waits on timers and runs again
   * alone, and the statements before it run once.
   */
  private execScript(script: string, token?: symbol, queued = false): Promise<void> {
    return whenAdmitted<void>(this.gate, () => {
      this.ensureOpen();
      const db = this.db!;
      if (this.readOnly || db.inTransaction || this.gate.openToken() !== null) {
        db.exec(script);
        return;
      }
      if (!queued && this.lockWaits !== null) {
        return this.afterLockWaits(() => this.execScript(script, token, true));
      }
      if (createsTrigger(script)) {
        db.exec(script);
        return;
      }
      const statements = sqliteStatementSpans(script).map(({ start, end }) => script.slice(start, end));
      const ran = this.execStatementsFrom(db, statements, 0);
      return queued ? ran : this.holdLaterWork(ran);
    }, token);
  }

  /**
   * Runs a script's statements in order from `index`. A statement inside a
   * transaction the script began, and one that names the busy timeout, runs in
   * SQLite's busy handler; any other waits for a lock on timers.
   */
  private execStatementsFrom(db: BetterSqliteDatabase, statements: string[], index: number): void | Promise<void> {
    for (let at = index; at < statements.length; at++) {
      const statement = statements[at];
      if (db.inTransaction || namesBusyTimeout(statement)) {
        db.exec(statement);
        continue;
      }
      const ran = this.retryOnBusy(db, () => {
        db.exec(statement);
      });
      if (ran instanceof Promise) return ran.then(() => this.execStatementsFrom(db, statements, at + 1));
    }
    return undefined;
  }

  /**
   * Runs `attempt` with SQLite's busy timeout at 0. While another connection
   * holds the lock it needs, tries again on timers until the connection's busy
   * timeout passes, then throws the last SQLITE_BUSY. The value comes back at
   * once when the first try succeeds.
   */
  private retryOnBusy<T>(db: BetterSqliteDatabase, attempt: () => T): T | Promise<T> {
    const busyTimeout = readBusyTimeout(db);
    const deadline = performance.now() + busyTimeout;
    const first = tryWithoutBusyHandler(db, attempt, busyTimeout);
    return first.ok ? first.value : this.retryAfterBusy(db, attempt, first.error, deadline);
  }

  private async retryAfterBusy<T>(
    db: BetterSqliteDatabase,
    attempt: () => T,
    error: unknown,
    deadline: number,
  ): Promise<T> {
    const gate = this.gate;
    for (let wait = 0; ; wait++) {
      const left = deadline - performance.now();
      if (left <= 0) throw error;
      await pauseBeforeBusyRetry(wait, left);
      // Top-level work keeps this adapter's transactions from beginning while it
      // waits, so none should hold the gate here. If one does, the statement
      // waits for it as at the gate, and that time does not count.
      if (gate.openToken() !== null) {
        const heldFrom = performance.now();
        while (gate.openToken() !== null) await gate.ended();
        deadline += performance.now() - heldFrom;
      }
      // The checks and the try run in one turn, as in whenAdmitted().
      if (!db.open || performance.now() >= deadline || db.inTransaction) throw error;
      const result = tryWithoutBusyHandler(db, attempt, readBusyTimeout(db));
      if (result.ok) return result.value;
      error = result.error;
    }
  }

  /** Runs `work` after the top-level work that waits for a lock, holding later work behind it; at once when none waits. */
  private afterLockWaits<T>(work: () => Promise<T>): Promise<T> {
    const waiting = this.lockWaits;
    if (waiting === null) return work();
    const queued = waiting.then(work);
    this.holdLaterWork(queued);
    return queued;
  }

  /** Holds later top-level work behind `work` when it waits for a lock. */
  private holdLaterWork<T>(work: T | Promise<T>): T | Promise<T> {
    if (work instanceof Promise) {
      const settled = work.then(() => undefined, () => undefined);
      this.lockWaits = settled;
      void settled.then(() => {
        if (this.lockWaits === settled) this.lockWaits = null;
      });
    }
    return work;
  }

  /**
   * The statements of one transaction's handle: they carry the transaction's
   * token, so the gate admits them whatever async context runs them (a callback
   * may reach its handle through an AsyncResource made before the transaction).
   */
  private handleStatements(token: symbol): StorageAdapter {
    return {
      kind: this.kind,
      capabilities: this.capabilities,
      open: async () => {},
      close: async () => {},
      run: (statement, parameters) => this.runStatement(statement, parameters, token),
      get: <T>(statement: string, parameters?: StorageParameters) => this.getStatement<T>(statement, parameters, token),
      all: <T>(statement: string, parameters?: StorageParameters) => this.allStatement<T>(statement, parameters, token),
      exec: (script) => this.execScript(script, token),
      batch: (operations) => whenAdmitted(this.gate, () => this.batchNow(operations), token),
      // The handle answers a nested transaction() itself and never calls this.
      transaction: (fn) => fn(this),
    };
  }

  public async transaction<T>(fn: (trx: StorageAdapter) => Promise<T>, options?: StorageTransactionOptions): Promise<T> {
    this.ensureOpen();
    const openToken = this.gate.inside() ? this.gate.openToken() : null;
    if (openToken) {
      // Code the open transaction runs called the adapter itself: the callback
      // joins the open transaction, as one given to the handle's transaction()
      // does, instead of queueing behind the transaction it belongs to. Its
      // handle carries the open transaction's token, as the outer one does.
      return fn(createSharedConnectionTransactionAdapter(this.handleStatements(openToken)));
    }
    // The adapter has one physical connection. Queue top-level callbacks so
    // overlapping callers cannot issue a second BEGIN inside the first tx, and
    // hold the gate so other callers' statements wait for its end. A statement
    // issued before it that waits for a lock runs first.
    return this.runSerializedTransaction(() => this.afterLockWaits(() =>
      this.gate.hold(async (token) => {
        this.ensureOpen();
        const readsOnly = options?.readOnly === true;
        await this.beginTransaction(readsOnly);
        const transactionAdapter = createSharedConnectionTransactionAdapter(this.handleStatements(token));
        let restoreQueryOnly: (() => void) | null = null;
        try {
          if (readsOnly) restoreQueryOnly = this.holdQueryOnly();
          const result = await fn(transactionAdapter);
          this.db!.exec('COMMIT');
          return result;
        } catch (error) {
          try { this.db!.exec('ROLLBACK'); } catch { /* ignore rollback errors */ }
          throw error;
        } finally {
          restoreQueryOnly?.();
        }
      }),
    ));
  }

  /**
   * Begins a top-level transaction. IMMEDIATE takes the file's write lock now.
   * A deferred BEGIN starts as a reader, and SQLite fails its first write at
   * once with SQLITE_BUSY (SQLITE_BUSY_SNAPSHOT in WAL) when another
   * connection has written since, without calling the busy handler.
   *
   * While another connection holds the lock, the adapter tries again on timers
   * until the connection's busy timeout passes, with SQLite's busy timeout at 0
   * for each try, and then throws the last SQLITE_BUSY. SQLite's own busy
   * handler sleeps the thread: a second adapter on the same file in this
   * process, waiting in it, would hold the first adapter's callback, and the
   * COMMIT that ends the wait, until its own wait ran out.
   *
   * A connection that cannot take the write lock begins deferred: one opened
   * read-only, and one under `PRAGMA query_only`, whose BEGIN IMMEDIATE SQLite
   * refuses with SQLITE_READONLY. It only reads, so it loses no write. So does
   * a transaction begun with `readOnly` (`readsOnly`), which holds
   * `PRAGMA query_only` until it ends.
   */
  private async beginTransaction(readsOnly = false): Promise<void> {
    const db = this.db!;
    if (this.readOnly || readsOnly) {
      db.exec('BEGIN');
      return;
    }
    const busyTimeout = readBusyTimeout(db);
    const deadline = Date.now() + busyTimeout;
    db.pragma('busy_timeout = 0');
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          db.exec('BEGIN IMMEDIATE');
          return;
        } catch (error) {
          const code = sqliteCode(error);
          if (code.startsWith('SQLITE_READONLY')) {
            db.exec('BEGIN');
            return;
          }
          const left = deadline - Date.now();
          if (!code.startsWith('SQLITE_BUSY') || left <= 0) throw error;
          await pauseBeforeBusyRetry(attempt, left);
        }
      }
    } finally {
      if (db.open) db.pragma(`busy_timeout = ${busyTimeout}`);
    }
  }

  /**
   * Turns `PRAGMA query_only` on for a transaction begun with `readOnly`, so a
   * write inside it fails with SQLITE_READONLY, as PostgreSQL refuses one in a
   * READ ONLY transaction, instead of failing later as a lost write: a
   * deferred transaction's write fails with SQLITE_BUSY_SNAPSHOT once another
   * connection has written. Returns the step that turns it off again; a
   * connection the caller set to query_only keeps the setting.
   */
  private holdQueryOnly(): () => void {
    const db = this.db!;
    if (Number(db.pragma('query_only', { simple: true })) === 1) return () => undefined;
    db.pragma('query_only = ON');
    return () => {
      if (db.open) db.pragma('query_only = OFF');
    };
  }

  public async close(): Promise<void> {
    this.gate.dispose();
    this.gate = createConnectionGate(null);
    if (this.db) {
      // Finalize all prepared statements
      this.preparedStatements.clear();
      this.db.close();
      this.db = null;
    }
    this.readOnly = false;
  }

  /**
   * Execute multiple operations efficiently in a single transaction.
   *
   * Much faster than executing operations individually, especially
   * for bulk inserts. Automatically wraps in a transaction.
   *
   * @param operations - Array of SQL operations to execute
   * @returns Results of the batch operation
   */
  public async batch(operations: BatchOperation[]): Promise<BatchResult> {
    // On a read-only connection, and from code an open transaction runs, the
    // batch runs in place: a deferred transaction, or a savepoint in the open one.
    if (this.readOnly || this.gate.inside()) {
      return whenAdmitted(this.gate, () => this.batchNow(operations));
    }
    // Otherwise it takes its turn and begins as transaction() does, so its wait
    // for another connection's write lock does not stop the event loop.
    return this.runSerializedTransaction(() => this.afterLockWaits(() =>
      this.gate.hold(async () => {
        this.ensureOpen();
        // A transaction a caller began with BEGIN through run() or exec(): the
        // batch runs in it, as a savepoint.
        if (this.db!.inTransaction) return this.batchNow(operations);
        try {
          await this.beginTransaction();
        } catch (error) {
          return failedBatch(operations, error);
        }
        const result = this.batchNow(operations);
        try {
          this.db!.exec('COMMIT');
        } catch (error) {
          try { this.db!.exec('ROLLBACK'); } catch { /* the COMMIT's error is the one reported */ }
          return failedBatch(operations, error);
        }
        return result;
      }),
    ));
  }

  /**
   * Makes a JavaScript function callable from SQL on this connection under
   * `name`. The adapter must be open.
   */
  public registerFunction(name: string, fn: SqlFunction, options: SqlFunctionOptions = {}): void {
    this.ensureOpen();
    this.db!.function(checkFunctionName(name), { deterministic: options.deterministic ?? false }, fn);
  }

  private batchNow(operations: BatchOperation[]): BatchResult {
    this.ensureOpen();

    const results: StorageRunResult[] = [];
    const errors: Array<{ index: number; error: Error }> = [];
    let successful = 0;
    let failed = 0;

    // Use a transaction for atomicity and performance
    const transaction = this.db!.transaction(() => {
      operations.forEach((op, index) => {
        try {
          const prepared = toSqliteStatement(op.statement, op.parameters);
          const stmt = this.prepareInternal(prepared.statement);
          const { named, positional } = normaliseParameters(integersAsBigInt(prepared.parameters));
          const result = named ? stmt.run(named) : stmt.run(positional ?? []);
          results.push({
            changes: result.changes,
            lastInsertRowid: normaliseRowId(result.lastInsertRowid)
          });
          successful++;
        } catch (error) {
          failed++;
          errors.push({
            index,
            error: error instanceof Error ? error : new Error(String(error))
          });
        }
      });
    });

    try {
      // Inside a transaction both run as a savepoint; batch() has begun the
      // top-level one on a writable connection. A handle whose transaction
      // has ended gets here outside one, and begins IMMEDIATE, as
      // transaction() begins.
      if (this.readOnly) {
        transaction();
      } else {
        transaction.immediate();
      }
    } catch (error) {
      // Transaction failed, all operations rolled back
      return failedBatch(operations, error);
    }

    return { successful, failed, results, errors };
  }

  private prepareInternal(statement: string): BetterSqliteStatement {
    this.ensureOpen();

    // Cache prepared statements for reuse
    if (!this.preparedStatements.has(statement)) {
      this.preparedStatements.set(statement, this.db!.prepare(statement));
    }

    return this.preparedStatements.get(statement)!;
  }

  private ensureOpen(): void {
    if (!this.db) {
      throw new Error('Storage adapter not opened. Call open() before executing statements.');
    }
  }
}

/**
 * Factory helper.
 */
/**
 * Factory helper for creating a BetterSqliteAdapter.
 *
 * Path Resolution:
 * - Absolute paths are used as-is.
 * - Relative paths are resolved against the current working directory instead
 *   of the adapter file location (simpler & bundler neutral).
 * - Special values like ':memory:' and 'file:' URIs are passed through.
 * - With `options.segment`, the file's name carries the segment
 *   (`app.sqlite3` becomes `app-agentos.sqlite3`).
 * - `options.busyTimeoutMs` sets how long a statement waits for another
 *   connection's lock (default 5000).
 *
 * @throws {Error} When `options.segment` is not a name a segment can take.
 */
export const createBetterSqliteAdapter = (filePath: string, options?: BetterSqliteAdapterOptions): StorageAdapter => {
  if (filePath === ':memory:' || filePath.startsWith('file:')) {
    return new BetterSqliteAdapter(filePath, options);
  }
  const resolved = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(process.cwd(), filePath);
  return new BetterSqliteAdapter(resolved, options);
};
