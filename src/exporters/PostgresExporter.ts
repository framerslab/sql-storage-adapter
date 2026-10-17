import type { IDatabaseExporter } from '../core/contracts/exporter.js';

/** Options of a {@link PostgresExporter}. */
export interface PostgresExporterOptions {
  /**
   * The one schema to export, as pg_dump's `--schema` takes it, by its exact
   * name. The exporter of a segmented adapter is given its segment, so the
   * export holds the segment's tables alone. Default: the whole database.
   */
  schema?: string;
  /**
   * What an export says when there is no connection string. Default: that
   * pg_dump needs one.
   */
  missingConnection?: string;
}

/** How `pg_dump` is started: the program, its arguments and its environment. */
export interface PgDumpInvocation {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/** The largest dump `exportToBytes()` holds in memory: 256 MiB. */
const MAX_DUMP_BYTES = 256 * 1024 * 1024;

/**
 * The scheme of a connection URI, at the very start. libpq knows it in lower
 * case alone; pg, which the adapter connects with, reads it in any case. So it
 * is read in any case here and written in lower case for pg_dump.
 */
const URI_SCHEME = /^postgres(?:ql)?:\/\//i;

/**
 * The user part of a connection URI as libpq reads it: everything before the
 * first `@` that comes before any `/`. Its user name ends at its first `:`,
 * and its password runs from there to the `@`.
 */
const URI_USER_PART = /^([^@/]*)@/;

/** A part of a URI, percent-decoded; undefined when it is not valid percent-encoded UTF-8. */
const decodePart = (part: string): string | undefined => {
  try {
    return decodeURIComponent(part);
  } catch {
    return undefined;
  }
};

/**
 * The database pg_dump connects to, with the password taken out of the
 * command line, where the process list shows it. A `postgres://` or
 * `postgresql://` URI is read as libpq reads one: the password of its user
 * part, or of its `password` parameter, which libpq takes over the user
 * part's, goes to PGPASSWORD, which pg_dump reads. A connection string of
 * another form, one that holds no password, or one whose password is not valid
 * percent-encoding is passed as it is, its scheme in lower case.
 */
const connectionOf = (connectionString: string): { dbname: string; env: Record<string, string> } => {
  const found = URI_SCHEME.exec(connectionString)?.[0];
  if (found === undefined) return { dbname: connectionString, env: {} };
  const scheme = found.toLowerCase();
  const uri = scheme + connectionString.slice(found.length);

  let rest = uri.slice(scheme.length);
  let user = '';
  let encoded: string | undefined;
  const userPart = URI_USER_PART.exec(rest);
  if (userPart) {
    const colon = userPart[1].indexOf(':');
    user = colon < 0 ? userPart[1] : userPart[1].slice(0, colon);
    // libpq keeps no empty password: PGPASSWORD or ~/.pgpass answers instead.
    if (colon >= 0 && colon < userPart[1].length - 1) encoded = userPart[1].slice(colon + 1);
    rest = rest.slice(userPart[0].length);
  }

  // The parameters follow the first ? after the user part, separated by &.
  const query = rest.indexOf('?');
  if (query >= 0) {
    const kept: string[] = [];
    for (const parameter of rest.slice(query + 1).split('&')) {
      const equals = parameter.indexOf('=');
      if (equals >= 0 && decodePart(parameter.slice(0, equals)) === 'password') {
        encoded = parameter.slice(equals + 1);
      } else {
        kept.push(parameter);
      }
    }
    rest = rest.slice(0, query) + (kept.length > 0 ? `?${kept.join('&')}` : '');
  }

  const password = encoded === undefined ? undefined : decodePart(encoded);
  if (password === undefined) return { dbname: uri, env: {} };
  return { dbname: `${scheme}${user ? `${user}@` : ''}${rest}`, env: { PGPASSWORD: password } };
};

/**
 * The `pg_dump` invocation for a connection string and, when writing a file,
 * its path, in pg_dump's custom format. Each value is one argument of an
 * argument array that no shell parses, so a quote, a `$(...)` or a `;` in the
 * connection string or the path is a character of that argument and never a
 * command. The password of a `postgres://` or `postgresql://` URI, in its user
 * part or its `password` parameter, is taken out before the URI becomes
 * `--dbname` and travels in `PGPASSWORD`, so it never shows in the process
 * list; the URI is read as libpq reads one, so an empty host, several hosts,
 * or a `#` or `?` in the password keep it off the command line too. A keyword
 * and value connection string (`host=... password=...`) is passed whole as
 * `--dbname`; give a URI to keep its password out of the process list. With
 * `schema`, the dump holds that schema alone.
 */
export function pgDumpInvocation(
  connectionString: string,
  outputPath?: string,
  options: Pick<PostgresExporterOptions, 'schema'> = {},
): PgDumpInvocation {
  const { dbname, env } = connectionOf(connectionString);
  const args = [`--dbname=${dbname}`, '--format=custom'];
  if (options.schema !== undefined) {
    // In double quotes pg_dump reads the name exactly: no case folding, and no pattern characters.
    args.push(`--schema="${options.schema.replace(/"/g, '""')}"`);
  }
  if (outputPath !== undefined) args.push(`--file=${outputPath}`);
  return { file: 'pg_dump', args, env: { ...(typeof process !== 'undefined' ? process.env : {}), ...env } };
}

/**
 * PostgreSQL database exporter using `pg_dump`, in its custom format.
 *
 * Requires a connection string and `pg_dump` on the system PATH. pg_dump is
 * started without a shell (`execFile` with an argument array): each argument
 * reaches it as it is, and the password of a `postgres://` or `postgresql://`
 * connection string, in its user part or its `password` parameter, reaches it
 * through PGPASSWORD, not the command line (see {@link pgDumpInvocation}).
 * With `schema`, the export holds that schema alone. Supports both file-based
 * and byte-array exports.
 */
export class PostgresExporter implements IDatabaseExporter {
  private readonly options: PostgresExporterOptions;

