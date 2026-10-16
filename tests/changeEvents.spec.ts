import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createDatabase,
  createPostgresAdapter,
  createSqlJsAdapter,
  createStorageFeatures,
  PostgresAdapter,
  withChangeEvents,
  type RowChange,
  type StorageAdapter,
} from '../src/index.js';

// Row-change events. withChangeEvents reports the writes made through an
// adapter, once they commit, on every engine; on PostgreSQL, listen() and
// notify() carry notifications between sessions, and the dialect's trigger
// sends one for each write to a table from any session.

const POSTGRES_TEST_URL = process.env.POSTGRES_TEST_URL;

const unique = (prefix: string): string => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;

const engines: Array<[string, () => Promise<StorageAdapter>]> = [
  ['better-sqlite3', () => createDatabase({ type: 'memory' })],
  [
    'sql.js',
    async () => {
      const adapter = createSqlJsAdapter();
      await adapter.open();
      return adapter;
    },
  ],
];
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

describe.each(engines)('row-change events on %s', (engine, open) => {
  let base: StorageAdapter;
  let db: StorageAdapter & { onChange: (listener: (change: RowChange) => void, options?: { tables?: string[] }) => () => void };
  const table = unique('changes');
  const other = unique('changes_other');
  const seen: RowChange[] = [];
  let stop: () => void = () => undefined;

  beforeAll(async () => {
    base = await open();
    db = withChangeEvents(base);
    await db.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, label TEXT NOT NULL)`);
    await db.exec(`CREATE TABLE ${other} (id INTEGER PRIMARY KEY)`);
    stop = db.onChange((change) => seen.push(change), { tables: [table] });
  });

  afterAll(async () => {
    stop();
    await base.exec(`DROP TABLE IF EXISTS ${table}`).catch(() => undefined);
    await base.exec(`DROP TABLE IF EXISTS ${other}`).catch(() => undefined);
    await base.close();
  });

  beforeEach(() => {
    seen.length = 0;
  });

  it('reports a write once it has run, with the count the engine gave', async () => {
    await db.run(`INSERT INTO ${table} (id, label) VALUES (?, ?)`, [1, 'one']);
    await db.run(`UPDATE ${table} SET label = ? WHERE id = ?`, ['none', 999]);
    await db.run(`UPDATE ${table} SET label = ? WHERE id = ?`, ['uno', 1]);
    await db.run(`INSERT INTO ${other} (id) VALUES (?)`, [1]);
    await db.run(`DELETE FROM ${table} WHERE id = ?`, [1]);

    expect(seen.map((change) => [change.table, change.operation, change.changes])).toEqual([
      [table, 'insert', 1],
      [table, 'update', 1],
      [table, 'delete', 1],
    ]);
  });

  it("reports a transaction's writes when it commits, and none when it rolls back", async () => {
    await db.transaction(async (trx) => {
      await trx.run(`INSERT INTO ${table} (id, label) VALUES (?, ?)`, [2, 'two']);
      expect(seen).toEqual([]);
    });
    expect(seen.map((change) => change.operation)).toEqual(['insert']);

    seen.length = 0;
    await expect(
      db.transaction(async (trx) => {
        await trx.run(`INSERT INTO ${table} (id, label) VALUES (?, ?)`, [3, 'three']);
        throw new Error('give up');
      }),
    ).rejects.toThrow('give up');
    expect(seen).toEqual([]);
  });

  it('reports each write of a script, and names quoted and WITH-led statements', async () => {
    await db.exec(`INSERT INTO ${table} (id, label) VALUES (4, 'four'); UPDATE "${table}" SET label = 'cuatro' WHERE id = 4`);
    await db.run(`WITH picked AS (SELECT 4 AS id) DELETE FROM ${table} WHERE id IN (SELECT id FROM picked)`);

    expect(seen.map((change) => [change.table, change.operation])).toEqual([
      [table, 'insert'],
      [table, 'update'],
      [table, 'delete'],
    ]);
    expect(seen[0].changes).toBeUndefined();
  });

  it.skipIf(engine === 'sql.js')('reports the operations of a batch that succeeded', async () => {
    await db.batch?.([
      { statement: `INSERT INTO ${table} (id, label) VALUES (?, ?)`, parameters: [7, 'seven'] },
      { statement: `INSERT INTO ${table} (id, label) VALUES (?, ?)`, parameters: [7, 'duplicate'] },
      { statement: `UPDATE ${table} SET label = ? WHERE id = ?`, parameters: ['siete', 7] },
    ]);

    expect(seen.map((change) => [change.operation, change.changes])).toEqual([
      ['insert', 1],
      ['update', 1],
    ]);
  });

  it('goes on writing when a listener throws, and stops reporting once unsubscribed', async () => {
    const off = db.onChange(() => {
      throw new Error('the listener broke');
    });
    await db.run(`INSERT INTO ${table} (id, label) VALUES (?, ?)`, [5, 'five']);
    off();
    stop();
    await db.run(`INSERT INTO ${table} (id, label) VALUES (?, ?)`, [6, 'six']);

    expect(seen.map((change) => change.operation)).toEqual(['insert']);
    stop = db.onChange((change) => seen.push(change), { tables: [table] });
  });
});

describe.skipIf(!POSTGRES_TEST_URL)('PostgreSQL notifications between sessions', () => {
  const url = POSTGRES_TEST_URL as string;
  let listener: PostgresAdapter;
  let writer: PostgresAdapter;
  let admin: PostgresAdapter;
  const tables: string[] = [];

  beforeAll(async () => {
    listener = new PostgresAdapter(url);
    writer = new PostgresAdapter(url);
    admin = new PostgresAdapter(url);
    await Promise.all([listener.open(), writer.open(), admin.open()]);
  });

  afterAll(async () => {
    for (const table of tables) await admin.exec(`DROP TABLE IF EXISTS ${table}`).catch(() => undefined);
    await Promise.all([listener.close(), writer.close(), admin.close()]);
  });

  const waitFor = async (check: () => boolean, ms = 10_000): Promise<void> => {
    const end = Date.now() + ms;
    while (!check()) {
      if (Date.now() > end) throw new Error('timed out waiting for a notification');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  it('delivers notify() to listen() in another session, and nothing after unlisten', async () => {
    const channel = unique('chan');
    const got: string[] = [];
    const unlisten = await listener.listen(channel, (payload) => got.push(payload));

    await writer.notify(channel, 'hello');
    await waitFor(() => got.length === 1);
    expect(got).toEqual(['hello']);

    await unlisten();
    await writer.notify(channel, 'again');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(got).toEqual(['hello']);
  });

  it("notifies each write to a table, from any session, through the dialect's trigger", async () => {
    const table = unique('notified');
    const channel = unique('chan');
    tables.push(table);
    await writer.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, label TEXT)`);
    for (const statement of createStorageFeatures(writer).dialect.changeNotificationSql(table, channel) ?? []) {
      await writer.exec(statement);
    }
    const got: Array<{ schema: string; table: string; operation: string }> = [];
    const unlisten = await listener.listen(channel, (payload) => got.push(JSON.parse(payload)));

    await writer.run(`INSERT INTO ${table} (id, label) VALUES (?, ?)`, [1, 'one']);
    await writer.run(`UPDATE ${table} SET label = ? WHERE id = ?`, ['uno', 1]);
    await writer.run(`DELETE FROM ${table} WHERE id = ?`, [1]);
    await waitFor(() => got.length === 3);

    expect(got.map((change) => [change.table, change.operation])).toEqual([
      [table, 'insert'],
      [table, 'update'],
      [table, 'delete'],
    ]);
    expect(got[0].schema).toBe('public');
    await unlisten();
  });

  it('listens again after the server ends its connection', async () => {
    const channel = unique('chan');
    const got: string[] = [];
    const unlisten = await listener.listen(channel, (payload) => got.push(payload));

    const ended = await admin.get<{ ended: boolean }>(
      'SELECT bool_or(pg_terminate_backend(pid)) AS ended FROM pg_stat_activity WHERE query = ? AND pid <> pg_backend_pid()',
      [`LISTEN "${channel}"`],
    );
    expect(ended?.ended).toBe(true);

    const end = Date.now() + 15_000;
    while (!got.includes('back')) {
      if (Date.now() > end) throw new Error('no notification after the server ended the listening connection');
      await writer.notify(channel, 'back');
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    await unlisten();
  });
});

describe('the dialect trigger on SQLite', () => {
  it('is null: SQLite has no notifications between connections', async () => {
    const db = await createDatabase({ type: 'memory' });
    try {
      expect(createStorageFeatures(db).dialect.changeNotificationSql('notes', 'changes')).toBeNull();
    } finally {
      await db.close();
    }
  });
});
