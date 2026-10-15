// NOTE: Browser safety - we avoid throwing at module load so bundlers can include
// this file without crashing. A runtime error will be thrown inside `open()` if
// execution actually occurs in a browser.
const __isBrowser = typeof window !== 'undefined' && typeof window.document !== 'undefined';

// Dynamic import for pg to prevent bundlers from trying to bundle it in browser builds
type PgModule = typeof import('pg');
type PoolConfig = import('pg').PoolConfig;

import type { StorageAdapter, StorageCapability, StorageOpenOptions, StorageParameters, StorageRunResult } from '../core/contracts';
import { toPostgresStatement } from '../shared/sqlPlaceholders';
import { splitSqlStatements } from '../shared/splitSqlStatements';
import { validateSegment } from '../shared/segment';
import { getStorageLogger } from '../shared/logger';

/** What the adapter reads from the answer to a query. */
export interface PostgresQueryResultLike {
  rows: unknown[];
  rowCount?: number | null;
}

/** A connection checked out of a pool: the part of pg's `PoolClient` the adapter uses. */
export interface PostgresPoolClientLike {
  query(text: string, values?: unknown[]): Promise<PostgresQueryResultLike>;
  release(error?: Error | boolean): void;
  /**
   * pg's client is an event emitter: while the adapter holds a client, it
   * listens for the client's connection error. A client without these emits
   * nothing for the adapter to hear.
   */
  on?(event: 'error', listener: (error: Error) => void): unknown;
  removeListener?(event: 'error', listener: (error: Error) => void): unknown;
}

/**
 * The part of pg's `Pool` the adapter uses. A `Pool` from `pg` is one; so is
 * any object with these members.
 */
export interface PostgresPoolLike {
  query(text: string, values?: unknown[]): Promise<PostgresQueryResultLike>;
  connect(): Promise<PostgresPoolClientLike>;
  end(): Promise<void>;
  on?(event: 'error', listener: (error: Error) => void): unknown;
  removeListener?(event: 'error', listener: (error: Error) => void): unknown;
  /** True once `end()` has been called; pg's Pool sets it. */
  readonly ending?: boolean;
  /** True once the pool has ended; pg's Pool sets it. */
  readonly ended?: boolean;
  /** Connections the pool holds, checked out or idle; pg's Pool counts them. */
  readonly totalCount?: number;
  /** Connections idle in the pool. */
  readonly idleCount?: number;
  /** Callers waiting for a connection. */
  readonly waitingCount?: number;
}

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
  /**
   * How this pool's connections decode the column types whose pg defaults
   * surprise JavaScript code, through pg's per-client type parsers. Each field
   * left out keeps pg's default. A value it does not know fails open(). A pool
   * of the caller's decodes with the `types` it was made with, so this cannot
   * be given with `pool`.
   */
  typeParsers?: PostgresTypeParsers;
  /**
   * A schema of its own for the adapter's tables. Every connection of the
   * adapter's pool starts with `search_path` set to the segment, then
   * `public`, so the tables it creates without a schema land in the segment,
   * and the types, functions and operators of extensions in `public`
   * (pgvector's `vector`, `<->`) still resolve. `open()` creates the schema
   * when it is missing, and a `CREATE EXTENSION` that names no schema installs
   * the extension where it would without a segment, in `public`.
   *
   * A name the segment does not hold falls through to `public`: create a
   * segment's tables before reading them (`CREATE TABLE IF NOT EXISTS` creates
   * one in the segment even when `public` has a table of that name), and name
   * the segment in a DROP or ALTER that `public` could also answer.
   *
   * Lower-case letters, digits and underscores; not `public`,
   * `information_schema` or a name beginning with `pg_`. A segment cannot be
   * combined with `pool`, nor with a connection string that sets its own
   * `options` startup parameter: pg sends those in place of the segment's.
   */
  segment?: string;
  /**
   * A pool the caller made (a `pg` `Pool`) for the adapter to run on, instead
   * of making one. The adapter runs on it from the start: no `open()` is
   * needed, and `open()` after `close()` takes it up again. The connection
   * settings above apply when a pool is made, so none of them, nor `segment`,
   * can be given with it.
   */
  pool?: PostgresPoolLike;
  /**
   * Whether `close()` ends `pool`. False by default: the pool is its caller's,
   * and `close()` leaves it open. Pass true when the adapter is the pool's one
   * holder and closing the adapter is how the pool should end; `close()` then
   * ends it once, however often it is called.
   */
  ownsPool?: boolean;
  /**
   * Called with the error an idle connection of the pool reports (the server
   * ended it, the network dropped). pg's Pool raises such an error as an event
   * that, with no listener, ends the process. On a pool the adapter makes or
   * owns, the adapter listens even without `onError` and logs one warning per
   * error; on a pool of its caller's that it does not own, it listens only
   * when given `onError`, and takes its listener off again on `close()`.
   */
  onError?: (error: Error) => void;
}

