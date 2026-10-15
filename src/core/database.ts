/**
 * High-level, user-friendly API for SQL storage.
 * 
 * This module provides simple functions like:
 * - createDatabase() - Automatically picks the best database for your environment
 * - connectDatabase() - Explicit connection with clear options
 * - openDatabase() - Simple file-based database
 */

import { StorageResolutionError, type StorageAdapter } from './contracts';
import { resolveStorageAdapter, type StorageResolutionOptions, type AdapterKind } from './resolver';
import { hasPostgresConnection, namesPostgresServer } from '../shared/postgresTarget';
import type { PostgresAdapterOptions } from '../adapters/postgresAdapter';
import type { CapacitorAdapterOptions } from '../adapters/capacitorSqliteAdapter';
import type { IndexedDbAdapterOptions } from '../adapters/indexedDbAdapter';
import type { StorageLogger } from '../shared/logger';

/**
 * The options that configure Postgres: `url` when the caller set the key, even
 * to undefined (`{ url: process.env.DATABASE_URL }`), and `postgres`.
 */
const configuredPostgresOptions = (options: DatabaseOptions): Array<'url' | 'postgres'> => {
  const named: Array<'url' | 'postgres'> = [];
  if (Object.prototype.hasOwnProperty.call(options, 'url')) named.push('url');
  if (options.postgres !== undefined) named.push('postgres');
  return named;
};

/**
 * Database connection options.
 */
export interface DatabaseOptions {
  /**
   * Database URL (e.g., postgresql://user:pass@host/db).
   * A `postgres://` or `postgresql://` URL makes `createDatabase()` use
   * PostgreSQL on Node, with no fallback to SQLite, unless `priority` or
   * `type` says otherwise. A URL of another scheme (`file:./dev.db`,
   * `sqlite:...`) names no PostgreSQL server: the local default opens, or,
   * with `strict`, `createDatabase()` fails.
   */
  url?: string;
  
  /** 
   * File path for SQLite database.
   * Used for local/offline storage.
   */
  file?: string;
  
  /**
   * PostgreSQL-specific configuration, passed on to the Postgres adapter whole.
   * When it names a server (a `postgres://` or `postgresql://` connection
   * string, or a host, database or user), PostgreSQL is used on Node, with no
   * fallback to SQLite, unless `priority` or `type` says otherwise.
   * `{ connectionString: process.env.DATABASE_URL }` with DATABASE_URL unset,
   * or set to a URL of another scheme, names none, and the local default is
   * used. To open PostgreSQL from another form of connection string (a
   * `socket:` URL, a socket path), pass `type: 'postgres'` or use
   * `connectDatabase()`.
   */
  postgres?: PostgresAdapterOptions;
  
  /**
   * Mobile (Capacitor) configuration.
   * Automatically detected on mobile platforms.
   */
  mobile?: CapacitorAdapterOptions;

  /**
   * IndexedDB configuration for browser-native persistence.
   * Uses sql.js (WASM) for SQL execution + IndexedDB for storage.
   *
   * @example
   * ```typescript
   * const db = await createDatabase({
   *   priority: ['indexeddb', 'sqljs'],
   *   indexedDb: {
   *     dbName: 'my-app-db',
   *     sqlJsConfig: {
   *       locateFile: (file) => `/wasm/${file}`
   *     }
   *   }
   * });
   * ```
   */
  indexedDb?: IndexedDbAdapterOptions;

  /**
   * Force a specific database type.
   * Leave empty to auto-detect.
   */
  type?: 'postgres' | 'sqlite' | 'browser' | 'mobile' | 'memory';
  
  /**
   * Custom priority order for adapter selection.
   * Advanced: Only use if you need fine-grained control.
   */
  priority?: AdapterKind[];

  /**
   * Strict resolution, for servers: no local database stands in for a
   * Postgres the options configure. Default: false.
   *
   * - A `url` or `postgres` option that names no server (no `postgres://` or
   *   `postgresql://` connection string, and no host, database or user) fails
   *   on Node instead of opening the local default, unless `file` is given.
   * - A postgres candidate that fails ends resolution with an error, whatever
   *   `priority` lists after it.
   *
   * `DATABASE_URL` in the environment does not count here, strict or not.
   * See `StorageResolutionOptions.strict` for the resolver's side.
   */
  strict?: boolean;

