import type { StorageParameters } from '../core/contracts';
import { normaliseParameters } from './parameterUtils';

/**
 * Placeholder rewriting that reads SQL the way the database does. A `?`,
 * `@name` or `$1` inside a string literal, a quoted identifier, a
 * dollar-quoted string or a comment is text, and is never rewritten.
 */

/** How a dialect's lexer reads the parts of a statement that are not code. */
interface ScanRules {
  /** PostgreSQL nests block comments; SQLite ends one at the first `*\/`. */
  nestedComments: boolean;
  /** PostgreSQL's dollar-quoted strings: `$$...$$` and `$tag$...$tag$`. */
  dollarQuotes: boolean;
  /** PostgreSQL's `E'...'` strings, where a backslash escapes the next character. */
  escapeStrings: boolean;
  /** SQLite's backtick-quoted identifiers. */
  backticks: boolean;
}

/** A run of statement text: code, or a literal, quoted identifier or comment kept as written. */
interface Segment {
  code: boolean;
  text: string;
}

const POSTGRES_RULES: ScanRules = { nestedComments: true, dollarQuotes: true, escapeStrings: true, backticks: false };
const SQLITE_RULES: ScanRules = { nestedComments: false, dollarQuotes: false, escapeStrings: false, backticks: true };

const isIdentStart = (ch: string | undefined): boolean =>
  ch !== undefined && ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || ch === '_');

/** Characters that continue an identifier; both dialects allow `$` after the first. */
const isIdentPart = (ch: string | undefined): boolean =>
  ch !== undefined && (isIdentStart(ch) || (ch >= '0' && ch <= '9') || ch === '$');

/** The dollar-quote delimiter (`$$` or `$tag$`) that starts at `start`, or null. */
const readDollarTag = (sql: string, start: number): string | null => {
  if (sql[start + 1] === '$') return '$$';
  if (!isIdentStart(sql[start + 1])) return null;
  let end = start + 2;
  while (end < sql.length && (isIdentStart(sql[end]) || (sql[end] >= '0' && sql[end] <= '9'))) end += 1;
  return sql[end] === '$' ? sql.slice(start, end + 1) : null;
};

/** Splits `sql` into code and the literals, quoted identifiers and comments between it. */
const scanSql = (sql: string, rules: ScanRules): Segment[] => {
  const segments: Segment[] = [];
  const length = sql.length;
  let codeStart = 0;
  let i = 0;

  const keep = (start: number, end: number): void => {
    if (start > codeStart) segments.push({ code: true, text: sql.slice(codeStart, start) });
    segments.push({ code: false, text: sql.slice(start, end) });
    codeStart = end;
  };

  while (i < length) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (ch === '-' && next === '-') {
      const newline = sql.indexOf('\n', i + 2);
      const end = newline === -1 ? length : newline;
      keep(i, end);
      i = end;
      continue;
    }

    if (ch === '/' && next === '*') {
      let end = i + 2;
      let depth = 1;
      while (end < length && depth > 0) {
        if (rules.nestedComments && sql[end] === '/' && sql[end + 1] === '*') {
          depth += 1;
          end += 2;
        } else if (sql[end] === '*' && sql[end + 1] === '/') {
          depth -= 1;
          end += 2;
        } else {
          end += 1;
        }
      }
      keep(i, Math.min(end, length));
      i = Math.min(end, length);
      continue;
    }

    if (ch === "'") {
      // E'...' (not the E at the end of a longer word) takes backslash escapes.
      const escapes =
        rules.escapeStrings && (sql[i - 1] === 'E' || sql[i - 1] === 'e') && !isIdentPart(sql[i - 2]);
      let end = i + 1;
      while (end < length) {
        if (escapes && sql[end] === '\\') {
          end += 2;
          continue;
        }
        if (sql[end] === "'") {
          if (sql[end + 1] === "'") {
            end += 2;
            continue;
          }
          end += 1;
          break;
        }
        end += 1;
      }
      keep(i, Math.min(end, length));
      i = Math.min(end, length);
      continue;
    }

    if (ch === '"' || (rules.backticks && ch === '`')) {
      let end = i + 1;
      while (end < length) {
        if (sql[end] === ch) {
          if (sql[end + 1] === ch) {
            end += 2;
            continue;
          }
          end += 1;
          break;
        }
        end += 1;
      }
      keep(i, Math.min(end, length));
      i = Math.min(end, length);
      continue;
    }

    // A dollar quote never follows an identifier character directly: there the
    // $ is part of the identifier.
    if (rules.dollarQuotes && ch === '$' && !isIdentPart(sql[i - 1])) {
      const tag = readDollarTag(sql, i);
      if (tag) {
        const close = sql.indexOf(tag, i + tag.length);
        const end = close === -1 ? length : close + tag.length;
        keep(i, end);
        i = end;
        continue;
      }
    }

    i += 1;
  }

  if (codeStart < length) segments.push({ code: true, text: sql.slice(codeStart) });
  return segments;
};