  /**
   * @param connectionString The database to dump: a connection string, or a
   *   function that gives one when an export runs. The exporter of an adapter
   *   reads the pool the adapter runs on then.
   * @param options The one schema to export, and what an export with no
   *   connection string says.
   */
  constructor(
    private readonly connectionString?: string | (() => string | undefined),
    options: PostgresExporterOptions = {},
  ) {
    this.options = options;
  }

  async exportToFile(outputPath: string): Promise<void> {
    await this.dump(outputPath);
  }

  async exportToBytes(): Promise<Uint8Array> {
    const dump = await this.dump();
    return new Uint8Array(dump.buffer, dump.byteOffset, dump.byteLength);
  }

  /** Runs pg_dump, into the file at `outputPath` when one is given and to its output otherwise. */
  private async dump(outputPath?: string): Promise<Buffer> {
    const connectionString =
      typeof this.connectionString === 'function' ? this.connectionString() : this.connectionString;
    if (!connectionString) {
      throw new Error(this.options.missingConnection ?? 'PostgresExporter requires a connection string for pg_dump.');
    }
    const { file, args, env } = pgDumpInvocation(connectionString, outputPath, { schema: this.options.schema });

    const { execFile } = await import('node:child_process');
    return new Promise<Buffer>((resolve, reject) => {
      execFile(file, args, { encoding: 'buffer', maxBuffer: MAX_DUMP_BYTES, env }, (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout);
          return;
        }
        const code = (error as { code?: unknown }).code;
        if (code === 'ENOENT') {
          reject(new Error('PostgresExporter: pg_dump was not found on the PATH. Install the PostgreSQL client tools.'));
          return;
        }
        if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          reject(new Error('PostgresExporter: the dump is larger than 256 MiB, which exportToBytes() holds; use exportToFile().'));
          return;
        }
        // pg_dump's own words. The error's message repeats the command
        // line, which can hold a password, so it is left out.
        const said = stderr ? stderr.toString('utf8').trim() : '';
        reject(
          new Error(
            `PostgresExporter: pg_dump failed${typeof code === 'number' ? ` (exit code ${code})` : ''}${said ? `: ${said}` : '.'}`,
          ),
        );
      });
    });
  }
}
