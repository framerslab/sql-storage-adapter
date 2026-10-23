declare module '@capacitor-community/sqlite' {
  /** What a run or execute call changed (`Changes` in the plugin's definitions). */
  export interface Changes {
    changes?: number;
    lastId?: number;
    values?: unknown[];
  }

  /** The answer of run, execute and the transaction calls (`capSQLiteChanges`). */
  export interface SQLiteChangesResult {
    changes?: Changes;
  }

  export interface SQLiteQueryResult<T = unknown> {
    values?: T[];
  }

  /** A connection SQLiteConnection made, to one database. */
  export interface SQLiteDBConnection {
    open(): Promise<void>;
    close(): Promise<void>;
    /** With `transaction` true, the default, the plugin runs the statements in a transaction of its own. */
    execute(statements: string, transaction?: boolean): Promise<SQLiteChangesResult>;
    /** With `transaction` true, the default, the plugin runs the statement in a transaction of its own. */
    run(statement: string, values?: unknown[], transaction?: boolean): Promise<SQLiteChangesResult>;
    /** Runs the statement as it is, outside any transaction of the plugin's own, and answers its rows. */
    query<T = unknown>(statement: string, values?: unknown[]): Promise<SQLiteQueryResult<T>>;
    /** Plugin 5.0.7 and later. */
    beginTransaction(): Promise<SQLiteChangesResult>;
    /** Plugin 5.0.7 and later. */
    commitTransaction(): Promise<SQLiteChangesResult>;
    /** Plugin 5.0.7 and later. */
    rollbackTransaction(): Promise<SQLiteChangesResult>;
  }

  /**
   * The native plugin. Each of its methods takes one options object; the
   * adapter reaches it through SQLiteConnection.
   */
  export interface CapacitorSQLitePlugin {
    createConnection(options: {
      database?: string;
      version?: number;
      encrypted?: boolean;
      mode?: string;
      readonly?: boolean;
    }): Promise<void>;
    closeConnection(options: { database?: string; readonly?: boolean }): Promise<void>;
  }

  /** The plugin's JavaScript side over CapacitorSQLite: it makes the connections and holds them. */
  export class SQLiteConnection {
    constructor(sqlite: CapacitorSQLitePlugin);
    createConnection(
      database: string,
      encrypted: boolean,
      mode: string,
      version: number,
      readonly: boolean,
    ): Promise<SQLiteDBConnection>;
    closeConnection(database: string, readonly: boolean): Promise<void>;
  }

  export const CapacitorSQLite: CapacitorSQLitePlugin;
}
