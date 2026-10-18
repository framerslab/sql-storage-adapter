/**
 * Data import utilities for cross-adapter migration and restoration.
 * Supports importing from JSON, SQL dumps, and CSV files.
 */

import { syncPostgresSequence } from '../../shared/identitySequence';
import type { StorageAdapter } from '../../core/contracts';
import { createStorageFeatures } from '../../core/contracts/features';
import { splitSqlStatements } from '../../shared/splitSqlStatements';
import type { ExportedData } from './dataExport';
import { createTableStatement, quoteIdentifier, type Engine } from './tableDefinition';

/**
 * Options for data import.
 */
export interface DataImportOptions {
  /** Drop existing tables before import */
  dropTables?: boolean;
  /** Skip schema creation (data only) */
  skipSchema?: boolean;
  /** Skip data import (schema only) */
  skipData?: boolean;
  /** Batch size for inserts */
  batchSize?: number;
  /** Tables to import (all if not specified) */
  tables?: string[];
  /** On conflict strategy */
  onConflict?: 'replace' | 'ignore' | 'error';
  /**
   * The engine the data came from, for an export that does not say
   * (`ExportedData.dialect` is newer than some exports). Without either, the
   * schema's types and defaults are read as the target engine's.
   */
  sourceDialect?: 'sqlite' | 'postgres';
  /** Column types to create as given, by `table.column`: `{ 'events.at_ms': 'BIGINT' }`. */
  columnTypes?: Record<string, string>;
}

/**
 * Import result with statistics.
 */
export interface ImportResult {
  success: boolean;
  tablesImported: number;
  /** Rows written: inserted, or replaced; a row `onConflict: 'ignore'` skipped is not counted. */
  rowsImported: number;
  errors?: string[];
  /** What the target table could not carry over: a default the target engine has no form of, a generated column made plain. */
  warnings?: string[];
  duration: number;
}

/**
 * Import data from exported JSON format.
 */
export async function importData(
  adapter: StorageAdapter,
  data: ExportedData,
  options: DataImportOptions = {}
): Promise<ImportResult> {
  const startTime = Date.now();
  const {
    dropTables = false,
    skipSchema = false,
    skipData = false,
    batchSize = 100,
    tables,
    onConflict = 'error',
  } = options;

  const errors: string[] = [];
  const warnings: string[] = [];
  let tablesImported = 0;
  let rowsImported = 0;
  const target = engineOf(adapter);
  const source: Engine = data.dialect ?? options.sourceDialect ?? target;

  // Determine tables to import from both schema and data
  let tablesToImport: string[];
  if (tables) {
    tablesToImport = tables;
  } else {
    const dataTables = Object.keys(data.data);
    const schemaTables = data.schema?.map(s => s.name) || [];
    tablesToImport = Array.from(new Set([...dataTables, ...schemaTables]));
  }

  let foreignKeys: number | undefined;
  try {
    if (target === 'sqlite') {
      foreignKeys = (await adapter.get<{ foreign_keys: number }>('PRAGMA foreign_keys'))?.foreign_keys;
      if (foreignKeys === 1) {
        await adapter.exec('PRAGMA foreign_keys = OFF');
        if ((await adapter.get<{ foreign_keys: number }>('PRAGMA foreign_keys'))?.foreign_keys === 1) {
          throw new Error('Cannot suspend foreign keys inside an active SQLite transaction');
        }
      }
    }
    // Import schema
    if (!skipSchema && data.schema) {
      for (const tableSchema of data.schema) {
        if (!tablesToImport.includes(tableSchema.name)) continue;

        try {
          if (dropTables) {
            await adapter.run(`DROP TABLE IF EXISTS ${escapeIdentifier(tableSchema.name)}`);
          }
          const statement = createTableStatement(tableSchema, source, target, {
            rows: data.data[tableSchema.name] ?? [],
            columnTypes: options.columnTypes,
          });
          await adapter.run(statement.sql);
          warnings.push(...statement.warnings);
          // Only count if we're not also importing data (to avoid double counting)
          if (skipData) {
            tablesImported++;
          }
        } catch (error) {
          const errorMsg = `Schema error for ${tableSchema.name}: ${(error as Error).message}`;
          errors.push(errorMsg);
          // If we're in error mode, fail fast
          if (onConflict === 'error') {
            return {
              success: false,
              tablesImported,
              rowsImported,
              errors,
              ...(warnings.length > 0 ? { warnings } : {}),
              duration: Date.now() - startTime,
            };
          }
        }
      }
    }

    // Import data
    if (!skipData) {
      for (const [tableName, rows] of Object.entries(data.data)) {
        if (!tablesToImport.includes(tableName)) continue;
        if (!Array.isArray(rows) || rows.length === 0) continue;

        try {
          const imported = await importTableData(adapter, tableName, rows, {
            batchSize,
            onConflict,
            sourceDialect: source,
          });
          rowsImported += imported;
          tablesImported++;
        } catch (error) {
          errors.push(`Data error for ${tableName}: ${(error as Error).message}`);
        }
      }
    }

    if (target === 'sqlite' && !skipData) {
      for (const schema of data.schema ?? []) {
        if (!tablesToImport.includes(schema.name) || schema.sequence === undefined) continue;
        if (!/^\d+$/.test(schema.sequence)) throw new Error(`Invalid sequence for ${schema.name}`);
        const created = await adapter.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", [schema.name]);
        if (!/\bAUTOINCREMENT\b/i.test(created?.sql ?? '')) continue;
        await adapter.run('UPDATE sqlite_sequence SET seq = MAX(seq, CAST(? AS INTEGER)) WHERE name = ?', [schema.sequence, schema.name]);
        await adapter.run(
          'INSERT INTO sqlite_sequence (name, seq) SELECT ?, CAST(? AS INTEGER) WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = ?)',
          [schema.name, schema.sequence, schema.name],
        );
      }
    }

    if (target === 'sqlite') {
      const violations = await adapter.all<{ table: string; rowid: number | null }>('PRAGMA foreign_key_check');
      for (const violation of violations) errors.push(`Foreign key violation in ${violation.table}, row ${violation.rowid}`);
    }

    return {
      success: errors.length === 0,
      tablesImported,
      rowsImported,
      errors: errors.length > 0 ? errors : undefined,
      ...(warnings.length > 0 ? { warnings } : {}),
      duration: Date.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      tablesImported,
      rowsImported,
      errors: [...errors, `Fatal error: ${(error as Error).message}`],
      ...(warnings.length > 0 ? { warnings } : {}),
      duration: Date.now() - startTime,
    };
  } finally {
    if (foreignKeys === 1) await adapter.exec('PRAGMA foreign_keys = ON');
  }
}

