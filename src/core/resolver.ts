// Browser-safe path utilities - avoid importing Node.js 'path' module in browser builds
const isBrowser = typeof window !== 'undefined' && typeof window.document !== 'undefined';
const isNode = typeof process !== 'undefined' && !!process.versions?.node;

// Browser-safe path join (only used in Node.js environments)
const joinPath = async (parts: string[]): Promise<string> => {
  if (isBrowser) {
    // In browser, just join with '/' (not used anyway since filePath is provided)
    return parts.join('/');
  }
  // In Node.js, use path.join dynamically
  if (isNode) {
    try {
      // Dynamic import to avoid bundling 'path' in browser builds
      const path = await import('path');
      return path.join(...parts);
    } catch {
      // Fallback if import fails
      return parts.join('/');
    }
  }
  return parts.join('/');
};

// Browser-safe process.env access
const getEnv = (key: string): string | undefined => {
  if (typeof process !== 'undefined' && process.env) {
    return process.env[key];
  }
  return undefined;
};

// Browser-safe process.cwd()
const getCwd = (): string => {
  if (isNode && typeof process !== 'undefined' && process.cwd) {
    return process.cwd();
  }
  // Browser fallback (not used in browser anyway)
  return '/';
};

import type { StorageAdapter, StorageAdapterFactory, StorageOpenOptions } from './contracts';
import { StorageResolutionError } from './contracts';
import type { AdapterKind } from './contracts/context';
import { createBetterSqliteAdapter } from '../adapters/betterSqliteAdapter';
import { createSqlJsAdapter } from '../adapters/sqlJsAdapter';
import { createCapacitorSqliteAdapter, type CapacitorAdapterOptions } from '../adapters/capacitorSqliteAdapter';
import { createPostgresAdapter, type PostgresAdapterOptions } from '../adapters/postgresAdapter';
import { IndexedDbAdapter, type IndexedDbAdapterOptions } from '../adapters/indexedDbAdapter';
import { isNonEmpty, namesPostgresServer } from '../shared/postgresTarget';
import { validateSegment } from '../shared/segment';
import { getStorageLogger, type StorageLogger } from '../shared/logger';

// Re-export AdapterKind for external use
export type { AdapterKind } from './contracts/context';

export interface StorageResolutionOptions {
  /** Absolute path for sqlite file (used by better-sqlite3/sql.js when persistence is desired). */
  filePath?: string;
  /**
   * Explicit adapter priority override. The resolver builds `postgres`,
   * `better-sqlite3`, `capacitor`, `indexeddb` and `sqljs`; `memory` builds
   * sql.js, as `sqljs` does. Any other kind (`electron-main`,
   * `electron-renderer`, `supabase`, or an unknown name) fails as a candidate
   * with an error that names it, and the resolver goes on to the next one.
   */
  priority?: AdapterKind[];
  /** Options passed to the Capacitor adapter. */
  capacitor?: CapacitorAdapterOptions;
  /**
   * Options passed to the Postgres adapter, all of them: a connection string,
   * or host, port, database, user and password, and the pool, SSL and timeout
   * settings. Without a connection string or a host, database or user here,
   * the connection string comes from DATABASE_URL.
   */
  postgres?: PostgresAdapterOptions;
  /** Options passed to the IndexedDB adapter (browser persistence), all of them. */
  indexedDb?: IndexedDbAdapterOptions;
  /** Options forwarded to adapter.open. */
  openOptions?: StorageOpenOptions;
  /** Suppress fallback chain logs (adapter not-found warnings). Default: false. */
  quiet?: boolean;
  /**
   * The logger for this call's resolver lines (pino's fits). Default: the one
   * `setStorageLogger()` set, else the console.
   */
  logger?: StorageLogger;
  /**
   * Strict resolution, for servers: only the database the options name opens.
   * Default: false.
   *
   * - The postgres candidate is the last one tried. When it fails to open,
   *   resolution throws a `StorageResolutionError` instead of trying a local
   *   SQLite database, whatever `priority` lists after it.
   * - A Postgres server named by `postgres` or `DATABASE_URL`, with no
   *   `priority`, makes `['postgres']` the whole list.
   * - An explicit `filePath` outranks `DATABASE_URL`: with a `filePath` and no
   *   `postgres` options that name a server, `DATABASE_URL` is not read.
   * - `postgres` options that name no server, with no `DATABASE_URL` to fill
   *   in and no `filePath`, fail instead of opening the local default.
   *
   * Without `strict`, a postgres candidate that fails falls through to the
   * next candidate, and `DATABASE_URL` puts Postgres first even when a
   * `filePath` is given.
   */
  strict?: boolean;
  /**
   * Keeps the resolved adapter's tables apart from other users of the same
   * database: on PostgreSQL a schema of the segment's name, on better-sqlite3
   * and sql.js a file with the segment in its name (`app.sqlite3` becomes
   * `app-agentos.sqlite3`), on IndexedDB and Capacitor a database name with
   * the segment appended (`app-db-agentos`). Lower-case letters, digits and
   * underscores; not `public`, `information_schema` or a name beginning with
   * `pg_`. A name that cannot be a segment is refused before any adapter is
   * tried, here or in `postgres`, `indexedDb` or `capacitor`, and so is a
   * segment with `postgres.pool`, which the Postgres adapter cannot start in
   * the segment. Takes the place of a `segment` in `postgres`, `indexedDb` or
   * `capacitor`.
   *
   * Without it, a candidate whose options name no segment of their own
   * (better-sqlite3 and sql.js have none), tried after a candidate whose
   * options named one and failed, opens in that candidate's segment: a
   * resolution that asked for a segment never falls through to the database
   * every user of the file or the browser shares.
   */
  segment?: string;
}

