/**
 * The client half of the mutation sync, for a browser or any process that keeps its rows in a `StorageAdapter`.
 *
 * Beside the caller's own data, in the same database, it keeps its membership (with its group, client id, local
 * activation instance, restore epoch, cookie and next mutation id), the server's canonical rows, its pending mutations,
 * a journal of every mutation it issued in its group, its own results, the comparison base an off leaves, and the rows
 * it keeps alone with their reasons. Every operation runs under the tab lock, on a freshly reloaded image, in one
 * transaction of the adapter, which a durable adapter has written before it resolves; a stale image is reloaded and the
 * operation run once more, and a failed one reloads the stored image before its error leaves the lock, so a commit
 * IndexedDB refused is never stored by the client's next operation. Under `crossTab`, open the adapter with
 * `rollbackRefusedSaves` too, so a statement another part of the page queued on the adapter behind the refused save
 * stores nothing of it either. The lock is the client's own, never the adapter's.
 *
 * A save commits the caller's data with its mutations and their journal records, or nothing. Only a pull acknowledges:
 * it applies a complete answer's patch and results, keeps the values of refused mutations, drops the pending ones the
 * server processed, replays the rest over the new canonical state and hands the caller what became visible, in one
 * transaction, only while the request's context and cookie still hold. A push acknowledges nothing: it records only
 * that its sends stopped, and hands a changed epoch, a gone group or a gap to the recovery, the leave or the sequence
 * repair. A changed epoch keeps every downloaded row aside, takes a full snapshot, and pushes again from the journal
 * every issued mutation the restored server lacks, with its id; a journal with a hole retires the client.
 */
import type { StorageAdapter } from '../../../core/contracts';
import { nextCounter, readCounter, writeCounter } from './counter';
import { packMutations } from './packing';
import { applyRowMutation, copyIdOf, planRowChanges, rowMutationOf, type PlannedRow, type Row, type RowMutation, type RowPolicy, type RowView } from './rows';
import type { TabLock } from './tabLock';
import type { MutationTransport } from './transport';
import type { MutationRecord, MutationResult, Outcome, PatchEntry, PullResponse, Refusal, Revision } from './wire';

/** Where a client stands with its scope's group. */
export type MembershipState = 'none' | 'joining' | 'joined' | 'declined' | 'off' | 'retired';

/** Why a row is kept in this browser alone. */
export type KeptReason = 'too_long' | 'full' | 'removed' | 'unreadable' | 'recovery' | 'differs';

/** The client's membership. */
export interface Membership {
  state: MembershipState;
  group: string | null;
  clientId: string | null;
  /** Changes with every join, leave and removal, so an answer to an earlier request can be recognised. */
  activation: string;
  epoch: string | null;
  cookie: number | null;
  nextMutationId: number;
  sends: 'open' | 'size_error' | 'malformed';
  recovering: boolean;
  declinedGroup: string | null;
  removing: boolean;
  /** When the last pull applied, for a status line; no ordering reads it. */
  syncedAt: string | null;
}

/** A row kept in this browser alone. */
export interface KeptRow {
  id: string;
  value: string;
  reason: KeptReason;
  group: string | null;
  revision: Revision | null;
}

/** A row as the caller shows it. */
export interface VisibleRow {
  id: string;
  value: string;
  revision: Revision | null;
  source: 'canonical' | 'pending' | 'kept';
  reason: KeptReason | null;
}

/** What the caller writes into its own data: ids for unmarked values, values put by id, rows removed. */
export interface VisibleChange {
  assign: Array<{ value: string; id: string }>;
  puts: Array<{ id: string; value: string }>;
  deletes: string[];
}

/** A block of the caller's data at a join: its id, or none for a block that never had one, and its derived id if any. */
export interface LocalBlock {
  id: string | null;
  value: string;
  derivedId: string | null;
}

/** What a request was made in; an answer applies only while it still holds. */
export interface RequestContext {
  group: string;
  clientId: string;
  activation: string;
  epoch: string;
  cookie: number | null;
}

/** What the client shows. */
export interface ClientSnapshot {
  membership: Membership;
  visible: VisibleRow[];
  kept: KeptRow[];
  pending: number;
  /** The rows the account holds that are not tombstones. */
  accountRows: number;
}

/** A save's result. */
export interface SaveResult {
  mode: 'local' | 'joined';
  issued: number;
  /** Ids kept in this browser alone because their value is too long for the account. */
  tooLong: string[];
  deletes: number;
}

/** What a push, a pull or a join came to. */
export type SyncOutcome =
  | { kind: 'idle' | 'sent' | 'applied' | 'blocked' | 'recovering' | 'off' | 'retired' | 'resend' | 'stale' }
  | { kind: 'wait'; ms: number };

/** A save asked while a removal holds the client. */
export class RemovalInProgress extends Error {
  constructor() {
    super('a removal of this browser\'s rows is in progress');
    this.name = 'RemovalInProgress';
  }
}

/** A save that would send more deletes than the person confirmed. */
export class DeletesChanged extends Error {
  constructor(readonly deletes: number) {
    super('the save would delete more rows than were confirmed');
    this.name = 'DeletesChanged';
  }
}

/** A removal asked of a joined client that did not begin one. */
export class RemovalNotStarted extends Error {
  constructor() {
    super('a removal begins with beginRemoval while sync is on');
    this.name = 'RemovalNotStarted';
  }
}

/**
 * A removal that cannot run on the confirmation it was given: this browser changed after the check (a save that issued a
 * mutation, an off learned at a pull, a retirement), the check could not run (a mutation pending, a recovery open, sends
 * stopped), or no check was made. Check again and ask again.
 */
export class RemovalInvalidated extends Error {
  constructor(readonly reason: 'changed' | 'unchecked' | 'pending' | 'recovering' | 'sends_blocked') {
    super(
      reason === 'changed'
        ? 'this browser changed after the removal was confirmed'
        : reason === 'unchecked'
          ? 'a removal while joined needs the stamp of the check the person confirmed'
          : `the backed-up check cannot stand while ${reason === 'pending' ? 'a mutation is pending' : reason === 'recovering' ? 'a recovery is open' : 'sends are stopped'}`,
    );
    this.name = 'RemovalInvalidated';
  }
}

/** What the backed-up check answers. */
export interface BackupCheck {
  /** False when the check could not run: not joined, recovering, sends stopped, or a mutation pending. */
  checked: boolean;
  reason: 'not_joined' | 'recovering' | 'sends_blocked' | 'pending' | null;
  /** The blocks no acknowledged readable account copy holds (all of them when the check could not run). */
  unbacked: Array<{ id: string | null; value: string }>;
  /** What a removal must present: the membership, the counters and the kept rows as they were checked. */
  stamp: string;
}

