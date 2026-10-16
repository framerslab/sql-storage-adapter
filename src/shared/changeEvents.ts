import type { BatchOperation, BatchResult, StorageAdapter, StorageParameters, StorageRunResult } from '../core/contracts';
import { getStorageLogger } from './logger';
import { splitSqlStatements } from './splitSqlStatements';
import { writtenTables, type RowChangeOperation } from './statementTarget';

export type { RowChangeOperation } from './statementTarget';

/** A write to a table, reported once it has committed. */
export interface RowChange {
  /** The table, as the statement names it, unquoted: `notes`, or `app.notes` when the statement qualifies it. */
  table: string;
  operation: RowChangeOperation;
  /**
   * The rows the engine counted, from run() and batch(), which report only a
   * statement that changed a row. get(), all() and exec() report the statement
   * without a count.
   */
  changes?: number;
  /** run()'s lastInsertRowid, for an insert. */
  lastInsertRowid?: StorageRunResult['lastInsertRowid'];
  /** The statement that made the change. */
  statement: string;
}

/** Which changes a listener hears. */
export interface RowChangeOptions {
  /**
   * The tables to hear, by name, case aside; a schema-qualified change
   * (`app.notes`) is heard by its full name or its table's (`notes`).
   */
  tables?: string[];
}

/** A listener for row changes. */
export type RowChangeListener = (change: RowChange) => void;

/** What withChangeEvents adds to an adapter. */
export interface ChangeEvents {
  /** Calls `listener` with each change made through the adapter once it commits. Returns a function that stops it. */
  onChange(listener: RowChangeListener, options?: RowChangeOptions): () => void;
}

type Emit = (changes: RowChange[]) => void;

/** The changes `statement` made, with the count when the call gave one. */
const changesOf = (statement: string, result?: StorageRunResult): RowChange[] => {
  if (result && !(result.changes > 0)) return [];
  return writtenTables(statement).map(({ table, operation }) => ({
    table,
    operation,
    ...(result ? { changes: result.changes } : {}),
    ...(result && operation === 'insert' ? { lastInsertRowid: result.lastInsertRowid } : {}),
    statement,
  }));
};

/** The changes of a batch's operations that succeeded, matched to their results in order. */
const batchChanges = (operations: BatchOperation[], result: BatchResult): RowChange[] => {
  const failed = new Set((result.errors ?? []).map((entry) => entry.index));
  if (failed.has(-1)) return [];
  const results = result.results ?? [];
  const changes: RowChange[] = [];
  let next = 0;
  operations.forEach((operation, index) => {
    if (failed.has(index)) return;
    // An adapter whose batch gives no results reports the statement without a count.
    const outcome = results[next++];
    changes.push(...changesOf(operation.statement, outcome));
  });
  return changes;
};