/**
 * Import data from JSON string.
 */
export async function importFromJSON(
  adapter: StorageAdapter,
  jsonString: string,
  options: DataImportOptions = {}
): Promise<ImportResult> {
  try {
    const data = JSON.parse(jsonString) as ExportedData;
    return await importData(adapter, data, options);
  } catch (error) {
    return {
      success: false,
      tablesImported: 0,
      rowsImported: 0,
      errors: [`JSON parse error: ${(error as Error).message}`],
      duration: 0,
    };
  }
}

/**
 * Import data from SQL dump.
 */
export async function importFromSQL(
  adapter: StorageAdapter,
  sqlDump: string,
  options: DataImportOptions = {}
): Promise<ImportResult> {
  const startTime = Date.now();
  const errors: string[] = [];
  let statementsExecuted = 0;

  try {
    // Comment- and string-aware split so semicolons inside `--`, `/* */`,
    // quoted strings, or dollar-quoted bodies do not slice statements.
    const statements = splitSqlStatements(sqlDump);

    for (const statement of statements) {
      try {
        // Skip if filtering by tables
        if (options.tables) {
          const matchesTable = options.tables.some(table =>
            statement.toLowerCase().includes(table.toLowerCase())
          );
          if (!matchesTable) continue;
        }

        // Execute the statement
        await adapter.run(statement);
        statementsExecuted++;
      } catch (error) {
        errors.push(`SQL error in statement: ${(error as Error).message}`);
      }
    }

    return {
      success: errors.length === 0,
      tablesImported: statementsExecuted,
      rowsImported: 0, // Cannot accurately count from SQL
      errors: errors.length > 0 ? errors : undefined,
      duration: Date.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      tablesImported: 0,
      rowsImported: 0,
      errors: [...errors, `Fatal error: ${(error as Error).message}`],
      duration: Date.now() - startTime,
    };
  }
}

/**
 * Import data from CSV.
 */
export async function importFromCSV(
  adapter: StorageAdapter,
  tableName: string,
  csvContent: string,
  options: DataImportOptions = {}
): Promise<ImportResult> {
  const startTime = Date.now();

  try {
    const rows = parseCSV(csvContent);
    if (rows.length === 0) {
      return {
        success: true,
        tablesImported: 0,
        rowsImported: 0,
        duration: Date.now() - startTime,
      };
    }

    const imported = await importTableData(adapter, tableName, rows, {
      batchSize: options.batchSize || 100,
      onConflict: options.onConflict || 'error',
    });

    return {
      success: true,
      tablesImported: 1,
      rowsImported: imported,
      duration: Date.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      tablesImported: 0,
      rowsImported: 0,
      errors: [`CSV import error: ${(error as Error).message}`],
      duration: Date.now() - startTime,
    };
  }
}

