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
 * import { IndexedDbAdapter } from '@framers/sql-storage-adapter/adapters/indexedDbAdapter';
 * 
 * const adapter = new IndexedDbAdapter({
 *   dbName: 'my-app-db',
 *   autoSave: true,
 *   saveIntervalMs: 5000,
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
import { normaliseParameters } from '../shared/parameterUtils';
import { toSqliteStatement } from '../shared/sqlPlaceholders';
import {
  createSerializedTransactionRunner,
  createSharedConnectionTransactionAdapter,
} from '../shared/serializedTransaction';
import { createConnectionGate, whenAdmitted, type LongWaitWatch } from '../shared/connectionGate';

/** How long a statement waits for an open transaction before the adapter warns. */
const LONG_WAIT_MS = 10_000;

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
 * Configuration for IndexedDB adapter.
 */
export interface IndexedDbAdapterOptions {
  /** IndexedDB database name (default: 'app-db') */
  dbName?: string;
  /** IndexedDB object store name (default: 'sqliteDb') */
  storeName?: string;
  /** Auto-save to IndexedDB after each write (default: true) */
  autoSave?: boolean;
  /** Save interval in milliseconds for batched writes (default: 5000) */
  saveIntervalMs?: number;
  /** sql.js configuration (e.g., locateFile for wasm) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sqlJsConfig?: any;
}

const DB_VERSION = 1;

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
 * **Is This Necessary?**
 * 
 * **✅ YES** if you need:
 * - Data to survive page refreshes (production apps)
 * - Offline-first functionality (PWAs)
 * - Privacy-first apps (data never leaves browser)
 * - Zero manual save logic (just works)
 * 
 * **❌ NO** if you:
 * - Only need temporary/in-memory data (edge functions)
 * - Are prototyping and don't care about persistence
 * - Want to manually control when data is saved
 * - Don't need data to survive refreshes
 * 
 * **Alternative:** You could use sql.js directly and manually save to IndexedDB yourself, but you'd lose:
 * - Automatic batched saves (performance optimization)
 * - Reliable persistence (easy to forget manual saves = data loss)
 * - Consistent API across platforms
 * - Production-ready defaults
 * 
 * **Bottom line:** This adapter is **necessary for production web apps** that need persistence. For prototypes or edge functions, sql.js alone is fine.
 * 
 * **How It Works:**
 * 1. IndexedDB stores the SQLite database file (binary blob) - this is just storage
 * 2. sql.js (WASM) loads the database into memory and executes SQL - this provides SQL capabilities
 * 3. After writes, the updated database is automatically saved back to IndexedDB
 * 
 * **Why IndexedDB + sql.js?**
 * - IndexedDB alone: NoSQL key-value store, no SQL support
 * - sql.js alone: In-memory SQL, but **no automatic persistence** (you must manually save)
 * - Combined: Full SQL + **automatic browser-native persistence** = production-ready solution
 * 
 * **Capabilities:**
 * - ✅ Transactions (via sql.js)
 * - ✅ Persistence (via IndexedDB - automatic!)
 * - ✅ Full SQL support (via sql.js)
 * - ✅ Export/import
 * - ❌ Concurrent writes (single-threaded)
 * - ❌ Server-side (browser only)
 * 
 * **Performance:**
 * - Fast reads (in-memory SQL)
 * - Moderate writes (IndexedDB persistence)
 * - Auto-save batching reduces IDB overhead
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
  /** Whether open() was asked to enforce foreign keys; sql.js forgets the PRAGMA when export() reopens the connection. */
  private foreignKeys = false;
  private idb: IDBDatabase | null = null;
  private saveTimer: ReturnType<typeof setInterval> | null = null;
  /** Bumped by every statement that can change the database. */
  private writeGeneration = 0;
  /** The generation the last completed save exported; the writes after it are unsaved. */
  private savedGeneration = 0;
  /** The save in progress, if any. */
  private saving: Promise<void> | null = null;
  /** Whether a failed auto-save has been reported since the last one that succeeded. */
  private saveFailureReported = false;
  /** Set while close() runs: no statement or transaction starts. */
  private closing = false;
  /** The close() in progress, which a second call waits for. */
  private closeRun: Promise<void> | null = null;
  private longWaitReported = false;
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly sqlJsConfig: any;

  constructor(options: IndexedDbAdapterOptions = {}) {
    this.dbName = options.dbName || 'app-db';
    this.storeName = options.storeName || 'sqliteDb';
    this.autoSave = options.autoSave ?? true;
    this.saveIntervalMs = options.saveIntervalMs || 5000;
    this.sqlJsConfig = options.sqlJsConfig || {};
  }

  /**
   * Opens IndexedDB and initializes sql.js database.
   * Loads existing database from IndexedDB if present.
   *
   * Uses a global sql.js singleton to prevent race conditions when
   * multiple adapters (e.g., fabric_codex_db and quarry-codex-local)
   * are initialized simultaneously.
   */
  public async open(options?: StorageOpenOptions): Promise<void> {
    if (this.db) {
      return; // Already open
    }
    this.foreignKeys = options?.foreignKeys === true;

    // Initialize sql.js using global singleton (prevents race conditions)
    this.SQL = await getGlobalSQL(this.sqlJsConfig);

    // Open IndexedDB with retry logic for race conditions
    this.idb = await this.openIndexedDbWithRetry();

    // Load existing database from IndexedDB or create new
    const existingData = await this.loadFromIndexedDb();
    if (existingData) {
      this.db = new this.SQL.Database(existingData);
    } else {
      this.db = new this.SQL.Database();
    }
    this.applyConnectionSettings();

    // Start auto-save interval
    if (this.autoSave) {
      this.startAutoSave();
    }
  }

  /**
   * Executes a SQL statement that doesn't return rows (INSERT, UPDATE, DELETE, CREATE, etc.).
   * @param statement SQL statement with ? or :name placeholders
   * @param parameters Positional array or named object
   * @returns Result with changes count and last insert row ID
   */
  public async run(statement: string, parameters?: StorageParameters): Promise<StorageRunResult> {
    return whenAdmitted(this.gate, () => this.runNow(statement, parameters), undefined, this.longWait);
  }

  private runNow(statement: string, parameters?: StorageParameters): StorageRunResult {
    ({ statement, parameters } = toSqliteStatement(statement, parameters));
    this.ensureOpen();
    const stmt = this.db!.prepare(statement);
    try {
      const { named, positional } = normaliseParameters(parameters);
      if (named) {
        stmt.bind(named);
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
   * Executes a SQL query and returns all matching rows.
   * @param statement SELECT statement
   * @param parameters Query parameters
   * @returns Array of result rows as objects
   */
  public async all<T>(statement: string, parameters?: StorageParameters): Promise<T[]> {
    return whenAdmitted(this.gate, () => this.allNow<T>(statement, parameters), undefined, this.longWait);
  }

  private allNow<T>(statement: string, parameters?: StorageParameters): T[] {
    ({ statement, parameters } = toSqliteStatement(statement, parameters));
    this.ensureOpen();
    const stmt = this.db!.prepare(statement);
    try {
      const { named, positional } = normaliseParameters(parameters);
      if (named) {
        stmt.bind(named);
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

      return results;
    } finally {
      stmt.free();
    }
  }

  /**
   * Executes a script containing multiple SQL statements.
   */
  public async exec(script: string): Promise<void> {
    return whenAdmitted(this.gate, () => this.execNow(script), undefined, this.longWait);
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
   * Executes a callback within a database transaction.
   *
   * Callbacks run one at a time, since every transaction shares the one
   * connection. The callback's statements go through the handle it receives;
   * a statement issued through the adapter itself while the callback runs
   * waits until the transaction ends, so a callback must not await one. The
   * auto-save tick does not save while a transaction is open.
   */
  public async transaction<T>(fn: (trx: StorageAdapter) => Promise<T>): Promise<T> {
    this.ensureOpen();
    const queued = setTimeout(() => this.reportLongWait(), LONG_WAIT_MS);
    return this.runSerializedTransaction(() => {
      clearTimeout(queued);
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
          // RETURNING), which mark nothing unsaved; the commit does.
          this.writeGeneration += 1;
          return result;
        } catch (error) {
          this.rollbackQuietly();
          throw error;
        }
      });
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
   * the callback form: other callers' statements are not held out of it.
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
        await this.settleSave();
        if (this.hasUnsavedWrites()) {
          await this.startSave();
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
   * Can be downloaded or stored externally.
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
    const image = this.db!.export();
    // export() closed and reopened the connection, which reset its PRAGMAs.
    this.applyConnectionSettings();
    return image;
  }

  /** Applies the connection settings open() was asked for: sql.js loses them whenever export() reopens the connection. */
  private applyConnectionSettings(): void {
    if (this.foreignKeys) {
      this.db!.run('PRAGMA foreign_keys = ON;');
    }
  }

  /**
   * Imports a database from a Uint8Array (SQLite file).
   * Replaces the current database once any open transaction() has ended, and
   * saves it to IndexedDB before it resolves.
   * @param data SQLite database file
   */
  public async importDatabase(data: Uint8Array): Promise<void> {
    this.ensureOpen();
    await whenAdmitted(
      this.gate,
      () => {
        this.ensureOpen();
        // Opened before the current database closes: an image sql.js refuses
        // leaves the adapter on the database it had.
        const imported = new this.SQL!.Database(data);
        this.db!.close();
        this.db = imported;
        this.applyConnectionSettings();
        this.writeGeneration += 1;
        // The save exports in this turn, so no transaction can open between
        // the swap and the export and hold the save back.
        return this.startSave();
      },
      undefined,
      this.longWait,
    );
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
   * Loads the SQLite database from IndexedDB.
   * @returns Binary database or null if not found
   */
  private async loadFromIndexedDb(): Promise<Uint8Array | null> {
    if (!this.idb) return null;

    return this.withTransactionRetry(async () => {
      return new Promise((resolve, reject) => {
        const tx = this.idb!.transaction(this.storeName, 'readonly');
        const store = tx.objectStore(this.storeName);
        const req = store.get('db');

        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    });
  }

  /**
   * Writes the current image to IndexedDB. Never called while a transaction is
   * open (see saveIfIdle): sql.js's export() closes and reopens the connection,
   * which ends an open transaction.
   *
   * Settles when the IndexedDB transaction completes, not when its put request
   * succeeds: the transaction can still abort after that (a quota error at
   * commit), and the image is then not stored. On abort the writes stay
   * unsaved, so the next save writes them. A write made after the export stays
   * unsaved too.
   */
  private async saveToIndexedDb(): Promise<void> {
    if (!this.idb || !this.db) return;

    const generation = this.writeGeneration;
    const data = this.db.export();
    // export() closed and reopened the connection, which reset its PRAGMAs.
    this.applyConnectionSettings();

    await this.withTransactionRetry(
      () =>
        new Promise<void>((resolve, reject) => {
          const tx = this.idb!.transaction(this.storeName, 'readwrite');
          tx.objectStore(this.storeName).put(data, 'db');
          tx.oncomplete = () => resolve();
          // A failed request aborts the transaction, so abort covers both.
          tx.onabort = () =>
            reject(tx.error ?? new Error(`IndexedDbAdapter: saving "${this.dbName}" to IndexedDB was aborted.`));
        }),
    );
    this.savedGeneration = Math.max(this.savedGeneration, generation);
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
   * Starts a save at once and keeps it as the save in progress. The caller has
   * made sure no transaction is open: the export would end it.
   */
  private startSave(): Promise<void> {
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

  /**
   * Prepares a SQL statement for execution.
   */
  private prepareInternal(statement: string) {
    this.ensureOpen();
    return this.db!.prepare(statement);
  }
}
