import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IDBFactory } from 'fake-indexeddb';
import {
  IndexedDbAdapter,
  createBetterSqliteAdapter,
  createPostgresAdapter,
  createSqlJsAdapter,
  type StorageAdapter,
} from '../../src/index.js';
import { createSqlKeyValueStore, namespaced, type KeyValueStore } from '../../src/features/kv/index.js';

// The key-value store over a SQL table: the same calls as the IndexedDB store,
// on every adapter. Each backend below runs the same specs on a real database:
// better-sqlite3 and sql.js files, the IndexedDB adapter on fake-indexeddb, and
// PostgreSQL when POSTGRES_TEST_URL names a server (CI starts one).

const POSTGRES_TEST_URL = process.env.POSTGRES_TEST_URL;

interface Backend {
  /** Opens the test's database; a second call in one test opens the same one again. */
  open: () => Promise<StorageAdapter>;
  /** Removes what the backend made. */
  cleanUp: () => Promise<void>;
}

/** A table name no other run uses. */
const uniqueTable = (): string => `kv_${Math.random().toString(36).slice(2, 10)}`;

const backends: Array<[name: string, make: () => Backend]> = [
  [
    'better-sqlite3',
    () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kv-better-sqlite3-'));
      return {
        open: async () => {
          const adapter = createBetterSqliteAdapter(path.join(dir, 'kv.sqlite3'));
          await adapter.open();
          return adapter;
        },
        cleanUp: async () => fs.rmSync(dir, { recursive: true, force: true }),
      };
    },
  ],
  [
    'sql.js',
    () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kv-sqljs-'));
      return {
        open: async () => {
          const adapter = createSqlJsAdapter();
          await adapter.open({ filePath: path.join(dir, 'kv.sqlite3') });
          return adapter;
        },
        cleanUp: async () => fs.rmSync(dir, { recursive: true, force: true }),
      };
    },
  ],
  [
    'IndexedDB',
    () => {
      const dbName = `kv-${Math.random().toString(36).slice(2, 10)}`;
      return {
        open: async () => {
          const adapter = new IndexedDbAdapter({ dbName, durability: 'commit' });
          await adapter.open();
          return adapter;
        },
        cleanUp: async () => undefined,
      };
    },
  ],
  ...(POSTGRES_TEST_URL
    ? [
        [
          'PostgreSQL',
          (): Backend => ({
            open: async () => {
              const adapter = createPostgresAdapter({ connectionString: POSTGRES_TEST_URL, max: 2 });
              await adapter.open();
              return adapter;
            },
            cleanUp: async () => undefined,
          }),
        ] as [string, () => Backend],
      ]
    : []),
];

