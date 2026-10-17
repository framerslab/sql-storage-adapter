/**
 * The server half of the mutation sync. `push` runs a client's mutations in id order inside one transaction under the
 * group's row lock: a mutation at or below the client's last id is skipped, one past the next expected id aborts the
 * batch with nothing written, and each processed mutation's effect, its result, the client's last id and the group's new
 * version commit together, so a lost answer or a repeated push never applies a mutation twice. A permanent refusal
 * consumes its id and records its result; any other failure rolls the whole push back. `pull` reads the version, the
 * rows changed since a cookie, every client's last id and the caller's results in one transaction, and streams them as
 * one JSON answer, batch by batch; a cancelled stream, or one still open at `maxPullMs`, rolls its transaction back and
 * never completes.
 * `replayTombstone` writes a deletion fence's tombstone after a restore. The store is the caller's: its tables, its
 * locks and its isolation.
 */
import type { StorageAdapter } from '../../../core/contracts';
import { nextCounter, readCounter, writeCounter } from './counter';
import { HandOver, iterate, PullCancelled } from './handOver';
import { applyRowMutation, parseRowArgs, rowMutationOf, type Row, type RowPolicy, type RowView } from './rows';
import { parsePushRequest, type MutationResult, type PatchEntry, type PullRefusal, type PullRequest, type PushAnswer, type PushRequest, type Revision } from './wire';

/** A row as the store keeps it: its value sealed by the codec, or null for a tombstone. */
export interface StoredRow {
  id: string;
  state: 'live' | 'tombstone';
  stored: string | null;
  revision: Revision;
  version: number;
  deletedAt: string | null;
}

/** A scope's group and its version, the pull cookie. */
export interface GroupRow {
  group: string;
  version: number;
}

/** The tables the server reads and writes, each call inside the transaction handle it is given. */
export interface MutationServerStore {
  /** Runs first in every transaction: isolation (`pull`), lock and statement timeouts (`push`, `replay`). */
  begin(trx: StorageAdapter, purpose: 'push' | 'pull' | 'replay'): Promise<void>;
  /** The scope's group with its row locked until the transaction ends; null when the scope has none. */
  lockGroup(trx: StorageAdapter, scope: string): Promise<GroupRow | null>;
  /** The scope's group without a lock. */
  readGroup(trx: StorageAdapter, scope: string): Promise<GroupRow | null>;
  setVersion(trx: StorageAdapter, scope: string, version: number): Promise<void>;
  /** A client's last processed mutation id; 0 for a client the group has not seen. */
  lastMutationId(trx: StorageAdapter, scope: string, group: string, clientId: string): Promise<number>;
  setLastMutationId(trx: StorageAdapter, scope: string, group: string, clientId: string, last: number): Promise<void>;
  readRow(trx: StorageAdapter, scope: string, id: string): Promise<StoredRow | null>;
  writeRow(trx: StorageAdapter, scope: string, row: StoredRow, at: Date): Promise<void>;
  /** The rows that are not tombstones. */
  liveCount(trx: StorageAdapter, scope: string): Promise<number>;
  readResult(trx: StorageAdapter, scope: string, group: string, clientId: string, mutationId: number): Promise<MutationResult | null>;
  writeResult(trx: StorageAdapter, scope: string, group: string, result: MutationResult): Promise<void>;
  /** Rows with a version above `since` (all for null), ordered by id, after `afterId`, at most `limit`. */
  rowsSince(trx: StorageAdapter, scope: string, since: number | null, afterId: string | null, limit: number): Promise<StoredRow[]>;
  /** Every client of the group with its last mutation id. */
  clients(trx: StorageAdapter, scope: string, group: string): Promise<Array<{ clientId: string; lastMutationId: number }>>;
  /** A client's results with a version above `since` (all for null), ordered by mutation id. */
  resultsSince(trx: StorageAdapter, scope: string, group: string, clientId: string, since: number | null): Promise<MutationResult[]>;
}

/** Seals a value for the store and opens it again; `open` throws `UnreadableValue` for a value it cannot open. */
export interface ValueCodec {
  seal(value: string, place: { scope: string; id: string }): Promise<string>;
  open(stored: string, place: { scope: string; id: string }): Promise<string>;
}

