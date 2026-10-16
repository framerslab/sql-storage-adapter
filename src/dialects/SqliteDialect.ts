import type {
  AutoIncrementOptions,
  CastType,
  ColumnKind,
  DateBucketUnit,
  IntervalUnit,
  JsonValueType,
  SqlDialect,
} from '../core/contracts/dialect.js';
import {
  checkChannelName,
  checkChoice,
  checkColumnName,
  checkDateBucketUnit,
  checkTableName,
  intervalSeconds,
  parseJsonPath,
  upsertUpdateColumns,
} from './shared.js';

/** The time format a bound Date takes, which SQLite's date functions read and write. */
const ISO_FORMAT = '%Y-%m-%dT%H:%M:%fZ';

const BUCKET_FORMATS: Record<DateBucketUnit, string> = {
  minute: '%Y-%m-%dT%H:%M:00.000Z',
  hour: '%Y-%m-%dT%H:00:00.000Z',
  day: '%Y-%m-%dT00:00:00.000Z',
  month: '%Y-%m-01T00:00:00.000Z',
  year: '%Y-01-01T00:00:00.000Z',
};

const COLUMN_TYPES: Record<ColumnKind, string> = {
  text: 'TEXT',
  integer: 'INTEGER',
  bigint: 'INTEGER',
  real: 'REAL',
  boolean: 'INTEGER',
  timestamp: 'TEXT',
  json: 'TEXT',
  uuid: 'TEXT',
  blob: 'BLOB',
};

/**
 * SQLite dialect implementation.
 *
 * Generates SQLite SQL: `INSERT OR IGNORE`, `ON CONFLICT ... DO UPDATE`
 * upserts, `json_extract()`, `ifnull()`, `strftime()` times in ISO 8601 UTC
 * text, `PRAGMA`, and positional `?` placeholders.
 */
export class SqliteDialect implements SqlDialect {
  readonly name = 'sqlite' as const;

  insertOrIgnore(table: string, columns: string[], placeholders: string[]): string {
    return `INSERT OR IGNORE INTO ${table} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`;
  }

  insertOrReplace(table: string, columns: string[], placeholders: string[], primaryKey?: string): string {
    // ON CONFLICT DO UPDATE, not INSERT OR REPLACE: REPLACE deletes the
    // conflicting row first, which fires ON DELETE actions on its dependents
    // and resets the columns the statement does not name.
    return this.upsert(table, columns, placeholders, [primaryKey ?? columns[0]]);
  }

  upsert(
    table: string,
    columns: string[],
    placeholders: string[],
    conflictColumns: string[],
    updateColumns?: string[]
  ): string {
    const updates = upsertUpdateColumns(columns, conflictColumns, updateColumns);
    const action = updates.length
      ? `DO UPDATE SET ${updates.map((column) => `${column} = excluded.${column}`).join(', ')}`
      : 'DO NOTHING';
    return `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) ON CONFLICT (${conflictColumns.join(', ')}) ${action}`;
  }

  jsonExtract(column: string, jsonPath: string): string {
    return `json_extract(${column}, '${jsonPath}')`;
  }

  jsonExtractAs(column: string, jsonPath: string, type: JsonValueType): string {
    checkChoice('jsonExtractAs type', type, ['text', 'integer', 'real', 'json']);
    const path = `$${parseJsonPath(jsonPath)
      .map((step) => (typeof step === 'number' ? `[${step}]` : `.${step}`))
      .join('')}`;
    const value = `json_extract(${column}, '${path}')`;
    if (type === 'json') return value;
    return `CAST(${value} AS ${type === 'text' ? 'TEXT' : type === 'integer' ? 'INTEGER' : 'REAL'})`;
  }

  jsonArrayContains(jsonArray: string, valueExpr: string): string {
    return `EXISTS (SELECT 1 FROM json_each(${jsonArray}) WHERE CAST(json_each.value AS TEXT) = CAST(${valueExpr} AS TEXT))`;
  }

  ifnull(expr: string, fallback: string): string {
    return `ifnull(${expr}, ${fallback})`;
  }

  autoIncrementPrimaryKey(_options: AutoIncrementOptions = {}): string {
    return 'INTEGER PRIMARY KEY AUTOINCREMENT';
  }

  changeNotificationSql(table: string, channel: string): null {
    checkTableName(table);
    checkChannelName(channel);
    return null;
  }

  syncIdentitySequence(table: string, column: string): null {
    checkTableName(table);
    checkColumnName(column);
    return null;
  }

  columnType(kind: ColumnKind): string {
    checkChoice('columnType kind', kind, Object.keys(COLUMN_TYPES) as ColumnKind[]);
    return COLUMN_TYPES[kind];
  }

  pragma(key: string, value: string): string | null {
    return `PRAGMA ${key} = ${value}`;
  }

  placeholder(_index: number): string {
    return '?';
  }

  now(): string {
    return `strftime('${ISO_FORMAT}', 'now')`;
  }

  cast(expr: string, type: CastType): string {
    checkChoice('cast type', type, ['text', 'integer', 'real', 'timestamp']);
    if (type === 'timestamp') return `strftime('${ISO_FORMAT}', ${expr})`;
    return `CAST(${expr} AS ${type === 'text' ? 'TEXT' : type === 'integer' ? 'INTEGER' : 'REAL'})`;
  }

  addInterval(expr: string, amount: number, unit: IntervalUnit): string {
    const seconds = intervalSeconds(amount, unit);
    return `strftime('${ISO_FORMAT}', ${expr}, '${seconds >= 0 ? '+' : ''}${seconds} seconds')`;
  }

  dateBucket(unit: DateBucketUnit, expr: string): string {
    return `strftime('${BUCKET_FORMATS[checkDateBucketUnit(unit)]}', ${expr})`;
  }

  ilike(expr: string, pattern: string): string {
    return `${expr} LIKE ${pattern}`;
  }

  inList(expr: string, items: string[]): string {
    return items.length ? `${expr} IN (${items.join(', ')})` : '(1 = 0)';
  }

  inArray(expr: string, arrayParam: string): string {
    return `${expr} IN (SELECT value FROM json_each(${arrayParam}))`;
  }

  rowLock(mode: 'update' | 'share', wait: 'wait' | 'skipLocked' | 'noWait' = 'wait'): string {
    checkChoice('rowLock mode', mode, ['update', 'share']);
    checkChoice('rowLock wait', wait, ['wait', 'skipLocked', 'noWait']);
    return '';
  }

  advisoryTransactionLock(_keyExpr: string): string | null {
    return null;
  }

  greatest(...exprs: string[]): string {
    return nullSkippingExtreme('max', exprs);
  }

  least(...exprs: string[]): string {
    return nullSkippingExtreme('min', exprs);
  }

  uuid(): string {
    return (
      "lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || " +
      "substr('89ab', 1 + (random() & 3), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6)))"
    );
  }
}

/**
 * SQLite's multi-argument max() and min() return NULL when any argument is
 * NULL; PostgreSQL's GREATEST and LEAST skip NULLs. Coalescing each argument
 * with the others first gives the PostgreSQL result: NULL only when all are.
 */
const nullSkippingExtreme = (fn: 'max' | 'min', exprs: string[]): string => {
  if (exprs.length === 0) throw new Error(`${fn === 'max' ? 'greatest' : 'least'} needs at least one expression.`);
  if (exprs.length === 1) return `(${exprs[0]})`;
  const coalesced = exprs.map((expr, index) => `coalesce(${[expr, ...exprs.filter((_, other) => other !== index)].join(', ')})`);
  return `${fn}(${coalesced.join(', ')})`;
};
