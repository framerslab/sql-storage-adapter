import { describe, expect, it, afterEach, vi } from 'vitest';
import { CapacitorSqliteAdapter } from '../src/adapters/capacitorSqliteAdapter';

/**
 * @capacitor-community/sqlite as an app loads it on a device: the native plugin,
 * CapacitorSQLite, whose methods each take one options object, and the plugin's
 * JavaScript classes over it, SQLiteConnection and SQLiteDBConnection (the
 * plugin's src/definitions.ts). The package is not installed here, so the spec
 * mocks it. Its native side runs on sql.js and keeps the plugin's rules (android
 * CapacitorSQLite.java and Database.java, ios CapacitorSQLite.swift and
 * Database.swift):
 * - createConnection needs a database name and refuses a connection it already
 *   holds; it keeps a connection until closeConnection, across reloads of the
 *   page;
 * - open turns foreign keys on;
 * - execute and run with `transaction` true, the default, run inside a
 *   transaction of their own, which cannot nest in an open one;
 * - SQLite refuses to change into WAL inside a transaction;
 * - SQLiteConnection drops a trailing ".db" from a database name, so "notes.db"
 *   and "notes" name one connection;
 * - on Android, execute and run go through execSQL, which fails on a statement
 *   that answers a row, as PRAGMA journal_mode = WAL does; query reads it.
 */
