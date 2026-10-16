import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IDBFactory } from 'fake-indexeddb';
import {
  CapacitorSqliteAdapter,
  IndexedDbAdapter,
  createBetterSqliteAdapter,
  createDatabase,
  createSqlJsAdapter,
  resolveStorageAdapter,
  segmentFilePath,
  segmentName,
  type StorageAdapter,
} from '../src/index';
import { createElectronMainAdapter } from '../src/adapters/electron/electronMainAdapter';

// A segment keeps one user's tables apart from another's: on the SQLite family
// a database file of its own, on IndexedDB and Capacitor a database name of its
// own. tests/postgres.segment.spec.ts covers PostgreSQL, where it is a schema.

const { capacitorNames, ipc } = vi.hoisted(() => ({
  capacitorNames: [] as string[],
  ipc: { initialized: [] as unknown[], disposed: 0 },
}));

// @capacitor-community/sqlite is an optional peer that CI does not install; the
// adapter loads it in open(), and this stands in for it: the native plugin,
// CapacitorSQLite, and the plugin's SQLiteConnection over it, which makes the
// connections (tests/capacitorSqliteAdapter.open.spec.ts keeps the native rules).
vi.mock('@capacitor-community/sqlite', () => ({
  CapacitorSQLite: {},
  SQLiteConnection: class {
    async createConnection(name: string) {
      capacitorNames.push(name);
      return {
        open: async () => undefined,
        close: async () => undefined,
        execute: async () => ({ changes: { changes: 0 } }),
        run: async () => ({ changes: { changes: 0, lastId: 0 } }),
        query: async () => ({ values: [] }),
      };
    }

    async closeConnection() {
      return undefined;
    }
  },
}));

// The Electron main adapter reaches Electron's BrowserWindow and ipcMain; this
// suite runs it on Node, where neither exists.
vi.mock('electron', () => ({
  app: {},
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => undefined, removeHandler: () => undefined },
}));
vi.mock('../src/adapters/electron/ipc/protocol', () => ({
  initializeIpcProtocol: (adapter: unknown) => {
    ipc.initialized.push(adapter);
  },
  disposeIpcProtocol: () => {
    ipc.disposed += 1;
  },
}));

describe('segment names', () => {
  it('puts the segment before the extension of a file name', () => {
    expect(segmentFilePath('/data/app.sqlite3', 'agentos')).toBe('/data/app-agentos.sqlite3');
    expect(segmentFilePath('C:\\data\\app.db', 'agentos')).toBe('C:\\data\\app-agentos.db');
    expect(segmentFilePath('db_data/archive.tar.db', 'agentos')).toBe('db_data/archive.tar-agentos.db');
    expect(segmentFilePath('notes', 'agentos')).toBe('notes-agentos');
    expect(segmentFilePath('/data/.store', 'agentos')).toBe('/data/.store-agentos');
  });

  it('keeps the query of a file: URI and leaves in-memory databases alone', () => {
    expect(segmentFilePath('file:data/app.db?mode=ro', 'agentos')).toBe('file:data/app-agentos.db?mode=ro');
    expect(segmentFilePath(':memory:', 'agentos')).toBe(':memory:');
    expect(segmentFilePath('file::memory:?cache=shared', 'agentos')).toBe('file::memory:?cache=shared');
  });

  it('changes nothing without a segment', () => {
    expect(segmentFilePath('/data/app.sqlite3', undefined)).toBe('/data/app.sqlite3');
    expect(segmentName('app-db', undefined)).toBe('app-db');
  });

  it('appends the segment to a database name', () => {
    expect(segmentName('app-db', 'agentos')).toBe('app-db-agentos');
  });

  it.each(['', 'AgentOS', 'agent-os', 'agent os', '1agent', 'pg_agent', 'public', 'information_schema', 'a'.repeat(64)])(
    'refuses %j as a segment name',
    (name) => {
      expect(() => segmentName('app', name)).toThrow(/segment/i);
      expect(() => segmentFilePath('/data/app.db', name)).toThrow(/segment/i);
    },
  );

  it('takes lower-case letters, digits and underscores up to 63 characters', () => {
    expect(segmentName('app', '_agentos_2')).toBe('app-_agentos_2');
    expect(segmentName('app', 'a'.repeat(63))).toBe(`app-${'a'.repeat(63)}`);
  });
});