/**
 * Migrate data from one adapter to another, on the same engine or between
 * SQLite and PostgreSQL. The target tables get the target engine's types, the
 * defaults it has a form of, NOT NULL and the primary key; a column the source
 * engine fills becomes an identity column on PostgreSQL (its sequence moved
 * past the copied ids) or an INTEGER PRIMARY KEY AUTOINCREMENT on SQLite.
 * SQLite to SQLite recreates each table from the statement SQLite keeps for it.
 */
export async function migrateAdapter(
  sourceAdapter: StorageAdapter,
  targetAdapter: StorageAdapter,
  options: DataImportOptions = {}
): Promise<ImportResult> {
  const { exportData } = await import('./dataExport.js');

  // Export from source
  const exportedData = await exportData(sourceAdapter, {
    tables: options.tables,
    includeSchema: true,
  });

  // Import to target
  return await importData(targetAdapter, exportedData, options);
}

/** The engine an adapter runs on. */
const engineOf = (adapter: StorageAdapter): Engine => createStorageFeatures(adapter).dialect.name;

/** What an insert needs to know of the target table. */
interface TargetTable {
  /** The table's name as the target holds it. */
  name: string;
  /** Column names by lower-cased name, as the target holds them. */
  columns: Map<string, string>;
  /** Generated columns, which take no value. */
  generated: Set<string>;
  /** PostgreSQL: identity columns GENERATED ALWAYS, which take a value only with OVERRIDING SYSTEM VALUE. */
  always: Set<string>;
  /** PostgreSQL: the sequence of each identity or serial column. */
  sequences: Map<string, string>;
  /** PostgreSQL: columns of type timestamp with time zone. */
  zoned: Set<string>;
  /** PostgreSQL: JSON columns, whose parsed source values need JSON encoding. */
  json: Set<string>;
  /** PostgreSQL: the primary key's columns, for onConflict 'replace'. */
  primaryKey: string[];
}

async function readTargetTable(adapter: StorageAdapter, table: string, engine: Engine): Promise<TargetTable> {
  const target: TargetTable = {
    name: table,
    columns: new Map(),
    generated: new Set(),
    always: new Set(),
    sequences: new Map(),
    zoned: new Set(),
    json: new Set(),
    primaryKey: [],
  };
  if (engine === 'sqlite') {
    let columns: Array<{ name: string; hidden?: number }>;
    try {
      columns = await adapter.all('SELECT name, hidden FROM pragma_table_xinfo(?)', [table]);
    } catch {
      // SQLite before 3.26 has no table_xinfo, and no generated columns.
      columns = await adapter.all('SELECT name FROM pragma_table_info(?)', [table]);
    }
    for (const column of columns) {
      target.columns.set(column.name.toLowerCase(), column.name);
      const hidden = Number(column.hidden ?? 0);
      if (hidden === 2 || hidden === 3) target.generated.add(column.name);
    }
    return target;
  }

  type Column = { name: string; type: string; identity: string; generated: string; sequence: string | null };
  const read = (name: string) =>
    adapter.all<Column>(
      `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attidentity AS identity,
              a.attgenerated AS generated,
              pg_get_serial_sequence(quote_ident(current_schema()) || '.' || quote_ident(?), a.attname) AS sequence
       FROM pg_attribute a
       WHERE a.attrelid = to_regclass(quote_ident(current_schema()) || '.' || quote_ident(?))
         AND a.attnum > 0 AND NOT a.attisdropped`,
      [name, name]
    );
  let columns = await read(table);
  if (columns.length === 0 && table !== table.toLowerCase()) {
    // A table the target created without quotes holds its name in lower case.
    const folded = await read(table.toLowerCase());
    if (folded.length > 0) {
      target.name = table.toLowerCase();
      columns = folded;
    }
  }
  for (const column of columns) {
    target.columns.set(column.name.toLowerCase(), column.name);
    if (column.generated === 's' || column.generated === 'v') target.generated.add(column.name);
    if (column.type === 'json' || column.type === 'jsonb') target.json.add(column.name);
    if (column.identity === 'a') target.always.add(column.name);
    if (column.sequence) target.sequences.set(column.name, column.sequence);
    if (/^timestamp(\(\d+\))? with time zone$/.test(column.type)) target.zoned.add(column.name);
  }
  target.primaryKey = (
    await adapter.all<{ name: string }>(
      `SELECT a.attname AS name
       FROM pg_index i
       CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, position)
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
       WHERE i.indisprimary
         AND i.indrelid = to_regclass(quote_ident(current_schema()) || '.' || quote_ident(?))
         AND k.position <= i.indnkeyatts
       ORDER BY k.position`,
      [target.name]
    )
  ).map(row => row.name);
  return target;
}

const ZONELESS = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?))?$/;

