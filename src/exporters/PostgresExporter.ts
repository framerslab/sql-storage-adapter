import type { IDatabaseExporter } from '../core/contracts/exporter.js';

/** How `pg_dump` is started: the program, its arguments and its environment. */
export interface PgDumpInvocation {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/**
 * The `pg_dump` invocation for a connection string and, when writing a file, its path. Each value is one argument of
 * an argument array that no shell parses, so a quote, a `$(...)` or a `;` in the connection string or the path is a
 * character of that argument and never a command. A `postgres://` or `postgresql://` URL loses its password before it
 * becomes `--dbname`, and the password travels in `PGPASSWORD`, so it never shows in the process list. A keyword and
 * value connection string (`host=... password=...`) is passed whole as `--dbname`; give a URL to keep its password out
 * of the process list.
 */
export function pgDumpInvocation(connectionString: string, outputPath?: string): PgDumpInvocation {
  const env: NodeJS.ProcessEnv = { ...process.env };
  let dbname = connectionString;
  if (/^postgres(?:ql)?:\/\//i.test(connectionString)) {
    const url = new URL(connectionString);
    if (url.password !== '') {
      env.PGPASSWORD = decodeURIComponent(url.password);
      url.password = '';
    }
    dbname = url.toString();
  }
  const args = [`--dbname=${dbname}`, '--format=custom'];
  if (outputPath !== undefined) args.push(`--file=${outputPath}`);
  return { file: 'pg_dump', args, env };
}

/**
 * PostgreSQL database exporter using `pg_dump`.
 *
 * Requires a valid connection string and `pg_dump` to be available on the system PATH. Supports both file-based and
 * byte-array exports. `pg_dump` is started without a shell (`execFile` with an argument array), and a URL's password
 * reaches it through `PGPASSWORD` (see {@link pgDumpInvocation}).
 */
export class PostgresExporter implements IDatabaseExporter {
  constructor(private readonly connectionString?: string) {}

  async exportToFile(outputPath: string): Promise<void> {
    if (!this.connectionString) {
      throw new Error('PostgresExporter requires a connection string for pg_dump.');
    }
    const { execFile } = await import('node:child_process');
    const { file, args, env } = pgDumpInvocation(this.connectionString, outputPath);
    await new Promise<void>((resolve, reject) => {
      execFile(file, args, { env, maxBuffer: 16 * 1024 * 1024 }, (error) => (error ? reject(error) : resolve()));
    });
  }

  async exportToBytes(): Promise<Uint8Array> {
    if (!this.connectionString) {
      throw new Error('PostgresExporter requires a connection string for pg_dump.');
    }
    const { execFile } = await import('node:child_process');
    const { file, args, env } = pgDumpInvocation(this.connectionString);
    const buf = await new Promise<Buffer>((resolve, reject) => {
      execFile(file, args, { env, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
    });
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
}
