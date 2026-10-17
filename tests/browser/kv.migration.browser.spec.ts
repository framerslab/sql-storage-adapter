import { afterEach, describe, expect, it } from 'vitest';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import browserWasmUrl from 'sql.js/dist/sql-wasm-browser.wasm?url';
import { IndexedDbAdapter } from '../../src/adapters/indexedDbAdapter';
import type { StorageAdapter } from '../../src/core/contracts';
import { createSqlKeyValueStore, namespaced, type KeyValueStore } from '../../src/features/kv/index';
import { migrateIndexedDbKeyValue, MIGRATION_MARKER, type LegacyKeyValueSource } from '../../src/features/kv/migrateIndexedDbKeyValue';

// The move of an old key-value store in the browsers themselves, Chromium,
// WebKit and Firefox: their own version check locks the old writers out, their
// own blocked event holds the move while an old connection is open, and each
// value comes through as their own structured clone held it.

const sqlJsConfig = {
  locateFile: (file: string): string => (file.includes('browser') ? browserWasmUrl : wasmUrl),
};

/** A database name no other test uses. */
const unique = (name: string): string => `${name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const PREFIX = 'a'.repeat(32) + '/';
const OTHER_PREFIX = 'b'.repeat(32) + '/';
const TABLE = 'kv_entries';

/** A source on an old database no other test uses. */
const source = (): LegacyKeyValueSource => ({ dbName: unique('old-store'), storeName: 'kv', prefix: PREFIX, fromVersion: 1, lockVersion: 2 });

/** The old store at version 1 holding `records`; its connection is closed, or handed back when `hold` says. */
async function oldStore(from: LegacyKeyValueSource, records: Record<string, unknown>, hold = false): Promise<IDBDatabase | null> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(from.dbName, from.fromVersion);
    request.onupgradeneeded = () => request.result.createObjectStore(from.storeName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(from.storeName, 'readwrite');
    for (const [key, value] of Object.entries(records)) tx.objectStore(from.storeName).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });
  if (hold) return db;
  db.close();
  return null;
}

/** Every key the old store holds, sorted. */
async function oldKeys(from: LegacyKeyValueSource): Promise<string[]> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(from.dbName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise<string[]>((resolve, reject) => {
      const request = db.transaction(from.storeName, 'readonly').objectStore(from.storeName).getAllKeys();
      request.onsuccess = () => resolve(request.result.map(String).sort());
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

/** Null when the old writers' version still opens, else the error's name. */
function oldVersionOpens(from: LegacyKeyValueSource): Promise<string | null> {
  return new Promise((resolve) => {
    const request = indexedDB.open(from.dbName, from.fromVersion);
    request.onsuccess = () => {
      request.result.close();
      resolve(null);
    };
    request.onerror = () => resolve(request.error?.name ?? 'error');
  });
}

describe('the move of an old IndexedDB key-value store in a browser', () => {
  const opened: IndexedDbAdapter[] = [];

  /** The adapter the records move into, on a database of its own, and the store over it. */
  const target = async (): Promise<{ adapter: IndexedDbAdapter; into: (trx: StorageAdapter) => Promise<KeyValueStore>; store: KeyValueStore }> => {
    const adapter = new IndexedDbAdapter({ dbName: unique('new-store'), sqlJsConfig, durability: 'commit' });
    opened.push(adapter);
    await adapter.open();
    const into = async (trx: StorageAdapter): Promise<KeyValueStore> => namespaced(await createSqlKeyValueStore(trx, { table: TABLE }), PREFIX);
    return { adapter, into, store: await into(adapter) };
  };

  afterEach(async () => {
    for (const adapter of opened.splice(0)) {
      await adapter.close().catch(() => undefined);
    }
  });

  it("moves one namespace's records, removes them from the old store and locks the old version out", async () => {
    const from = source();
    await oldStore(from, {
      [`${PREFIX}doc`]: { text: '## Plan\nShip it.\n', saved: 1760500000000 },
      [`${PREFIX}items/1`]: { title: 'kept here', count: 2 },
      [`${OTHER_PREFIX}doc`]: { text: 'another namespace', saved: 2 },
    });
    const t = await target();

    expect(await migrateIndexedDbKeyValue({ source: from, adapter: t.adapter, into: t.into })).toBe('migrated');

    expect(await t.store.get('doc')).toEqual({ text: '## Plan\nShip it.\n', saved: 1760500000000 });
    expect(await t.store.get('items/1')).toEqual({ title: 'kept here', count: 2 });
    expect(await t.store.get(MIGRATION_MARKER)).toEqual({ phase: 'done' });
    expect(await oldKeys(from)).toEqual([`${OTHER_PREFIX}doc`]);
    expect(await oldVersionOpens(from)).toBe('VersionError');
  });

  it('answers blocked while an old connection is open, and moves once it closes', async () => {
    const from = source();
    const oldTab = await oldStore(from, { [`${PREFIX}doc`]: { text: 'one', saved: 1 } }, true);
    const t = await target();

    expect(await migrateIndexedDbKeyValue({ source: from, adapter: t.adapter, into: t.into })).toBe('blocked');
    expect(await t.store.keys('')).toEqual([]);

    // The upgrade the blocked attempt left waiting runs once the old tab closes, and is aborted; the next open waits
    // behind it in the database's queue.
    oldTab?.close();
    expect(await migrateIndexedDbKeyValue({ source: from, adapter: t.adapter, into: t.into })).toBe('migrated');
    expect(await t.store.get('doc')).toEqual({ text: 'one', saved: 1 });
    expect(await oldKeys(from)).toEqual([]);
  });

  it("keeps each value as the browser's structured clone held it", async () => {
    const from = source();
    const value = {
      title: 'two',
      seen: new Date(Date.UTC(2026, 9, 15, 12, 30)),
      bytes: new Uint8Array([0, 1, 254, 255]),
      tags: new Map<string, number>([['a', 1]]),
      // eslint-disable-next-line no-sparse-arrays
      list: [1, , 3],
      extra: undefined,
    };
    await oldStore(from, { [`${PREFIX}items/2`]: value });
    const t = await target();

    expect(await migrateIndexedDbKeyValue({ source: from, adapter: t.adapter, into: t.into })).toBe('migrated');

    expect(await t.store.get('items/2')).toStrictEqual(structuredClone(value));
  });
});
