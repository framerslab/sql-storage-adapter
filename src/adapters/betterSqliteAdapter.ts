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
import { integersAsBigInt, toSqliteStatement } from '../shared/sqlPlaceholders';
import { checkFunctionName, type SqlFunction, type SqlFunctionOptions } from '../shared/sqlFunctions';
import {
  createSerializedTransactionRunner,
  createSharedConnectionTransactionAdapter,
} from '../shared/serializedTransaction';
import {
  createConnectionGate,
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

/**
 * Words that keep SQL out of the write transaction the adapter begins for a
 * write outside a transaction: SQL with one runs as SQLite runs it. BEGIN,
 * COMMIT, END, ROLLBACK, SAVEPOINT and RELEASE begin or end a transaction
 * themselves (ROLLBACK as a conflict clause ends the one it runs in). VACUUM,
 * ATTACH and DETACH fail inside a transaction. A PRAGMA can fail there
 * (`journal_mode`, `wal_checkpoint`) or do nothing (`foreign_keys`).
 */
const RUNS_AS_WRITTEN = ['BEGIN', 'COMMIT', 'END', 'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'PRAGMA', 'VACUUM', 'ATTACH', 'DETACH'];

/** A statement is of the kind its first keyword names. */
const STATEMENT_RUNS_AS_WRITTEN = new Set(RUNS_AS_WRITTEN);

/**
 * A script is not cut into statements: the word anywhere in it counts, in a
 * comment, a string, a trigger's body (`BEGIN ... END`) or a `CASE ... END`
 * too. SQLite reads a keyword only as a whole word, between characters that
 * cannot go on a name, so no script that holds one of these statements goes
 * unseen.
 */
const SCRIPT_RUNS_AS_WRITTEN = new RegExp(`\\b(?:${RUNS_AS_WRITTEN.join('|')})\\b`, 'i');

/** The whitespace, comments and empty statements (`;`) SQLite skips before a statement's first keyword. */
const LEADING_EMPTY_STATEMENTS = /^(?:[\s;]+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/;

/** The whitespace and comments SQLite skips between two keywords. */
const SPACE_BETWEEN_KEYWORDS = /^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/;

/** A keyword at the start of `text`, upper-cased; '' when there is none. */
const keywordAt = (text: string): string => (/^[A-Za-z]+/.exec(text)?.[0] ?? '').toUpperCase();

/** A statement's first two keywords, upper-cased, past what SQLite skips before and between them; '' for one it lacks. */
const leadingKeywords = (statement: string): [string, string] => {
  const rest = statement.replace(LEADING_EMPTY_STATEMENTS, '');
  const first = keywordAt(rest);
  return [first, first ? keywordAt(rest.slice(first.length).replace(SPACE_BETWEEN_KEYWORDS, '')) : ''];
};

/** Statements that write nothing to the file: a read, and EXPLAIN, which reads a plan whatever it explains. */
const READS = new Set(['SELECT', 'VALUES', 'EXPLAIN']);

/** Statements that write, by their first keyword. The adapter prepares them once it holds the write lock. */
const WRITES = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'CREATE', 'DROP', 'ALTER', 'ANALYZE', 'REINDEX']);

/** Statements whose rows SQLite counts in changes(): INSERT, UPDATE, DELETE and REPLACE, and WITH that leads one. */
const COUNTS_CHANGES = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'WITH']);

/**
 * How a statement outside a transaction runs: `as-written` as SQLite runs it;
 * `write` under the write lock, prepared once the lock is held; `ask` as its
 * prepared form says (`stmt.readonly`), for SQL whose first keyword does not
 * tell (`WITH`, ...). `CREATE TEMP` writes only the connection's own temp
 * database, so it does not wait for main's lock.
 */
const routeOf = (statement: string): 'as-written' | 'write' | 'ask' => {
  const [first, second] = leadingKeywords(statement);
  if (STATEMENT_RUNS_AS_WRITTEN.has(first) || READS.has(first)) return 'as-written';
  if (first === 'CREATE' && (second === 'TEMP' || second === 'TEMPORARY')) return 'as-written';
  return WRITES.has(first) ? 'write' : 'ask';
};

/** A table of the adapter's own in the connection's temp database: a DELETE of none of its rows sets changes() to 0. */
const CHANGES_RESET_TABLE = '"sql_storage_adapter_changes"';

/**
 * Whether the connection has a database attached. `PRAGMA database_list`
 * numbers main 0, temp 1 and attached databases from 2.
 */
const hasAttachedDatabase = (db: BetterSqliteDatabase): boolean =>
  (db.pragma('database_list') as Array<{ seq: number }>).some(({ seq }) => seq > 1);

