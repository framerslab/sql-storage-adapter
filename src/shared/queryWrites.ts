/**
 * Whether a statement run through `all()` or `get()` can change a database an
 * adapter saves as one image: sql.js with a file, and IndexedDB. Both adapters
 * read this one classifier, so a statement is saved by the same rule on each.
 * It reads a statement's first keyword and, for a PRAGMA, its name and whether
 * a value follows, as SQLite's tokenizer reads them; it does not parse SQL
 * beyond that.
 */

/** A statement past its leading comments and whitespace. */
const pastLeadingComments = (statement: string): string =>
  statement.replace(/^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/, '');

/**
 * The first keyword of a statement, upper-cased, past its leading comments and
 * whitespace: `SELECT`, `INSERT`, `WITH`, `PRAGMA` and so on. An empty string
 * when the statement holds none.
 *
 * @param statement - One SQL statement.
 */
export const firstKeyword = (statement: string): string =>
  (/^[A-Za-z]+/.exec(pastLeadingComments(statement))?.[0] ?? '').toUpperCase();

/**
 * PRAGMAs whose assignment changes the database image: the header's
 * user_version, application_id and schema_version, and the settings a new
 * database or a VACUUM writes (page_size, auto_vacuum, encoding). SQLite's
 * change counter, `total_changes()`, counts none of them.
 */
const IMAGE_PRAGMAS_WHEN_SET = new Set(['user_version', 'application_id', 'schema_version', 'page_size', 'auto_vacuum', 'encoding']);

/** PRAGMAs that change the image in any form: incremental_vacuum frees pages, optimize may run ANALYZE. */
const IMAGE_PRAGMAS_ALWAYS = new Set(['incremental_vacuum', 'optimize']);

/** A token of a statement's head: a name, bare or quoted (a string in single quotes included), or one character of punctuation. */
interface HeadToken {
  text: string;
  name: boolean;
}

/** The characters a bare name of SQLite's goes on with. */
const NAME_PART = /[A-Za-z0-9_$]/;

/**
 * The first `count` tokens of a statement as SQLite's tokenizer reads them: a
 * comment (`-- ...` to the end of its line, `/* ... *\/`) or whitespace
 * separates two tokens and is no token itself, and a quoted name (in double
 * quotes, brackets or backticks) needs no space before it. A string in single
 * quotes is read as a name as well: SQLite's grammar takes one for a name where
 * a PRAGMA's schema or name goes (parse.y, `nm ::= STRING`), and its tokenizer
 * ends it as it ends a quoted name, at a quote not written twice (tokenize.c,
 * `CC_QUOTE`).
 */
const headTokens = (statement: string, count: number): HeadToken[] => {
  const tokens: HeadToken[] = [];
  let at = 0;
  while (at < statement.length && tokens.length < count) {
    const char = statement[at];
    if (/\s/.test(char)) {
      at += 1;
    } else if (statement.startsWith('--', at)) {
      const end = statement.indexOf('\n', at + 2);
      at = end < 0 ? statement.length : end + 1;
    } else if (statement.startsWith('/*', at)) {
      const end = statement.indexOf('*/', at + 2);
      at = end < 0 ? statement.length : end + 2;
    } else if (char === '"' || char === '`' || char === "'") {
      // A quote character inside the name is written twice.
      let text = '';
      let end = at + 1;
      while (end < statement.length) {
        if (statement[end] === char) {
          if (statement[end + 1] !== char) break;
          end += 1;
        }
        text += statement[end];
        end += 1;
      }
      tokens.push({ text, name: true });
      at = end + 1;
    } else if (char === '[') {
      const end = statement.indexOf(']', at + 1);
      tokens.push({ text: statement.slice(at + 1, end < 0 ? statement.length : end), name: true });
      at = end < 0 ? statement.length : end + 1;
    } else if (/[A-Za-z_]/.test(char)) {
      let end = at + 1;
      while (end < statement.length && NAME_PART.test(statement[end])) end += 1;
      tokens.push({ text: statement.slice(at, end), name: true });
      at = end;
    } else {
      tokens.push({ text: char, name: false });
      at += 1;
    }
  }
  return tokens;
};

/**
 * Whether a PRAGMA statement changes the database image although no row
 * changes: an assignment to a header field or a file setting, or a pragma that
 * rewrites pages. Reads (`PRAGMA table_info(t)`, `PRAGMA user_version`) and
 * connection settings (`PRAGMA foreign_keys = ON`) do not. The statement is
 * read as SQLite reads it: `PRAGMA [schema.]name`, then `=` or `(` when it
 * gives the pragma a value, with any comment between two of them.
 *
 * @param statement - One SQL statement whose first keyword is PRAGMA.
 */
export const pragmaChangesImage = (statement: string): boolean => {
  const tokens = headTokens(statement, 5);
  if (tokens[0]?.text.toUpperCase() !== 'PRAGMA' || tokens[1]?.name !== true) return false;
  const qualified = tokens[2]?.text === '.' && tokens[2].name === false && tokens[3]?.name === true;
  const name = (qualified ? tokens[3] : tokens[1]).text.toLowerCase();
  const next = tokens[qualified ? 4 : 2];
  const setsValue = next !== undefined && next.name === false && (next.text === '=' || next.text === '(');
  return IMAGE_PRAGMAS_ALWAYS.has(name) || (setsValue && IMAGE_PRAGMAS_WHEN_SET.has(name));
};

/**
 * How a statement run through `all()` or `get()` can change the database:
 *
 * - `'no'`: `SELECT`, `VALUES` and `EXPLAIN` only read.
 * - `'if-rows-changed'`: a `WITH` statement leads a read or a write, and a
 *   `PRAGMA` that writes no header field or file setting reads a setting or a
 *   table's columns, or sets a connection setting (`PRAGMA foreign_keys = ON`),
 *   which the image does not hold. SQLite's count of changed rows decides.
 * - `'yes'`: any other statement. `INSERT`, `UPDATE`, `DELETE` and `REPLACE`
 *   with `RETURNING`, a schema change, and a `PRAGMA` that writes the image
 *   although no row changes (`PRAGMA user_version = 3`,
 *   `PRAGMA application_id(42)`, `PRAGMA incremental_vacuum`).
 */
export type QueryWrite = 'no' | 'if-rows-changed' | 'yes';

/**
 * How a statement run through `all()` or `get()` can change the database. See
 * {@link QueryWrite}.
 *
 * @param statement - One SQL statement.
 */
export const queryWrites = (statement: string): QueryWrite => {
  const keyword = firstKeyword(statement);
  if (keyword === 'SELECT' || keyword === 'EXPLAIN' || keyword === 'VALUES') return 'no';
  if (keyword === 'WITH') return 'if-rows-changed';
  if (keyword === 'PRAGMA') return pragmaChangesImage(statement) ? 'yes' : 'if-rows-changed';
  return 'yes';
};
