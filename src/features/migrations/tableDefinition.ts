/**
 * Table definitions across engines, for importData, migrateAdapter and the
 * SQL export: a source column's type and default read as a kind, and written
 * as the target engine's.
 */

import { SqliteDialect } from '../../dialects/SqliteDialect';
import type { ColumnInfo, TableSchema } from './dataExport';

/** The engines a table definition is read from and written for. */
export type Engine = 'sqlite' | 'postgres';

type Kind =
  | 'integer'
  | 'bigint'
  | 'real'
  | 'numeric'
  | 'text'
  | 'untyped'
  | 'boolean'
  | 'date'
  | 'time'
  | 'timestamp'
  | 'json'
  | 'uuid'
  | 'blob';

const INT4_MIN = -2147483648;
const INT4_MAX = 2147483647;

const LITERAL = /^'(?:[^']|'')*'$/;
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const CAST_SUFFIX = /::\s*"?[A-Za-z_][A-Za-z0-9_ ."]*(?:\(\s*\d+(?:\s*,\s*\d+)?\s*\))?(?:\[\])*\s*$/;

/** Quotes an SQL identifier. */
export const quoteIdentifier = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/**
 * A SQLite declared type's kind: the names applications give dates, booleans,
 * JSON and UUIDs first, then SQLite's affinity rules in their order
 * (https://www.sqlite.org/datatype3.html#determination_of_column_affinity).
 */
const sqliteKind = (declared: string): Kind => {
  const type = declared.trim().toUpperCase();
  if (type.includes('BOOL')) return 'boolean';
  if (type.includes('DATETIME') || type.includes('TIMESTAMP')) return 'timestamp';
  if (type === 'DATE') return 'date';
  if (type === 'TIME') return 'time';
  if (type.includes('JSON')) return 'json';
  if (type.includes('UUID') || type.includes('GUID')) return 'uuid';
  if (type.includes('INT')) return 'integer';
  if (type.includes('CHAR') || type.includes('CLOB') || type.includes('TEXT')) return 'text';
  if (type.includes('BLOB')) return 'blob';
  if (type === '') return 'untyped';
  if (type.includes('REAL') || type.includes('FLOA') || type.includes('DOUB')) return 'real';
  return 'numeric';
};

/** A PostgreSQL type's kind, from format_type's name for it. */
const postgresKind = (formatted: string): Kind => {
  const type = formatted.trim().toLowerCase();
  if (type.endsWith('[]')) return 'json';
  if (type === 'smallint' || type === 'integer') return 'integer';
  if (type === 'bigint') return 'bigint';
  if (type.startsWith('numeric') || type.startsWith('decimal')) return 'numeric';
  if (type === 'real' || type === 'double precision') return 'real';
  if (type === 'boolean') return 'boolean';
  if (type.startsWith('timestamp')) return 'timestamp';
  if (type === 'date') return 'date';
  if (type.startsWith('time')) return 'time';
  if (type === 'json' || type === 'jsonb') return 'json';
  if (type === 'uuid') return 'uuid';
  if (type === 'bytea') return 'blob';
  return 'text';
};

/** Whether a value in the column lies outside PostgreSQL's INTEGER. */
const outsideInt4 = (rows: unknown[], column: string): boolean =>
  rows.some((row) => {
    const value = (row as Record<string, unknown>)[column];
    if (typeof value === 'bigint') return value < BigInt(INT4_MIN) || value > BigInt(INT4_MAX);
    if (typeof value === 'number') return value < INT4_MIN || value > INT4_MAX;
    if (typeof value === 'string' && /^\s*[+-]?\d+\s*$/.test(value)) {
      const number = Number(value);
      return number < INT4_MIN || number > INT4_MAX;
    }
    return false;
  });

/** Whether the column holds a binary value. */
const holdsBinary = (rows: unknown[], column: string): boolean =>
  rows.some((row) => (row as Record<string, unknown>)[column] instanceof Uint8Array);

/** The target engine's type for a kind. */
const targetType = (kind: Kind, target: Engine, wide: boolean): string => {
  if (target === 'sqlite') {
    switch (kind) {
      case 'integer':
      case 'bigint':
      case 'boolean':
        return 'INTEGER';
      case 'real':
        return 'REAL';
      case 'numeric':
        return 'TEXT';
      case 'blob':
        return 'BLOB';
      default:
        return 'TEXT';
    }
  }
  switch (kind) {
    case 'integer':
      return wide ? 'BIGINT' : 'INTEGER';
    case 'bigint':
      return 'BIGINT';
    case 'real':
      return 'DOUBLE PRECISION';
    case 'numeric':
      return 'NUMERIC';
    case 'boolean':
      return 'BOOLEAN';
    case 'date':
      return 'DATE';
    case 'time':
      return 'TIME';
    case 'timestamp':
      return 'TIMESTAMPTZ';
    case 'json':
      return 'JSONB';
    case 'uuid':
      return 'UUID';
    case 'blob':
      return 'BYTEA';
    default:
      return 'TEXT';
  }
};

