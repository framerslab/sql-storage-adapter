/**
 * @fileoverview Moves one namespace of an old IndexedDB key-value store (one object store, out-of-line string keys, a
 * prefix per namespace: the store `openIndexedDbStore` opens) into a `KeyValueStore` over an adapter, without a moment
 * where two writable copies exist:
 *
 * 1. The old database is opened at `lockVersion`, above the version its writers open it at. The upgrade waits until no
 *    connection at an older version is open; while one is, the answer is `blocked` and nothing moves. From then an old
 *    writer's open fails with a `VersionError`, and `openIndexedDbStore` at the old version answers from memory.
 * 2. The records under the prefix are read, and written without it into the store `into` makes over a transaction's
 *    handle, with the marker `{ phase: 'copied' }`, in one transaction of the adapter. Each value is kept as the old
 *    store held it: the SQL store's codec gives back what the structured clone gives back.
 * 3. The copy is stored: an adapter that answers `flush()` (the IndexedDB adapter, which on `durability: 'interval'`
 *    stores a transaction after it resolves) is flushed. Only then are the old records under the prefix deleted, in an
 *    IndexedDB transaction whose completion is awaited.
 * 4. The marker becomes `{ phase: 'done' }`.
 *
 * A reload anywhere resumes from the committed side: with the marker at `copied`, steps 3 and 4 run again; at `done`,
 * the answer is `already`. A browser with no old store answers `none` and is marked done; the move leaves the old
 * database made, empty, at `lockVersion`, so an old page that opens it later still cannot write.
 *
 * Two moves that run at once copy once: step 2's transaction reads the marker again and writes nothing when another
 * move has committed its copy (the store may hold newer values by then), and the later move answers `already`, running
 * steps 3 and 4 when the first has not. Across tabs this needs an adapter that runs each transaction on what the other
 * tabs stored, as the IndexedDB adapter does under `crossTab`; a transaction it refuses with `IndexedDbConflictError`
 * rejects the move, which reads the other tab's marker when it is run again.
 *
 * A store that keeps nothing past the page (its `memoryOnly` true: an adapter without `persistence`, such as the
 * IndexedDB adapter's `memoryOnly` mode) is refused before the old database is opened, since deleting the old records
 * would leave their one copy in memory.
 *
 * The old store is read by its keys: a key that is not a string is left where it is. The module's types are the
 * structural shapes of `idb.ts`, so its declarations need no DOM library.
 * @module sql-storage-adapter/kv/migrateIndexedDbKeyValue
 */

import type { StorageAdapter } from '../../core/contracts';
import { idb, type IdbDatabaseLike, type IdbObjectStoreLike, type IdbOpenRequestLike, type IdbRequestLike } from './idb';
import type { KeyValueStore } from './keyValueStore';

/** Where the old records live. */
export interface LegacyKeyValueSource {
  /** The old database's name. */
  dbName: string;
  /** The object store that holds the records, with out-of-line keys. */
  storeName: string;
  /** The namespace's prefix in the old keys; the store's keys are the old keys without it. */
  prefix: string;
  /** The version the old writers open the database at. */
  fromVersion: number;
  /** The version the move opens it at, above `fromVersion`: from the move on, the database stays at it. */
  lockVersion: number;
}

/**
 * What a move did: `migrated`, it moved the records (or finished a move a reload cut after its copy); `already`, a
 * move had finished, or another move committed its copy while this one ran; `none`, the old store held nothing under
 * the prefix; `blocked`, a connection at the old version holds the database open, and nothing moved.
 */
export type MigrationOutcome = 'migrated' | 'already' | 'none' | 'blocked';

/**
 * The marker's key in the store `into` makes, beside the moved records: `{ phase: 'copied' }` once the copy is
 * committed, `{ phase: 'done' }` once the old records are deleted.
 */
export const MIGRATION_MARKER = 'migration/indexeddb-key-value';

/** The marker's value: the last committed step. */
interface Marker {
  phase: 'copied' | 'done';
}

/** The part of an IndexedDB factory the move calls; the page's `indexedDB` is one. */
interface OpenerLike {
  open(name: string, version?: number): unknown;
}

