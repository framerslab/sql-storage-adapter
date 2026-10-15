/**
 * @fileoverview IndexedDB Storage Adapter
 * @description Browser-native SQL storage using sql.js (WASM) for SQL execution and IndexedDB for persistence.
 *
 * **Architecture:**
 * - **SQL Execution**: Uses sql.js (SQLite compiled to WebAssembly) for full SQL support
 * - **Persistence**: Stores the SQLite database file (as binary blob) in IndexedDB
 * - **Workflow**: Load DB from IndexedDB → Execute SQL in memory (sql.js) → Save back to IndexedDB
 *
 * **Why this approach?**
 * - IndexedDB is NOT SQL - it's a NoSQL key-value store
 * - sql.js provides full SQLite compatibility (transactions, joins, etc.)
 * - IndexedDB provides durable browser-native persistence
 * - Together: Full SQL capabilities + browser persistence = best of both worlds
 *
 * **Use cases:**
 * - Fully client-side applications (no backend needed)
 * - Progressive Web Apps (PWAs)
 * - Offline-capable web apps
 * - Privacy-first applications (data never leaves browser)
 *
 * **Performance:**
 * - Fast reads (in-memory SQL via sql.js)
 * - Moderate writes (IndexedDB persistence adds ~10-50ms)
 * - Auto-save batching reduces IDB overhead
 *
 * @example
 * ```typescript
 * import { IndexedDbAdapter } from '@framers/sql-storage-adapter';
 *
 * const adapter = new IndexedDbAdapter({
 *   dbName: 'my-app-db',
 *   durability: 'commit', // each write is in IndexedDB before it resolves
 *   crossTab: true,       // two tabs of the site keep each other's writes
 * });
 *
 * await adapter.open();
 * await adapter.run('CREATE TABLE sessions (id TEXT PRIMARY KEY, data TEXT)');
 * await adapter.run('INSERT INTO sessions VALUES (?, ?)', ['session-1', '{"events": []}']);
 *
 * const session = await adapter.get('SELECT * FROM sessions WHERE id = ?', ['session-1']);
 * console.log(session);
 * ```
 */

import initSqlJs from 'sql.js';
import type { SqlJsStatic, Database as SqlJsDatabase } from 'sql.js';
import type {
  StorageAdapter,
  StorageCapability,
  StorageOpenOptions,
  StorageParameters,
  StorageRunResult,
} from '../core/contracts';
import { expandNamedParameters, normaliseParameters } from '../shared/parameterUtils';
import { toSqliteStatement } from '../shared/sqlPlaceholders';
import {
  createSerializedTransactionRunner,
  createSharedConnectionTransactionAdapter,
} from '../shared/serializedTransaction';
import { createConnectionGate, whenAdmitted, type LongWaitWatch } from '../shared/connectionGate';
import { segmentName } from '../shared/segment';

/** How long a statement waits for an open transaction or the cross-tab lock before the adapter warns. */
const LONG_WAIT_MS = 10_000;

/** The object store's key of the database image. */
const IMAGE_KEY = 'db';

/**
 * The object store's key of the image's version stamp: every save writes a
 * new one beside the image, in the same IndexedDB transaction, so a tab can
 * tell that another has saved since it loaded.
 */
const STAMP_KEY = 'db:stamp';

/** How often a statement runs again after another tab saved first, without Web Locks. */
const MAX_CONFLICT_RETRIES = 50;

/**
 * Connection settings sql.js's export drops: `export()` closes the
 * connection and opens it again, which resets every per-connection PRAGMA. A
 * save reads these before it exports and sets again the ones a caller changed.
 */
const CONNECTION_PRAGMAS = [
  'foreign_keys',
  'recursive_triggers',
  'automatic_index',
  'cache_size',
  'cache_spill',
  'cell_size_check',
  'ignore_check_constraints',
  'legacy_alter_table',
  'query_only',
  'reverse_unordered_selects',
  'secure_delete',
  'synchronous',
  'temp_store',
  'trusted_schema',
  'busy_timeout',
] as const;

// ============================================================================
// GLOBAL SQL.JS SINGLETON
// ============================================================================
// Prevents race conditions when multiple IndexedDbAdapter instances initialize
// simultaneously by ensuring sql.js WASM is loaded only once.

let globalSQL: SqlJsStatic | null = null;
let globalSQLPromise: Promise<SqlJsStatic> | null = null;

/**
 * Get or initialize the global sql.js instance.
 * Uses a singleton pattern to prevent race conditions when multiple
 * adapters initialize simultaneously.
 */
async function getGlobalSQL(config?: Parameters<typeof initSqlJs>[0]): Promise<SqlJsStatic> {
  if (globalSQL) {
    return globalSQL;
  }

  if (globalSQLPromise) {
    return globalSQLPromise;
  }

  globalSQLPromise = initSqlJs(config).then((sql: SqlJsStatic) => {
    globalSQL = sql;
    return sql;
  });

  return globalSQLPromise;
}

/**
 * The part of the Web Locks API (`navigator.locks`) the adapter uses: an
 * exclusive lock per name, granted to one holder at a time, in the order
 * asked, and held until the callback's promise settles.
 */
export interface IndexedDbLockManager {
  request<T>(name: string, options: { mode: 'exclusive' }, callback: () => Promise<T>): Promise<T>;
}

/** How tabs coordinate their saves. */
export interface IndexedDbCrossTabOptions {
  /**
   * The lock manager: the browser's `navigator.locks` when left out. `null`
   * coordinates by the version stamp alone, as the adapter does where the
   * browser has no Web Locks.
   */
  locks?: IndexedDbLockManager | null;
}

/** When a write is stored in IndexedDB. */
export type IndexedDbDurability = 'interval' | 'commit';

/**
 * Configuration for IndexedDB adapter.
 */