/** Whether the text is one parenthesised group, as in `(x)` but not `(a) + (b)`. */
const wrapped = (text: string): boolean => {
  if (!text.startsWith('(') || !text.endsWith(')')) return false;
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === "'") quoted = !quoted;
    if (quoted) continue;
    if (char === '(') depth++;
    if (char === ')') {
      depth--;
      if (depth === 0 && index < text.length - 1) return false;
    }
  }
  return depth === 0;
};

const unwrap = (expr: string): string => {
  let text = expr.trim();
  while (wrapped(text)) text = text.slice(1, -1).trim();
  return text;
};

/** A PostgreSQL default without the casts it writes on literals (`'none'::character varying`). */
const uncast = (expr: string): string => {
  let text = unwrap(expr);
  for (;;) {
    const cast = CAST_SUFFIX.exec(text);
    if (!cast) return text;
    const head = unwrap(text.slice(0, cast.index));
    if (!LITERAL.test(head) && !NUMBER.test(head)) return text;
    text = head;
  }
};

type Moment = { what: 'timestamp' | 'date' | 'time' | 'epoch' | 'seconds'; format?: string };

const SQLITE_ISO_NOW = new SqliteDialect().now();

/** The current-time defaults each engine writes, read as what they give. */
const moment = (expr: string, from: Engine): Moment | null => {
  const compact = expr.replace(/\s+/g, '');
  const upper = compact.toUpperCase();
  if (from === 'sqlite') {
    if (upper === 'CURRENT_TIMESTAMP' || upper === "DATETIME('NOW')") return { what: 'timestamp', format: 'YYYY-MM-DD HH24:MI:SS' };
    if (upper === 'CURRENT_DATE' || upper === "DATE('NOW')") return { what: 'date', format: 'YYYY-MM-DD' };
    if (upper === 'CURRENT_TIME' || upper === "TIME('NOW')") return { what: 'time', format: 'HH24:MI:SS' };
    if (compact === SQLITE_ISO_NOW.replace(/\s+/g, '')) return { what: 'timestamp', format: 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"' };
    const strftime = /^STRFTIME\('%([sS])','NOW'\)$/i.exec(compact) ??
      /^CAST\(STRFTIME\('%([sS])','NOW'\)ASINTEGER\)$/i.exec(compact);
    if (strftime) return { what: strftime[1] === 's' ? 'epoch' : 'seconds' };
    if (upper === 'UNIXEPOCH()' || upper === "UNIXEPOCH('NOW')") return { what: 'epoch' };
    return null;
  }
  if (
    /^(NOW\(\)|CURRENT_TIMESTAMP(\(\d\))?|LOCALTIMESTAMP(\(\d\))?|TRANSACTION_TIMESTAMP\(\)|STATEMENT_TIMESTAMP\(\)|CLOCK_TIMESTAMP\(\))$/.test(upper)
  ) {
    return { what: 'timestamp' };
  }
  if (upper === 'CURRENT_DATE') return { what: 'date' };
  if (/^(CURRENT_TIME|LOCALTIME)(\(\d\))?$/.test(upper)) return { what: 'time' };
  return null;
};

/** The current time as the target engine writes it for a column of this kind. */
const momentFor = (now: Moment, kind: Kind, target: Engine): string | null => {
  if (target === 'postgres') {
    // SQLite's current-time defaults give UTC (https://www.sqlite.org/lang_createtable.html#dfltval).
    if (now.what === 'seconds') return ['integer', 'bigint', 'numeric'].includes(kind) ? '(FLOOR(EXTRACT(SECOND FROM now())))::integer' : null;
    if (now.what === 'epoch') return kind === 'integer' || kind === 'bigint' || kind === 'numeric' ? '(EXTRACT(EPOCH FROM now()))::bigint' : null;
    if (kind === 'timestamp') return 'CURRENT_TIMESTAMP';
    if (kind === 'date') return "((now() AT TIME ZONE 'UTC')::date)";
    if (kind === 'time') return "((now() AT TIME ZONE 'UTC')::time)";
    if (kind === 'text' || kind === 'untyped') return now.format ? `(to_char(now() AT TIME ZONE 'UTC', '${now.format.replace(/'/g, "''")}'))` : null;
    return null;
  }
  if (now.what === 'date') return 'CURRENT_DATE';
  if (now.what === 'time') return 'CURRENT_TIME';
  if (now.what === 'timestamp') return `(${SQLITE_ISO_NOW})`;
  return null;
};

const TRUE_WORDS = new Set(['t', 'true', 'y', 'yes', 'on', '1']);
const FALSE_WORDS = new Set(['f', 'false', 'n', 'no', 'off', '0']);

/**
 * Calendar literals that can be carried to PostgreSQL without relying on
 * DateStyle or accepting SQLite's zero dates. Other forms get a warning.
 */
const calendarLiteral = (value: string, kind: Kind): boolean => {
  if (/^[+-]?infinity$/i.test(value) && kind !== 'time') return true;
  const time = /^(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}(?::?\d{2})?)?$/;
  const validTime = (text: string): boolean => {
    const match = time.exec(text);
    return !!match && Number(match[1]) < 24 && Number(match[2]) < 60 && Number(match[3]) < 60;
  };
  if (kind === 'time') return validTime(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](.+))?$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year > 0 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1] &&
    (!match[4] || (kind === 'timestamp' && validTime(match[4])));
};