/** The move's options. */
export interface MigrateOptions {
  /** Where the old records live. */
  source: LegacyKeyValueSource;
  /** The adapter the records move into; the copy and its marker run in one of its transactions. */
  adapter: StorageAdapter;
  /**
   * The store the records go into, made over the adapter or over the transaction handle given, so the copy joins the
   * move's transaction: as a rule, `async (trx) => namespaced(await createSqlKeyValueStore(trx, { table }), prefix)`.
   */
  into(trx: StorageAdapter): Promise<KeyValueStore>;
  /** The IndexedDB the old store lives in; the page's `indexedDB` when left out. */
  factory?: OpenerLike;
  /**
   * Stops the move with an error once the copy is committed, before the old records are deleted: a stand-in for a
   * page closed between the two, for tests of the resume.
   */
  stopAfter?: 'copied';
}

/**
 * Opens the old database at `version`. Null when a connection at an older version blocks the upgrade: the browser runs
 * the upgrade once that connection closes, and it is aborted then, so the database stays at its version.
 */
function openAt(factory: OpenerLike, name: string, version: number): Promise<IdbDatabaseLike | null> {
  return new Promise((resolve, reject) => {
    // True once the promise is settled. The browser does not end a blocked open: it goes on when the other
    // connection closes, after the move has answered, and what it opens then is nobody's.
    let answered = false;
    const request = factory.open(name, version) as IdbOpenRequestLike;
    request.onupgradeneeded = () => {
      // Aborting the upgrade fails the open, which closes its connection and leaves the database as it was.
      if (answered && request.transaction) request.transaction.abort();
    };
    request.onsuccess = () => {
      if (answered) {
        request.result.close();
        return;
      }
      answered = true;
      resolve(request.result);
    };
    request.onerror = () => {
      if (answered) return;
      answered = true;
      // An upgrade aborted before the answer (the browser ended it) leaves the database as it was: try again later.
      if ((request.error as { name?: unknown } | null)?.name === 'AbortError') resolve(null);
      else reject(request.error);
    };
    request.onblocked = () => {
      if (answered) return;
      answered = true;
      resolve(null);
    };
  });
}

/** The string keys under `prefix` among `keys`, in the order given. */
const keysUnder = (keys: unknown[], prefix: string): string[] =>
  keys.filter((key): key is string => typeof key === 'string' && key.startsWith(prefix));

/**
 * Runs `work` in one transaction over the object store, settling once the transaction completes with what `done`
 * answers then, or with the first failed request's error. `work` passes each request it makes through `watch`.
 */
function inTransaction<T>(
  db: IdbDatabaseLike,
  storeName: string,
  mode: 'readonly' | 'readwrite',
  work: (store: IdbObjectStoreLike, watch: <R>(request: IdbRequestLike<R>) => IdbRequestLike<R>) => () => T,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    // A failed request's event reaches the request before the transaction, whose own error is still null then.
    let failure: unknown = null;
    const watch = <R>(request: IdbRequestLike<R>): IdbRequestLike<R> => {
      request.onerror = () => {
        if (failure === null) failure = request.error;
      };
      return request;
    };
    const done = work(tx.objectStore(storeName), watch);
    tx.oncomplete = () => resolve(done());
    tx.onerror = () => reject(failure ?? tx.error ?? new Error(`the old store's ${mode} transaction failed`));
    tx.onabort = () => reject(tx.error ?? failure ?? new Error(`the old store's ${mode} transaction was aborted`));
  });
}

/**
 * The records under `prefix`, keys and values, read in one transaction in the order of their keys; none when the
 * object store does not exist.
 */
function readNamespace(db: IdbDatabaseLike, storeName: string, prefix: string): Promise<Array<[string, unknown]>> {
  if (!db.objectStoreNames.contains(storeName)) return Promise.resolve([]);
  return inTransaction(db, storeName, 'readonly', (store, watch) => {
    const reads: Array<[string, IdbRequestLike<unknown>]> = [];
    const keys = watch(store.getAllKeys());
    keys.onsuccess = () => {
      for (const key of keysUnder(keys.result, prefix)) reads.push([key, watch(store.get(key))]);
    };
    return () => reads.map(([key, read]): [string, unknown] => [key, read.result]);
  });
}

