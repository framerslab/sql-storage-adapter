import type { SqlDialect } from './dialect.js';
import type { IFullTextSearch } from './fts.js';
import type { IBlobCodec } from './blobCodec.js';
import type { IDatabaseExporter } from './exporter.js';
import type { StorageAdapter } from './index.js';
import { SqliteDialect } from '../../dialects/SqliteDialect.js';
import { PostgresDialect } from '../../dialects/PostgresDialect.js';
import { SqliteFts5 } from '../../fts/SqliteFts5.js';
import { PostgresFts } from '../../fts/PostgresFts.js';
import { NodeBlobCodec } from '../../codecs/NodeBlobCodec.js';
import { BrowserBlobCodec } from '../../codecs/BrowserBlobCodec.js';
import { SqliteFileExporter } from '../../exporters/SqliteFileExporter.js';
import { PostgresExporter, type PostgresExporterOptions } from '../../exporters/PostgresExporter.js';

/** Connection settings, as the Postgres adapter's options and a pg Pool's `options` hold them. */
interface PostgresConnectionLike {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  /** pg also takes a function here, which a connection string cannot hold. */
  password?: unknown;
  ssl?: boolean | object;
}

interface PostgresAdapterOptionsLike extends PostgresConnectionLike {
  segment?: string;
  /** A pool of the caller's; a pg Pool keeps the settings it was made with as `options`. */
  pool?: { options?: PostgresConnectionLike } | null;
}

/** A connection string pg_dump reaches the database of these settings with. */
function connectionStringOf(settings: PostgresConnectionLike | undefined): string | undefined {
  if (!settings) return undefined;
  if (settings.connectionString) return settings.connectionString;
  if (!settings.database) return undefined;

  const host = settings.host ?? 'localhost';
  const port = settings.port ?? 5432;
  const user = settings.user ? encodeURIComponent(settings.user) : '';
  // A password pg reads from a function is left to PGPASSWORD or ~/.pgpass.
  const password = typeof settings.password === 'string' && settings.password ? `:${encodeURIComponent(settings.password)}` : '';
  const auth = user ? `${user}${password}@` : '';
  const sslQuery = settings.ssl ? '?sslmode=require' : '';
  return `postgresql://${auth}${host}:${port}/${encodeURIComponent(settings.database)}${sslQuery}`;
}

/**
 * Where the exporter of a Postgres adapter reaches its database, and what it
 * exports: the adapter's own connection settings, else the settings of the
 * pool its caller gave it; the segment's schema alone on a segmented adapter.
 */
function postgresExport(adapter: StorageAdapter): { connectionString?: string; options: PostgresExporterOptions } {
  const options = (adapter as StorageAdapter & { options?: PostgresAdapterOptionsLike }).options;
  const exportOptions: PostgresExporterOptions = options?.segment ? { schema: options.segment } : {};
  const connectionString = connectionStringOf(options) ?? connectionStringOf(options?.pool?.options);
  if (connectionString === undefined && options?.pool) {
    exportOptions.missingConnection =
      'PostgresExporter: the adapter runs on a pool its caller made, and the pool names no connection string or ' +
      'database for pg_dump to reach. Make the pool with a connectionString, or with host, database, user and password.';
  }
  return { connectionString, options: exportOptions };
}

/**
 * Bundle of platform-aware database features.
 *
 * Created by `createStorageFeatures(adapter)` — consumers use this
 * instead of writing raw platform-specific SQL.
 */
export interface StorageFeatures {
  readonly dialect: SqlDialect;
  readonly fts: IFullTextSearch;
  readonly blobCodec: IBlobCodec;
  readonly exporter: IDatabaseExporter;
}

/**
 * Create a platform-aware feature bundle for the given storage adapter.
 *
 * Inspects `adapter.kind` and the runtime environment to select the right
 * dialect, FTS, BLOB codec, and exporter implementations.
 */
export function createStorageFeatures(adapter: StorageAdapter): StorageFeatures {
  const isPostgres = adapter.kind === 'postgres';
  const isBrowser = typeof window !== 'undefined' && typeof window.document !== 'undefined';
  const postgresTarget = isPostgres ? postgresExport(adapter) : undefined;

  return {
    dialect: isPostgres ? new PostgresDialect() : new SqliteDialect(),
    fts: isPostgres ? new PostgresFts() : new SqliteFts5(),
    blobCodec: isBrowser ? new BrowserBlobCodec() : new NodeBlobCodec(),
    exporter: postgresTarget
      ? new PostgresExporter(postgresTarget.connectionString, postgresTarget.options)
      : new SqliteFileExporter(adapter),
  };
}