/** Per-pool decoding of int8, numeric, date and json columns. Each field left out keeps pg's default. */
export interface PostgresTypeParsers {
  /** int8 / bigint (OID 20). pg's default is 'string'. 'number' refuses a value past `Number.MAX_SAFE_INTEGER`. */
  int8?: 'string' | 'number' | 'bigint';
  /** numeric / decimal (OID 1700). pg's default is 'string'. 'number' is a double, so it can round. */
  numeric?: 'string' | 'number';
  /** date (OID 1082). pg's default is 'date', a Date at local midnight; 'string' keeps `YYYY-MM-DD`. */
  date?: 'date' | 'string';
  /** json (OID 114) and jsonb (OID 3802). pg's default is 'parse'; 'string' keeps the text, as SQLite returns it. */
  json?: 'parse' | 'string';
}

type TextParser = (text: string) => unknown;

/** The type-parser overrides `parsers` asks for, by OID, after checking each value. */
const typeParserOverrides = (parsers: PostgresTypeParsers | undefined): Map<number, TextParser> => {
  const overrides = new Map<number, TextParser>();
  if (!parsers) return overrides;

  const choice = (field: keyof PostgresTypeParsers, allowed: readonly string[]): string | undefined => {
    const value = parsers[field];
    if (value === undefined) return undefined;
    if (!allowed.includes(value)) {
      throw new Error(
        `typeParsers.${field} must be ${allowed.map((option) => `'${option}'`).join(' or ')}; got ${JSON.stringify(value)}.`
      );
    }
    return value;
  };

  const int8 = choice('int8', ['string', 'number', 'bigint']);
  if (int8 === 'string') overrides.set(20, (text) => text);
  if (int8 === 'bigint') overrides.set(20, (text) => BigInt(text));
  if (int8 === 'number') {
    overrides.set(20, (text) => {
      const value = Number(text);
      if (!Number.isSafeInteger(value)) {
        throw new RangeError(
          `int8 value ${text} is outside Number's safe integer range; read it with typeParsers.int8 'bigint' or 'string'.`
        );
      }
      return value;
    });
  }

  const numeric = choice('numeric', ['string', 'number']);
  if (numeric === 'string') overrides.set(1700, (text) => text);
  if (numeric === 'number') overrides.set(1700, (text) => Number(text));

  if (choice('date', ['date', 'string']) === 'string') overrides.set(1082, (text) => text);

  if (choice('json', ['parse', 'string']) === 'string') {
    overrides.set(114, (text) => text);
    overrides.set(3802, (text) => text);
  }

  return overrides;
};

/** The options that configure a pool when one is made, which a pool of the caller's already has. */
const POOL_SETTINGS = [
  'connectionString',
  'host',
  'port',
  'database',
  'user',
  'password',
  'ssl',
  'max',
  'min',
  'idleTimeoutMillis',
  'connectionTimeoutMillis',
  'application_name',
  'statement_timeout',
  'query_timeout',
  'allowExitOnIdle',
  'typeParsers',
] as const;

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
const transactionStatus = (client: PostgresPoolClientLike): string | null => {
  const read = (client as unknown as { getTransactionStatus?: () => string | null }).getTransactionStatus;
  return typeof read === 'function' ? read.call(client) : null;
};

/** The statement and values node-postgres receives: see toPostgresStatement. */
const prepareStatement = toPostgresStatement;

/** Runs one statement's text: on the adapter's pool, or on a transaction's client. */
type QueryRunner = (text: string, values: unknown[]) => Promise<PostgresQueryResultLike>;

/** Execute a mutation through a pool or a transaction client. */
const runWith = async (query: QueryRunner, statement: string, parameters?: StorageParameters): Promise<StorageRunResult> => {
  const { text, values } = prepareStatement(statement, parameters);
  const result = await query(text, values);
  const firstRow: unknown = result.rows?.[0];
  const lastInsertRowid =
    firstRow && typeof firstRow === 'object' && 'id' in (firstRow as Record<string, unknown>)
      ? ((firstRow as Record<string, unknown>).id as number | string | null)
      : null;
  return { changes: result.rowCount ?? 0, lastInsertRowid };
};

/** Read one row through a pool or a transaction client. */
const getWith = async <T>(query: QueryRunner, statement: string, parameters?: StorageParameters): Promise<T | null> => {
  const { text, values } = prepareStatement(statement, parameters);
  const result = await query(text, values);
  return (result.rows?.[0] as T) ?? null;
};

