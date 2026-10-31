import { describe, expect, it, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  connectDatabase,
  createDatabase,
  resolveStorageAdapter,
  StorageResolutionError,
  type StorageAdapter,
} from '../src/index.js';

// createDatabase() with a Postgres URL or Postgres options opens Postgres, with
// every option passed on to the pool; without one it opens the local default.
// The specs that need a server run when POSTGRES_TEST_URL names one (CI starts
// a Postgres service for them).

const POSTGRES_TEST_URL = process.env.POSTGRES_TEST_URL;

/** A Postgres URL nothing listens on. */
const UNREACHABLE_URL = 'postgresql://adapter:adapter@127.0.0.1:1/unreachable';

describe('createDatabase - choosing Postgres', () => {
  const adapters: StorageAdapter[] = [];
  const dirs: string[] = [];

  const keep = (adapter: StorageAdapter): StorageAdapter => {
    adapters.push(adapter);
    return adapter;
  };

  const tempFile = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'create-database-'));
    dirs.push(dir);
    return path.join(dir, 'app.sqlite3');
  };

  afterEach(async () => {
    for (const adapter of adapters.splice(0)) {
      await adapter.close().catch(() => undefined);
    }
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('fails when the Postgres URL it was given cannot be reached, instead of opening SQLite', async () => {
    let opened: StorageAdapter | undefined;
    let failure: unknown;
    try {
      opened = keep(await createDatabase({ url: UNREACHABLE_URL }));
    } catch (error) {
      failure = error;
    }

    expect(opened?.kind).toBeUndefined();
    expect(failure).toBeInstanceOf(StorageResolutionError);
  });

  it('opens the local default when the postgres option names no server', async () => {
    // createDatabase({ postgres: { connectionString: process.env.DATABASE_URL } })
    // with DATABASE_URL unset, as in development.
    const adapter = keep(await createDatabase({ postgres: { connectionString: undefined }, file: tempFile() }));

    expect(['better-sqlite3', 'sqljs']).toContain(adapter.kind);
  });

  it('does not move createDatabase({ file }) to Postgres when DATABASE_URL is set', async () => {
    // Stores that keep a local file run in processes where DATABASE_URL names
    // another database.
    vi.stubEnv('DATABASE_URL', UNREACHABLE_URL);

    const adapter = keep(await createDatabase({ file: tempFile() }));

    expect(['better-sqlite3', 'sqljs']).toContain(adapter.kind);
  });

  it('opens the local default for a URL that is not a PostgreSQL URL, as 0.6.13 did', async () => {
    // A Prisma-style DATABASE_URL in development.
    const adapter = keep(await createDatabase({ url: 'file:./dev.db', file: tempFile() }));

    expect(['better-sqlite3', 'sqljs']).toContain(adapter.kind);
  });

  it('refuses connectDatabase() options that name no server, and opens no local file', async () => {
    // connectDatabase({ connectionString: process.env.DATABASE_URL }) with the
    // variable unset. The resolver's default file lives under the working
    // directory, so the spec points that at a new folder.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'connect-database-'));
    dirs.push(cwd);
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);

    let failure: unknown;
    try {
      keep(await connectDatabase({ connectionString: undefined }));
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/no PostgreSQL server/);
    expect(fs.existsSync(path.join(cwd, 'db_data', 'app.sqlite3'))).toBe(false);
  });

  describe.skipIf(!POSTGRES_TEST_URL)('against a Postgres server', () => {
    const url = POSTGRES_TEST_URL as string;

    const setting = async (adapter: StorageAdapter, name: 'application_name' | 'statement_timeout'): Promise<string> => {
      const row = await adapter.get<Record<string, string>>(`SHOW ${name}`);
      return row?.[name] ?? '';
    };

    it('opens Postgres for createDatabase({ url })', async () => {
      const adapter = keep(await createDatabase({ url }));

      expect(adapter.kind).toBe('postgres');
      expect(await adapter.get<{ one: number }>('SELECT 1 AS one')).toEqual({ one: 1 });
    });

    it('opens Postgres for connectDatabase(url)', async () => {
      const adapter = keep(await connectDatabase(url));

      expect(adapter.kind).toBe('postgres');
    });

    it('passes the pool, timeout and application settings on to Postgres', async () => {
      const adapter = keep(
        await createDatabase({
          postgres: { connectionString: url, application_name: 'adapter-create-database', statement_timeout: 4321, max: 2 },
        }),
      );

      expect(adapter.kind).toBe('postgres');
      expect(await setting(adapter, 'application_name')).toBe('adapter-create-database');
      expect(await setting(adapter, 'statement_timeout')).toBe('4321ms');
    });

    it('passes them on through resolveStorageAdapter too', async () => {
      const adapter = keep(
        await resolveStorageAdapter({
          priority: ['postgres'],
          postgres: { connectionString: url, application_name: 'adapter-resolver', statement_timeout: 1234 },
          quiet: true,
        }),
      );

      expect(await setting(adapter, 'application_name')).toBe('adapter-resolver');
      expect(await setting(adapter, 'statement_timeout')).toBe('1234ms');
    });

    it('connects with host, port, database, user and password and no connection string', async () => {
      const parsed = new URL(url);
      const adapter = keep(
        await createDatabase({
          postgres: {
            host: parsed.hostname,
            port: Number(parsed.port || 5432),
            database: decodeURIComponent(parsed.pathname.slice(1)),
            user: decodeURIComponent(parsed.username),
            password: decodeURIComponent(parsed.password),
          },
        }),
      );

      expect(adapter.kind).toBe('postgres');
      expect(await adapter.get<{ one: number }>('SELECT 1 AS one')).toEqual({ one: 1 });
    });
  });
});
