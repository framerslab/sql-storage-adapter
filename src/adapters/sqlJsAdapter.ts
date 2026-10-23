import initSqlJs from 'sql.js';
import type { SqlJsStatic, SqlJsConfig, Database as SqlJsDatabase } from 'sql.js';
import fs from 'fs';
import path from 'path';
import type { StorageAdapter, StorageCapability, StorageOpenOptions, StorageParameters, StorageRunResult } from '../core/contracts';
import { expandNamedParameters, normaliseParameters } from '../shared/parameterUtils';
import { toSqliteStatement } from '../shared/sqlPlaceholders';
import { checkFunctionName, type SqlFunction, type SqlFunctionOptions } from '../shared/sqlFunctions';
import {
  createSerializedTransactionRunner,
  createSharedConnectionTransactionAdapter,
} from '../shared/serializedTransaction';
import { namesInMemoryDatabase, segmentFilePath, validateSegment } from '../shared/segment';
import { queryWrites, type QueryWrite } from '../shared/queryWrites';
import { exportKeepingSettings } from '../shared/sqlJsConnectionSettings';
import { getStorageLogger } from '../shared/logger';

/** sql.js's own configuration (`locateFile` and the rest), and the adapter's segment. */
export type SqlJsAdapterOptions = SqlJsConfig & {
  /**
   * A database file of its own: the segment goes into the name of the file
   * `open({ filePath })` names, before its extension (`app.sqlite3` becomes
   * `app-agentos.sqlite3`). An in-memory database is its own already.
   */
  segment?: string;
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const normaliseRowId = (value: unknown): string | number | null => {
  if (typeof value === 'number' || typeof value === 'string') {
    return value;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  return null;
};

const hasFsAccess = (): boolean => {
  try {
    return typeof fs.accessSync === 'function';
  } catch {
    return false;
  }
};

/**
 * Storage adapter backed by sql.js (WebAssembly) for environments without native SQLite bindings.
 *
 * With a `filePath`, the adapter writes the database image to the file after
 * each write, once SQLite has no transaction open: a statement through run(),
 * a script through exec() (the statements before a failure included), a
 * statement through all() or get() that can write (see queryWrites, which the
 * IndexedDB adapter reads too), and the end of a transaction(). It does not
 * save while SQLite has a transaction open, whatever began it (transaction(),
 * BEGIN or SAVEPOINT through run(), or a script), since sql.js's export()
 * closes and reopens the connection, which would roll the transaction back;
 * the save after its COMMIT or RELEASE writes it. The connection's PRAGMA
 * settings are read before each export and set again after it, and the
 * functions registerFunction() made are registered again. TEMP tables,
 * attached databases and functions registered on the sql.js database itself
 * do not survive a save; the adapter warns once, through the host logger, when
 * a save drops TEMP objects.
 */
export class SqlJsAdapter implements StorageAdapter {
  public readonly kind = 'sqljs';
  public readonly capabilities: ReadonlySet<StorageCapability>;

  private SQL: SqlJsStatic | null = null;
  private db: SqlJsDatabase | null = null;
  private filePath?: string;
  /** Foreign-key enforcement as open() was asked for it (undefined: the engine default), set on the connection open() makes. */
  private foreignKeys: boolean | undefined;
  /** The functions registerFunction made callable from SQL, registered again after each reopening. */
  private readonly sqlFunctions = new Map<string, SqlFunction>();
  private readonly runSerializedTransaction = createSerializedTransactionRunner();
  /**
   * 1 while a transaction() callback runs. SQLite has a transaction open then,
   * so a save is skipped without asking SQLite.
   */
  private transactionRunning = 0;
  /** Set while close() runs: no statement starts. */
  private closing = false;
  /** The close() in progress, which a second call waits for. */
  private closeRun: Promise<void> | null = null;
  /** Whether a save that dropped TEMP objects has been reported. */
  private tempDropReported = false;
  private readonly sqlJsConfig: SqlJsConfig;
  private readonly segment: string | undefined;

  constructor(adapterOptions: SqlJsAdapterOptions = {}) {
    const { segment, ...sqlJsConfig } = adapterOptions;
    this.segment = segment === undefined ? undefined : validateSegment(segment);
    this.sqlJsConfig = sqlJsConfig;
    const caps: StorageCapability[] = ['transactions', 'json', 'prepared'];
    if (hasFsAccess()) {
      caps.push('persistence');
    }
    this.capabilities = new Set(caps);
  }

  public async open(options?: StorageOpenOptions): Promise<void> {
    if (this.db) {
      return;
    }

    this.SQL = await initSqlJs(this.sqlJsConfig);
    // ':memory:' names a database of the connection alone: no file holds it.
    const requested = options?.filePath;
    this.filePath =
      requested === undefined || namesInMemoryDatabase(requested) ? undefined : segmentFilePath(requested, this.segment);
    this.foreignKeys = options?.foreignKeys;

    if (this.filePath && hasFsAccess() && fs.existsSync(this.filePath)) {
      const buffer = fs.readFileSync(this.filePath);
      this.db = new this.SQL.Database(buffer);
    } else {
      this.db = new this.SQL.Database();
    }
    this.applyConnectionSettings();
  }

  /**
   * Runs one statement. With a `filePath`, the database is saved to the file
   * after it unless SQLite has a transaction open; a transaction's statements
   * are saved by the save after its COMMIT. A statement that fails part way
   * (`INSERT OR FAIL`, `UPDATE OR FAIL`) keeps the rows it changed before the
   * failure, as SQLite's FAIL resolution does, and they are saved too.
   */
  public async run(statement: string, parameters?: StorageParameters): Promise<StorageRunResult> {
    ({ statement, parameters } = toSqliteStatement(statement, parameters));
    const stmt = this.prepareInternal(statement);
    let result: StorageRunResult;
    try {
      const { named, positional } = normaliseParameters(parameters);
      if (named) {
        stmt.bind(expandNamedParameters(named));
      } else if (positional) {
        stmt.bind(positional);
      }
      stmt.step();
      // Read before the save, whose export reopens the connection.
      const rowIdResult = this.db!.exec('SELECT last_insert_rowid() AS id');
      const rawRowId = rowIdResult[0]?.values?.[0]?.[0];
      result = {
        changes: this.db!.getRowsModified(),
        lastInsertRowid: normaliseRowId(rawRowId)
      };
    } catch (error) {
      // Freed before the save, whose export frees every statement it finds.
      stmt.free();
      await this.persistQuietly();
      throw error;
    }
    stmt.free();
    await this.persistIfNeeded();
    return result;
  }

  public async get<T>(statement: string, parameters?: StorageParameters): Promise<T | null> {
    const rows = await this.all<T>(statement, parameters);
    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * Runs a statement and returns its rows. A statement that writes (`INSERT
   * ... RETURNING`, a `PRAGMA` that sets a header field such as
   * `user_version`) is saved to the file as a run() is; see {@link queryWrites}.
   */
  public async all<T>(statement: string, parameters?: StorageParameters): Promise<T[]> {
    ({ statement, parameters } = toSqliteStatement(statement, parameters));
    const writes = queryWrites(statement);
    const stmt = this.prepareInternal(statement);
    const changesBefore = writes === 'if-rows-changed' ? this.totalChanges() : 0;
    const results: T[] = [];
    try {
      const { named, positional } = normaliseParameters(parameters);
      if (named) {
        stmt.bind(expandNamedParameters(named));
      } else if (positional) {
        stmt.bind(positional);
      }

      while (stmt.step()) {
        const row: Record<string, unknown> = {};
        stmt.getColumnNames().forEach((column: string, index: number) => {
          row[column] = stmt.get()[index];
        });
        results.push(row as T);
      }
    } catch (error) {
      stmt.free();
      // The rows a statement changed before it failed (INSERT OR FAIL ...
      // RETURNING) stay, and are saved as a failed script's statements are.
      if (this.wrote(writes, changesBefore)) await this.persistQuietly();
      throw error;
    }
    stmt.free();
    if (this.wrote(writes, changesBefore)) {
      await this.persistIfNeeded();
    }
    return results;
  }

  /** Whether a statement all() or get() ran can have changed the database; see {@link queryWrites}. */
  private wrote(writes: QueryWrite, changesBefore: number): boolean {
    return writes === 'yes' || (writes === 'if-rows-changed' && this.totalChanges() !== changesBefore);
  }

  /**
   * Runs a script of one or more statements. With a `filePath`, the database
   * is saved after it unless SQLite has a transaction open, which a script
   * can begin (`BEGIN; INSERT ...`) or end (`INSERT ...; COMMIT`). A script
   * that fails part way keeps the statements before the failure, and they are
   * saved as a script's that succeeds are; the script's error is the one
   * thrown.
   */
  public async exec(script: string): Promise<void> {
    this.ensureOpen();
    try {
      this.db!.exec(script);
    } catch (error) {
      await this.persistQuietly();
      throw error;
    }
    await this.persistIfNeeded();
  }

  /**
   * Runs `fn` in a transaction: COMMIT when it resolves, ROLLBACK when it
   * throws. Callbacks run one at a time, since they share the connection, and
   * the database is saved to the file once the transaction has ended. A nested
   * transaction() on the handle runs in the open transaction.
   */
  public async transaction<T>(fn: (trx: StorageAdapter) => Promise<T>): Promise<T> {
    this.ensureOpen();
    return this.runSerializedTransaction(async () => {
      this.ensureOpen();
      // BEGIN goes to sql.js directly. The FIFO runner is required because
      // every callback shares this connection.
      this.db!.run('BEGIN TRANSACTION;');
      this.transactionRunning += 1;
      const transactionAdapter = createSharedConnectionTransactionAdapter(this);
      let result: T;
      try {
        result = await fn(transactionAdapter);
        this.ensureOpen();
        this.db!.run('COMMIT;');
      } catch (error) {
        this.transactionRunning -= 1;
        // A close() during the callback has rolled the transaction back and
        // closed the database; the callback's error is the one to report.
        if (this.db && this.sqliteTransactionOpen()) {
          try {
            this.db.run('ROLLBACK;');
          } catch (rollbackError) {
            // sql.js can end the transaction itself on some DDL failures.
            // Keep the original error rather than mask it with the rollback's.
            if (!messageOf(rollbackError).includes('no transaction is active')) {
              throw rollbackError;
            }
          }
        }
        await this.persistQuietly();
        throw error;
      }
      this.transactionRunning -= 1;
      await this.persistIfNeeded();
      return result;
    });
  }

  /**
   * Saves the committed state to the file and closes the database. A
   * transaction still open is rolled back first, as closing a SQLite
   * connection does, so the save holds committed writes only. A call made
   * while a close is running waits for that close. The adapter can be opened
   * again.
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
    if (!this.db) {
      return;
    }
    // From here no statement starts: a transaction() callback still running
    // fails at its next statement.
    this.closing = true;
    try {
      if (this.sqliteTransactionOpen()) {
        try {
          this.db.run('ROLLBACK');
        } catch {
          // The transaction ended already.
        }
      }
      await this.saveToFile();
      this.db.close();
      this.db = null;
    } finally {
      this.closing = false;
    }
  }

  private prepareInternal(statement: string) {
    this.ensureOpen();
    return this.db!.prepare(statement);
  }

  private ensureOpen(): void {
    if (!this.db || this.closing) {
      throw new Error('Storage adapter not opened. Call open() first.');
    }
  }

  /**
   * Applies the connection settings open() was asked for (foreignKeys), on the
   * connection open() makes, and registers the functions registerFunction()
   * keeps. A save to the file keeps the connection's settings from then on
   * (see saveToFile()), a PRAGMA the caller ran after open() included.
   */
  private applyConnectionSettings(): void {
    if (this.foreignKeys !== undefined) {
      this.db!.run(`PRAGMA foreign_keys = ${this.foreignKeys ? 'ON' : 'OFF'};`);
    }
    this.applyFunctions();
  }

  /** Registers the functions registerFunction keeps: sql.js drops them when export() reopens the connection. */
  private applyFunctions(): void {
    for (const [name, fn] of this.sqlFunctions) {
      this.db!.create_function(name, fn);
    }
  }

  /**
   * Makes a JavaScript function callable from SQL under `name`. It is
   * registered again whenever sql.js reopens the connection (each save to a
   * file), which drops the functions it had.
   */
  public registerFunction(name: string, fn: SqlFunction, _options: SqlFunctionOptions = {}): void {
    this.sqlFunctions.set(checkFunctionName(name), fn);
    if (this.db) this.db.create_function(name, fn);
  }

  /**
   * Saves the database to the file unless a transaction is open; inside a
   * transaction() callback without asking SQLite (see saveToFile()).
   */
  private async persistIfNeeded(): Promise<void> {
    if (this.transactionRunning > 0) {
      return;
    }
    await this.saveToFile();
  }

  /**
   * Writes the database image to the file. Skipped while SQLite has a
   * transaction open, whatever began it: sql.js's export() closes and reopens
   * the connection, which would roll the transaction back. The save after its
   * COMMIT writes it. The connection's PRAGMA settings are read before the
   * export and set again after it, and the registered functions with them.
   */
  private async saveToFile(): Promise<void> {
    if (!this.db || !this.filePath || !hasFsAccess()) {
      return;
    }
    if (this.sqliteTransactionOpen()) {
      return;
    }
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const data = exportKeepingSettings(this.db, {
      onRefused: (name, value, error) => {
        getStorageLogger().warn(
          { scope: this.kind, pragma: name, error: messageOf(error) },
          `Could not set PRAGMA ${name} = ${value} again on the connection sql.js reopened to save the database.`,
        );
      },
      onTempObjectsDropped: (count) => {
        if (this.tempDropReported) return;
        this.tempDropReported = true;
        getStorageLogger().warn(
          { scope: this.kind, file: this.filePath, tempObjects: count },
          `A save to ${this.filePath} dropped the connection's TEMP tables, views, indexes and triggers (${count}): ` +
            'sql.js reopens its connection to read the database image, and TEMP objects do not survive that. ' +
            'Keep such state in the main database.',
        );
      },
    });
    // export() dropped the functions with the connection it closed.
    this.applyFunctions();
    fs.writeFileSync(this.filePath, Buffer.from(data));
  }

  /**
   * persistIfNeeded() for a path that is already failing: a save that fails
   * too is logged, and the next save writes what it held.
   */
  private async persistQuietly(): Promise<void> {
    try {
      await this.persistIfNeeded();
    } catch (error) {
      getStorageLogger().warn(
        { scope: this.kind, file: this.filePath, error: messageOf(error) },
        'Saving the database to its file failed after a failed statement; the next save writes it.',
      );
    }
  }

  /**
   * Whether SQLite has a transaction open on the connection: one transaction()
   * or the caller began, a savepoint, or one a script began. sql.js does not
   * export sqlite3_get_autocommit, so the adapter asks SQLite: BEGIN fails
   * inside a transaction, and outside one it is rolled back at once. A probe
   * that fails for any reason counts as open, so the adapter does not export.
   */
  private sqliteTransactionOpen(): boolean {
    try {
      this.db!.run('BEGIN');
    } catch {
      return true;
    }
    try {
      this.db!.run('ROLLBACK');
    } catch {
      return true;
    }
    return false;
  }

  /** SQLite's count of the rows changed since the connection opened. */
  private totalChanges(): number {
    return Number(this.db!.exec('SELECT total_changes()')[0]?.values?.[0]?.[0] ?? 0);
  }
}

/**
 * Creates a sql.js adapter. `open({ filePath })` loads the database from that
 * file and saves it there; with `segment`, from a file of the segment's own.
 *
 * @throws {Error} When `segment` is not a name a segment can take.
 */
export const createSqlJsAdapter = (options?: SqlJsAdapterOptions): StorageAdapter => new SqlJsAdapter(options);