const plugin = vi.hoisted(() => {
  type SqlDatabase = import('sql.js').Database;
  type SqlStatic = import('sql.js').SqlJsStatic;

  const ANDROID_ROW_ERROR = 'Queries can be performed using SQLiteDatabase query or rawQuery methods only.';
  const WAL_IN_TRANSACTION = 'cannot change into wal mode from within a transaction';

  let sqlJs: Promise<SqlStatic> | null = null;
  const loadSqlJs = (): Promise<SqlStatic> => {
    if (!sqlJs) sqlJs = import('sql.js').then((module) => module.default());
    return sqlJs;
  };

  /** A database file on the device: it outlives the connections to it. */
  interface DeviceFile {
    db: SqlDatabase;
    journalMode: string;
  }

  /** A native connection, as the plugin's dictionary of connections holds it. */
  interface NativeConnection {
    database: string;
    file: DeviceFile | null;
    inTransaction: boolean;
  }

  type OpenConnection = NativeConnection & { file: DeviceFile };

  const files = new Map<string, DeviceFile>();
  const connections = new Map<string, NativeConnection>();
  const calls: string[] = [];

  const nextTask = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  const optionsOf = (options: unknown, method: string): Record<string, unknown> & { database: string } => {
    if (typeof options !== 'object' || options === null || typeof (options as { database?: unknown }).database !== 'string') {
      throw new Error(`${method}: Must provide a database name`);
    }
    return options as Record<string, unknown> & { database: string };
  };

  const keyOf = (options: Record<string, unknown> & { database: string }): string =>
    `${options.readonly ? 'RO' : 'RW'}_${options.database}`;

  const openConnection = (options: unknown, method: string): OpenConnection => {
    const named = optionsOf(options, method);
    const connection = connections.get(keyOf(named));
    if (!connection) throw new Error(`${method}: No available connection for database ${named.database}`);
    if (!connection.file) throw new Error(`${method}: database ${named.database} not opened`);
    return connection as OpenConnection;
  };

  const closeFile = (connection: NativeConnection): void => {
    if (connection.file && connection.inTransaction) {
      connection.file.db.run('ROLLBACK');
    }
    connection.inTransaction = false;
    connection.file = null;
  };

  const setsWal = (statement: string): boolean => /^\s*PRAGMA\s+journal_mode\s*=\s*'?wal'?\s*;?\s*$/i.test(statement);

  /** One statement through Android's execSQL: a statement that answers a row fails. */
  const execSql = (connection: OpenConnection, statement: string, values: unknown[] = []): void => {
    if (setsWal(statement)) {
      if (connection.inTransaction) throw new Error(WAL_IN_TRANSACTION);
      // The mode changes on the statement's first step, before the row it answers fails the call.
      connection.file.journalMode = 'wal';
      throw new Error(ANDROID_ROW_ERROR);
    }
    const prepared = connection.file.db.prepare(statement);
    try {
      if (values.length > 0) prepared.bind(values as never);
      if (prepared.step()) throw new Error(ANDROID_ROW_ERROR);
    } finally {
      prepared.free();
    }
  };

  /** Runs `work` inside a transaction of the call's own when `transaction` is true. */
  const inOwnTransaction = <T>(connection: OpenConnection, transaction: boolean, work: () => T): T => {
    if (!transaction) return work();
    if (connection.inTransaction) throw new Error('Already in transaction');
    connection.file.db.run('BEGIN TRANSACTION');
    connection.inTransaction = true;
    try {
      const result = work();
      connection.file.db.run('COMMIT');
      return result;
    } catch (error) {
      connection.file.db.run('ROLLBACK');
      throw error;
    } finally {
      connection.inTransaction = false;
    }
  };

  /** The statements of a script; the spec's scripts carry no semicolon inside a string. */
  const statementsOf = (script: string): string[] =>
    script
      .split(';')
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);

  const CapacitorSQLite = {
    async createConnection(options: unknown): Promise<void> {
      calls.push('createConnection');
      await nextTask();
      const named = optionsOf(options, 'CreateConnection');
      if (connections.has(keyOf(named))) {
        throw new Error(`CreateConnection: Connection ${named.database} already exists`);
      }
      connections.set(keyOf(named), { database: named.database, file: null, inTransaction: false });
    },

    async closeConnection(options: unknown): Promise<void> {
      calls.push('closeConnection');
      await nextTask();
      const named = optionsOf(options, 'CloseConnection');
      const connection = connections.get(keyOf(named));
      if (!connection) throw new Error(`CloseConnection: No available connection for database ${named.database}`);
      closeFile(connection);
      connections.delete(keyOf(named));
    },

    async open(options: unknown): Promise<void> {
      calls.push('open');
      await nextTask();
      const named = optionsOf(options, 'Open');
      const connection = connections.get(keyOf(named));
      if (!connection) throw new Error(`Open: No available connection for database ${named.database}`);
      const SQL = await loadSqlJs();
      let file = files.get(named.database);
      if (!file) {
        file = { db: new SQL.Database(), journalMode: 'delete' };
        files.set(named.database, file);
      }
      file.db.run('PRAGMA foreign_keys = ON');
      connection.file = file;
    },

    async close(options: unknown): Promise<void> {
      calls.push('close');
      await nextTask();
      const named = optionsOf(options, 'Close');
      const connection = connections.get(keyOf(named));
      if (!connection) throw new Error(`Close: No available connection for database ${named.database}`);
      closeFile(connection);
    },

    async execute(options: unknown): Promise<{ changes: { changes: number } }> {
      calls.push('execute');
      await nextTask();
      const connection = openConnection(options, 'Execute');
      const { statements, transaction = true } = options as { statements: string; transaction?: boolean };
      return inOwnTransaction(connection, transaction, () => {
        for (const statement of statementsOf(statements)) execSql(connection, statement);
        return { changes: { changes: connection.file.db.getRowsModified() } };
      });
    },

    async run(options: unknown): Promise<{ changes: { changes: number; lastId: number } }> {
      calls.push('run');
      await nextTask();
      const connection = openConnection(options, 'Run');
      const { statement, values = [], transaction = true } = options as {
        statement: string;
        values?: unknown[];
        transaction?: boolean;
      };
      return inOwnTransaction(connection, transaction, () => {
        execSql(connection, statement, values);
        const lastId = Number(connection.file.db.exec('SELECT last_insert_rowid()')[0].values[0][0]);
        return { changes: { changes: connection.file.db.getRowsModified(), lastId } };
      });
    },

    async query(options: unknown): Promise<{ values: Record<string, unknown>[] }> {
      calls.push('query');
      await nextTask();
      const connection = openConnection(options, 'Query');
      const { statement, values = [] } = options as { statement: string; values?: unknown[] };
      if (setsWal(statement)) {
        if (connection.inTransaction) throw new Error(WAL_IN_TRANSACTION);
        connection.file.journalMode = 'wal';
        return { values: [{ journal_mode: 'wal' }] };
      }
      const prepared = connection.file.db.prepare(statement);
      try {
        if (values.length > 0) prepared.bind(values as never);
        const rows: Record<string, unknown>[] = [];
        while (prepared.step()) rows.push(prepared.getAsObject());
        return { values: rows };
      } finally {
        prepared.free();
      }
    },

    async beginTransaction(options: unknown): Promise<{ changes: { changes: number } }> {
      calls.push('beginTransaction');
      await nextTask();
      const connection = openConnection(options, 'BeginTransaction');
      if (connection.inTransaction) throw new Error('BeginTransaction: Failed in beginTransactionAlready in transaction');
      connection.file.db.run('BEGIN TRANSACTION');
      connection.inTransaction = true;
      return { changes: { changes: 0 } };
    },

    async commitTransaction(options: unknown): Promise<{ changes: { changes: number } }> {
      calls.push('commitTransaction');
      await nextTask();
      const connection = openConnection(options, 'CommitTransaction');
      if (!connection.inTransaction) throw new Error('CommitTransaction: Failed in commitTransactionNo transaction active');
      connection.file.db.run('COMMIT');
      connection.inTransaction = false;
      return { changes: { changes: 0 } };
    },

    async rollbackTransaction(options: unknown): Promise<{ changes: { changes: number } }> {
      calls.push('rollbackTransaction');
      await nextTask();
      const connection = openConnection(options, 'RollbackTransaction');
      if (connection.inTransaction) {
        connection.file.db.run('ROLLBACK');
        connection.inTransaction = false;
      }
      return { changes: { changes: 0 } };
    },
  };

  type Plugin = typeof CapacitorSQLite;

  class SQLiteDBConnection {
    constructor(
      private readonly dbName: string,
      private readonly readOnly: boolean,
      private readonly sqlite: Plugin,
    ) {}

    open() {
      return this.sqlite.open({ database: this.dbName, readonly: this.readOnly });
    }

    close() {
      return this.sqlite.close({ database: this.dbName, readonly: this.readOnly });
    }

    execute(statements: string, transaction = true) {
      return this.sqlite.execute({ database: this.dbName, statements, transaction, readonly: false });
    }

    run(statement: string, values: unknown[] = [], transaction = true) {
      return this.sqlite.run({ database: this.dbName, statement, values, transaction, readonly: false });
    }

    query(statement: string, values: unknown[] = []) {
      return this.sqlite.query({ database: this.dbName, statement, values, readonly: this.readOnly });
    }

    beginTransaction() {
      return this.sqlite.beginTransaction({ database: this.dbName });
    }

    commitTransaction() {
      return this.sqlite.commitTransaction({ database: this.dbName });
    }

    rollbackTransaction() {
      return this.sqlite.rollbackTransaction({ database: this.dbName });
    }
  }

  class SQLiteConnection {
    private readonly held = new Map<string, SQLiteDBConnection>();

    constructor(private readonly sqlite: Plugin) {}

    async createConnection(database: string, encrypted: boolean, mode: string, version: number, readonly: boolean) {
      if (database.endsWith('.db')) database = database.slice(0, -3);
      await this.sqlite.createConnection({ database, encrypted, mode, version, readonly });
      const connection = new SQLiteDBConnection(database, readonly, this.sqlite);
      this.held.set(`${readonly ? 'RO' : 'RW'}_${database}`, connection);
      return connection;
    }

    async closeConnection(database: string, readonly: boolean) {
      if (database.endsWith('.db')) database = database.slice(0, -3);
      await this.sqlite.closeConnection({ database, readonly });
      this.held.delete(`${readonly ? 'RO' : 'RW'}_${database}`);
    }

    async isConnection(database: string, readonly: boolean) {
      if (database.endsWith('.db')) database = database.slice(0, -3);
      return { result: this.held.has(`${readonly ? 'RO' : 'RW'}_${database}`) };
    }
  }

  return {
    module: { CapacitorSQLite, SQLiteConnection, SQLiteDBConnection },
    connections,
    calls,
    journalMode: (database: string): string | undefined => files.get(database)?.journalMode,
  };
});

