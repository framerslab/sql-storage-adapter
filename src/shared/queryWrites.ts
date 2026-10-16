import { leadingKeyword, skipLeadingComments } from './leadingKeyword';

/**
 * Whether a statement run through `all()` or `get()` can change a database
 * that an adapter saves as one image (sql.js with a file, IndexedDB):
 *
 * - `'no'`: `SELECT`, `VALUES` and `EXPLAIN` only read.
 * - `'if-rows-changed'`: a `WITH` statement leads a read or a write, and a
 *   `PRAGMA` that sets no value reads a setting or a table's columns. SQLite's
 *   count of changed rows decides.
 * - `'yes'`: any other statement. `INSERT`, `UPDATE`, `DELETE` and `REPLACE`
 *   with `RETURNING`, a schema change, and a `PRAGMA` that sets a value
 *   (`PRAGMA user_version = 3`, `PRAGMA application_id(42)`), which can change
 *   the file's header without changing a row.
 */
export type QueryWrite = 'no' | 'if-rows-changed' | 'yes';

/** The PRAGMA statements that take an argument to read with it: `PRAGMA table_info(items)`. */
const READ_WITH_ARGUMENT = new Set([
  'foreign_key_check',
  'foreign_key_list',
  'index_info',
  'index_list',
  'index_xinfo',
  'integrity_check',
  'quick_check',
  'table_info',
  'table_list',
  'table_xinfo',
]);

/** An SQL name: plain, or quoted with "", `` or []. */
const NAME = '(?:"(?:[^"]|"")*"|`(?:[^`]|``)*`|\\[[^\\]]*\\]|[A-Za-z_][A-Za-z0-9_$]*)';

/** `PRAGMA [schema.]name`, and the `=` or `(` that follows when it sets a value. */
const PRAGMA_HEAD = new RegExp(`^PRAGMA\\s+(?:${NAME}\\s*\\.\\s*)?(${NAME})\\s*(=|\\()?`, 'i');

const unquote = (name: string): string => {
  const first = name[0];
  if (first === '"' || first === '`') return name.slice(1, -1).split(first + first).join(first);
  if (first === '[') return name.slice(1, -1);
  return name;
};

/** Whether a PRAGMA statement sets a value: `= value`, or `(value)` on a PRAGMA that does not read with it. */
const pragmaSetsValue = (statement: string): boolean => {
  const match = PRAGMA_HEAD.exec(skipLeadingComments(statement));
  if (!match || match[2] === undefined) return false;
  return match[2] === '=' || !READ_WITH_ARGUMENT.has(unquote(match[1]).toLowerCase());
};

/**
 * How a statement run through `all()` or `get()` can change the database. See
 * {@link QueryWrite}. It reads the statement's first keyword and, for a
 * PRAGMA, its name and whether a value follows; it does not parse SQL beyond
 * that.
 *
 * @param statement - One SQL statement.
 */
export const queryWrites = (statement: string): QueryWrite => {
  const keyword = leadingKeyword(statement);
  if (keyword === 'SELECT' || keyword === 'VALUES' || keyword === 'EXPLAIN') return 'no';
  if (keyword === 'WITH') return 'if-rows-changed';
  if (keyword === 'PRAGMA') return pragmaSetsValue(statement) ? 'yes' : 'if-rows-changed';
  return 'yes';
};
