/**
 * The tables a statement writes, read from its leading keywords: INSERT [OR
 * ...] INTO, REPLACE INTO, UPDATE [OR ...] [ONLY], DELETE FROM [ONLY] and
 * TRUNCATE [TABLE] [ONLY], after a WITH clause when one leads. Comments and
 * quoted names (`"x"`, `` `x` ``, `[x]`) are read as SQL reads them.
 */

/** What a statement does to a table's rows. */
export type RowChangeOperation = 'insert' | 'update' | 'delete';

/** A table a statement writes, and how. */
export interface WrittenTable {
  /** The table as the statement names it, unquoted; schema-qualified when the statement qualifies it (`app.notes`). */
  table: string;
  operation: RowChangeOperation;
}

/** A word (an unquoted identifier or keyword), a quoted name, or a symbol, at a parenthesis depth. */
interface Token {
  kind: 'word' | 'name' | 'symbol';
  /** The word as written, the quoted name without its quotes, or the symbol. */
  text: string;
  depth: number;
}

const WORD = /[A-Za-z_][A-Za-z0-9_$]*/y;
const CLOSING: Record<string, string> = { '"': '"', '`': '`', '[': ']' };

/** The statement's tokens up to its first semicolon, with strings, dollar-quoted bodies and comments skipped. */
const tokens = (sql: string): Token[] => {
  const out: Token[] = [];
  let depth = 0;
  let index = 0;
  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];
    if (/\s/.test(char)) {
      index++;
    } else if (char === '-' && next === '-') {
      const end = sql.indexOf('\n', index);
      index = end < 0 ? sql.length : end + 1;
    } else if (char === '/' && next === '*') {
      const end = sql.indexOf('*/', index + 2);
      index = end < 0 ? sql.length : end + 2;
    } else if (char === "'") {
      index++;
      while (index < sql.length && !(sql[index] === "'" && sql[index + 1] !== "'")) {
        index += sql[index] === "'" ? 2 : 1;
      }
      index++;
      out.push({ kind: 'symbol', text: "'", depth });
    } else if (char === '$' && next !== undefined && /[A-Za-z_$]/.test(next) && /^\$[A-Za-z_0-9]*\$/.test(sql.slice(index))) {
      // A PostgreSQL dollar-quoted body: $$...$$ or $tag$...$tag$.
      const tag = (/^\$[A-Za-z_0-9]*\$/.exec(sql.slice(index)) as RegExpExecArray)[0];
      const end = sql.indexOf(tag, index + tag.length);
      index = end < 0 ? sql.length : end + tag.length;
      out.push({ kind: 'symbol', text: '$', depth });
    } else if (CLOSING[char]) {
      const close = CLOSING[char];
      let name = '';
      index++;
      while (index < sql.length) {
        if (sql[index] === close && sql[index + 1] === close && close !== ']') {
          name += close;
          index += 2;
        } else if (sql[index] === close) {
          index++;
          break;
        } else {
          name += sql[index++];
        }
      }
      out.push({ kind: 'name', text: name, depth });
    } else if (/[A-Za-z_]/.test(char)) {
      WORD.lastIndex = index;
      const word = (WORD.exec(sql) as RegExpExecArray)[0];
      out.push({ kind: 'word', text: word, depth });
      index += word.length;
    } else if (char === ';') {
      break;
    } else {
      if (char === ')') depth = Math.max(0, depth - 1);
      out.push({ kind: 'symbol', text: char, depth });
      if (char === '(') depth++;
      index++;
    }
  }
  return out;
};

const isWord = (token: Token | undefined, ...words: string[]): boolean =>
  token !== undefined && token.kind === 'word' && words.includes(token.text.toUpperCase());

const isSymbol = (token: Token | undefined, symbol: string): boolean => token !== undefined && token.kind === 'symbol' && token.text === symbol;

/** A table name at `at` (an identifier or a quoted name, schema-qualified or not), and the index after it. */
const tableName = (list: Token[], at: number): { table: string; next: number } | null => {
  const part = (token: Token | undefined): string | null => (token && token.kind !== 'symbol' ? token.text : null);
  const first = part(list[at]);
  if (first === null) return null;
  if (isSymbol(list[at + 1], '.')) {
    const second = part(list[at + 2]);
    if (second !== null) return { table: `${first}.${second}`, next: at + 3 };
  }
  return { table: first, next: at + 1 };
};

/** The tables `statement` writes, in order, or an empty list for a statement that writes none. */
export const writtenTables = (statement: string): WrittenTable[] => {
  const list = tokens(statement);
  let at = 0;
  if (isWord(list[0], 'WITH')) {
    // The statement after the WITH clause starts at the first top-level verb.
    at = list.findIndex((token, index) => index > 0 && token.depth === 0 && isWord(token, 'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'SELECT', 'MERGE'));
    if (at < 0) return [];
  }
  const verb = list[at];
  if (isWord(verb, 'INSERT', 'REPLACE')) {
    let into = at + 1;
    if (isWord(verb, 'INSERT') && isWord(list[into], 'OR')) into += 2;
    if (!isWord(list[into], 'INTO')) return [];
    const name = tableName(list, into + 1);
    return name ? [{ table: name.table, operation: 'insert' }] : [];
  }
  if (isWord(verb, 'UPDATE')) {
    let start = at + 1;
    if (isWord(list[start], 'OR')) start += 2;
    if (isWord(list[start], 'ONLY')) start += 1;
    const name = tableName(list, start);
    return name ? [{ table: name.table, operation: 'update' }] : [];
  }
  if (isWord(verb, 'DELETE')) {
    if (!isWord(list[at + 1], 'FROM')) return [];
    let start = at + 2;
    if (isWord(list[start], 'ONLY')) start += 1;
    const name = tableName(list, start);
    return name ? [{ table: name.table, operation: 'delete' }] : [];
  }
  if (isWord(verb, 'TRUNCATE')) {
    let start = at + 1;
    if (isWord(list[start], 'TABLE')) start += 1;
    const found: WrittenTable[] = [];
    for (;;) {
      if (isWord(list[start], 'ONLY')) start += 1;
      const name = tableName(list, start);
      if (!name) break;
      found.push({ table: name.table, operation: 'delete' });
      if (!isSymbol(list[name.next], ',')) break;
      start = name.next + 1;
    }
    return found;
  }
  return [];
};
