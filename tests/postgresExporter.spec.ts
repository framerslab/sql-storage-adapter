import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgresExporter, pgDumpInvocation } from '../src/exporters/PostgresExporter';

// The exporter built pg_dump's command as one shell string, so a quote or a $(...) in the output path or the
// connection string ran as a command, and the password showed in the process list for as long as pg_dump ran.

/** A path that starts a second command when a shell reads it. */
const HOSTILE_PATH = '/tmp/x"; touch /tmp/pwned; echo "';

describe('pgDumpInvocation', () => {
  it('passes the path and the connection string as single arguments and the password in PGPASSWORD alone', () => {
    const { file, args, env } = pgDumpInvocation('postgresql://dump_user:p%40ss%20word@db.example:5432/app?sslmode=require', HOSTILE_PATH);
    expect(file).toBe('pg_dump');
    expect(args).toEqual([
      '--dbname=postgresql://dump_user@db.example:5432/app?sslmode=require',
      '--format=custom',
      '--no-password',
      `--file=${HOSTILE_PATH}`,
    ]);
    expect(env.PGPASSWORD).toBe('p@ss word');
    for (const arg of args) {
      expect(arg).not.toContain('p@ss');
      expect(arg).not.toContain('p%40ss');
    }
  });

  it('leaves PGPASSWORD as the environment had it when the URL holds no password, and passes a keyword string whole', () => {
    const before = process.env.PGPASSWORD;
    expect(pgDumpInvocation('postgres://reader@db.example/app').env.PGPASSWORD).toBe(before);
    const keyword = 'host=db.example dbname=app user=reader';
    expect(pgDumpInvocation(keyword).args).toEqual([`--dbname=${keyword}`, '--format=custom', '--no-password']);
  });
});

describe('PostgresExporter starts pg_dump without a shell', () => {
  afterEach(() => {
    vi.doUnmock('node:child_process');
    vi.resetModules();
  });

  it('hands execFile the program and an argument array, so a hostile path is one argument and no shell runs', async () => {
    const calls: Array<{ file: string; args: string[]; options: Record<string, unknown> }> = [];
    vi.doMock('node:child_process', () => ({
      execFile: (file: string, args: string[], options: Record<string, unknown>, done: (error: Error | null, stdout: Buffer) => void) => {
        calls.push({ file, args, options });
        done(null, Buffer.from([1, 2, 3]));
      },
    }));
    const { PostgresExporter: Fresh } = await import('../src/exporters/PostgresExporter');
    const exporter = new Fresh('postgresql://dump_user:secret@db.example/app');
    await exporter.exportToFile(HOSTILE_PATH);
    expect(await exporter.exportToBytes()).toEqual(new Uint8Array([1, 2, 3]));
    expect(calls.map((call) => call.file)).toEqual(['pg_dump', 'pg_dump']);
    expect(calls[0]!.args).toContain(`--file=${HOSTILE_PATH}`);
    for (const call of calls) {
      expect(call.options.shell).toBeUndefined();
      expect(call.args.join(' ')).not.toContain('secret');
      expect((call.options.env as NodeJS.ProcessEnv).PGPASSWORD).toBe('secret');
    }
  });
});

/** Whether a pg_dump binary answers on this machine. */
function hasPgDump(): boolean {
  try {
    execFileSync('pg_dump', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// pg_dump reads every table of the database it dumps, and the other spec files create and drop tables in the test
// database while this one runs: a table dropped between pg_dump's catalog read and its LOCK TABLE fails the dump with
// "relation ... does not exist". So the dump reads a database of its own, made here and dropped after.
describe.skipIf(!process.env.POSTGRES_TEST_URL || !hasPgDump())('PostgresExporter against a PostgreSQL server', () => {
  const dirs: string[] = [];
  const database = `dump_${process.pid}_${Math.random().toString(36).slice(2, 10)}`;
  let admin: pg.Client | undefined;
  let databaseUrl = '';

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: process.env.POSTGRES_TEST_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${database}`);
    const parsed = new URL(process.env.POSTGRES_TEST_URL as string);
    parsed.pathname = `/${database}`;
    databaseUrl = parsed.toString();
    const own = new pg.Client({ connectionString: databaseUrl });
    await own.connect();
    try {
      await own.query('CREATE TABLE exported_rows (id INTEGER PRIMARY KEY, label TEXT NOT NULL)');
      await own.query("INSERT INTO exported_rows (id, label) VALUES (1, 'kept')");
    } finally {
      await own.end();
    }
  });

  afterAll(async () => {
    if (admin === undefined) return;
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  });

  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes the dump to the literal path a shell would have split, and nothing runs', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-dump-'));
    dirs.push(dir);
    const marker = `pwned-${process.pid}-${Date.now()}`;
    const target = path.join(dir, `dump"; touch ${marker}; echo "$(touch ${marker}-sub).custom`);
    await new PostgresExporter(databaseUrl).exportToFile(target);
    expect(fs.existsSync(target)).toBe(true);
    // the custom format keeps each object's definition as plain text beside the compressed data
    expect(fs.readFileSync(target).toString('latin1')).toContain('CREATE TABLE public.exported_rows');
    expect(fs.existsSync(path.join(process.cwd(), marker))).toBe(false);
    expect(fs.existsSync(path.join(process.cwd(), `${marker}-sub`))).toBe(false);
  });

  // After a closing quote libpq reads the next keyword at once, with no space
  // between, and a later host replaces the earlier one (fe-connect.c,
  // conninfo_parse and conninfo_storeval). pg_dump given the settings as they
  // are reaches the server the later host names, and the export, which takes
  // the quoted password out for PGPASSWORD, reaches the same one.
  it('reaches, as libpq reads them, the host of a setting right after a quoted password', async () => {
    const url = new URL(databaseUrl);
    const quoted = decodeURIComponent(url.password).replace(/[\\']/g, '\\$&');
    const settings =
      `host=unreachable.invalid password='${quoted}'host=${url.hostname} port=${url.port || '5432'} ` +
      `user=${decodeURIComponent(url.username)} dbname=${database}`;

    const schema = execFileSync('pg_dump', [`--dbname=${settings}`, '--schema-only', '--no-password', '--table=exported_rows'], {
      encoding: 'utf8',
      env: { ...process.env, PGPASSWORD: '' },
    });
    expect(schema).toContain('CREATE TABLE public.exported_rows');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-dump-'));
    dirs.push(dir);
    const target = path.join(dir, 'after-quote.custom');
    await new PostgresExporter(settings).exportToFile(target);
    expect(fs.readFileSync(target).toString('latin1')).toContain('CREATE TABLE public.exported_rows');
  });
});
