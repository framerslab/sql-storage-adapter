import { describe, expect, it, beforeEach } from 'vitest';
import initSqlJs from 'sql.js';
import type { Database as SqlJsDatabase } from 'sql.js';
import { CapacitorSqliteAdapter } from '../src/adapters/capacitorSqliteAdapter';

/**
 * A connection of @capacitor-community/sqlite, run on sql.js. It keeps the
 * rules of the plugin's native code (android Database.java execute and runSQL,
 * ios Database.swift executeSQL and runSQL): a call with `transaction` true,
 * the default, begins its own transaction and commits it, and fails when a
 * transaction is already open; beginTransaction, commitTransaction and
 * rollbackTransaction (plugin 5.0.7 and later) hold one open across calls; run
 * answers `{ changes: { changes, lastId } }`.
 *
 * Each step of a call runs in a task of its own, so two calls in flight at once
 * interleave: the adapter must not rely on the bridge finishing one call before
 * it starts the next.
 */
class FakePluginConnection {
  public readonly calls: string[] = [];
  private active = false;

  constructor(private readonly db: SqlJsDatabase) {}

  private nextTask(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
  }

  private begin(): void {
    if (this.active) throw new Error('Already in transaction');
    this.db.run('BEGIN TRANSACTION');
    this.active = true;
  }

  private commit(): void {
    if (!this.active) throw new Error('No transaction active');
    this.db.run('COMMIT');
    this.active = false;
  }

  private rollback(): void {
    if (!this.active) return;
    this.db.run('ROLLBACK');
    this.active = false;
  }