export interface IndexedDbAdapterOptions {
  /** IndexedDB database name (default: 'app-db') */
  dbName?: string;
  /** IndexedDB object store name (default: 'sqliteDb') */
  storeName?: string;
  /** Auto-save to IndexedDB on a timer (default: true) */
  autoSave?: boolean;
  /** Save interval in milliseconds for batched writes (default: 5000) */
  saveIntervalMs?: number;
  /** sql.js configuration (e.g., locateFile for wasm) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sqlJsConfig?: any;
  /**
   * When a write is stored in IndexedDB.
   *
   * - `'interval'`, the default: the auto-save tick stores the writes made
   *   since the last save, every `saveIntervalMs`; `flush()` and `close()`
   *   store them at once. A write can be lost when the page goes before the
   *   next tick.
   * - `'commit'`: `run()`, `exec()`, a write through `all()` or `get()`
   *   (`INSERT ... RETURNING`) and `transaction()` resolve once their write is
   *   in IndexedDB, and reject when IndexedDB refuses it (the write stays in
   *   the database and the next save stores it). Each save writes the whole
   *   database image, so batch many writes in one `transaction()`. While a
   *   transaction a caller opened with `BEGIN` is open, nothing can be saved:
   *   its statements resolve at once, and its rows are stored when its
   *   `COMMIT` resolves.
   */
  durability?: IndexedDbDurability;
  /**
   * Keeps the writes of two tabs of the site that open the same database.
   * Each tab holds the whole database in memory and writes it back whole, so
   * without this the tab that saves last overwrites the other's writes.
   *
   * With `crossTab`, every statement and transaction runs under a Web Lock on
   * the database, on the newest stored image (a tab reloads it when another
   * has saved), and is stored before the lock is let go: `durability` is
   * `'commit'` whatever it says. Where the browser has no Web Locks (Safari
   * before 15.4, an insecure origin, Lockdown Mode), the version stamp stored
   * beside the image keeps both tabs' writes alone: a statement that finds
   * another tab saved first runs again on the newer image, and a
   * `transaction()` is refused with `IndexedDbConflictError`, storing
   * nothing, for its caller to run again. The adapter says once when it runs
   * without Web Locks.
   *
   * A transaction begun with `BEGIN` through `run()` or `exec()` cannot be
   * held across tabs: it is rolled back and refused. Use `transaction()`.
   */
  crossTab?: boolean | IndexedDbCrossTabOptions;
  /**
   * A database of its own: the segment is appended to `dbName`
   * (`app-db` becomes `app-db-agentos`). Lower-case letters, digits and
   * underscores.
   */
  segment?: string;
}

/**
 * A `transaction()` another tab saved over: refused, with nothing of it
 * stored. The adapter has loaded the other tab's image, so running the
 * transaction again keeps both tabs' writes.
 */
export class IndexedDbConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IndexedDbConflictError';
  }
}

const DB_VERSION = 1;

/** What the object store holds: the image and its version stamp. */
interface StoredImage {
  image: Uint8Array | null;
  stamp: string | null;
}

/** The first keyword of a statement, past its leading comments and whitespace. */
const firstKeyword = (statement: string): string => {
  const rest = statement.replace(/^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/, '');
  return (/^[A-Za-z]+/.exec(rest)?.[0] ?? '').toUpperCase();
};

/**
 * Storage adapter using IndexedDB + sql.js for client-side SQL persistence.
 *
 * **The Key Difference: Automatic Persistence**
 *
 * **sql.js adapter alone:**
 * - In-memory SQLite database (lost on page refresh)
 * - You must manually call `db.export()` and save it yourself
 * - No automatic persistence in browsers
 * - Good for: Edge functions, temporary calculations, prototyping
 *
 * **IndexedDB adapter (this):**
 * - Same sql.js SQL engine, but automatically saves to IndexedDB
 * - Data survives page refreshes automatically
 * - Auto-save batching reduces overhead
 * - Good for: Production PWAs, offline-first apps, persistent client-side storage
 *
 * **How It Works:**
 * 1. IndexedDB stores the SQLite database file (binary blob) - this is just storage
 * 2. sql.js (WASM) loads the database into memory and executes SQL - this provides SQL capabilities
 * 3. After writes, the updated database is saved back to IndexedDB: on a timer
 *    (the default), before each write resolves (`durability: 'commit'`), or
 *    under a cross-tab lock (`crossTab`)
 *
 * **Capabilities:**
 * - ✅ Transactions (via sql.js)
 * - ✅ Persistence (via IndexedDB - automatic!)
 * - ✅ Full SQL support (via sql.js)
 * - ✅ Export/import
 * - ✅ Several tabs on one database, with `crossTab`
 * - ❌ Server-side (browser only)
 *
 * @example Client-side application
 * ```typescript
 * const adapter = new IndexedDbAdapter({ dbName: 'my-app-db' });
 * await adapter.open();
 * await adapter.run('CREATE TABLE sessions (id TEXT PRIMARY KEY, data TEXT)');
 * ```
 */
export class IndexedDbAdapter implements StorageAdapter {
  public readonly kind = 'indexeddb';
  public readonly capabilities: ReadonlySet<StorageCapability> = new Set(['transactions', 'persistence', 'json', 'prepared']);

