/**
 * Supabase Postgres Storage Adapter
 * Provides full Postgres capabilities with Supabase's managed infrastructure
 *
 * @deprecated Use the PostgreSQL adapter with the Supabase connection string:
 * `createPostgresAdapter({ connectionString, ssl: { rejectUnauthorized: true, ca } })`
 * from `@framers/sql-storage-adapter/postgres`. It reaches Supabase the same
 * way, with pool control, transaction error handling and `strict` resolution.
 */

import type { Pool } from 'pg';
import { toPostgresStatement } from '../shared/sqlPlaceholders';
import { getStorageLogger } from '../shared/logger';
import type {
  StorageAdapter,
  StorageCapability,
  StorageOpenOptions,
  StorageParameters,
  StorageRunResult,
  BatchResult
} from '../core/contracts';
import type {
  StorageAdapterExtensions,
  ExtendedBatchOperation,
  Migration,
  PerformanceMetrics,
  StreamOptions
} from '../core/contracts/extensions';

export interface SupabaseAdapterOptions extends StorageOpenOptions {
  connectionString?: string;
  poolConfig?: {
    max?: number;
    min?: number;
    idleTimeoutMillis?: number;
    connectionTimeoutMillis?: number;
  };
  /** TLS: false turns it off; an object (with `ca` to verify Supabase's certificate) is passed to pg; otherwise TLS without verification. */
  ssl?: boolean | { rejectUnauthorized: boolean; ca?: string };
}

/** Whether this process has been told the adapter is deprecated. */
let deprecationLogged = false;

/** A statement and its parameters for pg: `?` and `@name` rewritten to `$n`, as the PostgreSQL adapter does. */
const prepare = (statement: string, parameters?: StorageParameters): [string, unknown[]] => {
  const { text, values } = toPostgresStatement(statement, parameters);
  return [text, values];
};

/** An error with `message`, keeping the database error as `cause` and its PostgreSQL error `code`. */
const failure = (message: string, error: unknown): Error => {
  const wrapped = new Error(message) as Error & { cause?: unknown; code?: unknown };
  wrapped.cause = error;
  if (error && typeof error === 'object' && 'code' in error) wrapped.code = (error as { code?: unknown }).code;
  return wrapped;
};

/**
 * Whether the query cache may hold a statement's answer: a SELECT, whose first word past white space and comments is
 * SELECT. Block comments nest, as PostgreSQL reads them. Any other statement can write, such as `UPDATE ... RETURNING`
 * through `get`, and runs each time it is asked. A SELECT can write too, through a function it calls or with `INTO`,
 * which its text cannot show, so its answer is kept only when PostgreSQL says it wrote nothing (`readAndCheck`).
 */
const isSelect = (statement: unknown): boolean => {
  if (typeof statement !== 'string') return false;
  let at = 0;
  for (;;) {
    while (at < statement.length && /\s/.test(statement.charAt(at))) at += 1;
    if (statement.startsWith('--', at)) {
      const end = statement.indexOf('\n', at);
      if (end < 0) return false;
      at = end + 1;
    } else if (statement.startsWith('/*', at)) {
      let depth = 1;
      at += 2;
      while (depth > 0) {
        if (at >= statement.length) return false;
        if (statement.startsWith('/*', at)) {
          depth += 1;
          at += 2;
        } else if (statement.startsWith('*/', at)) {
          depth -= 1;
          at += 2;
        } else {
          at += 1;
        }
      }
    } else {
      return /^select\b/i.test(statement.slice(at, at + 7));
    }
  }
};

/** Stands for an answer the cache cannot copy faithfully, which it then does not keep. */
const UNCOPIED = Symbol('uncopied');

/**
 * A copy of an answer the cache keeps or gives, so a caller that changes the row or list it was given changes nothing
 * the cache answers next: arrays and plain objects, such as rows and parsed JSON, copied through, a Date and a Buffer
 * as themselves, and text, numbers, booleans and null as they are, as those cannot be changed. Any other object, such
 * as the interval pg parses to an object of its own, has no faithful copy, so an answer holding one is `UNCOPIED`.
 */
