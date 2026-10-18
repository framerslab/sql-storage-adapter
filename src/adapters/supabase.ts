/**
 * Supabase Postgres Storage Adapter
 * Provides full Postgres capabilities with Supabase's managed infrastructure
 *
 * @deprecated Use the PostgreSQL adapter with the Supabase connection string:
 * `createPostgresAdapter({ connectionString, ssl: { rejectUnauthorized: true, ca } })`
 * from `@framers/sql-storage-adapter/postgres`. It reaches Supabase the same
 * way, with pool control, transaction error handling and `strict` resolution.
 */

import type { Pool, PoolClient } from 'pg';
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

/** An unknown thrown value as an Error. */
const asError = (value: unknown): Error => (value instanceof Error ? value : new Error(String(value)));

/**
 * The rows of a statement's answer. pg answers a string of several statements, sent with no parameters as one simple
 * query, with a list of results, which has no rows of its own: such a call answers no rows, as the PostgreSQL adapter's
 * does, so `get` answers null, `all` an empty list and `run` no row's id, after PostgreSQL ran every statement.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows as pg types them, so callers keep their types
const rowsOf = (result: unknown): any[] => {
  if (Array.isArray(result)) return [];
  const rows = (result as { rows?: unknown } | null | undefined)?.rows;
  return Array.isArray(rows) ? rows : [];
};

/** Puts a failed ROLLBACK's error on the error thrown, as a non-enumerable `rollbackError`, when that error takes one. */
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
 * Hears a connection error on a client checked out of the pool, until `stop()`. pg emits a client's connection error
 * (the server ending the session, a broken socket) on the client, and pg-pool listens only on idle clients, so an
 * error nothing heard would end the process. The client goes back to the pool with the error `failure()` answers, and
 * the pool closes it.
 */
const watchClient = (client: PoolClient): { failure: () => Error | undefined; stop: () => void } => {
  let failed: Error | undefined;
  const onError = (error: Error): void => {
    if (!failed) failed = error;
  };
  client.on('error', onError);
  return {
    failure: () => failed,
    stop: () => {
      client.removeListener('error', onError);
    },
  };
};

/** The pool's listener for a failed idle connection, which pg-pool has dropped by then. */
const warnOfIdleError = (error: Error): void => {
  const message = error instanceof Error ? error.message : String(error);
  getStorageLogger().warn(
    { adapter: 'supabase-postgres', error: message },
    `SupabaseAdapter: an idle connection of the pool failed; the pool opens another when one is needed. ${message}`,
  );
};

/**
 * The error of a transaction whose COMMIT PostgreSQL answered with ROLLBACK: a statement in it failed and the callback
 * went on, and PostgreSQL ends an aborted transaction that way, with no error of its own.
 */
const rolledBackAtCommit = (): Error =>
  new Error(
    'The transaction was rolled back at COMMIT: a statement in it failed, so PostgreSQL wrote none of it. ' +
      'A statement that may fail inside a transaction runs under a savepoint of its own.',
  );

/** The savepoint each operation of `batchWrite` runs under. */
const BATCH_SAVEPOINT = 'supabase_adapter_batch';

/** The statement and the values of one `batchWrite` operation, or `undefined` for a type the batch does not know. */
const batchStatementOf = (op: ExtendedBatchOperation): { query: string; params: unknown[] } | undefined => {
  switch (op.type) {
    case 'insert': {
      const keys = Object.keys(op.values || {});
      const values = Object.values(op.values || {});
      const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
      return { query: `INSERT INTO ${op.table} (${keys.join(', ')}) VALUES (${placeholders})`, params: values };
    }
    case 'update': {
      const sets = Object.keys(op.values || {}).map((k, i) => `${k} = $${i + 1}`).join(', ');
      const whereClause = Object.keys(op.where || {})
        .map((k, i) => `${k} = $${i + Object.keys(op.values || {}).length + 1}`)
        .join(' AND ');
      return {
        query: `UPDATE ${op.table} SET ${sets} WHERE ${whereClause}`,
        params: [...Object.values(op.values || {}), ...Object.values(op.where || {})],
      };
    }
    case 'delete': {
      const whereClause = Object.keys(op.where || {})
        .map((k, i) => `${k} = $${i + 1}`)
        .join(' AND ');
      return { query: `DELETE FROM ${op.table} WHERE ${whereClause}`, params: Object.values(op.where || {}) };
    }
    default:
      return undefined;
  }
};