/** A stored value the codec cannot open: the row is unreadable, never absent. */
export class UnreadableValue extends Error {
  constructor() {
    super('the stored value cannot be opened');
    this.name = 'UnreadableValue';
  }
}

/** A delete the push accepted: the row, the deleting mutation and when. */
export interface AcceptedDelete {
  id: string;
  revision: Revision;
  deletedAt: string;
}

/** What a push decided, before anything is written. */
export interface PushPlan {
  scope: string;
  group: string;
  clientId: string;
  version: number;
  acceptedDeletes: AcceptedDelete[];
  results: MutationResult[];
}

/** What a caller adds around a push's writes. */
export interface PushHooks {
  /** Inside the transaction, once every mutation is decided and before anything is written; a throw rolls back. */
  beforeWrite?(trx: StorageAdapter, plan: PushPlan): Promise<void>;
  /** After the commit. */
  afterCommit?(plan: PushPlan): Promise<void>;
  /** Aborts the push between mutations. */
  signal?: AbortSignal;
}

/** The scope a request acts in (from the caller's session, never the request) and the deployment's restore epoch. */
export interface ScopeContext {
  scope: string;
  epoch: string;
}

/**
 * A pull's opening: its stream with a promise that settles once the stream's transaction has ended (committed or
 * rolled back, never rejecting), which a route waits on to release its gate lease; or the refusal decided before any
 * row was read. A caller that opens a stream reads it to its end or calls its iterator's `return`.
 */
export type PullOpening = { kind: 'stream'; chunks: AsyncIterable<string>; done: Promise<void> } | PullRefusal;

/** The server's parts and limits. */
export interface MutationServerOptions {
  adapter: StorageAdapter;
  store: MutationServerStore;
  codec: ValueCodec;
  policy: RowPolicy;
  /** The most mutations one push may carry. */
  maxMutations: number;
  /** The most rows one read of a pull takes (default 200). */
  pullBatchRows?: number;
  /**
   * How long a pull's transaction may stay open, in milliseconds (default 120,000, the fetch transport's own deadline):
   * a stream still open then is cancelled and its transaction rolled back, so a reader that stops reading cannot hold
   * it; `Infinity` sets no limit.
   */
  maxPullMs?: number;
  clock?: () => Date;
}

/** The server. */
export class MutationServer {
  constructor(private readonly options: MutationServerOptions) {}

  /** Reads a push's body with this server's limit and the row mutators' argument parser. */
  parsePush(body: unknown): PushRequest {
    return parsePushRequest(body, this.options.maxMutations, parseRowArgs);
  }

