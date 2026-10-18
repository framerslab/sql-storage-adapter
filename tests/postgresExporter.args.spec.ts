import { describe, expect, it, afterAll, afterEach, beforeAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

// How a pool's password function is called follows the version of the pg this
// library loads. A spec that sets pgRead.as reads pg as that; the others read
// the pg installed.
const { pgRead } = vi.hoisted(() => ({
  pgRead: { as: null as null | { version?: string; Client?: unknown } },
}));

vi.mock('../src/exporters/pgModule.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/exporters/pgModule.js')>();
  return { ...actual, loadPg: async () => pgRead.as ?? actual.loadPg() };
});

import { Client as PgClient } from 'pg';
import { PostgresExporter } from '../src/exporters/PostgresExporter.js';
import { createStorageFeatures } from '../src/core/contracts/features.js';
import type { StorageAdapter } from '../src/core/contracts/index.js';
// pg's own reading of a pool's settings (pg exports ./lib/*).
// @ts-expect-error pg ships no declarations for its lib files.
import ConnectionParameters from 'pg/lib/connection-parameters.js';

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

/** What an export refused with, or null when it ran. */
const refusal = (run: Promise<unknown>): Promise<Error | null> =>
  run.then(
    () => null,
    (error: Error) => error,
  );

/** The variable pg reads the operating system's user name from. */
const USER_VARIABLE = process.platform === 'win32' ? 'USERNAME' : 'USER';

/** host, port, user and database of a URI the features exporter wrote, decoded. */
const partsOf = (uri: string): { user: string; host: string; port: number; database: string } => {
  const match = /^postgresql:\/\/(?:([^:@]*)(?::[^@]*)?@)?([^:/?]*):(\d+)\/([^?]*)(?:\?.*)?$/.exec(uri);
  if (!match) throw new Error(`not a URI the features exporter writes: ${uri}`);
  return {
    user: decodeURIComponent(match[1] ?? ''),
    host: decodeURIComponent(match[2]),
    port: Number(match[3]),
    database: decodeURIComponent(match[4]),
  };
};