  /**
   * SQLite: `true` turns foreign-key enforcement on and `false` turns it off
   * when the adapter opens, and the setting holds when sql.js reopens its
   * connection. Left out, each engine keeps its default: better-sqlite3
   * enforces foreign keys, sql.js, IndexedDB and Capacitor do not.
   * PostgreSQL always enforces them and ignores this. On the resolver, pass
   * `openOptions: { foreignKeys: true }`.
   */
  foreignKeys?: boolean;

  /**
   * The logger for this call's resolver lines (pino's fits). Default: the one
   * `setStorageLogger()` set, else the console.
   */
  logger?: StorageLogger;
}

/**
 * Create a database connection.
 * Automatically picks the best database for your environment.
 * 
 * @example
 * ```typescript
 * // The local default: better-sqlite3 (sql.js without it) on Node, sql.js in a
 * // browser. DATABASE_URL in the environment does not change it.
 * const db = await createDatabase();
 *
 * // PostgreSQL from DATABASE_URL on a server; strict fails when it is unset
 * // instead of opening a local file
 * const db = await createDatabase({
 *   url: process.env.DATABASE_URL,
 *   strict: true
 * });
 * 
 * // Specify file path
 * const db = await createDatabase({
 *   file: './my-app.db'
 * });
 * 
 * // Full PostgreSQL config
 * const db = await createDatabase({
 *   postgres: {
 *     host: 'db.example.com',
 *     database: 'myapp',
 *     user: 'dbuser',
 *     password: process.env.DB_PASSWORD,
 *     ssl: true
 *   }
 * });
 * ```
 */
/**
 * Create (or auto-resolve) the most appropriate database adapter for the current
 * runtime environment. Priority selection logic:
 *
 * 1. Explicit `options.priority` (caller-specified) wins entirely.
 * 2. Explicit `options.type` is mapped to a single adapter priority.
 * 3. Otherwise we auto-detect environment:
 *    - Browser / Deno: ['sqljs']
 *    - Node.js with a `postgres://` or `postgresql://` URL, or Postgres
 *      options that name a server: ['postgres']. There is no fallback to
 *      SQLite: data meant for Postgres would land in a local file. A URL of
 *      another scheme names no server. DATABASE_URL in the environment does
 *      not count here.
 *    - Node.js otherwise: ['better-sqlite3', 'sqljs'] (native first, wasm fallback)
 *
 * With `strict` on Node, a `url` or `postgres` option that names no server
 * throws instead of choosing the local default (unless `file` is given), and a
 * postgres candidate that fails ends resolution.
 *
 * The function never throws solely due to a native adapter absence; it falls
 * back to next candidates. Only when no candidate can open will it bubble an error.
 */
