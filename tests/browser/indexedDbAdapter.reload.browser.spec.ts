import { afterEach, describe, expect, it } from 'vitest';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import browserWasmUrl from 'sql.js/dist/sql-wasm-browser.wasm?url';
import { IndexedDbAdapter } from '../../src/adapters/indexedDbAdapter';

// memoryOnly and reload() in the browsers themselves, run by Playwright.

const sqlJsConfig = {
  locateFile: (file: string): string => (file.includes('browser') ? browserWasmUrl : wasmUrl),
};

/** A database name no other test uses. */
const unique = (name: string): string => `${name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** Whether a database of this name exists: an open that upgrades from version 0 made it, and is undone. */
const exists = (dbName: string): Promise<boolean> =>
  new Promise((resolve, reject) => {
    let made = false;
    const open = indexedDB.open(dbName);
    open.onupgradeneeded = (event) => {
      made = event.oldVersion === 0;
    };
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      open.result.close();
      if (!made) {
        resolve(true);
        return;
      }
      const drop = indexedDB.deleteDatabase(dbName);
      drop.onsuccess = () => resolve(false);
      drop.onerror = () => reject(drop.error);
    };
  });

describe('memoryOnly and reload() in a browser', () => {
  const opened: IndexedDbAdapter[] = [];

  const openTab = async (dbName: string, options: ConstructorParameters<typeof IndexedDbAdapter>[0] = {}): Promise<IndexedDbAdapter> => {
    const adapter = new IndexedDbAdapter({ dbName, sqlJsConfig, durability: 'commit', ...options });
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

  it('makes no database in memory-only mode', async () => {
    const dbName = unique('memory-only');
    const adapter = await openTab(dbName, { memoryOnly: true, crossTab: true });
    await adapter.run('INSERT INTO items (label) VALUES (?)', ['memory']);
    await adapter.close();
    expect(await exists(dbName)).toBe(false);
  });

  it("reloads another tab's stored image on the engine's own IndexedDB", async () => {
    const dbName = unique('reload');
    const reader = await openTab(dbName);
    const writer = await openTab(dbName, { crossTab: true });
    await writer.run('INSERT INTO items (label) VALUES (?)', ['from the other tab']);
    expect(await labels(reader)).toEqual([]);
    expect(await reader.reload()).toBe(true);
    expect(await labels(reader)).toEqual(['from the other tab']);
    expect(await reader.reload()).toBe(false);
  });
});