/** A default written for the other engine, or null when it has no form there. */
const crossDefault = (raw: string, kind: Kind, from: Engine, to: Engine, sourceType: string): string | null => {
  const expr = from === 'postgres' ? uncast(raw) : unwrap(raw);
  const upper = expr.toUpperCase();
  if (upper === 'NULL') return 'NULL';
  if (from === 'postgres' && sourceType.endsWith('[]')) return expr === "'{}'" ? "'[]'" : null;
  if (NUMBER.test(expr)) {
    if (kind === 'numeric' && to === 'sqlite') return `'${expr}'`;
    if (kind === 'boolean' && to === 'postgres') return Number(expr) === 0 ? 'FALSE' : 'TRUE';
    return expr;
  }
  if (LITERAL.test(expr)) {
    if (to === 'postgres' && ['date', 'time', 'timestamp'].includes(kind) && !calendarLiteral(expr.slice(1, -1), kind)) return null;
    if (kind === 'boolean') {
      const word = expr.slice(1, -1).trim().toLowerCase();
      if (TRUE_WORDS.has(word)) return to === 'sqlite' ? '1' : 'TRUE';
      if (FALSE_WORDS.has(word)) return to === 'sqlite' ? '0' : 'FALSE';
    }
    return expr;
  }
  if (upper === 'TRUE' || upper === 'FALSE') {
    if (to === 'sqlite' || ['integer', 'bigint', 'real', 'numeric'].includes(kind)) return upper === 'TRUE' ? '1' : '0';
    return kind === 'boolean' ? upper : null;
  }
  const now = moment(expr, from);
  if (now) return momentFor(now, kind, to);
  if (from === 'postgres' && /^(GEN_RANDOM_UUID|UUID_GENERATE_V4)\(\)$/.test(upper.replace(/\s+/g, ''))) {
    return `(${new SqliteDialect().uuid()})`;
  }
  if (from === 'sqlite' && expr.replace(/\s+/g, '') === new SqliteDialect().uuid().replace(/\s+/g, '')) return 'gen_random_uuid()';
  return null;
};

/** The kind of a source column, data deciding an untyped SQLite column. */
const kindOf = (column: ColumnInfo, source: Engine, rows: unknown[]): Kind => {
  const kind = source === 'sqlite' ? sqliteKind(column.type ?? '') : postgresKind(column.type ?? '');
  if (kind === 'untyped') return holdsBinary(rows, column.name) ? 'blob' : 'untyped';
  return kind;
};

/** Options for createTableStatement. */
export interface TableStatementOptions {
  /** The rows the table will hold, which decide INTEGER or BIGINT for an integer column on PostgreSQL. */
  rows?: unknown[];
  /** Column types to use as given, by `table.column`. */
  columnTypes?: Record<string, string>;
  /** Create every identity column as GENERATED BY DEFAULT, for statements that insert ids (an SQL export). */
  identityByDefault?: boolean;
}

/** A CREATE TABLE statement and what it could not carry over. */
export interface TableStatement {
  sql: string;
  warnings: string[];
}

const ifNotExists = (sql: string): string =>
  sql.replace(/^\s*CREATE\s+(VIRTUAL\s+)?TABLE\s+(?!IF\s+NOT\s+EXISTS\b)/i, (_match, virtual: string | undefined) =>
    `CREATE ${virtual ? 'VIRTUAL ' : ''}TABLE IF NOT EXISTS `,
  );

