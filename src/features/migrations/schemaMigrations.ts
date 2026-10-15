/**
 * A versioned schema-migration runner over StorageAdapter, for PostgreSQL and
 * SQLite alike. It applies hand-written SQL files in number order, each in its
 * own transaction, records each in a ledger table with the SHA-256 of its text,
 * refuses an applied file whose text changed, and stops at the first error.
 *
 * Locking: on PostgreSQL each file's transaction first takes a
 * transaction-scoped advisory lock, and checks the ledger again under it, so
 * two runners at once apply each file once. A file marked to run outside a
 * transaction (CREATE INDEX CONCURRENTLY) runs under the session-level lock on
 * one held connection. On SQLite the file's write transaction is the lock.
 *
 * @module
 */
import type { StorageAdapter } from '../../core/contracts';
import { createStorageFeatures } from '../../core/contracts/features';
import { getStorageLogger } from '../../shared/logger';

/** One migration: its file name, which orders it, and its SQL. */
export interface SchemaMigration {
  name: string;
  sql: string;
}

/** How the runner names its ledger and lock, and what it does with surprises. */
export interface SchemaMigrationOptions {
  /** The ledger table, schema-qualified if need be. Default: `schema_migrations`. */
  table?: string;
  /** The ledger column that holds each file's SHA-256 in hex. Default: `checksum`. */
  checksumColumn?: string;
  /**
   * The PostgreSQL advisory lock key: an integer, or text hashed with
   * `hashtext()`. Default: 724313571. Runners that share a database share a key.
   */
  lockKey?: number | string;
  /**
   * A ledger row whose file the list lacks (the database is ahead of the
   * code): `'refuse'` (the default) stops before applying anything; `'ignore'`
   * goes on.
   */
  unknown?: 'refuse' | 'ignore';
  /**
   * A file whose first line, trimmed, is this runs outside a transaction.
   * Default: `-- outside transaction`.
   */
  outsideTransactionMarker?: string;
}

/** What a run or a status check found. */
export interface SchemaMigrationReport {
  /** Applied by this run, in order (a status check applies none, and lists the files the ledger holds unchanged). */
  applied: string[];
  /** Already in the ledger with the same checksum: a run skipped them. */
  skipped: string[];
  /** In the list and not in the ledger: a status check's pending files. */
  pending: string[];
  /** In the ledger with a different checksum. */
  changed: string[];
  /** In the ledger and not in the list. */
  unknown: string[];
}

/** Options for reading a migrations folder. */
export interface ReadSchemaMigrationsOptions {
  /** Reads `<dir>/<dialect>` when that folder exists, else `<dir>`. */
  dialect?: 'postgres' | 'sqlite';
  /**
   * The file-name form, whose first capture group is the number that orders
   * the file. Default: digits, an underscore, then lower-case letters, digits
   * and underscores, `.sql` (`001_init.sql`, `0001_accounts.sql`).
   */
  namePattern?: RegExp;
}

const DEFAULT_TABLE = 'schema_migrations';
const DEFAULT_CHECKSUM_COLUMN = 'checksum';
const DEFAULT_LOCK_KEY = 724313571;
const DEFAULT_MARKER = '-- outside transaction';
const DEFAULT_NAME = /^(\d+)_[a-z0-9_]+\.sql$/;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

/** The SHA-256 of `text` (its UTF-8 bytes) in hex, through Web Crypto, else node:crypto. */
const sha256Hex = async (text: string): Promise<string> => {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (subtle) {
    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  const { createHash } = await import('crypto');
  return createHash('sha256').update(text).digest('hex');
};

const checkIdentifier = (what: string, value: string): string => {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    throw new Error(`${what} must be an SQL identifier (letters, digits and underscores, optionally schema-qualified); got ${JSON.stringify(value)}.`);
  }
  return value;
};

/**
 * Reads the migrations of a folder in number order: `<dir>/<dialect>` when
 * that folder exists, else `<dir>`. Files not ending in `.sql` are left out; a
 * `.sql` name out of form, or a number used twice, is refused. Node only.
 */
export async function readSchemaMigrations(dir: string, options: ReadSchemaMigrationsOptions = {}): Promise<SchemaMigration[]> {
  const { readdir, readFile, stat } = await import('fs/promises');
  const path = await import('path');
  const pattern = options.namePattern ?? DEFAULT_NAME;

  let folder = dir;
  if (options.dialect) {
    const own = path.join(dir, options.dialect);
    const isFolder = await stat(own).then((entry) => entry.isDirectory(), () => false);
    if (isFolder) folder = own;
  }

  const numbers = new Map<string, string>();
  const entries: Array<{ name: string; number: number }> = [];
  for (const name of await readdir(folder)) {
    if (!name.endsWith('.sql')) continue;
    const number = pattern.exec(name)?.[1];
    if (number === undefined) {
      throw new Error(`${name}: a migration's name is digits, an underscore and a lower-case name, ending in .sql.`);
    }
    const key = String(Number(number));
    if (numbers.has(key)) throw new Error(`${name}: the number ${number} is used twice (also ${numbers.get(key)}).`);
    numbers.set(key, name);
    entries.push({ name, number: Number(number) });
  }
  entries.sort((a, b) => a.number - b.number || a.name.localeCompare(b.name));

  return Promise.all(entries.map(async ({ name }) => ({ name, sql: await readFile(path.join(folder, name), 'utf8') })));
}