/** Read every matching row through a pool or a transaction client. */
const allWith = async <T>(query: QueryRunner, statement: string, parameters?: StorageParameters): Promise<T[]> => {
  const { text, values } = prepareStatement(statement, parameters);
  const result = await query(text, values);
  return (result.rows as T[]) ?? [];
};

/** Execute a statement script through a pool or a transaction client. */
const execWith = async (query: QueryRunner, script: string): Promise<void> => {
  const statements = splitSqlStatements(script);
  for (const text of statements) {
    await query(text, []);
  }
};

/** A word of a statement: keywords upper-cased, identifiers as PostgreSQL reads them. */
interface StatementWord {
  /** An unquoted word upper-cased; '"' for a quoted identifier; the character itself for anything else. */
  keyword: string;
  /** The identifier the word names: an unquoted word lower-cased, a quoted one as written. */
  identifier: string;
}

/**
 * The first `limit` words of a statement, past its comments: enough to tell
 * what the statement is. String literals and dollar-quoted strings count as
 * one word each and never read as a keyword.
 */
const leadingWords = (statement: string, limit: number): StatementWord[] => {
  const words: StatementWord[] = [];
  let i = 0;
  const length = statement.length;
  while (i < length && words.length < limit) {
    const char = statement[i];
    if (/\s/.test(char)) {
      i += 1;
    } else if (char === '-' && statement[i + 1] === '-') {
      const end = statement.indexOf('\n', i);
      i = end === -1 ? length : end + 1;
    } else if (char === '/' && statement[i + 1] === '*') {
      // PostgreSQL's block comments nest.
      let depth = 1;
      i += 2;
      while (i < length && depth > 0) {
        if (statement[i] === '/' && statement[i + 1] === '*') {
          depth += 1;
          i += 2;
        } else if (statement[i] === '*' && statement[i + 1] === '/') {
          depth -= 1;
          i += 2;
        } else {
          i += 1;
        }
      }
    } else if (char === "'") {
      i += 1;
      while (i < length) {
        if (statement[i] === "'" && statement[i + 1] === "'") i += 2;
        else if (statement[i] === "'") break;
        else i += 1;
      }
      i += 1;
      words.push({ keyword: "'", identifier: '' });
    } else if (char === '"') {
      let identifier = '';
      i += 1;
      while (i < length) {
        if (statement[i] === '"' && statement[i + 1] === '"') {
          identifier += '"';
          i += 2;
        } else if (statement[i] === '"') {
          break;
        } else {
          identifier += statement[i];
          i += 1;
        }
      }
      i += 1;
      words.push({ keyword: '"', identifier });
    } else if (char === '$') {
      const tag = /^\$[A-Za-z_]*\$/.exec(statement.slice(i));
      if (tag) {
        const end = statement.indexOf(tag[0], i + tag[0].length);
        i = end === -1 ? length : end + tag[0].length;
        words.push({ keyword: '$', identifier: '' });
      } else {
        i += 1;
        words.push({ keyword: '$', identifier: '' });
      }
    } else if (/[A-Za-z_]/.test(char)) {
      const word = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(statement.slice(i))![0];
      i += word.length;
      words.push({ keyword: word.toUpperCase(), identifier: word.toLowerCase() });
    } else {
      i += 1;
      words.push({ keyword: char, identifier: '' });
    }
  }
  return words;
};

/**
 * The extension a `CREATE EXTENSION` statement creates when the statement
 * names no schema (`SCHEMA` or `WITH SCHEMA`), or null for any other
 * statement.
 */
const unqualifiedCreateExtension = (statement: string): string | null => {
  const words = leadingWords(statement, 16);
  if (words[0]?.keyword !== 'CREATE' || words[1]?.keyword !== 'EXTENSION') return null;
  let at = 2;
  if (words[2]?.keyword === 'IF' && words[3]?.keyword === 'NOT' && words[4]?.keyword === 'EXISTS') at = 5;
  const name = words[at];
  if (!name || (name.keyword !== '"' && !/^[A-Z_]/.test(name.keyword))) return null;
  if (words.slice(at + 1).some((word) => word.keyword === 'SCHEMA')) return null;
  return name.identifier;
};

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
const watchClient = (client: PostgresPoolClientLike): { failure: () => Error | undefined; stop: () => void } => {
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
      client.removeListener?.('error', onError);
    },
  };
};

/** Where an installed extension's objects are, and whether ALTER EXTENSION ... SET SCHEMA can move them. */
const EXTENSION_PLACE =
  'SELECT n.nspname AS schema, e.extrelocatable AS relocatable FROM pg_extension e ' +
  'JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = $1';