interface CapacitorGlobal {
  Capacitor?: {
    isNativePlatform?: () => boolean;
  };
}

const isCapacitorRuntime = (): boolean => {
  if (typeof window === 'undefined') {
    return false;
  }
  const maybeCapacitor = (window as Window & CapacitorGlobal).Capacitor;
  return Boolean(maybeCapacitor?.isNativePlatform?.());
};

/**
 * Detect if running in Electron main process.
 */
const isElectronMain = (): boolean => {
  return typeof process !== 'undefined' &&
    Boolean(process.versions?.electron) &&
    (process as NodeJS.Process & { type?: string }).type === 'browser';
};

/**
 * Detect if running in Electron renderer process.
 */
const isElectronRenderer = (): boolean => {
  return typeof window !== 'undefined' &&
    typeof process !== 'undefined' &&
    Boolean(process.versions?.electron) &&
    (process as NodeJS.Process & { type?: string }).type === 'renderer';
};

interface Candidate {
  name: AdapterKind;
  /** The segment the candidate's own options name: `postgres`, `indexedDb` or `capacitor`. */
  ownSegment?: string;
  /** Builds the candidate's adapter, in `segment` or with none. */
  build: (segment: string | undefined) => ReturnType<StorageAdapterFactory>;
  openOptions?: StorageOpenOptions;
}

/** A `segment` option, or none. */
const withSegment = (segment: string | undefined): { segment?: string } =>
  segment === undefined ? {} : { segment };

/** The error of a candidate the resolver cannot build. */
const unsupportedKind = (kind: string): Error => {
  switch (kind) {
    case 'electron-main':
      return new Error(
        `The resolver cannot build adapter kind "${kind}". Create it with createElectronMainAdapter from '@framers/sql-storage-adapter/electron'.`,
      );
    case 'electron-renderer':
      return new Error(
        `The resolver cannot build adapter kind "${kind}". Create it with createElectronRendererAdapter from '@framers/sql-storage-adapter/electron'.`,
      );
    case 'supabase':
      return new Error(
        `The resolver cannot build adapter kind "${kind}". Use kind "postgres" with the Supabase connection string, or create a SupabaseAdapter.`,
      );
    default:
      return new Error(
        `Unknown adapter kind "${kind}". The resolver builds postgres, better-sqlite3, capacitor, indexeddb, sqljs and memory.`,
      );
  }
};

