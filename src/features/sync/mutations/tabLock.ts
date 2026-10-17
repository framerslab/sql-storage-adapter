/**
 * A lock that runs one holder at a time across the tabs of one page's origin. The Web Locks API grants it where the
 * page has it, and frees it when the holding tab ends. Where a page has no Web Locks, a lease in IndexedDB stands in: a
 * record with its holder and an expiry, taken in one IndexedDB transaction, renewed while the work runs and given back
 * after; a crashed holder's lease lapses after its time, and a tab that waits past its limit is refused with `LockBusy`,
 * which a caller shows as a read-only tab. Where neither exists, an in-page queue serves one tab. The lock serializes
 * work; it is not what keeps a stale tab from writing (the IndexedDB adapter's version stamp does that). It is the
 * caller's lock and never the adapter's `crossTab.locks`: a holder of this lock calls the adapter, which takes a lock of
 * its own, and neither lock is reentrant.
 */
import { createSerializedTransactionRunner } from '../../../shared/serializedTransaction';

/** What a page's lock does: run one piece of work at a time, and say which mechanism holds it. */
export interface TabLock {
  /** The mechanism that holds the lock: the Web Locks API, the IndexedDB lease, or the in-page queue. */
  readonly mode: 'web-locks' | 'lease' | 'memory';
  /** Runs `work` once the lock is held, and lets the lock go when it settles; answers what `work` answers. */
  run<T>(work: () => Promise<T>): Promise<T>;
}

/**
 * The part of the Web Locks API's `LockManager` the lock uses: the shape of the IndexedDB adapter's
 * `IndexedDbLockManager`, so `navigator.locks` serves both, each under its own name.
 */
export interface LockManagerLike {
  request<T>(name: string, options: { mode: 'exclusive' }, callback: () => Promise<T>): Promise<T>;
}

/** A tab that waited past its limit for a lease another tab holds. */
export class LockBusy extends Error {
  constructor() {
    super('another tab holds the lock');
    this.name = 'LockBusy';
  }
}

/** The lock over the Web Locks API. */
export function webLocksTabLock(name: string, locks: LockManagerLike): TabLock {
  return { mode: 'web-locks', run: (work) => locks.request(name, { mode: 'exclusive' }, () => work()) };
}

/** The lock for one tab alone: its work in the order it asked. */
export function memoryTabLock(): TabLock {
  const serialized = createSerializedTransactionRunner();
  return { mode: 'memory', run: (work) => serialized(work) };
}

/** The lease's settings. */
export interface LeaseOptions {
  /** The lock's name; the lease lives in the IndexedDB database `<name>-lease`. */
  name: string;
  /** The IndexedDB factory; the page's `indexedDB` when left out. */
  factory?: IDBFactory;
  /** How long a lease holds without renewal, in milliseconds (default 10,000). */
  ttlMs?: number;
  /** How often a waiting tab tries again (default 100). */
  pollMs?: number;
  /** How long a tab waits before `LockBusy` (default 15,000). */
  waitMs?: number;
}

const LEASE_STORE = 'lease';
const LEASE_KEY = 'holder';

interface LeaseRecord {
  holder: string;
  expiresAt: number;
}

function randomHolder(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function openLeaseDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(`${name}-lease`, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(LEASE_STORE)) request.result.createObjectStore(LEASE_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('the lease database is held open at another version'));
  });
}

/** Takes or renews the lease for `holder` when it is free, lapsed or already `holder`'s; answers whether it holds it. */
function takeLease(db: IDBDatabase, holder: string, ttlMs: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(LEASE_STORE, 'readwrite');
    const store = tx.objectStore(LEASE_STORE);
    let taken = false;
    const read = store.get(LEASE_KEY);
    read.onsuccess = () => {
      const current = read.result as LeaseRecord | undefined;
      const now = Date.now();
      if (current === undefined || current.expiresAt <= now || current.holder === holder) {
        const record: LeaseRecord = { holder, expiresAt: now + ttlMs };
        store.put(record, LEASE_KEY);
        taken = true;
      }
    };
    tx.oncomplete = () => resolve(taken);
    tx.onabort = () => reject(tx.error ?? new Error('the lease transaction was aborted'));
  });
}

/** Gives the lease back when `holder` still holds it. */
function giveLeaseBack(db: IDBDatabase, holder: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(LEASE_STORE, 'readwrite');
    const store = tx.objectStore(LEASE_STORE);
    const read = store.get(LEASE_KEY);
    read.onsuccess = () => {
      const current = read.result as LeaseRecord | undefined;
      if (current !== undefined && current.holder === holder) store.delete(LEASE_KEY);
    };
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('the lease transaction was aborted'));
  });
}

/**
 * The lock over an IndexedDB lease. Each run takes the lease under a holder id of its own, renews it every third of
 * `ttlMs` while its work runs and gives it back after; a database that failed to open is opened again on the next run.
 */
export function leaseTabLock(options: LeaseOptions): TabLock & {
  /** Stops renewing the lease the running work holds, as a tab that died would; the lease then lapses after `ttlMs`. */
  stopRenewing(): void;
} {
  const factory = options.factory ?? globalThis.indexedDB;
  const ttlMs = options.ttlMs ?? 10_000;
  const pollMs = options.pollMs ?? 100;
  const waitMs = options.waitMs ?? 15_000;
  // one tab's own work goes one at a time, so it never waits on a lease it holds itself
  const serialized = createSerializedTransactionRunner();
  let database: Promise<IDBDatabase> | null = null;
  let renewing: ReturnType<typeof setInterval> | null = null;
  return {
    mode: 'lease',
    stopRenewing(): void {
      if (renewing !== null) clearInterval(renewing);
      renewing = null;
    },
    run<T>(work: () => Promise<T>): Promise<T> {
      return serialized(async () => {
        // a failed open is not kept: the next run opens the database again
        const opening = (database ??= openLeaseDatabase(factory, options.name).catch((error: unknown) => {
          database = null;
          throw error;
        }));
        const db = await opening;
        const holder = randomHolder();
        const started = Date.now();
        while (!(await takeLease(db, holder, ttlMs))) {
          if (Date.now() - started >= waitMs) throw new LockBusy();
          await new Promise((resolve) => setTimeout(resolve, pollMs));
        }
        renewing = setInterval(() => {
          void takeLease(db, holder, ttlMs).catch(() => undefined);
        }, Math.max(1, Math.floor(ttlMs / 3)));
        try {
          return await work();
        } finally {
          if (renewing !== null) clearInterval(renewing);
          renewing = null;
          await giveLeaseBack(db, holder).catch(() => undefined);
        }
      });
    },
  };
}

/**
 * The page's lock: Web Locks when the page has them, else the IndexedDB lease, else the in-page queue. `locks` and
 * `factory` stand in for the page's own in tests; null says the page has none.
 */
export function createTabLock(name: string, options: { locks?: LockManagerLike | null; factory?: IDBFactory | null } = {}): TabLock {
  const scope = globalThis as unknown as { navigator?: { locks?: Partial<LockManagerLike> }; indexedDB?: IDBFactory };
  const locks = options.locks === undefined ? scope.navigator?.locks : options.locks;
  if (locks !== null && locks !== undefined && typeof locks.request === 'function') {
    return webLocksTabLock(name, locks as LockManagerLike);
  }
  const factory = options.factory === undefined ? scope.indexedDB : options.factory;
  if (factory !== null && factory !== undefined) return leaseTabLock({ name, factory });
  return memoryTabLock();
}
