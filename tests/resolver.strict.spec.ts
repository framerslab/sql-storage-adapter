import { describe, expect, it, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createDatabase,
  resolveStorageAdapter,
  StorageResolutionError,
  type StorageAdapter,
} from '../src/index.js';

// Strict resolution, for servers: a configured Postgres that cannot open fails
// instead of falling through to a local SQLite file, and an explicit file path
// outranks DATABASE_URL. Without strict, both behave as before. The specs that
// need a server run when POSTGRES_TEST_URL names one (CI starts a Postgres
// service for them).

const POSTGRES_TEST_URL = process.env.POSTGRES_TEST_URL;

/** A Postgres URL nothing listens on. */
const UNREACHABLE_URL = 'postgresql://adapter:adapter@127.0.0.1:1/unreachable';

const LOCAL_KINDS = ['better-sqlite3', 'sqljs'];

describe('strict resolution', () => {
  const adapters: StorageAdapter[] = [];
  const dirs: string[] = [];

  const keep = (adapter: StorageAdapter): StorageAdapter => {
    adapters.push(adapter);
    return adapter;
  };

  const tempDir = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strict-resolution-'));
    dirs.push(dir);
    return dir;
  };

  /**
   * Points the resolver's working directory at a new folder and returns the
   * path of the default SQLite file there, so a fallback to it can be seen.
   */
  const defaultFileInTempCwd = (): string => {
    const dir = tempDir();
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    return path.join(dir, 'db_data', 'app.sqlite3');
  };

  /** What a call settles to: the adapter it opened, or the error it threw. */
  const settle = async (open: () => Promise<StorageAdapter>): Promise<{ adapter?: StorageAdapter; error?: unknown }> => {
    try {
      return { adapter: keep(await open()) };
    } catch (error) {
      return { error };
    }
  };

  /** The resolver's warnings that name the postgres candidate. */
  const postgresWarnings = (warn: { mock: { calls: unknown[][] } }): string[] =>
    warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('postgres'));

  afterEach(async () => {
    for (const adapter of adapters.splice(0)) {
      await adapter.close().catch(() => undefined);
    }
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('resolveStorageAdapter', () => {
    it('fails when DATABASE_URL names a server it cannot reach, and opens no local file', async () => {
      const defaultFile = defaultFileInTempCwd();
      vi.stubEnv('DATABASE_URL', UNREACHABLE_URL);

      const { adapter, error } = await settle(() => resolveStorageAdapter({ strict: true, quiet: true }));

      expect(adapter?.kind).toBeUndefined();
      expect(error).toBeInstanceOf(StorageResolutionError);
      expect((error as StorageResolutionError).causes).toHaveLength(1);
      expect(fs.existsSync(defaultFile)).toBe(false);
    });

    it('without strict, falls back to the local file when DATABASE_URL cannot be reached, as before', async () => {
      defaultFileInTempCwd();
      vi.stubEnv('DATABASE_URL', UNREACHABLE_URL);

      const adapter = keep(await resolveStorageAdapter({ quiet: true }));

      expect(LOCAL_KINDS).toContain(adapter.kind);
    });

    it('does not try the candidates after a postgres candidate that fails, whatever the priority lists', async () => {
      const file = path.join(tempDir(), 'app.sqlite3');

      const { adapter, error } = await settle(() =>
        resolveStorageAdapter({
          strict: true,
          priority: ['postgres', 'better-sqlite3', 'sqljs'],
          postgres: { connectionString: UNREACHABLE_URL },
          filePath: file,
          quiet: true,
        }),
      );

      expect(adapter?.kind).toBeUndefined();
      expect(error).toBeInstanceOf(StorageResolutionError);
      expect((error as StorageResolutionError).causes).toHaveLength(1);
      expect(fs.existsSync(file)).toBe(false);
    });

    it('fails when the postgres option names no server and DATABASE_URL is unset, instead of opening the local default', async () => {
      const defaultFile = defaultFileInTempCwd();
      vi.stubEnv('DATABASE_URL', '');

      const { adapter, error } = await settle(() =>
        resolveStorageAdapter({ strict: true, postgres: { max: 2 }, quiet: true }),
      );

      expect(adapter?.kind).toBeUndefined();
      expect(error).toBeInstanceOf(StorageResolutionError);
      expect(String((error as StorageResolutionError).causes[0])).toMatch(/connection string/);
      expect(fs.existsSync(defaultFile)).toBe(false);
    });

    it('opens an explicit file path without trying DATABASE_URL', async () => {
      const file = path.join(tempDir(), 'app.sqlite3');
      vi.stubEnv('DATABASE_URL', UNREACHABLE_URL);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      vi.spyOn(console, 'info').mockImplementation(() => undefined);

      const adapter = keep(await resolveStorageAdapter({ strict: true, filePath: file }));

      expect(LOCAL_KINDS).toContain(adapter.kind);
      expect(postgresWarnings(warn)).toEqual([]);
    });

    it('without strict, still tries DATABASE_URL before an explicit file path, as before', async () => {
      const file = path.join(tempDir(), 'app.sqlite3');
      vi.stubEnv('DATABASE_URL', UNREACHABLE_URL);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      vi.spyOn(console, 'info').mockImplementation(() => undefined);

      const adapter = keep(await resolveStorageAdapter({ filePath: file }));

      expect(LOCAL_KINDS).toContain(adapter.kind);
      expect(postgresWarnings(warn)).toHaveLength(1);
    });

    it('opens the file when the postgres option names no server and a file path is given', async () => {
      const file = path.join(tempDir(), 'app.sqlite3');
      vi.stubEnv('DATABASE_URL', UNREACHABLE_URL);

      const adapter = keep(
        await resolveStorageAdapter({ strict: true, postgres: { max: 2 }, filePath: file, quiet: true }),
      );

      expect(LOCAL_KINDS).toContain(adapter.kind);
    });
  });

  describe('createDatabase', () => {
    it('fails when the url option is empty, instead of opening the local default', async () => {
      const defaultFile = defaultFileInTempCwd();

      const { adapter, error } = await settle(() => createDatabase({ url: '', strict: true }));

      expect(adapter?.kind).toBeUndefined();
      expect(error).toBeInstanceOf(StorageResolutionError);
      expect(String((error as Error).message)).toMatch(/url/);
      expect(fs.existsSync(defaultFile)).toBe(false);
    });

    it('fails when the postgres option names no server, instead of opening the local default', async () => {
      const defaultFile = defaultFileInTempCwd();

      const { adapter, error } = await settle(() =>
        createDatabase({ postgres: { connectionString: undefined, max: 4 }, strict: true }),
      );

      expect(adapter?.kind).toBeUndefined();
      expect(error).toBeInstanceOf(StorageResolutionError);
      expect(String((error as Error).message)).toMatch(/postgres/);
      expect(fs.existsSync(defaultFile)).toBe(false);
    });

    it('without strict, an empty url still opens the local default, as before', async () => {
      defaultFileInTempCwd();

      const adapter = keep(await createDatabase({ url: '' }));

      expect(LOCAL_KINDS).toContain(adapter.kind);
    });

    it('opens the file it is given when the url option is empty', async () => {
      const file = path.join(tempDir(), 'app.sqlite3');

      const adapter = keep(await createDatabase({ url: undefined, file, strict: true }));

      expect(LOCAL_KINDS).toContain(adapter.kind);
    });

    it('passes strict on to the resolver, so a priority with fallbacks stops at a failed postgres', async () => {
      const file = path.join(tempDir(), 'app.sqlite3');

      const { adapter, error } = await settle(() =>
        createDatabase({ url: UNREACHABLE_URL, file, priority: ['postgres', 'better-sqlite3'], strict: true }),
      );

      expect(adapter?.kind).toBeUndefined();
      expect(error).toBeInstanceOf(StorageResolutionError);
      expect(fs.existsSync(file)).toBe(false);
    });
  });

  describe.skipIf(!POSTGRES_TEST_URL)('against a Postgres server', () => {
    const url = POSTGRES_TEST_URL as string;

    it('opens Postgres from DATABASE_URL', async () => {
      vi.stubEnv('DATABASE_URL', url);

      const adapter = keep(await resolveStorageAdapter({ strict: true, quiet: true }));

      expect(adapter.kind).toBe('postgres');
      expect(await adapter.get<{ one: number }>('SELECT 1 AS one')).toEqual({ one: 1 });
    });

    it('opens an explicit file path instead of the server DATABASE_URL names', async () => {
      vi.stubEnv('DATABASE_URL', url);
      const file = path.join(tempDir(), 'app.sqlite3');

      const strict = keep(await resolveStorageAdapter({ strict: true, filePath: file, quiet: true }));
      const loose = keep(await resolveStorageAdapter({ filePath: path.join(tempDir(), 'loose.sqlite3'), quiet: true }));

      expect(LOCAL_KINDS).toContain(strict.kind);
      // Without strict, DATABASE_URL still comes first, as before.
      expect(loose.kind).toBe('postgres');
    });

    it('opens Postgres for createDatabase({ url, strict })', async () => {
      const adapter = keep(await createDatabase({ url, strict: true }));

      expect(adapter.kind).toBe('postgres');
    });
  });
});
