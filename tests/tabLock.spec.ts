import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { createTabLock, leaseTabLock, LockBusy, memoryTabLock, webLocksTabLock, type LockManagerLike } from '../src/features/sync/mutations/tabLock';

/** A lock manager that grants one exclusive holder at a time, in request order, as the Web Locks API does. */
function fakeLocks(): LockManagerLike {
  const tails = new Map<string, Promise<void>>();
  return {
    request: async <T>(name: string, _options: { mode: 'exclusive' }, callback: () => Promise<T>): Promise<T> => {
      const previous = tails.get(name) ?? Promise.resolve();
      let release!: () => void;
      tails.set(name, new Promise<void>((resolve) => { release = resolve; }));
      await previous;
      try {
        return await callback();
      } finally {
        release();
      }
    },
  };
}

/** Runs two pieces of work through the locks and answers the order their steps ran in. */
async function interleaving(first: { run<T>(work: () => Promise<T>): Promise<T> }, second: { run<T>(work: () => Promise<T>): Promise<T> }): Promise<string[]> {
  const steps: string[] = [];
  const work = (name: string) => async () => {
    steps.push(`${name} in`);
    await new Promise((resolve) => setTimeout(resolve, 15));
    steps.push(`${name} out`);
  };
  await Promise.all([first.run(work('a')), second.run(work('b'))]);
  return steps;
}

/** A promise and the function that settles it. */
function signal(): { promise: Promise<void>; settle: () => void } {
  let settle!: () => void;
  const promise = new Promise<void>((resolve) => { settle = resolve; });
  return { promise, settle };
}

describe('the tab lock', () => {
  it('takes the Web Locks API when the page has it, and runs one holder at a time', async () => {
    const locks = fakeLocks();
    const lock = createTabLock('rows', { locks });
    expect(lock.mode).toBe('web-locks');
    expect(await interleaving(lock, webLocksTabLock('rows', locks))).toEqual(['a in', 'a out', 'b in', 'b out']);
  });

  it('falls back to a lease in IndexedDB that two tabs hold one at a time', async () => {
    const factory = new IDBFactory();
    const one = createTabLock('rows', { locks: null, factory });
    const two = leaseTabLock({ name: 'rows', factory });
    expect(one.mode).toBe('lease');
    expect(await interleaving(one, two)).toEqual(['a in', 'a out', 'b in', 'b out']);
  });

  it('waits out the lease of a holder that crashed, then takes it', async () => {
    const factory = new IDBFactory();
    const crashed = leaseTabLock({ name: 'rows', factory, ttlMs: 120, pollMs: 10 });
    const forever = signal();
    const holding = signal();
    // the crashed holder takes the lease and never gives it back: once its work runs, it holds the lease, and its
    // renewal is stopped by hand to stand for a tab that died
    const held = crashed.run(() => { holding.settle(); return forever.promise; }).catch(() => undefined);
    await holding.promise;
    crashed.stopRenewing();
    const next = leaseTabLock({ name: 'rows', factory, ttlMs: 120, pollMs: 10, waitMs: 2000 });
    const started = Date.now();
    expect(await next.run(async () => 'taken')).toBe('taken');
    expect(Date.now() - started).toBeGreaterThanOrEqual(80);
    forever.settle();
    await held;
  });

  it('refuses with LockBusy once a live holder keeps the lease past the wait', async () => {
    const factory = new IDBFactory();
    const holder = leaseTabLock({ name: 'rows', factory, ttlMs: 90, pollMs: 10 });
    const long = signal();
    const holding = signal();
    const held = holder.run(() => { holding.settle(); return long.promise; });
    await holding.promise;
    const waiting = leaseTabLock({ name: 'rows', factory, ttlMs: 90, pollMs: 10, waitMs: 250 });
    await expect(waiting.run(async () => 'never')).rejects.toBeInstanceOf(LockBusy);
    long.settle();
    await held;
  });

  it('opens the lease database again after an open that failed', async () => {
    const real = new IDBFactory();
    let refusals = 1;
    const factory = {
      open(name: string, version?: number): IDBOpenDBRequest {
        if (refusals > 0) {
          refusals -= 1;
          throw new Error('the database cannot be opened now');
        }
        return real.open(name, version);
      },
    } as unknown as IDBFactory;
    const lock = leaseTabLock({ name: 'rows', factory });
    await expect(lock.run(async () => 'first')).rejects.toThrow('the database cannot be opened now');
    expect(await lock.run(async () => 'second')).toBe('second');
  });

  it('runs the work of one tab in its order without a lease where neither API exists', async () => {
    const lock = createTabLock('rows', { locks: null, factory: null });
    expect(lock.mode).toBe('memory');
    expect(await interleaving(lock, lock)).toEqual(['a in', 'a out', 'b in', 'b out']);
    expect(memoryTabLock().mode).toBe('memory');
  });
});
