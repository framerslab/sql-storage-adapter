/**
 * The gate a server's sync requests pass while they can read, commit or send rows, and the block a deletion sets on
 * it. A request enters under its keys (a scope's, a group's) with a function that cancels it; a deletion blocks a key,
 * which turns new requests under it away at once and cancels the ones inside, then waits for them to leave, up to a
 * deadline: `stuck` means one is still inside, and the deletion stays pending. The gate is one process's; a server
 * that runs several processes holds its own across them.
 */
import { getStorageLogger } from '../../../shared/logger';

/** A request turned away because a deletion holds one of its keys. */
export class GateBlocked extends Error {
  constructor() {
    super('a deletion holds this sync scope');
    this.name = 'GateBlocked';
  }
}

/** A request's place inside the gate; released however the request ends. */
export interface GateLease {
  /** Leaves the gate; a second call does nothing. */
  release(): void;
}

/** A deletion's block on a key. */
export interface GateBlock {
  /** Waits until no request under the key is inside, or `deadlineMs` passed: `drained` or `stuck`. */
  drain(deadlineMs: number): Promise<'drained' | 'stuck'>;
  /** Lifts this block; the key stays blocked while another block holds it. A second call does nothing. */
  release(): void;
}

interface Inside {
  keys: readonly string[];
  cancel: (reason: unknown) => void;
}

/**
 * The gate. It holds the requests of one process: a server whose sync routes run in several processes needs a gate
 * of its own across them. A request's cancel that throws is logged through the host logger, and the block goes on;
 * that request stays inside until it releases its lease.
 */
export class DrainGate {
  private readonly inside = new Map<number, Inside>();
  private readonly blocked = new Map<string, number>();
  private readonly waiters = new Set<() => void>();
  private next = 1;

  /** Enters under `keys`, or throws `GateBlocked` when a deletion holds any of them. */
  enter(keys: readonly string[], cancel: (reason: unknown) => void): GateLease {
    if (keys.some((key) => this.isBlocked(key))) throw new GateBlocked();
    const id = this.next++;
    this.inside.set(id, { keys, cancel });
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.inside.delete(id);
        for (const waiter of [...this.waiters]) waiter();
      },
    };
  }

  /** True while a deletion holds `key`. */
  isBlocked(key: string): boolean {
    return (this.blocked.get(key) ?? 0) > 0;
  }

  /** Blocks `key`: new requests under it are turned away, and those inside are cancelled now. */
  block(key: string): GateBlock {
    this.blocked.set(key, (this.blocked.get(key) ?? 0) + 1);
    for (const request of [...this.inside.values()]) {
      if (!request.keys.includes(key)) continue;
      try {
        request.cancel(new GateBlocked());
      } catch (error) {
        getStorageLogger().warn(
          { scope: 'DrainGate', error: error instanceof Error ? error.message : String(error) },
          'A sync request failed to cancel when a deletion blocked its key; the block stands, and a drain waits for the request to leave.',
        );
      }
    }
    let released = false;
    const holding = (): boolean => [...this.inside.values()].some((request) => request.keys.includes(key));
    return {
      drain: (deadlineMs) =>
        new Promise<'drained' | 'stuck'>((resolve) => {
          if (!holding()) {
            resolve('drained');
            return;
          }
          const check = (): void => {
            if (holding()) return;
            clearTimeout(timer);
            this.waiters.delete(check);
            resolve('drained');
          };
          const timer = setTimeout(() => {
            this.waiters.delete(check);
            resolve(holding() ? 'stuck' : 'drained');
          }, deadlineMs);
          this.waiters.add(check);
        }),
      release: () => {
        if (released) return;
        released = true;
        const count = (this.blocked.get(key) ?? 1) - 1;
        if (count <= 0) this.blocked.delete(key);
        else this.blocked.set(key, count);
      },
    };
  }
}