/**
 * Runs a statement through a segment's connections with care for the one
 * statement whose effect depends on where it runs: an unqualified
 * `CREATE EXTENSION` installs into the current schema, which on a segment is
 * the segment, where no other segment and not the host find the extension's
 * types. Such a statement runs with `search_path` set to `public` for itself
 * alone, as it would without a segment (an extension whose control file names
 * a schema still goes there). Afterwards the adapter checks where the
 * extension is, since `IF NOT EXISTS` also succeeds for one installed in a
 * schema the segment cannot see.
 */
class SegmentStatements {
  /** Extensions already reported as out of the segment's reach. */
  private readonly reported = new Set<string>();

  constructor(public readonly segment: string) {}

  /**
   * Runs `text` on the pool. The connection that runs a `CREATE EXTENSION`
   * goes back to the pool unless its BEGIN or ROLLBACK failed or it broke
   * while held, in which case it is closed.
   */
  async onPool(pool: PostgresPoolLike, text: string, values: unknown[]): Promise<PostgresQueryResultLike> {
    const extension = unqualifiedCreateExtension(text);
    if (extension === null) {
      return pool.query(text, values);
    }
    const client = await pool.connect();
    const watch = watchClient(client);
    let brokenBy: Error | undefined;
    try {
      return await this.inOwnTransaction(client, text, values, extension, (error) => {
        if (!brokenBy) brokenBy = error;
      });
    } finally {
      watch.stop();
      client.release(brokenBy ?? watch.failure());
    }
  }

  /** Runs `text` on a transaction's client, inside the caller's transaction. */
  async inTransaction(client: PostgresPoolClientLike, text: string, values: unknown[]): Promise<PostgresQueryResultLike> {
    const extension = unqualifiedCreateExtension(text);
    if (extension === null) {
      return client.query(text, values);
    }
    return this.withinTransaction(client, text, values, extension);
  }

  /**
   * Runs `text` on the connection a `withConnection()` callback holds: inside
   * the transaction the callback began, as `inTransaction` does, or outside
   * one in a transaction of its own, as on the pool. On a pg that does not
   * report a connection's transaction status (before 8.21), the session's
   * search_path is set to `public` around the statement and set back after it.
   * `onBroken` hears when the connection cannot be trusted any more, so
   * `withConnection()` closes it instead of returning it to the pool.
   */
  async onConnection(
    client: PostgresPoolClientLike,
    text: string,
    values: unknown[],
    onBroken: (error: Error) => void,
  ): Promise<PostgresQueryResultLike> {
    const extension = unqualifiedCreateExtension(text);
    if (extension === null) {
      return client.query(text, values);
    }
    switch (transactionStatus(client)) {
      case 'T':
        return this.withinTransaction(client, text, values, extension);
      case 'I':
        return this.inOwnTransaction(client, text, values, extension, onBroken);
      case 'E':
        // The transaction has failed: the statement fails with its reason.
        return client.query(text, values);
      default:
        return this.aroundSession(client, text, values, extension, onBroken);
    }
  }

