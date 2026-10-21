/**
 * A reference `MutationServerStore` on four tables of its own under a prefix (`<prefix>groups`, `rows`, `clients`,
 * `results`), for SQLite and Postgres alike. On Postgres a pull reads in REPEATABLE READ, so every batch sees one
 * snapshot, and a push or a replay waits at most `lockTimeoutMs` for the group's row lock. A product with tables of
 * its own implements the store port on them instead.
 */
import type { StorageAdapter } from '../../../core/contracts';
import { readCounter, writeCounter } from './counter';
import type { MutationServerStore, StoredRow } from './server';
import type { MutationResult, Outcome, Refusal } from './wire';

const PREFIX = /^[a-z][a-z0-9_]{0,40}_$/;

function checkPrefix(prefix: string): void {
  if (!PREFIX.test(prefix)) throw new Error('a store prefix is a lower-case SQL identifier ending in an underscore');
}

/** The store's tables. */
export function mutationStoreDdl(prefix: string): string[] {
  checkPrefix(prefix);
  return [
    `CREATE TABLE IF NOT EXISTS ${prefix}groups (scope TEXT PRIMARY KEY, grp TEXT NOT NULL UNIQUE, version BIGINT NOT NULL DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS ${prefix}rows (scope TEXT NOT NULL, id TEXT NOT NULL, state TEXT NOT NULL, stored TEXT, rev_client TEXT NOT NULL, rev_mutation BIGINT NOT NULL, version BIGINT NOT NULL, deleted_at TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (scope, id))`,
    `CREATE INDEX IF NOT EXISTS ${prefix}rows_version ON ${prefix}rows (scope, version)`,
    `CREATE TABLE IF NOT EXISTS ${prefix}clients (scope TEXT NOT NULL, grp TEXT NOT NULL, client_id TEXT NOT NULL, last_mutation_id BIGINT NOT NULL DEFAULT 0, PRIMARY KEY (scope, grp, client_id))`,
    `CREATE TABLE IF NOT EXISTS ${prefix}results (scope TEXT NOT NULL, grp TEXT NOT NULL, client_id TEXT NOT NULL, mutation_id BIGINT NOT NULL, outcome TEXT NOT NULL, reason TEXT, target_id TEXT NOT NULL, rev_client TEXT, rev_mutation BIGINT, version BIGINT NOT NULL, PRIMARY KEY (scope, grp, client_id, mutation_id))`,
  ];
}

/** Makes a scope's group at version 0. */
export async function createSqlGroup(adapter: StorageAdapter, prefix: string, scope: string, group: string): Promise<void> {
  checkPrefix(prefix);
  await adapter.run(`INSERT INTO ${prefix}groups (scope, grp, version) VALUES (?, ?, 0)`, [scope, group]);
}

/** Removes a scope's group with every row, client and result. */
export async function dropSqlGroup(adapter: StorageAdapter, prefix: string, scope: string): Promise<void> {
  checkPrefix(prefix);
  await adapter.transaction(async (trx) => {
    for (const table of ['results', 'clients', 'rows', 'groups']) await trx.run(`DELETE FROM ${prefix}${table} WHERE scope = ?`, [scope]);
  });
}

interface RowRecord {
  id: string;
  state: string;
  stored: string | null;
  rev_client: string;
  rev_mutation: unknown;
  version: unknown;
  deleted_at: string | null;
}

interface ResultRecord {
  client_id: string;
  mutation_id: unknown;
  outcome: string;
  reason: string | null;
  target_id: string;
  rev_client: string | null;
  rev_mutation: unknown;
  version: unknown;
}

function rowOf(record: RowRecord): StoredRow {
  return {
    id: record.id,
    state: record.state === 'tombstone' ? 'tombstone' : 'live',
    stored: record.stored,
    revision: { client: record.rev_client, mutation: writeCounter(readCounter(record.rev_mutation)) },
    version: readCounter(record.version),
    deletedAt: record.deleted_at,
  };
}

function resultOf(record: ResultRecord): MutationResult {
  return {
    clientId: record.client_id,
    mutationId: writeCounter(readCounter(record.mutation_id)),
    outcome: record.outcome as Outcome,
    reason: record.reason as Refusal | null,
    targetId: record.target_id,
    revision: record.rev_client === null ? null : { client: record.rev_client, mutation: writeCounter(readCounter(record.rev_mutation)) },
    version: writeCounter(readCounter(record.version)),
  };
}

const ROW_COLUMNS = 'id, state, stored, rev_client, rev_mutation, version, deleted_at';
const RESULT_COLUMNS = 'client_id, mutation_id, outcome, reason, target_id, rev_client, rev_mutation, version';