describe('PostgresExporter', () => {
  beforeEach(() => {
    calls.length = 0;
    outcome.error = null;
    outcome.stderr = '';
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // Without a password, to a server that asks for one, pg_dump asks for it on
  // the terminal, or with no terminal on its standard input, which execFile
  // leaves open (pg_backup_db.c, ConnectDatabaseAhx; sprompt.c): the export
  // waited there for good.
  it('never lets pg_dump ask for a password: it runs with --no-password', async () => {
    await new PostgresExporter('postgresql://app@db.example/app').exportToBytes();
    await new PostgresExporter('host=db.example dbname=app').exportToFile('/backups/app.dump');

    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call.args).toContain('--no-password');
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

  it('leaves the password to the environment when the connection string holds none', async () => {
    for (const connectionString of [
      'postgresql://app@db.example/app',
      'postgresql://app:@db.example/app',
      'host=db.example dbname=app user=app',
      // pg_dump takes a string with no = that is not a URI for a database name.
      'app',
    ]) {
      calls.length = 0;
      await new PostgresExporter(connectionString).exportToBytes();

      expect(dbnameOf(calls[0].args)).toBe(connectionString);
      expect(calls[0].env.PGPASSWORD).toBe(process.env.PGPASSWORD);
    }
  });

  // A password that cannot be decoded cannot go to PGPASSWORD, and the URI that
  // holds it showed it in the process list for as long as pg_dump ran.
  it.each([
    ['a % not followed by two hex digits', 'postgresql://app:s3cr%zz@db.example/app'],
    ['a % at the end of the password', 'postgresql://app:s3cr%@db.example/app'],
    ['bytes that are not UTF-8', 'postgresql://app:s3cr%ff@db.example/app'],
    ['a password parameter', 'postgresql://app@db.example/app?password=s3cr%zz'],
  ])('refuses a password it cannot decode, with %s, before pg_dump starts', async (_name, connectionString) => {
    const failure = await refusal(new PostgresExporter(connectionString).exportToBytes());

    expect(failure?.message).toMatch(/password.*not valid percent-encoding/);
    expect(failure?.message).not.toContain('s3cr');
    expect(calls).toHaveLength(0);
  });

  // libpq refuses %00, and Node's own refusal of a NUL in an argument or an
  // environment variable repeats the value, password and all.
  it.each([
    ['a password that decodes to a NUL', 'postgresql://app:s3cr%00t@db.example/app'],
    ['a connection string that holds a NUL', 'host=db.example password=s3cr\u0000t'],
  ])('refuses %s before pg_dump starts', async (_name, connectionString) => {
    const failure = await refusal(new PostgresExporter(connectionString).exportToBytes());

    expect(failure?.message).toMatch(/NUL/);
    expect(failure?.message).not.toContain('s3cr');
    expect(calls).toHaveLength(0);
  });

  // libpq takes everything before the first @ that comes before any / as the
  // user part, a ? included (fe-connect.c, conninfo_uri_parse_options): pg_dump
  // reaches other.example as the user db.example?application_name=x, from the
  // string as given and from the string with its password taken out alike.
  it('reads a ? before the @ as libpq does, so the password libpq reads stays off the command line', async () => {
    await new PostgresExporter('postgresql://db.example?application_name=x:s3cret@other.example').exportToBytes();

    expect(dbnameOf(calls[0].args)).toBe('postgresql://db.example?application_name=x@other.example');
    expect(calls[0].env.PGPASSWORD).toBe('s3cret');
  });

  // libpq reads keyword=value settings too: a value runs to whitespace, or sits
  // in single quotes, and a backslash takes the character after it as it is.
  it.each([
    ['a bare value', 'host=db.example dbname=app user=app password=s3cret', 'host=db.example dbname=app user=app', 's3cret'],
    [
      'a quoted value with a space, a quote and a backslash',
      "host=db.example password='s3 cr\\'e\\\\t' dbname=app",
      'host=db.example  dbname=app',
      "s3 cr'e\\t",
    ],
    ['a backslash before a space in a bare value', 'password=s3cr\\ et host=db.example', 'host=db.example', 's3cr et'],
    ['spaces around the equals sign', 'password = s3cret host=db.example', 'host=db.example', 's3cret'],
    ['two passwords, of which libpq takes the later', 'password=s3cr-first host=db.example password=s3cret', 'host=db.example', 's3cret'],
    // After a closing quote libpq reads the next keyword at once, with no
    // space between, and a later value of a keyword replaces the earlier one
    // (fe-connect.c, conninfo_parse and conninfo_storeval): libpq reaches
    // other.example from the string as given and from the string with its
    // password taken out alike.
    [
      'a setting right after a quoted password, with no space between',
      "host=db.example password='s3cret'host=other.example dbname=app",
      'host=db.example host=other.example dbname=app',
      's3cret',
    ],
  ])('keeps the password of keyword=value settings off the command line, with %s', async (_name, connectionString, dbname, password) => {
    await new PostgresExporter(connectionString).exportToBytes();

    expect(dbnameOf(calls[0].args)).toBe(dbname);
    expect(calls[0].args.join(' ')).not.toContain('s3cr');
    expect(calls[0].env.PGPASSWORD).toBe(password);
  });

  // libpq reads PGPASSWORD only for a password the string leaves out
  // (fe-connect.c, conninfo_add_defaults): an empty password given in the
  // string is the password, and the environment's is never sent. An empty
  // PGPASSWORD is read the same way.
  it.each([
    ['an empty quoted password', "host=db.example password='' dbname=app", 'host=db.example  dbname=app'],
    ['an empty password at the end', 'host=db.example dbname=app password=', 'host=db.example dbname=app'],
    ['an empty password after a password', "password=s3cret host=db.example password=''", 'host=db.example'],
    ['an empty password parameter of a URI', 'postgresql://app@db.example/app?password=', 'postgresql://app@db.example/app'],
  ])("hands pg_dump an empty PGPASSWORD, not the environment's, for %s", async (_name, connectionString, dbname) => {
    vi.stubEnv('PGPASSWORD', 'ambient-secret');

    await new PostgresExporter(connectionString).exportToBytes();

    expect(dbnameOf(calls[0].args)).toBe(dbname);
    expect(calls[0].args.join(' ')).not.toContain('s3cr');
    expect(calls[0].env.PGPASSWORD).toBe('');
  });

  it.each([
    ['an unterminated quoted value', "host=db.example password='s3cret", /unterminated/],
    ['a setting with no =', 'host=db.example password=s3cr et', /no "="/],
  ])('refuses keyword=value settings libpq refuses, %s, before pg_dump starts', async (_name, connectionString, said) => {
    const failure = await refusal(new PostgresExporter(connectionString).exportToBytes());

    expect(failure?.message).toMatch(said);
    expect(failure?.message).not.toContain('s3cr');
    expect(calls).toHaveLength(0);
  });

  it('takes the connection string from a function that resolves it when the export runs', async () => {
    await new PostgresExporter(async () => 'postgresql://app:s3cret@db.example/app').exportToBytes();

    expect(dbnameOf(calls[0].args)).toBe('postgresql://app@db.example/app');
    expect(calls[0].env.PGPASSWORD).toBe('s3cret');
  });

  it('writes a scheme in upper case in lower case, which libpq alone reads, when the string holds no password', async () => {
    await new PostgresExporter('Postgres://app@db.example/app').exportToBytes();

    expect(dbnameOf(calls[0].args)).toBe('postgres://app@db.example/app');
    expect(calls[0].env.PGPASSWORD).toBe(process.env.PGPASSWORD);
  });

  it("fails with pg_dump's own words, and never with the command line that held the password", async () => {
    outcome.error = Object.assign(new Error('Command failed: pg_dump --dbname=postgresql://app:hunter2@db/app'), { code: 1 });
    outcome.stderr = 'pg_dump: error: connection to server failed: password authentication failed';

    const failure = await refusal(new PostgresExporter('postgresql://app:hunter2@db/app').exportToBytes());

    expect(failure?.message).toMatch(/password authentication failed/);
    expect(failure?.message).not.toContain('hunter2');
  });

  it('says so when pg_dump is not installed', async () => {
    outcome.error = Object.assign(new Error('spawn pg_dump ENOENT'), { code: 'ENOENT' });

    await expect(new PostgresExporter('postgresql://app@db/app').exportToBytes()).rejects.toThrow(/pg_dump was not found/);
  });

  // libpq reads sslrootcert=system as the system's certificate authorities
  // from PostgreSQL 16 on. An older libpq looks for a file named system, and
  // without it refuses verify-full (REL_15_STABLE fe-secure-openssl.c,
  // initialize_SSL), in these words.
  it('says what to do where the libpq of pg_dump is older than 16 and looks for a file named system', async () => {
    outcome.error = Object.assign(new Error('Command failed: pg_dump'), { code: 1 });
    outcome.stderr =
      'pg_dump: error: connection to server at "db.example" (192.0.2.10), port 5432 failed: ' +
      'root certificate file "system" does not exist\n' +
      'Either provide the file or change sslmode to disable server certificate verification.';

    const failure = await refusal(
      new PostgresExporter('postgresql://app@db.example/app?sslmode=verify-full&sslrootcert=system').exportToBytes(),
    );

    expect(failure?.message).toMatch(/root certificate file "system" does not exist/);
    expect(failure?.message).toMatch(/PostgreSQL 16 or later/);
    expect(failure?.message).toMatch(/sslrootcert parameter.*PGSSLROOTCERT/s);
  });
});

describe('createStorageFeatures exporter on PostgreSQL', () => {
  beforeEach(() => {
    calls.length = 0;
    outcome.error = null;
    outcome.stderr = '';
    // pg reads these where the settings leave a value out, and takes the user
    // name from the operating system's; each spec that needs one sets it.
    // They are removed, not emptied: libpq refuses an empty PGSSLMODE.
    for (const name of ['PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD', 'PGSSLMODE', 'PGSSLROOTCERT', 'USER', 'USERNAME']) {
      vi.stubEnv(name, undefined);
    }
    pgRead.as = null;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** The features exporter of an adapter on a pool of the caller made with these settings. */
  const poolExporter = (settings: Record<string, unknown>) =>
    createStorageFeatures(postgresAdapter({ pool: { options: settings } })).exporter;

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

  it('says what the pool lacks when a pool of the caller keeps no settings', async () => {
    const { exporter } = createStorageFeatures(postgresAdapter({ pool: {} }));

    await expect(exporter.exportToBytes()).rejects.toThrow(/pool its caller made/);
    expect(calls).toHaveLength(0);
  });

  // pg reads PGHOST, PGPORT, PGUSER and PGDATABASE where the settings leave
  // them out, then takes localhost, 5432, the operating system's user name and
  // the user's name for the database (pg lib/connection-parameters.js). The
  // export reaches the server pg reaches.
  it('reaches the server the environment names for a pool of the caller made without a host or a port', async () => {
    vi.stubEnv('PGHOST', 'env-host.example');
    vi.stubEnv('PGPORT', '6543');

    await poolExporter({ database: 'app', user: 'app' }).exportToBytes();

    expect(dbnameOf(calls[0].args)).toBe('postgresql://app@env-host.example:6543/app');
  });

  it('takes the user and the database the environment names, and the user name for the database, as pg does', async () => {
    vi.stubEnv('PGUSER', 'env-user');
    vi.stubEnv('PGDATABASE', 'env-db');
    await poolExporter({ host: 'db.example' }).exportToBytes();
    expect(dbnameOf(calls[0].args)).toBe('postgresql://env-user@db.example:5432/env-db');

    calls.length = 0;
    vi.stubEnv('PGUSER', '');
    vi.stubEnv('PGDATABASE', '');
    vi.stubEnv(USER_VARIABLE, 'os-user');
    await poolExporter({ host: 'db.example' }).exportToBytes();
    expect(dbnameOf(calls[0].args)).toBe('postgresql://os-user@db.example:5432/os-user');
  });

  it('reaches the database pg reaches for a pool of the caller made with no settings', async () => {
    vi.stubEnv(USER_VARIABLE, 'os-user');

    await poolExporter({}).exportToBytes();

    expect(dbnameOf(calls[0].args)).toBe('postgresql://os-user@localhost:5432/os-user');
  });

  it("keeps the adapter's own localhost and 5432 over PGHOST and PGPORT, as the pool it makes does", async () => {
    vi.stubEnv('PGHOST', 'env-host.example');
    vi.stubEnv('PGPORT', '6543');

    await createStorageFeatures(postgresAdapter({ database: 'app', user: 'app' })).exporter.exportToBytes();

    expect(dbnameOf(calls[0].args)).toBe('postgresql://app@localhost:5432/app');
  });

  // pg calls a password function for each connection it makes. The export
  // calls it when it runs, and hands its answer to pg_dump in PGPASSWORD.
  it('hands pg_dump the answer of the password function of a pool of the caller, asked when each export runs', async () => {
    let asked = 0;
    const seen: unknown[] = [];
    const exporter = poolExporter({
      host: 'db.example',
      database: 'app',
      user: 'app',
      password: async (parameters: unknown) => {
        seen.push(parameters);
        asked += 1;
        return `s3cret-token-${asked}`;
      },
    });

    await exporter.exportToBytes();
    await exporter.exportToBytes();

    expect(calls.map((call) => call.env.PGPASSWORD)).toEqual(['s3cret-token-1', 's3cret-token-2']);
    expect(calls.map((call) => call.args.join(' ')).join(' ')).not.toContain('s3cr');
    expect(seen[0]).toMatchObject({ host: 'db.example', port: 5432, user: 'app', database: 'app' });
  });

  // pg connects with no password where the password function answers none,
  // and reads no PGPASSWORD then (lib/client.js, _getPassword). pg_dump gets
  // an empty PGPASSWORD, so it sends the environment's no more than pg does.
  it.each([
    ['undefined', undefined],
    ['an empty string', ''],
  ])("hands pg_dump an empty PGPASSWORD, not the environment's, when the password function answers %s", async (_name, answer) => {
    vi.stubEnv('PGPASSWORD', 'ambient-secret');

    await poolExporter({ host: 'db.example', database: 'app', user: 'app', password: () => answer }).exportToBytes();

    expect(dbnameOf(calls[0].args)).toBe('postgresql://app@db.example:5432/app');
    expect(calls[0].env.PGPASSWORD).toBe('');
  });

  // A password the settings leave out, or give empty, pg reads from
  // PGPASSWORD, then ~/.pgpass, as libpq does.
  it('leaves PGPASSWORD to pg_dump where the pool gives no password, as pg reads it then', async () => {
    vi.stubEnv('PGPASSWORD', 'env-secret');

    await poolExporter({ host: 'db.example', database: 'app', user: 'app', password: '' }).exportToBytes();

    expect(dbnameOf(calls[0].args)).toBe('postgresql://app@db.example:5432/app');
    expect(calls[0].env.PGPASSWORD).toBe('env-secret');
  });

  it('refuses when the password function fails or answers with no string, before pg_dump starts', async () => {
    for (const password of [
      async () => {
        throw new Error('token service down');
      },
      async () => 42,
    ]) {
      const failure = await refusal(poolExporter({ host: 'db.example', database: 'app', password }).exportToBytes());

      expect(failure?.message).toMatch(/password function/);
    }
    expect(calls).toHaveLength(0);
  });

  // pg reads a connection string over the pool's other connection settings,
  // and the password it reads from one that holds none is empty, so a
  // password function beside it is never called.
  it('calls no password function beside a connection string, as pg calls none', async () => {
    const password = vi.fn(async () => 's3cret-token');

    await poolExporter({ connectionString: 'postgresql://app@db.example/app', password }).exportToBytes();

    expect(password).not.toHaveBeenCalled();
    expect(calls[0].env.PGPASSWORD).toBe(process.env.PGPASSWORD);
  });

  // pg calls a pool's password function as a method of the client it is
  // connecting (pg-pool newClient: new this.Client(this.options)), with no
  // arguments before 8.19.0 and from 8.19.0 with the client's
  // ConnectionParameters (node-postgres #3602; lib/client.js, _getPassword).
  it.each(['8.13.1', '8.18.0'])(
    'calls the password function with no arguments, on a client of the pool, where pg is %s, as that pg calls it',
    async (version) => {
      pgRead.as = { version, Client: PgClient };
      const seen: Array<{ self: unknown; args: unknown[] }> = [];
      const exporter = poolExporter({
        host: 'db.example',
        database: 'app',
        user: 'app',
        // A function written for pg before 8.19.0, which gives it no argument:
        // it reads the client it is called on, and an argument names another
        // secret, as when other code calls it.
        password: function (this: { user?: string } | undefined, ...args: unknown[]) {
          seen.push({ self: this, args });
          return args.length === 0 && this?.user === 'app' ? 'pool-secret' : 'another-secret';
        },
      });

      await exporter.exportToBytes();

      expect(seen).toHaveLength(1);
      expect(seen[0].args).toEqual([]);
      expect(seen[0].self).toBeInstanceOf(PgClient);
      expect(seen[0].self).toMatchObject({ user: 'app', database: 'app', host: 'db.example', port: 5432 });
      expect(calls[0].env.PGPASSWORD).toBe('pool-secret');
    },
  );

  it.each(['8.19.0', '8.23.1'])(
    "calls the password function with the client's ConnectionParameters, on that client, where pg is %s, as that pg calls it",
    async (version) => {
      pgRead.as = { version, Client: PgClient };
      const seen: Array<{ self: unknown; args: unknown[] }> = [];
      const settings = {
        host: 'db.example',
        database: 'app',
        user: 'app',
        application_name: 'reports',
        statement_timeout: 5000,
        password: function (this: unknown, ...args: unknown[]) {
          seen.push({ self: this, args });
          return 'pool-secret';
        },
      };

      await poolExporter(settings).exportToBytes();

      expect(seen).toHaveLength(1);
      expect(seen[0].self).toBeInstanceOf(PgClient);
      expect(seen[0].args).toHaveLength(1);
      expect(seen[0].args[0]).toBe((seen[0].self as { connectionParameters: unknown }).connectionParameters);
      expect(seen[0].args[0]).toBeInstanceOf(ConnectionParameters);
      expect(seen[0].args[0]).toEqual(new ConnectionParameters(settings));
      expect(seen[0].args[0]).toMatchObject({ host: 'db.example', port: 5432, user: 'app', application_name: 'reports' });
      expect(calls[0].env.PGPASSWORD).toBe('pool-secret');
    },
  );

  // pg calls a stream function of the settings to open a client's socket, as
  // a connector does (stream: () => tls.connect(...)): the client the export
  // makes for the password function never opens one.
  it("never calls the pool's stream function when it asks the password function", async () => {
    pgRead.as = { version: '8.23.1', Client: PgClient };
    const stream = vi.fn(() => {
      throw new Error('the export opened a socket');
    });

    await poolExporter({ host: 'db.example', database: 'app', user: 'app', stream, password: () => 'pool-secret' }).exportToBytes();

    expect(stream).not.toHaveBeenCalled();
    expect(calls[0].env.PGPASSWORD).toBe('pool-secret');
  });

  it("calls the password function with the connection's user, database, host and port where pg cannot be read", async () => {
    pgRead.as = {};
    const seen: unknown[][] = [];

    await poolExporter({
      host: 'db.example',
      database: 'app',
      user: 'app',
      password: (...args: unknown[]) => {
        seen.push(args);
        return 'pool-secret';
      },
    }).exportToBytes();

    expect(seen).toEqual([[{ user: 'app', database: 'app', host: 'db.example', port: 5432 }]]);
    expect(calls[0].env.PGPASSWORD).toBe('pool-secret');
  });

  // pg's TLS is Node's, which checks the server's certificate against Node's
  // certificate authorities, and its host name, unless rejectUnauthorized is
  // false. libpq checks a certificate with verify-ca or verify-full alone, the
  // host name with verify-full alone, and against a root certificate file or
  // the system's (sslrootcert=system, libpq 16 and later); its require checks
  // nothing without a root certificate file (fe-secure-openssl.c).
  it.each([
    ['ssl: true', true],
    ['an empty ssl object', {}],
    ['rejectUnauthorized: true', { rejectUnauthorized: true }],
  ])("has pg_dump check the server's certificate and host name, as pg does, with %s", async (_name, ssl) => {
    await poolExporter({ host: 'db.example', database: 'app', user: 'app', ssl }).exportToBytes();

    expect(dbnameOf(calls[0].args)).toBe('postgresql://app@db.example:5432/app?sslmode=verify-full&sslrootcert=system');
  });

  // libpq reads PGSSLMODE where the URI names no sslmode; pg reads none once
  // the settings set ssl.
  it.each(['verify-full', 'verify-ca', 'require', 'prefer'])(
    'has pg_dump check the server as pg does over a PGSSLMODE of %s, where the pool asks for TLS',
    async (sslmode) => {
      vi.stubEnv('PGSSLMODE', sslmode);

      await poolExporter({ host: 'db.example', database: 'app', user: 'app', ssl: true }).exportToBytes();

      expect(dbnameOf(calls[0].args)).toBe('postgresql://app@db.example:5432/app?sslmode=verify-full&sslrootcert=system');
    },
  );

  // pg reads PGSSLMODE prefer, require, verify-ca and verify-full as ssl: true
  // where the settings set no ssl (lib/connection-parameters.js,
  // readSSLConfigFromEnvironment), and Node's TLS then checks the server.
  it.each(['prefer', 'require', 'verify-ca', 'verify-full'])(
    'has pg_dump check the server as pg does for a PGSSLMODE of %s, where the pool sets no ssl',
    async (sslmode) => {
      vi.stubEnv('PGSSLMODE', sslmode);

      await poolExporter({ host: 'db.example', database: 'app', user: 'app' }).exportToBytes();

      expect(dbnameOf(calls[0].args)).toBe('postgresql://app@db.example:5432/app?sslmode=verify-full&sslrootcert=system');
    },
  );

  // PGSSLROOTCERT is libpq's alone: where it names a file, libpq checks the
  // server against it, as psql does.
  it('leaves the root certificate to PGSSLROOTCERT where it names one', async () => {
    vi.stubEnv('PGSSLROOTCERT', '/etc/ssl/private-ca.pem');

    await poolExporter({ host: 'db.example', database: 'app', user: 'app', ssl: true }).exportToBytes();

    expect(dbnameOf(calls[0].args)).toBe('postgresql://app@db.example:5432/app?sslmode=verify-full');
    expect(calls[0].env.PGSSLROOTCERT).toBe('/etc/ssl/private-ca.pem');
  });

  // pg refuses sslmode=verify-ca read as libpq reads it (uselibpqcompat=true)
  // where no root certificate names what to check the server against
  // (pg-connection-string index.js:125-130), so the pool makes no connection;
  // pg_dump, which PGSSLROOTCERT would give a root certificate, makes none
  // either.
  it('refuses, as pg does, sslmode=verify-ca with uselibpqcompat=true and no root certificate', async () => {
    const connectionString = 'postgresql://app@db.example/app?uselibpqcompat=true&sslmode=verify-ca';
    expect(() => new ConnectionParameters({ connectionString })).toThrow(/verify-ca requires specifying a CA/);
    vi.stubEnv('PGSSLROOTCERT', '/etc/ssl/private-ca.pem');

    const failure = await refusal(poolExporter({ connectionString }).exportToBytes());

    expect(failure?.message).toMatch(/sslmode=verify-ca.*sslrootcert/s);
    expect(calls).toHaveLength(0);
  });

  // What libpq is asked to check follows pg's own reading of the string, the
  // ssl of its ConnectionParameters: no TLS (disable), TLS that checks nothing
  // (require), the certificate alone, where pg's checkServerIdentity checks
  // nothing (verify-ca), or the certificate and the host name (verify-full),
  // against the root certificate the string names, which pg reads, else the
  // system's certificate authorities.
  describe("asks libpq to check what pg's own reading of a connection string checks", () => {
    let dir = '';
    let root = '';

    beforeAll(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-tls-parity-'));
      root = path.join(dir, 'root.pem');
      // pg reads the file's text, and leaves checking it to Node's TLS.
      fs.writeFileSync(root, 'ROOT PEM');
    });

    afterAll(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it.each([
      'sslmode=disable',
      'sslmode=prefer',
      'sslmode=require',
      'sslmode=verify-ca',
      'sslmode=verify-full',
      'sslmode=no-verify',
      'ssl=true',
      'ssl=0',
      'sslrootcert=ROOT',
      'sslmode=require&sslrootcert=ROOT',
      'sslmode=no-verify&sslrootcert=ROOT',
      'uselibpqcompat=true&sslmode=disable',
      'uselibpqcompat=true&sslmode=prefer',
      'uselibpqcompat=true&sslmode=require',
      'uselibpqcompat=true&sslmode=require&sslrootcert=ROOT',
      'uselibpqcompat=true&sslmode=verify-ca&sslrootcert=ROOT',
      'uselibpqcompat=true&sslmode=verify-full',
      'uselibpqcompat=true&sslmode=verify-full&sslrootcert=ROOT',
    ])('with %s', async (query) => {
      const connectionString = `postgresql://app@db.example/app?${query.replace('ROOT', encodeURIComponent(root))}`;
      const ssl = new ConnectionParameters({ connectionString }).ssl as
        | boolean
        | { rejectUnauthorized?: unknown; checkServerIdentity?: unknown };
      const named = query.includes('sslrootcert=ROOT') ? root : null;
      const expected = !ssl
        ? { sslmode: 'disable', sslrootcert: null }
        : typeof ssl === 'object' && ssl.rejectUnauthorized === false
          ? { sslmode: 'require', sslrootcert: named }
          : typeof ssl === 'object' && typeof ssl.checkServerIdentity === 'function'
            ? { sslmode: 'verify-ca', sslrootcert: named }
            : { sslmode: 'verify-full', sslrootcert: named ?? 'system' };

      await poolExporter({ connectionString }).exportToBytes();

      const written = new URL(dbnameOf(calls[0].args) as string).searchParams;
      expect({ sslmode: written.get('sslmode'), sslrootcert: written.get('sslrootcert') }).toEqual(expected);
    });
  });

  // pg_dump reads TLS material from files alone, and sslmode=require in their
  // place connected without the client certificate or checked no CA.
  it.each([
    ['a CA', { ca: ['CA ONE', Buffer.from('CA TWO')] }, /ssl settings ca cannot reach pg_dump/],
    ['a CA beside rejectUnauthorized: false', { ca: 'CA PEM', rejectUnauthorized: false }, /ssl settings ca cannot/],
    ['a client certificate and a key', { cert: Buffer.from('CERT PEM'), key: 'KEY PEM' }, /ssl settings cert, key cannot/],
    [
      'a pfx, its passphrase and a server name',
      { pfx: Buffer.from('x'), passphrase: 's3cret', servername: 'db.internal' },
      /ssl settings pfx, passphrase, servername cannot/,
    ],
  ])("refuses a pool's ssl with %s, naming the settings, before pg_dump starts", async (_name, ssl, said) => {
    const failure = await refusal(poolExporter({ host: 'db.example', database: 'app', ssl }).exportToBytes());

    expect(failure?.message).toMatch(said);
    expect(failure?.message).toMatch(/sslrootcert/);
    expect(failure?.message).not.toContain('s3cr');
    expect(calls).toHaveLength(0);
  });

  it('sees a key that pg-pool hides from enumeration', async () => {
    const ssl: Record<string, unknown> = { key: 'KEY PEM' };
    Object.defineProperty(ssl, 'key', { enumerable: false });

    const failure = await refusal(poolExporter({ host: 'db.example', database: 'app', ssl }).exportToBytes());

    expect(failure?.message).toMatch(/ssl settings key cannot/);
  });

  // pg makes no TLS connection when its ssl is false, or PGSSLMODE is a value
  // it does not know; libpq would read PGSSLMODE, refuse pg's no-verify and an
  // unknown value, and insist on TLS for require.
  it.each([
    ["pg's no-verify beside ssl: false", 'no-verify', false],
    ['require beside ssl: false', 'require', false],
    ['a value neither knows, with no ssl', 'sometimes', undefined],
  ])('connects without TLS where pg does, with %s', async (_name, sslmode, ssl) => {
    vi.stubEnv('PGSSLMODE', sslmode);

    await poolExporter({ host: 'db.example', database: 'app', user: 'app', ssl }).exportToBytes();

    expect(dbnameOf(calls[0].args)).toBe('postgresql://app@db.example:5432/app?sslmode=disable');
  });

  // pg reads PGSSLMODE only where neither the settings nor the connection
  // string set TLS (lib/connection-parameters.js). A pool that checks no
  // certificate connects to a server whose certificate libpq's verify-ca or
  // verify-full would refuse, so pg_dump gets require over them.
  it.each([
    ['rejectUnauthorized: false, beside PGSSLMODE verify-full', { ssl: { rejectUnauthorized: false } }, 'verify-full'],
    ['rejectUnauthorized: false, beside PGSSLMODE verify-ca', { ssl: { rejectUnauthorized: false } }, 'verify-ca'],
    [
      "pg's sslmode=no-verify, beside PGSSLMODE verify-full",
      { connectionString: 'postgresql://app@db.example/app?sslmode=no-verify' },
      'verify-full',
    ],
    [
      'sslmode=prefer with uselibpqcompat=true, which checks no certificate, beside PGSSLMODE verify-full',
      { connectionString: 'postgresql://app@db.example/app?uselibpqcompat=true&sslmode=prefer' },
      'verify-full',
    ],
    ['rejectUnauthorized: false, with no PGSSLMODE', { ssl: { rejectUnauthorized: false } }, undefined],
  ])('asks pg_dump for TLS that checks no certificate where the pool checks none, with %s', async (_name, settings, sslmode) => {
    if (sslmode !== undefined) vi.stubEnv('PGSSLMODE', sslmode);

    await poolExporter({ host: 'db.example', database: 'app', user: 'app', ...settings }).exportToBytes();

    expect(dbnameOf(calls[0].args)).toBe('postgresql://app@db.example:5432/app?sslmode=require');
  });

  // The pool's own choice of no TLS is pg's whatever PGSSLMODE says, where
  // libpq's prefer or allow would use TLS with a server that offers it.
  it.each([
    ['ssl: false beside PGSSLMODE prefer', { ssl: false }, 'prefer'],
    ['ssl: false beside PGSSLMODE allow', { ssl: false }, 'allow'],
    ['ssl: false and no PGSSLMODE', { ssl: false }, undefined],
    ["the connection string's ssl=0 beside PGSSLMODE prefer", { connectionString: 'postgresql://app@db.example/app?ssl=0' }, 'prefer'],
  ])('connects pg_dump without TLS where the pool chose none, with %s', async (_name, settings, sslmode) => {
    if (sslmode !== undefined) vi.stubEnv('PGSSLMODE', sslmode);

    await poolExporter({ host: 'db.example', database: 'app', user: 'app', ...settings }).exportToBytes();

    expect(dbnameOf(calls[0].args)).toBe('postgresql://app@db.example:5432/app?sslmode=disable');
  });

  // Where pg uses no TLS by default (no ssl in the settings or the string, and
  // no PGSSLMODE pg reads as TLS), libpq's default, prefer, and a PGSSLMODE of
  // disable or allow connect where pg connects, and stay. pg reads an empty
  // PGSSLMODE as no TLS, and libpq refuses it.
  it.each([
    ['no PGSSLMODE', undefined, ''],
    ['PGSSLMODE disable', 'disable', ''],
    ['PGSSLMODE allow', 'allow', ''],
    ['an empty PGSSLMODE', '', '?sslmode=disable'],
  ])('leaves TLS to libpq where pg uses none by default, with %s, unless libpq refuses it', async (_name, sslmode, query) => {
    if (sslmode !== undefined) vi.stubEnv('PGSSLMODE', sslmode);

    await poolExporter({ host: 'db.example', database: 'app', user: 'app' }).exportToBytes();

    expect(dbnameOf(calls[0].args)).toBe(`postgresql://app@db.example:5432/app${query}`);
  });

  it("reads PGSSLMODE as pg does where the pool sets no ssl: pg's no-verify is libpq's require", async () => {
    vi.stubEnv('PGSSLMODE', 'no-verify');

    await poolExporter({ host: 'db.example', database: 'app', user: 'app' }).exportToBytes();

    expect(dbnameOf(calls[0].args)).toBe('postgresql://app@db.example:5432/app?sslmode=require');
  });

  it("applies the pool's ssl beside a connection string that sets no TLS of its own, as pg does", async () => {
    await poolExporter({ connectionString: 'postgresql://app@db.example/app', ssl: { rejectUnauthorized: false } }).exportToBytes();
    expect(dbnameOf(calls[0].args)).toBe('postgresql://app@db.example:5432/app?sslmode=require');

    // The string's sslmode makes pg's ssl anew, without the settings' ca
    // (pg-connection-string index.js:77-79): Node's own authorities check it.
    calls.length = 0;
    await poolExporter({
      connectionString: 'postgresql://app@db.example/app?sslmode=verify-full',
      ssl: { ca: 'CA PEM' },
    }).exportToBytes();
    expect(dbnameOf(calls[0].args)).toBe('postgresql://app@db.example:5432/app?sslmode=verify-full&sslrootcert=system');
  });

  // pg reads a pool's connection string as a WHATWG URL (pg-connection-string),
  // and libpq by its own grammar. The export hands pg_dump the string written
  // so that libpq reads the parts pg reads.
  it.each([
    ['an @ in the password, where pg reads to the last @ of the authority', 'postgresql://app:p@ss@db.example/app', 'postgresql://app@db.example:5432/app', 'p@ss'],
    [
      'an @ in a parameter of a string with no path, where libpq would read the host after it',
      'postgresql://db.example?application_name=x@y',
      'postgresql://app@db.example:5432/app?application_name=x%40y',
      undefined,
    ],
    ['no host, where pg takes localhost', 'postgresql:///app', 'postgresql://app@localhost:5432/app', undefined],
    ['credentials and no host', 'postgresql://app:s3cret@/app', 'postgresql://app@localhost:5432/app', 's3cret'],
    [
      'a host parameter and no host',
      'postgresql:///app?host=/var/run/postgresql',
      'postgresql://app@%2Fvar%2Frun%2Fpostgresql:5432/app',
      undefined,
    ],
    ['a fragment, which pg drops', 'postgresql://app@db.example/app#note', 'postgresql://app@db.example:5432/app', undefined],
    ['a % that starts no escape, which pg reads as itself', 'postgresql://app:50%off@db.example/app', 'postgresql://app@db.example:5432/app', '50%off'],
    ["pg's sslmode=no-verify, libpq's require", 'postgresql://app@db.example/app?sslmode=no-verify', 'postgresql://app@db.example:5432/app?sslmode=require', undefined],
    ["pg's ssl=1", 'postgresql://app@db.example/app?ssl=1', 'postgresql://app@db.example:5432/app?sslmode=verify-full&sslrootcert=system', undefined],
    // Without uselibpqcompat=true, pg-connection-string makes ssl {} of
    // require, verify-ca and verify-full alike (index.js:139-152), and Node's
    // TLS checks the certificate and the host name.
    [
      'sslmode=require, which pg reads as a check of the server',
      'postgresql://app@db.example/app?sslmode=require',
      'postgresql://app@db.example:5432/app?sslmode=verify-full&sslrootcert=system',
      undefined,
    ],
    [
      'sslmode=verify-ca, which pg reads as a check of the host name too',
      'postgresql://app@db.example/app?sslmode=verify-ca',
      'postgresql://app@db.example:5432/app?sslmode=verify-full&sslrootcert=system',
      undefined,
    ],
    // With uselibpqcompat=true, verify-ca, and require beside a root
    // certificate, check the certificate and no host name (index.js:116-133).
    [
      'uselibpqcompat=true with verify-ca and a root certificate',
      'postgresql://app@db.example/app?uselibpqcompat=true&sslmode=verify-ca&sslrootcert=/etc/ssl/ca.pem',
      'postgresql://app@db.example:5432/app?sslrootcert=%2Fetc%2Fssl%2Fca.pem&sslmode=verify-ca',
      undefined,
    ],
    [
      'uselibpqcompat=true with require beside a root certificate',
      'postgresql://app@db.example/app?uselibpqcompat=true&sslmode=require&sslrootcert=/etc/ssl/ca.pem',
      'postgresql://app@db.example:5432/app?sslrootcert=%2Fetc%2Fssl%2Fca.pem&sslmode=verify-ca',
      undefined,
    ],
    [
      'uselibpqcompat=true with verify-full and a root certificate',
      'postgresql://app@db.example/app?uselibpqcompat=true&sslmode=verify-full&sslrootcert=/etc/ssl/ca.pem',
      'postgresql://app@db.example:5432/app?sslrootcert=%2Fetc%2Fssl%2Fca.pem&sslmode=verify-full',
      undefined,
    ],
    ["pg's ssl=0", 'postgresql://app@db.example/app?ssl=0', 'postgresql://app@db.example:5432/app?sslmode=disable', undefined],
    [
      "pg's uselibpqcompat and statement_timeout, which libpq does not know",
      'postgresql://app@db.example/app?uselibpqcompat=true&statement_timeout=5000&application_name=reports',
      'postgresql://app@db.example:5432/app?application_name=reports',
      undefined,
    ],
    [
      'a certificate file, which turns pg\'s TLS on and is what it checks the server against',
      'postgresql://app@db.example/app?sslrootcert=/etc/ssl/ca.pem',
      'postgresql://app@db.example:5432/app?sslrootcert=%2Fetc%2Fssl%2Fca.pem&sslmode=verify-full',
      undefined,
    ],
    // pg-connection-string turns TLS on for a certificate file over ssl=0
    // (index.js:77-79).
    [
      "pg's ssl=0 beside a certificate file, which turns pg's TLS on again",
      'postgresql://app@db.example/app?ssl=0&sslrootcert=/etc/ssl/ca.pem',
      'postgresql://app@db.example:5432/app?sslrootcert=%2Fetc%2Fssl%2Fca.pem&sslmode=verify-full',
      undefined,
    ],
    // pg uses TLS for any sslmode but disable; libpq refuses one it does not know.
    [
      'an sslmode libpq does not know, with which pg uses TLS that checks the server',
      'postgresql://app@db.example/app?sslmode=sometimes',
      'postgresql://app@db.example:5432/app?sslmode=verify-full&sslrootcert=system',
      undefined,
    ],
    // pg decodes the URL's user name only where no user parameter is given.
    [
      'a user parameter beside a user name that is not valid UTF-8, which pg never decodes',
      'postgresql://ba%ffd@db.example/app?user=app',
      'postgresql://app@db.example:5432/app',
      undefined,
    ],
    // libpq reads these from the connection string alone, pg_dump's command
    // line, and pg reads none of them.
    [
      'secrets pg does not read',
      'postgresql://app@db.example/app?sslpassword=s3cr1&oauth_client_secret=s3cr2&scram_client_key=s3cr3&application_name=reports',
      'postgresql://app@db.example:5432/app?application_name=reports',
      undefined,
    ],
  ])('reads the connection string of a pool as pg does, with %s', async (_name, connectionString, dbname, password) => {
    vi.stubEnv('PGUSER', 'app');

    await poolExporter({ connectionString }).exportToBytes();

    expect(dbnameOf(calls[0].args)).toBe(dbname);
    expect(calls[0].env.PGPASSWORD).toBe(password ?? process.env.PGPASSWORD);
  });

  it('reaches the host PGHOST names for a connection string with no host, as pg does', async () => {
    vi.stubEnv('PGHOST', 'env-host.example');

    await poolExporter({ connectionString: 'postgresql://app@/app' }).exportToBytes();

    expect(dbnameOf(calls[0].args)).toBe('postgresql://app@env-host.example:5432/app');
  });

  // pg-connection-string 2.14.1 copies the query's parameters, then sets the
  // database from the URL's path alone, null without one (index.js:40-42,
  // 66-67): pg reads no database parameter, and reaches PGDATABASE, then the
  // user's name. It reads an empty host parameter as none and keeps the URL's
  // host (index.js:54-56), whatever PGHOST says.
  it.each([
    ['a database parameter and no path', 'postgresql://db.example?database=reports', 'postgresql://app@db.example:5432/env-db'],
    ['a database parameter and an empty path', 'postgresql://app@db.example/?database=reports', 'postgresql://app@db.example:5432/env-db'],
    ['an empty host parameter', 'postgresql://app@url-host.example/app?host=', 'postgresql://app@url-host.example:5432/app'],
  ])('reaches the database and the host pg reaches, with %s', async (_name, connectionString, dbname) => {
    vi.stubEnv('PGUSER', 'app');
    vi.stubEnv('PGDATABASE', 'env-db');
    vi.stubEnv('PGHOST', 'env-host.example');

    await poolExporter({ connectionString }).exportToBytes();

    expect(dbnameOf(calls[0].args)).toBe(dbname);
  });

  // pg's own reading of a connection string, its ConnectionParameters given
  // the same string and environment, names the host, the port, the user and
  // the database the URI pg_dump gets names.
  it.each([
    ['postgresql://db.example?database=reports'],
    ['postgresql://app@db.example/?database=reports'],
    ['postgresql://app@url-host.example/app?host='],
    ['postgresql://app@/app?host='],
    ['postgresql://db.example?application_name=x@y'],
    ['postgresql://app:p@ss@db.example/app'],
    ['postgresql:///app?host=/var/run/postgresql'],
    ['postgresql://[::1]:6543/app'],
    ['postgresql://app@db.example:5433/app?port=6000'],
    ['postgresql://app@db.example:5433/app?port='],
    ['postgresql://app@db.example/app?user=other'],
    ['postgresql://%61pp@db.example/r%C3%A9ports'],
    ['socket:/var/run/postgresql?db=app'],
    ['/var/run/postgresql app'],
  ])("names the host, the port, the user and the database pg's own reading names, for %s", async (connectionString) => {
    vi.stubEnv('PGUSER', 'env-user');
    vi.stubEnv('PGDATABASE', 'env-db');
    vi.stubEnv('PGHOST', 'env-host.example');
    vi.stubEnv('PGPORT', '6432');
    const pg = new ConnectionParameters({ connectionString });

    await poolExporter({ connectionString }).exportToBytes();

    expect(partsOf(dbnameOf(calls[0].args) as string)).toEqual({
      user: pg.user,
      host: pg.host,
      port: pg.port,
      database: pg.database,
    });
  });

  it('passes keyword=value settings of a pool as they are, for libpq to read', async () => {
    await poolExporter({ connectionString: 'host=db.example dbname=app user=app password=s3cret' }).exportToBytes();

    expect(dbnameOf(calls[0].args)).toBe('host=db.example dbname=app user=app');
    expect(calls[0].env.PGPASSWORD).toBe('s3cret');
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

    expect(dbnameOf(calls[0].args)).toBe('postgresql://app@db.example:5432/app');
    expect(calls[0].env.PGPASSWORD).toBe('s3cret');
    expect(calls[0].args).toContain('--schema="agentos"');
  });

  it('prefers the pool the adapter runs on to the settings it was made with', async () => {
    const adapter = Object.assign(postgresAdapter({ connectionString: 'postgresql://app@made.example/app' }), {
      getPool: () => ({ options: { connectionString: 'postgresql://app@opened.example/app' } }),
    });

    await createStorageFeatures(adapter).exporter.exportToBytes();

    expect(dbnameOf(calls[0].args)).toBe('postgresql://app@opened.example:5432/app');
  });

  it('says what the adapter lacks when nothing names its database', async () => {
    const adapter = Object.assign(postgresAdapter({ segment: 'agentos' }), { getPool: () => null });

    await expect(createStorageFeatures(adapter).exporter.exportToBytes()).rejects.toThrow(/names no database/);
    expect(calls).toHaveLength(0);
  });
});
