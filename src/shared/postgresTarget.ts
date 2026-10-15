import type { PostgresAdapterOptions } from '../adapters/postgresAdapter';

/** A string with something in it. */
export const isNonEmpty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** A `postgres://` or `postgresql://` URL, in any case. */
export const isPostgresUrl = (value: unknown): value is string =>
  typeof value === 'string' && /^postgres(?:ql)?:\/\//i.test(value.trim());

/**
 * Whether Postgres options name a server, which makes `createDatabase()` choose
 * PostgreSQL: a `postgres://` or `postgresql://` connection string, or a host,
 * database or user.
 *
 * A connection string of another scheme names none: `DATABASE_URL` holds
 * `file:./dev.db` in a project that runs SQLite through Prisma, or the URL of
 * another database. So does `{ connectionString: process.env.DATABASE_URL }`
 * with DATABASE_URL unset.
 */
export const namesPostgresServer = (options: PostgresAdapterOptions | undefined): boolean =>
  Boolean(
    options &&
      (isPostgresUrl(options.connectionString) ||
        isNonEmpty(options.host) ||
        isNonEmpty(options.database) ||
        isNonEmpty(options.user)),
  );

/**
 * Whether Postgres options give the Postgres adapter something to connect
 * with: a connection string of any form pg reads (a URL, a `socket:` URL, a
 * socket path), or a host, database or user.
 */
export const hasPostgresConnection = (options: PostgresAdapterOptions | undefined): boolean =>
  Boolean(
    options &&
      (isNonEmpty(options.connectionString) ||
        isNonEmpty(options.host) ||
        isNonEmpty(options.database) ||
        isNonEmpty(options.user)),
  );