/** A `$n` placeholder: `$` and digits, not inside an identifier such as `price$1`. */
const DOLLAR_PLACEHOLDER = /(^|[^A-Za-z0-9_$])\$(\d+)/g;

const hasDollarPlaceholder = (code: string): boolean => new RegExp(DOLLAR_PLACEHOLDER.source).test(code);

/** A statement and its values, ready for node-postgres. */
export interface PostgresStatement {
  text: string;
  values: unknown[];
}

/**
 * Rewrites a statement's placeholders for node-postgres, which takes only
 * `$1`, `$2`, ... Outside literals, quoted identifiers, dollar-quoted strings
 * and comments:
 *
 * - Named parameters: each `@name` becomes the next `$n`, bound to that name's value.
 * - A statement that already uses `$n` placeholders is sent as written, its
 *   `?` operators included.
 * - Otherwise `??` becomes `?` (the jsonb key-exists operator), `?|` and `?&`
 *   stay operators (`?||` and `?&&` are a placeholder followed by `||` or
 *   `&&`), and each other `?` becomes the next `$n`. A statement run without
 *   parameters keeps its `?`, so the jsonb `?` operator works in it as written.
 */
export const toPostgresStatement = (statement: string, parameters?: StorageParameters): PostgresStatement => {
  const { named, positional } = normaliseParameters(parameters);
  if (!named && !statement.includes('?')) {
    return { text: statement, values: positional ?? [] };
  }
  if (named && !statement.includes('@')) {
    return { text: statement, values: [] };
  }

  const segments = scanSql(statement, POSTGRES_RULES);

  if (named) {
    const order: string[] = [];
    const text = segments
      .map((segment) =>
        segment.code
          ? segment.text.replace(/@([A-Za-z0-9_]+)/g, (_match, name: string) => {
              order.push(name);
              return `$${order.length}`;
            })
          : segment.text,
      )
      .join('');
    return { text, values: order.map((name) => named[name]) };
  }

  if (segments.some((segment) => segment.code && hasDollarPlaceholder(segment.text))) {
    return { text: statement, values: positional ?? [] };
  }

  let index = 0;
  const text = segments
    .map((segment) => {
      if (!segment.code) return segment.text;
      const code = segment.text;
      let out = '';
      for (let i = 0; i < code.length; i += 1) {
        const ch = code[i];
        if (ch !== '?') {
          out += ch;
          continue;
        }
        const after = code[i + 1];
        if (after === '?') {
          out += '?';
          i += 1;
        } else if ((after === '|' && code[i + 2] !== '|') || (after === '&' && code[i + 2] !== '&')) {
          out += `?${after}`;
          i += 1;
        } else if (positional) {
          index += 1;
          out += `$${index}`;
        } else {
          out += '?';
        }
      }
      return out;
    })
    .join('');
  return { text, values: positional ?? [] };
};

/** A statement and its parameters, ready for a SQLite engine. */
export interface SqliteStatement {
  statement: string;
  parameters?: StorageParameters;
}

/**
 * Lets the SQLite adapters take `$1`, `$2`, ... with a positional array, as
 * PostgreSQL does. SQLite reads `$1` as a parameter named "1", which
 * better-sqlite3 will not bind from an array and sql.js binds in order of
 * first appearance, so each `$n` outside literals, quoted identifiers and
 * comments becomes `?`, and the values follow the `$n` order, repeats
 * included. Named parameters, and statements without `$n`, pass through. A
 * statement that mixes `?` and `$n` placeholders is refused.
 */
export const toSqliteStatement = (statement: string, parameters?: StorageParameters): SqliteStatement => {
  if (!statement.includes('$')) return { statement, parameters };
  const { named, positional } = normaliseParameters(parameters);
  if (named) return { statement, parameters };

  const segments = scanSql(statement, SQLITE_RULES);
  if (!segments.some((segment) => segment.code && hasDollarPlaceholder(segment.text))) {
    return { statement, parameters };
  }
  if (segments.some((segment) => segment.code && segment.text.includes('?'))) {
    throw new Error(
      'This statement mixes ? and $n placeholders. Write it with one kind: ?, or $1, $2, ... bound from the same array.',
    );
  }

  const order: number[] = [];
  const text = segments
    .map((segment) =>
      segment.code
        ? segment.text.replace(DOLLAR_PLACEHOLDER, (_match, before: string, digits: string) => {
            order.push(Number(digits));
            return `${before}?`;
          })
        : segment.text,
    )
    .join('');
  const values = positional ?? [];
  return { statement: text, parameters: order.map((n) => values[n - 1]) };
};
