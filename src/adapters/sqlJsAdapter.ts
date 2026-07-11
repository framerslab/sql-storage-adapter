import initSqlJs from 'sql.js';
import type { SqlJsStatic, SqlJsConfig, Database as SqlJsDatabase } from 'sql.js';
import fs from 'fs';
import path from 'path';
import type { StorageAdapter, StorageCapability, StorageOpenOptions, StorageParameters, StorageRunResult } from '../core/contracts';
import { normaliseParameters } from '../shared/parameterUtils';
import {
  createSerializedTransactionRunner,
  createSharedConnectionTransactionAdapter,
} from '../shared/serializedTransaction';

type SqlJsAdapterOptions = SqlJsConfig;

const expandNamedParameters = (named: Record<string, unknown>): Record<string, unknown> => {
  const expanded: Record<string, unknown> = { ...named };
  for (const [rawKey, value] of Object.entries(named)) {
    if (!rawKey) continue;
    const key = rawKey.replace(/^[:@$]/, '');
    if (!key) continue;
    // sql.js expects keys to match the placeholder format (":id", "@id", "$id").
    // Other adapters (better-sqlite3) accept bare keys ("id") for "@id" placeholders.
    // Expand all variants so the same query payload works across adapters.
    if (!(key in expanded)) expanded[key] = value;
    if (!(`:${key}` in expanded)) expanded[`:${key}`] = value;
    if (!(`@${key}` in expanded)) expanded[`@${key}`] = value;
    if (!(`$${key}` in expanded)) expanded[`$${key}`] = value;
  }
  return expanded;
};