const copyOf = (value: unknown): unknown => {
  if (typeof value === 'function') return UNCOPIED;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const items = value.map(copyOf);
    return items.includes(UNCOPIED) ? UNCOPIED : items;
  }
  if (value instanceof Date) return new Date(value.getTime());
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return Buffer.from(value);
  if (Object.getPrototypeOf(value) !== Object.prototype) return UNCOPIED;
  const fields = Object.entries(value).map(([name, field]) => [name, copyOf(field)] as const);
  return fields.some(([, field]) => field === UNCOPIED) ? UNCOPIED : Object.fromEntries(fields);
};

/** Stands for parameters the cache key cannot write, so the read bound to them runs each time it is asked. */
const UNKEYED = Symbol('unkeyed');

/** Whether the value is a Date of any realm, as pg reads one: `Date.prototype.getTime` takes nothing else. */
const isDate = (value: unknown): value is Date => {
  try {
    Date.prototype.getTime.call(value as Date);
    return true;
  } catch {
    return false;
  }
};

/** The bytes of a view, such as a Buffer, as hex. */
const hexOf = (view: ArrayBufferView): string =>
  Array.from(new Uint8Array(view.buffer, view.byteOffset, view.byteLength), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');

/**
 * A parameter as the cache key writes it, so two parameters share a key only when pg binds them alike: text, numbers,
 * bigints and booleans as the text pg binds, and a tagged list for bytes, a Date, an array and any other object, which
 * pg binds as its JSON text. `UNKEYED` for one the key cannot write so: an object with a `toPostgres` of its own,
 * which pg binds through it, a function, a symbol, an object JSON cannot write, and text holding U+0000, which
 * PostgreSQL refuses, so that no read bound to it answers from the cache.
 */
const keyOf = (value: unknown): unknown => {
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case 'string':
      return value.includes('\u0000') ? UNKEYED : value;
    case 'number':
    case 'bigint':
    case 'boolean':
      return String(value);
    case 'object':
      break;
    default:
      return UNKEYED;
  }
  if (ArrayBuffer.isView(value)) return ['bytes', hexOf(value)];
  if (isDate(value)) return ['date', value.getTime()];
  if (Array.isArray(value)) {
    const items = value.map(keyOf);
    return items.includes(UNKEYED) ? UNKEYED : ['array', ...items];
  }
  if (typeof (value as { toPostgres?: unknown }).toPostgres === 'function') return UNKEYED;
  try {
    return ['json', JSON.stringify(value)];
  } catch {
    return UNKEYED;
  }
};

/**
 * The parameters as the cache key writes them, read as `toPostgresStatement` reads them: an array as positional values,
 * a plain object as named ones and any other value as the one positional value. `UNKEYED` as `keyOf` says, and for
 * named values on an object whose prototype could answer a name the statement asks for.
 */
const parametersKeyOf = (parameters?: StorageParameters): unknown => {
  if (parameters === undefined || parameters === null) return null;
  if (Array.isArray(parameters)) {
    const items = parameters.map(keyOf);
    return items.includes(UNKEYED) ? UNKEYED : ['positional', ...items];
  }
  if (typeof parameters === 'object') {
    const prototype = Object.getPrototypeOf(parameters);
    if (prototype !== Object.prototype && prototype !== null) return UNKEYED;
    const entries = Object.entries(parameters).map(([name, value]) => [name, keyOf(value)] as const);
    return entries.some(([, key]) => key === UNKEYED) ? UNKEYED : ['named', ...entries];
  }
  const item = keyOf(parameters);
  return item === UNKEYED ? UNKEYED : ['positional', item];
};

/** @deprecated Use `createPostgresAdapter` from `@framers/sql-storage-adapter/postgres` with the Supabase connection string. */
export class SupabaseAdapter implements StorageAdapter, StorageAdapterExtensions {
  readonly kind = 'supabase-postgres';
  readonly capabilities: ReadonlySet<StorageCapability> = new Set<StorageCapability>([
    'transactions',
    'persistence',
    'locks',
    'streaming',
    'batch'
  ]);

  private pool?: Pool;
  private options?: SupabaseAdapterOptions;
  private metrics: PerformanceMetrics = {
    totalQueries: 0,
    totalDuration: 0,
    averageDuration: 0,
    slowQueries: [],
    cacheHits: 0,
    cacheMisses: 0
  };
  private profilingEnabled = false;
  private queryCache = new Map<string, unknown>();
  private cacheEnabled = false;
  private maxCacheSize = 100;
  /** Moves with every `clearCache()`, so a read that was in flight across one keeps nothing. */
  private cacheGeneration = 0;

