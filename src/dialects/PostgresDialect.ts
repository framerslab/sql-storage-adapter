import { syncPostgresSequence } from '../shared/identitySequence.js';
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
  checkChoice,
  checkColumnName,
  checkDateBucketUnit,
  checkTableName,
  intervalSeconds,
  parseJsonPath,
  upsertUpdateColumns,
} from './shared.js';

const COLUMN_TYPES: Record<ColumnKind, string> = {
  text: 'TEXT',
  integer: 'INTEGER',
  bigint: 'BIGINT',
  real: 'DOUBLE PRECISION',
  boolean: 'BOOLEAN',
  timestamp: 'TIMESTAMPTZ',
  json: 'JSONB',
  uuid: 'UUID',
  blob: 'BYTEA',
};

const CAST_TYPES: Record<CastType, string> = {
  text: 'text',
  integer: 'integer',
  real: 'double precision',
  timestamp: 'timestamptz',
};

/** ISO 8601 UTC text with milliseconds, as the SQLite dialect writes times. */
const ISO_TEXT = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/**
 * PostgreSQL dialect implementation.
 *
 * Generates Postgres-compatible SQL syntax including `ON CONFLICT DO NOTHING`,
 * `ON CONFLICT ... DO UPDATE SET`, `jsonb` extraction operators, `COALESCE()`,
 * `GENERATED ALWAYS AS IDENTITY`, and `$N` positional placeholders.
 */
export class PostgresDialect implements SqlDialect {
  readonly name = 'postgres' as const;

  insertOrIgnore(table: string, columns: string[], placeholders: string[]): string {
    return `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) ON CONFLICT DO NOTHING`;
  }

  insertOrReplace(table: string, columns: string[], placeholders: string[], primaryKey?: string): string {
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
      ? `DO UPDATE SET ${updates.map((column) => `${column} = EXCLUDED.${column}`).join(', ')}`
      : 'DO NOTHING';
    return `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) ON CONFLICT (${conflictColumns.join(', ')}) ${action}`;
  }

  jsonExtract(column: string, jsonPath: string): string {
    const path = jsonPath.replace(/^\$\./, '');
    const parts = path.split('.');
    if (parts.length === 1) {
      return `(${column}::jsonb)->>'${parts[0]}'`;
    }
    const args = parts.map((p) => `'${p}'`).join(', ');
    return `jsonb_extract_path_text(${column}::jsonb, ${args})`;
  }

  jsonExtractAs(column: string, jsonPath: string, type: JsonValueType): string {
    checkChoice('jsonExtractAs type', type, ['text', 'integer', 'real', 'json']);
    const path = `'{${parseJsonPath(jsonPath).join(',')}}'`;
    if (type === 'json') return `((${column})::jsonb #> ${path})`;
    const text = `((${column})::jsonb #>> ${path})`;
    if (type === 'text') return text;
    return `(${text})::${type === 'integer' ? 'integer' : 'double precision'}`;
  }

  jsonArrayContains(jsonArray: string, valueExpr: string): string {
    return `EXISTS (SELECT 1 FROM jsonb_array_elements_text((${jsonArray})::jsonb) AS element(value) WHERE element.value = CAST(${valueExpr} AS text))`;
  }

  ifnull(expr: string, fallback: string): string {
    return `COALESCE(${expr}, ${fallback})`;
  }

  autoIncrementPrimaryKey(options: AutoIncrementOptions = {}): string {
    return `INTEGER GENERATED ${options.acceptExplicitIds ? 'BY DEFAULT' : 'ALWAYS'} AS IDENTITY PRIMARY KEY`;
  }

  syncIdentitySequence(table: string, column: string): string {
    const name = checkTableName(table);
    const col = checkColumnName(column);
    // pg_get_serial_sequence parses its first argument as SQL does (unquoted
    // names fold to lower case) and takes the column name literally.
    return syncPostgresSequence(
      `pg_get_serial_sequence('${name}', '${col.toLowerCase()}')`,
      `SELECT MAX(${col}) FROM ${name}`,
    );
  }

  columnType(kind: ColumnKind): string {
    checkChoice('columnType kind', kind, Object.keys(COLUMN_TYPES) as ColumnKind[]);
    return COLUMN_TYPES[kind];
  }

  pragma(_key: string, _value: string): string | null {
    return null;
  }

  placeholder(index: number): string {
    return `$${index + 1}`;
  }

  now(): string {
    return 'now()';
  }

  cast(expr: string, type: CastType): string {
    checkChoice('cast type', type, ['text', 'integer', 'real', 'timestamp']);
    return `CAST(${expr} AS ${CAST_TYPES[type]})`;
  }

  addInterval(expr: string, amount: number, unit: IntervalUnit): string {
    // Seconds, not days: a day added to a timestamptz follows the session's
    // time zone across a DST change, while SQLite adds 86400 seconds.
    return `((${expr})::timestamptz + interval '${intervalSeconds(amount, unit)} seconds')`;
  }

  dateBucket(unit: DateBucketUnit, expr: string): string {
    return `to_char(date_trunc('${checkDateBucketUnit(unit)}', (${expr})::timestamptz AT TIME ZONE 'UTC'), ${ISO_TEXT})`;
  }

  ilike(expr: string, pattern: string): string {
    return `${expr} ILIKE ${pattern}`;
  }

  inList(expr: string, items: string[]): string {
    return items.length ? `${expr} IN (${items.join(', ')})` : '(1 = 0)';
  }

  inArray(expr: string, arrayParam: string): string {
    return `${expr} = ANY(${arrayParam})`;
  }

  rowLock(mode: 'update' | 'share', wait: 'wait' | 'skipLocked' | 'noWait' = 'wait'): string {
    checkChoice('rowLock mode', mode, ['update', 'share']);
    checkChoice('rowLock wait', wait, ['wait', 'skipLocked', 'noWait']);
    const lock = mode === 'update' ? ' FOR UPDATE' : ' FOR SHARE';
    return wait === 'skipLocked' ? `${lock} SKIP LOCKED` : wait === 'noWait' ? `${lock} NOWAIT` : lock;
  }

  advisoryTransactionLock(keyExpr: string): string | null {
    return `SELECT pg_advisory_xact_lock(${keyExpr})`;
  }

  greatest(...exprs: string[]): string {
    if (exprs.length === 0) throw new Error('greatest needs at least one expression.');
    return `GREATEST(${exprs.join(', ')})`;
  }

  least(...exprs: string[]): string {
    if (exprs.length === 0) throw new Error('least needs at least one expression.');
    return `LEAST(${exprs.join(', ')})`;
  }

  uuid(): string {
    return 'gen_random_uuid()';
  }
}
