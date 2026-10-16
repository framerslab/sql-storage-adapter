import { describe, expect, it, afterAll, beforeAll } from 'vitest';
import { createDatabase, createPostgresAdapter, type StorageAdapter } from '../src/index.js';

// batch() runs its operations in one transaction and goes on past one that
// fails, on PostgreSQL (each operation under a savepoint, since a failed
// statement aborts a PostgreSQL transaction) as on better-sqlite3.

const POSTGRES_TEST_URL = process.env.POSTGRES_TEST_URL;

type Batching = StorageAdapter & Required<Pick<StorageAdapter, 'batch'>>;

const engines: Array<[string, () => Promise<StorageAdapter>]> = [['better-sqlite3', () => createDatabase({ type: 'memory' })]];
if (POSTGRES_TEST_URL) {
  engines.push([
    'PostgreSQL',
    async () => {
      const adapter = createPostgresAdapter(POSTGRES_TEST_URL);
      await adapter.open();
      return adapter;
    },
  ]);
}

describe.each(engines)('batch on %s', (_engine, openAdapter) => {
  let db: Batching;
  const table = `batch_${Math.random().toString(36).slice(2, 8)}`;

  beforeAll(async () => {
    db = (await openAdapter()) as Batching;
    await db.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, label TEXT NOT NULL)`);
  });

  afterAll(async () => {
    await db.exec(`DROP TABLE IF EXISTS ${table}`).catch(() => undefined);
    await db.close();
  });

  it('commits the operations that succeed and reports the one that fails', async () => {
    const result = await db.batch([
      { statement: `INSERT INTO ${table} (id, label) VALUES (?, ?)`, parameters: [1, 'one'] },
      { statement: `INSERT INTO ${table} (id, label) VALUES (?, ?)`, parameters: [1, 'duplicate'] },
      { statement: `INSERT INTO ${table} (id, label) VALUES (?, ?)`, parameters: [2, 'two'] },
    ]);

    expect(result.successful).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.errors?.map((entry) => entry.index)).toEqual([1]);
    expect(await db.all(`SELECT id, label FROM ${table} ORDER BY id`)).toEqual([
      { id: 1, label: 'one' },
      { id: 2, label: 'two' },
    ]);
  });
});
