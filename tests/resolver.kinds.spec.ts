import { describe, expect, it, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveStorageAdapter, StorageResolutionError, type AdapterKind, type StorageAdapter } from '../src/index.js';

// The adapter kinds a priority list (or STORAGE_ADAPTER) may name. The resolver
// builds postgres, better-sqlite3, capacitor, indexeddb and sqljs, and builds
// sql.js for memory, which hosts pass at the end of their browser lists. A kind
// it cannot build fails as a candidate with an error that names it, and the
// resolver goes on to the next one.

describe('Resolver - adapter kinds', () => {
  const dirs: string[] = [];
  const adapters: StorageAdapter[] = [];

  const tempFile = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-kinds-'));
    dirs.push(dir);
    return path.join(dir, 'app.sqlite3');
  };

  const resolve = async (priority: string[]): Promise<StorageAdapter> => {
    const adapter = await resolveStorageAdapter({
      priority: priority as AdapterKind[],
      filePath: tempFile(),
      quiet: true,
    });
    adapters.push(adapter);
    return adapter;
  };

  /** The error the resolver threw, which carries each candidate's failure. */
  const resolutionError = async (resolution: Promise<unknown>): Promise<StorageResolutionError> => {
    try {
      const adapter = await resolution;
      adapters.push(adapter as StorageAdapter);
    } catch (error) {
      expect(error).toBeInstanceOf(StorageResolutionError);
      return error as StorageResolutionError;
    }
    throw new Error('the resolver built an adapter');
  };

  afterEach(async () => {
    for (const adapter of adapters.splice(0)) {
      await adapter.close().catch(() => undefined);
    }
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it.each(['electron-main', 'electron-renderer', 'supabase', 'sqlite'])(
    'refuses %s with an error that names it',
    async (kind) => {
      const error = await resolutionError(resolve([kind]));

      expect(error.causes).toHaveLength(1);
      expect(String((error.causes[0] as Error).message)).toContain(`"${kind}"`);
    },
  );

  it('goes on to the next candidate after a kind it cannot build', async () => {
    const adapter = await resolve(['electron-main', 'sqljs']);

    expect(adapter.kind).toBe('sqljs');
  });

  it('builds sql.js for memory, as it did before', async () => {
    const adapter = await resolve(['memory']);

    expect(adapter.kind).toBe('sqljs');
    await adapter.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    await adapter.run('INSERT INTO t (id) VALUES (1)');
    expect(await adapter.all('SELECT id FROM t')).toEqual([{ id: 1 }]);
  });

  it('resolves the browser list hosts pass, with memory last', async () => {
    // No IndexedDB in Node, so the list falls through to sql.js.
    const adapter = await resolve(['indexeddb', 'sqljs', 'memory']);

    expect(adapter.kind).toBe('sqljs');
  });

  it('refuses a STORAGE_ADAPTER kind it cannot build, naming it', async () => {
    vi.stubEnv('STORAGE_ADAPTER', 'electron-main');

    const error = await resolutionError(resolveStorageAdapter({ filePath: tempFile(), quiet: true }));

    expect(String((error.causes[0] as Error).message)).toContain('"electron-main"');
  });
});