  private SQL: SqlJsStatic | null = null;
  private db: SqlJsDatabase | null = null;
  /** Foreign-key enforcement as open() was asked for it (undefined: the engine default); sql.js forgets the PRAGMA when export() reopens the connection. */
  private foreignKeys: boolean | undefined;
  private idb: IDBDatabase | null = null;
  private saveTimer: ReturnType<typeof setInterval> | null = null;
  /** Bumped by every statement that can change the database. */
  private writeGeneration = 0;
  /** The generation the last completed save exported; the writes after it are unsaved. */
  private savedGeneration = 0;
  /** The save in progress, if any. */
  private saving: Promise<void> | null = null;
  /** The generation the save in progress exported. */
  private savingGeneration = 0;
  /** Whether a failed auto-save has been reported since the last one that succeeded. */
  private saveFailureReported = false;
  /** The open() in progress, which a second call waits for. */
  private opening: Promise<void> | null = null;
  /** Set while close() runs: no statement or transaction starts. */
  private closing = false;
  /** The close() in progress, which a second call waits for. */
  private closeRun: Promise<void> | null = null;
  private longWaitReported = false;
  private lockWaitReported = false;
  /** The stamp of the image the database in memory was loaded from or last saved as. */
  private loadedStamp: string | null = null;
  /** How many stamps this adapter has made, which keeps two of its stamps apart. */
  private stampCount = 0;
  /** The connection settings a fresh connection has, which a save need not set again. */
  private pragmaDefaults = new Map<string, unknown>();
  /**
   * With `crossTab`, the lock manager, or null for the version stamp alone;
   * undefined without `crossTab`.
   */
  private locks: IndexedDbLockManager | null | undefined = undefined;
  /** Without Web Locks, this adapter's coordinated operations run one at a time. */
  private readonly runCoordinatedInTurn = createSerializedTransactionRunner();
  /**
   * The connection is shared, so transaction() runs one callback at a time.
   */
  private readonly runSerializedTransaction = createSerializedTransactionRunner();
  /**
   * Holds statements from outside an open transaction until it ends, so they
   * neither join it (and vanish in its rollback) nor read what it has not
   * committed. Browsers have no async context to tell the callback's own
   * statements apart, so the callback's handle is the only way into an open
   * transaction: a statement through the adapter itself waits.
   */
  private readonly gate = createConnectionGate(null, { withoutContext: 'wait' });
  private readonly longWait: LongWaitWatch = {
    afterMs: LONG_WAIT_MS,
    onLongWait: () => this.reportLongWait(),
  };

  private readonly dbName: string;
  private readonly storeName: string;
  private readonly autoSave: boolean;
  private readonly saveIntervalMs: number;
  private readonly durability: IndexedDbDurability;
  private readonly crossTab: IndexedDbCrossTabOptions | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly sqlJsConfig: any;

  /** @throws {Error} When `options.segment` is not a name a segment can take. */
  constructor(options: IndexedDbAdapterOptions = {}) {
    this.dbName = segmentName(options.dbName || 'app-db', options.segment);
    this.storeName = options.storeName || 'sqliteDb';
    this.autoSave = options.autoSave ?? true;
    this.saveIntervalMs = options.saveIntervalMs || 5000;
    this.sqlJsConfig = options.sqlJsConfig || {};
    this.crossTab =
      options.crossTab === true ? {} : typeof options.crossTab === 'object' && options.crossTab !== null ? options.crossTab : null;
    this.durability = this.crossTab ? 'commit' : options.durability ?? 'interval';
  }

  /** The name of the Web Lock that coordinates the tabs on this database. */
  private get lockName(): string {
    return `@framers/sql-storage-adapter:indexeddb:${this.dbName}:${this.storeName}`;
  }

  /**
   * Opens IndexedDB and initializes sql.js database.
   * Loads existing database from IndexedDB if present.
   *
   * Uses a global sql.js singleton to prevent race conditions when
   * multiple adapters (e.g., fabric_codex_db and quarry-codex-local)
   * are initialized simultaneously. Two calls at once open once.
   */
  public open(options?: StorageOpenOptions): Promise<void> {
    if (this.db) {
      return Promise.resolve(); // Already open
    }
    if (!this.opening) {
      this.foreignKeys = options?.foreignKeys;
      this.opening = this.openNow().finally(() => {
        this.opening = null;
      });
    }
    return this.opening;
  }

  private async openNow(): Promise<void> {
    // Initialize sql.js using global singleton (prevents race conditions)
    this.SQL = await getGlobalSQL(this.sqlJsConfig);

    // Open IndexedDB with retry logic for race conditions
    this.idb = await this.openIndexedDbWithRetry();

    // Load existing database from IndexedDB or create new
    const stored = await this.loadFromIndexedDb();
    const db = stored.image ? new this.SQL.Database(stored.image) : new this.SQL.Database();
    // What a fresh connection has, and export() returns to. Read before the
    // settings open() was asked for, so a save carries those like any other a
    // caller made.
    this.pragmaDefaults = readPragmas(db);
    this.db = db;
    this.loadedStamp = stored.stamp;
    this.applyConnectionSettings();

    if (this.crossTab) {
      this.locks = this.resolveLocks(this.crossTab);
    } else if (this.autoSave) {
      // Start auto-save interval; with crossTab every write is saved under the lock.
      this.startAutoSave();
    }
  }

  /** The lock manager crossTab uses, or null for the version stamp alone. */
  private resolveLocks(options: IndexedDbCrossTabOptions): IndexedDbLockManager | null {
    if (options.locks !== undefined) {
      return options.locks;
    }
    const scope = globalThis as unknown as { navigator?: { locks?: Partial<IndexedDbLockManager> } };
    const locks = scope.navigator?.locks;
    if (locks && typeof locks.request === 'function') {
      return locks as IndexedDbLockManager;
    }
    console.warn(
      `[IndexedDbAdapter] Web Locks are not available here, so "${this.dbName}" coordinates tabs by its version stamp alone: ` +
        'a statement another tab saved over runs again, and a transaction() another tab saved over fails with IndexedDbConflictError.',
    );
    return null;
  }

  /**
   * Executes a SQL statement that doesn't return rows (INSERT, UPDATE, DELETE, CREATE, etc.).
   * @param statement SQL statement with ? or :name placeholders
   * @param parameters Positional array or named object
   * @returns Result with changes count and last insert row ID
   */
  public async run(statement: string, parameters?: StorageParameters): Promise<StorageRunResult> {
    if (this.crossTab) {
      return this.coordinatedStatement(() => this.runNow(statement, parameters));
    }
    return whenAdmitted(this.gate, () => this.stored(this.runNow(statement, parameters)), undefined, this.longWait);
  }

