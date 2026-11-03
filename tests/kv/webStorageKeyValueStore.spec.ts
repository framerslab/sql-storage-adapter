import { describe, expect, it } from 'vitest';

import { namespaced, StorageFullError, WebStorageKeyValueStore } from '../../src/features/kv/index.js';
import { encodeValue } from '../../src/features/kv/valueCodec.js';

/** A `Storage` as a page has one, held in a map, with a hook that can make the next write throw. */
class MapStorage implements Storage {
  readonly items = new Map<string, string>();
  /** When set, `setItem` throws what this answers instead of writing. */
  failNextWrite: (() => unknown) | null = null;

  get length(): number {
    return this.items.size;
  }

  clear(): void {
    this.items.clear();
  }

  getItem(key: string): string | null {
    return this.items.has(key) ? (this.items.get(key) as string) : null;
  }

  key(index: number): string | null {
    return [...this.items.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.items.delete(key);
  }

  setItem(key: string, value: string): void {
    if (this.failNextWrite) {
      const thrown = this.failNextWrite();
      this.failNextWrite = null;
      throw thrown;
    }
    this.items.set(key, String(value));
  }

  [name: string]: unknown;
}

describe('WebStorageKeyValueStore', () => {
  it("round-trips the codec's values through set and get, and keeps them past the page", async () => {
    const storage = new MapStorage();
    const store = new WebStorageKeyValueStore(storage);
    const saved = new Date('2026-10-20T09:30:00.000Z');

    await store.set('text', 'Hotel: 14 rooms held until 20 October.');
    await store.set('number', 14);
    await store.set('date', saved);
    await store.set('list', ['venue', 'hotel', 3]);
    await store.set('note', { id: 'n1', version: 2, keywords: ['hotel'], nested: { done: false } });
    await store.set('nothing', undefined);

    expect(await store.get('text')).toBe('Hotel: 14 rooms held until 20 October.');
    expect(await store.get('number')).toBe(14);
    const date = await store.get<Date>('date');
    expect(date).toBeInstanceOf(Date);
    expect(date?.toISOString()).toBe(saved.toISOString());
    expect(await store.get('list')).toEqual(['venue', 'hotel', 3]);
    expect(await store.get('note')).toEqual({ id: 'n1', version: 2, keywords: ['hotel'], nested: { done: false } });
    expect(await store.keys('nothing')).toEqual(['nothing']);
    expect(await store.get('nothing')).toBeUndefined();
    expect(await store.get('never-set')).toBeUndefined();
    expect(store.memoryOnly).toBe(false);

    // A second store over the same storage reads what the first wrote, as a reload of the tab would.
    expect(await new WebStorageKeyValueStore(storage).get('number')).toBe(14);
  });

  it('lists the keys under a prefix in order, deletes them alone, and deletes a missing key without error', async () => {
    const storage = new MapStorage();
    const store = new WebStorageKeyValueStore(storage);
    await store.set('a/2', 2);
    await store.set('b/1', 'b');
    await store.set('a/1', 1);
    await store.set('ab', 'outside');

    expect(await store.keys('a/')).toEqual(['a/1', 'a/2']);
    await store.deletePrefix('a/');
    expect(await store.keys('')).toEqual(['ab', 'b/1']);
    await expect(store.delete('a/1')).resolves.toBeUndefined();
    await store.delete('ab');
    expect([...storage.items.keys()]).toEqual(['b/1']);
  });

  it('keeps two namespaces apart over one storage', async () => {
    const storage = new MapStorage();
    const store = new WebStorageKeyValueStore(storage);
    const x = namespaced(store, 'demo/x/');
    const y = namespaced(store, 'demo/y/');

    await x.set('notes', ['mine']);
    expect(await y.get('notes')).toBeUndefined();
    await y.set('notes', ['theirs']);
    await x.deletePrefix('');

    expect(await y.get('notes')).toEqual(['theirs']);
    expect(await x.keys('')).toEqual([]);
    expect([...storage.items.keys()]).toEqual(['demo/y/notes']);
  });

  it.each([
    ['named QuotaExceededError', () => new DOMException('quota', 'QuotaExceededError')],
    [
      'with code 22',
      () => {
        const error = new DOMException('quota', 'SomeOtherName');
        Object.defineProperty(error, 'code', { value: 22 });
        return error;
      },
    ],
    ['named NS_ERROR_DOM_QUOTA_REACHED', () => new DOMException('quota', 'NS_ERROR_DOM_QUOTA_REACHED')],
  ])('surfaces a full storage (a DOMException %s) as StorageFullError, naming no key or value', async (_label, make) => {
    const storage = new MapStorage();
    const store = new WebStorageKeyValueStore(storage);
    storage.failNextWrite = make;

    const failure = await store.set('demo/go-1/notes/secret-key', 'Parking: the garage on Rua Augusta.').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(StorageFullError);
    expect((failure as Error).name).toBe('StorageFullError');
    expect((failure as Error).message).not.toContain('secret-key');
    expect((failure as Error).message).not.toContain('Rua Augusta');
    expect(storage.items.size).toBe(0);
  });

  it('passes any other failure of a write through unchanged', async () => {
    const storage = new MapStorage();
    const store = new WebStorageKeyValueStore(storage);
    const security = new DOMException('denied', 'SecurityError');
    storage.failNextWrite = () => security;
    await expect(store.set('k', 1)).rejects.toBe(security);

    const plain = new TypeError('broken');
    storage.failNextWrite = () => plain;
    await expect(store.set('k', 1)).rejects.toBe(plain);
  });

  it("throws for a value in the codec's own format that is malformed, as the SQL store does, rather than reading it as missing", async () => {
    const storage = new MapStorage();
    const store = new WebStorageKeyValueStore(storage);
    // the codec's format marker, with a node of a kind the codec never writes
    storage.items.set('broken', '[1,["no such kind"]]');

    await expect(store.get('broken')).rejects.toThrow(/malformed/);
  });

  it("reads a value another writer put in a shape the codec does not write as undefined, never a throw", async () => {
    const storage = new MapStorage();
    const store = new WebStorageKeyValueStore(storage);
    storage.items.set('plain', 'not json at all');
    storage.items.set('json', JSON.stringify({ title: 'someone else' }));
    storage.items.set('array', '[2, "x"]');
    storage.items.set('good', encodeValue('kept'));

    await expect(store.get('plain')).resolves.toBeUndefined();
    await expect(store.get('json')).resolves.toBeUndefined();
    await expect(store.get('array')).resolves.toBeUndefined();
    await expect(store.get('good')).resolves.toBe('kept');
    expect(await store.keys('')).toEqual(['array', 'good', 'json', 'plain']);
  });
});
