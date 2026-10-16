import { describe, expect, it, beforeEach, vi } from 'vitest';

// PostgresExporter runs pg_dump. These specs read what it hands pg_dump: the
// arguments, each passed as it is with no shell between, and the environment.
// tests/postgres.exporter.spec.ts runs the real pg_dump against CI's PostgreSQL.

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
});
