import type { PostgresAdapterOptions } from '../adapters/postgresAdapter';

/** A string with something in it. */
export const isNonEmpty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/**
 * Whether Postgres options name a server: a connection string, or a host,
 * database or user. `{ connectionString: process.env.DATABASE_URL }` with
 * DATABASE_URL unset names none.
 */
export const namesPostgresServer = (options: PostgresAdapterOptions | undefined): boolean =>
  Boolean(
    options &&
      (isNonEmpty(options.connectionString) ||
        isNonEmpty(options.host) ||
        isNonEmpty(options.database) ||
        isNonEmpty(options.user)),
  );
