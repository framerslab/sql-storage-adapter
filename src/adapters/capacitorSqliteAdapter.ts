import type {
  StorageAdapter,
  StorageCapability,
  StorageOpenOptions,
  StorageParameters,
  StorageRunResult
} from '../core/contracts';
import { normaliseParameters } from '../shared/parameterUtils';
import { toSqliteStatement } from '../shared/sqlPlaceholders';
import {
  createSerializedTransactionRunner,
  createSharedConnectionTransactionAdapter,
} from '../shared/serializedTransaction';
import { createConnectionGate, whenAdmitted, type LongWaitWatch } from '../shared/connectionGate';
import { leadingKeyword } from '../shared/leadingKeyword';
import { splitSqlStatements } from '../shared/splitSqlStatements';

import type { CapacitorSQLitePlugin, SQLiteConnection, SQLiteDBConnection } from '@capacitor-community/sqlite';

/** How long a statement waits for an open transaction before the adapter warns. */
const LONG_WAIT_MS = 10_000;

export interface CapacitorAdapterOptions {
  /**
   * Database name. Defaults to `app`.
   */
  database?: string;
  /**
   * Whether to turn on WAL (write-ahead logging) when the adapter opens.
   * Default: true.
   */
  enableWal?: boolean;
}

/** The exports of @capacitor-community/sqlite the adapter uses. */
interface PluginExports {
  CapacitorSQLite: CapacitorSQLitePlugin;
  SQLiteConnection: new (plugin: CapacitorSQLitePlugin) => SQLiteConnection;
}

const pluginExports = (value: unknown): PluginExports | null => {
  if (!value || typeof value !== 'object') return null;
  if (!('SQLiteConnection' in value) || !('CapacitorSQLite' in value)) return null;
  const candidate = value as { SQLiteConnection: unknown; CapacitorSQLite: unknown };
  if (typeof candidate.SQLiteConnection !== 'function' || !candidate.CapacitorSQLite) return null;
  return candidate as PluginExports;
};

/**
 * Loads @capacitor-community/sqlite and makes the plugin's SQLiteConnection
 * over its native plugin, CapacitorSQLite. SQLiteConnection makes the
 * connections: `createConnection(database, encrypted, mode, version, readonly)`
 * answers a SQLiteDBConnection. CapacitorSQLite's own methods take one options
 * object and answer nothing a statement can run on.
 */
const importSqliteConnection = async (): Promise<SQLiteConnection | null> => {
  let mod: unknown;
  try {
    mod = await import('@capacitor-community/sqlite');
  } catch (error) {
    console.warn('[StorageAdapter] @capacitor-community/sqlite module not available.', error);
    return null;
  }
  // An ES module names its exports; a CommonJS build behind a bundler's
  // interop can hold them on default.
  const plugin =
    pluginExports(mod) ??
    (mod && typeof mod === 'object' && 'default' in mod ? pluginExports((mod as { default?: unknown }).default) : null);
  if (!plugin) {
    console.warn('[StorageAdapter] @capacitor-community/sqlite does not export SQLiteConnection and CapacitorSQLite.');
    return null;
  }
  return new plugin.SQLiteConnection(plugin.CapacitorSQLite);
};

/**
 * One SQLiteConnection for every adapter in the page. A load that fails is
 * tried again by the next open().
 */
let sharedSqliteConnection: Promise<SQLiteConnection | null> | null = null;

const loadSqliteConnection = (): Promise<SQLiteConnection | null> => {
  if (!sharedSqliteConnection) {
    sharedSqliteConnection = importSqliteConnection().then((made) => {
      if (!made) sharedSqliteConnection = null;
      return made;
    });
  }
  return sharedSqliteConnection;
};

/** The databases an adapter of this page has open, or is opening. */
const openDatabases = new Set<string>();

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Creates the connection to a database. The plugin's native side keeps its
 * connections until they are closed, across reloads of the page, so one can be
 * left from before a reload, and createConnection then fails with "Connection
 * <name> already exists". No adapter of this page holds that one (an adapter
 * holding it is refused before this), so it is closed and made again.
 */
const createConnection = async (sqlite: SQLiteConnection, database: string): Promise<SQLiteDBConnection> => {
  try {
    return await sqlite.createConnection(database, false, 'no-encryption', 1, false);
  } catch (error) {
    if (!/already exists/i.test(messageOf(error))) throw error;
    await sqlite.closeConnection(database, false);
    return sqlite.createConnection(database, false, 'no-encryption', 1, false);
  }
};