  private runNow(statement: string, parameters?: StorageParameters): StorageRunResult {
    ({ statement, parameters } = toSqliteStatement(statement, parameters));
    this.ensureOpen();
    const stmt = this.db!.prepare(statement);
    try {
      const { named, positional } = normaliseParameters(parameters);
      if (named) {
        stmt.bind(expandNamedParameters(named));
      } else if (positional) {
        stmt.bind(positional);
      }
      stmt.step();

      const rowIdResult = this.db!.exec('SELECT last_insert_rowid() AS id');
      const rawRowId = rowIdResult[0]?.values?.[0]?.[0];
      const lastInsertRowid = this.normaliseRowId(rawRowId);
      this.writeGeneration += 1;

      return {
        changes: this.db!.getRowsModified(),
        lastInsertRowid,
      };
    } finally {
      stmt.free();
    }
  }

  /**
   * Executes a SQL query and returns the first row.
   * @param statement SELECT statement
   * @param parameters Query parameters
   * @returns First row as object or null if no results
   */
  public async get<T>(statement: string, parameters?: StorageParameters): Promise<T | null> {
    const rows = await this.all<T>(statement, parameters);
    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * Executes a SQL query and returns all matching rows. A statement that
   * writes (`INSERT ... RETURNING`) is saved like a `run()`.
   * @param statement SELECT statement
   * @param parameters Query parameters
   * @returns Array of result rows as objects
   */
  public async all<T>(statement: string, parameters?: StorageParameters): Promise<T[]> {
    if (this.crossTab) {
      return this.coordinatedStatement(() => this.allNow<T>(statement, parameters));
    }
    return whenAdmitted(
      this.gate,
      () => {
        const before = this.writeGeneration;
        const rows = this.allNow<T>(statement, parameters);
        return this.writeGeneration === before ? rows : this.stored(rows);
      },
      undefined,
      this.longWait,
    );
  }

  private allNow<T>(statement: string, parameters?: StorageParameters): T[] {
    ({ statement, parameters } = toSqliteStatement(statement, parameters));
    this.ensureOpen();
    // A statement that is not a plain read can write (INSERT ... RETURNING,
    // WITH ... DELETE): it marks the database unsaved when it changed rows,
    // and a statement that can only write marks it whatever it changed.
    const keyword = firstKeyword(statement);
    const reads = keyword === 'SELECT' || keyword === 'EXPLAIN' || keyword === 'VALUES';
    const mayWrite = keyword === 'WITH' || keyword === 'PRAGMA';
    const changesBefore = mayWrite ? this.totalChanges() : 0;
    const stmt = this.db!.prepare(statement);
    try {
      const { named, positional } = normaliseParameters(parameters);
      if (named) {
        stmt.bind(expandNamedParameters(named));
      } else if (positional) {
        stmt.bind(positional);
      }

      const results: T[] = [];
      const columnNames = stmt.getColumnNames();

      while (stmt.step()) {
        const row = stmt.get();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const obj: any = {};
        columnNames.forEach((col: string, idx: number) => {
          obj[col] = row[idx];
        });
        results.push(obj as T);
      }

      if (!reads && (!mayWrite || this.totalChanges() !== changesBefore)) {
        this.writeGeneration += 1;
      }
      return results;
    } finally {
      stmt.free();
    }
  }

  /** The rows changed on this connection since it opened. */
  private totalChanges(): number {
    return Number(this.db!.exec('SELECT total_changes()')[0]?.values?.[0]?.[0] ?? 0);
  }

  /**
   * Executes a script containing multiple SQL statements.
   */
  public async exec(script: string): Promise<void> {
    if (this.crossTab) {
      return this.coordinatedStatement(() => this.execNow(script));
    }
    return whenAdmitted(this.gate, () => this.stored(this.execNow(script)), undefined, this.longWait);
  }

  private execNow(script: string): void {
    this.ensureOpen();
    try {
      this.db!.exec(script);
    } finally {
      // A script that fails part way keeps the statements before the failure.
      this.writeGeneration += 1;
    }
  }

  /**
   * With `durability: 'commit'`, resolves with `result` once the write that
   * produced it is stored; otherwise with `result` at once.
   */
  private stored<T>(result: T): T | Promise<T> {
    if (this.durability !== 'commit') {
      return result;
    }
    return this.saveThrough(this.writeGeneration).then(() => result);
  }

  /**
   * Executes a callback within a database transaction.
   *
   * Callbacks run one at a time, since every transaction shares the one
   * connection. The callback's statements go through the handle it receives;
   * a statement issued through the adapter itself while the callback runs
   * waits until the transaction ends, so a callback must not await one. The
   * auto-save tick does not save while a transaction is open. With
   * `durability: 'commit'` the transaction resolves once it is stored.
   */
  public async transaction<T>(fn: (trx: StorageAdapter) => Promise<T>): Promise<T> {
    this.ensureOpen();
    if (this.crossTab) {
      return this.coordinatedTransaction(fn);
    }
    const queued = setTimeout(() => this.reportLongWait(), LONG_WAIT_MS);
    return this.runSerializedTransaction(async () => {
      clearTimeout(queued);
      const result = await this.transactionNow(fn);
      if (this.durability === 'commit') {
        // The gate is open again, and the next transaction waits for this save.
        await this.saveThrough(this.writeGeneration);
      }
      return result;
    });
  }

  /** Runs one transaction: BEGIN, the callback through its handle, COMMIT or ROLLBACK. */
  private transactionNow<T>(fn: (trx: StorageAdapter) => Promise<T>): Promise<T> {
    return this.gate.hold(async (token) => {
      this.ensureOpen();
      // Outside the try: when BEGIN fails, the transaction that is open
      // (a caller's own BEGIN) is not this one to roll back.
      this.db!.run('BEGIN TRANSACTION');
      const transactionAdapter = createSharedConnectionTransactionAdapter(this.handleStatements(token));
      try {
        const result = await fn(transactionAdapter);
        this.ensureOpen();
        this.db!.run('COMMIT');
        // The callback may have written through all() or get() (INSERT ...
        // RETURNING); the commit marks the database unsaved in any case.
        this.writeGeneration += 1;
        return result;
      } catch (error) {
        this.rollbackQuietly();
        throw error;
      }
    });
  }

  /**
   * The statements of one transaction's handle: they carry the transaction's
   * token, so the gate admits them while the transaction is open.
   */
  private handleStatements(token: symbol): StorageAdapter {
    return {
      kind: this.kind,
      capabilities: this.capabilities,
      open: async () => {},
      close: async () => {},
      run: (statement, parameters) => whenAdmitted(this.gate, () => this.runNow(statement, parameters), token),
      get: async <T>(statement: string, parameters?: StorageParameters) => {
        const rows = await whenAdmitted(this.gate, () => this.allNow<T>(statement, parameters), token);
        return rows.length > 0 ? rows[0] : null;
      },
      all: <T>(statement: string, parameters?: StorageParameters) =>
        whenAdmitted(this.gate, () => this.allNow<T>(statement, parameters), token),
      exec: (script) => whenAdmitted(this.gate, () => this.execNow(script), token),
      // The handle answers a nested transaction() itself and never calls this.
      transaction: (fn) => fn(this),
    };
  }

  /** Rolls back the open transaction; one that already ended (a failed statement, close()) is left alone. */
  private rollbackQuietly(): void {
    if (!this.db) return;
    try {
      this.db.run('ROLLBACK');
    } catch {
      // No transaction is open.
    }
  }

  /**
   * Begins a transaction the caller ends with commit() or rollback(). It is not
   * the callback form: other callers' statements are not held out of it. With
   * `crossTab` it is refused: use transaction().
   */
  public async beginTransaction(): Promise<void> {
    await this.run('BEGIN');
  }

  /**
   * Commits the current transaction.
   */
  public async commit(): Promise<void> {
    await this.run('COMMIT');
  }

  /**
   * Rolls back the current transaction.
   */
  public async rollback(): Promise<void> {
    await this.run('ROLLBACK');
  }

  /**
   * Stores every write made so far in IndexedDB. A `transaction()` that is
   * open is waited for and stored with the rest; a transaction a caller began
   * with `BEGIN` cannot be stored without ending it, so flush() rejects while
   * one is open. Resolves at once when nothing is waiting to be saved.
   */
  public async flush(): Promise<void> {
    this.ensureOpen();
    if (this.crossTab) {
      // Every write is stored before it resolves; this stores one whose save
      // failed, unless another tab has saved since.
      await this.coordinatedStatement(() => undefined);
      return;
    }
    const target = this.writeGeneration;
    while (this.savedGeneration < target && this.db && this.idb) {
      if (this.saving) {
        const covering = this.savingGeneration >= target;
        try {
          await this.saving;
        } catch (error) {
          if (covering) throw error;
        }
        continue;
      }
      if (this.gate.openToken() !== null) {
        await this.gate.ended();
        continue;
      }
      if (this.inTransaction()) {
        throw new Error(
          `IndexedDbAdapter: flush() cannot store "${this.dbName}" while a transaction begun with BEGIN is open: ` +
            "sql.js's export would end it. COMMIT or ROLLBACK it first.",
        );
      }
      await this.startSave();
    }
  }

  /**
   * Closes the database and saves its committed state to IndexedDB.
   *
   * A transaction still open is rolled back, as closing a SQLite connection
   * does, before the save; the save then holds committed writes only. A call
   * made while a close is running waits for that close.
   */
  public close(): Promise<void> {
    if (!this.closeRun) {
      this.closeRun = this.closeNow().finally(() => {
        this.closeRun = null;
      });
    }
    return this.closeRun;
  }

  private async closeNow(): Promise<void> {
    if (this.opening) {
      await this.opening.catch(() => undefined);
    }
    if (this.saveTimer) {
      clearInterval(this.saveTimer);
      this.saveTimer = null;
    }

    if (this.db) {
      // From here no statement or transaction starts: a transaction() still
      // running fails at its next statement, and one queued behind it fails
      // when it starts.
      this.closing = true;
      try {
        if (this.inTransaction()) {
          this.rollbackQuietly();
        }
        if (this.crossTab) {
          // Under the lock, once the transaction that holds it has failed: a
          // write whose save failed is stored, unless another tab saved since.
          await this.withCoordination(async () => {
            if (this.db && this.hasUnsavedWrites()) {
              await this.saveIfStampIs(this.loadedStamp);
            }
          });
        } else {
          await this.settleSave();
          if (this.hasUnsavedWrites()) {
            await this.startSave();
          }
        }
        this.db?.close();
        this.db = null;
      } finally {
        this.closing = false;
      }
    }

    if (this.idb) {
      this.idb.close();
      this.idb = null;
    }
  }

  /**
   * Exports the database as a Uint8Array (SQLite file format).
   * Can be downloaded or stored externally. With `crossTab` it is this tab's
   * image, which another tab's save can have overtaken.
   *
   * Throws while a transaction is open: sql.js's export closes and reopens the
   * connection, which would end the transaction.
   * @returns SQLite database file as binary
   */
  public exportDatabase(): Uint8Array {
    this.ensureOpen();
    if (this.inTransaction()) {
      throw new Error(
        "IndexedDbAdapter: cannot export the database while a transaction is open; sql.js's export would end it.",
      );
    }
    return this.exportImage();
  }

  /**
   * Applies the connection settings open() was asked for. sql.js loses them
   * whenever export() reopens the connection; a save, an export, an import
   * and a reload set them again with the other settings a caller changed
   * (exportImage, replaceDatabase).
   */
  private applyConnectionSettings(): void {
    if (this.foreignKeys !== undefined) {
      this.db!.run(`PRAGMA foreign_keys = ${this.foreignKeys ? 'ON' : 'OFF'};`);
    }
  }

  /**
   * Imports a database from a Uint8Array (SQLite file).
   * Replaces the current database once any open transaction() has ended, and
   * saves it to IndexedDB before it resolves; with `crossTab`, in place of
   * what every tab stored. Bytes that are not a SQLite database are refused,
   * and the adapter keeps its database.
   * @param data SQLite database file
   */
  public async importDatabase(data: Uint8Array): Promise<void> {
    this.ensureOpen();
    if (this.crossTab) {
      await this.withCoordination(async () => {
        this.swapIn(data);
        await this.saveIfStampIs(undefined);
      });
      return;
    }
    await whenAdmitted(
      this.gate,
      () => {
        this.swapIn(data);
        // The save exports in this turn, so no transaction can open between
        // the swap and the export and hold the save back.
        return this.startSave();
      },
      undefined,
      this.longWait,
    );
  }

  /** Replaces the database with an image, once sql.js has read it as a SQLite database. */
  private swapIn(data: Uint8Array): void {
    this.ensureOpen();
    const imported = new this.SQL!.Database(data);
    try {
      // sqlite3_open reads nothing; the first statement reads the header.
      imported.exec('SELECT count(*) FROM sqlite_master');
    } catch (error) {
      imported.close();
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`IndexedDbAdapter: the image to import is not a SQLite database that sql.js can read (${reason}).`);
    }
    this.replaceDatabase(imported);
    this.writeGeneration += 1;
  }