/**
 * The CREATE TABLE statement for `schema`, read from the `source` engine,
 * written for the `target` one.
 *
 * - SQLite to SQLite runs the statement SQLite keeps for the table, so its
 *   keys, AUTOINCREMENT, constraints and generated columns come along.
 * - Otherwise each column gets the target engine's type for its kind, its
 *   default when the target engine has a form of it, and NOT NULL; the
 *   primary key follows. A column the source engine fills (SQLite's INTEGER
 *   PRIMARY KEY, a PostgreSQL identity or serial) becomes an identity
 *   column on PostgreSQL and an INTEGER PRIMARY KEY AUTOINCREMENT on SQLite.
 */
export const createTableStatement = (
  schema: TableSchema,
  source: Engine,
  target: Engine,
  options: TableStatementOptions = {},
): TableStatement => {
  if (schema.columns.length === 0) {
    throw new Error(`Cannot create table ${schema.name} without column definitions`);
  }
  const warnings: string[] = [];
  const rows = options.rows ?? [];
  const columnTypes = options.columnTypes ?? {};
  const overridden = schema.columns.some((column) => columnTypes[`${schema.name}.${column.name}`] !== undefined);

  if (source === 'sqlite' && target === 'sqlite' && schema.sql && !overridden) {
    return { sql: ifNotExists(schema.sql), warnings };
  }

  const primaryKeys = schema.primaryKeys ?? [];
  const where = (column: ColumnInfo) => `${schema.name}.${column.name}`;
  const kinds = new Map(schema.columns.map((column) => [column.name, kindOf(column, source, rows)]));
  const integerKind = (column: ColumnInfo) => ['integer', 'bigint'].includes(kinds.get(column.name) ?? '');
  // SQLite fills only a single-column INTEGER PRIMARY KEY, written in the column.
  const rowidKey =
    target === 'sqlite' && primaryKeys.length === 1
      ? schema.columns.find((column) => column.name === primaryKeys[0] && column.autoIncrement && integerKind(column))
      : undefined;

  const definitions = schema.columns.map((column) => {
    const kind = kinds.get(column.name) as Kind;
    const override = columnTypes[where(column)];
    const sameEngine = source === target;
    let type = override ?? (sameEngine ? column.type : targetType(kind, target, outsideInt4(rows, column.name)));
    let definition = '';

    if (column === rowidKey) {
      if (!override) type = 'INTEGER';
      return `${quoteIdentifier(column.name)} ${type} PRIMARY KEY${source === 'postgres' ? ' AUTOINCREMENT' : ''}`;
    }

    if (column.generated) {
      if (sameEngine && target === 'postgres' && column.generationExpression) {
        definition = ` GENERATED ALWAYS AS (${column.generationExpression}) ${column.generationKind === 'virtual' ? 'VIRTUAL' : 'STORED'}`;
      } else {
        warnings.push(`${where(column)} is a generated column in ${source}; it was created as a plain column holding the copied values.`);
      }
    } else if (column.autoIncrement && target === 'postgres') {
      const always = sameEngine && column.identity === 'always' && !options.identityByDefault;
      definition = ` GENERATED ${always ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY`;
    } else {
      if (column.autoIncrement) {
        warnings.push(
          `${where(column)} takes its values from a sequence in ${source}; SQLite fills only an INTEGER PRIMARY KEY, so it was created as a plain, nullable column holding the copied values.`,
        );
      }
      const fromSequence = column.defaultValue !== undefined && /^\s*nextval\s*\(/i.test(column.defaultValue);
      if (column.defaultValue !== undefined && column.defaultValue !== '' && !fromSequence) {
        const written = sameEngine ? column.defaultValue : crossDefault(column.defaultValue, kind, source, target, column.type);
        if (written === null) {
          warnings.push(`${where(column)}: the default ${column.defaultValue} has no ${target} form, so the column was created without it.`);
        } else {
          definition = ` DEFAULT ${written}`;
        }
      }
    }

    // An identity is NOT NULL by itself; a column SQLite cannot fill stays
    // nullable, so a row that leaves it out can still be inserted.
    const notNull = !column.nullable && !column.autoIncrement ? ' NOT NULL' : '';
    return `${quoteIdentifier(column.name)} ${type}${notNull}${definition}`;
  });

  if (primaryKeys.length > 0 && !rowidKey) {
    definitions.push(`PRIMARY KEY (${primaryKeys.map(quoteIdentifier).join(', ')})`);
  }

  return {
    sql: `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(schema.name)} (\n  ${definitions.join(',\n  ')}\n)`,
    warnings,
  };
};