/** The reference store on the tables `mutationStoreDdl(prefix)` makes. */
export function createSqlMutationStore(options: { prefix: string; lockTimeoutMs?: number }): MutationServerStore {
  const p = options.prefix;
  checkPrefix(p);
  const postgres = (trx: StorageAdapter): boolean => trx.kind === 'postgres';
  const group = async (trx: StorageAdapter, scope: string, lock: boolean) => {
    const row = await trx.get<{ grp: string; version: unknown }>(`SELECT grp, version FROM ${p}groups WHERE scope = ?${lock && postgres(trx) ? ' FOR UPDATE' : ''}`, [scope]);
    return row === null ? null : { group: row.grp, version: readCounter(row.version) };
  };
  return {
    async begin(trx, purpose) {
      if (!postgres(trx)) return;
      if (purpose === 'pull') await trx.run('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      else await trx.run(`SET LOCAL lock_timeout = '${Math.max(1, Math.floor(options.lockTimeoutMs ?? 3000))}ms'`);
    },
    lockGroup: (trx, scope) => group(trx, scope, true),
    readGroup: (trx, scope) => group(trx, scope, false),
    async setVersion(trx, scope, version) {
      await trx.run(`UPDATE ${p}groups SET version = ? WHERE scope = ?`, [version, scope]);
    },
    async lastMutationId(trx, scope, grp, clientId) {
      const row = await trx.get<{ last_mutation_id: unknown }>(`SELECT last_mutation_id FROM ${p}clients WHERE scope = ? AND grp = ? AND client_id = ?`, [scope, grp, clientId]);
      return row === null ? 0 : readCounter(row.last_mutation_id);
    },
    async setLastMutationId(trx, scope, grp, clientId, last) {
      await trx.run(
        `INSERT INTO ${p}clients (scope, grp, client_id, last_mutation_id) VALUES (?, ?, ?, ?) ON CONFLICT (scope, grp, client_id) DO UPDATE SET last_mutation_id = excluded.last_mutation_id`,
        [scope, grp, clientId, last],
      );
    },
    async readRow(trx, scope, id) {
      const row = await trx.get<RowRecord>(`SELECT ${ROW_COLUMNS} FROM ${p}rows WHERE scope = ? AND id = ?`, [scope, id]);
      return row === null ? null : rowOf(row);
    },
    async writeRow(trx, scope, row, at) {
      await trx.run(
        `INSERT INTO ${p}rows (scope, id, state, stored, rev_client, rev_mutation, version, deleted_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ` +
          'ON CONFLICT (scope, id) DO UPDATE SET state = excluded.state, stored = excluded.stored, rev_client = excluded.rev_client, rev_mutation = excluded.rev_mutation, version = excluded.version, deleted_at = excluded.deleted_at, updated_at = excluded.updated_at',
        [scope, row.id, row.state, row.stored, row.revision.client, readCounter(row.revision.mutation), row.version, row.deletedAt, at.toISOString()],
      );
    },
    async liveCount(trx, scope) {
      const row = await trx.get<{ n: unknown }>(`SELECT COUNT(*) AS n FROM ${p}rows WHERE scope = ? AND state <> 'tombstone'`, [scope]);
      return readCounter(row?.n ?? 0);
    },
    async readResult(trx, scope, grp, clientId, mutationId) {
      const row = await trx.get<ResultRecord>(`SELECT ${RESULT_COLUMNS} FROM ${p}results WHERE scope = ? AND grp = ? AND client_id = ? AND mutation_id = ?`, [scope, grp, clientId, mutationId]);
      return row === null ? null : resultOf(row);
    },
    async writeResult(trx, scope, grp, result) {
      await trx.run(
        `INSERT INTO ${p}results (scope, grp, client_id, mutation_id, outcome, reason, target_id, rev_client, rev_mutation, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [scope, grp, result.clientId, readCounter(result.mutationId), result.outcome, result.reason, result.targetId, result.revision?.client ?? null, result.revision === null ? null : readCounter(result.revision.mutation), readCounter(result.version)],
      );
    },
    async rowsSince(trx, scope, since, afterId, limit) {
      const conditions = ['scope = ?'];
      const parameters: unknown[] = [scope];
      if (since !== null) {
        conditions.push('version > ?');
        parameters.push(since);
      }
      if (afterId !== null) {
        conditions.push('id > ?');
        parameters.push(afterId);
      }
      parameters.push(limit);
      const rows = await trx.all<RowRecord>(`SELECT ${ROW_COLUMNS} FROM ${p}rows WHERE ${conditions.join(' AND ')} ORDER BY id LIMIT ?`, parameters);
      return rows.map(rowOf);
    },
    async clients(trx, scope, grp) {
      const rows = await trx.all<{ client_id: string; last_mutation_id: unknown }>(`SELECT client_id, last_mutation_id FROM ${p}clients WHERE scope = ? AND grp = ? ORDER BY client_id`, [scope, grp]);
      return rows.map((row) => ({ clientId: row.client_id, lastMutationId: readCounter(row.last_mutation_id) }));
    },
    async resultsSince(trx, scope, grp, clientId, since) {
      const rows = await trx.all<ResultRecord>(
        `SELECT ${RESULT_COLUMNS} FROM ${p}results WHERE scope = ? AND grp = ? AND client_id = ?${since === null ? '' : ' AND version > ?'} ORDER BY mutation_id`,
        since === null ? [scope, grp, clientId] : [scope, grp, clientId, since],
      );
      return rows.map(resultOf);
    },
  };
}