vi.mock('@capacitor-community/sqlite', () => plugin.module);

describe('CapacitorSqliteAdapter open() and close() on @capacitor-community/sqlite', () => {
  const adapters: CapacitorSqliteAdapter[] = [];

  const openAdapter = async (database: string, options: { enableWal?: boolean } = {}): Promise<CapacitorSqliteAdapter> => {
    const adapter = new CapacitorSqliteAdapter({ database, ...options });
    adapters.push(adapter);
    await adapter.open();
    return adapter;
  };

  afterEach(async () => {
    for (const adapter of adapters.splice(0)) {
      await adapter.close().catch(() => undefined);
    }
    vi.restoreAllMocks();
  });

  it("opens its database through the plugin's SQLiteConnection and runs statements on it", async () => {
    const adapter = await openAdapter('notes');
    await adapter.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)');

    expect(await adapter.run('INSERT INTO notes (body) VALUES (?)', ['first'])).toEqual({ changes: 1, lastInsertRowid: 1 });
    expect(await adapter.all('SELECT body FROM notes')).toEqual([{ body: 'first' }]);
    expect(plugin.connections.has('RW_notes')).toBe(true);
  });

  it("turns WAL on at open, outside the plugin's own transaction, and warns of nothing", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await openAdapter('wal');

    expect(plugin.journalMode('wal')).toBe('wal');
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps the plugin's foreign keys on by default, and foreignKeys false turns them off", async () => {
    const byDefault = await openAdapter('foreign-keys-default', { enableWal: false });
    expect(await byDefault.get('PRAGMA foreign_keys')).toEqual({ foreign_keys: 1 });

    const off = new CapacitorSqliteAdapter({ database: 'foreign-keys-off', enableWal: false });
    adapters.push(off);
    await off.open({ foreignKeys: false });
    expect(await off.get('PRAGMA foreign_keys')).toEqual({ foreign_keys: 0 });
  });

  it('stays closed, with no native connection left, when foreignKeys cannot be set at open', async () => {
    const native = plugin.module.CapacitorSQLite;
    const refuse = <T extends (options: unknown) => Promise<unknown>>(method: T): T =>
      (async (options: unknown) => {
        const { statement, statements } = options as { statement?: string; statements?: string };
        if (/foreign_keys\s*=/i.test(statement ?? statements ?? '')) throw new Error('foreign_keys refused');
        return method(options);
      }) as T;
    // The plugin's own methods, taken before the spies stand in for them.
    const realQuery = native.query.bind(native);
    const realExecute = native.execute.bind(native);
    const query = vi.spyOn(native, 'query').mockImplementation(refuse(realQuery));
    const execute = vi.spyOn(native, 'execute').mockImplementation(refuse(realExecute));
    const adapter = new CapacitorSqliteAdapter({ database: 'foreign-keys-refused', enableWal: false });
    adapters.push(adapter);

    await expect(adapter.open({ foreignKeys: false })).rejects.toThrow(/foreign_keys refused/);
    expect(plugin.connections.has('RW_foreign-keys-refused')).toBe(false);

    query.mockRestore();
    execute.mockRestore();
    await adapter.open({ foreignKeys: false });
    expect(await adapter.get('PRAGMA foreign_keys')).toEqual({ foreign_keys: 0 });
  });

  it('opens once when open() is called twice at once, and works after both resolve', async () => {
    const adapter = new CapacitorSqliteAdapter({ database: 'twice', enableWal: false });
    adapters.push(adapter);

    await Promise.all([adapter.open(), adapter.open()]);

    expect(plugin.connections.has('RW_twice')).toBe(true);
    await adapter.exec('CREATE TABLE notes (body TEXT NOT NULL)');
    await adapter.run('INSERT INTO notes (body) VALUES (?)', ['once']);
    expect(await adapter.all('SELECT body FROM notes')).toEqual([{ body: 'once' }]);
  });

  it("hands execute() the script's own text between its edge PRAGMAs, so a quoted name with a semicolon inside reaches the plugin as written", async () => {
    const adapter = await openAdapter('quoted-names', { enableWal: false });
    const native = plugin.module.CapacitorSQLite;
    const scripts: string[] = [];
    // The plugin's own execute() splits a script on semicolons itself; the
    // adapter's part is to hand it the script as the caller wrote it.
    vi.spyOn(native, 'execute').mockImplementation(async (options: unknown) => {
      scripts.push((options as { statements: string }).statements);
      return { changes: { changes: 0 } };
    });

    await adapter.exec(
      'PRAGMA foreign_keys = OFF;\nCREATE TABLE [a;b] (id INTEGER PRIMARY KEY);\nINSERT INTO `c;d` (v) VALUES (\';\');\nPRAGMA foreign_keys = ON;',
    );

    expect(scripts).toEqual(["CREATE TABLE [a;b] (id INTEGER PRIMARY KEY);\nINSERT INTO `c;d` (v) VALUES (';')"]);
    expect(await adapter.get('PRAGMA foreign_keys')).toEqual({ foreign_keys: 1 });
  });

  it('closes its native connection, so the database opens again with its rows', async () => {
    const first = await openAdapter('reopen');
    await first.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)');
    await first.run('INSERT INTO notes (body) VALUES (?)', ['kept']);
    await first.close();
    expect(plugin.connections.has('RW_reopen')).toBe(false);

    const second = await openAdapter('reopen');
    expect(await second.all('SELECT body FROM notes')).toEqual([{ body: 'kept' }]);
  });

  it('refuses a database whose connection the plugin holds for something else, and leaves that connection as it is', async () => {
    // Another part of the app opened it through the plugin, or a page before a
    // reload did and the plugin's native side kept the connection. The adapter
    // cannot tell the two apart, and closing the connection would end a
    // transaction its holder has open, so it closes nothing.
    const native = plugin.module.CapacitorSQLite;
    await native.createConnection({ database: 'held', readonly: false });
    await native.open({ database: 'held', readonly: false });
    await native.execute({
      database: 'held',
      statements: "CREATE TABLE notes (body TEXT NOT NULL); INSERT INTO notes (body) VALUES ('held outside the adapter');",
    });
    const callsBefore = plugin.calls.length;

    await expect(openAdapter('held')).rejects.toThrow(/already has a connection to database "held"/);

    expect(plugin.calls.slice(callsBefore)).not.toContain('closeConnection');
    expect(plugin.connections.get('RW_held')?.file).toBeTruthy();
    expect(await native.query({ database: 'held', statement: 'SELECT body FROM notes', readonly: false })).toEqual({
      values: [{ body: 'held outside the adapter' }],
    });

    // Closed where it was opened, the database opens through an adapter.
    await native.closeConnection({ database: 'held', readonly: false });
    const adapter = await openAdapter('held');
    expect(await adapter.all('SELECT body FROM notes')).toEqual([{ body: 'held outside the adapter' }]);
  });

  it('refuses a second adapter on a database another adapter has open, and the first keeps working', async () => {
    const first = await openAdapter('shared');
    await first.exec('CREATE TABLE notes (body TEXT NOT NULL)');

    await expect(openAdapter('shared')).rejects.toThrow(/already has database "shared" open/);

    await first.run('INSERT INTO notes (body) VALUES (?)', ['still open']);
    expect(await first.all('SELECT body FROM notes')).toEqual([{ body: 'still open' }]);
  });

  it('refuses a second adapter that names the open database with ".db", which the plugin reads as the same database', async () => {
    const first = await openAdapter('journal');
    await first.exec('CREATE TABLE notes (body TEXT NOT NULL)');

    await expect(openAdapter('journal.db')).rejects.toThrow(/already has database "journal" open/);

    await first.run('INSERT INTO notes (body) VALUES (?)', ['still open']);
    expect(await first.all('SELECT body FROM notes')).toEqual([{ body: 'still open' }]);
    expect(plugin.connections.has('RW_journal')).toBe(true);

    // Closed, the database opens again under either name.
    await first.close();
    const second = await openAdapter('journal.db');
    expect(await second.all('SELECT body FROM notes')).toEqual([{ body: 'still open' }]);
  });

  it("runs PRAGMA statements from exec() and run() outside the plugin's own transaction", async () => {
    const adapter = await openAdapter('pragmas', { enableWal: false });
    expect(await adapter.get('PRAGMA foreign_keys')).toEqual({ foreign_keys: 1 });

    await adapter.exec('PRAGMA foreign_keys = OFF');
    expect(await adapter.get('PRAGMA foreign_keys')).toEqual({ foreign_keys: 0 });

    await adapter.run('PRAGMA journal_mode = WAL');
    expect(plugin.journalMode('pragmas')).toBe('wal');
  });

  it('keeps the child rows when a script rebuilds their parent table between PRAGMA foreign_keys OFF and ON', async () => {
    // SQLite's procedure for changing a table's definition: foreign keys off,
    // copy the table into a new one, drop it, rename the copy, foreign keys on.
    const adapter = await openAdapter('rebuild', { enableWal: false });
    await adapter.exec(
      'CREATE TABLE parent (id INTEGER PRIMARY KEY, name TEXT);' +
        'CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent (id) ON DELETE CASCADE);' +
        "INSERT INTO parent (id, name) VALUES (1, 'one');" +
        'INSERT INTO child (parent_id) VALUES (1);',
    );

    await adapter.exec(
      'PRAGMA foreign_keys = OFF;' +
        'CREATE TABLE parent_new (id INTEGER PRIMARY KEY, name TEXT NOT NULL);' +
        'INSERT INTO parent_new (id, name) SELECT id, name FROM parent;' +
        'DROP TABLE parent;' +
        'ALTER TABLE parent_new RENAME TO parent;' +
        'PRAGMA foreign_keys = ON;',
    );

    expect(await adapter.all('SELECT parent_id FROM child')).toEqual([{ parent_id: 1 }]);
    expect(await adapter.get('PRAGMA foreign_keys')).toEqual({ foreign_keys: 1 });
  });
});