const normaliseRowId = (value: unknown): string | number | null => {
  if (typeof value === 'number' || typeof value === 'string') {
    return value;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  return null;
};

const hasFsAccess = (): boolean => {
  try {
    return typeof fs.accessSync === 'function';
  } catch {
    return false;
  }
};

/**
 * Storage adapter backed by sql.js (WebAssembly) for environments without native SQLite bindings.
 */
export class SqlJsAdapter implements StorageAdapter {
  public readonly kind = 'sqljs';
  public readonly capabilities: ReadonlySet<StorageCapability>;

  private SQL: SqlJsStatic | null = null;
  private db: SqlJsDatabase | null = null;
  private filePath?: string;
  private readonly runSerializedTransaction = createSerializedTransactionRunner();
  /**
   * Open transaction depth. > 0 means a SQLite-level transaction is in
   * flight on this connection and {@link persistIfNeeded} MUST be
   * skipped until the outermost commit / rollback returns.
   *
   * Why this exists: sql.js's `db.export()` (called by persistIfNeeded
   * to flush state to disk) ends any open transaction as a side
   * effect. Persisting mid-transaction therefore SILENTLY closes the
   * tx, making subsequent COMMIT / ROLLBACK throw "no transaction is
   * active" and — worse — leaking partial writes onto disk that the
   * matching rollback can no longer undo. Counter is bumped on
   * BEGIN/SAVEPOINT and decremented on COMMIT/RELEASE/ROLLBACK
   * regardless of whether the statement is issued via {@link run}
   * (caller-managed transactions) or {@link transaction} (helper-
   * managed). One source of truth for the in-tx flag.
   */
  private transactionDepth = 0;

  constructor(private readonly adapterOptions: SqlJsAdapterOptions = {}) {
    const caps: StorageCapability[] = ['transactions', 'json', 'prepared'];
    if (hasFsAccess()) {
      caps.push('persistence');
    }
    this.capabilities = new Set(caps);
  }

  public async open(options?: StorageOpenOptions): Promise<void> {
    if (this.db) {
      return;
    }

    this.SQL = await initSqlJs(this.adapterOptions);
    this.filePath = options?.filePath;

    if (this.filePath && hasFsAccess() && fs.existsSync(this.filePath)) {
      const buffer = fs.readFileSync(this.filePath);
      this.db = new this.SQL.Database(buffer);
    } else {
      this.db = new this.SQL.Database();
    }
  }

  public async run(statement: string, parameters?: StorageParameters): Promise<StorageRunResult> {
    // Detect caller-managed transaction control (BEGIN / SAVEPOINT /
    // COMMIT / ROLLBACK / RELEASE) so we can keep the tx depth in
    // sync regardless of whether the caller uses {@link transaction}
    // or issues control statements directly. Bump BEFORE execute on
    // BEGIN-shaped statements; decrement AFTER on COMMIT-shaped ones
    // so the persist gate in the finally block sees the correct
    // post-statement depth.
    const txKind = classifyTransactionControl(statement);
    if (txKind === 'begin') {
      this.transactionDepth += 1;
    }
    const stmt = this.prepareInternal(statement);
    try {
      const { named, positional } = normaliseParameters(parameters);
      if (named) {
        stmt.bind(expandNamedParameters(named));
      } else if (positional) {
        stmt.bind(positional);
      }
      stmt.step();
      const rowIdResult = this.db!.exec('SELECT last_insert_rowid() AS id');
      const rawRowId = rowIdResult[0]?.values?.[0]?.[0];
      return {
        changes: this.db!.getRowsModified(),
        lastInsertRowid: normaliseRowId(rawRowId)
      };
    } catch (err) {
      // If the BEGIN-shaped statement itself failed (e.g. nested
      // BEGIN in single-tx mode), undo the depth bump so the
      // adapter doesn't get stuck thinking it's in a tx.
      if (txKind === 'begin') {
        this.transactionDepth = Math.max(0, this.transactionDepth - 1);
      }
      throw err;
    } finally {
      stmt.free();
      if (txKind === 'end' && this.transactionDepth > 0) {
        this.transactionDepth -= 1;
      }
      // Persist only when we are NOT inside an open transaction. This
      // is the load-bearing rule: a mid-tx db.export() would close
      // the tx at the SQLite level and silently lose every
      // uncommitted write up to that point.
      if (this.transactionDepth === 0) {
        await this.persistIfNeeded();
      }
    }
  }

  public async get<T>(statement: string, parameters?: StorageParameters): Promise<T | null> {
    const rows = await this.all<T>(statement, parameters);
    return rows.length > 0 ? rows[0] : null;
  }

  public async all<T>(statement: string, parameters?: StorageParameters): Promise<T[]> {
    const stmt = this.prepareInternal(statement);
    try {
      const { named, positional } = normaliseParameters(parameters);
      if (named) {
        stmt.bind(expandNamedParameters(named));
      } else if (positional) {
        stmt.bind(positional);
      }

      const results: T[] = [];
      while (stmt.step()) {
        const row: Record<string, unknown> = {};
        stmt.getColumnNames().forEach((column: string, index: number) => {
          row[column] = stmt.get()[index];
        });
        results.push(row as T);
      }
      return results;
    } finally {
      stmt.free();
    }
  }

  public async exec(script: string): Promise<void> {
    this.ensureOpen();
    // `exec()` accepts multi-statement scripts so we can't reliably
    // classify the transactional intent the way {@link run} does.
    // Keep the original "skip persist on transaction-control" guard
    // for single-statement BEGIN/COMMIT calls AND additionally skip
    // when we're already known to be in a tx (depth > 0) — that case
    // covers `exec('CREATE TABLE …')` inside a {@link transaction}
    // block where the script itself isn't transaction-control but
    // persisting would still close the open tx.
    const isControl = isTransactionControlStatement(script);
    const txKind = isControl ? classifyTransactionControl(script) : 'none';
    if (txKind === 'begin') {
      this.transactionDepth += 1;
    }
    try {
      this.db!.exec(script);
    } catch (err) {
      if (txKind === 'begin') {
        this.transactionDepth = Math.max(0, this.transactionDepth - 1);
      }
      throw err;
    }
    if (txKind === 'end' && this.transactionDepth > 0) {
      this.transactionDepth -= 1;
    }
    if (!isControl && this.transactionDepth === 0) {
      await this.persistIfNeeded();
    } else if (txKind === 'end' && this.transactionDepth === 0) {
      // Just exited the outermost transaction — flush to disk.
      await this.persistIfNeeded();
    }
  }

  public async transaction<T>(fn: (trx: StorageAdapter) => Promise<T>): Promise<T> {
    this.ensureOpen();
    return this.runSerializedTransaction(async () => {
      this.ensureOpen();
      // BEGIN goes through raw sql.js (`this.db!.run`) to avoid the
      // adapter-level run() pre-bump + persist-skip machinery. The FIFO
      // runner is required because every callback shares this connection.
      this.db!.run('BEGIN TRANSACTION;');
      this.transactionDepth += 1;
      const transactionAdapter = createSharedConnectionTransactionAdapter(this);
      let committed = false;
      try {
        const result = await fn(transactionAdapter);
        this.db!.run('COMMIT;');
        committed = true;
        return result;
      } catch (error) {
        if (!committed) {
          try {
            this.db!.run('ROLLBACK;');
          } catch (rollbackError) {
            const message =
              rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
            // SQL.js may auto-close the transaction during certain DDL
            // failures. Preserve the original error rather than mask it
            // with a rollback hiccup.
            if (!message.includes('no transaction is active')) {
              throw rollbackError;
            }
          }
        }
        throw error;
      } finally {
        this.transactionDepth = Math.max(0, this.transactionDepth - 1);
        // Only the outermost transaction triggers a flush to disk. Nested
        // callbacks reuse the scoped view and do not change this depth.
        if (this.transactionDepth === 0) {
          await this.persistIfNeeded();
        }
      }
    });
  }

  public async close(): Promise<void> {
    if (this.db) {
      await this.persistIfNeeded();
      this.db.close();
      this.db = null;
    }
  }

  private prepareInternal(statement: string) {
    this.ensureOpen();
    return this.db!.prepare(statement);
  }

  private ensureOpen(): void {
    if (!this.db) {
      throw new Error('Storage adapter not opened. Call open() first.');
    }
  }

  private async persistIfNeeded(): Promise<void> {
    if (!this.filePath || !hasFsAccess()) {
      return;
    }
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const data = this.db!.export();
    fs.writeFileSync(this.filePath, Buffer.from(data));
  }
}

export const createSqlJsAdapter = (options?: SqlJsAdapterOptions): StorageAdapter => new SqlJsAdapter(options);

/**
 * Return true when `script` is purely a transaction-control statement
 * (BEGIN, SAVEPOINT, COMMIT, ROLLBACK, RELEASE). Used by `exec()` to
 * skip persistence on BEGIN/SAVEPOINT — `db.export()` ends any open
 * transaction in sql.js, so writing the snapshot mid-transaction
 * makes the matching COMMIT throw "no transaction is active". Callers
 * that COMMIT or ROLLBACK explicitly are still safe because the
 * subsequent write or close-time persistence runs `export()` after the
 * transaction has already closed.
 *
 * Pattern: tolerate leading whitespace, an optional trailing
 * semicolon, and statement-modifying keywords (BEGIN DEFERRED,
 * BEGIN IMMEDIATE, BEGIN EXCLUSIVE, BEGIN TRANSACTION, RELEASE
 * SAVEPOINT, ROLLBACK TO SAVEPOINT). Anything more complex falls
 * through to normal persistence.
 */
function isTransactionControlStatement(script: string): boolean {
  return classifyTransactionControl(script) !== 'none';
}

/**
 * Narrow classification of transaction-control SQL into the three
 * categories the persistence gate needs to react to:
 *
 *   - `'begin'` — BEGIN / BEGIN DEFERRED|IMMEDIATE|EXCLUSIVE / BEGIN
 *     TRANSACTION / SAVEPOINT <name>. Bumps depth before execution.
 *   - `'end'`   — COMMIT / ROLLBACK / ROLLBACK TO [SAVEPOINT] <name> /
 *     RELEASE [SAVEPOINT] <name>. Decrements depth after execution.
 *   - `'none'`  — any other statement; depth is unaffected.
 *
 * Pattern tolerates leading whitespace, an optional trailing
 * semicolon, and the SQLite-specific modifiers
 * (`BEGIN DEFERRED|IMMEDIATE|EXCLUSIVE`, `BEGIN TRANSACTION`,
 * `RELEASE SAVEPOINT`, `ROLLBACK TO SAVEPOINT`). Anything more
 * complex falls through to `'none'` — callers issuing multi-statement
 * scripts via {@link exec} are responsible for not mixing
 * transaction-control with other DML in a single call.
 */
function classifyTransactionControl(script: string): 'begin' | 'end' | 'none' {
  const trimmed = script.trim().replace(/;\s*$/, '').toUpperCase();
  if (trimmed === 'BEGIN') return 'begin';
  if (trimmed === 'COMMIT' || trimmed === 'ROLLBACK') return 'end';
  if (/^BEGIN\s+(DEFERRED|IMMEDIATE|EXCLUSIVE|TRANSACTION)$/.test(trimmed)) return 'begin';
  if (/^SAVEPOINT\s+\S+$/.test(trimmed)) return 'begin';
  if (/^RELEASE(\s+SAVEPOINT)?\s+\S+$/.test(trimmed)) return 'end';
  if (/^ROLLBACK(\s+TO(\s+SAVEPOINT)?)?\s+\S+$/.test(trimmed)) return 'end';
  return 'none';
}
