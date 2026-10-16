import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PostgresExporter, pgDumpInvocation } from '../src/exporters/PostgresExporter';

// The exporter built pg_dump's command as one shell string, so a quote or a $(...) in the output path or the
// connection string ran as a command, and the password showed in the process list for as long as pg_dump ran.

/** A path that starts a second command when a shell reads it. */
const HOSTILE_PATH = '/tmp/x"; touch /tmp/pwned; echo "';

describe('pgDumpInvocation', () => {
  it('passes the path and the connection string as single arguments and the password in PGPASSWORD alone', () => {
    const { file, args, env } = pgDumpInvocation('postgresql://dump_user:p%40ss%20word@db.example:5432/app?sslmode=require', HOSTILE_PATH);
    expect(file).toBe('pg_dump');
    expect(args).toEqual(['--dbname=postgresql://dump_user@db.example:5432/app?sslmode=require', '--format=custom', `--file=${HOSTILE_PATH}`]);
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
    expect(pgDumpInvocation(keyword).args).toEqual([`--dbname=${keyword}`, '--format=custom']);
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

describe.skipIf(!process.env.POSTGRES_TEST_URL || !hasPgDump())('PostgresExporter against a PostgreSQL server', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes the dump to the literal path a shell would have split, and nothing runs', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-dump-'));
    dirs.push(dir);
    const marker = `pwned-${process.pid}-${Date.now()}`;
    const target = path.join(dir, `dump"; touch ${marker}; echo "$(touch ${marker}-sub).custom`);
    await new PostgresExporter(process.env.POSTGRES_TEST_URL).exportToFile(target);
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.statSync(target).size).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(process.cwd(), marker))).toBe(false);
    expect(fs.existsSync(path.join(process.cwd(), `${marker}-sub`))).toBe(false);
  });
});
