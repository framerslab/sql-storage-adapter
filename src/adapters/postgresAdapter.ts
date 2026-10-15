// NOTE: Browser safety - we avoid throwing at module load so bundlers can include
// this file without crashing. A runtime error will be thrown inside `open()` if
// execution actually occurs in a browser.
const __isBrowser = typeof window !== 'undefined' && typeof window.document !== 'undefined';

// Dynamic import for pg to prevent bundlers from trying to bundle it in browser builds
type PgModule = typeof import('pg');
type Pool = import('pg').Pool;
type PoolClient = import('pg').PoolClient;
type PoolConfig = import('pg').PoolConfig;

import type { StorageAdapter, StorageCapability, StorageOpenOptions, StorageParameters, StorageRunResult } from '../core/contracts';
import { toPostgresStatement } from '../shared/sqlPlaceholders';
import { splitSqlStatements } from '../shared/splitSqlStatements';
import { getStorageLogger } from '../shared/logger';

/**
 * Configuration options for PostgreSQL adapter.
 * Supports both connection strings and granular configuration.
 */
export interface PostgresAdapterOptions {
  /** PostgreSQL connection string (e.g., 'postgresql://user:pass@host:5432/dbname') */
  connectionString?: string;
  /** Host name or IP address (default: localhost) */
  host?: string;
  /** Port number (default: 5432) */
  port?: number;
  /** Database name */
  database?: string;
  /** Username for authentication */
  user?: string;
  /** Password for authentication */
  password?: string;
  /** Enable SSL/TLS connection (recommended for remote) */
  ssl?: boolean | { rejectUnauthorized?: boolean; ca?: string; cert?: string; key?: string };
  /** Connection pool size (default: 10) */
  max?: number;
  /** Minimum pool size (default: 0) */
  min?: number;
  /** Idle timeout in ms (default: 10000) */
  idleTimeoutMillis?: number;
  /** Connection timeout in ms (default: 0 = no timeout) */
  connectionTimeoutMillis?: number;
  /** Application name for connection tracking */
  application_name?: string;
  /** Statement timeout in ms (0 = no timeout) */
  statement_timeout?: number;
  /** Query timeout in ms (0 = no timeout) */
  query_timeout?: number;
  /**
   * Let Node exit while every connection in the pool is idle (pg's
   * `allowExitOnIdle`). Default: false, so idle connections keep the process
   * running until `idleTimeoutMillis` closes them or `close()` ends the pool.
   */
  allowExitOnIdle?: boolean;
}

/** The isolation levels of PostgreSQL's `BEGIN`. */
export type PostgresIsolationLevel = 'read uncommitted' | 'read committed' | 'repeatable read' | 'serializable';

/** How a PostgreSQL transaction begins. Left out, each mode is the server's default. */
export interface PostgresTransactionOptions {
  /** `BEGIN ISOLATION LEVEL ...`. The server's default is `read committed` unless configured otherwise. */
  isolationLevel?: PostgresIsolationLevel;
  /** `READ ONLY` when true, `READ WRITE` when false. */
  readOnly?: boolean;
  /** `DEFERRABLE` when true, `NOT DEFERRABLE` when false. It changes only serializable read-only transactions. */
  deferrable?: boolean;
}

/** The counts of a Postgres adapter's connection pool. */
export interface PostgresPoolStats {
  /** Connections the pool holds, checked out or idle. */
  total: number;
  /** Connections idle in the pool. */
  idle: number;
  /** Callers waiting for a connection. */
  waiting: number;
}

/**
 * One pooled connection, held for a `withConnection()` callback. Its
 * statements run outside a transaction unless the callback opens one, and
 * session state (`SET`, session advisory locks, temporary tables) lasts until
 * the connection closes.
 */
export interface PostgresConnection extends StorageAdapter {
  /** Runs `fn` in a transaction on this connection. One transaction at a time. */
  transaction<T>(fn: (trx: StorageAdapter) => Promise<T>, options?: PostgresTransactionOptions): Promise<T>;
}

