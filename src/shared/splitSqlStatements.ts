/**
 * Splits a multi-statement SQL script into individual statements without
 * cutting inside the SQL surface forms a naive `.split(';')` mishandles.
 *
 * Recognised constructs that suppress top-level `;` splitting:
 * - `--` line comments (terminate at the next newline or EOF)
 * - `/* ... *\/` block comments, with Postgres-style nesting
 * - `'...'` single-quoted strings, including the `''` escape for an apostrophe
 * - `"..."` double-quoted identifiers, including the `""` escape
 * - `$$...$$` and `$tag$...$tag$` dollar-quoted strings
 *
 * A bare `$` not followed by a valid tag character or another `$` is treated
 * as a literal `$` so positional parameters (`$1`, `$2`, ...) round-trip.
 *
 * The function returns trimmed, non-empty statements. It does not parse SQL
 * beyond what's needed to find top-level statement separators, and it does
 * not validate or modify statement contents.
 *
 * Postgres E-string escape syntax (`E'...\n...'`) is parsed conservatively:
 * the `E` prefix is ignored and standard `''` escape rules apply. Migrations
 * in this codebase do not rely on backslash escapes, so this is sufficient.
 *
 * @param script - Multi-statement SQL script (may include comments and strings).
 * @returns Array of trimmed individual statements, in input order.
 */
export const splitSqlStatements = (script: string): string[] => {
  const length = script.length;
  const statements: string[] = [];
  let buffer = '';
  let i = 0;

  const pushBuffer = (): void => {
    const trimmed = buffer.trim();
    if (trimmed.length > 0) {
      statements.push(trimmed);
    }
    buffer = '';
  };

  const isIdentStart = (ch: string): boolean =>
    (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || ch === '_';
  const isIdentCont = (ch: string): boolean =>
    isIdentStart(ch) || (ch >= '0' && ch <= '9');

  /**
   * Attempts to read a dollar-quote opener starting at `start` (the index of
   * the leading `$`). Returns the full tag including both `$` delimiters
   * (e.g. `"$$"` or `"$func$"`) on success, or `null` if no valid opener
   * begins at `start`. Used both to detect openers and to recognise closers.
   */
  const readDollarTag = (start: number): string | null => {
    if (script[start] !== '$') return null;
    if (start + 1 >= length) return null;
    // Empty-tag form: $$
    if (script[start + 1] === '$') {
      return '$$';
    }
    // Tagged form: $ident$ where ident starts with letter/_ and continues with
    // letters/digits/_. A digit-led suffix like $1 is NOT a dollar-quote.
    if (!isIdentStart(script[start + 1])) return null;
    let j = start + 2;
    while (j < length && isIdentCont(script[j])) {
      j += 1;
    }
    if (j >= length || script[j] !== '$') return null;
    return script.slice(start, j + 1);
  };

  while (i < length) {
    const ch = script[i];
    const next = i + 1 < length ? script[i + 1] : '';

    // Line comment: -- ... \n
    if (ch === '-' && next === '-') {
      buffer += ch + next;
      i += 2;
      while (i < length && script[i] !== '\n') {
        buffer += script[i];
        i += 1;
      }
      continue;
    }

    // Block comment: /* ... */ with nesting
    if (ch === '/' && next === '*') {
      buffer += ch + next;
      i += 2;
      let depth = 1;
      while (i < length && depth > 0) {
        const c = script[i];
        const n = i + 1 < length ? script[i + 1] : '';
        if (c === '/' && n === '*') {
          buffer += c + n;
          i += 2;
          depth += 1;
        } else if (c === '*' && n === '/') {
          buffer += c + n;
          i += 2;
          depth -= 1;
        } else {
          buffer += c;
          i += 1;
        }
      }
      continue;
    }

    // Single-quoted string: '...' with '' escape
    if (ch === "'") {
      buffer += ch;
      i += 1;
      while (i < length) {
        const c = script[i];
        if (c === "'") {
          // Doubled '' inside string = escaped apostrophe; consume both.
          if (i + 1 < length && script[i + 1] === "'") {
            buffer += "''";
            i += 2;
            continue;
          }
          buffer += c;
          i += 1;
          break;
        }
        buffer += c;
        i += 1;
      }
      continue;
    }

    // Double-quoted identifier: "..." with "" escape
    if (ch === '"') {
      buffer += ch;
      i += 1;
      while (i < length) {
        const c = script[i];
        if (c === '"') {
          if (i + 1 < length && script[i + 1] === '"') {
            buffer += '""';
            i += 2;
            continue;
          }
          buffer += c;
          i += 1;
          break;
        }
        buffer += c;
        i += 1;
      }
      continue;
    }

    // Dollar-quoted string: $tag$...$tag$ or $$...$$
    if (ch === '$') {
      const tag = readDollarTag(i);
      if (tag !== null) {
        buffer += tag;
        i += tag.length;
        while (i < length) {
          if (script[i] === '$') {
            const close = readDollarTag(i);
            if (close === tag) {
              buffer += close;
              i += close.length;
              break;
            }
          }
          buffer += script[i];
          i += 1;
        }
        continue;
      }
      // Not a dollar-quote -- fall through to default handling so `$1`,
      // `$2`, and `$,` are emitted as literal characters.
    }

    // Top-level statement separator
    if (ch === ';') {
      pushBuffer();
      i += 1;
      continue;
    }

    buffer += ch;
    i += 1;
  }

  pushBuffer();
  return statements;
};

/** A statement's place in a script: offsets into the script, with the whitespace around the statement left out. */
export interface StatementSpan {
  start: number;
  end: number;
}

/**
 * The statements of a SQLite script, as offsets into it: the script is cut at
 * the semicolons outside SQLite's strings, quoted names and comments (`'...'`,
 * `"..."`, `` `...` ``, `[...]`, `--` to the end of the line, `/* ... *\/`), and
 * each statement's whitespace is left out of its span. A caller that must hand
 * a part of the script on as written (the Capacitor adapter's exec(), whose
 * plugin splits the script itself) slices the script by these spans and never
 * rejoins statements. SQLite has no dollar quoting: `$name` is a parameter.
 *
 * @param script - A script of one or more SQLite statements.
 * @returns The spans of the statements that hold anything but whitespace, in order.
 */
export const sqliteStatementSpans = (script: string): StatementSpan[] => {
  const spans: StatementSpan[] = [];
  const length = script.length;
  let from = 0;
  const push = (to: number): void => {
    let start = from;
    let end = to;
    while (start < end && /\s/.test(script[start])) start += 1;
    while (end > start && /\s/.test(script[end - 1])) end -= 1;
    if (end > start) spans.push({ start, end });
    from = to + 1;
  };
  let i = 0;
  while (i < length) {
    const ch = script[i];
    const next = script[i + 1];
    if (ch === '-' && next === '-') {
      const end = script.indexOf('\n', i + 2);
      i = end < 0 ? length : end + 1;
    } else if (ch === '/' && next === '*') {
      const end = script.indexOf('*/', i + 2);
      i = end < 0 ? length : end + 2;
    } else if (ch === "'" || ch === '"' || ch === '`') {
      // The quote character inside is written twice.
      i += 1;
      while (i < length) {
        if (script[i] === ch) {
          if (script[i + 1] === ch) {
            i += 2;
            continue;
          }
          break;
        }
        i += 1;
      }
      i += 1;
    } else if (ch === '[') {
      const end = script.indexOf(']', i + 1);
      i = end < 0 ? length : end + 1;
    } else if (ch === ';') {
      push(i);
      i += 1;
    } else {
      i += 1;
    }
  }
  push(length);
  return spans;
};
