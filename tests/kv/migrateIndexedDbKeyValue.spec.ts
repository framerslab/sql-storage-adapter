import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { IndexedDbAdapter } from '../../src/adapters/indexedDbAdapter';
import type { StorageAdapter } from '../../src/core/contracts';
import { createSqlKeyValueStore, namespaced, type KeyValueStore } from '../../src/features/kv';
import { migrateIndexedDbKeyValue, MIGRATION_MARKER, type LegacyKeyValueSource } from '../../src/features/kv/migrateIndexedDbKeyValue';

// The move runs on fake-indexeddb, a factory of its own stubbed in for each
// case, so the old store and the adapter's database share it.

const SOURCE: LegacyKeyValueSource = { dbName: 'old-store', storeName: 'kv', prefix: 'a'.repeat(32) + '/', fromVersion: 1, lockVersion: 2 };
const OTHER_PREFIX = 'b'.repeat(32) + '/';
const TABLE = 'kv_entries';

/** An old store at version 1 holding records for two namespaces; its connection is closed, or handed back when `hold` says. */
async function oldStore(records: Record<string, unknown>, hold = false): Promise<IDBDatabase | null> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(SOURCE.dbName, SOURCE.fromVersion);
    request.onupgradeneeded = () => request.result.createObjectStore(SOURCE.storeName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(SOURCE.storeName, 'readwrite');
    for (const [key, value] of Object.entries(records)) tx.objectStore(SOURCE.storeName).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  if (hold) return db;
  db.close();
  return null;
}

/** Every key the old store holds, sorted; none when the store is not there. */
async function oldKeys(): Promise<string[]> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(SOURCE.dbName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  if (!db.objectStoreNames.contains(SOURCE.storeName)) {
    db.close();
    return [];
  }
  const keys = await new Promise<string[]>((resolve, reject) => {
    const request = db.transaction(SOURCE.storeName, 'readonly').objectStore(SOURCE.storeName).getAllKeys();
    request.onsuccess = () => resolve((request.result as IDBValidKey[]).map(String).sort());
    request.onerror = () => reject(request.error);
  });
  db.close();
  return keys;
}

/** Whether the old version still opens: null when it does, else the error's name (`VersionError` once the move has begun). */
function oldVersionOpens(): Promise<string | null> {
  return new Promise((resolve) => {
    const request = indexedDB.open(SOURCE.dbName, SOURCE.fromVersion);
    request.onsuccess = () => {
      request.result.close();
      resolve(null);
    };
    request.onerror = () => resolve(request.error?.name ?? 'error');
  });
}

/** The store over `adapter` the move writes into: the key-value table, scoped to the source's prefix. */
const intoTable = async (trx: StorageAdapter): Promise<KeyValueStore> =>
  namespaced(await createSqlKeyValueStore(trx, { table: TABLE }), SOURCE.prefix);

/** The target: master's durable adapter on a database of its own, the store factory the move takes, and the store over the adapter. */
async function target(): Promise<{ adapter: IndexedDbAdapter; into: (trx: StorageAdapter) => Promise<KeyValueStore>; store: KeyValueStore }> {
  const adapter = new IndexedDbAdapter({ dbName: 'new-store', durability: 'commit' });
  await adapter.open();
  return { adapter, into: intoTable, store: await intoTable(adapter) };
}

const RECORDS = {
  [`${SOURCE.prefix}doc`]: { text: '## Plan\nShip it.\n', saved: 1760500000000 },
  [`${SOURCE.prefix}cfg/settings`]: { flag: false },
  [`${SOURCE.prefix}items/1`]: { title: 'kept here', count: 2 },
  [`${OTHER_PREFIX}doc`]: { text: 'another namespace', saved: 2 },
};