const ISOLATION_LEVELS = new Map<string, string>([
  ['read uncommitted', 'READ UNCOMMITTED'],
  ['read committed', 'READ COMMITTED'],
  ['repeatable read', 'REPEATABLE READ'],
  ['serializable', 'SERIALIZABLE'],
]);

/** The BEGIN statement for `options`. Refuses an isolation level it does not know, before any SQL is sent. */
const beginStatement = (options?: PostgresTransactionOptions): string => {
  const modes: string[] = [];
  if (options?.isolationLevel !== undefined) {
    const level = ISOLATION_LEVELS.get(options.isolationLevel);
    if (!level) {
      throw new Error(
        `Unknown isolation level "${String(options.isolationLevel)}". Use 'read uncommitted', 'read committed', 'repeatable read' or 'serializable'.`,
      );
    }
    modes.push(`ISOLATION LEVEL ${level}`);
  }
  if (options?.readOnly !== undefined) modes.push(options.readOnly ? 'READ ONLY' : 'READ WRITE');
  if (options?.deferrable !== undefined) modes.push(options.deferrable ? 'DEFERRABLE' : 'NOT DEFERRABLE');
  return modes.length > 0 ? `BEGIN ${modes.join(', ')}` : 'BEGIN';
};

/**
 * A connection's transaction status: 'I' idle, 'T' in a transaction, 'E' in
 * a failed one. pg reports it from 8.21; null on an older pg.
 */
const transactionStatus = (client: PoolClient): string | null => {
  const read = (client as unknown as { getTransactionStatus?: () => string | null }).getTransactionStatus;
  return typeof read === 'function' ? read.call(client) : null;
};

/** The statement and values node-postgres receives: see toPostgresStatement. */
const prepareStatement = toPostgresStatement;

/** Execute a mutation through a specific pool or transaction client. */
const runWithExecutor = async (
  executor: Pool | PoolClient,
  statement: string,
  parameters?: StorageParameters
): Promise<StorageRunResult> => {
  const { text, values } = prepareStatement(statement, parameters);
  const result = await executor.query(text, values);
  const firstRow: unknown = result.rows?.[0];
  const lastInsertRowid =
    firstRow && typeof firstRow === 'object' && 'id' in (firstRow as Record<string, unknown>)
      ? ((firstRow as Record<string, unknown>).id as number | string | null)
      : null;
  return { changes: result.rowCount ?? 0, lastInsertRowid };
};

/** Read one row through a specific pool or transaction client. */
const getWithExecutor = async <T>(
  executor: Pool | PoolClient,
  statement: string,
  parameters?: StorageParameters
): Promise<T | null> => {
  const { text, values } = prepareStatement(statement, parameters);
  const result = await executor.query(text, values);
  return (result.rows?.[0] as T) ?? null;
};

/** Read every matching row through a specific pool or transaction client. */
const allWithExecutor = async <T>(
  executor: Pool | PoolClient,
  statement: string,
  parameters?: StorageParameters
): Promise<T[]> => {
  const { text, values } = prepareStatement(statement, parameters);
  const result = await executor.query(text, values);
  return (result.rows as T[]) ?? [];
};

/** Execute a statement script through a specific pool or transaction client. */
const execWithExecutor = async (executor: Pool | PoolClient, script: string): Promise<void> => {
  const statements = splitSqlStatements(script);
  for (const text of statements) {
    await executor.query(text);
  }
};

/**
 * Adapter view bound to one checked-out transaction client while its
 * transaction runs. Each concurrent transaction receives its own instance, so
 * callback queries cannot leak onto another callback's client through shared
 * mutable state. Once its transaction has ended, the client may be another
 * caller's, so the view sends its statements to `afterEnd` instead: the
 * adapter's pool, or the held connection the transaction ran on.
 */
class PostgresTransactionAdapter implements StorageAdapter {
  public readonly kind = 'postgres';
  private ended = false;

