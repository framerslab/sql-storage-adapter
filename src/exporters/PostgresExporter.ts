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
 * What libpq older than PostgreSQL 16 says of `sslrootcert=system`: it looks for a file of that name
 * (fe-secure-openssl.c, initialize_SSL), where libpq 16 and later read the system's certificate authorities.
 */
const NO_SYSTEM_ROOTS = /root certificate file "system" does not exist/;

/** What to do where pg_dump's libpq reads `sslrootcert=system` as a file. */
const SYSTEM_ROOTS_ADVICE =
  " libpq reads sslrootcert=system as the system's certificate authorities from PostgreSQL 16 on, and an older " +
  'libpq looks for a file named system: run a pg_dump of PostgreSQL 16 or later, or name the root certificate file ' +
  "in the connection string's sslrootcert parameter or in PGSSLROOTCERT.";

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

/** An export refused before pg_dump starts. It never holds the connection string, which can hold a password. */
const refusal = (why: string): Error => new Error(`PostgresExporter: ${why}`);

/**
 * The password of a URI, decoded for PGPASSWORD. libpq refuses `%00`, and a password that is not valid
 * percent-encoded UTF-8 cannot become an environment variable: either would otherwise stay in the URI on pg_dump's
 * command line, where the process list shows it.
 */
const uriPassword = (encoded: string): string => {
  const password = decodePart(encoded);
  if (password === undefined) {
    throw refusal(
      'the password in the connection string is not valid percent-encoding, so it cannot reach pg_dump through ' +
        'PGPASSWORD. Percent-encode it, as encodeURIComponent does.',
    );
  }
  if (password.includes('\u0000')) {
    throw refusal('the password in the connection string decodes to a NUL character, which libpq refuses.');
  }
  return password;
};

/**
 * The database pg_dump connects to, with the password of a `postgres://` or `postgresql://` URI taken out of the
 * command line, where the process list shows it. The URI is read as libpq reads one: the password of its user part,
 * or of its `password` parameter, which libpq takes over the user part's, goes to PGPASSWORD, which pg_dump reads.
 */
const uriConnectionOf = (connectionString: string, found: string): { dbname: string; env: Record<string, string> } => {
  const scheme = found.toLowerCase();
  const uri = scheme + connectionString.slice(found.length);

  let rest = uri.slice(scheme.length);
  let user = '';
  let encoded: string | undefined;
  // libpq looks for the user part's @ up to the first / alone, so a ? before the @ belongs to the user part
  // (fe-connect.c, conninfo_uri_parse_options), and it is read so here.
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

  if (encoded === undefined) return { dbname: uri, env: {} };
  return { dbname: `${scheme}${user ? `${user}@` : ''}${rest}`, env: { PGPASSWORD: uriPassword(encoded) } };
};

/** Whitespace as libpq's conninfo parser reads it (C's isspace). */
const isSpace = (char: string | undefined): boolean => char !== undefined && /[ \t\n\v\f\r]/.test(char);

/**
 * The settings of a keyword=value connection string, with each `password` setting taken out for PGPASSWORD, read as
 * libpq reads them (fe-connect.c, conninfo_parse): a keyword runs to `=` or whitespace, a value runs to whitespace
 * or sits in single quotes, a backslash takes the character after it as it is, and the later of two passwords wins.
 * An empty password goes to PGPASSWORD empty: libpq reads the environment's PGPASSWORD only for a password the
 * settings leave out (conninfo_add_defaults), and reads an empty PGPASSWORD as it reads an empty setting.
 */
const keywordConnectionOf = (connectionString: string): { dbname: string; env: Record<string, string> } => {
  const text = connectionString;
  const passwordSpans: Array<[number, number]> = [];
  let password: string | undefined;
  let at = 0;
  while (at < text.length) {
    if (isSpace(text[at])) {
      at += 1;
      continue;
    }
    const start = at;
    while (at < text.length && text[at] !== '=' && !isSpace(text[at])) at += 1;
    const keyword = text.slice(start, at);
    while (isSpace(text[at])) at += 1;
    if (text[at] !== '=') {
      throw refusal('the connection string is not keyword=value settings libpq reads: a setting has no "=".');
    }
    at += 1;
    while (isSpace(text[at])) at += 1;
    let value = '';
    if (text[at] === "'") {
      at += 1;
      let closed = false;
      while (at < text.length) {
        const char = text[at];
        at += 1;
        if (char === '\\') {
          if (at < text.length) value += text[at];
          at += 1;
        } else if (char === "'") {
          closed = true;
          break;
        } else {
          value += char;
        }
      }
      if (!closed) throw refusal('the connection string holds an unterminated quoted value, which libpq refuses.');
    } else {
      while (at < text.length && !isSpace(text[at])) {
        const char = text[at];
        at += 1;
        if (char === '\\') {
          if (at < text.length) value += text[at];
          at += 1;
        } else {
          value += char;
        }
      }
    }
    if (keyword === 'password') {
      password = value;
      passwordSpans.push([start, Math.min(at, text.length)]);
    }
  }
  if (passwordSpans.length === 0) return { dbname: connectionString, env: {} };
  let kept = '';
  let from = 0;
  for (const [start, end] of passwordSpans) {
    kept += text.slice(from, start);
    from = end;
  }
  kept += text.slice(from);
  return { dbname: kept.trim(), env: password === undefined ? {} : { PGPASSWORD: password } };
};

