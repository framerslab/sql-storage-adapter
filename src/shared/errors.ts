/**
 * Error checks that read the same failure from every adapter.
 */

/** better-sqlite3's extended result codes for a unique or primary-key violation. */
const SQLITE_UNIQUE_CODES = new Set(['SQLITE_CONSTRAINT_UNIQUE', 'SQLITE_CONSTRAINT_PRIMARYKEY']);

/** SQLite's message for one, which sql.js and the Capacitor plugin pass on without a code. */
const SQLITE_UNIQUE_MESSAGE = /\bUNIQUE constraint failed\b/;

/** How deep isUniqueViolation follows `cause`. */
const MAX_CAUSE_DEPTH = 10;

/**
 * Whether `error` is a unique or primary-key violation, from any adapter:
 * PostgreSQL's SQLSTATE `23505` (`unique_violation`, pg's `code`),
 * better-sqlite3's `SQLITE_CONSTRAINT_UNIQUE` and
 * `SQLITE_CONSTRAINT_PRIMARYKEY`, and the "UNIQUE constraint failed" message
 * that sql.js, the IndexedDB adapter and the Capacitor plugin give. An error
 * that wraps one as its `cause`, to any depth up to ten, counts too.
 *
 * @example
 * ```typescript
 * try {
 *   await db.run('INSERT INTO users (email) VALUES (?)', [email]);
 * } catch (error) {
 *   if (isUniqueViolation(error)) return { taken: true };
 *   throw error;
 * }
 * ```
 */
export const isUniqueViolation = (error: unknown): boolean => {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== null && typeof current === 'object' && !seen.has(current) && seen.size < MAX_CAUSE_DEPTH) {
    seen.add(current);
    const { code, message } = current as { code?: unknown; message?: unknown };
    if (code === '23505') return true;
    if (typeof code === 'string' && SQLITE_UNIQUE_CODES.has(code)) return true;
    if (typeof message === 'string' && SQLITE_UNIQUE_MESSAGE.test(message)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
};
