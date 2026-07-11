import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPostgresAdapter } from '../src/adapters/postgresAdapter.js';
import { type StorageAdapter } from '../src/types.js';

vi.mock('pg', () => {
  const queries: Array<{
    source: 'pool' | 'client';
    clientId?: number;
    text: string;
    values?: unknown[];
  }> = [];
  let nextClientId = 0;

  class FakeClient {
    readonly id = ++nextClientId;

    async query(text: string, values?: unknown[]) {
      queries.push({ source: 'client', clientId: this.id, text, values });
      if (/SELECT/.test(text)) {
        return { rowCount: 1, rows: [{ id: 321, text, values }] };
      }
      return { rowCount: 1, rows: [] };
    }

    release(): void {}
  }

  class FakePool {
    async connect() {
      queries.push({ source: 'pool', text: 'CONNECT' });
      return new FakeClient();
    }

    async query(text: string, values?: unknown[]) {
      queries.push({ source: 'pool', text, values });
      if (/SELECT/.test(text)) {
        return { rowCount: 1, rows: [{ id: 123, text, values }] };
      }
      return { rowCount: 1, rows: [] };
    }

    async end(): Promise<void> {
      queries.push({ source: 'pool', text: 'END' });
    }
  }

  return { Pool: FakePool, __queries: queries };
});

const getQueries = async () => {
  const mod: any = await import('pg');
  return mod.__queries as Array<{
    source: 'pool' | 'client';
    clientId?: number;
    text: string;
    values?: unknown[];
  }>;
};

describe('PostgresAdapter', () => {
  beforeEach(async () => {
    const queries = await getQueries();
    queries.length = 0;
  });

  const CONNECTION = 'postgres://user:pass@localhost:5432/test_db';

  const withAdapter = async (fn: (adapter: StorageAdapter) => Promise<void>) => {
    const adapter = createPostgresAdapter(CONNECTION);
    await adapter.open();
    try {
      await fn(adapter);
    } finally {
      await adapter.close();
    }
  };

  it('binds named parameters in order', async () => {
    await withAdapter(async (adapter) => {
      await adapter.run(
        'INSERT INTO example (foo, bar) VALUES (@foo, @bar)',
        { foo: 'named', bar: 99 }
      );
      const queries = await getQueries();
      const insert = queries.find((entry) => entry.text.startsWith('INSERT INTO example'));
      expect(insert).toBeDefined();
      expect(insert?.values).toEqual(['named', 99]);
      expect(insert?.text).toContain('$1');
      expect(insert?.text).toContain('$2');
    });
  });

  it('supports positional parameters', async () => {
    await withAdapter(async (adapter) => {
      const row = await adapter.get<{ id: number }>('SELECT * FROM example WHERE id = ?', [42]);
      const queries = await getQueries();
      const select = queries.find((entry) => entry.text.startsWith('SELECT * FROM example'));
      expect(select).toBeDefined();
      expect(select?.values).toEqual([42]);
      expect(select?.text).toBe('SELECT * FROM example WHERE id = $1');
      expect(row?.id).toBe(123);
    });
  });

  it('exec() does not slice statements at semicolons inside `--` line comments', async () => {
    // Regression for the prod outage where the foundation_session_npcs
    // bootstrap DDL was sliced at a `;` inside a line comment, leaving an
    // unclosed paren and Postgres erroring with 42601 on every API request.
    const script = `
      CREATE TABLE foundation_session_npcs (
        id TEXT PRIMARY KEY,
        -- comment with a ; embedded that used to slice this DDL in half
        session_id TEXT NOT NULL
      );
      CREATE INDEX idx_session_npcs ON foundation_session_npcs(session_id);
    `;
    await withAdapter(async (adapter) => {
      await adapter.exec(script);
      const queries = await getQueries();
      const ddlQueries = queries.filter((entry) =>
        entry.text.startsWith('CREATE TABLE') || entry.text.startsWith('CREATE INDEX')
      );
      expect(ddlQueries).toHaveLength(2);

      const createTable = ddlQueries.find((entry) => entry.text.startsWith('CREATE TABLE'));
      expect(createTable).toBeDefined();
      // Balanced parens prove the table DDL wasn't sliced inside the comment.
      const opens = (createTable!.text.match(/\(/g) ?? []).length;
      const closes = (createTable!.text.match(/\)/g) ?? []).length;
      expect(opens).toBe(closes);
      expect(createTable!.text).toContain('session_id TEXT NOT NULL');

      const createIndex = ddlQueries.find((entry) => entry.text.startsWith('CREATE INDEX'));
      expect(createIndex).toBeDefined();
      expect(createIndex!.text).toContain('foundation_session_npcs(session_id)');
    });
  });

  it('wraps statements in explicit transactions', async () => {
    await withAdapter(async (adapter) => {
      await adapter.transaction(async (trx) => {
        await trx.run('UPDATE example SET foo = @foo WHERE id = @id', { foo: 'updated', id: 7 });
      });
      const queries = await getQueries();
      const beginIndex = queries.findIndex((entry) => entry.text === 'BEGIN');
      const updateIndex = queries.findIndex((entry) => entry.text.startsWith('UPDATE example'));
      const commitIndex = queries.findIndex((entry) => entry.text === 'COMMIT');
      expect(beginIndex).toBeGreaterThan(-1);
      expect(updateIndex).toBeGreaterThan(beginIndex);
      expect(commitIndex).toBeGreaterThan(updateIndex);
      const update = queries[updateIndex];
      expect(update.values).toEqual(['updated', 7]);
    });
  });

  it('keeps overlapping transaction callbacks bound to their own clients', async () => {
    await withAdapter(async (adapter) => {
      let arrivals = 0;
      let release: () => void = () => {};
      const bothReady = new Promise<void>((resolve) => {
        release = resolve;
      });
      const rendezvous = async () => {
        arrivals += 1;
        if (arrivals === 2) release();
        await bothReady;
      };

      await Promise.all([
        adapter.transaction(async (trx) => {
          await rendezvous();
          await trx.run('UPDATE example SET foo = ? WHERE id = ?', ['first', 1]);
        }),
        adapter.transaction(async (trx) => {
          await rendezvous();
          await trx.run('UPDATE example SET foo = ? WHERE id = ?', ['second', 2]);
        }),
      ]);

      const queries = await getQueries();
      const first = queries.find((entry) => entry.values?.[0] === 'first');
      const second = queries.find((entry) => entry.values?.[0] === 'second');
      expect(first?.source).toBe('client');
      expect(second?.source).toBe('client');
      expect(first?.clientId).toBeDefined();
      expect(second?.clientId).toBeDefined();
      expect(first?.clientId).not.toBe(second?.clientId);
    });
  });
});
