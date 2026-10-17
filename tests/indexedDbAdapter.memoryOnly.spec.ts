import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { IndexedDbAdapter } from '../src/adapters/indexedDbAdapter';

// memoryOnly keeps the database in memory alone: IndexedDB is never opened,
// whatever durability and crossTab say, and nothing outlives the adapter.

describe('IndexedDbAdapter in memory alone', () => {
  const opened: IndexedDbAdapter[] = [];
  let factory: IDBFactory;

  const openAdapter = async (options: ConstructorParameters<typeof IndexedDbAdapter>[0] = {}): Promise<IndexedDbAdapter> => {
    const adapter = new IndexedDbAdapter({ dbName: 'memory-only', ...options });
    opened.push(adapter);
    await adapter.open();
    return adapter;
  };

  const labels = async (adapter: IndexedDbAdapter): Promise<string[]> =>
    (await adapter.all<{ label: string }>('SELECT label FROM items ORDER BY id')).map((row) => row.label);

  beforeEach(() => {
    factory = new IDBFactory();
    vi.stubGlobal('indexedDB', factory);
  });

  afterEach(async () => {
    for (const adapter of opened.splice(0)) {
      await adapter.close().catch(() => undefined);
    }
    vi.unstubAllGlobals();
  });

  it('never opens IndexedDB, says it keeps nothing, and answers every call from memory', async () => {
    const open = vi.spyOn(factory, 'open');
    const adapter = await openAdapter({ memoryOnly: true, durability: 'commit', crossTab: true });
    await adapter.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL)');
    await adapter.transaction(async (trx) => {
      await trx.run('INSERT INTO items (label) VALUES (?)', ['memory']);
    });
    await adapter.run('INSERT INTO items (label) VALUES (?)', ['more']);
    expect(await labels(adapter)).toEqual(['memory', 'more']);
    expect(adapter.capabilities.has('persistence')).toBe(false);
    expect(adapter.capabilities.has('transactions')).toBe(true);
    await adapter.flush();
    expect(await adapter.reload()).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  it('leaves nothing behind: a connection on the same name finds no stored image', async () => {
    const memory = await openAdapter({ memoryOnly: true });
    await memory.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL)');
    await memory.run('INSERT INTO items (label) VALUES (?)', ['gone with the page']);
    await memory.close();
    const stored = await openAdapter({ durability: 'commit' });
    expect(await stored.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'items'")).toEqual([]);
  });

  it('exports and imports its image in memory', async () => {
    const memory = await openAdapter({ memoryOnly: true });
    await memory.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL)');
    await memory.run('INSERT INTO items (label) VALUES (?)', ['kept']);
    const image = memory.exportDatabase();
    const other = await openAdapter({ memoryOnly: true, dbName: 'memory-only-2' });
    await other.importDatabase(image);
    expect(await labels(other)).toEqual(['kept']);
  });
});
