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

  export interface SQLiteDBConnection {
    open(): Promise<void>;
    close(): Promise<void>;
    /** With `transaction` true, the default, the plugin runs the statements in a transaction of its own. */
    execute(statements: string, transaction?: boolean): Promise<SQLiteChangesResult>;
    /** With `transaction` true, the default, the plugin runs the statement in a transaction of its own. */
    run(statement: string, values?: unknown[], transaction?: boolean): Promise<SQLiteChangesResult>;
    query<T = unknown>(statement: string, values?: unknown[]): Promise<SQLiteQueryResult<T>>;
    /** Plugin 5.0.7 and later. */
    beginTransaction(): Promise<SQLiteChangesResult>;
    /** Plugin 5.0.7 and later. */
    commitTransaction(): Promise<SQLiteChangesResult>;
    /** Plugin 5.0.7 and later. */
    rollbackTransaction(): Promise<SQLiteChangesResult>;
  }

  export interface CapacitorSQLitePlugin {
    createConnection(
      database: string,
      encrypted: boolean,
      mode: string,
      version: number,
      readonly: boolean
    ): Promise<SQLiteDBConnection>;
  }

  export const CapacitorSQLite: CapacitorSQLitePlugin;
  const plugin: CapacitorSQLitePlugin;
  export default plugin;
}