const isPragma = (statement: string): boolean => leadingKeyword(statement) === 'PRAGMA';

/**
 * A script's PRAGMA statements at its start and at its end, and the statements
 * between them; null when it has none there.
 *
 * The plugin runs execute() and run() inside a transaction of its own, where
 * SQLite ignores PRAGMA foreign_keys and refuses to change the journal mode,
 * and on Android through execSQL, which fails on a statement that answers a
 * row, as PRAGMA journal_mode = WAL does. The adapter sends these PRAGMA
 * statements through query(), which runs a statement as it is: the ones before
 * the rest of the script first, the rest in one execute() call as before, the
 * ones after it last. That is SQLite's procedure for changing a table: foreign
 * keys off, rebuild the table, foreign keys on. A PRAGMA between two other
 * statements stays in the script.
 */
const pragmaEdges = (script: string): { before: string[]; body: string | null; after: string[] } | null => {
  if (!/pragma/i.test(script)) return null;
  const statements = splitSqlStatements(script);
  let start = 0;
  while (start < statements.length && isPragma(statements[start])) start += 1;
  let end = statements.length;
  while (end > start && isPragma(statements[end - 1])) end -= 1;
  if (start === 0 && end === statements.length) return null;
  const body = statements.slice(start, end);
  return {
    before: statements.slice(0, start),
    // Separators on lines of their own, so a statement's trailing -- comment
    // cannot swallow one.
    body: body.length > 0 ? body.join('\n;\n') : null,
    after: statements.slice(end),
  };
};

/**
 * The plugin answers run() with `{ changes: { changes, lastId } }`
 * (`capSQLiteChanges`); a flat `{ changes, lastId }` is read as well.
 */
const toRunResult = (answer: unknown): StorageRunResult => {
  const outer = (answer ?? {}) as { changes?: unknown; lastId?: unknown };
  const inner =
    typeof outer.changes === 'object' && outer.changes !== null
      ? (outer.changes as { changes?: unknown; lastId?: unknown })
      : outer;
  const changes = typeof inner.changes === 'number' ? inner.changes : 0;
  const lastId = inner.lastId;
  return {
    changes,
    lastInsertRowid: typeof lastId === 'number' || typeof lastId === 'string' ? lastId : null,
  };
};

/**
 * Adapter using @capacitor-community/sqlite for native mobile targets.
 *
 * It opens its database through the plugin's SQLiteConnection, one for every
 * adapter in the page, and close() closes the plugin's connection too, so the
 * database can be opened again. One adapter at a time holds a database: a
 * second open() of the same database fails while the first adapter has it.
 *
 * Transactions use the plugin's beginTransaction, commitTransaction and
 * rollbackTransaction (plugin 5.0.7 and later). The plugin runs every other
 * execute and run call in a transaction of its own, which cannot nest in an
 * open one, so the statements of a transaction's callback go to the plugin
 * with `transaction` false. A PRAGMA statement goes through the plugin's
 * query(), outside that transaction of the plugin's own: in a run() call, or
 * at the start or the end of an exec() script.
 */
export class CapacitorSqliteAdapter implements StorageAdapter {
  public readonly kind = 'capacitor-sqlite';
  public readonly capabilities: ReadonlySet<StorageCapability> = new Set<StorageCapability>([
    'transactions',
    'wal',
    'locks',
    'persistence'
  ]);

  /** The SQLiteConnection that made this adapter's connection. */
  private sqlite: SQLiteConnection | null = null;
  /** The name of the database this adapter has open. */
  private openName: string | null = null;
  private connection: SQLiteDBConnection | null = null;
  private dbName: string;
  /** The connection is shared, so transaction() runs one callback at a time. */
  private readonly runSerializedTransaction = createSerializedTransactionRunner();
  /**
   * Holds statements from outside an open transaction until it ends. A WebView
   * has no async context to tell the callback's own statements apart, so the
   * callback's handle is the only way into an open transaction.
   */
  private readonly gate = createConnectionGate(null, { withoutContext: 'wait' });
  /** Statements sent to the plugin from outside a transaction and not yet answered. */
  private readonly inFlight = new Set<Promise<unknown>>();
  private longWaitReported = false;
  private readonly longWait: LongWaitWatch = {
    afterMs: LONG_WAIT_MS,
    onLongWait: () => this.reportLongWait(),
  };