/**
 * Resolves the most appropriate storage adapter for the current runtime.
 * Tries candidates in the supplied priority order and falls back when one fails.
 */
export const resolveStorageAdapter = async (options: StorageResolutionOptions = {}): Promise<StorageAdapter> => {
  // A segment name is a programming error, not an adapter that failed: refuse
  // it before trying any, the resolver's own and each adapter's alike.
  const segment = options.segment === undefined ? undefined : validateSegment(options.segment);
  for (const own of [options.postgres?.segment, options.indexedDb?.segment, options.capacitor?.segment]) {
    if (own !== undefined) validateSegment(own);
  }
  // A segment on a pool of the caller's never opens: the Postgres adapter sets
  // the segment's search_path when it starts a connection, and it does not
  // start the connections of a pool it did not make. Without strict, the
  // failed postgres candidate would fall through to a local file in the
  // segment, so the pair is refused before any adapter is tried.
  if ((segment ?? options.postgres?.segment) !== undefined && options.postgres?.pool) {
    throw new Error(
      "A segment cannot run on a PostgreSQL pool of the caller's (postgres.pool): the segment's search_path is set when " +
        'each connection of the pool starts, and the adapter does not start the connections of a pool it did not make. ' +
        'Give the connection settings and the segment instead of the pool.',
    );
  }
  const envOverride = getEnv('STORAGE_ADAPTER') as AdapterKind | undefined;
  const log = options.logger ?? getStorageLogger();
  const strict = options.strict === true;
  const postgresOptions = options.postgres;
  const explicitConnection = postgresOptions?.connectionString;
  // In strict resolution an explicit file path outranks DATABASE_URL.
  const fileOutranksEnv = strict && isNonEmpty(options.filePath);
  // Explicit options that name a server are the target; DATABASE_URL fills in
  // only when they name none.
  const postgresConnection = isNonEmpty(explicitConnection)
    ? explicitConnection
    : namesPostgresServer(postgresOptions) || fileOutranksEnv
      ? undefined
      : getEnv('DATABASE_URL') || undefined;
  const postgresTarget = isNonEmpty(postgresConnection) || namesPostgresServer(postgresOptions);
  const defaultFilePath = isBrowser ? 'db_data/app.sqlite3' : await joinPath([getCwd(), 'db_data', 'app.sqlite3']);
  const filePath = options.filePath ?? defaultFilePath;

  const defaultPriority: AdapterKind[] = (() => {
    if (options.priority && options.priority.length > 0) {
      return options.priority;
    }
    if (envOverride) {
      return [envOverride];
    }
    // Electron detection - provide guidance to use dedicated Electron adapters
    if (isElectronMain()) {
      log.warn(
        { runtime: 'electron-main' },
        'Electron main process detected. ' +
        'Consider using the dedicated Electron adapter for full framework support:\n' +
        "  import { createElectronMainAdapter } from '@framers/sql-storage-adapter/electron';\n" +
        'Falling back to better-sqlite3 adapter.'
      );
      return ['better-sqlite3'];
    }
    if (isElectronRenderer()) {
      log.warn(
        { runtime: 'electron-renderer' },
        'Electron renderer process detected. ' +
        'For IPC-based database access, use the dedicated Electron adapter:\n' +
        "  import { createElectronRendererAdapter } from '@framers/sql-storage-adapter/electron';\n" +
        'Note: Direct database access in renderer is not recommended for security reasons.'
      );
      return ['indexeddb', 'sqljs'];
    }
    if (isCapacitorRuntime()) {
      return ['capacitor', 'indexeddb', 'sqljs'];
    }
    if (postgresTarget) {
      return strict ? ['postgres'] : ['postgres', 'better-sqlite3', 'indexeddb', 'sqljs'];
    }
    if (strict && postgresOptions !== undefined && !isNonEmpty(options.filePath)) {
      // Postgres is configured but names no server: the postgres candidate
      // fails with the reason, where the local default would hide it.
      return ['postgres'];
    }
    // Browser detection (check for IndexedDB)
    if (typeof window !== 'undefined' && window.indexedDB) {
      return ['indexeddb', 'sqljs'];
    }
    return ['better-sqlite3', 'indexeddb', 'sqljs'];
  })();

  const candidates: Candidate[] = defaultPriority.map((name) => {
    // A kind from STORAGE_ADAPTER or a host's list is any string at run time.
    switch (name as string) {
      case 'postgres': {
        return {
          name,
          ownSegment: postgresOptions?.segment,
          build: async (chosen: string | undefined) => {
            if (!postgresTarget) {
              throw new Error(
                fileOutranksEnv
                  ? 'A postgres connection string, or a postgres host, database or user is required. Strict resolution does not read DATABASE_URL when a filePath is given.'
                  : 'DATABASE_URL, a postgres connection string, or a postgres host, database or user is required.',
              );
            }
            return createPostgresAdapter({
              ...postgresOptions,
              ...(postgresConnection ? { connectionString: postgresConnection } : {}),
              ...withSegment(chosen),
            });
          },
          openOptions: postgresConnection ? { connectionString: postgresConnection } : undefined
        };
      }
      case 'better-sqlite3':
        return {
          name,
          build: async (chosen: string | undefined) => createBetterSqliteAdapter(filePath, withSegment(chosen)),
          openOptions: { filePath }
        };
      case 'capacitor':
        return {
          name,
          ownSegment: options.capacitor?.segment,
          build: async (chosen: string | undefined) => createCapacitorSqliteAdapter({ ...options.capacitor, ...withSegment(chosen) })
        };
      case 'indexeddb':
        return {
          name,
          ownSegment: options.indexedDb?.segment,
          build: async (chosen: string | undefined) => {
            // Use dedicated indexedDb options, fallback to legacy openOptions.adapterOptions
            const legacyOptions = options.openOptions?.adapterOptions as { dbName?: string } | undefined;
            return new IndexedDbAdapter({
              ...options.indexedDb,
              dbName: options.indexedDb?.dbName || legacyOptions?.dbName || 'app-db',
              autoSave: options.indexedDb?.autoSave ?? true,
              ...withSegment(chosen),
            });
          }
        };
      case 'sqljs':
      // Not an AdapterKind, but the README lists it and hosts pass it; it builds
      // what it has always built.
      case 'memory':
        return {
          name: 'sqljs',
          build: async (chosen: string | undefined) => createSqlJsAdapter(withSegment(chosen)),
          openOptions: { filePath }
        };
      default:
        return {
          name,
          build: async () => {
            throw unsupportedKind(name);
          }
        };
    }
  });

  const errors: unknown[] = [];
  const quiet = options.quiet === true;
  /**
   * The segment of the first candidate tried whose own options named one. A
   * candidate after it with no segment of its own opens in it, so a candidate
   * that asked for a segment and failed never falls through to the database
   * every user of the file or the browser shares.
   */
  let askedFor: string | undefined;

  for (const candidate of candidates) {
    const chosen = segment ?? candidate.ownSegment ?? askedFor;
    askedFor ??= candidate.ownSegment;
    try {
      const adapter = await candidate.build(chosen);
      const openOptions: StorageOpenOptions = {
        ...candidate.openOptions,
        ...options.openOptions,
      };
      await adapter.open(openOptions);
      if (!quiet) {
        log.info(
          chosen === undefined ? { adapter: candidate.name } : { adapter: candidate.name, segment: chosen },
          `Using adapter "${candidate.name}"${chosen === undefined ? '' : ` for segment "${chosen}"`}.`,
        );
      }
      return adapter;
    } catch (error) {
      errors.push(error);
      if (strict && candidate.name === 'postgres') {
        const msg = error instanceof Error ? error.message : String(error);
        throw new StorageResolutionError(
          `PostgreSQL could not be opened, and strict resolution does not fall back to a local database. ${msg}`,
          errors,
        );
      }
      if (!quiet) {
        const msg = error instanceof Error ? error.message : String(error);
        log.warn({ adapter: candidate.name, error: msg }, `${candidate.name} not available, trying next. ${msg}`);
      }
      continue;
    }
  }

  throw new StorageResolutionError('Unable to resolve a storage adapter for the current environment.', errors);
};

