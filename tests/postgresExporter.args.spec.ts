import { describe, expect, it, beforeEach, vi } from 'vitest';

// PostgresExporter runs pg_dump. These specs read what it hands pg_dump: the
// arguments, each passed as it is with no shell between, and the environment.
// tests/postgres.exporter.spec.ts runs the real pg_dump against CI's PostgreSQL
// for segments and pools, and tests/postgresExporter.spec.ts pins
// pgDumpInvocation() and a path no shell may split.

const { calls, outcome } = vi.hoisted(() => ({
  calls: [] as Array<{ file: string; args: string[]; env: Record<string, string | undefined> }>,
  outcome: { error: null as (Error & { code?: string | number }) | null, stderr: '' },
}));

vi.mock('node:child_process', () => ({
  execFile: (
    file: string,
    args: string[],
    options: { env?: Record<string, string | undefined> },
    callback: (error: Error | null, stdout: Buffer, stderr: Buffer) => void,
  ) => {
    calls.push({ file, args, env: options.env ?? {} });
    callback(outcome.error, Buffer.from('PGDMP'), Buffer.from(outcome.stderr));
  },
}));

import { PostgresExporter } from '../src/exporters/PostgresExporter.js';
import { createStorageFeatures } from '../src/core/contracts/features.js';
import type { StorageAdapter } from '../src/core/contracts/index.js';

/** An adapter of kind postgres with these options, as createStorageFeatures reads one. */
const postgresAdapter = (options: Record<string, unknown>): StorageAdapter =>
  ({
    kind: 'postgres',
    capabilities: new Set(),
    open: async () => {},
    run: async () => ({ changes: 0 }),
    get: async () => null,
    all: async () => [],
    exec: async () => {},
    transaction: async (fn: (trx: StorageAdapter) => Promise<unknown>) => fn({} as StorageAdapter),
    close: async () => {},
    options,
  }) as unknown as StorageAdapter;

/** The one --dbname argument of the last pg_dump run. */
const dbnameOf = (args: string[]): string | undefined =>
  args.find((arg) => arg.startsWith('--dbname='))?.slice('--dbname='.length);

