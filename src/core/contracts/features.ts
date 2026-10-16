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
  port?: number | string;
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

/** What the exporter reads of a Postgres adapter. */
interface PostgresAdapterLike {
  options?: PostgresAdapterOptionsLike;
  /** The pool the adapter runs on: the pool it made when it opened, or its caller's; null while it is closed. */
  getPool?: () => { options?: PostgresConnectionLike } | null;
}

/** A connection string pg_dump reaches the database of these settings with. */
function connectionStringOf(settings: PostgresConnectionLike | undefined): string | undefined {
  if (!settings) return undefined;
  if (settings.connectionString) return settings.connectionString;
  if (!settings.database) return undefined;

  // libpq percent-decodes each part of a URI, so a host that is a Unix-socket
  // directory goes in encoded: postgresql://%2Fvar%2Frun%2Fpostgresql:5432/app.
  const host = encodeURIComponent(settings.host ?? 'localhost');
  const port = settings.port ?? 5432;
  const user = settings.user ? encodeURIComponent(settings.user) : '';
  // A password pg reads from a function is left to PGPASSWORD or ~/.pgpass.
  const password = typeof settings.password === 'string' && settings.password ? `:${encodeURIComponent(settings.password)}` : '';
  // A password with no user name goes in too: libpq takes the user name from PGUSER or the operating system.
  const auth = user || password ? `${user}${password}@` : '';
  const sslQuery = settings.ssl ? '?sslmode=require' : '';
  return `postgresql://${auth}${host}:${port}/${encodeURIComponent(settings.database)}${sslQuery}`;
}

/**
 * The exporter of a Postgres adapter. It names the adapter's database when an
 * export runs: the pool the adapter runs on names the database it reaches,
 * the connection string `open()` was given included; before the adapter
 * opens, its own settings name it, or those of the pool its caller gave it.
 * A segmented adapter exports its segment's schema alone.
 */
function postgresExporterOf(adapter: StorageAdapter): PostgresExporter {
  const postgres = adapter as StorageAdapter & PostgresAdapterLike;
  const options = postgres.options;
  const exportOptions: PostgresExporterOptions = {
    ...(options?.segment ? { schema: options.segment } : {}),
    missingConnection: options?.pool
      ? 'PostgresExporter: the adapter runs on a pool its caller made, and the pool names no connection string or ' +
        'database for pg_dump to reach. Make the pool with a connectionString, or with host, database, user and password.'
      : 'PostgresExporter: the adapter names no database for pg_dump to reach. Make it with a connectionString, or ' +
        'with host, database and user, or export once open() has been given a connection string.',
  };
  const connectionString = (): string | undefined => {
    const pool = typeof postgres.getPool === 'function' ? postgres.getPool() : null;
    return connectionStringOf(pool?.options) ?? connectionStringOf(options) ?? connectionStringOf(options?.pool?.options);
  };
  return new PostgresExporter(connectionString, exportOptions);
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

  return {
    dialect: isPostgres ? new PostgresDialect() : new SqliteDialect(),
    fts: isPostgres ? new PostgresFts() : new SqliteFts5(),
    blobCodec: isBrowser ? new BrowserBlobCodec() : new NodeBlobCodec(),
    exporter: isPostgres ? postgresExporterOf(adapter) : new SqliteFileExporter(adapter),
  };
}
