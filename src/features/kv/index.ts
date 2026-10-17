/**
 * @fileoverview The key-value module, `@framers/sql-storage-adapter/kv`: one `KeyValueStore` contract and its
 * stores. `openIndexedDbStore` keeps values in one IndexedDB object store, moved unchanged from @framers/agentos, so a
 * page's keys stay where they are; `createSqlKeyValueStore` keeps them in a SQL table on any adapter; the memory store
 * keeps them for the page alone. `migrateIndexedDbKeyValue` moves one namespace of an old IndexedDB store into a
 * `KeyValueStore` over an adapter, behind a marker, its old writers locked out by the database's version.
 *
 * The module imports no adapter, so a page that loads it for its key-value store loads neither sql.js nor pg: the move
 * takes its adapter as an argument.
 * @module sql-storage-adapter/kv
 */

export { MemoryKeyValueStore, namespaced, type KeyValueStore } from './keyValueStore';
export { IndexedDbKeyValueStore, openIndexedDbStore, type IndexedDbStoreOptions } from './indexedDbKeyValueStore';
export {
  idb,
  type IdbDatabaseLike,
  type IdbKeyRangeLike,
  type IdbObjectStoreLike,
  type IdbOpenRequestLike,
  type IdbRequestLike,
  type IdbTransactionLike,
} from './idb';
export { createSqlKeyValueStore, type SqlKeyValueStoreOptions } from './sqlKeyValueStore';
export {
  migrateIndexedDbKeyValue,
  MIGRATION_MARKER,
  type LegacyKeyValueSource,
  type MigrateOptions,
  type MigrationOutcome,
} from './migrateIndexedDbKeyValue';
