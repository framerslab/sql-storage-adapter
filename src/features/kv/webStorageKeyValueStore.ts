/**
 * @fileoverview A key-value store over the page's Web Storage (`sessionStorage` for a tab's own copy, `localStorage`
 * for a product that wants one), under the `KeyValueStore` contract: values through the module's codec, keys listed
 * and removed by prefix, a full storage surfaced as the store's own refusal. The tab's store of a demo visitor: its
 * notes live as long as the tab, and nothing of them reaches IndexedDB or a server.
 * @module sql-storage-adapter/kv/webStorageKeyValueStore
 */

import type { KeyValueStore } from './keyValueStore';
import { decodeValue, encodeValue } from './valueCodec';

/** The storage refused a write for want of room: the caller says so in its own words; the message names no key or value. */
export class StorageFullError extends Error {
  constructor() {
    super('the web storage is full');
    this.name = 'StorageFullError';
  }
}

/** True for the exception every engine throws when a `Storage` is full. */
function isQuotaError(error: unknown): boolean {
  return (
    typeof DOMException !== 'undefined' &&
    error instanceof DOMException &&
    (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED' || error.code === 22)
  );
}

/**
 * A `KeyValueStore` over a `Storage`. Each value is kept as the codec's text, so a value comes back as the structured
 * clone gives it back (a `Date` as a `Date`, `undefined` as a held key with no value). A value under a key that is not
 * the codec's text (another writer's) reads as undefined. Nothing of it outlives what the browser keeps of that
 * storage: `sessionStorage` goes with the tab.
 */
export class WebStorageKeyValueStore implements KeyValueStore {
  /** Always false: the values live as long as the storage keeps them. */
  readonly memoryOnly = false;

  constructor(private readonly storage: Storage) {}

  /** The value held under `key`, or undefined when there is none or it is not the codec's text. */
  async get<T = unknown>(key: string): Promise<T | undefined> {
    const text = this.storage.getItem(key);
    if (text === null) return undefined;
    try {
      return decodeValue(text) as T;
    } catch {
      return undefined;
    }
  }

  /**
   * Holds `value` under `key`, in place of what was there.
   *
   * @throws {StorageFullError} When the storage has no room for it; nothing is written.
   * @throws {Error} A `DataCloneError` for a value the codec refuses, or whatever else the storage throws, unchanged.
   */
  async set(key: string, value: unknown): Promise<void> {
    const text = encodeValue(value);
    try {
      this.storage.setItem(key, text);
    } catch (error) {
      if (isQuotaError(error)) throw new StorageFullError();
      throw error;
    }
  }

  /** Removes `key`. A key that is not held is no error. */
  async delete(key: string): Promise<void> {
    this.storage.removeItem(key);
  }

  /** Every key that begins with `prefix`, in order. */
  async keys(prefix: string): Promise<string[]> {
    const found: string[] = [];
    for (let index = 0; index < this.storage.length; index += 1) {
      const key = this.storage.key(index);
      if (key !== null && key.startsWith(prefix)) found.push(key);
    }
    return found.sort();
  }

  /** Removes every key that begins with `prefix`. */
  async deletePrefix(prefix: string): Promise<void> {
    for (const key of await this.keys(prefix)) this.storage.removeItem(key);
  }
}