/**
 * A value for a PostgreSQL timestamp with time zone column. Text without a
 * zone is read as UTC, as SQLite writes it (CURRENT_TIMESTAMP, datetime()),
 * where PostgreSQL would read it in the session's TimeZone
 * (https://www.postgresql.org/docs/current/datatype-datetime.html).
 */
const zonedValue = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  const match = ZONELESS.exec(value.trim());
  if (!match) return value;
  return `${match[1]}T${match[2] ?? '00:00:00'}Z`;
};

/**
 * Import rows into a table.
 */
async function importTableData(
  adapter: StorageAdapter,
  tableName: string,
  rows: unknown[],
  options: { batchSize: number; onConflict: 'replace' | 'ignore' | 'error'; sourceDialect?: Engine }
): Promise<number> {
  let imported = 0;
  const { batchSize, onConflict } = options;
  const engine = engineOf(adapter);
  const target = await readTargetTable(adapter, tableName, engine);
  const table = quoteIdentifier(target.name);
  const exact = new Set(target.columns.values());
  /** The target's name for a source column: as given, else matched without case. */
  const targetColumn = (column: string): string => (exact.has(column) ? column : target.columns.get(column.toLowerCase()) ?? column);

  if (engine === 'postgres' && onConflict === 'replace' && target.primaryKey.length === 0) {
    throw new Error(`onConflict 'replace' on PostgreSQL needs a primary key on ${target.name}`);
  }

  const sequenced = new Set<string>();

  // Process in batches
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);

    for (const row of batch) {
      const record = row as Record<string, unknown>;
      const entries = Object.keys(record)
        .map(column => [targetColumn(column), record[column]] as const)
        .filter(([column]) => !target.generated.has(column));
      const columns = entries.map(([column]) => column);
      const values = entries.map(([column, value]) => {
        if (target.json.has(column) && options.sourceDialect === 'postgres' && value !== null && value !== undefined) {
          return JSON.stringify(value);
        }
        return target.zoned.has(column) ? zonedValue(value) : value;
      });
      const placeholders = columns.map(() => '?');
      const list = columns.map(quoteIdentifier).join(', ');

      let insertSQL: string;
      if (engine === 'postgres') {
        const overriding = columns.some(column => target.always.has(column)) ? ' OVERRIDING SYSTEM VALUE' : '';
        insertSQL = `INSERT INTO ${table} (${list})${overriding} VALUES (${placeholders.join(', ')})`;
        if (onConflict === 'ignore') {
          insertSQL += ' ON CONFLICT DO NOTHING';
        } else if (onConflict === 'replace') {
          const updates = columns.filter(column => !target.primaryKey.includes(column) && !target.always.has(column));
          insertSQL +=
            ` ON CONFLICT (${target.primaryKey.map(quoteIdentifier).join(', ')}) ` +
            (updates.length > 0
              ? `DO UPDATE SET ${updates.map(column => `${quoteIdentifier(column)} = EXCLUDED.${quoteIdentifier(column)}`).join(', ')}`
              : 'DO NOTHING');
        }
      } else {
        // SQLite's conflict clauses
        const verb = onConflict === 'replace' ? 'INSERT OR REPLACE' : onConflict === 'ignore' ? 'INSERT OR IGNORE' : 'INSERT';
        insertSQL = `${verb} INTO ${table} (${list}) VALUES (${placeholders.join(', ')})`;
      }

      const result = await adapter.run(insertSQL, values);
      if ((result.changes ?? 1) > 0) {
        imported++;
        for (const column of columns) if (target.sequences.has(column)) sequenced.add(column);
      }
    }
  }

  // An identity or serial column that took ids keeps generating past them
  // (https://www.postgresql.org/docs/current/functions-sequence.html).
  for (const column of sequenced) {
    await adapter.get(
      syncPostgresSequence('CAST(? AS regclass)', `SELECT MAX(${quoteIdentifier(column)}) FROM ${table}`),
      [target.sequences.get(column), target.sequences.get(column), target.sequences.get(column)]
    );
  }

  return imported;
}

/**
 * Parse CSV content into rows.
 */
function parseCSV(content: string): Array<Record<string, unknown>> {
  const lines = content.split('\n').filter(line => line.trim().length > 0);
  if (lines.length === 0) return [];

  const headers = parseCSVLine(lines[0]);
  const rows: Array<Record<string, unknown>> = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    const row: Record<string, unknown> = {};

    headers.forEach((header, idx) => {
      row[header] = values[idx] ?? null;
    });

    rows.push(row);
  }

  return rows;
}

/**
 * Parse a single CSV line.
 */
function parseCSVLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      values.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  values.push(current);
  return values;
}

/**
 * Escape SQL identifier.
 */
function escapeIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}
