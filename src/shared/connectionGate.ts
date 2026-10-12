/**
 * Keeps statements from outside an open transaction out of it.
 *
 * An adapter whose transactions share one connection runs BEGIN, the
 * callback's statements and COMMIT on that connection. While the callback
 * awaits, a statement another caller issues would otherwise run on the same
 * connection inside the open transaction: a write would be undone if the
 * transaction rolled back, and a read would see rows the transaction has not
 * committed. The gate makes such a statement wait until the transaction ends.
 *
 * A statement issued from inside the transaction runs in it, whether it goes
 * through the callback's handle or through the adapter from code the callback
 * runs. The callback's async context tells the two apart, so the gate needs a
 * context store (Node's AsyncLocalStorage). Without one it admits every
 * statement at once, which is how the adapters behaved before the gate.
 *
 * This module imports nothing from Node, so browser bundles can include it;
 * the adapter that runs on Node passes the store in.
 */

/** The part of Node's `AsyncLocalStorage` the gate uses. */
export interface TransactionContextStore {
  run<R>(store: symbol, callback: () => R): R;
  getStore(): symbol | undefined;
}

/** The gate of one shared connection. */
export interface ConnectionGate {
  /** True when a transaction is open and the caller is outside it, so a statement must wait. */
  blocks(): boolean;
  /** True when a transaction is open and the caller runs inside it. */
  inside(): boolean;
  /** Settles when the open transaction ends; at once when none is open. */
  ended(): Promise<void>;
  /**
   * Runs one transaction's body with the gate closed to callers outside it.
   * The body runs in its own context, so its statements are admitted. The
   * caller runs one body at a time (the adapter's transaction queue).
   */
  hold<T>(body: () => Promise<T>): Promise<T>;
}

/**
 * Creates the gate of one shared connection.
 *
 * @param context - Node's AsyncLocalStorage, or null where there is none (the
 *   gate then admits every statement at once).
 */
export const createConnectionGate = (context: TransactionContextStore | null): ConnectionGate => {
  let open: { id: symbol; done: Promise<void> } | null = null;

  return {
    blocks: () => open !== null && context !== null && context.getStore() !== open.id,
    inside: () => open !== null && context !== null && context.getStore() === open.id,
    ended: () => open?.done ?? Promise.resolve(),
    async hold<T>(body: () => Promise<T>): Promise<T> {
      const id = Symbol('transaction');
      let release!: () => void;
      const done = new Promise<void>((resolve) => {
        release = resolve;
      });
      open = { id, done };
      try {
        return await (context ? context.run(id, body) : body());
      } finally {
        open = null;
        release();
      }
    },
  };
};

/**
 * Runs `work`, a synchronous statement, once the gate admits the caller. The
 * last check and the work happen in the same turn, so no transaction can open
 * between them; a caller woken when a transaction ends checks again, since the
 * next transaction may already be open.
 */
export const whenAdmitted = async <T>(gate: ConnectionGate, work: () => T): Promise<T> => {
  while (gate.blocks()) {
    await gate.ended();
  }
  return work();
};