  /**
   * In a transaction of its own on `client`, whose COMMIT or ROLLBACK ends the
   * setting. A BEGIN or ROLLBACK that fails leaves the connection in a state
   * nobody knows, so `onBroken` hears of it.
   */
  private async inOwnTransaction(
    client: PostgresPoolClientLike,
    text: string,
    values: unknown[],
    extension: string,
    onBroken: (error: Error) => void,
  ): Promise<PostgresQueryResultLike> {
    try {
      await client.query('BEGIN');
    } catch (error) {
      onBroken(asError(error));
      throw error;
    }
    let result: PostgresQueryResultLike;
    try {
      // set_config(..., true) is SET LOCAL: the COMMIT or ROLLBACK below ends it,
      // so the connection goes back to the pool on the segment's search_path.
      await client.query("SELECT set_config('search_path', 'public', true)");
      result = await client.query(text, values);
      await client.query('COMMIT');
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        onBroken(asError(rollbackError));
        keepRollbackError(error, asError(rollbackError));
      }
      throw error;
    }
    await this.checkReach((t, v) => client.query(t, v), extension);
    return result;
  }

  /** Inside the transaction open on `client`, setting the search_path for the statement and back. */
  private async withinTransaction(
    client: PostgresPoolClientLike,
    text: string,
    values: unknown[],
    extension: string,
  ): Promise<PostgresQueryResultLike> {
    const saved = await client.query("SELECT current_setting('search_path') AS path");
    const path = (saved.rows[0] as { path?: unknown } | undefined)?.path;
    await client.query("SELECT set_config('search_path', 'public', true)");
    // A failure aborts the caller's transaction, whose rollback (or a
    // rollback to a savepoint before this) undoes the setting.
    const result = await client.query(text, values);
    await client.query('SELECT set_config($1, $2, true)', ['search_path', typeof path === 'string' ? path : `${this.segment}, public`]);
    await this.checkReach((t, v) => client.query(t, v), extension);
    return result;
  }

  /**
   * With the session's search_path set to `public` for the statement, and set
   * back after it. When the statement fails inside a transaction, setting it
   * back fails too, and that transaction's rollback restores it. Without the
   * transaction status this cannot tell that case from a connection whose
   * search_path stays on `public`, so a failed set-back tells `onBroken`, and
   * the connection is closed rather than returned to the pool outside the
   * segment.
   */
  private async aroundSession(
    client: PostgresPoolClientLike,
    text: string,
    values: unknown[],
    extension: string,
    onBroken: (error: Error) => void,
  ): Promise<PostgresQueryResultLike> {
    const saved = await client.query("SELECT current_setting('search_path') AS path");
    const savedPath = (saved.rows[0] as { path?: unknown } | undefined)?.path;
    const path = typeof savedPath === 'string' ? savedPath : `${this.segment}, public`;
    await client.query("SELECT set_config('search_path', 'public', false)");
    const setBack = async (): Promise<void> => {
      try {
        await client.query('SELECT set_config($1, $2, false)', ['search_path', path]);
      } catch (error) {
        onBroken(asError(error));
        throw error;
      }
    };
    let result: PostgresQueryResultLike;
    try {
      result = await client.query(text, values);
    } catch (error) {
      await setBack().catch(() => undefined);
      throw error;
    }
    await setBack();
    await this.checkReach((t, v) => client.query(t, v), extension);
    return result;
  }

  private async checkReach(query: QueryRunner, extension: string): Promise<void> {
    if (this.reported.has(extension)) return;
    const found = await query(EXTENSION_PLACE, [extension]);
    const place = found.rows[0] as { schema?: unknown; relocatable?: unknown } | undefined;
    if (!place || place.relocatable !== true) return;
    if (place.schema === 'public' || place.schema === this.segment) return;
    this.reported.add(extension);
    getStorageLogger().warn(
      { adapter: 'postgres', segment: this.segment, extension, schema: String(place.schema) },
      `PostgreSQL extension "${extension}" is installed in schema "${String(place.schema)}", which segment ` +
        `"${this.segment}" does not reach: its search_path is ${this.segment}, public, so the extension's types and functions ` +
        `do not resolve here. ALTER EXTENSION "${extension}" SET SCHEMA public moves it where every segment finds it.`,
    );
  }
}

/** A pool on which `end()` has been called. */
const hasEnded = (pool: PostgresPoolLike): boolean => pool.ending === true || pool.ended === true;

/** The listener the adapter puts on a pool it owns when no `onError` was given. */
const warnOfIdleError = (error: Error): void => {
  const message = error instanceof Error ? error.message : String(error);
  getStorageLogger().warn(
    { adapter: 'postgres', error: message },
    `PostgreSQL: an idle connection of the pool failed; the pool opens another when one is needed. ${message}`,
  );
};

/** The value of an environment variable, where there is an environment. */
const readEnv = (key: string): string | undefined =>
  typeof process !== 'undefined' && process.env ? process.env[key] : undefined;

/**
 * Refuses a connection string that sets its own startup options when a
 * segment needs that parameter: pg copies a connection string's parameters
 * over the explicit configuration, so its `options` would replace the
 * segment's search_path.
 */
const refuseOwnStartupOptions = (connectionString: string | undefined): void => {
  if (connectionString && /[?&]options=/i.test(connectionString)) {
    throw new Error(
      'PostgresAdapter: a segment cannot be used with a connection string that sets its own startup options (options=...): ' +
        "pg sends those in place of the segment's search_path. Move them out of the connection string, into PGOPTIONS.",
    );
  }
};

/**
 * Creates a segment's schema when it is missing. The check comes first, so a
 * role without CREATE on the database can open a segment that exists: CREATE
 * SCHEMA IF NOT EXISTS checks that privilege before it looks for the schema.
 */
