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

/** The largest dump `exportToBytes()` holds in memory: 256 MiB. */
const MAX_DUMP_BYTES = 256 * 1024 * 1024;

/**
 * The database pg_dump connects to, with the password taken out of the
 * command line, where the process list shows it: a `postgres://` or
 * `postgresql://` connection string gives its password to PGPASSWORD, which
 * pg_dump reads. A connection string of another form is passed as it is.
 */
const connectionOf = (connectionString: string): { dbname: string; env: Record<string, string> } => {
  try {
    const url = new URL(connectionString);
    if ((url.protocol === 'postgres:' || url.protocol === 'postgresql:') && url.password !== '') {
      const password = decodeURIComponent(url.password);
      url.password = '';
      return { dbname: url.toString(), env: { PGPASSWORD: password } };
    }
  } catch {
    // Not a URL, or a password that is not percent-encoded: passed as it is.
  }
  return { dbname: connectionString, env: {} };
};

/**
 * PostgreSQL database exporter using `pg_dump`, in its custom format.
 *
 * Requires a connection string and `pg_dump` on the system PATH. pg_dump runs
 * with no shell between: each argument reaches it as it is, and the password
 * of a `postgresql://` connection string reaches it through PGPASSWORD, not
 * the command line. With `schema`, the export holds that schema alone.
 * Supports both file-based and byte-array exports.
 */
export class PostgresExporter implements IDatabaseExporter {
  private readonly options: PostgresExporterOptions;

  constructor(
    private readonly connectionString?: string,
    options: PostgresExporterOptions = {},
  ) {
    this.options = options;
  }

  async exportToFile(outputPath: string): Promise<void> {
    await this.dump([`--file=${outputPath}`]);
  }

  async exportToBytes(): Promise<Uint8Array> {
    const dump = await this.dump([]);
    return new Uint8Array(dump.buffer, dump.byteOffset, dump.byteLength);
  }

  /** Runs pg_dump with these arguments after the connection, the format and the schema. */
  private async dump(extra: string[]): Promise<Buffer> {
    if (!this.connectionString) {
      throw new Error(this.options.missingConnection ?? 'PostgresExporter requires a connection string for pg_dump.');
    }
    const { dbname, env } = connectionOf(this.connectionString);
    const args = [`--dbname=${dbname}`, '--format=custom'];
    if (this.options.schema !== undefined) {
      // In double quotes pg_dump reads the name exactly: no case folding, and no pattern characters.
      args.push(`--schema="${this.options.schema.replace(/"/g, '""')}"`);
    }
    args.push(...extra);

    const { execFile } = await import('node:child_process');
    return new Promise<Buffer>((resolve, reject) => {
      execFile(
        'pg_dump',
        args,
        {
          encoding: 'buffer',
          maxBuffer: MAX_DUMP_BYTES,
          env: { ...(typeof process !== 'undefined' ? process.env : {}), ...env },
        },
        (error, stdout, stderr) => {
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
        },
      );
    });
  }
}