describe('a segment on each adapter', () => {
  const adapters: StorageAdapter[] = [];
  const dirs: string[] = [];

  const keep = <T extends StorageAdapter>(adapter: T): T => {
    adapters.push(adapter);
    return adapter;
  };

  const tempDir = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'segment-'));
    dirs.push(dir);
    return dir;
  };

  const writeOneRow = async (adapter: StorageAdapter, label: string): Promise<void> => {
    await adapter.exec('CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, label TEXT NOT NULL)');
    await adapter.run('INSERT INTO items (label) VALUES (?)', [label]);
  };

  const labels = async (adapter: StorageAdapter): Promise<string[]> =>
    (await adapter.all<{ label: string }>('SELECT label FROM items ORDER BY id')).map((row) => row.label);

  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    capacitorNames.length = 0;
    ipc.initialized.length = 0;
    ipc.disposed = 0;
  });

  afterEach(async () => {
    for (const adapter of adapters.splice(0)) {
      await adapter.close().catch(() => undefined);
    }
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('better-sqlite3 opens a file of its own', async () => {
    const dir = tempDir();
    const adapter = keep(createBetterSqliteAdapter(path.join(dir, 'app.sqlite3'), { segment: 'agentos' }));
    await adapter.open();
    await writeOneRow(adapter, 'in the segment');
    await adapter.close();

    expect(fs.existsSync(path.join(dir, 'app-agentos.sqlite3'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'app.sqlite3'))).toBe(false);
  });

  it('better-sqlite3 applies the segment to a path given to open()', async () => {
    const dir = tempDir();
    const adapter = keep(createBetterSqliteAdapter(path.join(dir, 'default.sqlite3'), { segment: 'agentos' }));
    await adapter.open({ filePath: path.join(dir, 'given.sqlite3') });
    await writeOneRow(adapter, 'x');
    await adapter.close();

    expect(fs.existsSync(path.join(dir, 'given-agentos.sqlite3'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'given.sqlite3'))).toBe(false);
  });

  it('sql.js saves to a file of its own', async () => {
    const dir = tempDir();
    const adapter = keep(createSqlJsAdapter({ segment: 'agentos' }));
    await adapter.open({ filePath: path.join(dir, 'app.sqlite3') });
    await writeOneRow(adapter, 'in the segment');
    await adapter.close();

    expect(fs.existsSync(path.join(dir, 'app-agentos.sqlite3'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'app.sqlite3'))).toBe(false);
  });

  // ':memory:' is SQLite's name for a database of the connection alone; sql.js
  // wrote it to a file of that name in the working directory, which every
  // in-memory instance, of any segment, then shared.
  it('sql.js keeps an in-memory database in memory and writes no file named :memory:', async () => {
    const stray = path.join(process.cwd(), ':memory:');
    try {
      const first = keep(createSqlJsAdapter({ segment: 'first' }));
      await first.open({ filePath: ':memory:' });
      await writeOneRow(first, 'first');
      await first.close();

      const second = keep(createSqlJsAdapter({ segment: 'second' }));
      await second.open({ filePath: ':memory:' });
      await second.exec('CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, label TEXT NOT NULL)');

      expect(await labels(second)).toEqual([]);
      expect(fs.existsSync(stray)).toBe(false);
    } finally {
      fs.rmSync(stray, { force: true });
    }
  });

  it('IndexedDB opens a database of its own', async () => {
    const adapter = keep(new IndexedDbAdapter({ dbName: 'notes', segment: 'agentos', autoSave: false }));
    await adapter.open();
    await writeOneRow(adapter, 'in the segment');
    await adapter.close();

    const names = (await indexedDB.databases()).map((database) => database.name);
    expect(names).toContain('notes-agentos');
    expect(names).not.toContain('notes');

    const reopened = keep(new IndexedDbAdapter({ dbName: 'notes', segment: 'agentos', autoSave: false }));
    await reopened.open();
    expect(await labels(reopened)).toEqual(['in the segment']);
  });

  it('IndexedDB keeps two segments of one database name apart', async () => {
    const first = keep(new IndexedDbAdapter({ dbName: 'notes', segment: 'first', autoSave: false }));
    const second = keep(new IndexedDbAdapter({ dbName: 'notes', segment: 'second', autoSave: false }));
    await first.open();
    await second.open();
    await writeOneRow(first, 'first');
    await writeOneRow(second, 'second');

    expect(await labels(first)).toEqual(['first']);
    expect(await labels(second)).toEqual(['second']);
  });

  it('Capacitor opens a database of its own', async () => {
    const adapter = keep(new CapacitorSqliteAdapter({ database: 'app', segment: 'agentos', enableWal: false }));
    await adapter.open();

    expect(capacitorNames).toEqual(['app-agentos']);
  });

  it('Capacitor applies the segment to a database name given to open()', async () => {
    const adapter = keep(new CapacitorSqliteAdapter({ segment: 'agentos', enableWal: false }));
    await adapter.open({ adapterOptions: { database: 'given' } });

    expect(capacitorNames).toEqual(['given-agentos']);
  });

  it('the Electron main adapter opens a file of its own and names it', async () => {
    const dir = tempDir();
    const adapter = keep(
      createElectronMainAdapter({
        filePath: path.join(dir, 'app.db'),
        segment: 'agentos',
        wal: { enabled: false },
        recovery: { enabled: false },
      }),
    );
    await adapter.open();
    await writeOneRow(adapter, 'in the segment');

    expect(adapter.getFilePath()).toBe(path.join(dir, 'app-agentos.db'));
    expect(fs.existsSync(path.join(dir, 'app-agentos.db'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'app.db'))).toBe(false);
  });

  // The renderer's IPC channels are one set per process. A main adapter takes
  // them when it opens and removes them when it closes, so a segmented adapter
  // opened beside the app's own would take the app's windows over to its
  // segment, and closing it would cut them off.
  it('leaves the renderer channels to the Electron main adapter without a segment', async () => {
    const dir = tempDir();
    const app = keep(
      createElectronMainAdapter({ filePath: path.join(dir, 'app.db'), wal: { enabled: false }, recovery: { enabled: false } }),
    );
    const segmented = keep(
      createElectronMainAdapter({
        filePath: path.join(dir, 'app.db'),
        segment: 'agentos',
        wal: { enabled: false },
        recovery: { enabled: false },
      }),
    );
    await app.open();
    await segmented.open();
    await segmented.close();

    expect(ipc.initialized).toEqual([app]);
    expect(ipc.disposed).toBe(0);
  });

  it('refuses a segment name the adapter cannot use, when it is made', () => {
    expect(() => createBetterSqliteAdapter('/tmp/app.db', { segment: 'Bad Name' })).toThrow(/segment/i);
    expect(() => createSqlJsAdapter({ segment: 'Bad Name' })).toThrow(/segment/i);
    expect(() => new IndexedDbAdapter({ segment: 'Bad Name' })).toThrow(/segment/i);
    expect(() => new CapacitorSqliteAdapter({ segment: 'Bad Name' })).toThrow(/segment/i);
  });
});