  constructor(private readonly options: CapacitorAdapterOptions = {}) {
    this.dbName = options.database ?? 'app';
  }

  public async open(options?: StorageOpenOptions): Promise<void> {
    if (this.connection) {
      return;
    }

    const adapterOptions = options?.adapterOptions as { database?: unknown } | undefined;
    const requestedName = typeof adapterOptions?.database === 'string' ? adapterOptions.database : undefined;
    const name = requestedName ?? this.options.database ?? this.dbName;

    // Two adapters on one connection would run their transactions into each other.
    if (openDatabases.has(name)) {
      throw new Error(
        `Capacitor SQLite: an adapter already has database "${name}" open. Close it before opening another adapter on the same database.`,
      );
    }
    openDatabases.add(name);

    let sqlite: SQLiteConnection;
    let connection: SQLiteDBConnection;
    try {
      const loaded = await loadSqliteConnection();
      if (!loaded) {
        throw new Error('@capacitor-community/sqlite is unavailable. Install the plugin or choose a different adapter.');
      }
      sqlite = loaded;
      connection = await createConnection(sqlite, name);
      try {
        await connection.open();
      } catch (error) {
        await sqlite.closeConnection(name, false).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      openDatabases.delete(name);
      throw error;
    }

    this.sqlite = sqlite;
    this.openName = name;
    this.connection = connection;

    if (this.options.enableWal ?? true) {
      await this.enableWal(connection);
    }
  }

  public async run(statement: string, parameters?: StorageParameters): Promise<StorageRunResult> {
    return whenAdmitted(this.gate, () => this.track(this.runNow(statement, parameters, true)), undefined, this.longWait);
  }

  public async get<T>(statement: string, parameters?: StorageParameters): Promise<T | null> {
    const rows = await this.all<T>(statement, parameters);
    return rows.length > 0 ? rows[0] : null;
  }

  public async all<T>(statement: string, parameters?: StorageParameters): Promise<T[]> {
    return whenAdmitted(this.gate, () => this.track(this.allNow<T>(statement, parameters)), undefined, this.longWait);
  }

  public async exec(script: string): Promise<void> {
    return whenAdmitted(this.gate, () => this.track(this.execNow(script, true)), undefined, this.longWait);
  }

  /**
   * Executes a callback within a database transaction.
   *
   * Callbacks run one at a time, since every transaction shares the one
   * connection. The callback's statements go through the handle it receives;
   * a statement issued through the adapter itself while the callback runs
   * waits until the transaction ends, so a callback must not await one.
   */
  public async transaction<T>(fn: (trx: StorageAdapter) => Promise<T>): Promise<T> {
    this.ensureConnection();
    const queued = setTimeout(() => this.reportLongWait(), LONG_WAIT_MS);
    return this.runSerializedTransaction(() => {
      clearTimeout(queued);
      return this.gate.hold(async (token) => {
        // The gate now holds new statements back; let the ones already sent
        // answer before the transaction begins.
        await Promise.allSettled([...this.inFlight]);
        const conn = this.ensureConnection();
        // Outside the try: when beginTransaction fails, no transaction of this
        // call is open to roll back.
        await conn.beginTransaction();
        const transactionAdapter = createSharedConnectionTransactionAdapter(this.handleStatements(token));
        try {
          const result = await fn(transactionAdapter);
          await conn.commitTransaction();
          return result;
        } catch (error) {
          try {
            await conn.rollbackTransaction();
          } catch {
            // The transaction already ended.
          }
          throw error;
        }
      });
    });
  }

  /**
   * Closes the database and the plugin's connection to it, so the database can
   * be opened again, by this adapter or another one.
   */
  public async close(): Promise<void> {
    const connection = this.connection;
    if (!connection) {
      return;
    }
    const sqlite = this.sqlite;
    const name = this.openName;
    this.connection = null;
    this.sqlite = null;
    this.openName = null;
    try {
      await connection.close();
    } finally {
      if (sqlite && name !== null) {
        openDatabases.delete(name);
        await sqlite.closeConnection(name, false);
      }
    }
  }

  /**
   * The statements of one transaction's handle: they carry the transaction's
   * token, so the gate admits them while the transaction is open, and run
   * inside the plugin's open transaction.
   */
  private handleStatements(token: symbol): StorageAdapter {
    return {
      kind: this.kind,
      capabilities: this.capabilities,
      open: async () => {},
      close: async () => {},
      run: (statement, parameters) => whenAdmitted(this.gate, () => this.runNow(statement, parameters, false), token),
      get: async <T>(statement: string, parameters?: StorageParameters) => {
        const rows = await whenAdmitted(this.gate, () => this.allNow<T>(statement, parameters), token);
        return rows.length > 0 ? rows[0] : null;
      },
      all: <T>(statement: string, parameters?: StorageParameters) =>
        whenAdmitted(this.gate, () => this.allNow<T>(statement, parameters), token),
      exec: (script) => whenAdmitted(this.gate, () => this.execNow(script, false), token),
      // The handle answers a nested transaction() itself and never calls this.
      transaction: (fn) => fn(this),
    };
  }

  /**
   * Turns on WAL with PRAGMA journal_mode = WAL, through query(): the plugin
   * runs execute() inside a transaction of its own by default, where SQLite
   * refuses to change the journal mode, and on Android through execSQL, which
   * fails on a statement that answers a row, as this PRAGMA does. query() runs
   * it as it is and reads back the mode SQLite answers.
   */
  private async enableWal(connection: SQLiteDBConnection): Promise<void> {
    try {
      const answer = await connection.query<Record<string, unknown>>('PRAGMA journal_mode = WAL;');
      const mode = String(Object.values(answer.values?.[0] ?? {})[0] ?? '').toLowerCase();
      if (mode !== 'wal') {
        console.warn(`[StorageAdapter] Capacitor SQLite kept journal mode "${mode}"; WAL is not on.`);
      }
    } catch (error) {
      console.warn('[StorageAdapter] Failed to enable WAL on Capacitor SQLite.', error);
    }
  }

  /**
   * @param ownTransaction - true for a statement from outside a transaction:
   *   the plugin runs it in a transaction of its own, as it always has. A
   *   PRAGMA goes through query() either way; see pragmaEdges().
   */
  private async runNow(
    statement: string,
    parameters: StorageParameters | undefined,
    ownTransaction: boolean,
  ): Promise<StorageRunResult> {
    ({ statement, parameters } = toSqliteStatement(statement, parameters));
    const conn = this.ensureConnection();
    const { positional } = normaliseParameters(parameters);
    if (isPragma(statement)) {
      await conn.query(statement, positional ?? []);
      return { changes: 0, lastInsertRowid: null };
    }
    return toRunResult(await conn.run(statement, positional ?? [], ownTransaction));
  }

  private async allNow<T>(statement: string, parameters?: StorageParameters): Promise<T[]> {
    ({ statement, parameters } = toSqliteStatement(statement, parameters));
    const conn = this.ensureConnection();
    const { positional } = normaliseParameters(parameters);
    const result = await conn.query(statement, positional ?? []);
    return (result.values ?? []) as T[];
  }

  private async execNow(script: string, ownTransaction: boolean): Promise<void> {
    const conn = this.ensureConnection();
    const parts = pragmaEdges(script);
    if (!parts) {
      await conn.execute(script, ownTransaction);
      return;
    }
    for (const pragma of parts.before) {
      await conn.query(pragma);
    }
    if (parts.body !== null) {
      await conn.execute(parts.body, ownTransaction);
    }
    for (const pragma of parts.after) {
      await conn.query(pragma);
    }
  }

  /** Keeps a statement sent from outside a transaction in `inFlight` until it answers. */
  private track<T>(sent: Promise<T>): Promise<T> {
    this.inFlight.add(sent);
    const forget = () => {
      this.inFlight.delete(sent);
    };
    sent.then(forget, forget);
    return sent;
  }

  private reportLongWait(): void {
    if (this.longWaitReported) return;
    this.longWaitReported = true;
    console.warn(
      `[StorageAdapter] A Capacitor SQLite statement has waited ${LONG_WAIT_MS / 1000} s for an open transaction to end. ` +
        "Inside a transaction() callback, run statements through the callback's handle: one run through the adapter " +
        'itself waits for the transaction, and the transaction waits for it.',
    );
  }

  private ensureConnection(): SQLiteDBConnection {
    if (!this.connection) {
      throw new Error('Storage adapter not opened. Call open() before executing statements.');
    }
    return this.connection;
  }
}

export const createCapacitorSqliteAdapter = (options?: CapacitorAdapterOptions): StorageAdapter =>
  new CapacitorSqliteAdapter(options);
