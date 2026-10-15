/**
 * Where the library's log lines go. A host hands its own logger in, and
 * pino's logger fits as it is: each call passes the line's fields first and
 * its message second, as pino takes them. Without one, lines go to the
 * console, as the library has always written them.
 */
export interface StorageLogger {
  debug?(fields: Record<string, unknown>, message: string): void;
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

/** The console line's prefix: the field `scope` when a line has one, else StorageAdapter. */
const prefix = (fields: Record<string, unknown>): string =>
  `[${typeof fields.scope === 'string' ? fields.scope : 'StorageAdapter'}]`;

/** The default: one line on the console per call, prefixed as before. */
const consoleLogger: StorageLogger = {
  debug: (fields, message) => console.log(`${prefix(fields)} ${message}`),
  info: (fields, message) => console.info(`${prefix(fields)} ${message}`),
  warn: (fields, message) => console.warn(`${prefix(fields)} ${message}`),
  error: (fields, message) => console.error(`${prefix(fields)} ${message}`),
};

let current: StorageLogger = consoleLogger;

/**
 * Routes every line the library writes to `logger`, from then on and in every
 * adapter. `null` routes them back to the console.
 *
 * @example
 * ```typescript
 * import pino from 'pino';
 * setStorageLogger(pino({ name: 'storage' }));
 * ```
 */
export const setStorageLogger = (logger: StorageLogger | null): void => {
  current = logger ?? consoleLogger;
};

/** The logger the library writes to now. */
export const getStorageLogger = (): StorageLogger => current;
