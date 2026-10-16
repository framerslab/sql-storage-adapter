/**
 * Data export utilities for cross-adapter migration and backup.
 * Supports exporting data to portable formats (JSON, SQL, CSV).
 */

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
    const order =
      keys.length > 0 ? ` ORDER BY ${keys.map(escapeIdentifier).join(', ')}` : engine === 'postgres' ? ' ORDER BY ctid' : ' ORDER BY rowid';

    // Fetch data in batches
    do {
      batch = await adapter.all(
        `SELECT * FROM ${escapeIdentifier(table)}${order} LIMIT ${batchSize} OFFSET ${offset}`
      );
      rows.push(...batch);
      offset += batchSize;
    } while (batch.length === batchSize);

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
  const data = await exportData(adapter, options);
  const lines: string[] = [];

  lines.push('-- SQL Export from sql-storage-adapter');
  lines.push(`-- Generated at: ${data.exportedAt}`);
  lines.push('');

  const engine = data.dialect ?? 'sqlite';
  const schemas = new Map((data.schema ?? []).map((table) => [table.name, table]));

  // Export schema
  for (const table of schemas.values()) {
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
    if (rows.length === 0) continue;
    const columns = schemas.get(tableName)?.columns ?? [];
    const generated = new Set(columns.filter((column) => column.generated).map((column) => column.name));

    lines.push(`-- Data for table: ${tableName}`);
    for (const row of rows) {
      const values = Object.fromEntries(Object.entries(row as Record<string, unknown>).filter(([column]) => !generated.has(column)));
      lines.push(generateInsertSQL(tableName, values));
    }
    if (engine === 'postgres') {
      // Move each identity's sequence past the ids the inserts gave.
      for (const column of columns.filter((candidate) => candidate.autoIncrement)) {
        const table = quoteIdentifier(tableName);
        const literal = table.replace(/'/g, "''");
        lines.push(
          `SELECT setval(pg_get_serial_sequence('${literal}', '${column.name.replace(/'/g, "''")}'), GREATEST(COALESCE(MAX(${quoteIdentifier(column.name)}), 0), 0) + 1, false) FROM ${table};`,
        );
      }
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
  const created = await adapter.get<{ sql: string | null }>(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`,
    [table]
  );
  const sql = created?.sql ?? undefined;
  // The table's options follow its closing parenthesis: `) WITHOUT ROWID`.
  const withoutRowid = sql ? /\bWITHOUT\s+ROWID\b/i.test(sql.slice(sql.lastIndexOf(')') + 1)) : false;
  // A virtual table's hidden columns (hidden = 1) are not part of its rows.
  const visible = columns.filter(column => Number(column.hidden ?? 0) !== 1);
  const primaryKeys = visible
    .filter(column => Number(column.pk) > 0)
    .sort((a, b) => Number(a.pk) - Number(b.pk))
    .map(column => column.name);

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
  }>(
    `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null,
            pg_get_expr(d.adbin, d.adrelid) AS default_value, a.attidentity AS identity, a.attgenerated AS generated
     FROM pg_attribute a
     LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE a.attrelid = to_regclass(quote_ident(current_schema()) || '.' || quote_ident(?))
       AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY a.attnum`,
    [table]
  );
  const primaryKeys = (
    await adapter.all<{ name: string }>(
      `SELECT kcu.column_name AS name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_schema = tc.constraint_schema AND kcu.constraint_name = tc.constraint_name
       WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = current_schema() AND tc.table_name = ?
       ORDER BY kcu.ordinal_position`,
      [table]
    )
  ).map(row => row.name);

  return {
    name: table,
    columns: columns.map((column): ColumnInfo => {
      const generated = column.generated === 's';
      const identity = column.identity === 'a' ? 'always' : column.identity === 'd' ? 'by default' : undefined;
      const fromSequence = column.default_value !== null && /^\s*nextval\s*\(/i.test(column.default_value);
      return {
        name: column.name,
        type: column.type,
        nullable: !column.not_null,
        defaultValue: generated ? undefined : column.default_value ?? undefined,
        ...(identity || fromSequence ? { autoIncrement: true } : {}),
        ...(identity ? { identity } : {}),
        ...(generated ? { generated: true, generationExpression: column.default_value ?? undefined } : {}),
      };
    }),
    ...(primaryKeys.length > 0 ? { primaryKeys } : {}),
  };
}

/**
 * Generate INSERT SQL for a row.
 */
function generateInsertSQL(table: string, row: Record<string, unknown>): string {
  const columns = Object.keys(row);
  const values = columns.map(col => escapeSQLValue(row[col]));

  return `INSERT INTO ${escapeIdentifier(table)} (${columns.map(escapeIdentifier).join(', ')}) VALUES (${values.join(', ')});`;
}

/**
 * Escape SQL identifier (table/column name).
 */
function escapeIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

/**
 * Escape SQL value for INSERT statement.
 */
function escapeSQLValue(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (value instanceof Date) return `'${value.toISOString()}'`;
  return `'${String(value).replace(/'/g, "''")}'`;
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
