import { describe, expect, it, afterAll, beforeAll } from 'vitest';
import { createDatabase, createPostgresAdapter, PostgresAdapter, type StorageAdapter } from '../src/index.js';

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

const operationsOn = (table: string) => [
  { statement: `INSERT INTO ${table} (id, label) VALUES (?, ?)`, parameters: [1, 'one'] },
  { statement: `INSERT INTO ${table} (id, label) VALUES (?, ?)`, parameters: [1, 'duplicate'] },
  { statement: `INSERT INTO ${table} (id, label) VALUES (?, ?)`, parameters: [2, 'two'] },
];

describe.each(engines)('batch on %s', (_engine, openAdapter) => {
  let db: Batching;
  const tables: string[] = [];

  const newTable = async (): Promise<string> => {
    const table = `batch_${Math.random().toString(36).slice(2, 8)}`;
    tables.push(table);
    await db.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, label TEXT NOT NULL)`);
    return table;
  };

  beforeAll(async () => {
    db = (await openAdapter()) as Batching;
  });

  afterAll(async () => {
    for (const table of tables) await db.exec(`DROP TABLE IF EXISTS ${table}`).catch(() => undefined);
    await db.close();
  });

  it('says it can batch', () => {
    expect(db.capabilities.has('batch')).toBe(true);
  });

  it('commits the operations that succeed and reports the one that fails', async () => {
    const table = await newTable();
    const result = await db.batch(operationsOn(table));

    expect(result.successful).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.errors?.map((entry) => entry.index)).toEqual([1]);
    expect(await db.all(`SELECT id, label FROM ${table} ORDER BY id`)).toEqual([
      { id: 1, label: 'one' },
      { id: 2, label: 'two' },
    ]);
  });

  it('runs inside a transaction and commits with it', async () => {
    const table = await newTable();
    const result = await db.transaction(async (trx) => (trx as Batching).batch(operationsOn(table)));

    expect(result.successful).toBe(2);
    expect(result.errors?.map((entry) => entry.index)).toEqual([1]);
    expect(await db.all(`SELECT id FROM ${table} ORDER BY id`)).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('rolls back with the transaction it runs inside', async () => {
    const table = await newTable();
    await expect(
      db.transaction(async (trx) => {
        await (trx as Batching).batch(operationsOn(table));
        throw new Error('the caller gives up');
      }),
    ).rejects.toThrow('the caller gives up');

    expect(await db.all(`SELECT id FROM ${table}`)).toEqual([]);
  });
});

describe.skipIf(!POSTGRES_TEST_URL)('batch on a held PostgreSQL connection', () => {
  let db: PostgresAdapter;
  const table = `batch_held_${Math.random().toString(36).slice(2, 8)}`;

  beforeAll(async () => {
    db = new PostgresAdapter(POSTGRES_TEST_URL!);
    await db.open();
    await db.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, label TEXT NOT NULL)`);
  });

  afterAll(async () => {
    await db.exec(`DROP TABLE IF EXISTS ${table}`).catch(() => undefined);
    await db.close();
  });

  it('runs in a transaction of its own on the connection', async () => {
    const result = await db.withConnection(async (connection) => (connection as Batching).batch(operationsOn(table)));

    expect(result.successful).toBe(2);
    expect(result.failed).toBe(1);
    expect(await db.all(`SELECT id FROM ${table} ORDER BY id`)).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('refuses a batch while a transaction is open on the connection', async () => {
    await db.withConnection(async (connection) => {
      await connection.transaction(async () => {
        await expect((connection as Batching).batch(operationsOn(table))).rejects.toThrow(/already open on this connection/);
      });
    });
  });
});