  constructor(
    private readonly client: PoolClient,
    public readonly capabilities: ReadonlySet<StorageCapability>,
    private readonly afterEnd: StorageAdapter
  ) {}

  public async open(): Promise<void> {
    // The owning PostgresAdapter opens the pool before creating this view.
  }

  public async run(
    statement: string,
    parameters?: StorageParameters
  ): Promise<StorageRunResult> {
    if (this.ended) return this.afterEnd.run(statement, parameters);
    return runWithExecutor(this.client, statement, parameters);
  }

  public async get<T>(statement: string, parameters?: StorageParameters): Promise<T | null> {
    if (this.ended) return this.afterEnd.get<T>(statement, parameters);
    return getWithExecutor<T>(this.client, statement, parameters);
  }

  public async all<T>(statement: string, parameters?: StorageParameters): Promise<T[]> {
    if (this.ended) return this.afterEnd.all<T>(statement, parameters);
    return allWithExecutor<T>(this.client, statement, parameters);
  }

  public async exec(script: string): Promise<void> {
    if (this.ended) return this.afterEnd.exec(script);
    await execWithExecutor(this.client, script);
  }

  public async transaction<T>(fn: (trx: StorageAdapter) => Promise<T>): Promise<T> {
    // After the transaction has ended, a new one begins where afterEnd runs it.
    if (this.ended) return this.afterEnd.transaction(fn);
    // Nested callbacks share the outer transaction. Errors still reach the
    // owning adapter, which rolls the entire transaction back.
    return fn(this);
  }

  public async close(): Promise<void> {
    // The owning transaction releases the checked-out client after completion.
  }

  /** @internal runTransaction() calls this when the transaction has ended. */
  public end(): void {
    this.ended = true;
  }
}

/** An unknown thrown value as an Error. */
const asError = (value: unknown): Error => (value instanceof Error ? value : new Error(String(value)));

/**
 * Puts a failed ROLLBACK's error on the transaction's error, as a
 * non-enumerable `rollbackError` property, when that error can take one.
 */
