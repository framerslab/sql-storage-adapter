/**
 * A one-slot hand-over from a producer that must wait for its consumer to a consumer that pulls: a pull's transaction
 * offers its answer chunk by chunk and stays open until the consumer has taken the last one. Cancelling (the consumer
 * stops, or the request is aborted) refuses the waiting offer, which throws inside the transaction and rolls it back.
 */

/** A pull cancelled by its consumer, its request or a deletion. */
export class PullCancelled extends Error {
  constructor() {
    super('the pull was cancelled');
    this.name = 'PullCancelled';
  }
}

interface Slot<T> {
  value: T;
  taken: () => void;
  refused: (error: unknown) => void;
}

/** The hand-over. */
export class HandOver<T> {
  private slot: Slot<T> | null = null;
  private reader: { resolve: (result: IteratorResult<T>) => void; reject: (error: unknown) => void } | null = null;
  private ended: { error: unknown } | 'done' | null = null;

  /** Offers one value; resolves once the consumer has taken it, rejects once the hand-over is cancelled. */
  offer(value: T): Promise<void> {
    if (this.ended !== null) return Promise.reject(this.ended === 'done' ? new PullCancelled() : this.ended.error);
    return new Promise<void>((taken, refused) => {
      if (this.reader !== null) {
        const reader = this.reader;
        this.reader = null;
        reader.resolve({ value, done: false });
        taken();
        return;
      }
      this.slot = { value, taken, refused };
    });
  }

  /** The next value, waiting for the producer; the end once it finished; its error once it failed or was cancelled. */
  next(): Promise<IteratorResult<T>> {
    if (this.slot !== null) {
      const slot = this.slot;
      this.slot = null;
      slot.taken();
      return Promise.resolve({ value: slot.value, done: false });
    }
    if (this.ended === 'done') return Promise.resolve({ value: undefined, done: true });
    if (this.ended !== null) return Promise.reject(this.ended.error);
    return new Promise((resolve, reject) => {
      this.reader = { resolve, reject };
    });
  }

  /** The producer finished. */
  finish(): void {
    this.close('done');
  }

  /** The producer failed. */
  fail(error: unknown): void {
    this.close({ error });
  }

  /** The consumer stopped or the request was aborted: a waiting offer is refused. */
  cancel(error: unknown = new PullCancelled()): void {
    this.close({ error });
  }

  private close(how: { error: unknown } | 'done'): void {
    if (this.ended !== null) return;
    this.ended = how;
    if (this.slot !== null) {
      const slot = this.slot;
      this.slot = null;
      slot.refused(how === 'done' ? new PullCancelled() : how.error);
    }
    if (this.reader !== null) {
      const reader = this.reader;
      this.reader = null;
      if (how === 'done') reader.resolve({ value: undefined, done: true });
      else reader.reject(how.error);
    }
  }
}

/** The hand-over as an async iterable whose `return` cancels it. */
export function iterate<T>(handOver: HandOver<T>): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => handOver.next(),
      return: async () => {
        handOver.cancel(new PullCancelled());
        return { value: undefined, done: true };
      },
    }),
  };
}