  /** Processes a push; see the module's comment. */
  async push(context: ScopeContext, request: PushRequest, hooks: PushHooks = {}): Promise<PushAnswer> {
    if (request.epoch !== context.epoch) return { kind: 'epoch_changed', epoch: context.epoch };
    const { adapter, store, codec, policy } = this.options;
    const at = this.now();
    let committed: PushPlan | null = null;
    const answer = await adapter.transaction(async (trx): Promise<PushAnswer> => {
      await store.begin(trx, 'push');
      const group = await store.lockGroup(trx, context.scope);
      if (group === null || group.group !== request.group) return { kind: 'group_gone' };
      let last = await store.lastMutationId(trx, context.scope, group.group, request.clientId);
      const base = new Map<string, Row | null>();
      const writes = new Map<string, Row>();
      const recorded = new Map<string, MutationResult>();
      let liveBase: number | null = null;
      const counted = (row: Row | null | undefined): number => (row !== null && row !== undefined && row.state !== 'tombstone' ? 1 : 0);
      const read = async (id: string): Promise<Row | null> => {
        if (!base.has(id)) base.set(id, await this.rowOf(trx, context.scope, id));
        return base.get(id) ?? null;
      };
      const view: RowView = {
        row: async (id) => writes.get(id) ?? (await read(id)),
        liveCount: async () => {
          liveBase ??= await store.liveCount(trx, context.scope);
          let count = liveBase;
          for (const [id, row] of writes) count += counted(row) - counted(base.get(id));
          return count;
        },
        result: async (clientId, mutationId) =>
          recorded.get(`${clientId}:${mutationId}`) ?? (await store.readResult(trx, context.scope, group.group, clientId, readCounter(mutationId))),
      };
      const version = nextCounter(group.version);
      const accepted: AcceptedDelete[] = [];
      const results: MutationResult[] = [];
      for (const record of request.mutations) {
        if (hooks.signal?.aborted) throw hooks.signal.reason ?? new Error('the push was cancelled');
        const id = readCounter(record.id);
        if (id <= last) continue;
        if (id !== last + 1) return { kind: 'gap', expected: writeCounter(last + 1) };
        const effect = await applyRowMutation(view, policy, { group: group.group, clientId: request.clientId, mutationId: record.id }, rowMutationOf(record.name, record.args));
        const revision: Revision = { client: request.clientId, mutation: record.id };
        if (effect.write !== null) {
          await read(effect.write.id);
          writes.set(effect.write.id, { ...effect.write, revision });
        }
        if (effect.acceptedDelete) accepted.push({ id: effect.targetId, revision, deletedAt: at.toISOString() });
        const result: MutationResult = {
          clientId: request.clientId,
          mutationId: record.id,
          outcome: effect.outcome,
          reason: effect.reason,
          targetId: effect.targetId,
          revision: effect.revision,
          version: writeCounter(version),
        };
        results.push(result);
        recorded.set(`${request.clientId}:${record.id}`, result);
        last = id;
      }
      if (results.length === 0) return { kind: 'ok', processed: 0 };
      const plan: PushPlan = { scope: context.scope, group: group.group, clientId: request.clientId, version, acceptedDeletes: accepted, results };
      await hooks.beforeWrite?.(trx, plan);
      for (const row of writes.values()) {
        const tombstone = row.state === 'tombstone' || row.value === null;
        await store.writeRow(
          trx,
          context.scope,
          {
            id: row.id,
            state: tombstone ? 'tombstone' : 'live',
            stored: tombstone ? null : await codec.seal(row.value as string, { scope: context.scope, id: row.id }),
            revision: row.revision,
            version,
            deletedAt: tombstone ? at.toISOString() : null,
          },
          at,
        );
      }
      for (const result of results) await store.writeResult(trx, context.scope, group.group, result);
      await store.setLastMutationId(trx, context.scope, group.group, request.clientId, last);
      await store.setVersion(trx, context.scope, version);
      committed = plan;
      return { kind: 'ok', processed: results.length };
    });
    const plan = committed as PushPlan | null;
    if (plan !== null) await hooks.afterCommit?.(plan);
    return answer;
  }

  /**
   * Opens a pull. The refusals (a changed epoch, another group, a cookie past the version) are decided before any row is
   * read; otherwise the answer streams from one transaction: the version first, the rows in batches, then the
   * results and every client's last id. Aborting `signal`, stopping the iteration, or `maxPullMs` passing cancels the
   * stream and rolls its transaction back.
   */
  async pull(context: ScopeContext, request: PullRequest, signal?: AbortSignal): Promise<PullOpening> {
    if (request.epoch !== context.epoch) return { kind: 'epoch_changed', epoch: context.epoch };
    const { adapter, store } = this.options;
    const batch = this.options.pullBatchRows ?? 200;
    const since = request.cookie === null ? null : readCounter(request.cookie);
    const handOver = new HandOver<string>();
    let open!: (opening: PullOpening) => void;
    let refuse!: (error: unknown) => void;
    const opening = new Promise<PullOpening>((resolve, reject) => {
      open = resolve;
      refuse = reject;
    });
    let finished!: () => void;
    const done = new Promise<void>((resolve) => {
      finished = resolve;
    });
    const onAbort = (): void => handOver.cancel(signal?.reason ?? new PullCancelled());
    if (signal?.aborted) return Promise.reject(signal.reason ?? new PullCancelled());
    signal?.addEventListener('abort', onAbort, { once: true });
    // a reader that stops reading holds the transaction no longer than the limit; a timer holds at most 2^31 - 1 ms
    const limit = this.options.maxPullMs ?? 120_000;
    const deadline = Number.isFinite(limit) ? setTimeout(() => handOver.cancel(new PullCancelled()), Math.min(limit, 2_147_483_647)) : null;
    void adapter
      .transaction(async (trx) => {
        await store.begin(trx, 'pull');
        const group = await store.readGroup(trx, context.scope);
        if (group === null || group.group !== request.group) {
          open({ kind: 'group_gone' });
          return;
        }
        if (since !== null && since > group.version) {
          open({ kind: 'cookie_ahead' });
          return;
        }
        open({ kind: 'stream', chunks: iterate(handOver), done });
        await handOver.offer(`{"kind":"pull","group":${JSON.stringify(group.group)},"epoch":${JSON.stringify(context.epoch)},"cookie":"${writeCounter(group.version)}","full":${since === null},"patch":[`);
        let after: string | null = null;
        let first = true;
        for (;;) {
          if (signal?.aborted) throw signal.reason ?? new PullCancelled();
          const rows = await store.rowsSince(trx, context.scope, since, after, batch);
          if (rows.length > 0) {
            const entries: string[] = [];
            for (const row of rows) entries.push(JSON.stringify(await this.entryOf(context.scope, row)));
            await handOver.offer(`${first ? '' : ','}${entries.join(',')}`);
            first = false;
            after = rows[rows.length - 1].id;
          }
          if (rows.length < batch) break;
        }
        const results = await store.resultsSince(trx, context.scope, group.group, request.clientId, since);
        const last: Record<string, string> = { [request.clientId]: '0' };
        for (const client of await store.clients(trx, context.scope, group.group)) last[client.clientId] = writeCounter(client.lastMutationId);
        await handOver.offer(`],"results":${JSON.stringify(results)},"lastMutationIds":${JSON.stringify(last)}}`);
      })
      .then(
        () => handOver.finish(),
        (error: unknown) => {
          refuse(error);
          handOver.fail(error);
        },
      )
      .finally(() => {
        if (deadline !== null) clearTimeout(deadline);
        signal?.removeEventListener('abort', onAbort);
        finished();
      });
    return opening;
  }

