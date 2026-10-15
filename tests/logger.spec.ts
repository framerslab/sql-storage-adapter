import { describe, expect, it, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PostgresAdapter,
  createDatabase,
  createPostgresAdapter,
  resolveStorageAdapter,
  setStorageLogger,
  type StorageAdapter,
  type StorageLogger,
} from '../src/index.js';

// A host routes the library's log lines to its own logger (pino's fits as it
// is): setStorageLogger() for every line, or `logger` on createDatabase() and
// resolveStorageAdapter() for that call's resolver lines. Without one the lines
// go to the console, as before. The Postgres spec runs when POSTGRES_TEST_URL
// names a server (CI starts a Postgres service for it).

const POSTGRES_TEST_URL = process.env.POSTGRES_TEST_URL;

/** A Postgres URL nothing listens on. */
const UNREACHABLE_URL = 'postgresql://adapter:adapter@127.0.0.1:1/unreachable';

type Line = { level: 'debug' | 'info' | 'warn' | 'error'; fields: Record<string, unknown>; message: string };

/** A logger that keeps what it is given, as pino would write it. */
const recordingLogger = (): StorageLogger & { lines: Line[] } => {
  const lines: Line[] = [];
  const at =
    (level: Line['level']) =>
    (fields: Record<string, unknown>, message: string): void => {
      lines.push({ level, fields, message });
    };
  return { lines, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
};

describe('the host logger', () => {
  const opened: StorageAdapter[] = [];
  const dirs: string[] = [];

  const tempFile = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-logger-'));
    dirs.push(dir);
    return path.join(dir, 'app.sqlite3');
  };

  afterEach(async () => {
    setStorageLogger(null);
    for (const db of opened.splice(0)) await db.close().catch(() => undefined);
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('takes the resolver lines from setStorageLogger(), with fields, instead of the console', async () => {
    const logger = recordingLogger();
    setStorageLogger(logger);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.stubEnv('DATABASE_URL', UNREACHABLE_URL);

    opened.push(await resolveStorageAdapter({ filePath: tempFile() }));

    const fallback = logger.lines.find((line) => line.level === 'warn');
    expect(fallback?.fields).toMatchObject({ adapter: 'postgres' });
    expect(fallback?.message).toMatch(/postgres not available, trying next/);
    expect(logger.lines.find((line) => line.level === 'info')?.fields).toMatchObject({ adapter: 'better-sqlite3' });
    expect(warn).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it('takes one call\'s resolver lines from its logger option, through createDatabase too', async () => {
    const global = recordingLogger();
    const own = recordingLogger();
    setStorageLogger(global);

    opened.push(await createDatabase({ file: tempFile(), priority: ['postgres', 'better-sqlite3'], url: UNREACHABLE_URL, logger: own }));

    expect(own.lines.some((line) => line.level === 'warn' && line.fields.adapter === 'postgres')).toBe(true);
    expect(global.lines).toEqual([]);
  });

  it('writes to the console again after setStorageLogger(null), as it always has', async () => {
    setStorageLogger(recordingLogger());
    setStorageLogger(null);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    opened.push(await resolveStorageAdapter({ priority: ['better-sqlite3'], filePath: tempFile() }));

    expect(info).toHaveBeenCalledWith('[StorageAdapter] Using adapter "better-sqlite3".');
  });

  it('stays quiet when quiet is set, whatever the logger', async () => {
    const logger = recordingLogger();
    setStorageLogger(logger);

    opened.push(await resolveStorageAdapter({ priority: ['better-sqlite3'], filePath: tempFile(), quiet: true }));

    expect(logger.lines).toEqual([]);
  });

  it.skipIf(!POSTGRES_TEST_URL)('takes the Postgres adapter\'s ROLLBACK warning', async () => {
    const logger = recordingLogger();
    setStorageLogger(logger);
    const url = POSTGRES_TEST_URL as string;
    const other = createPostgresAdapter(url);
    await other.open();
    opened.push(other);
    const adapter = new PostgresAdapter({ connectionString: url, max: 1 });
    await adapter.open();
    opened.push(adapter);

    await adapter
      .transaction(async (trx) => {
        const pid = (await trx.get<{ pid: number }>('SELECT pg_backend_pid() AS pid'))!.pid;
        await other.get('SELECT pg_terminate_backend($1)', [pid]);
        for (let i = 0; i < 200; i += 1) {
          if (!(await other.get('SELECT 1 AS alive FROM pg_stat_activity WHERE pid = $1', [pid]))) break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error('the callback failed');
      })
      .catch(() => undefined);

    const line = logger.lines.find((entry) => entry.level === 'warn');
    expect(line?.message).toMatch(/ROLLBACK failed/);
    expect(line?.fields).toMatchObject({ adapter: 'postgres' });
  });
});
