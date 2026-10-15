/**
 * @fileoverview The key-value store over a SQL table, on any adapter: better-sqlite3 and sql.js files, the IndexedDB
 * adapter in a browser, Capacitor on a phone, PostgreSQL on a server. It answers the calls the IndexedDB store answers,
 * and gives back each value as the structured clone does (see `valueCodec`), so a host keeps one key-value contract on
 * every platform.
 * @module sql-storage-adapter/kv/sqlKeyValueStore
 */

import type { StorageAdapter } from '../../core/contracts';
import type { KeyValueStore } from './keyValueStore';
import { decodeValue, encodeValue } from './valueCodec';

/** Where the store keeps its keys and values. */
export interface SqlKeyValueStoreOptions {
  /**
   * The table: lower-case letters, digits and underscores, starting with a letter or an underscore, at most 63
   * characters. It is made, with a `key` and a `value` column, when it is missing.
   */
  table: string;
}

/** A table name the store takes: an unquoted PostgreSQL identifier, which SQLite takes too. */
const TABLE_PATTERN = /^[a-z_][a-z0-9_]*$/;

/** PostgreSQL's identifier limit. */
const MAX_TABLE_LENGTH = 63;

/** The length of `text` in characters (code points), as SQLite's and PostgreSQL's `substr` count them. */
const characters = (text: string): number => Array.from(text).length;

/**
 * The store over one table. Each call is one statement on the adapter, so it is atomic, and runs in the adapter's
 * transaction rules: through a transaction's handle it joins that transaction.
 *
 * Keys are text and are listed in the order of their UTF-16 code units, as IndexedDB orders them, whatever the
 * database's collation. On PostgreSQL a key cannot hold the NUL character, which its text type refuses.
 */
class SqlKeyValueStore implements KeyValueStore {
  /** True when the adapter keeps nothing past the process (an in-memory database). */
  readonly memoryOnly: boolean;

  constructor(
    private readonly adapter: StorageAdapter,
    private readonly table: string,
  ) {
    this.memoryOnly = !adapter.capabilities.has('persistence');
  }

  /** The value held under `key`, or undefined when there is none. */
  async get<T = unknown>(key: string): Promise<T | undefined> {
    const row = await this.adapter.get<{ value: string }>(`SELECT "value" FROM "${this.table}" WHERE "key" = ?`, [key]);
    return row ? (decodeValue(row.value) as T) : undefined;
  }

  /**
   * Holds `value` under `key`, in place of what was there. A value the structured clone refuses is refused with a
   * `DataCloneError` before anything is written, and the key keeps what it held.
   */
  async set(key: string, value: unknown): Promise<void> {
    const text = encodeValue(value);
    await this.adapter.run(
      `INSERT INTO "${this.table}" ("key", "value") VALUES (?, ?) ON CONFLICT ("key") DO UPDATE SET "value" = excluded."value"`,
      [key, text],
    );
  }

  /** Removes `key`. A key that is not held is no error. */
  async delete(key: string): Promise<void> {
    await this.adapter.run(`DELETE FROM "${this.table}" WHERE "key" = ?`, [key]);
  }

  /**
   * Every key that begins with `prefix`, in order. The prefix is read literally: `%`, `_` and `*` are characters,
   * not patterns.
   */
  async keys(prefix: string): Promise<string[]> {
    const rows =
      prefix === ''
        ? await this.adapter.all<{ key: string }>(`SELECT "key" FROM "${this.table}"`)
        : await this.adapter.all<{ key: string }>(
            `SELECT "key" FROM "${this.table}" WHERE substr("key", 1, ?) = ?`,
            [characters(prefix), prefix],
          );
    return rows
      .map((row) => row.key)
      .filter((key) => key.startsWith(prefix))
      .sort();
  }

  /** Removes every key that begins with `prefix`; with an empty prefix, every key of the table. */
  async deletePrefix(prefix: string): Promise<void> {
    if (prefix === '') {
      await this.adapter.run(`DELETE FROM "${this.table}"`);
      return;
    }
    await this.adapter.run(`DELETE FROM "${this.table}" WHERE substr("key", 1, ?) = ?`, [characters(prefix), prefix]);
  }

  /** Does nothing: the adapter is its caller's, who closes it. */
  close(): void {}
}

/**
 * Opens the key-value store over `options.table` on `adapter`, making the table when it is missing. The adapter must
 * be open; the store never closes it.
 *
 * @example
 * ```typescript
 * const db = await createDatabase({ segment: 'agentos' });
 * const kv = await createSqlKeyValueStore(db, { table: 'agentos_kv' });
 * await kv.set('notes/1', { title: 'One', saved: Date.now() });
 * ```
 *
 * @throws {Error} When `options.table` is not a table name the store takes.
 */
export async function createSqlKeyValueStore(
  adapter: StorageAdapter,
  options: SqlKeyValueStoreOptions,
): Promise<KeyValueStore & { close(): void }> {
  const table = options.table;
  if (typeof table !== 'string' || !TABLE_PATTERN.test(table) || table.length > MAX_TABLE_LENGTH) {
    throw new Error(
      `Invalid table name ${JSON.stringify(table)} for the key-value store: lower-case letters, digits and underscores, ` +
        `starting with a letter or an underscore, at most ${MAX_TABLE_LENGTH} characters.`,
    );
  }
  await adapter.exec(`CREATE TABLE IF NOT EXISTS "${table}" ("key" TEXT PRIMARY KEY NOT NULL, "value" TEXT NOT NULL)`);
  return new SqlKeyValueStore(adapter, table);
}