  /**
   * Writes a deletion fence's tombstone after a restore: a new tombstone takes the fence's deleting revision and the
   * group's next version, and touches no client's last id; an existing tombstone is kept as it is; a fence of another
   * group changes nothing.
   */
  async replayTombstone(input: { scope: string; group: string; id: string; revision: Revision; deletedAt: string }): Promise<'written' | 'kept' | 'group_gone'> {
    const { adapter, store } = this.options;
    const at = this.now();
    return adapter.transaction(async (trx) => {
      await store.begin(trx, 'replay');
      const group = await store.lockGroup(trx, input.scope);
      if (group === null || group.group !== input.group) return 'group_gone';
      const row = await store.readRow(trx, input.scope, input.id);
      if (row !== null && row.state === 'tombstone') return 'kept';
      const version = nextCounter(group.version);
      await store.writeRow(trx, input.scope, { id: input.id, state: 'tombstone', stored: null, revision: input.revision, version, deletedAt: input.deletedAt }, at);
      await store.setVersion(trx, input.scope, version);
      return 'written';
    });
  }

  private now(): Date {
    return (this.options.clock ?? (() => new Date()))();
  }

  /** A stored row as the mutators read it: live with its opened value, a tombstone, or unreadable. */
  private async rowOf(trx: StorageAdapter, scope: string, id: string): Promise<Row | null> {
    const stored = await this.options.store.readRow(trx, scope, id);
    if (stored === null) return null;
    if (stored.state === 'tombstone' || stored.stored === null) return { id, state: 'tombstone', value: null, revision: stored.revision };
    try {
      return { id, state: 'live', value: await this.options.codec.open(stored.stored, { scope, id }), revision: stored.revision };
    } catch (error) {
      if (error instanceof UnreadableValue) return { id, state: 'unreadable', value: null, revision: stored.revision };
      throw error;
    }
  }

  /** A stored row as a pull's patch carries it. */
  private async entryOf(scope: string, row: StoredRow): Promise<PatchEntry> {
    const version = writeCounter(row.version);
    if (row.state === 'tombstone' || row.stored === null) return { op: 'del', id: row.id, revision: row.revision, version, deletedAt: row.deletedAt ?? '' };
    try {
      return { op: 'put', id: row.id, value: await this.options.codec.open(row.stored, { scope, id: row.id }), revision: row.revision, version };
    } catch (error) {
      if (error instanceof UnreadableValue) return { op: 'unreadable', id: row.id, revision: row.revision, version };
      throw error;
    }
  }
}
