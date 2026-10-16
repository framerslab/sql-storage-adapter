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
import { PostgresExporter } from '../../exporters/PostgresExporter.js';

interface PostgresAdapterOptionsLike {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  ssl?: boolean | object;
}

function extractPostgresConnectionString(adapter: StorageAdapter): string | undefined {
  const options = (adapter as StorageAdapter & { options?: PostgresAdapterOptionsLike }).options;
  if (!options) return undefined;
  if (options.connectionString) return options.connectionString;
  if (!options.database) return undefined;

  const host = options.host ?? 'localhost';
  const port = options.port ?? 5432;
  const user = options.user ? encodeURIComponent(options.user) : '';
  const password = options.password ? `:${encodeURIComponent(options.password)}` : '';
  const auth = user ? `${user}${password}@` : '';
  const sslQuery = options.ssl ? '?sslmode=require' : '';
  return `postgresql://${auth}${host}:${port}/${options.database}${sslQuery}`;
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
  const postgresConnectionString = isPostgres ? extractPostgresConnectionString(adapter) : undefined;

  return {
    dialect: isPostgres ? new PostgresDialect() : new SqliteDialect(),
    fts: isPostgres ? new PostgresFts() : hasFts5 ? new SqliteFts5() : new SqliteFts4(),
    blobCodec: isBrowser ? new BrowserBlobCodec() : new NodeBlobCodec(),
    exporter: isPostgres
      ? new PostgresExporter(postgresConnectionString)
      : new SqliteFileExporter(adapter),
  };
}