const keepRollbackError = (error: unknown, rollbackError: Error): void => {
  if (typeof error !== 'object' || error === null || !Object.isExtensible(error)) return;
  try {
    Object.defineProperty(error, 'rollbackError', {
      value: rollbackError,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  } catch {
    // A non-configurable rollbackError is already there: keep it.
  }
};

/**
 * Listens for a connection error on a checked-out client until `stop()`. pg
 * emits a client's connection error (the server ending the session, a broken
 * socket) on the client when no query is running, and pg-pool listens only on
 * idle clients, so without this an unheard error event would end the process.
 */
const watchClient = (client: PoolClient): { failure: () => Error | undefined; stop: () => void } => {
  let failure: Error | undefined;
  // A pg-compatible pool whose clients are not event emitters emits nothing to hear.
  if (typeof client.on !== 'function' || typeof client.removeListener !== 'function') {
    return { failure: () => undefined, stop: () => undefined };
  }
  const onError = (error: Error): void => {
    if (!failure) failure = error;
  };
  client.on('error', onError);
  return {
    failure: () => failure,
    stop: () => {
      client.removeListener('error', onError);
    },
  };
};

/**
 * Runs `fn` in a transaction that `begin` opens on `client`: COMMIT when `fn`
 * resolves, ROLLBACK when `fn` or COMMIT throws, and that error is rethrown.
 * `onBroken` hears when the connection cannot be trusted any more (BEGIN or
 * ROLLBACK failed), so the caller closes it instead of returning it to the
 * pool. When ROLLBACK fails, the original error is still the one thrown, with
 * the ROLLBACK error on it as `rollbackError`.
 */
const runTransaction = async <T>(
  client: PoolClient,
  begin: string,
  fn: (trx: StorageAdapter) => Promise<T>,
  capabilities: ReadonlySet<StorageCapability>,
  afterEnd: StorageAdapter,
  onBroken: (error: Error) => void
): Promise<T> => {
  try {
    await client.query(begin);
  } catch (error) {
    onBroken(asError(error));
    throw error;
  }
  const handle = new PostgresTransactionAdapter(client, capabilities, afterEnd);
  try {
    const result = await fn(handle);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      const failure = asError(rollbackError);
      onBroken(failure);
      keepRollbackError(error, failure);
      getStorageLogger().warn(
        { adapter: 'postgres', error: failure.message },
        `PostgreSQL ROLLBACK failed after a transaction error, so the connection was closed; the transaction's own error is rethrown. ${failure.message}`
      );
    }
    throw error;
  } finally {
    handle.end();
  }
};

/**
 * The connection a `withConnection()` callback holds. It refuses statements
 * once the callback has ended, when the connection is back in the pool or
 * closed.
 */
class PostgresConnectionAdapter implements PostgresConnection {
  public readonly kind = 'postgres';
  private ended = false;
  private transactionOpen = false;

  constructor(
    private readonly client: PoolClient,
    public readonly capabilities: ReadonlySet<StorageCapability>
  ) {}

  public async open(): Promise<void> {
    // withConnection() checks the connection out before the callback runs.
  }

  public async run(statement: string, parameters?: StorageParameters): Promise<StorageRunResult> {
    return runWithExecutor(this.live(), statement, parameters);
  }

  public async get<T>(statement: string, parameters?: StorageParameters): Promise<T | null> {
    return getWithExecutor<T>(this.live(), statement, parameters);
  }

  public async all<T>(statement: string, parameters?: StorageParameters): Promise<T[]> {
    return allWithExecutor<T>(this.live(), statement, parameters);
  }

  public async exec(script: string): Promise<void> {
    await execWithExecutor(this.live(), script);
  }

  public async transaction<T>(
    fn: (trx: StorageAdapter) => Promise<T>,
    options?: PostgresTransactionOptions
  ): Promise<T> {
    const begin = beginStatement(options);
    const client = this.live();
    if (this.transactionOpen) {
      throw new Error(
        'A transaction is already open on this connection. Run its statements through the handle its callback receives.'
      );
    }
    this.transactionOpen = true;
    try {
      return await runTransaction(client, begin, fn, this.capabilities, this, (error) => {
        if (!this.brokenBy) this.brokenBy = error;
      });
    } finally {
      this.transactionOpen = false;
    }
  }

  public async close(): Promise<void> {
    // withConnection() returns the connection to the pool, or closes it, when the callback ends.
  }

  /** @internal Why the connection cannot be trusted any more, when a transaction's BEGIN or ROLLBACK failed. */
  public brokenBy: Error | undefined;

  /** @internal withConnection() calls this when the callback ends. */
  public end(): void {
    this.ended = true;
  }

  private live(): PoolClient {
    if (this.ended) {
      throw new Error('This connection was handed back when its withConnection() callback ended.');
    }
    return this.client;
  }
}

/**
 * PostgreSQL adapter for production-grade SQL operations.
 *
 * ## Performance Characteristics
 * - Connection pooling for efficient resource usage
 * - Excellent concurrent access with MVCC
 * - Optimized for complex queries and large datasets
 * - ~10,000 queries/second with connection pooling
 *
 * ## Advantages
 * - Full SQL feature set (CTEs, window functions, etc.)
 * - Native JSON/JSONB support
 * - Robust replication and backup options
 * - Battle-tested in production environments
 * - Secure remote connections with SSL/TLS
 *
 * ## Limitations
 * - Requires separate server process
 * - Network latency for remote connections
 * - Higher resource consumption than SQLite
 * - Configuration complexity for optimal performance
 *
 * ## When to Use
 * - Production web applications
 * - Multi-user systems
 * - When you need advanced SQL features
 * - Cloud deployments (AWS RDS, Heroku, Supabase, etc.)
 * - Remote database access
 *
 * ## Remote Connection Examples
 * 
 * ### Connection String (Recommended)
 * ```typescript
 * const db = createPostgresAdapter({
 *   connectionString: 'postgresql://user:password@db.example.com:5432/mydb?sslmode=require'
 * });
 * ```
 * 
 * ### Granular Configuration
 * ```typescript
 * const db = createPostgresAdapter({
 *   host: 'db.example.com',
 *   port: 5432,
 *   database: 'mydb',
 *   user: 'dbuser',
 *   password: 'secure_password',
 *   ssl: true,  // Enable SSL for security
 *   max: 20,    // Connection pool size
 *   statement_timeout: 30000  // 30 second timeout
 * });
 * ```
 * 
 * ### Cloud Provider Examples
 * 
 * #### AWS RDS
 * ```typescript
 * const db = createPostgresAdapter({
 *   host: 'mydb.abc123.us-east-1.rds.amazonaws.com',
 *   port: 5432,
 *   database: 'postgres',
 *   user: 'admin',
 *   password: process.env.RDS_PASSWORD,
 *   ssl: { rejectUnauthorized: true }
 * });
 * ```
 * 
 * #### Heroku Postgres
 * ```typescript
 * const db = createPostgresAdapter({
 *   connectionString: process.env.DATABASE_URL,
 *   ssl: { rejectUnauthorized: false }  // Heroku uses self-signed certs
 * });
 * ```
 * 
 * #### Supabase
 * ```typescript
 * const db = createPostgresAdapter({
 *   connectionString: process.env.SUPABASE_DB_URL,
 *   ssl: true
 * });
 * ```
 * 
 * #### DigitalOcean Managed Database
 * ```typescript
 * const db = createPostgresAdapter({
 *   host: 'db-postgresql-nyc3-12345.ondigitalocean.com',
 *   port: 25060,
 *   database: 'defaultdb',
 *   user: 'doadmin',
 *   password: process.env.DO_DB_PASSWORD,
 *   ssl: { rejectUnauthorized: true, ca: process.env.DO_CA_CERT }
 * });
 * ```
 *
 * ## Connection failures
 * - The pool drops a connection that fails, and the next query opens a new one.
 * - The adapter never falls back to SQLite. `resolveStorageAdapter()` without
 *   `strict` tries its next candidate when Postgres fails to open; with
 *   `strict`, and in `createDatabase()` given a Postgres URL, it throws.
 *
 * ## Pool control
 * - `withConnection(fn)` holds one connection for `fn`: session settings,
 *   session advisory locks, and statements that must run outside a
 *   transaction.
 * - `getPoolStats()` counts the pool's connections and waiting callers.
 * - `transaction(fn, { isolationLevel, readOnly, deferrable })` sets how the
 *   transaction begins.
 * - `allowExitOnIdle` lets Node exit while the pool is idle.
 */
/**
 * Production-grade PostgreSQL adapter backed by pg.Pool.
 *
 * Safe to import in browser bundles; will only throw if `open()` is invoked
 * in a browser environment.
 */
export class PostgresAdapter implements StorageAdapter {
  public readonly kind = 'postgres';
  public readonly capabilities: ReadonlySet<StorageCapability> = new Set<StorageCapability>([
    'transactions',  // Full ACID transaction support
    'locks',         // Row-level and advisory locks
    'persistence',   // Data persisted to disk
    'concurrent',    // Excellent concurrent access
    'json',          // Native JSON/JSONB support
    'arrays',        // Native array data types
    'prepared'       // Prepared statements for security/performance
  ]);

  private options: PostgresAdapterOptions;
  private pool: Pool | null = null;
  private pgModule: PgModule | null = null;

  constructor(options: PostgresAdapterOptions | string) {
    // Support both string and object initialization
    if (typeof options === 'string') {
      this.options = { connectionString: options };
    } else {
      this.options = options;
    }
  }

  /**
   * Lazy loader for pg module to keep the dependency optional and prevent bundling in browser builds.
   */
  private async loadPgModule(): Promise<PgModule> {
    if (this.pgModule) {
      return this.pgModule;
    }

    if (__isBrowser) {
      throw new Error('[StorageAdapter] PostgreSQL adapter cannot be used in a browser environment.');
    }

    try {
      // Dynamic import prevents bundlers from including pg in browser builds
      this.pgModule = await import('pg') as unknown as PgModule;
      return this.pgModule;
    } catch (error) {
      throw new Error(`[StorageAdapter] Failed to load pg module. Install it with: npm install pg. Error: ${error}`);
    }
  }

  public async open(openOptions?: StorageOpenOptions): Promise<void> {
    if (this.pool) {
      return;
    }

    if (__isBrowser) {
      throw new Error('[StorageAdapter] PostgreSQL adapter cannot be opened in a browser environment.');
    }

    // Load pg module dynamically
    const pg = await this.loadPgModule();
    const { Pool } = pg;

    // Build pool configuration
    const poolConfig: PoolConfig = {};

    // Use connection string if provided
    if (this.options.connectionString || openOptions?.connectionString) {
      poolConfig.connectionString = openOptions?.connectionString ?? this.options.connectionString;
    } else {
      // Build from individual options
      poolConfig.host = this.options.host ?? 'localhost';
      poolConfig.port = this.options.port ?? 5432;
      poolConfig.database = this.options.database;
      poolConfig.user = this.options.user;
      poolConfig.password = this.options.password;
    }

    // Pool configuration
    if (this.options.max !== undefined) poolConfig.max = this.options.max;
    if (this.options.min !== undefined) poolConfig.min = this.options.min;
    if (this.options.idleTimeoutMillis !== undefined) {
      poolConfig.idleTimeoutMillis = this.options.idleTimeoutMillis;
    }
    if (this.options.connectionTimeoutMillis !== undefined) {
      poolConfig.connectionTimeoutMillis = this.options.connectionTimeoutMillis;
    }
    if (this.options.application_name !== undefined) {
      poolConfig.application_name = this.options.application_name;
    }
    if (this.options.statement_timeout !== undefined) {
      poolConfig.statement_timeout = this.options.statement_timeout;
    }
    if (this.options.query_timeout !== undefined) {
      poolConfig.query_timeout = this.options.query_timeout;
    }
    if (this.options.allowExitOnIdle !== undefined) {
      poolConfig.allowExitOnIdle = this.options.allowExitOnIdle;
    }

    // SSL configuration
    if (this.options.ssl !== undefined) {
      poolConfig.ssl = this.options.ssl;
    }

    this.pool = new Pool(poolConfig);

    // Test connection
    const client = await this.pool.connect();
    client.release();
  }

  public async run(statement: string, parameters?: StorageParameters): Promise<StorageRunResult> {
    const executor = await this.getExecutor();
    return runWithExecutor(executor, statement, parameters);
  }

  public async get<T>(statement: string, parameters?: StorageParameters): Promise<T | null> {
    const executor = await this.getExecutor();
    return getWithExecutor<T>(executor, statement, parameters);
  }

  public async all<T>(statement: string, parameters?: StorageParameters): Promise<T[]> {
    const executor = await this.getExecutor();
    return allWithExecutor<T>(executor, statement, parameters);
  }

  public async exec(script: string): Promise<void> {
    const executor = await this.getExecutor();
    await execWithExecutor(executor, script);
  }

  /**
   * Runs `fn` in a transaction on one pooled connection: COMMIT when it
   * resolves, ROLLBACK when it or COMMIT throws, and that error is rethrown.
   * `options` sets the isolation level and the read-only and deferrable modes;
   * an unknown isolation level is refused before a connection is checked out.
   *
   * When ROLLBACK fails too (the connection broke), the error thrown is still
   * the transaction's own, with the ROLLBACK error on it as `rollbackError`,
   * and the connection is closed instead of returned to the pool. The handle
   * `fn` receives runs on the pool once the transaction has ended.
   */
  public async transaction<T>(
    fn: (trx: StorageAdapter) => Promise<T>,
    options?: PostgresTransactionOptions
  ): Promise<T> {
    const begin = beginStatement(options);
    const client = await this.requirePool().connect();
    const watch = watchClient(client);
    let brokenBy: Error | undefined;
    try {
      return await runTransaction(client, begin, fn, this.capabilities, this, (error) => {
        if (!brokenBy) brokenBy = error;
      });
    } finally {
      watch.stop();
      client.release(brokenBy ?? watch.failure());
    }
  }

  /**
   * Holds one pooled connection for `fn`, for work that needs one session:
   * `SET` and other session settings, session advisory locks
   * (`pg_advisory_lock`), temporary tables, or statements that must not run
   * inside a transaction. Its statements run outside a transaction unless
   * `fn` opens one with `connection.transaction()` or `BEGIN`.
   *
   * When `fn` resolves, the connection goes back to the pool with its session
   * state, so undo what `fn` set (or use `SET LOCAL` inside a transaction).
   * When `fn` throws, the connection is closed instead, which ends its session
   * state and any transaction it left open, and `fn`'s error is rethrown.
   * When `fn` resolves inside a transaction it began and did not end, the
   * connection is closed, which rolls the transaction back, and the call
   * rejects (pg 8.21 and later report the transaction status). The connection
   * refuses statements once `fn` has ended. A connection that broke while `fn`
   * held it (the server ended the session) is closed, not returned.
   */
  public async withConnection<T>(fn: (connection: PostgresConnection) => Promise<T>): Promise<T> {
    const client = await this.requirePool().connect();
    const watch = watchClient(client);
    const connection = new PostgresConnectionAdapter(client, this.capabilities);
    let releaseError: Error | undefined;
    try {
      const result = await fn(connection);
      const status = transactionStatus(client);
      if (status === 'T' || status === 'E') {
        releaseError = new Error(
          'withConnection(): the callback returned inside an open transaction. The connection was closed, which rolled the transaction back. End each transaction the callback begins, or run it through connection.transaction().'
        );
        throw releaseError;
      }
      return result;
    } catch (error) {
      // The connection may hold session state or an open transaction that
      // fn did not undo: close it rather than hand it to the next caller.
      if (!releaseError) {
        releaseError = error instanceof Error ? error : new Error(String(error));
      }
      throw error;
    } finally {
      connection.end();
      watch.stop();
      client.release(releaseError ?? connection.brokenBy ?? watch.failure());
    }
  }

  /** The pool's counts, or null when the adapter is not open. */
  public getPoolStats(): PostgresPoolStats | null {
    if (!this.pool) {
      return null;
    }
    return { total: this.pool.totalCount, idle: this.pool.idleCount, waiting: this.pool.waitingCount };
  }

  public async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  private async getExecutor(): Promise<Pool | PoolClient> {
    return this.requirePool();
  }

  private requirePool(): Pool {
    if (!this.pool) {
      throw new Error('Postgres adapter not opened.');
    }
    return this.pool;
  }
}

/**
 * Create a PostgreSQL adapter with connection string.
 * @param connectionString - PostgreSQL connection string
 * @example
 * ```typescript
 * const db = createPostgresAdapter('postgresql://user:pass@localhost:5432/mydb');
 * ```
 */
export function createPostgresAdapter(connectionString: string): StorageAdapter;

/**
 * Create a PostgreSQL adapter with configuration options.
 * @param options - PostgreSQL adapter configuration
 * @example
 * ```typescript
 * const db = createPostgresAdapter({
 *   host: 'db.example.com',
 *   database: 'mydb',
 *   user: 'dbuser',
 *   password: 'secure_password',
 *   ssl: true
 * });
 * ```
 */
export function createPostgresAdapter(options: PostgresAdapterOptions): StorageAdapter;

export function createPostgresAdapter(
  optionsOrString: PostgresAdapterOptions | string
): StorageAdapter {
  return new PostgresAdapter(optionsOrString);
}