describe('a segment through createDatabase and the resolver', () => {
  const adapters: StorageAdapter[] = [];
  const dirs: string[] = [];

  const tempDir = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'segment-resolve-'));
    dirs.push(dir);
    return dir;
  };

  afterEach(async () => {
    for (const adapter of adapters.splice(0)) {
      await adapter.close().catch(() => undefined);
    }
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('createDatabase({ file, segment }) keeps two segments of one file apart', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'app.sqlite3');
    const first = await createDatabase({ file, segment: 'first' });
    adapters.push(first);
    const second = await createDatabase({ file, segment: 'second' });
    adapters.push(second);

    for (const [adapter, label] of [
      [first, 'first'],
      [second, 'second'],
    ] as const) {
      await adapter.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL)');
      await adapter.run('INSERT INTO items (label) VALUES (?)', [label]);
    }

    expect(await first.all('SELECT label FROM items')).toEqual([{ label: 'first' }]);
    expect(await second.all('SELECT label FROM items')).toEqual([{ label: 'second' }]);
    expect(fs.existsSync(path.join(dir, 'app-first.sqlite3'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'app-second.sqlite3'))).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('resolveStorageAdapter({ segment }) passes the segment to sql.js', async () => {
    const dir = tempDir();
    const adapter = await resolveStorageAdapter({
      priority: ['sqljs'],
      filePath: path.join(dir, 'app.sqlite3'),
      segment: 'agentos',
      quiet: true,
    });
    adapters.push(adapter);
    await adapter.exec('CREATE TABLE items (id INTEGER PRIMARY KEY)');
    await adapter.run('INSERT INTO items (id) VALUES (1)');
    await adapter.close();

    expect(fs.existsSync(path.join(dir, 'app-agentos.sqlite3'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'app.sqlite3'))).toBe(false);
  });

  it('rejects a segment name it cannot use before it tries any adapter', async () => {
    await expect(createDatabase({ file: path.join(tempDir(), 'app.sqlite3'), segment: 'Bad Name' })).rejects.toThrow(
      /segment/i,
    );
    await expect(resolveStorageAdapter({ priority: ['sqljs'], segment: 'Bad Name', quiet: true })).rejects.toThrow(
      /segment/i,
    );
  });

  // The Postgres adapter refuses a segment on a pool its caller made. Without
  // strict, the resolver falls through from a postgres candidate that fails,
  // so the pair would open a local SQLite file in the segment instead.
  it('rejects a segment with a pool of the caller before it tries any adapter, and opens no local file', async () => {
    const dir = tempDir();
    const filePath = path.join(dir, 'app.sqlite3');
    const pool = {
      query: async () => ({ rows: [] }),
      connect: async () => {
        throw new Error('the refusal comes before the pool is used');
      },
      end: async () => undefined,
    };

    await expect(resolveStorageAdapter({ postgres: { pool }, filePath, segment: 'agentos', quiet: true })).rejects.toThrow(
      /segment cannot run on a PostgreSQL pool/,
    );
    await expect(
      resolveStorageAdapter({ postgres: { pool, segment: 'agentos' }, filePath, quiet: true }),
    ).rejects.toThrow(/segment cannot run on a PostgreSQL pool/);
    await expect(createDatabase({ postgres: { pool }, segment: 'agentos' })).rejects.toThrow(
      /segment cannot run on a PostgreSQL pool/,
    );
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
