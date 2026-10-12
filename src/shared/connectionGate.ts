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
 * A statement issued from inside the transaction runs in it. Through the
 * callback's handle it carries the transaction's token, so it is admitted
 * whatever async context runs it. Through the adapter itself, from code the
 * callback runs, the callback's async context tells it apart, so the gate needs
 * a context store (Node's AsyncLocalStorage); without one it admits every
 * statement that carries no token at once, which is how the adapters behaved
 * before the gate.
 *
 * This module imports nothing from Node, so browser bundles can include it;
 * the adapter that runs on Node passes the store in.
 */

/** The part of Node's `AsyncLocalStorage` the gate uses. */
export interface TransactionContextStore {
  run<R>(store: symbol, callback: () => R): R;
  getStore(): symbol | undefined;
  /** Releases the store; Node collects an enabled store only after this. */
  disable(): void;
}

/** The gate of one shared connection. */
export interface ConnectionGate {
  /**
   * True when a statement must wait: a transaction is open and the statement
   * is not its own. A transaction handle passes its token; any other caller is
   * judged by its async context.
   */
  blocks(token?: symbol): boolean;
  /** True when a transaction is open and the caller runs inside it. */
  inside(): boolean;
  /** The open transaction's token, for a handle made inside it; null when none is open. */
  openToken(): symbol | null;
  /** Settles when the open transaction ends; at once when none is open. */
  ended(): Promise<void>;
  /**
   * Runs one transaction's body with the gate closed to callers outside it.
   * The body receives the transaction's token for its handle, and runs in its
   * own async context, so code it runs is admitted too. The caller runs one
   * body at a time (the adapter's transaction queue).
   */
  hold<T>(body: (token: symbol) => Promise<T>): Promise<T>;
  /** Releases the context store when the connection closes. */
  dispose(): void;
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
    blocks: (token) => {
      if (open === null) return false;
      if (token !== undefined) return token !== open.id;
      return context !== null && context.getStore() !== open.id;
    },
    inside: () => open !== null && context !== null && context.getStore() === open.id,
    openToken: () => open?.id ?? null,
    ended: () => open?.done ?? Promise.resolve(),
    async hold<T>(body: (token: symbol) => Promise<T>): Promise<T> {
      const id = Symbol('transaction');
      let release!: () => void;
      const done = new Promise<void>((resolve) => {
        release = resolve;
      });
      open = { id, done };
      try {
        return await (context ? context.run(id, () => body(id)) : body(id));
      } finally {
        open = null;
        release();
      }
    },
    dispose: () => {
      context?.disable();
    },
  };
};

/**
 * Runs `work`, a synchronous statement, once the gate admits it. The last check
 * and the work happen in the same turn, so no transaction can open between
 * them; a caller woken when a transaction ends checks again, since the next
 * transaction may already be open.
 *
 * @param token - The transaction's token when the statement comes through a
 *   transaction handle; a handle whose transaction has ended waits like any
 *   outside caller.
 */
export const whenAdmitted = async <T>(gate: ConnectionGate, work: () => T, token?: symbol): Promise<T> => {
  while (gate.blocks(token)) {
    await gate.ended();
  }
  return work();
};