  /** Runs `work` inside a transaction of the call's own when `transaction` is true. */
  private async inOwnTransaction<T>(transaction: boolean, work: () => T): Promise<T> {
    await this.nextTask();
    if (!transaction) return work();
    this.begin();
    try {
      await this.nextTask();
      const result = work();
      await this.nextTask();
      this.commit();
      return result;
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  async open(): Promise<void> {}

  async close(): Promise<void> {}

  async beginTransaction(): Promise<{ changes: { changes: number } }> {
    this.calls.push('beginTransaction');
    await this.nextTask();
    this.begin();
    return { changes: { changes: 0 } };
  }

  async commitTransaction(): Promise<{ changes: { changes: number } }> {
    this.calls.push('commitTransaction');
    await this.nextTask();
    this.commit();
    return { changes: { changes: 0 } };
  }

  async rollbackTransaction(): Promise<{ changes: { changes: number } }> {
    this.calls.push('rollbackTransaction');
    await this.nextTask();
    this.rollback();
    return { changes: { changes: 0 } };
  }

  async execute(statements: string, transaction = true): Promise<{ changes: { changes: number } }> {
    this.calls.push(`execute(${transaction})`);
    return this.inOwnTransaction(transaction, () => {
      this.db.exec(statements);
      return { changes: { changes: this.db.getRowsModified() } };
    });
  }

  async run(
    statement: string,
    values: unknown[] = [],
    transaction = true,
  ): Promise<{ changes: { changes: number; lastId: number } }> {
    this.calls.push(`run(${transaction})`);
    return this.inOwnTransaction(transaction, () => {
      this.db.run(statement, values as never);
      const lastId = Number(this.db.exec('SELECT last_insert_rowid()')[0].values[0][0]);
      return { changes: { changes: this.db.getRowsModified(), lastId } };
    });
  }

  async query(statement: string, values: unknown[] = []): Promise<{ values: Record<string, unknown>[] }> {
    this.calls.push('query');
    await this.nextTask();
    const stmt = this.db.prepare(statement);
    try {
      stmt.bind(values as never);
      const rows: Record<string, unknown>[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return { values: rows };
    } finally {
      stmt.free();
    }
  }
}

/** A promise and the function that settles it. */
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

/** Lets the fake bridge answer the calls in flight. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 25; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

describe('CapacitorSqliteAdapter', () => {
  let connection: FakePluginConnection;
  let adapter: CapacitorSqliteAdapter;

  const labels = async (): Promise<string[]> =>
    (await adapter.all<{ label: string }>('SELECT label FROM items ORDER BY id')).map((row) => row.label);

  beforeEach(async () => {
    const SQL = await initSqlJs();
    connection = new FakePluginConnection(new SQL.Database());
    adapter = new CapacitorSqliteAdapter();
    // open() loads the plugin from @capacitor-community/sqlite and asks it for a
    // connection; the spec hands the adapter this connection instead.
    (adapter as unknown as { connection: FakePluginConnection }).connection = connection;
    await adapter.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL)');
  });

  it("reports run()'s changes and inserted row id from the plugin's answer", async () => {
    const first = await adapter.run('INSERT INTO items (label) VALUES (?)', ['one']);
    const second = await adapter.run('INSERT INTO items (label) VALUES (?)', ['two']);

    expect(first).toEqual({ changes: 1, lastInsertRowid: 1 });
    expect(second).toEqual({ changes: 1, lastInsertRowid: 2 });
  });

  it("commits a transaction through the plugin's transaction calls", async () => {
    connection.calls.length = 0;

    await adapter.transaction(async (trx) => {
      await trx.run('INSERT INTO items (label) VALUES (?)', ['first']);
      await trx.run('INSERT INTO items (label) VALUES (?)', ['second']);
    });

    expect(await labels()).toEqual(['first', 'second']);
    expect(connection.calls).toEqual(['beginTransaction', 'run(false)', 'run(false)', 'commitTransaction', 'query']);
  });

  it('rolls a transaction back whole when its callback throws', async () => {
    await expect(
      adapter.transaction(async (trx) => {
        await trx.run('INSERT INTO items (label) VALUES (?)', ['doomed']);
        await trx.exec("INSERT INTO items (label) VALUES ('also doomed')");
        throw new Error('roll back');
      }),
    ).rejects.toThrow('roll back');

    expect(await labels()).toEqual([]);
  });

  it('runs two overlapping transactions one after the other, and both commit', async () => {
    const firstStarted = deferred();
    const firstCanFinish = deferred();
    const order: string[] = [];

    const first = adapter.transaction(async (trx) => {
      order.push('first:start');
      await trx.run('INSERT INTO items (label) VALUES (?)', ['first']);
      firstStarted.resolve();
      await firstCanFinish.promise;
      order.push('first:end');
    });
    await Promise.race([firstStarted.promise, first]);

    const second = adapter.transaction(async (trx) => {
      order.push('second:start');
      await trx.run('INSERT INTO items (label) VALUES (?)', ['second']);
      order.push('second:end');
    });
    await settle();
    expect(order).toEqual(['first:start']);

    firstCanFinish.resolve();
    await Promise.all([first, second]);

    expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
    expect(await labels()).toEqual(['first', 'second']);
  });

  it('makes a write from outside an open transaction wait for it, so it survives the rollback', async () => {
    const started = deferred();
    const outsideWork = deferred();
    const transaction = adapter
      .transaction(async (trx) => {
        await trx.run('INSERT INTO items (label) VALUES (?)', ['inside']);
        started.resolve();
        await outsideWork.promise;
        throw new Error('roll back');
      })
      .catch((error: Error) => error.message);
    await Promise.race([started.promise, transaction]);

    let written = false;
    const write = adapter.run('INSERT INTO items (label) VALUES (?)', ['outside']).then(() => {
      written = true;
    });
    await settle();
    expect(written).toBe(false);

    outsideWork.resolve();
    expect(await transaction).toBe('roll back');
    await write;
    expect(await labels()).toEqual(['outside']);
  });

  it('begins a transaction only after the statements sent before it have answered', async () => {
    const write = adapter.run('INSERT INTO items (label) VALUES (?)', ['sent first']);
    await adapter.transaction(async (trx) => {
      await trx.run('INSERT INTO items (label) VALUES (?)', ['inside']);
    });
    await write;

    expect(await labels()).toEqual(['sent first', 'inside']);
  });
});