interface Resolved {
  table: string;
  checksumColumn: string;
  lock: { sql: string; session: string; unlock: string; params: unknown[] } | null;
  unknown: 'refuse' | 'ignore';
  marker: string;
  dialect: 'postgres' | 'sqlite';
}

const resolve = (adapter: StorageAdapter, options: SchemaMigrationOptions): Resolved => {
  const table = checkIdentifier('table', options.table ?? DEFAULT_TABLE);
  const checksumColumn = checkIdentifier('checksumColumn', options.checksumColumn ?? DEFAULT_CHECKSUM_COLUMN);
  const key = options.lockKey ?? DEFAULT_LOCK_KEY;
  if (typeof key === 'number' && !Number.isSafeInteger(key)) throw new Error(`lockKey must be a safe integer or text; got ${key}.`);
  const dialect = createStorageFeatures(adapter).dialect.name;
  const keyExpr = typeof key === 'number' ? '?' : 'hashtext(?)';
  return {
    table,
    checksumColumn,
    lock:
      dialect === 'postgres'
        ? {
            sql: `SELECT pg_advisory_xact_lock(${keyExpr})`,
            session: `SELECT pg_advisory_lock(${keyExpr})`,
            unlock: `SELECT pg_advisory_unlock(${keyExpr})`,
            params: [key],
          }
        : null,
    unknown: options.unknown ?? 'refuse',
    marker: options.outsideTransactionMarker ?? DEFAULT_MARKER,
    dialect,
  };
};

const ledgerDdl = (r: Resolved): string =>
  r.dialect === 'postgres'
    ? `CREATE TABLE IF NOT EXISTS ${r.table} (name TEXT PRIMARY KEY, ${r.checksumColumn} TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`
    : `CREATE TABLE IF NOT EXISTS ${r.table} (name TEXT PRIMARY KEY, ${r.checksumColumn} TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))`;

/** Runs `work` in a transaction that first takes the PostgreSQL lock. */
const inLockedTransaction = <T>(adapter: StorageAdapter, r: Resolved, work: (trx: StorageAdapter) => Promise<T>): Promise<T> =>
  adapter.transaction(async (trx) => {
    if (r.lock) await trx.get(r.lock.sql, r.lock.params);
    return work(trx);
  });

const ledgerRows = async (db: StorageAdapter, r: Resolved): Promise<Map<string, string>> => {
  const rows = await db.all<{ name: string; checksum: string }>(`SELECT name, ${r.checksumColumn} AS checksum FROM ${r.table}`);
  return new Map(rows.map((row) => [row.name, row.checksum]));
};

const compare = (
  list: Array<SchemaMigration & { checksum: string }>,
  ledger: Map<string, string>
): Omit<SchemaMigrationReport, 'skipped'> => {
  const report = { applied: [] as string[], pending: [] as string[], changed: [] as string[], unknown: [] as string[] };
  const carried = new Set(list.map((migration) => migration.name));
  for (const migration of list) {
    const recorded = ledger.get(migration.name);
    if (recorded === undefined) report.pending.push(migration.name);
    else if (recorded !== migration.checksum) report.changed.push(migration.name);
    else report.applied.push(migration.name);
  }
  report.unknown = [...ledger.keys()].filter((name) => !carried.has(name)).sort();
  return report;
};

const withChecksums = (migrations: SchemaMigration[]): Promise<Array<SchemaMigration & { checksum: string }>> =>
  Promise.all(migrations.map(async (migration) => ({ ...migration, checksum: await sha256Hex(migration.sql) })));

/** Creates the ledger if it is missing, under the lock. */
const ensureLedger = (adapter: StorageAdapter, r: Resolved): Promise<void> =>
  inLockedTransaction(adapter, r, async (trx) => {
    await trx.exec(ledgerDdl(r));
  });

/**
 * Compares the list with the ledger and applies nothing: `applied` lists the
 * files the ledger holds unchanged, `pending` the files it lacks, `changed`
 * the files whose text differs from what was applied, `unknown` the ledger
 * rows the list lacks. Creates the ledger when it is missing.
 */
export async function schemaMigrationStatus(
  adapter: StorageAdapter,
  migrations: SchemaMigration[],
  options: SchemaMigrationOptions = {}
): Promise<SchemaMigrationReport> {
  const r = resolve(adapter, options);
  await ensureLedger(adapter, r);
  return { ...compare(await withChecksums(migrations), await ledgerRows(adapter, r)), skipped: [] };
}