describe('the move of an old IndexedDB key-value store behind the adapter', () => {
  let adapter: IndexedDbAdapter | null = null;

  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory());
  });

  afterEach(async () => {
    await adapter?.close().catch(() => undefined);
    adapter = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("copies one namespace's records unchanged, commits the marker with them, then removes the old copies alone", async () => {
    await oldStore(RECORDS);
    const t = await target();
    adapter = t.adapter;
    expect(await migrateIndexedDbKeyValue({ source: SOURCE, adapter: t.adapter, into: t.into })).toBe('migrated');
    expect(await t.store.get('doc')).toEqual(RECORDS[`${SOURCE.prefix}doc`]);
    expect(await t.store.get('cfg/settings')).toEqual({ flag: false });
    expect(await t.store.get('items/1')).toEqual({ title: 'kept here', count: 2 });
    expect(await t.store.get(MIGRATION_MARKER)).toEqual({ phase: 'done' });
    expect(await oldKeys()).toEqual([`${OTHER_PREFIX}doc`]);
    expect(await migrateIndexedDbKeyValue({ source: SOURCE, adapter: t.adapter, into: t.into })).toBe('already');
  });

  it('locks old writers out: the old version no longer opens once the move has begun', async () => {
    await oldStore(RECORDS);
    const t = await target();
    adapter = t.adapter;
    expect(await oldVersionOpens()).toBeNull();
    await migrateIndexedDbKeyValue({ source: SOURCE, adapter: t.adapter, into: t.into });
    expect(await oldVersionOpens()).toBe('VersionError');
  });

  it('answers blocked, copying nothing, while an old tab holds the old version open', async () => {
    const oldTab = await oldStore(RECORDS, true);
    const t = await target();
    adapter = t.adapter;
    expect(await migrateIndexedDbKeyValue({ source: SOURCE, adapter: t.adapter, into: t.into })).toBe('blocked');
    expect(await t.store.keys('')).toEqual([]);
    oldTab?.close();
    // the upgrade the blocked attempt left waiting runs once the old tab closes, and is aborted, so the database stays at version 1
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await migrateIndexedDbKeyValue({ source: SOURCE, adapter: t.adapter, into: t.into })).toBe('migrated');
  });

  it('resumes after the copy committed and the removal did not run', async () => {
    await oldStore(RECORDS);
    const t = await target();
    adapter = t.adapter;
    await expect(migrateIndexedDbKeyValue({ source: SOURCE, adapter: t.adapter, into: t.into, stopAfter: 'copied' })).rejects.toThrow('stopped after copied');
    expect(await t.store.get(MIGRATION_MARKER)).toEqual({ phase: 'copied' });
    expect(await t.store.get('cfg/settings')).toEqual({ flag: false });
    expect((await oldKeys()).length).toBe(4);
    expect(await migrateIndexedDbKeyValue({ source: SOURCE, adapter: t.adapter, into: t.into })).toBe('migrated');
    expect(await oldKeys()).toEqual([`${OTHER_PREFIX}doc`]);
  });

  it('keeps each value as the old store held it: an undefined field and a Date come through the codec unchanged', async () => {
    const seen = new Date(1760500000000);
    await oldStore({ [`${SOURCE.prefix}items/2`]: { title: 'two', seen, extra: undefined } });
    const t = await target();
    adapter = t.adapter;
    expect(await migrateIndexedDbKeyValue({ source: SOURCE, adapter: t.adapter, into: t.into })).toBe('migrated');
    const value = await t.store.get<{ title: string; seen: Date; extra?: string }>('items/2');
    expect(value?.title).toBe('two');
    expect(value?.seen).toEqual(seen);
    expect(value !== undefined && 'extra' in value && value.extra === undefined).toBe(true);
  });

  it('answers none for a browser that never had the old store, and marks it done', async () => {
    const t = await target();
    adapter = t.adapter;
    expect(await migrateIndexedDbKeyValue({ source: SOURCE, adapter: t.adapter, into: t.into })).toBe('none');
    expect(await t.store.get(MIGRATION_MARKER)).toEqual({ phase: 'done' });
    expect(await migrateIndexedDbKeyValue({ source: SOURCE, adapter: t.adapter, into: t.into })).toBe('already');
  });

  it('copies once when two moves run at once: the later one writes nothing over a value written after the first, and answers already', async () => {
    await oldStore(RECORDS);
    const t = await target();
    adapter = t.adapter;
    let reached!: () => void;
    const atCopy = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // the later move's adapter: its copy's transaction waits until the first move is done and the page has written
    const waiting = new Proxy(t.adapter, {
      get(base, property) {
        if (property === 'transaction') {
          return async <T>(fn: (trx: StorageAdapter) => Promise<T>): Promise<T> => {
            reached();
            await held;
            return base.transaction(fn);
          };
        }
        const value: unknown = Reflect.get(base, property, base);
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(base) : value;
      },
    });
    const later = migrateIndexedDbKeyValue({ source: SOURCE, adapter: waiting, into: t.into });
    await atCopy;
    expect(await migrateIndexedDbKeyValue({ source: SOURCE, adapter: t.adapter, into: t.into })).toBe('migrated');
    await t.store.set('doc', { text: 'written after the move', saved: 3 });
    release();
    expect(await later).toBe('already');
    expect(await t.store.get('doc')).toEqual({ text: 'written after the move', saved: 3 });
    expect(await t.store.get(MIGRATION_MARKER)).toEqual({ phase: 'done' });
    expect(await oldKeys()).toEqual([`${OTHER_PREFIX}doc`]);
  });

  it('stores the copy before it removes the old records, on an adapter that saves on an interval', async () => {
    // The auto-save tick never fires: whatever is stored, the move stored.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    await oldStore(RECORDS);
    const interval = new IndexedDbAdapter({ dbName: 'new-store', durability: 'interval' });
    adapter = interval;
    await interval.open();
    expect(await migrateIndexedDbKeyValue({ source: SOURCE, adapter: interval, into: intoTable })).toBe('migrated');
    expect(await oldKeys()).toEqual([`${OTHER_PREFIX}doc`]);
    // what a page that loads now reads: the stored image, through a connection of its own
    const reader = new IndexedDbAdapter({ dbName: 'new-store', durability: 'commit' });
    await reader.open();
    try {
      const stored = await intoTable(reader);
      expect(await stored.get('doc')).toEqual(RECORDS[`${SOURCE.prefix}doc`]);
      expect(await stored.get('items/1')).toEqual({ title: 'kept here', count: 2 });
      expect(await stored.get(MIGRATION_MARKER)).toEqual({ phase: 'copied' });
    } finally {
      await reader.close();
    }
  });
});
