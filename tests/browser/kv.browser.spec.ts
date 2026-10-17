import { describe, expect, it, afterEach } from 'vitest';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import browserWasmUrl from 'sql.js/dist/sql-wasm-browser.wasm?url';
import { IndexedDbAdapter } from '../../src/adapters/indexedDbAdapter';
import { createSqlKeyValueStore, openIndexedDbStore } from '../../src/features/kv/index';

// The key-value module in the browsers themselves, Chromium, WebKit and
// Firefox: the IndexedDB store reads a database another page made where it is,
// and the SQL store, over the IndexedDB adapter, gives back each value as the
// browser's own structured clone (which IndexedDB applies to every value it
// stores) does.

const sqlJsConfig = {
  locateFile: (file: string): string => (file.includes('browser') ? browserWasmUrl : wasmUrl),
};

/** A database name no other test uses. */
const unique = (name: string): string => `${name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** Makes a database with one object store, as another page would, and puts `values` in it. */
const makeDatabase = (dbName: string, storeName: string, values: Record<string, unknown>): Promise<void> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(storeName);
    };
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(storeName, 'readwrite');
      for (const [key, value] of Object.entries(values)) tx.objectStore(storeName).put(value, key);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onabort = () => reject(tx.error);
    };
    request.onerror = () => reject(request.error);
  });

/** What IndexedDB gives back for `value`: its structured clone, made by the browser. */
const throughIndexedDb = async (dbName: string, value: unknown): Promise<unknown> => {
  await makeDatabase(dbName, 'kv', { value });
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);
    request.onsuccess = () => {
      const db = request.result;
      const read = db.transaction('kv', 'readonly').objectStore('kv').get('value');
      read.onsuccess = () => {
        db.close();
        resolve(read.result);
      };
      read.onerror = () => reject(read.error);
    };
    request.onerror = () => reject(request.error);
  });
};

class Point {
  constructor(
    public x: number,
    public y: number,
  ) {}
}

const values: Array<[string, () => unknown]> = [
  ['a string', () => 'notes | kw: a'],
  ['negative zero', () => -0],
  ['NaN', () => NaN],
  ['a bigint', () => 12345678901234567890123n],
  ['undefined', () => undefined],
  ['null', () => null],
  ['an object', () => ({ text: '## Note', saved: 1, tags: ['a', 'b'], missing: undefined })],
  // eslint-disable-next-line no-sparse-arrays
  ['an array with holes', () => [1, , 3]],
  ['a date', () => new Date(Date.UTC(2026, 9, 15, 12, 30))],
  ['a regular expression', () => /ab+c/gi],
  ['a map', () => new Map<unknown, unknown>([[1, 'one'], ['k', { v: 2 }]])],
  ['a set', () => new Set<unknown>([1, 'two'])],
  ['an ArrayBuffer', () => new Uint8Array([0, 1, 254, 255]).buffer],
  ['a Uint8Array', () => new Uint8Array([1, 2, 3])],
  ['a Float64Array', () => new Float64Array([1.5, -0, NaN])],
  ['a view into part of a buffer', () => new Uint16Array(new ArrayBuffer(16), 4, 3)],
  ['a DataView', () => new DataView(new Uint8Array([9, 8, 7, 6]).buffer, 1, 2)],
  ['a class instance', () => new Point(3, 4)],
  ['a TypeError', () => new TypeError('bad input')],
];

describe('the key-value module in a browser', () => {
  const opened: Array<{ close(): unknown }> = [];

  afterEach(async () => {
    for (const item of opened.splice(0)) {
      await Promise.resolve(item.close()).catch(() => undefined);
    }
  });

  it('reads a database another page made where it is', async () => {
    const dbName = unique('made-before');
    await makeDatabase(dbName, 'kv', {
      'acct/cards': { text: '## Note | kw: a', saved: 1 },
      'acct/lib/s/1': { title: 'One', bytes: new Uint8Array([1, 2]).buffer },
    });

    const store = await openIndexedDbStore({ dbName, storeName: 'kv' });
    opened.push(store);

    expect(store.memoryOnly).toBe(false);
    expect(await store.get('acct/cards')).toEqual({ text: '## Note | kw: a', saved: 1 });
    expect(await store.keys('acct/')).toEqual(['acct/cards', 'acct/lib/s/1']);
  });

  it.each(values)("gives back %s from the SQL store as the browser's structured clone does", async (_name, make) => {
    const adapter = new IndexedDbAdapter({ dbName: unique('kv-sql'), sqlJsConfig, durability: 'commit' });
    opened.push(adapter);
    await adapter.open();
    const store = await createSqlKeyValueStore(adapter, { table: 'kv' });

    await store.set('value', make());
    const back = await store.get('value');

    expect(back).toStrictEqual(await throughIndexedDb(unique('kv-clone'), make()));
    expect(back).toStrictEqual(structuredClone(make()));
  });

  it('refuses a Blob, which it cannot hold as text', async () => {
    const adapter = new IndexedDbAdapter({ dbName: unique('kv-blob'), sqlJsConfig, durability: 'commit' });
    opened.push(adapter);
    await adapter.open();
    const store = await createSqlKeyValueStore(adapter, { table: 'kv' });

    const refused = await store.set('blob', new Blob(['bytes'])).then(
      () => null,
      (error: unknown) => error,
    );
    expect((refused as { name?: string } | null)?.name).toBe('DataCloneError');
  });
});