/** Deletes the records under `prefix`, resolving once the transaction completes. */
function deleteNamespace(db: IdbDatabaseLike, storeName: string, prefix: string): Promise<void> {
  if (!db.objectStoreNames.contains(storeName)) return Promise.resolve();
  return inTransaction(db, storeName, 'readwrite', (store, watch) => {
    const keys = watch(store.getAllKeys());
    keys.onsuccess = () => {
      for (const key of keysUnder(keys.result, prefix)) watch(store.delete(key));
    };
    return () => undefined;
  });
}

/** Stores what the adapter has committed, when it answers `flush()`: the IndexedDB adapter does. */
async function storeCommitted(adapter: StorageAdapter): Promise<void> {
  const flush = (adapter as { flush?: unknown }).flush;
  if (typeof flush === 'function') await (flush as () => Promise<void>).call(adapter);
}

/**
 * Moves one namespace of an old IndexedDB key-value store into a `KeyValueStore` over `options.adapter`, behind a
 * marker, its old writers locked out by the database's version; the module's comment gives the steps. Run it again on
 * `blocked`, once the old page's tabs are closed. IndexedDB runs a database's opens in order, so a call made while an
 * earlier call's upgrade still waits on such a tab waits behind it, in this page or another, and goes on once the tab
 * closes.
 *
 * @example
 * ```typescript
 * const adapter = new IndexedDbAdapter({ dbName: 'app-device', crossTab: true });
 * await adapter.open();
 * const outcome = await migrateIndexedDbKeyValue({
 *   source: { dbName: 'app', storeName: 'kv', prefix: 'user-42/', fromVersion: 1, lockVersion: 2 },
 *   adapter,
 *   into: async (trx) => namespaced(await createSqlKeyValueStore(trx, { table: 'device_kv' }), 'user-42/'),
 * });
 * ```
 *
 * @returns What the move did; see `MigrationOutcome`.
 * @throws {Error} When `lockVersion` is not above `fromVersion`, when the store `into` makes keeps nothing past the
 *   page (nothing is opened or moved then), when no `factory` is given and the page has no IndexedDB, and when
 *   IndexedDB or the adapter refuses a step; the step that failed runs again on the next call.
 */
export async function migrateIndexedDbKeyValue(options: MigrateOptions): Promise<MigrationOutcome> {
  const { source, adapter } = options;
  if (!(source.lockVersion > source.fromVersion)) {
    throw new Error("migrateIndexedDbKeyValue: the lock version must be above the old writers' version");
  }
  const store = await options.into(adapter);
  if (store.memoryOnly) {
    // The old records would be deleted while their one copy lived in memory, gone with the page.
    throw new Error(
      'migrateIndexedDbKeyValue: the store the records move into keeps nothing past the page; the old store is left as it is',
    );
  }
  const marker = await store.get<Marker>(MIGRATION_MARKER);
  if (marker?.phase === 'done') return 'already';
  const db = await openAt(options.factory ?? idb().factory, source.dbName, source.lockVersion);
  if (db === null) return 'blocked';
  try {
    let outcome: MigrationOutcome = 'migrated';
    if (marker?.phase !== 'copied') {
      const records = await readNamespace(db, source.storeName, source.prefix);
      // The marker is read again inside the copy's transaction: another move that committed its copy since the first
      // read may have been followed by the page's own writes, which these records would put back.
      const found = await adapter.transaction(async (trx): Promise<Marker | undefined> => {
        const target = await options.into(trx);
        const current = await target.get<Marker>(MIGRATION_MARKER);
        if (current !== undefined) return current;
        for (const [key, value] of records) await target.set(key.slice(source.prefix.length), value);
        await target.set(MIGRATION_MARKER, { phase: 'copied' } satisfies Marker);
        return undefined;
      });
      if (found?.phase === 'done') return 'already';
      if (found !== undefined) outcome = 'already';
      else if (records.length === 0) outcome = 'none';
      if (options.stopAfter === 'copied') throw new Error('stopped after copied');
    }
    await storeCommitted(adapter);
    await deleteNamespace(db, source.storeName, source.prefix);
    await store.set(MIGRATION_MARKER, { phase: 'done' } satisfies Marker);
    return outcome;
  } finally {
    db.close();
  }
}
