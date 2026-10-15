import type {
  StorageAdapter,
  StorageCapability,
  StorageOpenOptions,
  StorageParameters,
  StorageRunResult
} from '../core/contracts';
import { normaliseParameters } from '../shared/parameterUtils';
import {
  createSerializedTransactionRunner,
  createSharedConnectionTransactionAdapter,
} from '../shared/serializedTransaction';
import { createConnectionGate, whenAdmitted, type LongWaitWatch } from '../shared/connectionGate';

import type { CapacitorSQLitePlugin, SQLiteDBConnection } from '@capacitor-community/sqlite';

/** How long a statement waits for an open transaction before the adapter warns. */
const LONG_WAIT_MS = 10_000;

export interface CapacitorAdapterOptions {
  /**
   * Database name. Defaults to `app`.
   */
  database?: string;
  /**
   * Whether to enable WAL when platform supports it.
   */
  enableWal?: boolean;
}

const isCapacitorPlugin = (value: unknown): value is CapacitorSQLitePlugin => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as { createConnection?: unknown };
  return typeof candidate.createConnection === 'function';
};

const loadCapacitorSqlite = async (): Promise<CapacitorSQLitePlugin | null> => {
  try {
    const mod: unknown = await import('@capacitor-community/sqlite');

    if (isCapacitorPlugin(mod)) {
      return mod;
    }

    if (mod && typeof mod === 'object') {
      const { default: defaultExport, CapacitorSQLite } = mod as {
        default?: unknown;
        CapacitorSQLite?: unknown;
      };

      if (isCapacitorPlugin(defaultExport)) {
        return defaultExport;
      }
      if (isCapacitorPlugin(CapacitorSQLite)) {
        return CapacitorSQLite;
      }
    }

    return null;
  } catch (error) {
    console.warn('[StorageAdapter] @capacitor-community/sqlite module not available.', error);
    return null;
  }
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
 * Transactions use the plugin's beginTransaction, commitTransaction and
 * rollbackTransaction (plugin 5.0.7 and later). The plugin runs every other
 * execute and run call in a transaction of its own, which cannot nest in an
 * open one, so the statements of a transaction's callback go to the plugin
 * with `transaction` false.
 */
export class CapacitorSqliteAdapter implements StorageAdapter {
  public readonly kind = 'capacitor-sqlite';
  public readonly capabilities: ReadonlySet<StorageCapability> = new Set<StorageCapability>([
    'transactions',
    'wal',
    'locks',
    'persistence'
  ]);

  private plugin: CapacitorSQLitePlugin | null = null;
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

    this.plugin = await loadCapacitorSqlite();
    if (!this.plugin) {
      throw new Error('@capacitor-community/sqlite is unavailable. Install the plugin or choose a different adapter.');
    }

    const adapterOptions = options?.adapterOptions as { database?: unknown } | undefined;
    const requestedName = typeof adapterOptions?.database === 'string' ? adapterOptions.database : undefined;
    const configuredName = this.options.database;
    const resolvedDbName = requestedName ?? configuredName ?? this.dbName;

    this.connection = await this.plugin.createConnection(resolvedDbName, false, 'no-encryption', 1, false);
    await this.connection.open();

    if (this.options.enableWal ?? true) {
      try {
        await this.connection.execute('PRAGMA journal_mode = WAL;');
      } catch (error) {
        console.warn('[StorageAdapter] Failed to enable WAL on Capacitor SQLite.', error);
      }
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

  public async close(): Promise<void> {
    if (this.connection) {
      await this.connection.close();
      this.connection = null;
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
   * @param ownTransaction - true for a statement from outside a transaction:
   *   the plugin runs it in a transaction of its own, as it always has.
   */
  private async runNow(
    statement: string,
    parameters: StorageParameters | undefined,
    ownTransaction: boolean,
  ): Promise<StorageRunResult> {
    const conn = this.ensureConnection();
    const { positional } = normaliseParameters(parameters);
    return toRunResult(await conn.run(statement, positional ?? [], ownTransaction));
  }

  private async allNow<T>(statement: string, parameters?: StorageParameters): Promise<T[]> {
    const conn = this.ensureConnection();
    const { positional } = normaliseParameters(parameters);
    const result = await conn.query(statement, positional ?? []);
    return (result.values ?? []) as T[];
  }

  private async execNow(script: string, ownTransaction: boolean): Promise<void> {
    const conn = this.ensureConnection();
    await conn.execute(script, ownTransaction);
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