/** The client's parts. */
export interface MutationClientOptions {
  adapter: StorageAdapter;
  /** The scope's id (an account, for example); the membership row is keyed by it. */
  scope: string;
  /** The client's own cross-tab lock (`createTabLock`), never the adapter's `crossTab.locks`. */
  lock: TabLock;
  transport: MutationTransport;
  policy: RowPolicy;
  /** Writes a change of the visible rows into the caller's own data, inside the client's transaction. */
  materialize(trx: StorageAdapter, change: VisibleChange): Promise<void>;
  /** Reloads the durable image before every operation and after a failed one (`IndexedDbAdapter.reload`). */
  reload?: () => Promise<unknown>;
  /** Tells other tabs after every commit. */
  notify?: () => void;
  /** Makes a random 32-hex id. */
  randomId?: () => string;
  /** The most mutations and UTF-8 bytes of one push (defaults 50 and 1,000,000). */
  pushMutations?: number;
  pushBytes?: number;
  /** The tables' prefix (default `sync_`). */
  tablePrefix?: string;
  clock?: () => Date;
}

function randomHexId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The client's tables; every counter column is BIGINT, as wide as the protocol's counters, on every database. */
export function clientDdl(p: string): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS ${p}membership (scope TEXT PRIMARY KEY, state TEXT NOT NULL, grp TEXT, client_id TEXT, activation TEXT NOT NULL, epoch TEXT, cookie BIGINT, next_mutation_id BIGINT NOT NULL, sends TEXT NOT NULL, recovering INTEGER NOT NULL, declined_group TEXT, removing INTEGER NOT NULL, synced_at TEXT)`,
    `CREATE TABLE IF NOT EXISTS ${p}rows (scope TEXT NOT NULL, id TEXT NOT NULL, state TEXT NOT NULL, value TEXT, rev_client TEXT NOT NULL, rev_mutation BIGINT NOT NULL, version BIGINT NOT NULL, PRIMARY KEY (scope, id))`,
    `CREATE TABLE IF NOT EXISTS ${p}base (scope TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (scope, id))`,
    `CREATE TABLE IF NOT EXISTS ${p}pending (scope TEXT NOT NULL, mutation_id BIGINT NOT NULL, name TEXT NOT NULL, args TEXT NOT NULL, size_error INTEGER NOT NULL, PRIMARY KEY (scope, mutation_id))`,
    `CREATE TABLE IF NOT EXISTS ${p}journal (scope TEXT NOT NULL, grp TEXT NOT NULL, client_id TEXT NOT NULL, mutation_id BIGINT NOT NULL, name TEXT NOT NULL, args TEXT NOT NULL, PRIMARY KEY (scope, grp, client_id, mutation_id))`,
    `CREATE TABLE IF NOT EXISTS ${p}results (scope TEXT NOT NULL, client_id TEXT NOT NULL, mutation_id BIGINT NOT NULL, outcome TEXT NOT NULL, reason TEXT, target_id TEXT NOT NULL, rev_client TEXT, rev_mutation BIGINT, PRIMARY KEY (scope, client_id, mutation_id))`,
    `CREATE TABLE IF NOT EXISTS ${p}kept (scope TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, reason TEXT NOT NULL, grp TEXT, rev_client TEXT, rev_mutation BIGINT, PRIMARY KEY (scope, id))`,
  ];
}

interface MembershipRecord {
  state: string;
  grp: string | null;
  client_id: string | null;
  activation: string;
  epoch: string | null;
  cookie: unknown;
  next_mutation_id: unknown;
  sends: string;
  recovering: unknown;
  declined_group: string | null;
  removing: unknown;
  synced_at: string | null;
}

interface PendingRow {
  mutationId: number;
  mutation: RowMutation;
  sizeError: boolean;
}

function contextOf(m: Membership): RequestContext | null {
  if (m.state !== 'joined' || m.group === null || m.clientId === null || m.epoch === null) return null;
  return { group: m.group, clientId: m.clientId, activation: m.activation, epoch: m.epoch, cookie: m.cookie };
}

function holds(m: Membership, context: RequestContext): boolean {
  return m.state === 'joined' && m.group === context.group && m.clientId === context.clientId && m.activation === context.activation && m.epoch === context.epoch;
}

/**
 * A visible row as a save plans against it. A kept row is held here alone and a save creates it again, but for an
 * unreadable one and one kept too long at the revision of the edit it holds: a save edits each at its revision.
 */
function plannedOf(row: VisibleRow): PlannedRow {
  const edited = row.reason === 'unreadable' || (row.reason === 'too_long' && row.revision !== null);
  return { id: row.id, value: row.value, revision: row.revision, local: row.source === 'kept' && !edited };
}

function changeOf(before: ReadonlyMap<string, { value: string }>, after: ReadonlyMap<string, { value: string }>): VisibleChange {
  const puts: VisibleChange['puts'] = [];
  const deletes: string[] = [];
  for (const [id, row] of after) {
    const was = before.get(id);
    if (was === undefined || was.value !== row.value) puts.push({ id, value: row.value });
  }
  for (const id of before.keys()) if (!after.has(id)) deletes.push(id);
  return { assign: [], puts, deletes };
}

function emptyChange(change: VisibleChange): boolean {
  return change.assign.length === 0 && change.puts.length === 0 && change.deletes.length === 0;
}

/** The client. */
export class MutationClient {
  private readonly p: string;
  private readonly randomId: () => string;

  constructor(private readonly options: MutationClientOptions) {
    this.p = options.tablePrefix ?? 'sync_';
    if (!/^[a-z][a-z0-9_]{0,30}_$/.test(this.p)) throw new Error('a client table prefix is a lower-case SQL identifier ending in an underscore');
    this.randomId = options.randomId ?? randomHexId;
  }

  private get scope(): string {
    return this.options.scope;
  }

  /** Makes the client's tables; run once before anything else. */
  async open(): Promise<void> {
    await this.options.adapter.transaction(async (trx) => {
      for (const statement of clientDdl(this.p)) await trx.run(statement);
    });
  }

  /** The membership, the visible rows, the kept rows and the counts. */
  async snapshot(): Promise<ClientSnapshot> {
    return this.locked(async (trx, m) => {
      const canonical = await this.canonical(trx);
      let accountRows = 0;
      for (const row of canonical.values()) if (row.state !== 'tombstone') accountRows += 1;
      return {
        membership: m,
        visible: [...(await this.visible(trx, m)).values()],
        kept: [...(await this.keptRows(trx)).values()],
        pending: (await this.pendingRows(trx)).length,
        accountRows,
      };
    }, false);
  }

  /** The context a request made now would carry, or null when the client is not joined. */
  async context(): Promise<RequestContext | null> {
    return this.locked(async (_trx, m) => contextOf(m), false);
  }

  /** What a save of `rows` would send, to ask the person before a save that removes many rows. */
  async preview(rows: ReadonlyArray<{ id: string; value: string }>): Promise<{ creates: number; edits: number; deletes: number }> {
    return this.locked(async (trx, m) => {
      if (m.state !== 'joined') return { creates: 0, edits: 0, deletes: 0 };
      const planned = planRowChanges([...(await this.visible(trx, m)).values()].map(plannedOf), rows);
      return {
        creates: planned.filter((mutation) => mutation.name === 'create').length,
        edits: planned.filter((mutation) => mutation.name === 'edit').length,
        deletes: planned.filter((mutation) => mutation.name === 'delete').length,
      };
    }, false);
  }

  /**
   * Saves: the caller's data written by `write` and, while joined, the mutations that take the visible rows to `rows`,
   * each with its journal record, in one transaction. A value too long for the account is kept in this browser under
   * its row's id and gets no mutation id (an edit's keeps the revision it was made against); a save that would send
   * more deletes than `allowDeletes` throws `DeletesChanged`.
   */
  async save(input: { rows: ReadonlyArray<{ id: string; value: string }>; write(trx: StorageAdapter): Promise<void>; allowDeletes?: number }): Promise<SaveResult> {
    return this.locked(async (trx, m) => {
      if (m.removing) throw new RemovalInProgress();
      if (m.state !== 'joined') {
        await input.write(trx);
        return { mode: 'local', issued: 0, tooLong: [], deletes: 0 };
      }
      const before = await this.visible(trx, m);
      const planned = planRowChanges([...before.values()].map(plannedOf), input.rows);
      const deletes = planned.filter((mutation) => mutation.name === 'delete').length;
      if (input.allowDeletes !== undefined && deletes > input.allowDeletes) throw new DeletesChanged(deletes);
      const kept = await this.keptRows(trx);
      let state = m;
      const tooLong: string[] = [];
      for (const mutation of planned) {
        if (mutation.name !== 'delete' && mutation.name !== 'amend' && mutation.args.value.length > this.options.policy.maxUnits) {
          // kept under its own id; an edit keeps the revision it was made against, so a save that fits edits the row
          const revision = mutation.name === 'edit' ? mutation.args.expected : null;
          await this.keep(trx, { id: mutation.args.id, value: mutation.args.value, reason: 'too_long', group: revision === null ? null : state.group, revision });
          tooLong.push(mutation.args.id);
          continue;
        }
        state = await this.issue(trx, state, mutation);
      }
      const saved = new Map(input.rows.map((row) => [row.id, row.value]));
      for (const row of kept.values()) {
        if (tooLong.includes(row.id)) continue;
        const value = saved.get(row.id);
        if (value === undefined) await this.unkeep(trx, row.id);
        else if (value !== row.value) {
          // an unreadable row stays marked, with the person's new text, until a readable copy is acknowledged
          if (row.reason === 'unreadable') await this.keep(trx, { ...row, value });
          else await this.unkeep(trx, row.id);
        }
      }
      await this.saveMembership(trx, state);
      await input.write(trx);
      const after = await this.visible(trx, state);
      const change = changeOf(new Map(input.rows.map((row) => [row.id, { value: row.value }])), after);
      if (!emptyChange(change)) await this.options.materialize(trx, change);
      return { mode: 'joined', issued: state.nextMutationId - m.nextMutationId, tooLong, deletes };
    });
  }

  /** Sends the pending mutations in id order. A sent push acknowledges nothing: the pull after it does. */
  async push(): Promise<SyncOutcome> {
    const work = await this.locked(async (trx, m) => {
      const context = contextOf(m);
      if (context === null || m.recovering || m.sends !== 'open') return null;
      const pending = await this.pendingRows(trx);
      if (pending.length === 0) return null;
      return { context, mutations: pending.map((row): MutationRecord => ({ id: writeCounter(row.mutationId), name: row.mutation.name, args: row.mutation.args })) };
    }, false);
    if (work === null) return { kind: 'idle' };
    const envelope = { group: work.context.group, epoch: work.context.epoch, clientId: work.context.clientId };
    const limits = { maxMutations: this.options.pushMutations ?? 50, maxBytes: this.options.pushBytes ?? 1_000_000 };
    for (const batch of packMutations(envelope, work.mutations, limits)) {
      const outcome = await this.sendBatch(work.context, batch);
      if (outcome.kind !== 'sent') return outcome;
    }
    return { kind: 'sent' };
  }

  /** Pulls and applies the server's changes. */
  async pull(): Promise<SyncOutcome> {
    const context = await this.locked(async (_trx, m) => contextOf(m), false);
    if (context === null) return { kind: 'idle' };
    const answer = await this.options.transport.pull({ group: context.group, epoch: context.epoch, clientId: context.clientId, cookie: context.cookie === null ? null : writeCounter(context.cookie) });
    switch (answer.kind) {
      case 'pull':
        return this.apply(answer, context);
      case 'protocol_changed':
        await this.blockSends(context, 'malformed', null);
        return { kind: 'blocked' };
      case 'epoch_changed':
        return this.recover(context, answer.epoch);
      case 'cookie_ahead':
        return this.recover(context, context.epoch);
      case 'group_gone':
        return this.leave(context);
      case 'rate_limited':
        return { kind: 'wait', ms: answer.retryAfterMs };
    }
  }

  /**
   * Joins `group` with the blocks `readBlocks` reads inside the merge's transaction: a new client and activation, a full
   * snapshot staged first, then the merge (see the module's comment), the creates issued, and what became visible handed
   * to the caller, ids for unmarked blocks among it. A join whose snapshot does not come, refused or failed, turns the
   * membership off again, and the caller joins once more.
   */
  async join(input: { group: string; epoch: string; readBlocks(trx: StorageAdapter): Promise<LocalBlock[]> }): Promise<SyncOutcome> {
    const intent = await this.locked(async (trx, m) => {
      if (m.state === 'joined' && m.group === input.group) return null;
      const next: Membership = {
        ...m,
        state: 'joining',
        group: input.group,
        clientId: this.randomId(),
        activation: this.randomId(),
        epoch: input.epoch,
        cookie: null,
        nextMutationId: 1,
        sends: 'open',
        recovering: false,
        declinedGroup: null,
        removing: false,
      };
      await this.clearTransport(trx);
      // rows kept for an earlier group are merged again as ordinary blocks of the caller's data
      await trx.run(`DELETE FROM ${this.p}kept WHERE scope = ?`, [this.scope]);
      await this.saveMembership(trx, next);
      return next;
    });
    if (intent === null || intent.clientId === null) return { kind: 'idle' };
    const clientId = intent.clientId;
    const answer = await this.options.transport.pull({ group: input.group, epoch: input.epoch, clientId, cookie: null }).catch(async (error: unknown) => {
      // no snapshot came: the joining state goes, since no push or pull could finish it; a revert that fails leaves it
      // to the next join, which replaces it, and the caller hears the request's own error
      await this.abandonJoin(intent.activation).catch(() => undefined);
      throw error;
    });
    if (answer.kind !== 'pull') {
      await this.abandonJoin(intent.activation);
      if (answer.kind === 'rate_limited') return { kind: 'wait', ms: answer.retryAfterMs };
      return { kind: answer.kind === 'group_gone' ? 'off' : 'stale' };
    }
    return this.locked(async (trx, m): Promise<SyncOutcome> => {
      if (m.state !== 'joining' || m.activation !== intent.activation || answer.group !== input.group || answer.epoch !== input.epoch) return { kind: 'stale' };
      for (const entry of answer.patch) await this.writeCanonical(trx, entry);
      for (const result of answer.results) if (result.clientId === clientId) await this.writeResult(trx, result);
      const canonical = await this.canonical(trx);
      const base = new Map((await trx.all<{ id: string; value: string }>(`SELECT id, value FROM ${this.p}base WHERE scope = ?`, [this.scope])).map((row) => [row.id, row.value]));
      const blocks = await input.readBlocks(trx);
      const marked = new Set(blocks.flatMap((block) => (block.id === null ? [] : [block.id])));
      const matched = new Set<string>();
      const shown = new Map<string, { value: string }>();
      const assign: VisibleChange['assign'] = [];
      const creates: Array<{ id: string; value: string }> = [];
      for (const block of blocks) {
        if (block.id === null) {
          const match = [...canonical.values()].find((row) => row.state === 'live' && row.value === block.value && !matched.has(row.id) && !marked.has(row.id));
          if (match !== undefined) {
            matched.add(match.id);
            assign.push({ value: block.value, id: match.id });
            shown.set(match.id, { value: block.value });
            continue;
          }
          let id = block.derivedId ?? this.randomId();
          if (canonical.has(id) || shown.has(id) || marked.has(id)) id = this.randomId();
          assign.push({ value: block.value, id });
          shown.set(id, { value: block.value });
          creates.push({ id, value: block.value });
          continue;
        }
        shown.set(block.id, { value: block.value });
        const row = canonical.get(block.id);
        if (row !== undefined && row.state === 'live' && (row.value === block.value || base.get(block.id) === block.value)) {
          matched.add(block.id);
          continue;
        }
        creates.push({ id: block.id, value: block.value });
      }
      let state: Membership = { ...m, state: 'joined', cookie: readCounter(answer.cookie), syncedAt: this.now().toISOString() };
      for (const create of creates) {
        if (create.value.length > this.options.policy.maxUnits) {
          await this.keep(trx, { id: create.id, value: create.value, reason: 'too_long', group: null, revision: null });
          continue;
        }
        state = await this.issue(trx, state, { name: 'create', args: create });
      }
      await trx.run(`DELETE FROM ${this.p}base WHERE scope = ?`, [this.scope]);
      await this.saveMembership(trx, state);
      const change = { ...changeOf(shown, await this.visible(trx, state)), assign };
      if (!emptyChange(change)) await this.options.materialize(trx, change);
      return { kind: 'applied' };
    });
  }

  /** Declines `group` in this browser: no row is pulled or pushed, and a later group asks again. */
  async decline(group: string): Promise<void> {
    await this.locked(async (trx, m) => {
      await this.clearTransport(trx);
      await this.saveMembership(trx, { ...m, state: 'declined', group: null, clientId: null, epoch: null, cookie: null, nextMutationId: 1, recovering: false, declinedGroup: group, activation: this.randomId() });
    });
  }

  /**
   * Leaves the group an answer said is gone, only while `context` still holds: the canonical values become the
   * comparison base, every transport record and kept row goes, and the caller's data stays as it is.
   */
  async leave(context: RequestContext): Promise<SyncOutcome> {
    return this.locked(async (trx, m): Promise<SyncOutcome> => {
      if (!holds(m, context)) return { kind: 'stale' };
      await trx.run(`DELETE FROM ${this.p}base WHERE scope = ?`, [this.scope]);
      for (const row of (await this.canonical(trx)).values()) {
        if (row.state === 'live' && row.value !== null) await trx.run(`INSERT INTO ${this.p}base (scope, id, value) VALUES (?, ?, ?)`, [this.scope, row.id, row.value]);
      }
      await this.clearTransport(trx);
      await trx.run(`DELETE FROM ${this.p}kept WHERE scope = ?`, [this.scope]);
      await this.saveMembership(trx, { ...m, state: 'off', group: null, clientId: null, epoch: null, cookie: null, nextMutationId: 1, sends: 'open', recovering: false, removing: false, activation: this.randomId() });
      return { kind: 'off' };
    });
  }

  /** Opens sends a size or shape fault stopped, once the fault is fixed (a new release, a raised limit). */
  async reopenSends(): Promise<void> {
    await this.locked(async (trx, m) => {
      if (m.sends === 'open') return;
      await trx.run(`UPDATE ${this.p}pending SET size_error = 0 WHERE scope = ?`, [this.scope]);
      await this.saveMembership(trx, { ...m, sends: 'open' });
    });
  }

  /**
   * Starts a removal: every save is refused with `RemovalInProgress` until it finishes or is cancelled. A caller
   * begins it before the backed-up check, so nothing a save writes changes between the check and the removal.
   */
  async beginRemoval(): Promise<void> {
    await this.locked(async (trx, m) => {
      await this.saveMembership(trx, { ...m, removing: true });
    });
  }

  /** Cancels a removal; saves go on. */
  async cancelRemoval(): Promise<void> {
    await this.locked(async (trx, m) => {
      await this.saveMembership(trx, { ...m, removing: false });
    });
  }

  /**
   * Whether `blocks` are backed by the account: checked only while joined, with nothing pending, no recovery open and
   * sends open; a block is backed when a readable canonical row of its id holds exactly its text and no kept row of
   * that id exists. A block with no id is never backed.
   */
  async backedUp(blocks: ReadonlyArray<{ id: string | null; value: string }>): Promise<BackupCheck> {
    return this.locked(async (trx, m): Promise<BackupCheck> => {
      const stamp = await this.stampOf(trx, m);
      const all = blocks.map((block) => ({ id: block.id, value: block.value }));
      if (m.state !== 'joined') return { checked: false, reason: 'not_joined', unbacked: all, stamp };
      if (m.recovering) return { checked: false, reason: 'recovering', unbacked: all, stamp };
      if (m.sends !== 'open') return { checked: false, reason: 'sends_blocked', unbacked: all, stamp };
      if ((await this.pendingRows(trx)).length > 0) return { checked: false, reason: 'pending', unbacked: all, stamp };
      const canonical = await this.canonical(trx);
      const kept = await this.keptRows(trx);
      const unbacked = all.filter((block) => {
        if (block.id === null || kept.has(block.id)) return true;
        const row = canonical.get(block.id);
        return row === undefined || row.state !== 'live' || row.value !== block.value;
      });
      return { checked: true, reason: null, unbacked, stamp };
    }, false);
  }

  /**
   * Removes every sync record of this scope and runs `write`, the caller's removal of its own data, in the same
   * transaction. A stamp given is compared whatever the state, so a confirmation is void once an off learned at a pull,
   * a retirement, a pull, a push or a save that issued a mutation changed this client's records. The stamp reads the
   * client's own records alone, never the caller's data: a save that issues no mutation (a block with no id, any block
   * while not joined) leaves it as it was. So a caller begins the removal before its check, from when every save is
   * refused, and a caller whose data something besides `save` writes compares that data itself. While joined it runs
   * only inside a removal, with the stamp of a check that ran (nothing pending, no recovery open, sends open); it leaves
   * a declined choice for the group with a new activation, and no row of the account changes.
   */
  async removeAll(write: (trx: StorageAdapter) => Promise<void>, stamp?: string): Promise<void> {
    await this.locked(async (trx, m) => {
      if (stamp !== undefined && stamp !== (await this.stampOf(trx, m))) throw new RemovalInvalidated('changed');
      if (m.state === 'joined') {
        if (!m.removing) throw new RemovalNotStarted();
        if (stamp === undefined) throw new RemovalInvalidated('unchecked');
        if (m.recovering) throw new RemovalInvalidated('recovering');
        if (m.sends !== 'open') throw new RemovalInvalidated('sends_blocked');
        if ((await this.pendingRows(trx)).length > 0) throw new RemovalInvalidated('pending');
      }
      for (const table of ['rows', 'base', 'pending', 'journal', 'results', 'kept']) await trx.run(`DELETE FROM ${this.p}${table} WHERE scope = ?`, [this.scope]);
      const declinedGroup = m.state === 'joined' ? m.group : m.declinedGroup;
      await this.saveMembership(trx, {
        ...m,
        state: declinedGroup === null ? 'off' : 'declined',
        group: null,
        clientId: null,
        epoch: null,
        cookie: null,
        nextMutationId: 1,
        sends: 'open',
        recovering: false,
        declinedGroup,
        removing: false,
        activation: this.randomId(),
      });
      await write(trx);
    });
  }

  /** Issues a repair for every kept unreadable row the account still holds unreadable at the kept revision. */
  async repairUnreadable(): Promise<number> {
    return this.locked(async (trx, m) => {
      if (m.state !== 'joined' || m.removing) return 0;
      const canonical = await this.canonical(trx);
      const touched = new Set((await this.pendingRows(trx)).map((row) => row.mutation.args.id));
      let state = m;
      let issued = 0;
      for (const row of (await this.keptRows(trx)).values()) {
        if (row.reason !== 'unreadable' || row.revision === null || touched.has(row.id)) continue;
        const held = canonical.get(row.id);
        if (held === undefined || held.state !== 'unreadable' || held.revision.client !== row.revision.client || held.revision.mutation !== row.revision.mutation) continue;
        state = await this.issue(trx, state, { name: 'repair', args: { id: row.id, expected: row.revision, value: row.value } });
        issued += 1;
      }
      if (issued > 0) await this.saveMembership(trx, state);
      return issued;
    });
  }

  /**
   * Puts a kept row back into the account with an explicit create under its id (`too_long`, `full`, `recovery` and
   * `differs` rows); false when it cannot be. A `removed` row is never put back here: its id is a tombstone the server
   * refuses for good, so its return is a separate explicit save of a new row under a new id, the caller's, with the kept
   * value; nothing here creates or re-stamps it. A recovery row whose id the restored server tombstoned comes back from
   * its create refused `removed` and is kept as `removed`.
   */
  async restoreKept(id: string): Promise<boolean> {
    return this.locked(async (trx, m) => {
      if (m.state !== 'joined' || m.removing) return false;
      const row = (await this.keptRows(trx)).get(id);
      if (row === undefined || row.reason === 'unreadable' || row.reason === 'removed' || row.value.length > this.options.policy.maxUnits) return false;
      const state = await this.issue(trx, m, { name: 'create', args: { id: row.id, value: row.value } });
      await this.unkeep(trx, row.id);
      await this.saveMembership(trx, state);
      return true;
    });
  }

  /** Turns a join that got no snapshot off again, only while the joining state is still the one it made. */
  private async abandonJoin(activation: string): Promise<void> {
    await this.locked(async (trx, m) => {
      if (m.state === 'joining' && m.activation === activation) await this.saveMembership(trx, { ...m, state: 'off', group: null, clientId: null, epoch: null, activation: this.randomId() });
    });
  }

  /**
   * The removal's stamp: the state, the activation, the group, the epoch, the cookie, the counters and the kept rows, the
   * client's own records alone; a write of the caller's data that issues no mutation does not move it.
   */
  private async stampOf(trx: StorageAdapter, m: Membership): Promise<string> {
    const pending = (await this.pendingRows(trx)).length;
    const kept = [...(await this.keptRows(trx)).values()].map((row) => `${row.id}:${row.reason}:${row.value.length}`).join(',');
    const rows = await trx.get<{ n: unknown; v: unknown }>(`SELECT COUNT(*) AS n, COALESCE(MAX(version), 0) AS v FROM ${this.p}rows WHERE scope = ?`, [this.scope]);
    return [m.state, m.activation, m.group ?? '', m.epoch ?? '', m.cookie ?? '', m.nextMutationId, pending, readCounter(rows?.n ?? 0), readCounter(rows?.v ?? 0), kept].join('|');
  }

  private async sendBatch(context: RequestContext, batch: MutationRecord[]): Promise<SyncOutcome> {
    const answer = await this.options.transport.push({ group: context.group, epoch: context.epoch, clientId: context.clientId, mutations: batch });
    switch (answer.kind) {
      case 'ok':
        return { kind: 'sent' };
      case 'too_large': {
        if (batch.length > 1) {
          const half = Math.ceil(batch.length / 2);
          const first = await this.sendBatch(context, batch.slice(0, half));
          return first.kind === 'sent' ? this.sendBatch(context, batch.slice(half)) : first;
        }
        await this.blockSends(context, 'size_error', readCounter(batch[0].id));
        return { kind: 'blocked' };
      }
      case 'malformed':
        await this.blockSends(context, 'malformed', null);
        return { kind: 'blocked' };
      case 'rate_limited':
        return { kind: 'wait', ms: answer.retryAfterMs };
      case 'protocol_changed':
        await this.blockSends(context, 'malformed', null);
        return { kind: 'blocked' };
      case 'epoch_changed':
        return this.recover(context, answer.epoch);
      case 'group_gone':
        return this.leave(context);
      case 'gap':
        return this.repairSequence(context, readCounter(answer.expected));
    }
  }

  private async blockSends(context: RequestContext, sends: 'size_error' | 'malformed', mutationId: number | null): Promise<void> {
    await this.locked(async (trx, m) => {
      if (!holds(m, context)) return;
      if (mutationId !== null) await trx.run(`UPDATE ${this.p}pending SET size_error = 1 WHERE scope = ? AND mutation_id = ?`, [this.scope, mutationId]);
      await this.saveMembership(trx, { ...m, sends });
    });
  }

  /** Applies a complete pull answer in one transaction, only while its context and its cookie still hold. */
  private async apply(answer: PullResponse, context: RequestContext): Promise<SyncOutcome> {
    return this.locked(async (trx, m): Promise<SyncOutcome> => {
      if (!holds(m, context) || m.cookie !== context.cookie || answer.group !== context.group || answer.epoch !== context.epoch) return { kind: 'stale' };
      const before = await this.visible(trx, m);
      const kept = await this.keptRows(trx);
      if (answer.full) {
        // a row a full snapshot no longer holds is kept aside: absence is no evidence of a deletion
        const incoming = new Set(answer.patch.map((entry) => entry.id));
        for (const row of (await this.canonical(trx)).values()) {
          if (row.state === 'live' && row.value !== null && !incoming.has(row.id) && !kept.has(row.id)) {
            await this.keep(trx, { id: row.id, value: row.value, reason: 'recovery', group: m.group, revision: row.revision });
          }
        }
        await trx.run(`DELETE FROM ${this.p}rows WHERE scope = ?`, [this.scope]);
        await trx.run(`DELETE FROM ${this.p}results WHERE scope = ?`, [this.scope]);
      }
      for (const entry of answer.patch) {
        // a row the server cannot open: this browser's healthy text is kept and marked
        if (entry.op === 'unreadable' && !kept.has(entry.id)) {
          const shown = before.get(entry.id);
          if (shown !== undefined) await this.keep(trx, { id: entry.id, value: shown.value, reason: 'unreadable', group: m.group, revision: entry.revision });
        }
        await this.writeCanonical(trx, entry);
      }
      for (const result of answer.results) if (result.clientId === context.clientId) await this.writeResult(trx, result);
      const acknowledged = readCounter(answer.lastMutationIds[context.clientId] ?? '0');
      let state: Membership = { ...m, cookie: readCounter(answer.cookie), syncedAt: this.now().toISOString(), nextMutationId: Math.max(m.nextMutationId, acknowledged + 1) };
      // a refused mutation's value is kept before its pending record goes, in a recovery as in any pull
      await this.dropAcknowledged(trx, state, acknowledged);
      if (m.recovering) state = { ...(await this.rebuildPending(trx, state, acknowledged, before)), recovering: false };
      await this.reconcileKept(trx);
      await this.saveMembership(trx, state);
      const change = changeOf(before, await this.visible(trx, state));
      if (!emptyChange(change)) await this.options.materialize(trx, change);
      return { kind: 'applied' };
    });
  }

  /**
   * Drops the pending mutations the server processed; a refused one's value is kept first, under the id `visible`
   * showed it at while the refusal was pending: beside a live row, the copy's id the mutation would have taken; at a
   * deleted or missing row, that row's id; beside an unreadable row, that row's id, unless this browser keeps that
   * row's text already, when a different value goes under the copy's id and the same value adds nothing.
   */
  private async dropAcknowledged(trx: StorageAdapter, m: Membership, acknowledged: number): Promise<void> {
    const canonical = await this.canonical(trx);
    const kept = await this.keptRows(trx);
    for (const pending of await this.pendingRows(trx)) {
      if (pending.mutationId > acknowledged) break;
      const result = await this.resultOf(trx, m.clientId as string, String(pending.mutationId));
      if (result !== null && result.outcome === 'refused' && result.reason !== null && result.reason !== 'stale' && result.reason !== 'occupied' && pending.mutation.name !== 'delete' && pending.mutation.name !== 'amend') {
        const value = pending.mutation.args.value;
        const held = canonical.get(result.targetId);
        const there = kept.get(result.targetId);
        const copyId = (): Promise<string> => copyIdOf({ group: m.group as string, clientId: m.clientId as string, mutationId: String(pending.mutationId) });
        let id: string | null = result.targetId;
        if (held !== undefined && held.state === 'live') id = await copyId();
        else if (held !== undefined && held.state === 'unreadable' && there !== undefined) id = there.value === value ? null : await copyId();
        if (id !== null) {
          const row: KeptRow = { id, value, reason: result.reason, group: m.group, revision: null };
          await this.keep(trx, row);
          kept.set(id, row);
        }
      }
      await trx.run(`DELETE FROM ${this.p}pending WHERE scope = ? AND mutation_id = ?`, [this.scope, pending.mutationId]);
    }
  }

  /**
   * After a restore: every issued mutation above the restored last id, from the journal, pending again with its id. A
   * journal with a hole keeps the values only a pending mutation showed and retires the client.
   */
  private async rebuildPending(trx: StorageAdapter, m: Membership, acknowledged: number, shown: ReadonlyMap<string, VisibleRow>): Promise<Membership> {
    const issued = m.nextMutationId - 1;
    const journal = await trx.all<{ mutation_id: unknown; name: string; args: string }>(
      `SELECT mutation_id, name, args FROM ${this.p}journal WHERE scope = ? AND grp = ? AND client_id = ? AND mutation_id > ? ORDER BY mutation_id`,
      [this.scope, m.group, m.clientId, acknowledged],
    );
    const complete = journal.length === Math.max(0, issued - acknowledged) && journal.every((row, index) => readCounter(row.mutation_id) === acknowledged + 1 + index);
    await trx.run(`DELETE FROM ${this.p}pending WHERE scope = ?`, [this.scope]);
    if (complete) {
      for (const row of journal) {
        await trx.run(`INSERT INTO ${this.p}pending (scope, mutation_id, name, args, size_error) VALUES (?, ?, ?, ?, 0)`, [this.scope, readCounter(row.mutation_id), row.name, row.args]);
      }
      return m;
    }
    for (const row of shown.values()) {
      if (row.source === 'pending') await this.keep(trx, { id: row.id, value: row.value, reason: 'recovery', group: m.group, revision: null });
    }
    return { ...m, state: 'retired' };
  }

  /**
   * Settles the kept rows against the canonical state: a readable row with the same value releases its kept row; a
   * different readable value marks a row kept across a restore or kept unreadable as differing, at the same id, and it
   * stays shown; a tombstone releases a row kept across a restore (its downloaded value, unchanged here) and marks an
   * unreadable or differing one removed; an unreadable or absent row leaves it as it is.
   */
  private async reconcileKept(trx: StorageAdapter): Promise<void> {
    const canonical = await this.canonical(trx);
    for (const row of (await this.keptRows(trx)).values()) {
      const held = canonical.get(row.id);
      if (held === undefined || held.state === 'unreadable') continue;
      if (held.state === 'live') {
        if (held.value === row.value) await this.unkeep(trx, row.id);
        else if (row.reason === 'recovery' || row.reason === 'unreadable') await this.keep(trx, { ...row, reason: 'differs' });
        continue;
      }
      if (row.reason === 'recovery') await this.unkeep(trx, row.id);
      else if (row.reason === 'unreadable' || row.reason === 'differs') await this.keep(trx, { ...row, reason: 'removed' });
    }
  }

  /** A changed epoch, while `context` holds: downloaded rows kept aside, the cookie dropped, the full snapshot next. */
  private async recover(context: RequestContext, epoch: string): Promise<SyncOutcome> {
    return this.locked(async (trx, m): Promise<SyncOutcome> => {
      if (!holds(m, context)) return { kind: 'stale' };
      const before = await this.visible(trx, m);
      const kept = await this.keptRows(trx);
      for (const row of before.values()) {
        if (row.source === 'canonical' && !kept.has(row.id)) await this.keep(trx, { id: row.id, value: row.value, reason: 'recovery', group: m.group, revision: row.revision });
      }
      await trx.run(`DELETE FROM ${this.p}rows WHERE scope = ?`, [this.scope]);
      await trx.run(`DELETE FROM ${this.p}results WHERE scope = ?`, [this.scope]);
      const next: Membership = { ...m, epoch, cookie: null, recovering: true };
      await this.saveMembership(trx, next);
      const change = changeOf(before, await this.visible(trx, next));
      if (!emptyChange(change)) await this.options.materialize(trx, change);
      return { kind: 'recovering' };
    });
  }

  /** The server expects an earlier id than the pending ones start at: the journal's mutations from there, or retirement. */
  private async repairSequence(context: RequestContext, expected: number): Promise<SyncOutcome> {
    return this.locked(async (trx, m): Promise<SyncOutcome> => {
      if (!holds(m, context)) return { kind: 'stale' };
      const before = await this.visible(trx, m);
      const next = await this.rebuildPending(trx, m, expected - 1, before);
      await this.saveMembership(trx, next);
      if (next.state !== 'retired') return { kind: 'resend' };
      const change = changeOf(before, await this.visible(trx, next));
      if (!emptyChange(change)) await this.options.materialize(trx, change);
      return { kind: 'retired' };
    });
  }

  /**
   * Runs `work` under the lock on a reloaded image in one transaction; a stale image is reloaded and run once more, and
   * any other failure reloads the stored image before its error leaves the lock.
   */
  private async locked<T>(work: (trx: StorageAdapter, m: Membership) => Promise<T>, notify = true): Promise<T> {
    return this.options.lock.run(async () => {
      for (let attempt = 0; ; attempt += 1) {
        await this.options.reload?.();
        try {
          const result = await this.options.adapter.transaction(async (trx) => work(trx, await this.membership(trx)));
          if (notify) this.options.notify?.();
          return result;
        } catch (error) {
          // another tab saved over this one's image between the reload and the commit (the IndexedDB adapter's crossTab
          // stamp): the adapter has loaded that tab's image, and the work runs once more on it
          if (attempt === 0 && error instanceof Error && error.name === 'IndexedDbConflictError') continue;
          // a commit IndexedDB refused can still be in the memory image, where the next save would store it with the
          // caller told it failed: the stored image goes back before the error leaves the lock (an adapter opened with
          // crossTab's rollbackRefusedSaves has done it under its own lock already); a reload that fails leaves the
          // error as it is, and the next operation's reload runs before any statement
          await this.options.reload?.().catch(() => undefined);
          throw error;
        }
      }
    });
  }

  private now(): Date {
    return (this.options.clock ?? (() => new Date()))();
  }

  private async membership(trx: StorageAdapter): Promise<Membership> {
    const record = await trx.get<MembershipRecord>(
      `SELECT state, grp, client_id, activation, epoch, cookie, next_mutation_id, sends, recovering, declined_group, removing, synced_at FROM ${this.p}membership WHERE scope = ?`,
      [this.scope],
    );
    if (record !== null) {
      return {
        state: record.state as MembershipState,
        group: record.grp,
        clientId: record.client_id,
        activation: record.activation,
        epoch: record.epoch,
        cookie: record.cookie === null ? null : readCounter(record.cookie),
        nextMutationId: readCounter(record.next_mutation_id),
        sends: record.sends as Membership['sends'],
        recovering: Number(record.recovering) === 1,
        declinedGroup: record.declined_group,
        removing: Number(record.removing) === 1,
        syncedAt: record.synced_at,
      };
    }
    const fresh: Membership = { state: 'none', group: null, clientId: null, activation: this.randomId(), epoch: null, cookie: null, nextMutationId: 1, sends: 'open', recovering: false, declinedGroup: null, removing: false, syncedAt: null };
    await this.saveMembership(trx, fresh);
    return fresh;
  }

  private async saveMembership(trx: StorageAdapter, m: Membership): Promise<void> {
    await trx.run(
      `INSERT INTO ${this.p}membership (scope, state, grp, client_id, activation, epoch, cookie, next_mutation_id, sends, recovering, declined_group, removing, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ` +
        'ON CONFLICT (scope) DO UPDATE SET state = excluded.state, grp = excluded.grp, client_id = excluded.client_id, activation = excluded.activation, epoch = excluded.epoch, cookie = excluded.cookie, next_mutation_id = excluded.next_mutation_id, sends = excluded.sends, recovering = excluded.recovering, declined_group = excluded.declined_group, removing = excluded.removing, synced_at = excluded.synced_at',
      [this.scope, m.state, m.group, m.clientId, m.activation, m.epoch, m.cookie, m.nextMutationId, m.sends, m.recovering ? 1 : 0, m.declinedGroup, m.removing ? 1 : 0, m.syncedAt],
    );
  }

  /** Drops the group's transport records: canonical rows, pending mutations, the journal and the results. */
  private async clearTransport(trx: StorageAdapter): Promise<void> {
    for (const table of ['rows', 'pending', 'journal', 'results']) await trx.run(`DELETE FROM ${this.p}${table} WHERE scope = ?`, [this.scope]);
  }

  private async canonical(trx: StorageAdapter): Promise<Map<string, Row>> {
    const rows = await trx.all<{ id: string; state: string; value: string | null; rev_client: string; rev_mutation: unknown }>(
      `SELECT id, state, value, rev_client, rev_mutation FROM ${this.p}rows WHERE scope = ? ORDER BY id`,
      [this.scope],
    );
    return new Map(rows.map((row) => [row.id, { id: row.id, state: row.state as Row['state'], value: row.value, revision: { client: row.rev_client, mutation: writeCounter(readCounter(row.rev_mutation)) } }]));
  }

  private async keptRows(trx: StorageAdapter): Promise<Map<string, KeptRow>> {
    const rows = await trx.all<{ id: string; value: string; reason: string; grp: string | null; rev_client: string | null; rev_mutation: unknown }>(
      `SELECT id, value, reason, grp, rev_client, rev_mutation FROM ${this.p}kept WHERE scope = ? ORDER BY id`,
      [this.scope],
    );
    return new Map(
      rows.map((row) => [
        row.id,
        { id: row.id, value: row.value, reason: row.reason as KeptReason, group: row.grp, revision: row.rev_client === null ? null : { client: row.rev_client, mutation: writeCounter(readCounter(row.rev_mutation)) } },
      ]),
    );
  }

  private async pendingRows(trx: StorageAdapter): Promise<PendingRow[]> {
    const rows = await trx.all<{ mutation_id: unknown; name: string; args: string; size_error: unknown }>(
      `SELECT mutation_id, name, args, size_error FROM ${this.p}pending WHERE scope = ? ORDER BY mutation_id`,
      [this.scope],
    );
    return rows.map((row) => ({ mutationId: readCounter(row.mutation_id), mutation: rowMutationOf(row.name, JSON.parse(row.args)), sizeError: Number(row.size_error) === 1 }));
  }

  /** A recorded result of this client's, with the revision it recorded, which a dependent mutation is compared against. */
  private async resultOf(trx: StorageAdapter, clientId: string, mutationId: string): Promise<{ outcome: Outcome; reason: Refusal | null; targetId: string; revision: Revision | null } | null> {
    const row = await trx.get<{ outcome: string; reason: string | null; target_id: string; rev_client: string | null; rev_mutation: unknown }>(
      `SELECT outcome, reason, target_id, rev_client, rev_mutation FROM ${this.p}results WHERE scope = ? AND client_id = ? AND mutation_id = ?`,
      [this.scope, clientId, readCounter(mutationId)],
    );
    if (row === null) return null;
    return {
      outcome: row.outcome as Outcome,
      reason: row.reason as Refusal | null,
      targetId: row.target_id,
      revision: row.rev_client === null ? null : { client: row.rev_client, mutation: writeCounter(readCounter(row.rev_mutation)) },
    };
  }

  private async writeResult(trx: StorageAdapter, result: MutationResult): Promise<void> {
    await trx.run(
      `INSERT INTO ${this.p}results (scope, client_id, mutation_id, outcome, reason, target_id, rev_client, rev_mutation) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (scope, client_id, mutation_id) DO UPDATE SET outcome = excluded.outcome, reason = excluded.reason, target_id = excluded.target_id, rev_client = excluded.rev_client, rev_mutation = excluded.rev_mutation`,
      [this.scope, result.clientId, readCounter(result.mutationId), result.outcome, result.reason, result.targetId, result.revision?.client ?? null, result.revision === null ? null : readCounter(result.revision.mutation)],
    );
  }

  private async writeCanonical(trx: StorageAdapter, entry: PatchEntry): Promise<void> {
    const state = entry.op === 'put' ? 'live' : entry.op === 'del' ? 'tombstone' : 'unreadable';
    await trx.run(
      `INSERT INTO ${this.p}rows (scope, id, state, value, rev_client, rev_mutation, version) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (scope, id) DO UPDATE SET state = excluded.state, value = excluded.value, rev_client = excluded.rev_client, rev_mutation = excluded.rev_mutation, version = excluded.version`,
      [this.scope, entry.id, state, entry.op === 'put' ? entry.value : null, entry.revision.client, readCounter(entry.revision.mutation), readCounter(entry.version)],
    );
  }

  private async keep(trx: StorageAdapter, row: KeptRow): Promise<void> {
    await trx.run(
      `INSERT INTO ${this.p}kept (scope, id, value, reason, grp, rev_client, rev_mutation) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (scope, id) DO UPDATE SET value = excluded.value, reason = excluded.reason, grp = excluded.grp, rev_client = excluded.rev_client, rev_mutation = excluded.rev_mutation`,
      [this.scope, row.id, row.value, row.reason, row.group, row.revision?.client ?? null, row.revision === null ? null : readCounter(row.revision.mutation)],
    );
  }

  private async unkeep(trx: StorageAdapter, id: string): Promise<void> {
    await trx.run(`DELETE FROM ${this.p}kept WHERE scope = ? AND id = ?`, [this.scope, id]);
  }

  /** Allocates the next mutation id and records the mutation as pending and in the journal. */
  private async issue(trx: StorageAdapter, m: Membership, mutation: RowMutation): Promise<Membership> {
    if (m.group === null || m.clientId === null) throw new Error('a mutation is issued only in a group');
    const id = m.nextMutationId;
    const args = JSON.stringify(mutation.args);
    await trx.run(`INSERT INTO ${this.p}pending (scope, mutation_id, name, args, size_error) VALUES (?, ?, ?, ?, 0)`, [this.scope, id, mutation.name, args]);
    await trx.run(`INSERT INTO ${this.p}journal (scope, grp, client_id, mutation_id, name, args) VALUES (?, ?, ?, ?, ?, ?)`, [this.scope, m.group, m.clientId, id, mutation.name, args]);
    return { ...m, nextMutationId: nextCounter(id) };
  }

  /**
   * The rows the caller shows: the canonical rows with the pending mutations replayed over them by the same mutators
   * the server runs, a pending value the replay refuses kept in view until its refusal is acknowledged, and the kept
   * rows over all of it.
   */
  private async visible(trx: StorageAdapter, m: Membership): Promise<Map<string, VisibleRow>> {
    const canonical = await this.canonical(trx);
    const overlay = new Map<string, Row>();
    const provisional = new Map<string, VisibleRow>();
    if (m.state === 'joined' && m.group !== null && m.clientId !== null) {
      const group = m.group;
      const clientId = m.clientId;
      const local = new Map<string, { outcome: Outcome; targetId: string; revision: Revision | null }>();
      const view: RowView = {
        row: async (id) => overlay.get(id) ?? canonical.get(id) ?? null,
        liveCount: async () => {
          let count = 0;
          for (const id of new Set([...canonical.keys(), ...overlay.keys()])) {
            const row = overlay.get(id) ?? canonical.get(id);
            if (row !== undefined && row.state !== 'tombstone') count += 1;
          }
          return count;
        },
        result: async (client, mutation) => local.get(`${client}:${mutation}`) ?? (await this.resultOf(trx, client, mutation)),
      };
      for (const pending of await this.pendingRows(trx)) {
        const context = { group, clientId, mutationId: String(pending.mutationId) };
        const revision: Revision = { client: clientId, mutation: context.mutationId };
        const effect = await applyRowMutation(view, this.options.policy, context, pending.mutation);
        local.set(`${clientId}:${context.mutationId}`, { outcome: effect.outcome, targetId: effect.targetId, revision: effect.revision });
        if (effect.write !== null) {
          overlay.set(effect.write.id, { ...effect.write, revision });
        } else if (effect.outcome === 'refused' && pending.mutation.name !== 'delete' && pending.mutation.name !== 'amend') {
          const held = overlay.get(effect.targetId) ?? canonical.get(effect.targetId);
          const id = held !== undefined && held.state === 'live' ? await copyIdOf(context) : effect.targetId;
          provisional.set(id, { id, value: pending.mutation.args.value, revision, source: 'pending', reason: null });
        }
      }
    }
    const visible = new Map<string, VisibleRow>();
    for (const id of new Set([...canonical.keys(), ...overlay.keys()])) {
      const row = overlay.get(id) ?? canonical.get(id);
      if (row !== undefined && row.state === 'live' && row.value !== null) visible.set(id, { id, value: row.value, revision: row.revision, source: overlay.has(id) ? 'pending' : 'canonical', reason: null });
    }
    for (const [id, row] of provisional) visible.set(id, row);
    for (const row of (await this.keptRows(trx)).values()) visible.set(row.id, { id: row.id, value: row.value, revision: row.revision, source: 'kept', reason: row.reason });
    return visible;
  }
}
