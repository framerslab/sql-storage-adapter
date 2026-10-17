import type { StorageAdapter } from '../../core/contracts';
import { createStorageFeatures } from '../../core/contracts/features';

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

const checkIdentifier = (what: string, value: string): string => {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    throw new Error(`The ${what} must be an SQL identifier (letters, digits and underscores); got ${JSON.stringify(value)}.`);
  }
  return value;
};

/**
 * Adds `column` to `table` with `definition` (its type and constraints, as
 * SQL: `TEXT NOT NULL DEFAULT 'none'`) when the table lacks it, on PostgreSQL
 * or SQLite. Resolves true when it added the column and false when the table
 * had it. The table may be schema-qualified on PostgreSQL (`app.notes`).
 *
 * @example
 * ```typescript
 * await ensureColumnExists(db, 'notes', 'archived_at', d.columnType('timestamp'));
 * ```
 */
export async function ensureColumnExists(db: StorageAdapter, table: string, column: string, definition: string): Promise<boolean> {
  const dialect = createStorageFeatures(db).dialect.name;
  const parts = typeof table === 'string' ? table.split('.') : [table];
  const schema = dialect === 'postgres' && parts.length === 2 ? checkIdentifier('schema', parts[0]) : null;
  const name = checkIdentifier('table name', schema ? parts[1] : table);
  checkIdentifier('column name', column);

  if (dialect === 'postgres') {
    const found = await db.get(
      `SELECT 1 AS found FROM information_schema.columns
       WHERE table_schema = COALESCE(?, current_schema()) AND table_name = lower(?) AND column_name = lower(?)`,
      [schema ? schema.toLowerCase() : null, name, column],
    );
    if (found) return false;
    await db.exec(`ALTER TABLE ${schema ? `${schema}.` : ''}${name} ADD COLUMN IF NOT EXISTS ${column} ${definition}`);
    return true;
  }

  const columns = await db.all<{ name: string }>('SELECT name FROM pragma_table_info(?)', [name]);
  if (columns.some((existing) => existing.name.toLowerCase() === column.toLowerCase())) return false;
  await db.exec(`ALTER TABLE ${name} ADD COLUMN ${column} ${definition}`);
  return true;
}