const createSchema = async (client: PostgresPoolClientLike, segment: string): Promise<void> => {
  const found = await client.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [segment]);
  if (found.rows.length > 0) {
    return;
  }
  try {
    // validateSegment admits lower-case letters, digits and underscores alone.
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${segment}"`);
  } catch (error) {
    // Two processes that open one new segment at once can both find it
    // missing; the slower CREATE then fails on pg_namespace's unique index.
    const code = (error as { code?: unknown } | null)?.code;
    if (code !== '23505' && code !== '42P06') {
      throw error;
    }
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
  private readonly query: QueryRunner;

  constructor(
    client: PostgresPoolClientLike,
    public readonly capabilities: ReadonlySet<StorageCapability>,
    segment: SegmentStatements | null,
    private readonly afterEnd: StorageAdapter,
  ) {
    this.query = segment
      ? (text, values) => segment.inTransaction(client, text, values)
      : (text, values) => client.query(text, values);
  }

  public async open(): Promise<void> {
    // The owning PostgresAdapter opens the pool before creating this view.
  }

  public async run(
    statement: string,
    parameters?: StorageParameters
  ): Promise<StorageRunResult> {
    if (this.ended) return this.afterEnd.run(statement, parameters);
    return runWith(this.query, statement, parameters);
  }

  public async get<T>(statement: string, parameters?: StorageParameters): Promise<T | null> {
    if (this.ended) return this.afterEnd.get<T>(statement, parameters);
    return getWith<T>(this.query, statement, parameters);
  }

  public async all<T>(statement: string, parameters?: StorageParameters): Promise<T[]> {
    if (this.ended) return this.afterEnd.all<T>(statement, parameters);
    return allWith<T>(this.query, statement, parameters);
  }

  public async exec(script: string): Promise<void> {
    if (this.ended) return this.afterEnd.exec(script);
    await execWith(this.query, script);
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

/**
 * Runs `fn` in a transaction that `begin` opens on `client`: COMMIT when `fn`
 * resolves, ROLLBACK when `fn` or COMMIT throws, and that error is rethrown.
 * `onBroken` hears when the connection cannot be trusted any more (BEGIN or
 * ROLLBACK failed), so the caller closes it instead of returning it to the
 * pool. When ROLLBACK fails, the original error is still the one thrown, with
 * the ROLLBACK error on it as `rollbackError`.
 */
const runTransaction = async <T>(
  client: PostgresPoolClientLike,
  begin: string,
  fn: (trx: StorageAdapter) => Promise<T>,
  capabilities: ReadonlySet<StorageCapability>,
  segment: SegmentStatements | null,
  afterEnd: StorageAdapter,
  onBroken: (error: Error) => void
): Promise<T> => {
  try {
    await client.query(begin);
  } catch (error) {
    onBroken(asError(error));
    throw error;
  }
  const handle = new PostgresTransactionAdapter(client, capabilities, segment, afterEnd);
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
  /**
   * @internal Why the connection cannot be trusted any more: a transaction's
   * BEGIN or ROLLBACK failed on it, or a segment's search_path could not be
   * set back. withConnection() closes it instead of returning it to the pool.
   */
  public brokenBy: Error | undefined;
  private ended = false;
  private transactionOpen = false;
  private readonly query: QueryRunner;

  constructor(
    private readonly client: PostgresPoolClientLike,
    public readonly capabilities: ReadonlySet<StorageCapability>,
    private readonly segment: SegmentStatements | null,
  ) {
    this.query = (text, values) => {
      const live = this.live();
      return segment ? segment.onConnection(live, text, values, this.onBroken) : live.query(text, values);
    };
  }

  /** Keeps the first reason the connection cannot be trusted any more. */
  private readonly onBroken = (error: Error): void => {
    if (!this.brokenBy) this.brokenBy = error;
  };

  public async open(): Promise<void> {
    // withConnection() checks the connection out before the callback runs.
  }

  public async run(statement: string, parameters?: StorageParameters): Promise<StorageRunResult> {
    return runWith(this.query, statement, parameters);
  }

  public async get<T>(statement: string, parameters?: StorageParameters): Promise<T | null> {
    return getWith<T>(this.query, statement, parameters);
  }

  public async all<T>(statement: string, parameters?: StorageParameters): Promise<T[]> {
    return allWith<T>(this.query, statement, parameters);
  }

  public async exec(script: string): Promise<void> {
    await execWith(this.query, script);
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
      return await runTransaction(client, begin, fn, this.capabilities, this.segment, this, this.onBroken);
    } finally {
      this.transactionOpen = false;
    }
  }

  public async close(): Promise<void> {
    // withConnection() returns the connection to the pool, or closes it, when the callback ends.
  }

  /** @internal withConnection() calls this when the callback ends. */
  public end(): void {
    this.ended = true;
  }

  private live(): PostgresPoolClientLike {
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
 * ### A pool the host already holds
 * ```typescript
 * const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
 * // The adapter runs on the host's pool; close() leaves it open.
 * const db = new PostgresAdapter({ pool, onError: (error) => console.warn('idle connection failed', error) });
 * ```
 *
 * ### A segment: the adapter's tables in a schema of their own
 * ```typescript
 * const agentos = createPostgresAdapter({ connectionString: process.env.DATABASE_URL, segment: 'agentos' });
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
  /**
   * The pool statements run on, or null while the adapter is closed. Hosts
   * written against 0.6 hand the adapter a Pool by setting this field before
   * `open()`; the adapter then runs on that Pool and ends it on `close()`, as
   * 0.6 did. Keep its name, and keep it a plain field that starts as null.
   */
  private pool: PostgresPoolLike | null = null;
  private pgModule: PgModule | null = null;
  /** The pool of the caller's the adapter was given, which `open()` takes up again after `close()`. */
  private readonly givenPool: PostgresPoolLike | null;
  /** Whether `close()` ends the pool. */
  private readonly ownsPool: boolean;
  private readonly segmentStatements: SegmentStatements | null;
  /** The error listener the adapter has on a pool, and that pool. */
  private listening: { pool: PostgresPoolLike; listener: (error: Error) => void } | null = null;
  private opening: Promise<void> | null = null;
  private closing: Promise<void> | null = null;

  constructor(options: PostgresAdapterOptions | string) {
    // Support both string and object initialization
    this.options = typeof options === 'string' ? { connectionString: options } : { ...options };
    const segment = this.options.segment === undefined ? undefined : validateSegment(this.options.segment);
    this.segmentStatements = segment === undefined ? null : new SegmentStatements(segment);

    const given = this.options.pool;
    if (given) {
      if (segment !== undefined) {
        throw new Error(
          "PostgresAdapter: a segment cannot run on a pool its caller made: the segment's search_path is set when each " +
            'connection of the pool starts, and the adapter does not start the connections of a pool it did not make. ' +
            'Give the connection settings and the segment instead of the pool.',
        );
      }
      const settings = POOL_SETTINGS.filter((key) => this.options[key] !== undefined);
      if (settings.length > 0) {
        throw new Error(
          `PostgresAdapter: ${settings.join(', ')} cannot be given with pool: they configure a pool when one is made, ` +
            'and the pool given was made by its caller. Set them on that pool' +
            (settings.includes('typeParsers') ? " (typeParsers through the pool's own types option)." : '.'),
        );
      }
      this.givenPool = given;
      this.ownsPool = this.options.ownsPool === true;
      this.pool = given;
      this.listenOn(given);
    } else {
      this.givenPool = null;
      this.ownsPool = true;
      if (segment !== undefined) {
        refuseOwnStartupOptions(this.options.connectionString);
      }
    }
  }

  /**
   * The pool the adapter runs on: the pool it was given, or the pool it made
   * while it is open. Null while the adapter is closed.
   */
  public getPool(): PostgresPoolLike | null {
    return this.pool;
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

  /**
   * Opens the adapter: makes its pool and checks that a connection can be
   * made (and with a segment, creates the segment's schema when it is
   * missing), or takes up the pool it was given. A failure ends the pool it
   * made, so a later `open()` starts again. Two calls at once open once.
   */
  public open(openOptions?: StorageOpenOptions): Promise<void> {
    if (this.pool) {
      return Promise.resolve();
    }
    if (!this.opening) {
      this.opening = this.openNow(openOptions).finally(() => {
        this.opening = null;
      });
    }
    return this.opening;
  }

  private async openNow(openOptions?: StorageOpenOptions): Promise<void> {
    if (__isBrowser) {
      throw new Error('[StorageAdapter] PostgreSQL adapter cannot be opened in a browser environment.');
    }

    if (this.givenPool) {
      if (hasEnded(this.givenPool)) {
        throw new Error('PostgresAdapter: the pool it was given has ended, so the adapter cannot open on it again.');
      }
      this.pool = this.givenPool;
      this.listenOn(this.givenPool);
      return;
    }

    const connectionString = openOptions?.connectionString ?? this.options.connectionString;
    if (this.segmentStatements) {
      refuseOwnStartupOptions(connectionString);
    }

    // Load pg module dynamically
    const pg = await this.loadPgModule();
    const pool: PostgresPoolLike = new pg.Pool(this.poolConfig(pg, connectionString));
    this.listenOn(pool);

    try {
      // Test connection
      const client = await pool.connect();
      try {
        if (this.segmentStatements) {
          await createSchema(client, this.segmentStatements.segment);
        }
      } finally {
        client.release();
      }
    } catch (error) {
      // The listener stays on the pool through its end; the adapter forgets it.
      this.listening = null;
      await pool.end().catch(() => undefined);
      throw error;
    }
    this.pool = pool;
  }

  /** The configuration of the pool the adapter makes. */
  private poolConfig(pg: PgModule, connectionString: string | undefined): PoolConfig {
    const poolConfig: PoolConfig = {};

    // Use connection string if provided
    if (connectionString) {
      poolConfig.connectionString = connectionString;
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
    const overrides = typeParserOverrides(this.options.typeParsers);
    if (overrides.size > 0) {
      const defaults = pg.types;
      poolConfig.types = {
        getTypeParser: (oid: number, format?: string) =>
          (format === undefined || format === 'text') && overrides.has(oid)
            ? overrides.get(oid)!
            : defaults.getTypeParser(oid, format as 'text'),
      } as unknown as PoolConfig['types'];
    }

    // SSL configuration
    if (this.options.ssl !== undefined) {
      poolConfig.ssl = this.options.ssl;
    }

    if (this.segmentStatements) {
      // Every connection the pool opens, a replacement included, starts on the
      // segment. A startup setting is the connection's default, so RESET and
      // DISCARD ALL return to it. pg reads PGOPTIONS only for a connection
      // without options of its own, so its options are kept here.
      const searchPath = `-c search_path=${this.segmentStatements.segment},public`;
      const inherited = readEnv('PGOPTIONS')?.trim();
      poolConfig.options = inherited ? `${inherited} ${searchPath}` : searchPath;
    }

    return poolConfig;
  }

  /** Puts the adapter's error listener on `pool`: `onError`, or the warning on a pool it owns. */
  private listenOn(pool: PostgresPoolLike): void {
    const listener = this.options.onError ?? (this.ownsPool ? warnOfIdleError : null);
    if (!listener || typeof pool.on !== 'function' || this.listening?.pool === pool) return;
    pool.on('error', listener);
    this.listening = { pool, listener };
  }

  /** The runner of statements outside a transaction. */
  private readonly query: QueryRunner = (text, values) => {
    const pool = this.requirePool();
    return this.segmentStatements ? this.segmentStatements.onPool(pool, text, values) : pool.query(text, values);
  };

  public async run(statement: string, parameters?: StorageParameters): Promise<StorageRunResult> {
    return runWith(this.query, statement, parameters);
  }

  public async get<T>(statement: string, parameters?: StorageParameters): Promise<T | null> {
    return getWith<T>(this.query, statement, parameters);
  }

  public async all<T>(statement: string, parameters?: StorageParameters): Promise<T[]> {
    return allWith<T>(this.query, statement, parameters);
  }

  public async exec(script: string): Promise<void> {
    await execWith(this.query, script);
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
      return await runTransaction(client, begin, fn, this.capabilities, this.segmentStatements, this, (error) => {
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
   * held it (the server ended the session) is closed, not returned. On a
   * segmented adapter the connection starts in the segment, as every
   * connection of its pool does.
   */
  public async withConnection<T>(fn: (connection: PostgresConnection) => Promise<T>): Promise<T> {
    const client = await this.requirePool().connect();
    const watch = watchClient(client);
    const connection = new PostgresConnectionAdapter(client, this.capabilities, this.segmentStatements);
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

  /**
   * The pool's counts, or null when the adapter is not open. A pool of the
   * caller's that does not count its connections, as pg's Pool does, reads 0.
   */
  public getPoolStats(): PostgresPoolStats | null {
    const pool = this.pool;
    if (!pool) {
      return null;
    }
    return { total: pool.totalCount ?? 0, idle: pool.idleCount ?? 0, waiting: pool.waitingCount ?? 0 };
  }

  /**
   * Closes the adapter. A pool the adapter made or owns is ended, once; a pool
   * of its caller's that it does not own is left open, with the adapter's
   * listener taken off it. A call made while a close is running waits for it.
   */
  public close(): Promise<void> {
    if (!this.closing) {
      this.closing = this.closeNow().finally(() => {
        this.closing = null;
      });
    }
    return this.closing;
  }

  private async closeNow(): Promise<void> {
    if (this.opening) {
      await this.opening.catch(() => undefined);
    }
    const pool = this.pool;
    this.pool = null;
    if (!pool) {
      return;
    }
    const listening = this.listening?.pool === pool ? this.listening : null;
    this.listening = null;
    if (this.ownsPool) {
      // The listener stays on: a connection the pool lets go can still report
      // its end after end() has resolved.
      if (!hasEnded(pool)) {
        await pool.end();
      }
      return;
    }
    if (listening && typeof pool.removeListener === 'function') {
      pool.removeListener('error', listening.listener);
    }
  }

  private requirePool(): PostgresPoolLike {
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