describe.each(backends)('createSqlKeyValueStore on %s', (_name, make) => {
  let backend: Backend;
  let table: string;
  const opened: StorageAdapter[] = [];

  const open = async (): Promise<StorageAdapter> => {
    const adapter = await backend.open();
    opened.push(adapter);
    return adapter;
  };

  const store = async (adapter?: StorageAdapter): Promise<KeyValueStore & { close(): void }> =>
    createSqlKeyValueStore(adapter ?? (await open()), { table });

  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    backend = make();
    table = uniqueTable();
  });

  afterEach(async () => {
    for (const adapter of opened.splice(0)) {
      if (adapter.kind === 'postgres') {
        await adapter.exec(`DROP TABLE IF EXISTS "${table}"`).catch(() => undefined);
      }
      await adapter.close().catch(() => undefined);
    }
    await backend.cleanUp();
    vi.unstubAllGlobals();
  });

  it('gets, sets, lists by prefix and deletes by prefix', async () => {
    const kv = await store();
    await kv.set('a/1', { n: 1 });
    await kv.set('a/2', { n: 2 });
    await kv.set('b/1', 'x');

    expect(await kv.get('a/1')).toEqual({ n: 1 });
    expect(await kv.keys('a/')).toEqual(['a/1', 'a/2']);
    await kv.deletePrefix('a/');
    expect(await kv.keys('')).toEqual(['b/1']);
  });

  it('answers undefined for a key it does not hold, and deleting one is no error', async () => {
    const kv = await store();

    expect(await kv.get('missing')).toBeUndefined();
    await expect(kv.delete('missing')).resolves.toBeUndefined();
  });

  it('replaces the value under a key', async () => {
    const kv = await store();
    await kv.set('k', 'first');
    await kv.set('k', { second: true });

    expect(await kv.get('k')).toEqual({ second: true });
    expect(await kv.keys('')).toEqual(['k']);
  });

  it('deletes one key', async () => {
    const kv = await store();
    await kv.set('keep', 1);
    await kv.set('drop', 2);
    await kv.delete('drop');

    expect(await kv.keys('')).toEqual(['keep']);
  });

  it('reads a prefix literally, with characters LIKE and GLOB would read as patterns', async () => {
    const kv = await store();
    for (const key of ['100%/a', '100x/b', 'a_b/1', 'axb/1', 'a*b/1', 'A/upper', 'a/lower']) {
      await kv.set(key, key);
    }

    expect(await kv.keys('100%/')).toEqual(['100%/a']);
    expect(await kv.keys('a_b/')).toEqual(['a_b/1']);
    expect(await kv.keys('a*b/')).toEqual(['a*b/1']);
    expect(await kv.keys('a/')).toEqual(['a/lower']);
    await kv.deletePrefix('a_b/');
    expect(await kv.get('axb/1')).toBe('axb/1');
    expect(await kv.get('a_b/1')).toBeUndefined();
  });

  it('lists keys in the order of their UTF-16 code units, as IndexedDB orders them', async () => {
    const kv = await store();
    const keys = ['b', 'a', 'B', 'é', 'z', '\u{1F600}', '～', 'aa'];
    for (const key of keys) await kv.set(key, true);

    expect(await kv.keys('')).toEqual([...keys].sort());
  });

  it('lists the keys under a prefix that holds characters beyond the Basic Multilingual Plane', async () => {
    const kv = await store();
    await kv.set('\u{1F600}/one', 1);
    await kv.set('\u{1F600}/two', 2);
    await kv.set('\u{1F601}/other', 3);

    expect(await kv.keys('\u{1F600}/')).toEqual(['\u{1F600}/one', '\u{1F600}/two']);
  });

  it('keeps two namespaces apart', async () => {
    const kv = await store();
    const ann = namespaced(kv, 'ann/');
    const bob = namespaced(kv, 'bob/');
    await ann.set('notes', 'mine');

    expect(await bob.get('notes')).toBeUndefined();
    expect(await ann.keys('')).toEqual(['notes']);
    await bob.set('notes', 'his');
    await ann.deletePrefix('');
    expect(await bob.get('notes')).toBe('his');
    expect(await kv.keys('')).toEqual(['bob/notes']);
  });

  it('hands out copies, as a structured clone would', async () => {
    const kv = await store();
    const value = { list: [1] };
    await kv.set('k', value);
    value.list.push(2);
    const read = await kv.get<{ list: number[] }>('k');
    read?.list.push(3);

    expect(await kv.get('k')).toEqual({ list: [1] });
  });

  it('gives back the values a structured clone keeps', async () => {
    const kv = await store();
    const shared = { x: 1 };
    const value = {
      text: '## Note | kw: a',
      saved: 1,
      missing: undefined,
      negativeZero: -0,
      notANumber: NaN,
      big: 2n ** 70n,
      when: new Date(Date.UTC(2026, 9, 15)),
      pattern: /a+b/g,
      map: new Map<unknown, unknown>([['k', [1, 2]]]),
      set: new Set(['x', 'y']),
      bytes: new Uint8Array([1, 2, 255]).buffer,
      view: new Float32Array([0.5, -0]),
      // eslint-disable-next-line no-sparse-arrays
      holes: [1, , 3],
      first: shared,
      second: shared,
    };
    await kv.set('value', value);

    const back = await kv.get<typeof value>('value');
    expect(back).toStrictEqual(structuredClone(value));
    expect(back?.first).toBe(back?.second);
  });

  it('refuses a value the structured clone refuses, and keeps what the key held', async () => {
    const kv = await store();
    await kv.set('k', 'before');

    const refused = await kv.set('k', { run: () => 1 }).then(
      () => null,
      (error: unknown) => error,
    );
    expect((refused as { name?: string } | null)?.name).toBe('DataCloneError');
    expect(await kv.get('k')).toBe('before');
  });

  // A proxy reads as the object it wraps to every check but the structured
  // clone's own, which refuses it, as IndexedDB's put does.
  it('refuses a proxy, which the structured clone refuses, and keeps what the key held', async () => {
    const kv = await store();
    await kv.set('k', 'before');

    for (const value of [new Proxy({ text: 'wrapped' }, {}), new Proxy(['wrapped'], {}), { inner: new Proxy({}, {}) }]) {
      const refused = await kv.set('k', value).then(
        () => null,
        (error: unknown) => error,
      );
      expect((refused as { name?: string } | null)?.name).toBe('DataCloneError');
    }
    expect(await kv.get('k')).toBe('before');
  });

  it('keeps what it holds when the database is opened again', async () => {
    const first = await open();
    const kv = await store(first);
    await kv.set('kept', { across: 'opens' });
    await first.close();

    const again = await store(await open());
    expect(await again.get('kept')).toEqual({ across: 'opens' });
  });

  it('keeps two stores on two tables of one database apart', async () => {
    const adapter = await open();
    const first = await createSqlKeyValueStore(adapter, { table });
    const otherTable = `${table}_other`;
    const second = await createSqlKeyValueStore(adapter, { table: otherTable });
    try {
      await first.set('k', 'first');
      await second.set('k', 'second');

      expect(await first.get('k')).toBe('first');
      expect(await second.get('k')).toBe('second');
    } finally {
      if (adapter.kind === 'postgres') await adapter.exec(`DROP TABLE IF EXISTS "${otherTable}"`);
    }
  });

  it('says whether what it holds outlives the process', async () => {
    const kv = await store();

    expect(kv.memoryOnly).toBe(false);
  });
});

describe('createSqlKeyValueStore', () => {
  it.each(['', '1kv', 'kv-store', 'kv store', 'kv"; DROP TABLE x; --', 'a'.repeat(64)])(
    'refuses %j as a table name',
    async (table) => {
      const adapter = createSqlJsAdapter();
      await adapter.open();
      try {
        await expect(createSqlKeyValueStore(adapter, { table })).rejects.toThrow(/table/i);
      } finally {
        await adapter.close();
      }
    },
  );

  it('says it outlives nothing over an adapter without persistence', async () => {
    const adapter = {
      kind: 'test',
      capabilities: new Set(['transactions']),
      open: async () => undefined,
      close: async () => undefined,
      run: async () => ({ changes: 0 }),
      get: async () => null,
      all: async () => [],
      exec: async () => undefined,
      transaction: async <T>(fn: (trx: StorageAdapter) => Promise<T>) => fn(adapter as unknown as StorageAdapter),
    } as unknown as StorageAdapter;

    const kv = await createSqlKeyValueStore(adapter, { table: 'kv' });
    expect(kv.memoryOnly).toBe(true);
  });
});
