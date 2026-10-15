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
 * a context store (Node's AsyncLocalStorage). Without one, the gate either
 * admits every statement that carries no token at once, which is how the
 * adapters behaved before the gate, or makes it wait like any outside caller,
 * so that the handle is the only way into an open transaction: the adapters
 * that run in a browser or a WebView, where there is no context store, wait.
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

/** How a gate treats a statement that carries no token. */
export interface ConnectionGateOptions {
  /**
   * When there is no context store: 'admit' runs such a statement at once (the
   * default, how the adapters behaved before the gate); 'wait' holds it until
   * the open transaction ends, so only the transaction's handle reaches it.
   */
  withoutContext?: 'admit' | 'wait';
}

/**
 * Creates the gate of one shared connection.
 *
 * @param context - Node's AsyncLocalStorage, or null where there is none.
 * @param options - What the gate does with a token-less statement when there
 *   is no context store.
 */
export const createConnectionGate = (
  context: TransactionContextStore | null,
  options: ConnectionGateOptions = {},
): ConnectionGate => {
  let open: { id: symbol; done: Promise<void> } | null = null;
  const waitWithoutContext = options.withoutContext === 'wait';

  return {
    blocks: (token) => {
      if (open === null) return false;
      if (token !== undefined) return token !== open.id;
      if (context === null) return waitWithoutContext;
      return context.getStore() !== open.id;
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

/** Reports a statement that is still waiting for an open transaction after a while. */
export interface LongWaitWatch {
  /** How long a statement may wait before `onLongWait` is called. */
  afterMs: number;
  /** Called once per waiting statement that passes `afterMs`. */
  onLongWait: () => void;
}

/**
 * Runs `work` once the gate admits it. `work` starts the statement: it runs it
 * (a synchronous adapter) or sends it (an asynchronous one), and the last check
 * and that start happen in the same turn, so no transaction can open between
 * them; a caller woken when a transaction ends checks again, since the next
 * transaction may already be open.
 *
 * @param token - The transaction's token when the statement comes through a
 *   transaction handle; a handle whose transaction has ended waits like any
 *   outside caller.
 * @param watch - Reports a statement that waits long, which is how a callback
 *   that issues a statement through the adapter instead of its handle shows
 *   on an adapter whose gate makes such statements wait.
 */
export const whenAdmitted = async <T>(
  gate: ConnectionGate,
  work: () => T | PromiseLike<T>,
  token?: symbol,
  watch?: LongWaitWatch,
): Promise<T> => {
  if (gate.blocks(token)) {
    const timer = watch ? setTimeout(watch.onLongWait, watch.afterMs) : undefined;
    try {
      while (gate.blocks(token)) {
        await gate.ended();
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  return work();
};