  /** Puts `next` in place of the database, with the connection settings the current one has. */
  private replaceDatabase(next: SqlJsDatabase): void {
    const settings = this.changedPragmas();
    this.db!.close();
    this.db = next;
    this.applyPragmas(settings);
  }

  // ==========================================================================
  // Across tabs
  // ==========================================================================

  /**
   * Runs `work` with this tab holding the database: under the Web Lock, or,
   * without Web Locks, after this adapter's earlier coordinated work.
   */
  private withCoordination<T>(work: () => Promise<T>): Promise<T> {
    const waiting = setTimeout(() => this.reportLockWait(), LONG_WAIT_MS);
    const start = (): Promise<T> => {
      clearTimeout(waiting);
      return work();
    };
    const locks = this.locks;
    const held = locks ? locks.request(this.lockName, { mode: 'exclusive' }, start) : this.runCoordinatedInTurn(start);
    return held.finally(() => clearTimeout(waiting));
  }

  /**
   * One statement across tabs: on the newest stored image, and stored before
   * it resolves. Without Web Locks another tab can save between the load and
   * the save; the statement then runs again on that tab's image.
   */
  private coordinatedStatement<T>(statement: () => T): Promise<T> {
    return this.withCoordination(async () => {
      for (let attempt = 1; ; attempt += 1) {
        this.ensureOpen();
        await this.syncFromStore();
        const result = statement();
        if (this.inTransaction()) {
          // A BEGIN cannot hold the database across tabs between two calls.
          this.rollbackQuietly();
          throw new Error(
            `IndexedDbAdapter: "${this.dbName}" coordinates tabs, so a transaction begun with BEGIN through run() or exec() ` +
              'cannot be held open; it was rolled back. Use transaction().',
          );
        }
        if (!this.hasUnsavedWrites() || (await this.saveIfStampIs(this.loadedStamp))) {
          return result;
        }
        if (attempt >= MAX_CONFLICT_RETRIES) {
          await this.syncFromStore();
          throw new IndexedDbConflictError(
            `IndexedDbAdapter: other tabs saved "${this.dbName}" before each of ${attempt} attempts to store a statement; nothing of it is stored.`,
          );
        }
        // Another tab saved first: load its image, and run the statement on it.
        await this.syncFromStore();
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 4 * attempt));
      }
    });
  }

  /**
   * One transaction across tabs: on the newest stored image, and stored before
   * it resolves. Without Web Locks another tab can save while the callback
   * runs; the transaction is then refused, nothing of it is stored, and the
   * other tab's image is loaded for the caller to run it again.
   */
  private coordinatedTransaction<T>(fn: (trx: StorageAdapter) => Promise<T>): Promise<T> {
    return this.withCoordination(async () => {
      this.ensureOpen();
      await this.syncFromStore();
      const result = await this.runSerializedTransaction(() => this.transactionNow(fn));
      if (this.hasUnsavedWrites() && !(await this.saveIfStampIs(this.loadedStamp))) {
        await this.syncFromStore();
        throw new IndexedDbConflictError(
          `IndexedDbAdapter: another tab saved "${this.dbName}" while this transaction ran, so nothing of it is stored. ` +
            "That tab's writes are loaded; run the transaction again.",
        );
      }
      return result;
    });
  }

  /** Loads the stored image when another tab (or adapter) has saved since this one loaded or saved. */
  private async syncFromStore(): Promise<void> {
    const stored = await this.readIfChanged(this.loadedStamp);
    if (!stored || !this.db) {
      return;
    }
    // The image in memory gives way: what it held that was not stored was
    // refused to its callers when its save failed.
    this.replaceDatabase(stored.image ? new this.SQL!.Database(stored.image) : new this.SQL!.Database());
    this.loadedStamp = stored.stamp;
    this.savedGeneration = this.writeGeneration;
  }

  /** Reads the stored stamp, and the image with it when the stamp is not `known`; null when it is. */
  private readIfChanged(known: string | null): Promise<StoredImage | null> {
    return this.withTransactionRetry(
      () =>
        new Promise<StoredImage | null>((resolve, reject) => {
          const tx = this.idb!.transaction(this.storeName, 'readonly');
          const store = tx.objectStore(this.storeName);
          let answer: StoredImage | null = null;
          const stampRequest = store.get(STAMP_KEY);
          stampRequest.onsuccess = () => {
            const stamp = typeof stampRequest.result === 'string' ? stampRequest.result : null;
            if (stamp === known) return;
            const imageRequest = store.get(IMAGE_KEY);
            imageRequest.onsuccess = () => {
              answer = { image: (imageRequest.result as Uint8Array | undefined) ?? null, stamp };
            };
          };
          tx.oncomplete = () => resolve(answer);
          tx.onabort = () => reject(tx.error ?? new Error(`IndexedDbAdapter: reading "${this.dbName}" was aborted.`));
        }),
    );
  }

  /**
   * Stores the image when the stored stamp is still `expected`, in one
   * IndexedDB transaction, so no other tab's save lands between the check and
   * the write. `undefined` stores it whatever the stamp is. Resolves with
   * whether it stored the image.
   */
  private async saveIfStampIs(expected: string | null | undefined): Promise<boolean> {
    const generation = this.writeGeneration;
    const image = this.exportImage();
    const stamp = this.nextStamp();
    const stored = await this.withTransactionRetry(
      () =>
        new Promise<boolean>((resolve, reject) => {
          const tx = this.idb!.transaction(this.storeName, 'readwrite');
          const store = tx.objectStore(this.storeName);
          let wrote = false;
          const write = (): void => {
            store.put(image, IMAGE_KEY);
            store.put(stamp, STAMP_KEY);
            wrote = true;
          };
          if (expected === undefined) {
            write();
          } else {
            const current = store.get(STAMP_KEY);
            current.onsuccess = () => {
              const found = typeof current.result === 'string' ? current.result : null;
              if (found === expected) write();
            };
          }
          tx.oncomplete = () => resolve(wrote);
          tx.onabort = () =>
            reject(tx.error ?? new Error(`IndexedDbAdapter: saving "${this.dbName}" to IndexedDB was aborted.`));
        }),
    );
    if (stored) {
      this.loadedStamp = stamp;
      this.savedGeneration = Math.max(this.savedGeneration, generation);
    }
    return stored;
  }

  /** A stamp no other save of this or another tab writes. */
  private nextStamp(): string {
    this.stampCount += 1;
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${this.stampCount}`;
  }

  // ==========================================================================
  // Saving
  // ==========================================================================

  /**
   * Exports the database for a save, keeping the connection settings a
   * caller made: sql.js's export() closes the connection and opens it again.
   */
  private exportImage(): Uint8Array {
    const settings = this.changedPragmas();
    const image = this.db!.export();
    this.applyPragmas(settings);
    return image;
  }

  /** The connection settings that differ from a fresh connection's. */
  private changedPragmas(): Map<string, unknown> {
    const changed = new Map<string, unknown>();
    if (!this.db) return changed;
    for (const [name, value] of readPragmas(this.db)) {
      if (this.pragmaDefaults.get(name) !== value) changed.set(name, value);
    }
    return changed;
  }

  /** Sets connection settings on the database, after a save or a reload. */
  private applyPragmas(settings: Map<string, unknown>): void {
    for (const [name, value] of settings) {
      const literal = typeof value === 'number' ? String(value) : `'${String(value).replace(/'/g, "''")}'`;
      try {
        this.db!.exec(`PRAGMA ${name} = ${literal}`);
      } catch {
        // A setting this build of SQLite does not take is left as it is.
      }
    }
  }

  /**
   * Opens or creates the IndexedDB database.
   */
  private openIndexedDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, DB_VERSION);

      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName);
        }
      };

      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Opens IndexedDB with retry logic and exponential backoff.
   * Handles race conditions when multiple adapters initialize simultaneously.
   *
   * The "NotFoundError" for object stores typically occurs when:
   * 1. Two adapters try to open/upgrade simultaneously
   * 2. One adapter opens the DB while another is still upgrading
   * 3. Schema version mismatch during concurrent initialization
   *
   * @param maxRetries Maximum number of retry attempts (default: 3)
   * @param baseDelayMs Base delay in milliseconds (default: 100)
   */
  private async openIndexedDbWithRetry(maxRetries = 3, baseDelayMs = 100): Promise<IDBDatabase> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.openIndexedDb();
      } catch (error) {
        lastError = error;

        // Check if this is a retryable error
        const isNotFoundError = error instanceof DOMException && error.name === 'NotFoundError';
        const isVersionError = error instanceof DOMException && error.name === 'VersionError';
        const isRetryable = isNotFoundError || isVersionError;

        if (!isRetryable || attempt === maxRetries) {
          break;
        }

        // Exponential backoff: 100ms, 200ms, 400ms, ...
        const delay = baseDelayMs * Math.pow(2, attempt);
        console.warn(
          `[IndexedDbAdapter] Retrying IndexedDB open for "${this.dbName}" ` +
          `(attempt ${attempt + 1}/${maxRetries + 1}, delay: ${delay}ms)`,
          error
        );

        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw lastError;
  }

  /**
   * Loads the SQLite database and its stamp from IndexedDB, in one
   * transaction, so the two belong together.
   */
  private async loadFromIndexedDb(): Promise<StoredImage> {
    if (!this.idb) return { image: null, stamp: null };

    return this.withTransactionRetry(
      () =>
        new Promise<StoredImage>((resolve, reject) => {
          const tx = this.idb!.transaction(this.storeName, 'readonly');
          const store = tx.objectStore(this.storeName);
          const image = store.get(IMAGE_KEY);
          const stamp = store.get(STAMP_KEY);
          tx.oncomplete = () =>
            resolve({
              image: (image.result as Uint8Array | undefined) ?? null,
              stamp: typeof stamp.result === 'string' ? stamp.result : null,
            });
          tx.onabort = () => reject(tx.error ?? new Error(`IndexedDbAdapter: reading "${this.dbName}" was aborted.`));
        }),
    );
  }

  /**
   * Writes the current image to IndexedDB, with a new stamp. Never called
   * while a transaction is open (see saveIfIdle): sql.js's export() closes and
   * reopens the connection, which ends an open transaction.
   *
   * Settles when the IndexedDB transaction completes, not when its put request
   * succeeds: the transaction can still abort after that (a quota error at
   * commit), and the image is then not stored. On abort the writes stay
   * unsaved, so the next save writes them. A write made after the export stays
   * unsaved too.
   */
  private async saveToIndexedDb(): Promise<void> {
    if (!this.idb || !this.db) return;
    // exportImage() sets the connection settings again after the export.
    await this.saveIfStampIs(undefined);
  }

  /** Whether writes were made since the image the last completed save exported. */
  private hasUnsavedWrites(): boolean {
    return this.writeGeneration !== this.savedGeneration;
  }

  /**
   * Whether a transaction is open on the connection: one transaction() is
   * running, or one the caller began with BEGIN or SAVEPOINT. sql.js does not
   * export sqlite3_get_autocommit, so the adapter asks SQLite: BEGIN fails
   * inside a transaction, and outside one it is rolled back at once. A probe
   * that fails for any reason counts as open, so the adapter does not export.
   */
  private inTransaction(): boolean {
    if (this.gate.openToken() !== null) return true;
    if (!this.db) return false;
    try {
      this.db.run('BEGIN');
    } catch {
      return true;
    }
    try {
      this.db.run('ROLLBACK');
    } catch {
      // The probe's own transaction did not roll back; it is open.
      return true;
    }
    return false;
  }

  /**
   * Starts a save of the unsaved writes, unless a save is running or a
   * transaction is open; the auto-save tick tries again later.
   */
  private saveIfIdle(): Promise<void> {
    if (this.saving) return this.saving;
    if (!this.db || !this.idb || !this.hasUnsavedWrites() || this.inTransaction()) {
      return Promise.resolve();
    }
    return this.startSave();
  }

  /**
   * Resolves once the writes up to `generation` are stored. A save in
   * progress that holds them is waited for; an open transaction() is waited
   * for, since its own save holds them; while a transaction a caller began
   * with BEGIN is open, nothing can be stored, and its COMMIT stores them.
   * Rejects when the save that held them failed.
   */
  private async saveThrough(generation: number): Promise<void> {
    while (this.savedGeneration < generation && this.db && this.idb) {
      if (this.saving) {
        const covering = this.savingGeneration >= generation;
        try {
          await this.saving;
        } catch (error) {
          if (covering) throw error;
        }
        continue;
      }
      if (this.gate.openToken() !== null) {
        await this.gate.ended();
        continue;
      }
      if (this.inTransaction()) {
        return;
      }
      await this.startSave();
    }
  }

  /**
   * Starts a save at once and keeps it as the save in progress. The caller has
   * made sure no transaction is open: the export would end it.
   */
  private startSave(): Promise<void> {
    this.savingGeneration = this.writeGeneration;
    const saving = this.saveToIndexedDb().finally(() => {
      if (this.saving === saving) this.saving = null;
    });
    this.saving = saving;
    return saving;
  }

  /** Waits for a save in progress to settle, whether it succeeded or not. */
  private async settleSave(): Promise<void> {
    if (this.saving) {
      await this.saving.catch(() => undefined);
    }
  }

  private reportLongWait(): void {
    if (this.longWaitReported) return;
    this.longWaitReported = true;
    console.warn(
      `[IndexedDbAdapter] A statement on "${this.dbName}" has waited ${LONG_WAIT_MS / 1000} s for an open transaction to end. ` +
        "Inside a transaction() callback, run statements through the callback's handle: one run through the adapter " +
        'itself waits for the transaction, and the transaction waits for it.',
    );
  }

  private reportLockWait(): void {
    if (this.lockWaitReported) return;
    this.lockWaitReported = true;
    console.warn(
      `[IndexedDbAdapter] A statement on "${this.dbName}" has waited ${LONG_WAIT_MS / 1000} s for its turn across tabs: ` +
        "another tab's transaction holds the lock, or a transaction() of this tab whose callback runs a statement through " +
        "the adapter itself instead of the callback's handle waits on itself.",
    );
  }

  /**
   * Wraps a transaction operation with retry logic.
   * Handles "NotFoundError" by reopening IndexedDB connection.
   */
  private async withTransactionRetry<T>(
    operation: () => Promise<T>,
    maxRetries = 2
  ): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;

        // Check if this is a "store not found" error that can be fixed by reopening
        const isNotFoundError = error instanceof DOMException && error.name === 'NotFoundError';

        if (!isNotFoundError || attempt === maxRetries) {
          break;
        }

        // Try to reopen the IndexedDB connection
        console.warn(
          `[IndexedDbAdapter] Transaction failed for "${this.dbName}", ` +
          `reopening connection (attempt ${attempt + 1}/${maxRetries + 1})`,
          error
        );

        try {
          if (this.idb) {
            this.idb.close();
          }
          this.idb = await this.openIndexedDbWithRetry();
        } catch (reopenError) {
          console.error('[IndexedDbAdapter] Failed to reopen IndexedDB:', reopenError);
          throw lastError; // Throw original error
        }
      }
    }

    throw lastError;
  }

  /**
   * Starts auto-save interval.
   */
  private startAutoSave(): void {
    this.saveTimer = setInterval(() => {
      void this.autoSaveTick();
    }, this.saveIntervalMs);
  }

  /** One auto-save tick: a failed save is reported once and tried again on the next tick. */
  private async autoSaveTick(): Promise<void> {
    try {
      await this.saveIfIdle();
      this.saveFailureReported = false;
    } catch (error) {
      if (!this.saveFailureReported) {
        this.saveFailureReported = true;
        console.warn(`[IndexedDbAdapter] Saving "${this.dbName}" to IndexedDB failed; the next tick tries again.`, error);
      }
    }
  }

  /**
   * Ensures the database is open.
   */
  private ensureOpen(): void {
    if (!this.db || this.closing) {
      throw new Error('IndexedDbAdapter: Database not open. Call open() first.');
    }
  }

  /**
   * Normalizes last insert row ID to string or number.
   */
  private normaliseRowId(value: unknown): string | number | null {
    if (typeof value === 'number' || typeof value === 'string') {
      return value;
    }
    if (typeof value === 'bigint') {
      return value.toString();
    }
    return null;
  }
}

/** The connection settings of `db`, by name. A setting this build does not have is left out. */
const readPragmas = (db: SqlJsDatabase): Map<string, unknown> => {
  const values = new Map<string, unknown>();
  for (const name of CONNECTION_PRAGMAS) {
    try {
      const value = db.exec(`PRAGMA ${name}`)[0]?.values?.[0]?.[0];
      if (value !== undefined) values.set(name, value);
    } catch {
      // Not in this build of SQLite.
    }
  }
  return values;
};