/**
 * Whether the query cache may hold a statement's answer: a SELECT, whose first word past white space and comments is
 * SELECT. Block comments nest, and a `--` comment ends at a line feed or a carriage return, as PostgreSQL reads them.
 * Any other statement can write, such as `UPDATE ... RETURNING` through `get`, and runs each time it is asked. A SELECT
 * can write too, through a function it calls or with `INTO`, which its text cannot show, so its answer is kept only
 * when PostgreSQL says it wrote nothing (`readAndCheck`).
 */
const isSelect = (statement: unknown): boolean => {
  if (typeof statement !== 'string') return false;
  let at = 0;
  for (;;) {
    while (at < statement.length && /\s/.test(statement.charAt(at))) at += 1;
    if (statement.startsWith('--', at)) {
      const end = statement.slice(at).search(/[\n\r]/);
      if (end < 0) return false;
      at += end + 1;
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

/** What the cache needs of pg: `prepareValue`, which writes a parameter as pg sends it. pg 8.15.0 and later export it. */
interface PgUtilities {
  prepareValue(value: unknown): unknown;
}

/** A statement as pg is sent it, with its values, and the key a SELECT's answer is kept under while the cache may keep it. */
interface Call {
  text: string;
  values: unknown[];
  cacheKey?: string;
}

/**
 * The values a read the cache may keep is sent with, each written by pg's own `prepareValue` when the call is made, as
 * text, bytes (copied) or null, and the key they give. The read is sent those, so its answer is the answer to them
 * whatever the caller changes afterwards, and two reads share an answer only when pg sends them the same values.
 * `undefined` when `prepareValue` answers anything else, as one a host put in its place may, and the read then runs
 * each time it is asked.
 */
const sentValuesOf = (values: unknown[], utilities: PgUtilities): { values: unknown[]; key: unknown[] } | undefined => {
  const sent: unknown[] = [];
  const key: unknown[] = [];
  for (const value of values) {
    const prepared = utilities.prepareValue(value);
    if (prepared === null || prepared === undefined) {
      sent.push(null);
      key.push(null);
    } else if (typeof prepared === 'string') {
      sent.push(prepared);
      key.push(prepared);
    } else if (typeof Buffer !== 'undefined' && Buffer.isBuffer(prepared)) {
      const bytes = Buffer.from(prepared);
      sent.push(bytes);
      key.push(['bytes', bytes.toString('hex')]);
    } else {
      return undefined;
    }
  }
  return { values: sent, key };
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
  /** pg's `prepareValue`, from pg's main export (pg 8.15.0 and later); without it a read with parameters is not kept. */
  private pgUtilities?: PgUtilities;

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
    const main = ((pg as unknown as { default?: unknown }).default ?? pg) as { utils?: Partial<PgUtilities> };
    this.pgUtilities = typeof main.utils?.prepareValue === 'function' ? (main.utils as PgUtilities) : undefined;

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
    // pg-pool emits an idle connection's failure on the pool, and with no listener that ends the process.
    this.pool.on('error', warnOfIdleError);

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

  async run(statement: string, parameters?: StorageParameters): Promise<StorageRunResult> {
    if (!this.pool) throw new Error('Storage adapter not opened');

    const startTime = Date.now();
    try {
      const result = await this.pool.query(...prepare(statement, parameters));
      this.trackQuery(statement, startTime);

      return {
        changes: result.rowCount || 0,
        lastInsertRowid: rowsOf(result)[0]?.id || 0
      };
    } catch (error) {
      throw failure(`Query failed: ${error}`, error);
    } finally {
      this.clearCache();
    }
  }

  /**
   * A statement for `get` or `all` as pg is sent it, with its values, and, while the cache is on and the statement is
   * a SELECT, the key its answer is kept under. Such a read is sent the values `sentValuesOf` writes when the call is
   * made, and its key names the call, the statement and those values, so `get` and `all` keep apart, as one answers a
   * row and the other a list. With values pg's `prepareValue` cannot write, or without it, the read has no key and
   * runs each time it is asked.
   */
  private callOf(call: 'get' | 'all', statement: string, parameters?: StorageParameters): Call {
    const [text, values] = prepare(statement, parameters);
    if (!this.cacheEnabled || !isSelect(statement)) return { text, values };
    if (values.length === 0) return { text, values, cacheKey: JSON.stringify([call, text, []]) };
    const utilities = this.pgUtilities;
    const sent = utilities === undefined ? undefined : sentValuesOf(values, utilities);
    if (sent === undefined) return { text, values };
    return { text, values: sent.values, cacheKey: JSON.stringify([call, text, sent.key]) };
  }

  /**
   * Runs a SELECT the cache may keep, once, in a transaction of its own on one client, and answers its rows and
   * whether it wrote. PostgreSQL gives a transaction an ID when it first writes to the database
   * (https://www.postgresql.org/docs/current/transaction-id.html), and `pg_current_xact_id_if_assigned()`, PostgreSQL
   * 13's, answers NULL until then, so a SELECT that calls a function that writes, or makes a table with `INTO`, answers
   * `wrote: true`. What it wrote commits, as it would outside the cache. The client goes back to the pool closed when
   * its connection failed, or when a ROLLBACK after a failure could not run, as when pg's `query_timeout` dropped it,
   * since it could still be inside this transaction.
   */
  private async readAndCheck(pool: Pool, call: Call): Promise<{ rows: unknown[]; wrote: boolean }> {
    const client = await pool.connect();
    const watch = watchClient(client);
    let broken: Error | undefined;
    try {
      await client.query('BEGIN');
      const result = await client.query(call.text, call.values);
      const check = await client.query<{ wrote: boolean }>(
        'SELECT pg_current_xact_id_if_assigned() IS NOT NULL AS wrote'
      );
      await client.query('COMMIT');
      // A string of statements answers a list of results, and a COMMIT in it can end this transaction before a
      // statement after it writes in one of its own, which the check cannot see: it counts as a write.
      const several = Array.isArray(result);
      return { rows: rowsOf(result), wrote: several || check.rows[0]?.wrote !== false };
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        broken = asError(rollbackError);
      }
      throw error;
    } finally {
      watch.stop();
      client.release(broken ?? watch.failure());
    }
  }

  /**
   * Runs a statement for `get` or `all`: a SELECT the cache may keep through `readAndCheck`, and any other statement,
   * or any with the cache off, as it is, taken as a write.
   */
  private async answer(pool: Pool, call: Call): Promise<{ rows: unknown[]; wrote: boolean }> {
    if (call.cacheKey !== undefined) return this.readAndCheck(pool, call);
    const result = await pool.query(call.text, call.values);
    return { rows: rowsOf(result), wrote: true };
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

    const startTime = Date.now();
    let wrote = true;
    try {
      const call = this.callOf('get', statement, parameters);
      const cached = this.cached<T | null>(call.cacheKey);
      if (cached !== undefined) {
        wrote = false;
        return cached ?? null;
      }

      const generation = this.cacheGeneration;
      const outcome = await this.answer(this.pool, call);
      wrote = outcome.wrote;
      this.trackQuery(statement, startTime);

      const value = outcome.rows[0] || null;
      if (!wrote && value !== null) this.keep(call.cacheKey, generation, value);
      return value as T;
    } catch (error) {
      throw failure(`Query failed: ${error}`, error);
    } finally {
      if (wrote) this.clearCache();
    }
  }

  async all<T = unknown>(statement: string, parameters?: StorageParameters): Promise<T[]> {
    if (!this.pool) throw new Error('Storage adapter not opened');

    const startTime = Date.now();
    let wrote = true;
    try {
      const call = this.callOf('all', statement, parameters);
      const cached = this.cached<T[]>(call.cacheKey);
      if (cached !== undefined) {
        wrote = false;
        return cached;
      }

      const generation = this.cacheGeneration;
      const outcome = await this.answer(this.pool, call);
      wrote = outcome.wrote;
      this.trackQuery(statement, startTime);

      if (!wrote) this.keep(call.cacheKey, generation, outcome.rows);
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

  /**
   * Runs `fn` in a transaction on one pooled client: COMMIT when it resolves, ROLLBACK when it or COMMIT throws, and
   * that error is thrown. A COMMIT that PostgreSQL answers with ROLLBACK, as it answers one when a statement in the
   * transaction failed and `fn` went on, throws too, as nothing was written. When the ROLLBACK cannot run either, the
   * error thrown is still the transaction's own, with the ROLLBACK's on it as `rollbackError`, and the client goes back
   * to the pool closed, as it does when its connection failed, since it could still be inside the transaction.
   */
  async transaction<T>(fn: (trx: StorageAdapter) => Promise<T>): Promise<T> {
    if (!this.pool) throw new Error('Storage adapter not opened');

    const client = await this.pool.connect();
    const watch = watchClient(client);
    let broken: Error | undefined;
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
          return rowsOf(result)[0] || null;
        },
        all: async (stmt, params) => {
          const result = await client.query(...prepare(stmt, params));
          return rowsOf(result);
        },
        exec: async (script) => {
          await client.query(script);
        },
        transaction: async (fn) => fn(trxAdapter)
      };

      const result = await fn(trxAdapter);
      const committed = await client.query('COMMIT');
      if (committed.command === 'ROLLBACK') throw rolledBackAtCommit();
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        broken = asError(rollbackError);
        keepRollbackError(error, broken);
      }
      throw error;
    } finally {
      watch.stop();
      client.release(broken ?? watch.failure());
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

  /**
   * Writes the operations in one transaction, each under a savepoint: a failed statement aborts a PostgreSQL
   * transaction, so a failed operation rolls back to its savepoint and the batch goes on, as the PostgreSQL adapter's
   * batch does. The operations that succeeded commit, and the result names each one that failed by its index. An
   * operation of a type the batch does not know writes nothing and is not counted.
   */
  async batchWrite(operations: ExtendedBatchOperation[]): Promise<BatchResult> {
    return this.transaction(async (trx) => {
      let successful = 0;
      let failed = 0;
      const errors: Array<{ index: number; error: Error }> = [];

      for (let index = 0; index < operations.length; index++) {
        const step = batchStatementOf(operations[index]);
        if (!step) continue;
        await trx.exec(`SAVEPOINT ${BATCH_SAVEPOINT}`);
        try {
          await trx.run(step.query, step.params);
        } catch (error: unknown) {
          await trx.exec(`ROLLBACK TO SAVEPOINT ${BATCH_SAVEPOINT}`);
          await trx.exec(`RELEASE SAVEPOINT ${BATCH_SAVEPOINT}`);
          failed++;
          errors.push({ index, error: asError(error) });
          continue;
        }
        await trx.exec(`RELEASE SAVEPOINT ${BATCH_SAVEPOINT}`);
        successful++;
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
   * comments (a `--` comment ends at a line feed or a carriage return), is SELECT; a string of several statements
   * counts as a write. One the cache does not hold runs once, in a transaction of its own, and its answer is kept only
   * when PostgreSQL gave that transaction no ID, which it gives a transaction when it first writes to the database: a
   * SELECT that calls a function that writes, or makes a table with INTO, runs each time it is asked. That check reads
   * `pg_current_xact_id_if_assigned()`, so the cache needs PostgreSQL 13 or later. A SELECT the cache may keep is sent
   * its values as pg's own `prepareValue` writes them when the call is made, so its answer is the answer to those values
   * whatever the caller changes afterwards, and two calls share an answer only when they send the same statement and the
   * same values; with pg before 8.15.0, which does not export `prepareValue`, a SELECT with parameters runs each time it
   * is asked. Every statement that writes, through `run`, `exec`, `get` or `all`, and every `transaction`, `batchWrite` and
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