/**
 * Applies every migration the ledger lacks, in list order, and reports what
 * it did: `applied` (this run) and `skipped` (already applied). Refuses to
 * start when an applied file's text changed, or (unless `unknown: 'ignore'`)
 * when the ledger holds a file the list lacks. A file runs in its own
 * transaction and holds no BEGIN or COMMIT; a file whose first line is the
 * outside-transaction marker runs outside one (on PostgreSQL that needs
 * `withConnection`, which PostgresAdapter has). Stops at the first error,
 * after rolling that file back, with an error that names it and carries the
 * database's error as `cause`.
 */
export async function runSchemaMigrations(
  adapter: StorageAdapter,
  migrations: SchemaMigration[],
  options: SchemaMigrationOptions = {}
): Promise<SchemaMigrationReport> {
  const r = resolve(adapter, options);
  const list = await withChecksums(migrations);
  await ensureLedger(adapter, r);

  const before = compare(list, await ledgerRows(adapter, r));
  if (before.changed.length) {
    throw new Error(`Applied migrations differ from the files given: ${before.changed.join(', ')}. An applied migration never changes.`);
  }
  if (before.unknown.length && r.unknown === 'refuse') {
    throw new Error(`The database has applied migrations the list lacks: ${before.unknown.join(', ')}. Run the newer code, or pass unknown: 'ignore'.`);
  }

  const report: SchemaMigrationReport = { applied: [], skipped: [...before.applied], pending: [], changed: [], unknown: before.unknown };
  for (const migration of list) {
    if (!before.pending.includes(migration.name)) continue;
    let applied: boolean;
    try {
      applied = outsideTransaction(migration, r) ? await applyOutside(adapter, r, migration) : await applyInside(adapter, r, migration);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failure = new Error(`Migration ${migration.name} failed: ${message}`);
      (failure as Error & { cause?: unknown }).cause = error;
      throw failure;
    }
    (applied ? report.applied : report.skipped).push(migration.name);
    if (applied) getStorageLogger().info({ migration: migration.name, table: r.table }, `Applied migration ${migration.name}.`);
  }
  return report;
}

const outsideTransaction = (migration: SchemaMigration, r: Resolved): boolean =>
  migration.sql.split('\n', 1)[0]?.trim() === r.marker;

/** The checksum the ledger holds for `name` now, read through `db`. */
const recorded = async (db: StorageAdapter, r: Resolved, name: string): Promise<string | undefined> =>
  (await db.get<{ checksum: string }>(`SELECT ${r.checksumColumn} AS checksum FROM ${r.table} WHERE name = ?`, [name]))?.checksum;

/** Throws when another runner applied a different text under this name. True when the file is applied. */
const appliedAlready = (migration: SchemaMigration & { checksum: string }, checksum: string | undefined): boolean => {
  if (checksum === undefined) return false;
  if (checksum !== migration.checksum) {
    throw new Error(`it was applied with checksum ${checksum} and now reads ${migration.checksum}`);
  }
  return true;
};

const record = (db: StorageAdapter, r: Resolved, migration: SchemaMigration & { checksum: string }): Promise<unknown> =>
  db.run(`INSERT INTO ${r.table} (name, ${r.checksumColumn}) VALUES (?, ?)`, [migration.name, migration.checksum]);

/** Applies one file in its own locked transaction, checking the ledger again under the lock. */
const applyInside = (adapter: StorageAdapter, r: Resolved, migration: SchemaMigration & { checksum: string }): Promise<boolean> =>
  inLockedTransaction(adapter, r, async (trx) => {
    if (appliedAlready(migration, await recorded(trx, r, migration.name))) return false;
    await trx.exec(migration.sql);
    await record(trx, r, migration);
    return true;
  });

type HoldsConnection = StorageAdapter & {
  withConnection<T>(fn: (connection: StorageAdapter) => Promise<T>): Promise<T>;
};

/** Applies one marked file outside a transaction: on PostgreSQL under the session-level lock on one held connection. */
const applyOutside = async (adapter: StorageAdapter, r: Resolved, migration: SchemaMigration & { checksum: string }): Promise<boolean> => {
  const work = async (db: StorageAdapter): Promise<boolean> => {
    if (appliedAlready(migration, await recorded(db, r, migration.name))) return false;
    await db.exec(migration.sql);
    await record(db, r, migration);
    return true;
  };
  if (!r.lock) return work(adapter);

  const held = adapter as Partial<HoldsConnection>;
  if (typeof held.withConnection !== 'function') {
    throw new Error('a file outside a transaction needs an adapter with withConnection() on PostgreSQL, to hold the lock on one session');
  }
  const { params, session, unlock } = r.lock;
  return (held as HoldsConnection).withConnection(async (connection) => {
    await connection.get(session, params);
    try {
      return await work(connection);
    } finally {
      await connection.get(unlock, params);
    }
  });
};
