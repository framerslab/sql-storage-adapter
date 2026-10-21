/**
 * The browser's half of the package: the IndexedDB adapter with its durable commits and cross-tab coordination, the
 * key-value module with the move of an old IndexedDB key-value store into it, the cross-tab lock, and the mutation
 * sync's client with its wire contract, its transport, its loop and its change channel. Nothing here imports a Node
 * built-in or a server driver.
 *
 * @packageDocumentation
 * @module @framers/sql-storage-adapter/browser
 */
export type { StorageAdapter, StorageCapability, StorageParameters, StorageRunResult } from './core/contracts';
export {
  IndexedDbAdapter,
  IndexedDbConflictError,
  type IndexedDbAdapterOptions,
  type IndexedDbCrossTabOptions,
  type IndexedDbDurability,
  type IndexedDbLockManager,
} from './adapters/indexedDbAdapter';
export * from './features/kv';
export * from './features/sync/mutations/counter';
export * from './features/sync/mutations/wire';
export * from './features/sync/mutations/rows';
export * from './features/sync/mutations/tabLock';
export * from './features/sync/mutations/packing';
export * from './features/sync/mutations/transport';
export * from './features/sync/mutations/client';
export * from './features/sync/mutations/loop';
export * from './features/sync/mutations/channel';
