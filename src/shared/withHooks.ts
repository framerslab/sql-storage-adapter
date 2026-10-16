import type { StorageAdapter, StorageParameters, StorageRunResult } from '../core/contracts';
import {
  generateOperationId,
  type OperationContext,
  type QueryContext,
  type StorageHooks,
  type TransactionContext,
  type WriteContext,
} from '../core/contracts/hooks';

/** Errors the hooks of an inner call already handed to onError, so the transaction around it does not hand them again. */
const handled = new WeakSet<object>();

const EMPTY_WRITE: StorageRunResult = { changes: 0, lastInsertRowid: null };

/**
 * The adapter with lifecycle hooks around its calls, on any adapter.
 *
 * - `onBeforeQuery` (get, all, exec) and `onBeforeWrite` (run) see the call's context, and return it, changed or
 *   not, to go on, or undefined to stop the call: a stopped get returns null, all an empty list, run no changes.
 * - `onAfterQuery` can replace the result, and `onAfterWrite` sees it.
 * - `onBeforeTransaction` can stop a transaction, and `onAfterTransaction` sees its outcome. The statements inside a
 *   transaction pass through the hooks too.
 * - `onError` sees each failure and returns the error to throw, or undefined to swallow it.
 *
 * Everything else, the adapter's kind and its own methods (`withConnection` on PostgreSQL), reaches the adapter
 * itself, and `instanceof` still names its class.
 */
export function withHooks<A extends StorageAdapter>(adapter: A, hooks: StorageHooks): A {
  const context = <O extends OperationContext['operation']>(operation: O) => ({
    operationId: generateOperationId(),
    operation,
    startTime: Date.now(),
    adapterKind: adapter.kind,
  });

  /** Hands `error` to onError; throws what it returns, or returns when it swallows the error. */
  const fail = async (error: unknown, at: OperationContext): Promise<void> => {
    const err = error instanceof Error ? error : new Error(String(error));
    if (!hooks.onError || handled.has(err)) throw err;
    const replaced = await hooks.onError(err, at);
    if (!replaced) return;
    handled.add(replaced);
    throw replaced;
  };

  const query = async <T>(
    operation: 'get' | 'all' | 'exec',
    statement: string,
    parameters: StorageParameters | undefined,
    call: (statement: string, parameters?: StorageParameters) => Promise<T>,
    stopped: T
  ): Promise<T> => {
    let at: QueryContext = { ...context(operation), statement, parameters };
    if (hooks.onBeforeQuery) {
      const next = await hooks.onBeforeQuery(at);
      if (!next) return stopped;
      at = next;
    }
    try {
      const result = await call(at.statement, at.parameters);
      if (!hooks.onAfterQuery) return result;
      const replaced = await hooks.onAfterQuery(at, result);
      return replaced === undefined ? result : (replaced as T);
    } catch (error) {
      await fail(error, at);
      return stopped;
    }
  };

  const overrides = {
    get: <T>(statement: string, parameters?: StorageParameters): Promise<T | null> =>
      query<T | null>('get', statement, parameters, (s, p) => adapter.get<T>(s, p), null),

    all: <T>(statement: string, parameters?: StorageParameters): Promise<T[]> =>
      query<T[]>('all', statement, parameters, (s, p) => adapter.all<T>(s, p), []),

    exec: (script: string): Promise<void> => query<void>('exec', script, undefined, (s) => adapter.exec(s), undefined),

    run: async (statement: string, parameters?: StorageParameters): Promise<StorageRunResult> => {
      let at: WriteContext = { ...context('run'), statement, parameters };
      if (hooks.onBeforeWrite) {
        const next = await hooks.onBeforeWrite(at);
        if (!next) return EMPTY_WRITE;
        at = next;
      }
      try {
        const result = await adapter.run(at.statement, at.parameters);
        await hooks.onAfterWrite?.(at, result);
        return result;
      } catch (error) {
        await fail(error, at);
        return EMPTY_WRITE;
      }
    },

    transaction: async <T>(fn: (trx: StorageAdapter) => Promise<T>): Promise<T> => {
      let at: TransactionContext = { ...context('transaction') };
      if (hooks.onBeforeTransaction) {
        const next = await hooks.onBeforeTransaction(at);
        if (!next) return undefined as T;
        at = next;
      }
      try {
        const result = await adapter.transaction((trx) => fn(withHooks(trx, hooks)));
        await hooks.onAfterTransaction?.({ ...at, outcome: 'committed' });
        return result;
      } catch (error) {
        await hooks.onAfterTransaction?.({ ...at, outcome: 'rolled_back' });
        await fail(error, at);
        return undefined as T;
      }
    },
  };

  return new Proxy(adapter, {
    get(target, property) {
      if (Object.prototype.hasOwnProperty.call(overrides, property)) {
        return overrides[property as keyof typeof overrides];
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
