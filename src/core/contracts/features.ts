import type { SqlDialect } from './dialect.js';
import type { IFullTextSearch } from './fts.js';
import type { IBlobCodec } from './blobCodec.js';
import type { IDatabaseExporter } from './exporter.js';
import type { StorageAdapter } from './index.js';
import { SqliteDialect } from '../../dialects/SqliteDialect.js';
import { PostgresDialect } from '../../dialects/PostgresDialect.js';
import { SqliteFts5 } from '../../fts/SqliteFts5.js';
import { SqliteFts4 } from '../../fts/SqliteFts4.js';
import { PostgresFts } from '../../fts/PostgresFts.js';
import { NodeBlobCodec } from '../../codecs/NodeBlobCodec.js';
import { BrowserBlobCodec } from '../../codecs/BrowserBlobCodec.js';
import { SqliteFileExporter } from '../../exporters/SqliteFileExporter.js';
import { PostgresExporter, type PostgresExporterOptions } from '../../exporters/PostgresExporter.js';
import { libpqConnectionStringOf, type PgConnectionSettings } from '../../exporters/pgConnection.js';

/**
 * A pg Pool as the exporter reads one: the settings it was made with (`options`) and the `Client` it makes its
 * connections with, which pg-pool keeps (pg-pool 3.14.0, `index.js:95`).
 */
interface PgPoolLike {
  options?: PgConnectionSettings;
  Client?: unknown;
}

interface PostgresAdapterOptionsLike extends PgConnectionSettings {
  segment?: string;
  /** A pool of the caller's. */
  pool?: PgPoolLike | null;
}

/** What the exporter reads of a Postgres adapter. */
interface PostgresAdapterLike {
  options?: PostgresAdapterOptionsLike;
  /** The pool the adapter runs on: the pool it made when it opened, or its caller's; null while it is closed. */
  getPool?: () => PgPoolLike | null;
}

/**
 * The settings of the pool a Postgres adapter makes when it opens, as its `poolConfig` makes them: the connection
 * string, or the host and port (localhost and 5432 when left out), database, user and password. Undefined when the
 * options name no server, so an adapter waiting for `open({ connectionString })` exports nothing before it opens.
 */
const ownPoolSettings = (options: PostgresAdapterOptionsLike | undefined): PgConnectionSettings | undefined => {
  if (!options) return undefined;
  if (options.connectionString) return { connectionString: options.connectionString, ssl: options.ssl };
  if (!options.host && !options.database && !options.user) return undefined;
  return {
    host: options.host ?? 'localhost',
    port: options.port ?? 5432,
    database: options.database,
    user: options.user,
    password: options.password,
    ssl: options.ssl,
  };
};

/**
 * The exporter of a Postgres adapter. When an export runs it reads the
 * connection of the pool the adapter runs on, as pg reads it (the connection
 * string `open()` was given included, and a password function of the pool's,
 * which it asks through the pool's own Client), and hands pg_dump a libpq URI
 * of it; before the adapter opens, the settings of the pool it will make, or of
 * the pool its caller gave it. A segmented adapter exports its segment's schema
 * alone.
 */
function postgresExporterOf(adapter: StorageAdapter): PostgresExporter {
  const postgres = adapter as StorageAdapter & PostgresAdapterLike;
  const options = postgres.options;
  const exportOptions: PostgresExporterOptions = {
    ...(options?.segment ? { schema: options.segment } : {}),
    // The URI holds the sslnegotiation the pool's pg reads, none where it reads none; libpq 17 would read this too.
    unsetEnvironment: ['PGSSLNEGOTIATION'],
    missingConnection: options?.pool
      ? 'PostgresExporter: the adapter runs on a pool its caller made, and the pool keeps no connection settings ' +
        'for pg_dump to reach. Make the pool with a connectionString, or with host, database, user and password.'
      : 'PostgresExporter: the adapter names no database for pg_dump to reach. Make it with a connectionString, or ' +
        'with host, database and user, or export once open() has been given a connection string.',
  };
  // A password function is asked through the Client of the pool whose settings are read; the pool the adapter will
  // make is of the pg this library loads.
  const connectionString = async (): Promise<string | undefined> => {
    const pool = typeof postgres.getPool === 'function' ? postgres.getPool() : null;
    if (pool?.options) return libpqConnectionStringOf(pool.options, pool.Client);
    const own = ownPoolSettings(options);
    if (own) return libpqConnectionStringOf(own);
    const given = options?.pool;
    return given?.options ? libpqConnectionStringOf(given.options, given.Client) : undefined;
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
  // The Supabase adapter runs PostgreSQL too.
  const isPostgres = adapter.kind === 'postgres' || adapter.kind === 'supabase-postgres';
  // sql.js, and the IndexedDB adapter over it, have FTS3 and FTS4 and no FTS5.
  const hasFts5 = adapter.kind !== 'sqljs' && adapter.kind !== 'indexeddb';
  const isBrowser = typeof window !== 'undefined' && typeof window.document !== 'undefined';

  return {
    dialect: isPostgres ? new PostgresDialect() : new SqliteDialect(),
    fts: isPostgres ? new PostgresFts() : hasFts5 ? new SqliteFts5() : new SqliteFts4(),
    blobCodec: isBrowser ? new BrowserBlobCodec() : new NodeBlobCodec(),
    exporter: isPostgres ? postgresExporterOf(adapter) : new SqliteFileExporter(adapter),
  };
}