export async function createDatabase(options: DatabaseOptions = {}): Promise<StorageAdapter> {
  const resolverOptions: StorageResolutionOptions = {};

  const isBrowser = typeof window !== 'undefined' && typeof window.document !== 'undefined';
  const isNode = typeof process !== 'undefined' && !!process.versions?.node;
  // Use globalThis to avoid TS error when DOM lib not present
  // (declare loosely to prevent dependency on @types/deno)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const isDeno = typeof (globalThis as any).Deno !== 'undefined';

  // PostgreSQL: the options pass on whole; the URL fills in a connection
  // string they do not give.
  if (options.url || options.postgres) {
    resolverOptions.postgres = {
      ...options.postgres,
      connectionString: options.postgres?.connectionString || options.url || undefined,
    };
  }

  // Handle file path
  if (options.file) {
    resolverOptions.filePath = options.file;
  }

  // Handle mobile config
  if (options.mobile) {
    resolverOptions.capacitor = options.mobile;
  }

  // Handle IndexedDB config (browser persistence)
  if (options.indexedDb) {
    resolverOptions.indexedDb = options.indexedDb;
  }

  // Handle explicit type (maps to a canonical adapter kind)
  if (options.type) {
    const typeMap: Record<NonNullable<DatabaseOptions['type']>, AdapterKind> = {
      postgres: 'postgres',
      sqlite: 'better-sqlite3',
      browser: 'sqljs',
      mobile: 'capacitor',
      memory: 'better-sqlite3'
    };
    resolverOptions.priority = [typeMap[options.type]];
    if (options.type === 'memory') {
      resolverOptions.filePath = ':memory:';
    }
  }
  
  // Handle custom priority (highest precedence - override previous)
  if (options.priority) {
    resolverOptions.priority = options.priority;
  }

  if (options.strict) {
    resolverOptions.strict = true;
  }

  if (options.foreignKeys !== undefined) {
    resolverOptions.openOptions = { ...resolverOptions.openOptions, foreignKeys: options.foreignKeys };
  }

  if (options.logger) {
    resolverOptions.logger = options.logger;
  }

  // Auto-detect environment ONLY if no priority already set
  if (!resolverOptions.priority || resolverOptions.priority.length === 0) {
    if (isBrowser || isDeno) {
      // A browser cannot reach PostgreSQL, so a URL here changes nothing.
      resolverOptions.priority = ['sqljs'];
    } else if (isNode && namesPostgresServer(resolverOptions.postgres)) {
      resolverOptions.priority = ['postgres'];
    } else if (isNode && options.strict && !options.file && configuredPostgresOptions(options).length > 0) {
      const named = configuredPostgresOptions(options);
      throw new StorageResolutionError(
        `[StorageAdapter] Strict resolution: the ${named.join(' and ')} option${named.length > 1 ? 's name' : ' names'} no server. ` +
          'Give a postgres:// or postgresql:// connection string, or a host, database or user, or pass file to open a local database.',
      );
    } else if (isNode) {
      resolverOptions.priority = ['better-sqlite3', 'sqljs'];
    } else {
      // Extremely unusual runtime - be explicit and fail loudly so caller can decide
      throw new Error('[StorageAdapter] Unsupported runtime environment for automatic adapter selection.');
    }
  }

  const adapter = await resolveStorageAdapter(resolverOptions);
  await adapter.open(resolverOptions.openOptions);
  return adapter;
}

/**
 * Connect to a PostgreSQL server.
 *
 * Opens PostgreSQL alone, in every runtime: there is no fallback to a local
 * database, so a server that cannot be reached fails the call. Any connection
 * string pg reads is accepted (a `postgres://` or `postgresql://` URL, a
 * `socket:` URL, a socket path).
 *
 * @throws Error when the configuration names no server: an empty or unset
 *   connection string and no host, database or user, as
 *   `connectDatabase(process.env.DATABASE_URL)` gives with DATABASE_URL unset.
 *   Nothing is opened then; the call does not read DATABASE_URL on its own.
 *
 * @example
 * ```typescript
 * // Simple connection string
 * const db = await connectDatabase('postgresql://user:pass@host/db');
 *
 * // With full config
 * const db = await connectDatabase({
 *   host: 'db.example.com',
 *   database: 'myapp',
 *   user: 'dbuser',
 *   password: process.env.DB_PASSWORD,
 *   ssl: true
 * });
 * ```
 */
export async function connectDatabase(
  config: string | PostgresAdapterOptions
): Promise<StorageAdapter> {
  // A plain JavaScript caller can pass undefined (an unset environment variable) or null.
  const postgres: PostgresAdapterOptions =
    typeof config === 'string' ? { connectionString: config } : { ...(config ?? {}) };
  if (!hasPostgresConnection(postgres)) {
    throw new Error(
      'connectDatabase() was given no PostgreSQL server to connect to: pass a connection string, or options with ' +
        'a connectionString, host, database or user. An unset DATABASE_URL gives an empty connection string.',
    );
  }
  return createDatabase({ postgres, priority: ['postgres'] });
}

/**
 * Open a local database file.
 * 
 * @example
 * ```typescript
 * // SQLite file
 * const db = await openDatabase('./my-app.db');
 * 
 * // In-memory database
 * const db = await openDatabase(':memory:');
 * ```
 */
export async function openDatabase(filePath: string): Promise<StorageAdapter> {
  return createDatabase({ file: filePath });
}

/**
 * Create an in-memory database.
 * Perfect for testing or temporary storage.
 * 
 * @example
 * ```typescript
 * const db = await createMemoryDatabase();
 * await db.exec('CREATE TABLE users (id INTEGER, name TEXT)');
 * ```
 */
export async function createMemoryDatabase(): Promise<StorageAdapter> {
  return openDatabase(':memory:');
}

// Re-export for backwards compatibility
export { resolveStorageAdapter } from './resolver';
