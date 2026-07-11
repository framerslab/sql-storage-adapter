import type {
  BatchOperation,
  BatchResult,
  StorageAdapter,
  StorageCapability,
  StorageOpenOptions,
  StorageParameters,
  StorageRunResult,
} from '../core/contracts';

/** Function that runs one asynchronous operation after earlier operations finish. */
export type SerializedTransactionRunner = <T>(operation: () => Promise<T>) => Promise<T>;

/**
 * Create a FIFO runner for adapters whose transactions share one connection.
 *
 * The queue tail always resolves, even when an operation rejects, so a failed
 * transaction cannot poison later work. Each caller installs its own release
 * promise before yielding, which preserves invocation order.
 */
export const createSerializedTransactionRunner = (): SerializedTransactionRunner => {
  let tail = Promise.resolve();

  return async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };
};

/**
 * Adapter view for callbacks already running on a shared connection.
 *
 * Queries delegate to the owner, while nested transaction callbacks reuse the
 * open transaction instead of entering the owner's top-level queue. This is
 * the same nested behavior as the client-bound PostgreSQL transaction view.
 */
class SharedConnectionTransactionAdapter implements StorageAdapter {
  public readonly kind: string;
  public readonly capabilities: ReadonlySet<StorageCapability>;
  public readonly batch?: (operations: BatchOperation[]) => Promise<BatchResult>;

  constructor(private readonly owner: StorageAdapter) {
    this.kind = owner.kind;
    this.capabilities = owner.capabilities;
    if (owner.batch) {
      this.batch = (operations) => owner.batch!(operations);
    }
  }

  public async open(_options?: StorageOpenOptions): Promise<void> {
    // The owner opened the shared connection before creating this view.
  }

  public async run(
    statement: string,
    parameters?: StorageParameters,
  ): Promise<StorageRunResult> {
    return this.owner.run(statement, parameters);
  }

  public async get<T>(statement: string, parameters?: StorageParameters): Promise<T | null> {
    return this.owner.get<T>(statement, parameters);
  }

  public async all<T>(statement: string, parameters?: StorageParameters): Promise<T[]> {
    return this.owner.all<T>(statement, parameters);
  }

  public async exec(script: string): Promise<void> {
    await this.owner.exec(script);
  }

  public async transaction<T>(fn: (trx: StorageAdapter) => Promise<T>): Promise<T> {
    return fn(this);
  }

  public async close(): Promise<void> {
    // The owner retains the connection until its own close() call.
  }
}

/** Create a callback-scoped adapter view for an already-open transaction. */
export const createSharedConnectionTransactionAdapter = (
  owner: StorageAdapter,
): StorageAdapter => new SharedConnectionTransactionAdapter(owner);
