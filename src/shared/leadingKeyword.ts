/**
 * The first keyword of a SQL statement, upper-cased, past the whitespace and
 * the `--` and `/* ... *\/` comments ahead of it: `SELECT`, `INSERT`, `WITH`,
 * `PRAGMA` and so on. An empty string when the statement holds none.
 *
 * The adapters read it to tell a statement that only reads from one that may
 * write, and to route PRAGMA statements; it does not parse SQL beyond that.
 *
 * @param statement - One SQL statement.
 * @returns The keyword, upper-cased, or `''`.
 */
export const leadingKeyword = (statement: string): string => {
  let i = 0;
  const length = statement.length;
  while (i < length) {
    const ch = statement[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v') {
      i += 1;
    } else if (ch === '-' && statement[i + 1] === '-') {
      const end = statement.indexOf('\n', i + 2);
      i = end === -1 ? length : end + 1;
    } else if (ch === '/' && statement[i + 1] === '*') {
      const end = statement.indexOf('*/', i + 2);
      i = end === -1 ? length : end + 2;
    } else {
      break;
    }
  }
  const match = /^[A-Za-z]+/.exec(statement.slice(i));
  return match ? match[0].toUpperCase() : '';
};
