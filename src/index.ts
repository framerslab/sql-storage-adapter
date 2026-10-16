// Public type surface -------------------------------------------------------
export * from './types';

// Core runtime APIs ---------------------------------------------------------
export * from './core/database';
export * from './core/resolver';

// Adapter implementations ----------------------------------------------------
export * from './adapters/betterSqliteAdapter';
export * from './adapters/sqlJsAdapter';
export * from './adapters/indexedDbAdapter';
export * from './adapters/capacitorSqliteAdapter';
export * from './adapters/postgresAdapter';
export * from './adapters/supabase';
export * from './adapters/baseStorageAdapter';

// Note: Electron adapter is available via separate entry point to avoid
// bundling Electron dependencies in non-Electron builds.
// Usage: import { createElectronMainAdapter, createElectronRendererAdapter } from '@framers/sql-storage-adapter/electron';
// Preload: import '@framers/sql-storage-adapter/electron/preload';

// Feature modules ------------------------------------------------------------
export * from './features/backup/cloudBackup';
export * from './features/migrations/dataExport';
export * from './features/migrations/dataImport';
export * from './features/migrations/migration';
export * from './features/migrations/schemaMigrations';
export * from './features/auth/authJsAdapter';
export * from './features/sync/syncManager';

// Note: Cross-platform sync is available via separate entry point for cleaner imports.
// Usage: import { createCrossPlatformSync } from '@framers/sql-storage-adapter/sync';

// Shared utilities -----------------------------------------------------------
export * from './shared/parameterUtils';
export { segmentFilePath, segmentName, validateSegment } from './shared/segment';

// Note: the key-value store is available via a separate entry point, which loads no adapter.
// Usage: import { createSqlKeyValueStore, openIndexedDbStore } from '@framers/sql-storage-adapter/kv';

// Dialect & feature abstractions -----------------------------------------------
export { SqliteDialect } from './dialects/SqliteDialect';
export { PostgresDialect } from './dialects/PostgresDialect';
export { SqliteFts5 } from './fts/SqliteFts5';
export { PostgresFts } from './fts/PostgresFts';
export { NodeBlobCodec } from './codecs/NodeBlobCodec';
export { BrowserBlobCodec } from './codecs/BrowserBlobCodec';
export { SqliteFileExporter } from './exporters/SqliteFileExporter';
export { PostgresExporter } from './exporters/PostgresExporter';
export { createStorageFeatures } from './core/contracts/features';
export { isUniqueViolation } from './shared/errors';
export { setStorageLogger, getStorageLogger, type StorageLogger } from './shared/logger';