describe('PostgresExporter', () => {
  beforeEach(() => {
    calls.length = 0;
    outcome.error = null;
    outcome.stderr = '';
  });

  it('runs pg_dump with the schema it was given, in the custom format', async () => {
    const exporter = new PostgresExporter('postgresql://app@db.example:5432/app', { schema: 'agentos' });

    expect(await exporter.exportToBytes()).toEqual(new Uint8Array(Buffer.from('PGDMP')));

    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe('pg_dump');
    expect(calls[0].args).toContain('--format=custom');
    expect(calls[0].args).toContain('--schema="agentos"');
    expect(dbnameOf(calls[0].args)).toBe('postgresql://app@db.example:5432/app');
  });

  it('exports the whole database without a schema, and writes a file where it is told', async () => {
    await new PostgresExporter('postgresql://app@db.example/app').exportToFile('/backups/a "quoted" name.dump');

    expect(calls[0].args.some((arg) => arg.startsWith('--schema'))).toBe(false);
    expect(calls[0].args).toContain('--file=/backups/a "quoted" name.dump');
  });

  it('keeps the password off the command line, in PGPASSWORD', async () => {
    await new PostgresExporter('postgresql://app:s3cr%40t@db.example:5432/app?sslmode=require').exportToBytes();

    expect(calls[0].args.join(' ')).not.toContain('s3cr');
    expect(dbnameOf(calls[0].args)).toBe('postgresql://app@db.example:5432/app?sslmode=require');
    expect(calls[0].env.PGPASSWORD).toBe('s3cr@t');
  });

  // pg_dump reads a URI as libpq does: the user part runs to the first @ that
  // comes before any /, and a password parameter after the path wins over the
  // user part's password. The WHATWG URL parser reads several of these
  // differently, or refuses them.
  it.each([
    [
      'an empty host and a socket directory as a parameter',
      'postgresql://app:s3cret@/app?host=/var/run/postgresql',
      'postgresql://app@/app?host=/var/run/postgresql',
      's3cret',
    ],
    [
      'several hosts',
      'postgresql://app:s3cret@one.example:5432,two.example:5433/app',
      'postgresql://app@one.example:5432,two.example:5433/app',
      's3cret',
    ],
    ['a # and a ? in the password', 'postgresql://app:s3cr#t?@db.example/app', 'postgresql://app@db.example/app', 's3cr#t?'],
    ['no user name', 'postgres://:s3cret@db.example/app', 'postgres://db.example/app', 's3cret'],
    [
      'a password parameter',
      'postgresql://app@db.example/app?sslmode=require&password=s3cr%26t',
      'postgresql://app@db.example/app?sslmode=require',
      's3cr&t',
    ],
    [
      'a password parameter and a password in the user part',
      'postgresql://app:s3cr-user@db.example/app?password=s3cret',
      'postgresql://app@db.example/app',
      's3cret',
    ],
    // pg reads the scheme in any case, libpq in lower case alone.
    ['a scheme in upper case', 'POSTGRESQL://app:s3cret@db.example/app', 'postgresql://app@db.example/app', 's3cret'],
  ])('keeps the password off the command line with %s', async (_name, connectionString, dbname, password) => {
    await new PostgresExporter(connectionString).exportToBytes();

    expect(dbnameOf(calls[0].args)).toBe(dbname);
    expect(calls[0].args.join(' ')).not.toContain('s3cr');
    expect(calls[0].env.PGPASSWORD).toBe(password);
  });

  it('leaves the password to the environment when the connection string holds none, or one libpq cannot decode', async () => {
    for (const connectionString of [
      'postgresql://app@db.example/app',
      'postgresql://app:@db.example/app',
      'postgresql://app:s3cr%zz@db.example/app',
      'host=db.example dbname=app user=app',
    ]) {
      calls.length = 0;
      await new PostgresExporter(connectionString).exportToBytes();

      expect(dbnameOf(calls[0].args)).toBe(connectionString);
      expect(calls[0].env.PGPASSWORD).toBe(process.env.PGPASSWORD);
    }
  });

  it('writes a scheme in upper case in lower case, which libpq alone reads, when the string holds no password', async () => {
    await new PostgresExporter('Postgres://app@db.example/app').exportToBytes();

    expect(dbnameOf(calls[0].args)).toBe('postgres://app@db.example/app');
    expect(calls[0].env.PGPASSWORD).toBe(process.env.PGPASSWORD);
  });

  it("fails with pg_dump's own words, and never with the command line that held the password", async () => {
    outcome.error = Object.assign(new Error('Command failed: pg_dump --dbname=postgresql://app:hunter2@db/app'), { code: 1 });
    outcome.stderr = 'pg_dump: error: connection to server failed: password authentication failed';

    const failure = await new PostgresExporter('postgresql://app:hunter2@db/app').exportToBytes().then(
      () => null,
      (error: Error) => error,
    );

    expect(failure?.message).toMatch(/password authentication failed/);
    expect(failure?.message).not.toContain('hunter2');
  });

  it('says so when pg_dump is not installed', async () => {
    outcome.error = Object.assign(new Error('spawn pg_dump ENOENT'), { code: 'ENOENT' });

    await expect(new PostgresExporter('postgresql://app@db/app').exportToBytes()).rejects.toThrow(/pg_dump was not found/);
  });
});