/** A statement's values as the driver binds them. */
type BoundValues = unknown[] | Record<string, unknown>;

/** A value as it is now. Bytes are copied, since their owner can write to them again; no other bound value can change. */
const snapshotValue = (value: unknown): unknown =>
  ArrayBuffer.isView(value)
    ? new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
    : value;

/**
 * The values of a statement that runs after its caller's turn, as they are
 * now: the caller may reuse its array, its object or its buffers meanwhile.
 * Every own property of an object counts, as the driver binds a named value
 * from any own property, enumerable or not.
 */
const snapshotValues = (values: BoundValues): BoundValues => {
  if (Array.isArray(values)) return values.map(snapshotValue);
  const named: Record<string, unknown> = values;
  return Object.fromEntries(Object.getOwnPropertyNames(named).map((name) => [name, snapshotValue(named[name])]));
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
 *   SQLite does not call the busy handler for a reader asking to become a writer. The wait at `BEGIN` runs on timers
 *   and leaves the event loop free
 * - A write outside a transaction (`run()`, a write through `get()` or `all()`, an `exec()` script of one statement)
 *   takes the write lock the same way first, with `BEGIN IMMEDIATE` on timers, then is prepared, runs once and
 *   commits. Its `COMMIT` waits in SQLite's busy handler, which holds the thread, in rollback-journal mode while
 *   another connection reads, for up to the busy timeout; in WAL it does not wait. The rest runs as SQLite runs it and
 *   waits in the busy handler: a statement that writes nothing (`EXPLAIN` included), `CREATE TEMP`, an `exec()` script
 *   of more than one statement or of none, a script of one statement that writes nothing, a statement that is or a
 *   script that names `BEGIN`, `COMMIT`, `END`, `ROLLBACK`, `SAVEPOINT`, `RELEASE`, `PRAGMA`, `VACUUM`, `ATTACH` or
 *   `DETACH`, anything on a read-only connection or inside a transaction the caller began with `BEGIN`, and a write on
 *   a connection with a database attached when the lock is not free at once
 * - Statements, scripts, transactions and batches that are not an open transaction's own run one at a time, in the
 *   order issued
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
  /**
   * The connection's one queue: every statement, script, transaction and batch
   * that is not an open transaction's own takes a turn in it, in the order
   * issued. close() ends it; the next connection starts another.
   */
  private runSerializedTransaction = createSerializedTransactionRunner();
  /**
   * Tells an open transaction's own statements apart, which run in it without
   * a turn in the queue. open() gives it Node's AsyncLocalStorage.
   */
  private gate: ConnectionGate = createConnectionGate(null);
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
    return this.statement(statement, parameters, (stmt, values) => {
      const result = stmt.run(values);
      return { changes: result.changes, lastInsertRowid: normaliseRowId(result.lastInsertRowid) };
    }, token);
  }

  private getStatement<T>(statement: string, parameters?: StorageParameters, token?: symbol): Promise<T | null> {
    return this.statement(statement, parameters, (stmt, values) => (stmt.get(values) as T) ?? null, token);
  }

  private allStatement<T>(statement: string, parameters?: StorageParameters, token?: symbol): Promise<T[]> {
    return this.statement(statement, parameters, (stmt, values) => stmt.all(values) as T[], token);
  }

  /**
   * Runs one statement. An open transaction's own statement runs in it, in the
   * caller's turn. Any other takes its turn in the queue with the values it
   * was issued with, and runs as SQLite runs it, or, when it writes, under the
   * write lock (writeUnderLock). It is prepared in its turn, after the work
   * issued before it, which may create what it names. Preparing reads the
   * schema, which another connection's exclusive lock holds off in SQLite's
   * busy handler, so a write is prepared once the lock is taken, and a
   * statement whose first keyword does not say whether it writes is prepared
   * on timers (prepareWithoutWaiting).
   */
  private async statement<T>(
    statement: string,
    parameters: StorageParameters | undefined,
    execute: (stmt: BetterSqliteStatement, values: BoundValues) => T,
    token?: symbol,
  ): Promise<T> {
    const prepared = toSqliteStatement(statement, parameters);
    const { named, positional } = normaliseParameters(integersAsBigInt(prepared.parameters));
    const values: BoundValues = named ?? positional ?? [];
    if (this.joinsOpenTransaction(token)) {
      return execute(this.prepareInternal(prepared.statement), values);
    }
    const issued = snapshotValues(values);
    const sql = prepared.statement;
    return this.inTurn(async (db) => {
      const route = this.readOnly || db.inTransaction ? 'as-written' : routeOf(sql);
      if (route === 'as-written') return execute(this.prepareInternal(sql), issued);
      const countsChanges = COUNTS_CHANGES.has(leadingKeywords(sql)[0]);
      if (route === 'write') return this.writeUnderLock(db, () => execute(this.prepareInternal(sql), issued), countsChanges);
      const stmt = await this.prepareWithoutWaiting(db, sql);
      // better-sqlite3's `readonly` is SQLite's sqlite3_stmt_readonly(): true
      // when the statement writes nothing to the file.
      return stmt.readonly ? execute(stmt, issued) : this.writeUnderLock(db, () => execute(stmt, issued), countsChanges);
    });
  }

  /**
   * Runs a script, whole, as better-sqlite3's exec() reads it. An open
   * transaction's own script runs in it. Any other takes its turn in the
   * queue. A script of one statement that writes runs under the write lock;
   * the rest run as SQLite runs them: a script of more than one statement or
   * of none, each statement in its own autocommit as on any connection, one
   * that names a word that keeps it out of a transaction, and one statement
   * that writes nothing or that `routeOf` runs as written.
   */
  private async execScript(script: string, token?: symbol): Promise<void> {
    if (this.joinsOpenTransaction(token)) {
      this.ensureOpen();
      this.db!.exec(script);
      return;
    }
    return this.inTurn(async (db) => {
      const sole =
        this.readOnly || db.inTransaction || SCRIPT_RUNS_AS_WRITTEN.test(script) ? null : await this.soleStatement(db, script);
      if (sole === null || sole.readonly || routeOf(script) === 'as-written') {
        db.exec(script);
        return;
      }
      return this.writeUnderLock(db, () => {
        db.exec(script);
      }, COUNTS_CHANGES.has(leadingKeywords(script)[0]));
    });
  }

  /**
   * The one statement a script holds, prepared on timers
   * (prepareWithoutWaiting), or null when it holds none, more than one, or
   * SQL SQLite refuses, which exec() then reports itself. better-sqlite3
   * prepares a script of one statement and refuses one of more.
   */
  private async soleStatement(db: BetterSqliteDatabase, script: string): Promise<BetterSqliteStatement | null> {
    try {
      return await this.retryWhileBusy(db, () => db.prepare(script));
    } catch (error) {
      if (sqliteCode(error).startsWith('SQLITE_BUSY')) throw error;
      return null;
    }
  }

  /**
   * Prepares a statement without waiting in SQLite's busy handler for the
   * schema it reads (retryWhileBusy), and keeps it for reuse.
   */
  private async prepareWithoutWaiting(db: BetterSqliteDatabase, statement: string): Promise<BetterSqliteStatement> {
    const cached = this.preparedStatements.get(statement);
    if (cached) return cached;
    const stmt = await this.retryWhileBusy(db, () => db.prepare(statement));
    this.preparedStatements.set(statement, stmt);
    return stmt;
  }

  /**
   * Whether a statement is the open transaction's own: it carries the
   * transaction's token, or code the transaction runs issued it through the
   * adapter. Where there is no async context to tell, a statement without a
   * token counts as the open transaction's, as it did before.
   */
  private joinsOpenTransaction(token?: symbol): boolean {
    return this.gate.openToken() !== null && !this.gate.blocks(token);
  }

  /**
   * Runs `work` on the connection open now, after the work issued before it.
   * Work whose turn comes once close() has ended that connection is refused,
   * whatever open() has opened since.
   */
  private inTurn<T>(work: (db: BetterSqliteDatabase) => T | Promise<T>): Promise<T> {
    this.ensureOpen();
    const db = this.db!;
    return this.runSerializedTransaction(async () => {
      this.refuseAfterClose(db);
      return work(db);
    });
  }

  /** Refuses work issued on `db` once close() has ended that connection. */
  private refuseAfterClose(db: BetterSqliteDatabase): void {
    if (this.db !== db) {
      throw new Error('The storage adapter was closed while this work waited for its turn.');
    }
  }

  /**
   * Runs a write outside a transaction: BEGIN IMMEDIATE, waiting for another
   * connection's lock on timers (takeWriteLock), then the write once, with the
   * connection's busy timeout as it is set, then COMMIT. Nothing runs again,
   * so a function the write calls runs as often as SQLite calls it once. When
   * SQLite gives the connection no write transaction (`query_only`), or a
   * database is attached and the lock is not free at once, the write runs as
   * SQLite runs it and reports what it meets itself.
   *
   * A write that fails is committed all the same, as autocommit does: SQLite
   * has undone a statement that failed, or kept the rows before the failure
   * for OR FAIL; then the write's own error is thrown. A failure that ended
   * the transaction (a ROLLBACK conflict resolution, a full disk) left nothing
   * to commit. A COMMIT that fails is rolled back and its error is thrown, in
   * place of the write's own error when the write failed too, so no row of a
   * write SQLite did not keep is returned: in rollback-journal mode it waits
   * in SQLite's busy handler for other connections' reads to end, for up to
   * the busy timeout. With `countsChanges`, for a statement whose rows SQLite
   * counts, changes() then reads 0, as autocommit leaves it.
   */
  private async writeUnderLock<T>(db: BetterSqliteDatabase, write: () => T, countsChanges: boolean): Promise<T> {
    const locked = await this.takeWriteLock(db, true);
    this.refuseAfterClose(db);
    if (!locked) return write();
    let result: T;
    try {
      result = write();
    } catch (error) {
      if (db.inTransaction) this.commitWrite(db, countsChanges);
      throw error;
    }
    this.commitWrite(db, countsChanges);
    return result;
  }

  /**
   * Commits the write transaction. A COMMIT that fails is rolled back and its
   * error thrown. The write counted its rows in changes() when it ran, and
   * neither the COMMIT nor the ROLLBACK sets the count, so with
   * `countsChanges` a DELETE of none of the rows of the adapter's own temp
   * table sets it to 0; the temp database is the connection's alone, so that
   * takes no lock another connection holds.
   */
  private commitWrite(db: BetterSqliteDatabase, countsChanges: boolean): void {
    try {
      db.exec('COMMIT');
    } catch (error) {
      try {
        if (db.inTransaction) db.exec('ROLLBACK');
        if (countsChanges) {
          db.exec(`CREATE TEMP TABLE IF NOT EXISTS ${CHANGES_RESET_TABLE} (unused); DELETE FROM temp.${CHANGES_RESET_TABLE} WHERE 0;`);
        }
      } catch { /* the COMMIT's error is the one reported */ }
      throw error;
    }
  }

  /**
   * The statements of one transaction's handle: they carry the transaction's
   * token, so they run in it whatever async context issues them (a callback
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
      // A handle whose transaction has ended batches in its own turn, after
      // any transaction open now, never in it.
      batch: async (operations) =>
        this.joinsOpenTransaction(token) ? this.batchNow(operations) : this.batchInTurn(operations),
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
    // The adapter has one physical connection. A top-level callback takes its
    // turn in the queue, so overlapping callers cannot issue a second BEGIN
    // inside the first tx and other callers' statements wait for its end, and
    // holds the gate, which tells its own statements apart.
    return this.inTurn((db) =>
      this.gate.hold(async (token) => {
        const readsOnly = options?.readOnly === true;
        await this.beginTransaction(db, readsOnly);
        const transactionAdapter = createSharedConnectionTransactionAdapter(this.handleStatements(token));
        let restoreQueryOnly: (() => void) | null = null;
        try {
          if (readsOnly) restoreQueryOnly = this.holdQueryOnly(db);
          const result = await fn(transactionAdapter);
          db.exec('COMMIT');
          return result;
        } catch (error) {
          try { db.exec('ROLLBACK'); } catch { /* ignore rollback errors */ }
          throw error;
        } finally {
          restoreQueryOnly?.();
        }
      }),
    );
  }

  /**
   * Begins a top-level transaction. IMMEDIATE takes the file's write lock now.
   * A deferred BEGIN starts as a reader, and SQLite fails its first write at
   * once with SQLITE_BUSY (SQLITE_BUSY_SNAPSHOT in WAL) when another
   * connection has written since, without calling the busy handler.
   *
   * A connection that cannot take the write lock begins deferred: one opened
   * read-only, and one under `PRAGMA query_only`, whose BEGIN IMMEDIATE SQLite
   * refuses with SQLITE_READONLY. It only reads, so it loses no write. So does
   * a transaction begun with `readOnly` (`readsOnly`), which holds
   * `PRAGMA query_only` until it ends.
   */
  private async beginTransaction(db: BetterSqliteDatabase, readsOnly = false): Promise<void> {
    if (this.readOnly || readsOnly || !(await this.takeWriteLock(db))) {
      db.exec('BEGIN');
    }
  }

  /**
   * Takes the file's write lock with BEGIN IMMEDIATE. Resolves true once the
   * transaction has begun, and false, with no transaction open, when SQLite
   * refuses the lock with SQLITE_READONLY.
   *
   * While another connection holds the lock, the adapter tries again on timers
   * (retryWhileBusy) until the connection's busy timeout passes, and then
   * throws the last SQLITE_BUSY. SQLite's own busy handler sleeps the thread:
   * a second adapter on the same file in this process, waiting in it, would
   * hold the first adapter's callback, and the COMMIT that ends the wait,
   * until its own wait ran out. SQLite's busy timeout is 0 for each BEGIN
   * IMMEDIATE alone and set back before anything else runs, so no statement
   * reads it as 0.
   *
   * BEGIN IMMEDIATE asks for the write lock of main and of every attached
   * database, and a write outside a transaction (`outsideTransaction`) may need
   * only some of them. On a connection with a database attached, a lock that
   * is not free at once resolves false for such a write: it runs as SQLite runs
   * it, and waits in the busy handler for what it needs.
   */
  private takeWriteLock(db: BetterSqliteDatabase, outsideTransaction = false): Promise<boolean> {
    return this.retryWhileBusy(db, (attempt) => {
      try {
        db.exec('BEGIN IMMEDIATE');
        return true;
      } catch (error) {
        const code = sqliteCode(error);
        if (code.startsWith('SQLITE_READONLY')) return false;
        if (code.startsWith('SQLITE_BUSY') && outsideTransaction && attempt === 0 && hasAttachedDatabase(db)) return false;
        throw error;
      }
    });
  }

  /**
   * Runs `step` with SQLite's busy timeout at 0, and while it fails with
   * SQLITE_BUSY tries again on timers until the connection's busy timeout
   * passes; then throws the last SQLITE_BUSY. The busy timeout is set back
   * after each try, before anything else runs. Any other failure is thrown at
   * once. Every wait ends in a try, so a timer that fires late, past the busy
   * timeout, still finds a lock released meanwhile.
   */
  private async retryWhileBusy<T>(db: BetterSqliteDatabase, step: (attempt: number) => T): Promise<T> {
    const busyTimeout = Math.max(0, Number(db.pragma('busy_timeout', { simple: true })) || 0);
    const deadline = Date.now() + busyTimeout;
    for (let attempt = 0; ; attempt++) {
      let wait = 0;
      db.pragma('busy_timeout = 0');
      try {
        return step(attempt);
      } catch (error) {
        if (!sqliteCode(error).startsWith('SQLITE_BUSY')) throw error;
        const left = deadline - Date.now();
        if (left <= 0) throw error;
        wait = Math.min(BUSY_RETRY_DELAYS_MS[Math.min(attempt, BUSY_RETRY_DELAYS_MS.length - 1)], left);
      } finally {
        db.pragma(`busy_timeout = ${busyTimeout}`);
      }
      await pause(wait);
      this.refuseAfterClose(db);
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
  private holdQueryOnly(db: BetterSqliteDatabase): () => void {
    if (Number(db.pragma('query_only', { simple: true })) === 1) return () => undefined;
    db.pragma('query_only = ON');
    return () => {
      if (db.open) db.pragma('query_only = OFF');
    };
  }

  public async close(): Promise<void> {
    if (this.db) {
      // better-sqlite3 refuses to close while the connection runs a statement
      // (close() from a registered function): the adapter then stays as it was.
      this.db.close();
      this.db = null;
      this.preparedStatements.clear();
    }
    this.gate.dispose();
    this.gate = createConnectionGate(null);
    // Work still waiting for its turn on this connection is refused when the
    // turn comes; the next connection's work does not wait behind it.
    this.runSerializedTransaction = createSerializedTransactionRunner();
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
    // From code an open transaction runs, the batch runs in it, as a savepoint.
    if (this.gate.inside()) return this.batchNow(operations);
    return this.batchInTurn(operations);
  }

  /**
   * A batch in its own turn, begun as transaction() begins, so its wait for
   * another connection's write lock does not stop the event loop.
   */
  private batchInTurn(operations: BatchOperation[]): Promise<BatchResult> {
    return this.inTurn((db) =>
      this.gate.hold(async () => {
        // On a read-only connection it runs as a deferred transaction, and in a
        // transaction a caller began with BEGIN through run() or exec() as a
        // savepoint in it.
        if (this.readOnly || db.inTransaction) return this.batchNow(operations);
        try {
          await this.beginTransaction(db);
        } catch (error) {
          return failedBatch(operations, error);
        }
        const result = this.batchNow(operations);
        try {
          db.exec('COMMIT');
        } catch (error) {
          try { db.exec('ROLLBACK'); } catch { /* the COMMIT's error is the one reported */ }
          return failedBatch(operations, error);
        }
        return result;
      }),
    );
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
      // top-level one on a writable connection, and lets a read-only one
      // begin it here, deferred.
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
