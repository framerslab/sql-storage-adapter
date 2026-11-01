import type { Database as SqlJsDatabase, SqlValue } from 'sql.js';

/**
 * The first column of the first row a statement returns, or undefined when it
 * returns none, read through `prepare()`, `step()` and `free()`. sql.js up to
 * 1.14.1 takes 16 bytes of its fixed WebAssembly stack on every
 * `Database.exec()` call and never gives them back (fixed in 1.14.2), and a
 * save reads some thirty values; once the stack runs out SQLite writes over
 * the heap. So the adapters' own reads never go through `exec()`.
 */
export const firstValue = (db: SqlJsDatabase, sql: string): SqlValue | undefined => {
  const stmt = db.prepare(sql);
  try {
    return stmt.step() ? stmt.get()[0] : undefined;
  } finally {
    stmt.free();
  }
};

/** Every row's first column, read as {@link firstValue} reads one. */
export const firstColumn = (db: SqlJsDatabase, sql: string): SqlValue[] => {
  const stmt = db.prepare(sql);
  const values: SqlValue[] = [];
  try {
    while (stmt.step()) values.push(stmt.get()[0]);
  } finally {
    stmt.free();
  }
  return values;
};

/**
 * The connection settings that sql.js's `export()` resets: it closes the
 * connection and opens it again, and a PRAGMA set on the old connection is
 * back at its default on the new one. The sql.js and IndexedDB adapters read
 * these before each export and set again the ones the reopened connection
 * lost. Each reads back with `PRAGMA <name>` and is set with
 * `PRAGMA <name> = <value>`. `query_only` comes last, so it cannot stand in
 * the way of the others.
 */
export const CONNECTION_PRAGMAS = [
  'foreign_keys',
  'recursive_triggers',
  'ignore_check_constraints',
  'legacy_alter_table',
  'reverse_unordered_selects',
  'trusted_schema',
  'automatic_index',
  'cell_size_check',
  'secure_delete',
  'cache_size',
  'cache_spill',
  'temp_store',
  'synchronous',
  'journal_mode',
  'busy_timeout',
  'query_only',
] as const;

/** Connection settings read from a connection, in the order they are set again. */
export type ConnectionSettings = Array<readonly [name: string, value: number | string]>;

/** What an export that keeps the connection's settings reports. */
export interface KeepSettingsReport {
  /** A setting the reopened connection refused; the others are set. */
  onRefused(name: string, value: number | string, error: unknown): void;
  /**
   * The TEMP tables, views, indexes and triggers the export dropped, which a
   * reopened connection does not have. Called only when there were some.
   */
  onTempObjectsDropped?(count: number): void;
}

/** A PRAGMA's value on a connection, or undefined when this build of SQLite has no such setting. */
const readPragma = (db: SqlJsDatabase, name: string): number | string | undefined => {
  try {
    const value = firstValue(db, `PRAGMA ${name}`);
    if (typeof value === 'number' && Number.isInteger(value)) return value;
    if (typeof value === 'string' && /^[A-Za-z_]+$/.test(value)) return value;
  } catch {
    // This build of SQLite does not know the pragma.
  }
  return undefined;
};

/**
 * The value to set a setting to. PRAGMA secure_delete reads 2 when it is FAST,
 * but takes 2 as a boolean, which turns it ON; it takes FAST by name.
 */
const settingLiteral = (name: string, value: number | string): number | string =>
  name === 'secure_delete' && value === 2 ? 'FAST' : value;

/** The settings of {@link CONNECTION_PRAGMAS} a connection has now. */
export const readConnectionSettings = (db: SqlJsDatabase): ConnectionSettings => {
  const settings: ConnectionSettings = [];
  for (const name of CONNECTION_PRAGMAS) {
    const value = readPragma(db, name);
    if (value !== undefined) settings.push([name, value]);
  }
  return settings;
};

/**
 * Sets on a connection each setting whose value it does not have already, in
 * the order given. A setting the connection refuses is reported and left as
 * it is.
 */
export const restoreConnectionSettings = (
  db: SqlJsDatabase,
  settings: ConnectionSettings,
  onRefused: KeepSettingsReport['onRefused'],
): void => {
  for (const [name, value] of settings) {
    if (readPragma(db, name) === value) continue;
    try {
      // run() without parameters is sqlite3_exec(), which returns the stack it takes.
      db.run(`PRAGMA ${name} = ${settingLiteral(name, value)}`);
    } catch (error) {
      onRefused(name, value, error);
    }
  }
};

/** How many TEMP tables, views, indexes and triggers the connection has. */
const tempObjectCount = (db: SqlJsDatabase): number => {
  try {
    return Number(firstValue(db, 'SELECT count(*) FROM sqlite_temp_master') ?? 0);
  } catch {
    return 0;
  }
};

/**
 * The database image, through sql.js's `export()`. `export()` closes and
 * reopens the connection, which sets every PRAGMA back to its default, so the
 * connection's settings are read first and set again after: a setting holds
 * as it would on a connection that is never reopened, whether `open()` made it
 * or a statement did later. TEMP objects, attached databases and functions
 * registered on the sql.js database do not survive the reopen; the TEMP
 * objects it drops are reported.
 */
export const exportKeepingSettings = (db: SqlJsDatabase, report: KeepSettingsReport): Uint8Array => {
  const settings = readConnectionSettings(db);
  const tempObjects = report.onTempObjectsDropped ? tempObjectCount(db) : 0;
  const image = db.export();
  restoreConnectionSettings(db, settings, report.onRefused);
  if (tempObjects > 0) report.onTempObjectsDropped?.(tempObjects);
  return image;
};
