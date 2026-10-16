import { describe, expect, it, afterAll, beforeAll } from 'vitest';
import {
  PostgresAdapter,
  createDatabase,
  createPostgresAdapter,
  createSqlJsAdapter,
  withHooks,
  type StorageAdapter,
  type StorageHooks,
} from '../src/index.js';

// Lifecycle hooks around an adapter's calls, through withHooks() or
// createDatabase({ hooks }): a hook sees each query, write, transaction and
// error, can change a statement or a result, can stop a call by returning
// undefined, and runs for the statements inside a transaction too. The same on
// PostgreSQL (CI's service, when POSTGRES_TEST_URL names it), better-sqlite3
// and sql.js.

const POSTGRES_TEST_URL = process.env.POSTGRES_TEST_URL;

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

describe.each(engines)('withHooks on %s', (engine, openAdapter) => {
  let base: StorageAdapter;
  const table = `hooks_${Math.random().toString(36).slice(2, 8)}`;
  const seen: string[] = [];

  const hooks: StorageHooks = {
    onBeforeQuery: async (context) => {
      seen.push(`query ${context.operation}`);
      return { ...context, statement: context.statement.replace('/* label */', `'hooked' AS label,`) };
    },
    onAfterQuery: async (context, result) => {
      seen.push(`after ${context.operation}`);
      return Array.isArray(result) ? (result.map((row) => ({ ...row, seen: true })) as typeof result) : result;
    },
    onBeforeWrite: async (context) => {
      seen.push(`write ${context.statement.split(' ')[0]}`);
      if (context.statement.includes('/* skip */')) return undefined;
      return context;
    },
    onAfterWrite: async (_context, result) => {
      seen.push(`wrote ${result.changes}`);
    },
    onBeforeTransaction: async (context) => {
      seen.push('begin');
      return context;
    },
    onAfterTransaction: async (context) => {
      seen.push(`end ${context.outcome}`);
    },
    onError: async (error) => new Error(`hooked: ${error.message}`),
  };

  let db: StorageAdapter;

  beforeAll(async () => {
    base = await openAdapter();
    await base.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, name TEXT NOT NULL)`);
    db = withHooks(base, hooks);
  });

  afterAll(async () => {
    await base.exec(`DROP TABLE IF EXISTS ${table}`).catch(() => undefined);
    await base.close();
  });

  it('runs the write hooks around run(), and skips a write a hook stops', async () => {
    seen.length = 0;
    expect((await db.run(`INSERT INTO ${table} (id, name) VALUES (?, ?)`, [1, 'one'])).changes).toBe(1);
    expect((await db.run(`INSERT INTO ${table} (id, name) VALUES (?, ?) /* skip */`, [2, 'two'])).changes).toBe(0);

    expect(seen).toEqual(['write INSERT', 'wrote 1', 'write INSERT']);
    expect(await base.all(`SELECT id FROM ${table} ORDER BY id`)).toEqual([{ id: 1 }]);
  });

  it('lets the query hooks change the statement and the result', async () => {
    seen.length = 0;
    const rows = await db.all(`SELECT /* label */ id FROM ${table} ORDER BY id`);

    expect(rows).toEqual([{ label: 'hooked', id: 1, seen: true }]);
    expect(seen).toEqual(['query all', 'after all']);
  });

  it('runs the transaction hooks, and the hooks of the statements inside it', async () => {
    seen.length = 0;
    await db.transaction(async (trx) => {
      await trx.run(`INSERT INTO ${table} (id, name) VALUES (?, ?)`, [3, 'three']);
    });
    await db
      .transaction(async (trx) => {
        await trx.run(`INSERT INTO ${table} (id, name) VALUES (?, ?)`, [4, 'four']);
        throw new Error('roll back');
      })
      .catch(() => undefined);

    expect(seen).toEqual(['begin', 'write INSERT', 'wrote 1', 'end committed', 'begin', 'write INSERT', 'wrote 1', 'end rolled_back']);
    expect(await base.all(`SELECT id FROM ${table} ORDER BY id`)).toEqual([{ id: 1 }, { id: 3 }]);
  });

  it('hands a failure to onError, which can replace the error', async () => {
    await expect(db.all('SELECT * FROM nowhere_at_all')).rejects.toThrow(/^hooked: /);
  });

  it('keeps the adapter itself: its kind, and on PostgreSQL its own methods', async () => {
    expect(db.kind).toBe(base.kind);
    if (engine === 'PostgreSQL') {
      expect(db).toBeInstanceOf(PostgresAdapter);
      expect(await (db as PostgresAdapter).withConnection((connection) => connection.get('SELECT 1 AS one'))).toEqual({ one: 1 });
    }
  });
});

describe('createDatabase({ hooks })', () => {
  it('returns the adapter with the hooks around it', async () => {
    const calls: string[] = [];
    const db = await createDatabase({
      type: 'memory',
      hooks: {
        onBeforeQuery: async (context) => {
          calls.push(context.statement);
          return context;
        },
      },
    });
    try {
      await db.get('SELECT 1 AS one');
      expect(calls).toEqual(['SELECT 1 AS one']);
    } finally {
      await db.close();
    }
  });
});