describe('createStorageFeatures exporter on PostgreSQL', () => {
  beforeEach(() => {
    calls.length = 0;
    outcome.error = null;
    outcome.stderr = '';
  });

  it("exports a segmented adapter's segment alone", async () => {
    const { exporter } = createStorageFeatures(
      postgresAdapter({ connectionString: 'postgresql://app@db.example/app', segment: 'agentos' }),
    );

    await exporter.exportToBytes();

    expect(calls[0].args).toContain('--schema="agentos"');
  });

  it('reaches the database a pool of the caller was made for, by its connection string', async () => {
    const pool = { options: { connectionString: 'postgresql://app:pool-secret@db.example:5432/app' } };
    const { exporter } = createStorageFeatures(postgresAdapter({ pool }));

    await exporter.exportToBytes();

    expect(dbnameOf(calls[0].args)).toBe('postgresql://app@db.example:5432/app');
    expect(calls[0].env.PGPASSWORD).toBe('pool-secret');
  });

  it('reaches the database a pool of the caller was made for, by its host, database, user and password', async () => {
    const pool = { options: { host: 'db.example', port: 6543, database: 'app', user: 'app', password: 'pool-secret' } };
    const { exporter } = createStorageFeatures(postgresAdapter({ pool }));

    await exporter.exportToBytes();

    expect(dbnameOf(calls[0].args)).toBe('postgresql://app@db.example:6543/app');
    expect(calls[0].env.PGPASSWORD).toBe('pool-secret');
  });

  it('says what the pool lacks when a pool of the caller names no database', async () => {
    const { exporter } = createStorageFeatures(postgresAdapter({ pool: { options: {} } }));

    await expect(exporter.exportToBytes()).rejects.toThrow(/pool its caller made/);
    expect(calls).toHaveLength(0);
  });

  it('writes a Unix-socket directory as libpq reads a host in a URI', async () => {
    const { exporter } = createStorageFeatures(postgresAdapter({ host: '/var/run/postgresql', database: 'app', user: 'app' }));

    await exporter.exportToBytes();

    expect(dbnameOf(calls[0].args)).toBe('postgresql://app@%2Fvar%2Frun%2Fpostgresql:5432/app');
  });

  it('gives PGPASSWORD a password set with no user name', async () => {
    const { exporter } = createStorageFeatures(postgresAdapter({ host: 'db.example', database: 'app', password: 's3cret' }));

    await exporter.exportToBytes();

    expect(dbnameOf(calls[0].args)).toBe('postgresql://db.example:5432/app');
    expect(calls[0].env.PGPASSWORD).toBe('s3cret');
  });

  // open({ connectionString }) makes the adapter's pool from a connection
  // string its options do not hold, after its features may have been made.
  it('reaches the database of the pool the adapter runs on, read when the export runs', async () => {
    let live: { options: Record<string, unknown> } | null = null;
    const adapter = Object.assign(postgresAdapter({ segment: 'agentos' }), { getPool: () => live });
    const { exporter } = createStorageFeatures(adapter);
    live = {
      options: { connectionString: 'postgresql://app:s3cret@db.example/app', options: '-c search_path=agentos,public' },
    };

    await exporter.exportToBytes();

    expect(dbnameOf(calls[0].args)).toBe('postgresql://app@db.example/app');
    expect(calls[0].env.PGPASSWORD).toBe('s3cret');
    expect(calls[0].args).toContain('--schema="agentos"');
  });

  it('prefers the pool the adapter runs on to the settings it was made with', async () => {
    const adapter = Object.assign(postgresAdapter({ connectionString: 'postgresql://app@made.example/app' }), {
      getPool: () => ({ options: { connectionString: 'postgresql://app@opened.example/app' } }),
    });

    await createStorageFeatures(adapter).exporter.exportToBytes();

    expect(dbnameOf(calls[0].args)).toBe('postgresql://app@opened.example/app');
  });

  it('says what the adapter lacks when nothing names its database', async () => {
    const adapter = Object.assign(postgresAdapter({ segment: 'agentos' }), { getPool: () => null });

    await expect(createStorageFeatures(adapter).exporter.exportToBytes()).rejects.toThrow(/names no database/);
    expect(calls).toHaveLength(0);
  });
});