/** The adapter, or a handle inside a transaction or on a held connection, reporting its writes to `emit`. */
const reporting = <A extends StorageAdapter>(target: A, emit: Emit): A => {
  const overrides: Partial<Record<string | symbol, unknown>> = {
    run: async (statement: string, parameters?: StorageParameters): Promise<StorageRunResult> => {
      const result = await target.run(statement, parameters);
      emit(changesOf(statement, result));
      return result;
    },
    get: async <T>(statement: string, parameters?: StorageParameters): Promise<T | null> => {
      const row = await target.get<T>(statement, parameters);
      emit(changesOf(statement));
      return row;
    },
    all: async <T>(statement: string, parameters?: StorageParameters): Promise<T[]> => {
      const rows = await target.all<T>(statement, parameters);
      emit(changesOf(statement));
      return rows;
    },
    exec: async (script: string): Promise<void> => {
      await target.exec(script);
      emit(splitSqlStatements(script).flatMap((statement) => changesOf(statement)));
    },
    transaction: async <T>(fn: (trx: StorageAdapter) => Promise<T>, ...rest: unknown[]): Promise<T> => {
      // The transaction's changes wait for its commit; a rollback drops them.
      const held: RowChange[] = [];
      const transaction = target.transaction as (fn: (trx: StorageAdapter) => Promise<T>, ...rest: unknown[]) => Promise<T>;
      const result = await transaction.call(target, (trx: StorageAdapter) => fn(reporting(trx, (changes) => held.push(...changes))), ...rest);
      emit(held);
      return result;
    },
  };
  if (typeof target.batch === 'function') {
    overrides.batch = async (operations: BatchOperation[]): Promise<BatchResult> => {
      const result = await (target.batch as (operations: BatchOperation[]) => Promise<BatchResult>).call(target, operations);
      emit(batchChanges(operations, result));
      return result;
    };
  }
  const withConnection = (target as { withConnection?: unknown }).withConnection;
  if (typeof withConnection === 'function') {
    overrides.withConnection = <T>(fn: (connection: StorageAdapter) => Promise<T>): Promise<T> =>
      (withConnection as (fn: (connection: StorageAdapter) => Promise<T>) => Promise<T>).call(target, (connection) =>
        fn(reporting(connection, emit)),
      );
  }

  return new Proxy(target, {
    get(object, property) {
      if (Object.prototype.hasOwnProperty.call(overrides, property)) return overrides[property];
      const value = Reflect.get(object, property, object);
      return typeof value === 'function' ? value.bind(object) : value;
    },
  });
};

/**
 * The adapter, reporting each write made through it: an INSERT (REPLACE and
 * upserts included), UPDATE, DELETE or TRUNCATE, through run(), get(), all(),
 * exec(), batch(), transaction() and, on PostgreSQL, withConnection(). A write
 * is reported once it commits: at once outside a transaction, when
 * transaction() commits inside one, and not at all when it rolls back.
 *
 * The changes are those made through this adapter: another adapter, another
 * process, or a transaction begun with BEGIN through run() (reported as its
 * statements run) is outside it. On PostgreSQL, `listen()` and the dialect's
 * `changeNotificationSql` report writes from every session.
 *
 * A listener that throws is logged through the host logger, and the write
 * goes on.
 *
 * @example
 * ```typescript
 * const db = withChangeEvents(await createDatabase());
 * const stop = db.onChange((change) => cache.invalidate(change.table), { tables: ['notes'] });
 * ```
 */
export function withChangeEvents<A extends StorageAdapter>(adapter: A): A & ChangeEvents {
  const listeners = new Set<{ listener: RowChangeListener; tables: Set<string> | null }>();

  const hears = (tables: Set<string> | null, change: RowChange): boolean => {
    if (!tables) return true;
    const name = change.table.toLowerCase();
    return tables.has(name) || tables.has(name.slice(name.lastIndexOf('.') + 1));
  };

  const reportFailure = (change: RowChange, error: unknown): void => {
    getStorageLogger().warn(
      { scope: 'withChangeEvents', table: change.table, operation: change.operation, error: error instanceof Error ? error.message : String(error) },
      `A row-change listener failed on ${change.operation} of ${change.table}; the write stands.`,
    );
  };

  const emit: Emit = (changes) => {
    for (const change of changes) {
      for (const entry of [...listeners]) {
        if (!hears(entry.tables, change)) continue;
        try {
          const returned = entry.listener(change) as unknown;
          if (returned && typeof (returned as Promise<unknown>).catch === 'function') {
            (returned as Promise<unknown>).catch((error) => reportFailure(change, error));
          }
        } catch (error) {
          reportFailure(change, error);
        }
      }
    }
  };

  const wrapped = reporting(adapter, emit);
  const onChange = (listener: RowChangeListener, options: RowChangeOptions = {}): (() => void) => {
    const entry = { listener, tables: options.tables ? new Set(options.tables.map((table) => table.toLowerCase())) : null };
    listeners.add(entry);
    return () => {
      listeners.delete(entry);
    };
  };

  return new Proxy(wrapped, {
    get(object, property) {
      if (property === 'onChange') return onChange;
      return Reflect.get(object, property);
    },
  }) as A & ChangeEvents;
}
