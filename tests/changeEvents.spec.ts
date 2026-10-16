import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDatabase,
  createPostgresAdapter,
  createSqlJsAdapter,
  createStorageFeatures,
  PostgresAdapter,
  setStorageLogger,
  type RowChange,
  type StorageAdapter,
  type BatchOperation,
} from '../src/index.js';
import { withChangeEvents } from '../src/core/portable.js';

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

  it('returns rows from writes through get and all, without reporting reads', async () => {
    const insert = `INSERT INTO ${table} (id, label) VALUES (?, ?) RETURNING id, label`;
    const update = `UPDATE ${table} SET label = ? WHERE id = ? RETURNING id, label`;
    expect(await db.get(insert, [20, 'twenty'])).toEqual({ id: 20, label: 'twenty' });
    expect(await db.all(update, ['veinte', 20])).toEqual([{ id: 20, label: 'veinte' }]);
    expect(await db.get(`SELECT label FROM ${table} WHERE id = ?`, [20])).toEqual({ label: 'veinte' });
    expect(await db.all(`SELECT id FROM ${table} WHERE id = ?`, [20])).toEqual([{ id: 20 }]);
    expect(seen).toEqual([
      { table, operation: 'insert', statement: insert },
      { table, operation: 'update', statement: update },
    ]);
  });

  it('matches qualified and bare table filters without case sensitivity', async () => {
    const schema = engine === 'PostgreSQL' ? 'public' : 'main';
    const qualified = `${schema}.${table}`;
    const full: RowChange[] = [];
    const muted: RowChange[] = [];
    const off = db.onChange((change) => full.push(change), { tables: [qualified.toUpperCase()] });
    const offMuted = db.onChange((change) => muted.push(change), { tables: [] });
    try {
      const statement = `INSERT INTO ${qualified} (id, label) VALUES (?, ?)`;
      const result = await db.run(statement, [21, 'qualified']);
      expect(seen).toEqual([{ table: qualified, operation: 'insert', statement, changes: result.changes, lastInsertRowid: result.lastInsertRowid }]);
      expect(full).toEqual(seen);
      expect(muted).toEqual([]);
      expect(db.kind).toBe(base.kind);
    } finally {
      off();
      offMuted();
    }
  });

  it('keeps a committed write and later listeners when an async listener rejects', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    setStorageLogger(logger);
    const off = db.onChange(async () => { throw 'rejected listener'; });
    const delivered: RowChange[] = [];
    const offNext = db.onChange((change) => delivered.push(change));
    try {
      await db.run(`INSERT INTO ${table} (id, label) VALUES (?, ?)`, [22, 'committed']);
      expect(await base.get(`SELECT label FROM ${table} WHERE id = ?`, [22])).toEqual({ label: 'committed' });
      expect(delivered).toEqual(seen);
      expect(delivered).toHaveLength(1);
      expect(logger.warn).toHaveBeenCalledWith(
        { scope: 'withChangeEvents', table, operation: 'insert', error: 'rejected listener' },
        expect.stringContaining('the write stands'),
      );
    } finally {
      off();
      offNext();
      setStorageLogger(null);
    }
  });

  it('reports nothing for a rejected write and returns the transaction callback value', async () => {
    await expect(db.run(`INSERT INTO ${table} (id, label) VALUES (?, ?)`, [23, null])).rejects.toThrow();
    expect(seen).toEqual([]);
    expect(await db.transaction(async (trx) => {
      await trx.run(`INSERT INTO ${table} (id, label) VALUES (?, ?)`, [23, 'committed']);
      expect(seen).toEqual([]);
      return 'callback value';
    })).toBe('callback value');
    expect(seen).toHaveLength(1);
  });

  it.skipIf(engine === 'sql.js')('reports successful batch statements when an adapter omits optional result metadata', async () => {
    // Keep real writes, but expose only the counts required by BatchResult.
    const countsOnly = new Proxy(base, {
      get(target, property) {
        if (property === 'batch') return async (operations: BatchOperation[]) => {
          const { successful, failed } = await target.batch!(operations);
          return { successful, failed };
        };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const wrapped = withChangeEvents(countsOnly);
    const changes: RowChange[] = [];
    const off = wrapped.onChange((change) => changes.push(change));
    const statement = `INSERT INTO ${table} (id, label) VALUES (?, ?)`;
    try {
      expect(await wrapped.batch!([{ statement, parameters: [24, 'no metadata'] }])).toEqual({ successful: 1, failed: 0 });
      expect(changes).toEqual([{ table, operation: 'insert', statement }]);
      expect(await base.get(`SELECT label FROM ${table} WHERE id = ?`, [24])).toEqual({ label: 'no metadata' });
    } finally {
      off();
    }
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

  const waitFor = async (check: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> => {
    const end = Date.now() + ms;
    while (!(await check())) {
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

  it("installs the trigger twice and notifies insert, update, delete and truncate from another session", async () => {
    const table = unique('notified');
    const channel = unique('Chan_\'"');
    tables.push(table);
    await writer.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, label TEXT)`);
    const statements = createStorageFeatures(writer).dialect.changeNotificationSql(`public.${table}`, channel);
    expect(statements).not.toBeNull();
    for (let install = 0; install < 2; install++) {
      for (const statement of statements!) await writer.exec(statement);
    }
    const got: Array<{ schema: string; table: string; operation: string }> = [];
    const unlisten = await listener.listen(channel, (payload) => got.push(JSON.parse(payload)));

    try {
      await writer.run(`INSERT INTO ${table} (id, label) VALUES (?, ?)`, [1, 'one']);
      await writer.run(`UPDATE ${table} SET label = ? WHERE id = ?`, ['uno', 1]);
      await writer.run(`DELETE FROM ${table} WHERE id = ?`, [1]);
      await writer.exec(`TRUNCATE TABLE ${table}`);
      await waitFor(() => got.length >= 4);
      expect(got).toEqual(['insert', 'update', 'delete', 'delete'].map((operation) => ({ schema: 'public', table, operation })));
    } finally {
      await unlisten();
    }
  });

  it('listens again after the server ends its connection', async () => {
    const channel = unique('chan');
    const got: string[] = [];
    const unlisten = await listener.listen(channel, (payload) => got.push(payload));

    try {
      const original = await admin.get<{ pid: number }>('SELECT pid FROM pg_stat_activity WHERE query = ?', [`LISTEN "${channel}"`]);
      expect(original).not.toBeNull();
      expect(await admin.get('SELECT pg_terminate_backend(?) AS ended', [original!.pid])).toEqual({ ended: true });
      await waitFor(async () => {
        const replacement = await admin.get<{ pid: number }>(
          "SELECT pid FROM pg_stat_activity WHERE query = ? AND state = 'idle' AND pid <> ?",
          [`LISTEN "${channel}"`, original!.pid],
        );
        return replacement !== null;
      });
      await writer.notify(channel, 'back');
      await waitFor(() => got.length > 0);
      expect(got).toEqual(['back']);
    } finally {
      await unlisten();
    }
  }, 15_000);

  it.each([new Error('handler broke'), 'handler broke'])('keeps other handlers and channels when a handler throws %s or unsubscribes', async (failure) => {
    const channel = unique('chan');
    const barrier = unique('barrier');
    const got: Array<[string, string]> = [];
    const barriers: string[] = [];
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    setStorageLogger(logger);
    const stops: Array<() => Promise<void>> = [];
    try {
      const offBroken = await listener.listen(channel, () => { throw failure; });
      stops.push(offBroken);
      const offGood = await listener.listen(channel, (payload, name) => got.push([payload, name]));
      stops.push(offGood);
      stops.push(await listener.listen(barrier, (payload) => barriers.push(payload)));
      await writer.notify(channel);
      await waitFor(() => got.length === 1);
      expect(got).toEqual([['', channel]]);
      expect(logger.warn).toHaveBeenCalledWith(
        { adapter: 'postgres', channel, error: 'handler broke' }, expect.stringContaining('listener goes on'),
      );
      await offBroken();
      await offBroken();
      await writer.notify(channel, 'still subscribed');
      await waitFor(() => got.length === 2);
      expect(got[1]).toEqual(['still subscribed', channel]);
      expect(logger.warn).toHaveBeenCalledTimes(1);

      // A second channel keeps the connection held, exercising UNLISTEN of
      // one channel. Its later notification is a delivery barrier.
      await offGood();
      await writer.notify(channel, 'unsubscribed');
      await writer.notify(barrier, 'delivered');
      await waitFor(() => barriers.length === 1);
      expect(got).toHaveLength(2);
      expect(barriers).toEqual(['delivered']);
    } finally {
      for (const stop of stops) await stop();
      setStorageLogger(null);
    }
  });

  it('reports held-connection writes, delaying their transaction writes until commit', async () => {
    const table = unique('held_changes');
    tables.push(table);
    await writer.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY)`);
    const db = withChangeEvents(writer);
    const seen: RowChange[] = [];
    const stop = db.onChange((change) => seen.push(change));
    try {
      expect(await db.withConnection(async (connection) => {
        await connection.run(`INSERT INTO ${table} VALUES (?)`, [1]);
        expect(seen.map((change) => change.operation)).toEqual(['insert']);
        await connection.transaction(async (trx) => {
          await trx.run(`UPDATE ${table} SET id = 2`);
          expect(seen).toHaveLength(1);
        });
        await expect(connection.transaction(async (trx) => {
          await trx.run(`DELETE FROM ${table}`);
          throw new Error('rollback held write');
        })).rejects.toThrow('rollback held write');
        return 'held result';
      })).toBe('held result');
      expect(seen.map((change) => [change.operation, change.changes])).toEqual([['insert', 1], ['update', 1]]);
      expect(await writer.all(`SELECT id FROM ${table}`)).toEqual([{ id: 2 }]);
      // Adapter-specific methods still receive the original instance as this.
      expect(db.getPoolStats()).toEqual(writer.getPoolStats());
    } finally {
      stop();
    }
  });

  it('reports no batch writes when a deferred constraint rejects the commit', async () => {
    const table = unique('deferred_changes');
    tables.push(table);
    await writer.exec(`CREATE TABLE ${table} (id INTEGER UNIQUE DEFERRABLE INITIALLY DEFERRED)`);
    const db = withChangeEvents(writer);
    const seen: RowChange[] = [];
    const off = db.onChange((change) => seen.push(change));
    try {
      const result = await db.batch([
        { statement: `INSERT INTO ${table} VALUES (1)` },
        { statement: `INSERT INTO ${table} VALUES (1)` },
      ]);
      expect(result).toMatchObject({ successful: 0, failed: 2, errors: [{ index: -1 }] });
      expect(seen).toEqual([]);
      expect(await writer.all(`SELECT * FROM ${table}`)).toEqual([]);
    } finally {
      off();
    }
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