/**
 * The database pg_dump connects to, with the password taken out of the command line, where the process list shows
 * it, for PGPASSWORD. A `postgres://` or `postgresql://` URI is read as libpq reads one, and so are keyword=value
 * settings (`host=... password=...`). Any other string (a database name) is passed as it is.
 *
 * @throws {Error} When the string holds a NUL character, which neither libpq nor a process argument takes, or a
 *   password pg_dump could not be given through PGPASSWORD, or settings libpq refuses.
 */
const connectionOf = (connectionString: string): { dbname: string; env: Record<string, string> } => {
  if (connectionString.includes('\u0000')) {
    throw refusal('the connection string holds a NUL character, which pg_dump cannot take.');
  }
  const found = URI_SCHEME.exec(connectionString)?.[0];
  if (found !== undefined) return uriConnectionOf(connectionString, found);
  // libpq reads a string with an = as keyword=value settings, and any other as a database name.
  if (connectionString.includes('=')) return keywordConnectionOf(connectionString);
  return { dbname: connectionString, env: {} };
};

/**
 * The `pg_dump` invocation for a connection string and, when writing a file,
 * its path, in pg_dump's custom format. Each value is one argument of an
 * argument array that no shell parses, so a quote, a `$(...)` or a `;` in the
 * connection string or the path is a character of that argument and never a
 * command. The password of a `postgres://` or `postgresql://` URI, in its user
 * part or its `password` parameter, and of keyword=value settings
 * (`host=... password=...`), is taken out before the string becomes
 * `--dbname` and travels in `PGPASSWORD`, so it never shows in the process
 * list; the string is read as libpq reads it, so an empty host, several hosts,
 * a `#` or `?` in a URI's password, or a quoted value with spaces keep it off
 * the command line too. An empty password given in the string goes to
 * `PGPASSWORD` empty, so libpq sends no password of the environment's. pg_dump
 * runs with `--no-password`: it never asks for one, on a terminal or on its
 * standard input, which `execFile` leaves open. With `schema`, the dump holds
 * that schema alone.
 *
 * @throws {Error} Before pg_dump starts, when the connection string holds a
 *   NUL character, a password that is not valid percent-encoding or decodes
 *   to a NUL, or keyword=value settings libpq refuses; the error never holds
 *   the connection string.
 */
export function pgDumpInvocation(
  connectionString: string,
  outputPath?: string,
  options: Pick<PostgresExporterOptions, 'schema'> = {},
): PgDumpInvocation {
  const { dbname, env } = connectionOf(connectionString);
  // Without a password, to a server that asks for one, pg_dump would ask for it on the terminal, or with no
  // terminal on its standard input, and wait there (pg_backup_db.c, ConnectDatabaseAhx; sprompt.c).
  const args = [`--dbname=${dbname}`, '--format=custom', '--no-password'];
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
 * reaches it as it is, and the password of the connection string, a URI's or
 * keyword=value settings', reaches it through PGPASSWORD, not the command line
 * (see {@link pgDumpInvocation}).
 * With `schema`, the export holds that schema alone. Supports both file-based
 * and byte-array exports.
 */
export class PostgresExporter implements IDatabaseExporter {
  private readonly options: PostgresExporterOptions;

  /**
   * @param connectionString The database to dump: a connection string, or a
   *   function that gives one, or a promise of one, when an export runs. The
   *   exporter of an adapter reads the pool the adapter runs on then, and asks
   *   a password function of the pool for its password.
   * @param options The one schema to export, and what an export with no
   *   connection string says.
   */
  constructor(
    private readonly connectionString?: string | (() => string | undefined | Promise<string | undefined>),
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
      typeof this.connectionString === 'function' ? await this.connectionString() : this.connectionString;
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
        const advice = NO_SYSTEM_ROOTS.test(said) ? SYSTEM_ROOTS_ADVICE : '';
        reject(
          new Error(
            `PostgresExporter: pg_dump failed${typeof code === 'number' ? ` (exit code ${code})` : ''}${said ? `: ${said}` : '.'}${advice}`,
          ),
        );
      });
    });
  }
}
