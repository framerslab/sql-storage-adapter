/**
 * Data export utilities for cross-adapter migration and backup.
 * Supports exporting data to portable formats (JSON, SQL, CSV).
 */

import { syncPostgresSequence } from '../../shared/identitySequence';
import type { StorageAdapter } from '../../core/contracts';
import { createStorageFeatures } from '../../core/contracts/features';
import { createTableStatement, quoteIdentifier, type Engine } from './tableDefinition';

/**
 * Export format types.
 */
export type ExportFormat = 'json' | 'sql' | 'csv';

/**
 * Options for data export.
 */
export interface DataExportOptions {
  /** Tables to export (all if not specified) */
  tables?: string[];
  /** Include schema/DDL statements */
  includeSchema?: boolean;
  /** Format for export */
  format?: ExportFormat;
  /** Batch size for large exports */
  batchSize?: number;
  /** Whether to pretty-print JSON */
  pretty?: boolean;
}

/**
 * Exported data structure.
 */
export interface ExportedData {
  version: string;
  exportedAt: string;
  adapter: string;
  /** The engine the data came from, which reads the schema's types and defaults on import. */
  dialect?: 'sqlite' | 'postgres';
  schema?: TableSchema[];
  data: Record<string, unknown[]>;
}

/**
 * Table schema information.
 */
export interface TableSchema {
  name: string;
  columns: ColumnInfo[];
  /** The primary key's columns, in key order. */
  primaryKeys?: string[];
  indexes?: IndexInfo[];
  /** A selected view is exported as a row snapshot, not recreated as a view. */
  view?: boolean;
  /** SQLite AUTOINCREMENT high-water mark, including ids whose rows were deleted. */
  sequence?: string;
  /** SQLite: the CREATE TABLE statement SQLite keeps for the table, which a SQLite import runs. */
  sql?: string;
}

/**
 * Column information.
 */
export interface ColumnInfo {
  name: string;
  /** The declared type on SQLite; format_type's name on PostgreSQL (`character varying(20)`, `integer[]`). */
  type: string;
  nullable?: boolean;
  defaultValue?: string;
  /** The engine fills it when an insert leaves it out: SQLite's INTEGER PRIMARY KEY, a PostgreSQL identity or serial column. */
  autoIncrement?: boolean;
  /** PostgreSQL: the identity column's kind. */
  identity?: 'always' | 'by default';
  /** A generated column, whose values the engine computes. */
  generated?: boolean;
  /** PostgreSQL: the generated column's expression. */
  generationExpression?: string;
  /** PostgreSQL: how the generated column is evaluated. */
  generationKind?: 'stored' | 'virtual';
}

/**
 * Index information.
 */
export interface IndexInfo {
  name: string;
  columns: string[];
  unique?: boolean;
}

/**
 * Export data from an adapter to a portable format.
 */