  async open(options?: SupabaseAdapterOptions): Promise<void> {
    this.options = options;
    if (!deprecationLogged) {
      deprecationLogged = true;
      getStorageLogger().warn(
        { adapter: 'supabase-postgres' },
        'SupabaseAdapter is deprecated: use createPostgresAdapter({ connectionString }) from @framers/sql-storage-adapter/postgres, which reaches Supabase the same way. SupabaseAdapter does not verify the server certificate unless ssl is { rejectUnauthorized: true, ca }.',
      );
    }

    // Dynamic import to avoid bundling pg when not needed
    const pg = await import('pg');
    const { Pool } = pg;

    // Browser-safe process.env access
    const getEnv = (key: string): string | undefined => {
      if (typeof process !== 'undefined' && process.env) {
        return process.env[key];
      }
      return undefined;
    };

    const connectionString = options?.connectionString || getEnv('DATABASE_URL');
    if (!connectionString) {
      throw new Error('Supabase connection string required (DATABASE_URL or connectionString option)');
    }

    this.pool = new Pool({
      connectionString,
      max: options?.poolConfig?.max || 20,
      min: options?.poolConfig?.min || 2,
      idleTimeoutMillis: options?.poolConfig?.idleTimeoutMillis || 30000,
      connectionTimeoutMillis: options?.poolConfig?.connectionTimeoutMillis || 5000,
      ssl: options?.ssl === false ? undefined : typeof options?.ssl === 'object' ? options.ssl : { rejectUnauthorized: false }
    });

    // Test connection
    try {
      const client = await this.pool.connect();
      client.release();
    } catch (error) {
      throw new Error(`Failed to connect to Supabase: ${error}`);
    }
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = undefined;
    }
    this.clearCache();
  }

  private trackQuery(query: string, startTime: number): void {
    if (!this.profilingEnabled) return;

    const duration = Date.now() - startTime;
    this.metrics.totalQueries++;
    this.metrics.totalDuration += duration;
    this.metrics.averageDuration = this.metrics.totalDuration / this.metrics.totalQueries;

    if (duration > 100) {
      if (!this.metrics.slowQueries) {
        this.metrics.slowQueries = [];
      }
      this.metrics.slowQueries.push({
        query: query.substring(0, 200),
        duration,
        timestamp: new Date(Date.now())
      });
      // Keep only last 100 slow queries
      if (this.metrics.slowQueries.length > 100) {
        this.metrics.slowQueries.shift();
      }
    }
  }

  /**
   * The key of an answer: the call, the statement and the parameters as pg binds them (`parametersKeyOf`), or
   * `undefined` for parameters the key cannot write, so the read runs each time it is asked. `get` and `all` keep
   * apart, as one answers a row and the other a list.
   */
  private getCacheKey(call: 'get' | 'all', query: string, params?: StorageParameters): string | undefined {
    let bound: unknown;
    try {
      bound = parametersKeyOf(params);
    } catch {
      return undefined;
    }
    return bound === UNKEYED ? undefined : `${call}::${query}::${JSON.stringify(bound)}`;
  }

  async run(statement: string, parameters?: StorageParameters): Promise<StorageRunResult> {
    if (!this.pool) throw new Error('Storage adapter not opened');

    const startTime = Date.now();
    try {
      const result = await this.pool.query(...prepare(statement, parameters));
      this.trackQuery(statement, startTime);

      return {
        changes: result.rowCount || 0,
        lastInsertRowid: result.rows[0]?.id || 0
      };
    } catch (error) {
      throw failure(`Query failed: ${error}`, error);
    } finally {
      this.clearCache();
    }
  }

  /** The key a SELECT is cached under while the cache is on; `undefined` for any other statement or with it off. */
  private cacheKeyOf(
    call: 'get' | 'all',
    statement: string,
    parameters?: StorageParameters
  ): string | undefined {
    return this.cacheEnabled && isSelect(statement) ? this.getCacheKey(call, statement, parameters) : undefined;
  }

  /**
   * Runs a SELECT the cache may keep, once, in a transaction of its own on one client, and answers its rows and
   * whether it wrote. PostgreSQL gives a transaction an ID when it first writes to the database
   * (https://www.postgresql.org/docs/current/transaction-id.html), and `pg_current_xact_id_if_assigned()`, PostgreSQL
   * 13's, answers NULL until then, so a SELECT that calls a function that writes, or makes a table with `INTO`, answers
   * `wrote: true`. What it wrote commits, as it would outside the cache.
   */
  private async readAndCheck(
    pool: Pool,
    statement: string,
    parameters?: StorageParameters
  ): Promise<{ rows: unknown[]; wrote: boolean }> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(...prepare(statement, parameters));
      const check = await client.query<{ wrote: boolean }>(
        'SELECT pg_current_xact_id_if_assigned() IS NOT NULL AS wrote'
      );
      await client.query('COMMIT');
      // A string of statements answers a list of results, and a COMMIT in it can end this transaction before a
      // statement after it writes in one of its own, which the check cannot see: it counts as a write.
      const several = Array.isArray(result);
      return { rows: result.rows, wrote: several || check.rows[0]?.wrote !== false };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Runs a statement for `get` or `all`: a SELECT the cache may keep through `readAndCheck`, and any other statement,
   * or any with the cache off, as it is, taken as a write.
   */
  private async answer(
    pool: Pool,
    cacheKey: string | undefined,
    statement: string,
    parameters?: StorageParameters
  ): Promise<{ rows: unknown[]; wrote: boolean }> {
    if (cacheKey !== undefined) return this.readAndCheck(pool, statement, parameters);
    const result = await pool.query(...prepare(statement, parameters));
    return { rows: result.rows, wrote: true };
  }

  /** A copy of the cached answer under the key, counted as a hit; `undefined` when the cache holds none. */
  private cached<T>(cacheKey: string | undefined): T | undefined {
    if (cacheKey === undefined) return undefined;
    if (this.queryCache.has(cacheKey)) {
      if (this.metrics.cacheHits !== undefined) {
        this.metrics.cacheHits++;
      }
      return copyOf(this.queryCache.get(cacheKey)) as T;
    }
    if (this.metrics.cacheMisses !== undefined) {
      this.metrics.cacheMisses++;
    }
    return undefined;
  }

  /**
   * Keeps a copy of a SELECT's answer under its key, apart from the one its caller gets, unless a write or
   * `clearCache()` came while it was read, or the answer holds a value with no faithful copy.
   */
  private keep(cacheKey: string | undefined, generation: number, value: unknown): void {
    if (cacheKey === undefined || !this.cacheEnabled || generation !== this.cacheGeneration) return;
    const copy = copyOf(value);
    if (copy === UNCOPIED) return;
    this.queryCache.set(cacheKey, copy);
    if (this.queryCache.size > this.maxCacheSize) {
      const firstKey = this.queryCache.keys().next().value;
      if (firstKey !== undefined) {
        this.queryCache.delete(firstKey);
      }
    }
  }

  async get<T = unknown>(statement: string, parameters?: StorageParameters): Promise<T | null> {
    if (!this.pool) throw new Error('Storage adapter not opened');

    const cacheKey = this.cacheKeyOf('get', statement, parameters);
    const cached = this.cached<T | null>(cacheKey);
    if (cached !== undefined) return cached ?? null;

    const generation = this.cacheGeneration;
    const startTime = Date.now();
    let wrote = true;
    try {
      const outcome = await this.answer(this.pool, cacheKey, statement, parameters);
      wrote = outcome.wrote;
      this.trackQuery(statement, startTime);

      const value = outcome.rows[0] || null;
      if (!wrote && value !== null) this.keep(cacheKey, generation, value);
      return value as T;
    } catch (error) {
      throw failure(`Query failed: ${error}`, error);
    } finally {
      if (wrote) this.clearCache();
    }
  }

  async all<T = unknown>(statement: string, parameters?: StorageParameters): Promise<T[]> {
    if (!this.pool) throw new Error('Storage adapter not opened');

    const cacheKey = this.cacheKeyOf('all', statement, parameters);
    const cached = this.cached<T[]>(cacheKey);
    if (cached !== undefined) return cached;

    const generation = this.cacheGeneration;
    const startTime = Date.now();
    let wrote = true;
    try {
      const outcome = await this.answer(this.pool, cacheKey, statement, parameters);
      wrote = outcome.wrote;
      this.trackQuery(statement, startTime);

      if (!wrote) this.keep(cacheKey, generation, outcome.rows);
      return outcome.rows as T[];
    } catch (error) {
      throw failure(`Query failed: ${error}`, error);
    } finally {
      if (wrote) this.clearCache();
    }
  }

  async exec(script: string): Promise<void> {
    if (!this.pool) throw new Error('Storage adapter not opened');

    const startTime = Date.now();
    try {
      await this.pool.query(script);
      this.trackQuery(script, startTime);
    } catch (error) {
      throw failure(`Script execution failed: ${error}`, error);
    } finally {
      this.clearCache();
    }
  }

  async transaction<T>(fn: (trx: StorageAdapter) => Promise<T>): Promise<T> {
    if (!this.pool) throw new Error('Storage adapter not opened');

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Create a transaction-scoped adapter
      const trxAdapter: StorageAdapter = {
        kind: this.kind,
        capabilities: this.capabilities,
        open: async () => {},
        close: async () => {},
        run: async (stmt, params) => {
          const result = await client.query(...prepare(stmt, params));
          return { changes: result.rowCount || 0, lastInsertRowid: 0 };
        },
        get: async (stmt, params) => {
          const result = await client.query(...prepare(stmt, params));
          return result.rows[0] || null;
        },
        all: async (stmt, params) => {
          const result = await client.query(...prepare(stmt, params));
          return result.rows;
        },
        exec: async (script) => {
          await client.query(script);
        },
        transaction: async (fn) => fn(trxAdapter)
      };

      const result = await fn(trxAdapter);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
      // What the transaction wrote is visible from here, so nothing read before it may answer again.
      this.clearCache();
    }
  }

  // Extension methods
  async *stream<T = unknown>(
    query: string,
    parameters?: unknown,
    options?: StreamOptions
  ): AsyncIterableIterator<T> {
    if (!this.pool) throw new Error('Storage adapter not opened');

    const batchSize = options?.batchSize || 100;
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const paginatedQuery = `${query} LIMIT ${batchSize} OFFSET ${offset}`;
      const rows = await this.all<T>(paginatedQuery, parameters as StorageParameters | undefined);

      if (rows.length < batchSize) {
        hasMore = false;
      }

      for (const row of rows) {
        yield row;
      }

      offset += batchSize;
    }
  }

  async batchWrite(operations: ExtendedBatchOperation[]): Promise<BatchResult> {
    return this.transaction(async (trx) => {
      let successful = 0;
      let failed = 0;
      const errors: Array<{ index: number; error: Error }> = [];

      for (let index = 0; index < operations.length; index++) {
        const op = operations[index];
        try {
          switch (op.type) {
            case 'insert': {
              const keys = Object.keys(op.values || {});
              const values = Object.values(op.values || {});
              const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
              const query = `INSERT INTO ${op.table} (${keys.join(', ')}) VALUES (${placeholders})`;
              await trx.run(query, values);
              successful++;
              break;
            }
            case 'update': {
              const sets = Object.keys(op.values || {}).map((k, i) => `${k} = $${i + 1}`).join(', ');
              const whereClause = Object.keys(op.where || {})
                .map((k, i) => `${k} = $${i + Object.keys(op.values || {}).length + 1}`)
                .join(' AND ');
              const query = `UPDATE ${op.table} SET ${sets} WHERE ${whereClause}`;
              const params = [...Object.values(op.values || {}), ...Object.values(op.where || {})];
              await trx.run(query, params);
              successful++;
              break;
            }
            case 'delete': {
              const whereClause = Object.keys(op.where || {})
                .map((k, i) => `${k} = $${i + 1}`)
                .join(' AND ');
              const query = `DELETE FROM ${op.table} WHERE ${whereClause}`;
              await trx.run(query, Object.values(op.where || {}));
              successful++;
              break;
            }
          }
        } catch (error: unknown) {
          failed++;
          errors.push({ 
            index,
            error: error instanceof Error ? error : new Error(String(error))
          });
        }
      }

      return { successful, failed, errors: errors.length > 0 ? errors : undefined };
    });
  }

  async migrate(migrations: Migration[]): Promise<void> {
    // Create migrations table if it doesn't exist
    await this.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Get applied migrations
    const applied = await this.all<{ id: string; version: number }>('SELECT id, version FROM _migrations');
    const appliedSet = new Set(applied.map(m => m.id));

    // Apply pending migrations
    for (const migration of migrations) {
      if (!appliedSet.has(migration.id)) {
        await this.transaction(async (trx) => {
          await trx.exec(migration.up);
          await trx.run(
            'INSERT INTO _migrations (id, version) VALUES ($1, $2)',
            [migration.id, migration.version]
          );
        });
      }
    }
  }

  async getMigrationStatus(): Promise<Migration[]> {
    const applied = await this.all<{ id: string; version: number; applied_at: string }>(
      'SELECT * FROM _migrations ORDER BY version'
    );
    return applied.map(m => ({
      id: m.id,
      version: m.version,
      up: '',
      down: '',
      timestamp: new Date(m.applied_at).getTime()
    }));
  }

  async backup(_destination: string): Promise<void> {
    // For Supabase, we can use pg_dump via command line or API
    throw new Error('Backup not implemented for Supabase adapter. Use Supabase dashboard or pg_dump.');
  }

  async restore(_source: string): Promise<void> {
    // For Supabase, we can use pg_restore via command line or API
    throw new Error('Restore not implemented for Supabase adapter. Use Supabase dashboard or pg_restore.');
  }

  enableProfiling(): void {
    this.profilingEnabled = true;
  }

  disableProfiling(): void {
    this.profilingEnabled = false;
  }

  getMetrics(): PerformanceMetrics {
    return { ...this.metrics };
  }

  clearMetrics(): void {
    this.metrics = {
      totalQueries: 0,
      totalDuration: 0,
      averageDuration: 0,
      slowQueries: [],
      cacheHits: 0,
      cacheMisses: 0
    };
  }

  /**
   * Keeps the answers of SELECTs through `get` and `all`, at most `maxSize` of them, and answers the same statement with
   * the same parameters from them, each time with a copy, so a caller that changes the row or list it was given changes
   * nothing the cache answers next. An answer holding a value with no faithful copy, such as an interval, which pg
   * parses to an object of its own, is not kept. A SELECT is a statement whose first word, past white space and
   * comments, is SELECT; a string of several statements counts as a write. One the cache does not hold runs once, in a
   * transaction of its own, and its answer is kept only when PostgreSQL gave that transaction no ID, which it gives a
   * transaction when it first writes to the database: a SELECT that calls a function that writes, or makes a table with
   * INTO, runs each time it is asked. That check reads `pg_current_xact_id_if_assigned()`, so the cache needs
   * PostgreSQL 13 or later. Two calls share an answer only when pg binds their parameters alike, and a SELECT bound to
   * an object with a `toPostgres` of its own, or to text holding U+0000, runs each time it is asked, as one that writes
   * does. Every statement that writes, through `run`, `exec`, `get` or `all`, and every `transaction`, `batchWrite` and
   * `migrate`, clears the cache when it ends, and a read that was in flight across one keeps nothing, so the cache never
   * answers a row as it stood before this adapter's own write. It cannot see a write through another adapter, pool or
   * process, an effect that writes no row, such as `pg_notify()` or an advisory lock, nor a SELECT whose answer changes
   * from one call to the next by itself, such as one that calls `random()`, `now()` or `nextval()`: a kept answer is
   * given again without running the statement, until `clearCache()`. Run a statement wanted for its effect through
   * `run`, or begin it with a word other than SELECT, such as `VALUES (nextval('ids'))`, which runs each time.
   */
  enableCache(maxSize: number = 100): void {
    this.cacheEnabled = true;
    this.maxCacheSize = maxSize;
  }

  disableCache(): void {
    this.cacheEnabled = false;
    this.clearCache();
  }

  /** Empties the cache; a read in flight when it is called keeps nothing. */
  clearCache(): void {
    this.cacheGeneration += 1;
    this.queryCache.clear();
  }

  getPoolStatus(): { active: number; idle: number; waiting: number; max: number } {
    if (!this.pool) {
      return { active: 0, idle: 0, waiting: 0, max: 0 };
    }
    return {
      active: this.pool.totalCount,
      idle: this.pool.idleCount,
      waiting: this.pool.waitingCount,
      max: this.pool.options?.max ?? 0
    };
  }
}
