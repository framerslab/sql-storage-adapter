/**
 * The adapter-free entry, `@framers/sql-storage-adapter/core`: the contracts and errors, the SQL dialects, full-text
 * search, codecs and exporters, `createStorageFeatures`, the schema-migration runner, `isUniqueViolation` and the
 * logger. It imports no adapter, so a server that takes its adapter from a per-adapter entry
 * (`@framers/sql-storage-adapter/postgres`) bundles neither sql.js nor the S3 client.
 *
 * @module
 */
export * from '../types';
export { SqliteDialect } from '../dialects/SqliteDialect';
export { PostgresDialect } from '../dialects/PostgresDialect';
export { SqliteFts5 } from '../fts/SqliteFts5';
export { SqliteFts4 } from '../fts/SqliteFts4';
export { PostgresFts } from '../fts/PostgresFts';
export { NodeBlobCodec } from '../codecs/NodeBlobCodec';
export { BrowserBlobCodec } from '../codecs/BrowserBlobCodec';
export { SqliteFileExporter } from '../exporters/SqliteFileExporter';
export { PostgresExporter } from '../exporters/PostgresExporter';
export { createStorageFeatures } from './contracts/features';
export { isUniqueViolation } from '../shared/errors';
export { setStorageLogger, getStorageLogger, type StorageLogger } from '../shared/logger';
export * from '../features/migrations/schemaMigrations';
export * from '../features/auth/authJsAdapter';
export * from '../shared/parameterUtils';