export async function exportData(
  adapter: StorageAdapter,
  options: DataExportOptions = {}
): Promise<ExportedData> {
  const { tables, includeSchema = true, batchSize = 1000 } = options;

  const engine = engineOf(adapter);
  const exportedData: ExportedData = {
    version: '1.0.0',
    exportedAt: new Date().toISOString(),
    adapter: 'sql-storage-adapter',
    dialect: engine,
    data: {},
  };

  // Get list of tables
  const tablesToExport = tables || (await getTables(adapter, engine));

  const schemas = await Promise.all(tablesToExport.map(table => getTableSchema(adapter, table, engine)));

  // Export schema if requested
  if (includeSchema) {
    exportedData.schema = schemas;
  }

  // Export data from each table
  for (const [index, table] of tablesToExport.entries()) {
    const rows: unknown[] = [];
    let offset = 0;
    let batch: unknown[];
    // Pages in one order, so none repeats or skips a row: the primary key's,
    // else the row's place in the table (its rowid on SQLite, its ctid on PostgreSQL).
    const keys = schemas[index].primaryKeys ?? [];
    const view = schemas[index].view === true;
    const order = view ? '' :
      keys.length > 0 ? ` ORDER BY ${keys.map(escapeIdentifier).join(', ')}` : engine === 'postgres' ? ' ORDER BY ctid' : ' ORDER BY rowid';

    // FTS uses its rowid to look up external content; SELECT * omits it.
    const selection = engine === 'sqlite' && /^\s*CREATE\s+VIRTUAL\s+TABLE\b/i.test(schemas[index].sql ?? '') &&
      /\bUSING\s+fts[345]\s*\(/i.test(schemas[index].sql ?? '') ? 'rowid, *' : '*';

    // Fetch data in batches
    do {
      batch = await adapter.all(
        `SELECT ${selection} FROM ${escapeIdentifier(table)}${order}${view ? '' : ` LIMIT ${batchSize} OFFSET ${offset}`}`
      );
      rows.push(...batch.map(row => {
        const record = { ...(row as Record<string, unknown>) };
        if (engine === 'postgres') {
          for (const column of schemas[index].columns) {
            const value = record[column.name];
            if (!(value instanceof Date)) continue;
            if (column.type === 'date' || /^timestamp(\(\d+\))? without time zone$/.test(column.type)) {
              // pg reads zone-less fields in the process's local time.
              const pad = (n: number, width = 2) => String(n).padStart(width, '0');
              const day = `${pad(value.getFullYear(), 4)}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
              record[column.name] = column.type === 'date' ? day :
                `${day} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}.${pad(value.getMilliseconds(), 3)}`;
            }
          }
        }
        return record;
      }));
      offset += batchSize;
    } while (!view && batch.length === batchSize);

    exportedData.data[table] = rows;
  }

  return exportedData;
}

/**
 * Export data as JSON string.
 */
export async function exportAsJSON(
  adapter: StorageAdapter,
  options: DataExportOptions = {}
): Promise<string> {
  const data = await exportData(adapter, options);
  return JSON.stringify(data, null, options.pretty ? 2 : 0);
}

/**
 * Export data as SQL statements.
 */
export async function exportAsSQL(
  adapter: StorageAdapter,
  options: DataExportOptions = {}
): Promise<string> {
  const data = await exportData(adapter, { ...options, includeSchema: true });
  const lines: string[] = [];

  lines.push('-- SQL Export from sql-storage-adapter');
  lines.push(`-- Generated at: ${data.exportedAt}`);
  lines.push('');

  const engine = data.dialect ?? 'sqlite';
  const schemas = new Map((data.schema ?? []).map((table) => [table.name, table]));

  // Export schema
  for (const table of options.includeSchema === false ? [] : schemas.values()) {
    lines.push(`-- Table: ${table.name}`);
    // The export inserts the ids it holds, so identity columns take them.
    const { sql, warnings } = createTableStatement(table, engine, engine, {
      rows: data.data[table.name] ?? [],
      identityByDefault: true,
    });
    for (const warning of warnings) lines.push(`-- ${warning}`);
    lines.push(`${sql};`);
    lines.push('');
  }

  // Export data
  for (const [tableName, rows] of Object.entries(data.data)) {
    const columns = schemas.get(tableName)?.columns ?? [];
    const generated = new Set(columns.filter((column) => column.generated).map((column) => column.name));

    const types = new Map(columns.map((column) => [column.name, column.type]));

    lines.push(`-- Data for table: ${tableName}`);
    for (const row of rows) {
      const values = Object.fromEntries(Object.entries(row as Record<string, unknown>).filter(([column]) => !generated.has(column)));
      lines.push(generateInsertSQL(tableName, values, engine, types));
    }
    if (engine === 'postgres' && rows.length > 0) {
      // Move each identity's sequence past the ids the inserts gave.
      for (const column of columns.filter((candidate) => candidate.autoIncrement)) {
        const table = quoteIdentifier(tableName);
        const literal = table.replace(/'/g, "''");
        lines.push(
          `${syncPostgresSequence(
            `pg_get_serial_sequence('${literal}', '${column.name.replace(/'/g, "''")}')`,
            `SELECT MAX(${quoteIdentifier(column.name)}) FROM ${table}`,
          )};`,
        );
      }
    }
    const sequence = schemas.get(tableName)?.sequence;
    if (engine === 'sqlite' && sequence !== undefined && /^\d+$/.test(sequence)) {
      const name = quoteText(tableName);
      lines.push(`UPDATE sqlite_sequence SET seq = MAX(seq, ${sequence}) WHERE name = ${name};`);
      lines.push(`INSERT INTO sqlite_sequence (name, seq) SELECT ${name}, ${sequence} WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = ${name});`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Export data as CSV (one file per table).
 */
export async function exportAsCSV(
  adapter: StorageAdapter,
  options: DataExportOptions = {}
): Promise<Record<string, string>> {
  const data = await exportData(adapter, options);
  const csvFiles: Record<string, string> = {};

  for (const [tableName, rows] of Object.entries(data.data)) {
    if (rows.length === 0) {
      csvFiles[tableName] = '';
      continue;
    }

    const firstRow = rows[0] as Record<string, unknown>;
    const headers = Object.keys(firstRow);

    const lines: string[] = [];
    lines.push(headers.map(escapeCSVValue).join(','));

    for (const row of rows) {
      const values = headers.map(header =>
        escapeCSVValue(String((row as Record<string, unknown>)[header] ?? ''))
      );
      lines.push(values.join(','));
    }

    csvFiles[tableName] = lines.join('\n');
  }

  return csvFiles;
}

/** The engine an adapter runs on. */
const engineOf = (adapter: StorageAdapter): Engine => createStorageFeatures(adapter).dialect.name;

/**
 * The tables to export: on SQLite those in sqlite_master, less the shadow
 * tables a virtual table keeps (FTS5's `_data`, `_idx`, ...), which the
 * virtual table recreates; on PostgreSQL those of the current schema.
 */
async function getTables(adapter: StorageAdapter, engine: Engine): Promise<string[]> {
  if (engine === 'postgres') {
    // The tables of the schema unqualified names are created in, which is the
    // segment on a segmented adapter and public otherwise.
    const rows = await adapter.all<{ name: string }>(
      `SELECT tablename AS name FROM pg_tables WHERE schemaname = current_schema() ORDER BY tablename`
    );
    return rows.map(r => r.name);
  }
  const rows = await adapter.all<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`
  );
  let shadow = new Set<string>();
  try {
    // PRAGMA table_list (SQLite 3.37 and later) marks shadow tables; an older
    // SQLite has no such list, and every table is exported.
    shadow = new Set(
      (await adapter.all<{ name: string }>(`SELECT name FROM pragma_table_list WHERE schema = 'main' AND type = 'shadow'`)).map(r => r.name)
    );
  } catch {
    shadow = new Set();
  }
  return rows.map(r => r.name).filter(name => !shadow.has(name));
}

/**
 * The schema of one table: its columns, primary key, the columns the engine
 * fills or generates, and on SQLite the CREATE TABLE statement it keeps.
 */
async function getTableSchema(adapter: StorageAdapter, table: string, engine: Engine): Promise<TableSchema> {
  try {
    return engine === 'postgres' ? await getPostgresTableSchema(adapter, table) : await getSqliteTableSchema(adapter, table);
  } catch {
    // Fallback: no schema info
    return {
      name: table,
      columns: [],
    };
  }
}

async function getSqliteTableSchema(adapter: StorageAdapter, table: string): Promise<TableSchema> {
  type Row = { name: string; type: string; not_null: number; default_value: string | null; pk: number; hidden?: number };
  let columns: Row[];
  try {
    // table_xinfo (SQLite 3.26 and later) lists generated and hidden columns too.
    columns = await adapter.all<Row>(
      'SELECT name, type, "notnull" AS not_null, dflt_value AS default_value, pk, hidden FROM pragma_table_xinfo(?)',
      [table]
    );
  } catch {
    columns = await adapter.all<Row>(
      'SELECT name, type, "notnull" AS not_null, dflt_value AS default_value, pk FROM pragma_table_info(?)',
      [table]
    );
  }
  const created = await adapter.get<{ sql: string | null; type: string }>(
    `SELECT sql, type FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?`,
    [table]
  );
  const sql = created?.type === 'view' ? undefined : created?.sql ?? undefined;
  // The table's options follow its closing parenthesis: `) WITHOUT ROWID`.
  const withoutRowid = sql ? /\bWITHOUT\s+ROWID\b/i.test(sql.slice(sql.lastIndexOf(')') + 1)) : false;
  // A virtual table's hidden columns (hidden = 1) are not part of its rows.
  const visible = columns.filter(column => Number(column.hidden ?? 0) !== 1);
  const primaryKeys = visible
    .filter(column => Number(column.pk) > 0)
    .sort((a, b) => Number(a.pk) - Number(b.pk))
    .map(column => column.name);

  const sequenceTable = sql && /\bAUTOINCREMENT\b/i.test(sql)
    ? await adapter.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'")
    : undefined;
  const sequence = sequenceTable
    ? await adapter.get<{ seq: string }>('SELECT CAST(seq AS TEXT) AS seq FROM sqlite_sequence WHERE name = ?', [table])
    : undefined;

  return {
    name: table,
    columns: visible.map(column => {
      // A single-column INTEGER PRIMARY KEY is the rowid, which SQLite fills
      // (https://www.sqlite.org/lang_createtable.html#rowid).
      const rowid = !withoutRowid && primaryKeys.length === 1 && Number(column.pk) === 1 && column.type.trim().toUpperCase() === 'INTEGER';
      const hidden = Number(column.hidden ?? 0);
      return {
        name: column.name,
        type: column.type,
        nullable: Number(column.not_null) === 0,
        defaultValue: column.default_value ?? undefined,
        ...(rowid ? { autoIncrement: true } : {}),
        ...(hidden === 2 || hidden === 3 ? { generated: true } : {}),
      };
    }),
    ...(primaryKeys.length > 0 ? { primaryKeys } : {}),
    ...(sql ? { sql } : {}),
    ...(created?.type === 'view' ? { view: true } : {}),
    ...(sequence ? { sequence: sequence.seq } : {}),
  };
}

async function getPostgresTableSchema(adapter: StorageAdapter, table: string): Promise<TableSchema> {
  // The columns of the table in the current schema alone, in their order.
  const columns = await adapter.all<{
    name: string;
    type: string;
    not_null: boolean;
    default_value: string | null;
    identity: string;
    generated: string;
    relation_kind: string;
  }>(
    `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null,
            pg_get_expr(d.adbin, d.adrelid) AS default_value, a.attidentity AS identity, a.attgenerated AS generated, c.relkind AS relation_kind
     FROM pg_attribute a
     JOIN pg_class c ON c.oid = a.attrelid
     LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE a.attrelid = to_regclass(quote_ident(current_schema()) || '.' || quote_ident(?))
       AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY a.attnum`,
    [table]
  );
  const primaryKeys = (
    await adapter.all<{ name: string }>(
      `SELECT a.attname AS name
       FROM pg_index i
       CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, position)
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
       WHERE i.indisprimary
         AND i.indrelid = to_regclass(quote_ident(current_schema()) || '.' || quote_ident(?))
         AND k.position <= i.indnkeyatts
       ORDER BY k.position`,
      [table]
    )
  ).map(row => row.name);

  return {
    name: table,
    ...(columns[0]?.relation_kind === 'v' ? { view: true } : {}),
    columns: columns.map((column): ColumnInfo => {
      const generated = column.generated === 's' || column.generated === 'v';
      const identity = column.identity === 'a' ? 'always' : column.identity === 'd' ? 'by default' : undefined;
      const fromSequence = column.default_value !== null && /^\s*nextval\s*\(/i.test(column.default_value);
      return {
        name: column.name,
        type: column.type,
        nullable: !column.not_null,
        defaultValue: generated ? undefined : column.default_value ?? undefined,
        ...(identity || fromSequence ? { autoIncrement: true } : {}),
        ...(identity ? { identity } : {}),
        ...(generated ? { generated: true, generationKind: column.generated === 'v' ? 'virtual' : 'stored', generationExpression: column.default_value ?? undefined } : {}),
      };
    }),
    ...(primaryKeys.length > 0 ? { primaryKeys } : {}),
  };
}

/**
 * Generate INSERT SQL for a row.
 */
function generateInsertSQL(table: string, row: Record<string, unknown>, engine: Engine, types: Map<string, string>): string {
  const columns = Object.keys(row);
  const values = columns.map(col => escapeSQLValue(row[col], engine, types.get(col)));

  return `INSERT INTO ${escapeIdentifier(table)} (${columns.map(escapeIdentifier).join(', ')})${engine === 'postgres' ? ' OVERRIDING SYSTEM VALUE' : ''} VALUES (${values.join(', ')});`;
}

/**
 * Escape SQL identifier (table/column name).
 */
function escapeIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

const quoteText = (text: string): string => `'${text.replace(/'/g, "''")}'`;

/** A PostgreSQL array literal's text (`{"a","b"}`), for a column of an array type. */
const postgresArrayText = (items: unknown[]): string =>
  `{${items
    .map(item => {
      if (item === null || item === undefined) return 'NULL';
      if (Array.isArray(item)) return postgresArrayText(item);
      const text = item instanceof Date ? item.toISOString() : typeof item === 'object' ? JSON.stringify(item) : String(item);
      return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    })
    .join(',')}}`;

/**
 * Escape SQL value for INSERT statement, as the engine reads it back: bytes as
 * a blob or bytea literal, booleans as 1 and 0 on SQLite, arrays as an array
 * literal in a PostgreSQL array column, and other objects as JSON text.
 */
function escapeSQLValue(value: unknown, engine: Engine, columnType?: string): string {
  if (value === null || value === undefined) return 'NULL';
  if (engine === 'postgres' && (columnType === 'json' || columnType === 'jsonb')) return quoteText(JSON.stringify(value));
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : quoteText(String(value));
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') return engine === 'postgres' ? (value ? 'TRUE' : 'FALSE') : value ? '1' : '0';
  if (value instanceof Date) return quoteText(value.toISOString());
  if (value instanceof Uint8Array) {
    const hex = Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('');
    // bytea's hex input format (https://www.postgresql.org/docs/current/datatype-binary.html); SQLite's blob literal.
    return engine === 'postgres' ? `'\\x${hex}'` : `X'${hex}'`;
  }
  if (Array.isArray(value) && engine === 'postgres' && columnType?.endsWith('[]')) return quoteText(postgresArrayText(value));
  if (typeof value === 'object') return quoteText(JSON.stringify(value));
  return quoteText(String(value));
}

/**
 * Escape CSV value.
 */
function escapeCSVValue(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
