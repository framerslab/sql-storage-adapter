import { describe, expect, it, afterEach } from 'vitest';
import initSqlJs from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import browserWasmUrl from 'sql.js/dist/sql-wasm-browser.wasm?url';
import { IndexedDbAdapter } from '../../src/adapters/indexedDbAdapter';

// The IndexedDB adapter in the browsers themselves, Chromium and WebKit, run by
// Playwright. Two adapters on one database in one page stand for two tabs: each
// holds a database image of its own, and they share the page's IndexedDB and
// Web Locks, which two tabs of one site share too.

const sqlJsConfig = {
  locateFile: (file: string): string => (file.includes('browser') ? browserWasmUrl : wasmUrl),
};

/** A database name no other test uses. */
const unique = (name: string): string => `${name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** The labels in the items table of the image stored under `dbName`, read through a connection of its own. */
const storedLabels = async (dbName: string): Promise<string[]> => {
  const image = await new Promise<Uint8Array | null>((resolve, reject) => {
    const open = indexedDB.open(dbName, 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('sqliteDb', 'readonly');
      const request = tx.objectStore('sqliteDb').get('db');
      request.onsuccess = () => resolve((request.result as Uint8Array | undefined) ?? null);
      request.onerror = () => reject(request.error);
      tx.oncomplete = () => db.close();
    };
  });
  if (!image) return [];
  const SQL = await initSqlJs(sqlJsConfig);
  const db = new SQL.Database(image);
  try {
    const rows = db.exec('SELECT label FROM items ORDER BY id');
    return rows.length ? rows[0].values.map(([label]) => String(label)) : [];
  } finally {
    db.close();
  }
};

/** A promise and the function that settles it. */
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

describe('IndexedDbAdapter in a browser', () => {
  const opened: IndexedDbAdapter[] = [];

  const openTab = async (dbName: string, options: ConstructorParameters<typeof IndexedDbAdapter>[0] = {}) => {
    const adapter = new IndexedDbAdapter({ dbName, sqlJsConfig, crossTab: true, ...options });
    opened.push(adapter);
    await adapter.open();
    await adapter.exec('CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, label TEXT NOT NULL)');
    return adapter;
  };

  const labels = async (adapter: IndexedDbAdapter): Promise<string[]> =>
    (await adapter.all<{ label: string }>('SELECT label FROM items ORDER BY id')).map((row) => row.label);

  afterEach(async () => {
    for (const adapter of opened.splice(0)) {
      await adapter.close().catch(() => undefined);
    }
  });

  it('runs in a secure context that has the Web Locks API', () => {
    expect(window.isSecureContext).toBe(true);
    expect(typeof navigator.locks?.request).toBe('function');
  });

  it("keeps both tabs' writes when each tab loaded the database before the other wrote", async () => {
    const dbName = unique('two-tabs');
    const first = await openTab(dbName);
    const second = await openTab(dbName);

    await first.run('INSERT INTO items (label) VALUES (?)', ['from the first tab']);
    await second.run('INSERT INTO items (label) VALUES (?)', ['from the second tab']);

    expect(await storedLabels(dbName)).toEqual(['from the first tab', 'from the second tab']);
    expect(await labels(first)).toEqual(['from the first tab', 'from the second tab']);
  });

  it('keeps every write when two tabs write at the same time', async () => {
    const dbName = unique('interleaved');
    const first = await openTab(dbName);
    const second = await openTab(dbName);

    await Promise.all([
      ...Array.from({ length: 10 }, (_, i) => first.run('INSERT INTO items (label) VALUES (?)', [`first ${i}`])),
      ...Array.from({ length: 10 }, (_, i) => second.run('INSERT INTO items (label) VALUES (?)', [`second ${i}`])),
    ]);

    expect(await storedLabels(dbName)).toHaveLength(20);
    expect(await labels(second)).toHaveLength(20);
  });

  it('lets a tab read what another tab stored after it opened', async () => {
    const dbName = unique('read-visibility');
    const reader = await openTab(dbName);
    const writer = await openTab(dbName);

    await writer.run('INSERT INTO items (label) VALUES (?)', ['written in another tab']);

    expect(await labels(reader)).toEqual(['written in another tab']);
  });

  it("holds another tab's write until a transaction commits, and keeps both", async () => {
    const dbName = unique('transaction-holds');
    const first = await openTab(dbName);
    const second = await openTab(dbName);
    const inside = deferred();
    const finish = deferred();

    const transaction = first.transaction(async (trx) => {
      await trx.run('INSERT INTO items (label) VALUES (?)', ['in the transaction']);
      inside.resolve();
      await finish.promise;
    });
    await inside.promise;
    let written = false;
    const write = second.run('INSERT INTO items (label) VALUES (?)', ['from the other tab']).then(() => {
      written = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(written).toBe(false);

    finish.resolve();
    await Promise.all([transaction, write]);
    expect(await storedLabels(dbName)).toEqual(['in the transaction', 'from the other tab']);
  });

  it("keeps both tabs' writes by the version stamp alone, without Web Locks", async () => {
    const dbName = unique('no-locks');
    const first = await openTab(dbName, { crossTab: { locks: null } });
    const second = await openTab(dbName, { crossTab: { locks: null } });

    await Promise.all([
      ...Array.from({ length: 5 }, (_, i) => first.run('INSERT INTO items (label) VALUES (?)', [`first ${i}`])),
      ...Array.from({ length: 5 }, (_, i) => second.run('INSERT INTO items (label) VALUES (?)', [`second ${i}`])),
    ]);

    expect(await storedLabels(dbName)).toHaveLength(10);
  });

  it("stores a write before run() resolves with durability 'commit'", async () => {
    const dbName = unique('commit');
    const adapter = await openTab(dbName, { crossTab: false, durability: 'commit' });

    await adapter.run('INSERT INTO items (label) VALUES (?)', ['stored']);

    expect(await storedLabels(dbName)).toEqual(['stored']);
  });
});
