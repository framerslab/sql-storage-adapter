/**
 * The mutations of a set of named text rows and the copy policy that settles their conflicts by the server's order.
 * The server runs them inside each push's transaction; a client runs the same functions to replay its pending
 * mutations over the server's state, so its rebase lands where the server will. Nothing here reads a clock: an edit
 * names the revision it was made against, and a revision is a mutation's identity.
 *
 * - `create` takes an unused id; the same value already there is a no-op; a different live or unreadable row is kept
 *   and the incoming value becomes a copy; a deleted id is refused as removed.
 * - `edit` replaces a row at the revision it names; at another revision a different value becomes a copy and the same
 *   value is a no-op; a missing or deleted row is refused as removed.
 * - `delete` removes a row at the revision it names and leaves a tombstone for a missing or deleted one (an accepted
 *   delete); at another revision it is refused as stale, so a delayed delete never removes an edit its sender had not
 *   seen.
 * - `repair` replaces a row the server could not open, at exactly the revision it names, and is refused otherwise.
 * - `amend` names the row's whole revision and its content revision: a delta alone lands on the row as it is now; new
 *   content lands when its content revision is current or it equals the row's content, else it becomes a copy that
 *   carries the row's current rest with the delta. What content is and how a delta applies are the caller's
 *   `RowComposer`'s; a policy with none refuses `amend` as stale.
 * - `claim` creates at an id the caller derived; the same value there is a no-op, and anything else, a tombstone
 *   included, is refused as occupied, never a copy. A mutation that names a refused claim's revision is refused too.
 *
 * A copy's id is derived from the group, the client and the mutation id; a mutation that names an earlier mutation's
 * revision follows that mutation's recorded result to its copy, and an edit that does keeps the copy's naming
 * (`copyValue`). Copies and unreadable rows count toward the limit.
 */
import { hexIdAt, revisionAt, WireError, type Outcome, type Refusal, type Revision } from './wire';

/** The row mutations. */
export const ROW_MUTATIONS = ['create', 'edit', 'delete', 'repair', 'amend', 'claim'] as const;

/** One row mutation's name. */
export type RowMutationName = (typeof ROW_MUTATIONS)[number];

/** Each row mutation's arguments. */
export interface RowArgs {
  create: { id: string; value: string };
  edit: { id: string; expected: Revision; value: string };
  delete: { id: string; expected: Revision };
  repair: { id: string; expected: Revision; value: string };
  /** A change made against a row's revision and its content revision: replacement content or none, a delta or none, not both none. */
  amend: { id: string; expected: Revision; expectedContent: Revision; content: string | null; delta: string | null };
  /** A create at an id the caller derived, refused when anything else holds it. */
  claim: { id: string; value: string };
}

/** A row mutation as code builds it, before it has an id. */
export type RowMutation = { [N in RowMutationName]: { name: N; args: RowArgs[N] } }[RowMutationName];

/** A row's state: readable, deleted, or kept by the server without it being able to read it. */
export type RowState = 'live' | 'tombstone' | 'unreadable';

/** A row as the mutators read it; `value` is null but for a live row. */
export interface Row {
  id: string;
  state: RowState;
  value: string | null;
  revision: Revision;
  /** The mutation that last changed its content; its `revision` when left out. */
  contentRevision?: Revision;
}

/** An earlier mutation's recorded result, as the mutators read it. */
export interface RecordedResult {
  outcome: Outcome;
  reason?: Refusal | null;
  targetId: string;
  /** The whole revision after a successful result, including a no-op; null for a refusal. */
  revision: Revision | null;
  /** Its target's content revision after it; null or absent when it wrote nothing that names one. */
  contentRevision?: Revision | null;
}

/** What the mutators read. */
export interface RowView {
  row(id: string): Promise<Row | null>;
  /** The rows that are not tombstones. */
  liveCount(): Promise<number>;
  /** The recorded result of an earlier mutation, or null. */
  result(clientId: string, mutationId: string): Promise<RecordedResult | null>;
}

/** How a caller splits a value into its content and the rest; the mutators never parse a value themselves. */
export interface RowComposer {
  /** The part of a value its content revision covers. */
  contentOf(value: string): string;
  /** `current` with its content replaced when `content` is not null, and `delta` applied when it is not null. */
  compose(current: string, content: string | null, delta: string | null): string;
  /** The delta from `before` to `after` outside their content, or null when there is none. */
  deltaOf(before: string, after: string): string | null;
  /** Whether the live value at a claimed id is the claim's own. */
  sameClaim(current: string, incoming: string): boolean;
}

/** The limits, the copy's value and the composer, which the caller sets. */
export interface RowPolicy {
  /** The most rows that are not tombstones, copies and unreadable rows included. */
  maxRows: number;
  /** The longest value, in UTF-16 code units. */
  maxUnits: number;
  /** The value a copy of `value` is kept under, so a person can tell the two apart. */
  copyValue(value: string): string;
  /** Takes `amend` and decides a claim's sameness; with none, `amend` is refused as stale and claims compare exactly. */
  composer?: RowComposer;
}

/** Whose mutation this is. */
export interface MutationContext {
  group: string;
  clientId: string;
  mutationId: string;
}

/** What one mutation did. */
export interface RowEffect {
  outcome: 'applied' | 'noop' | 'copied' | 'refused';
  reason: Refusal | null;
  /** The row the effect landed on, or would have: the copy's id for a copy. */
  targetId: string;
  /**
   * The row's revision after the effect: the mutation's own for a write, the row's current one for a no-op, null for a
   * refusal. The result records it, and a dependent mutation from the same client is compared against it.
   */
  revision: Revision | null;
  /** The row to write with the mutation's revision, or null; `contentChanged` false keeps the row's content revision. */
  write: { id: string; state: RowState; value: string | null; contentChanged: boolean } | null;
  /** True for a delete the server accepted, whose row a caller fences before it commits. */
  acceptedDelete: boolean;
}

function textArg(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new WireError(field);
  return value;
}

function nullableText(value: unknown, field: string): string | null {
  return value === null ? null : textArg(value, field);
}

const ALLOWED: Record<RowMutationName, readonly string[]> = {
  create: ['id', 'value'],
  edit: ['id', 'expected', 'value'],
  delete: ['id', 'expected'],
  repair: ['id', 'expected', 'value'],
  amend: ['id', 'expected', 'expectedContent', 'content', 'delta'],
  claim: ['id', 'value'],
};

/** Reads a row mutation's arguments, refusing any other shape. */
export function parseRowArgs(name: string, args: unknown, field = 'args'): RowArgs[RowMutationName] {
  if (!(ROW_MUTATIONS as readonly string[]).includes(name)) throw new WireError(`${field}.name`);
  if (typeof args !== 'object' || args === null || Array.isArray(args)) throw new WireError(field);
  const record = args as Record<string, unknown>;
  const known = name as RowMutationName;
  for (const key of Object.keys(record)) if (!ALLOWED[known].includes(key)) throw new WireError(`${field}.${key}`);
  const id = hexIdAt(record.id, `${field}.id`);
  switch (known) {
    case 'create':
      return { id, value: textArg(record.value, `${field}.value`) };
    case 'edit':
      return { id, expected: revisionAt(record.expected, `${field}.expected`), value: textArg(record.value, `${field}.value`) };
    case 'delete':
      return { id, expected: revisionAt(record.expected, `${field}.expected`) };
    case 'repair':
      return { id, expected: revisionAt(record.expected, `${field}.expected`), value: textArg(record.value, `${field}.value`) };
    case 'amend': {
      const content = nullableText(record.content, `${field}.content`);
      const delta = nullableText(record.delta, `${field}.delta`);
      if (content === null && delta === null) throw new WireError(field);
      return { id, expected: revisionAt(record.expected, `${field}.expected`), expectedContent: revisionAt(record.expectedContent, `${field}.expectedContent`), content, delta };
    }
    case 'claim':
      return { id, value: textArg(record.value, `${field}.value`) };
  }
}

/** A row mutation from its stored name and arguments. */
export function rowMutationOf(name: string, args: unknown): RowMutation {
  return { name, args: parseRowArgs(name, args) } as RowMutation;
}

/** True when two revisions name the same mutation. */
export function sameRevision(a: Revision, b: Revision): boolean {
  return a.client === b.client && a.mutation === b.mutation;
}

/** A copy's id: the first 32 hexadecimal characters of SHA-256 over `copy:v1:<group>:<client>:<mutation id>`. */
export async function copyIdOf(context: MutationContext): Promise<string> {
  const bytes = new TextEncoder().encode(`copy:v1:${context.group}:${context.clientId}:${context.mutationId}`);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest.subarray(0, 16), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function effect(outcome: RowEffect['outcome'], targetId: string, write: RowEffect['write'], revision: Revision, acceptedDelete = false): RowEffect {
  return { outcome, reason: null, targetId, revision, write, acceptedDelete };
}

function refused(reason: Refusal, targetId: string): RowEffect {
  return { outcome: 'refused', reason, targetId, revision: null, write: null, acceptedDelete: false };
}

/**
 * The row a mutation that names `expected` acts on, and the revision it is compared against: the row and the revision
 * its earlier mutation's successful result recorded (a copy's id and revision, or the revision a no-op found on the
 * row), else `id` and `expected` as given. A dependent mutation from a client targets that client's recorded result,
 * so a same-text create that was a no-op is followed by its delete or edit at the revision the row had, not at the
 * client's own. Null when the earlier mutation was refused as occupied (a claim, or a mutation that depended on one):
 * its dependents have no target.
 */
async function targetOf(view: RowView, id: string, expected: Revision): Promise<{ id: string; expected: Revision } | null> {
  const earlier = await view.result(expected.client, expected.mutation);
  if (earlier !== null && earlier.outcome === 'refused' && earlier.reason === 'occupied') return null;
  return earlier !== null && earlier.outcome !== 'refused' && earlier.revision !== null
    ? { id: earlier.targetId, expected: earlier.revision }
    : { id, expected };
}

/** The content revision a mutation was made against: the one its earlier mutation's result left, else the one it names. */
async function contentBase(view: RowView, expected: Revision): Promise<Revision> {
  const earlier = await view.result(expected.client, expected.mutation);
  return earlier?.contentRevision ?? expected;
}

/** Keeps `value` as a copy beside the row it differs from, or refuses it when the copy is too long or the rows full. */
async function copy(view: RowView, policy: RowPolicy, context: MutationContext, own: Revision, id: string, value: string): Promise<RowEffect> {
  const copyValue = policy.copyValue(value);
  if (copyValue.length > policy.maxUnits) return refused('too_long', id);
  const copyId = await copyIdOf(context);
  const existing = await view.row(copyId);
  if (existing !== null) return effect('noop', copyId, null, existing.revision);
  if ((await view.liveCount()) >= policy.maxRows) return refused('full', id);
  return effect('copied', copyId, { id: copyId, state: 'live', value: copyValue, contentChanged: true }, own);
}

/** The value at issue time: its own, or an amend composed over its live local base; persist it before any rebase. */
export function incomingValue(policy: RowPolicy, mutation: RowMutation, held: Row | undefined): string | null {
  switch (mutation.name) {
    case 'delete':
      return null;
    case 'amend':
      if (policy.composer === undefined || held?.state !== 'live' || held.value === null) throw new Error('amend recovery requires its local base');
      return policy.composer.compose(held.value, mutation.args.content, mutation.args.delta);
    default:
      return mutation.args.value;
  }
}

/** Runs one row mutation against a view; the caller writes `write` with the mutation's revision and records the result. */
export async function applyRowMutation(view: RowView, policy: RowPolicy, context: MutationContext, mutation: RowMutation): Promise<RowEffect> {
  const own: Revision = { client: context.clientId, mutation: context.mutationId };
  switch (mutation.name) {
    case 'create': {
      const { id, value } = mutation.args;
      if (value.length > policy.maxUnits) return refused('too_long', id);
      const row = await view.row(id);
      if (row === null) {
        if ((await view.liveCount()) >= policy.maxRows) return refused('full', id);
        return effect('applied', id, { id, state: 'live', value, contentChanged: true }, own);
      }
      if (row.state === 'tombstone') return refused('removed', id);
      if (row.state === 'live' && row.value === value) return effect('noop', id, null, row.revision);
      return copy(view, policy, context, own, id, value);
    }
    case 'edit': {
      const target = await targetOf(view, mutation.args.id, mutation.args.expected);
      if (target === null) return refused('occupied', mutation.args.id);
      const { id, expected } = target;
      // an edit that follows its earlier mutation to a copy keeps the copy's naming
      const value = id === mutation.args.id ? mutation.args.value : policy.copyValue(mutation.args.value);
      if (value.length > policy.maxUnits) return refused('too_long', id);
      const row = await view.row(id);
      if (row === null || row.state === 'tombstone') return refused('removed', id);
      if (sameRevision(row.revision, expected)) return effect('applied', id, { id, state: 'live', value, contentChanged: true }, own);
      if (row.state === 'live' && row.value === value) return effect('noop', id, null, row.revision);
      return copy(view, policy, context, own, id, mutation.args.value);
    }
    case 'delete': {
      const target = await targetOf(view, mutation.args.id, mutation.args.expected);
      if (target === null) return refused('occupied', mutation.args.id);
      const { id, expected } = target;
      const row = await view.row(id);
      if (row === null) return effect('applied', id, { id, state: 'tombstone', value: null, contentChanged: true }, own, true);
      if (row.state === 'tombstone') return effect('noop', id, null, row.revision, true);
      if (sameRevision(row.revision, expected)) return effect('applied', id, { id, state: 'tombstone', value: null, contentChanged: true }, own, true);
      return refused('stale', id);
    }
    case 'repair': {
      const { id, expected, value } = mutation.args;
      if (value.length > policy.maxUnits) return refused('too_long', id);
      const row = await view.row(id);
      if (row !== null && row.state === 'unreadable' && sameRevision(row.revision, expected)) return effect('applied', id, { id, state: 'live', value, contentChanged: true }, own);
      return refused('stale', id);
    }
    case 'amend': {
      const composer = policy.composer;
      if (composer === undefined) return refused('stale', mutation.args.id);
      const { expected, expectedContent, content, delta } = mutation.args;
      const target = await targetOf(view, mutation.args.id, expected);
      if (target === null) return refused('occupied', mutation.args.id);
      const { id } = target;
      const row = await view.row(id);
      if (row === null || row.state === 'tombstone') return refused('removed', id);
      if (row.state !== 'live' || row.value === null) return refused('stale', id);
      // content that follows its earlier mutation to a copy keeps the copy's naming
      const named = content === null || id === mutation.args.id ? content : composer.contentOf(policy.copyValue(composer.compose(row.value, content, null)));
      const current = composer.contentOf(row.value);
      const sameContent = named === null || named === current;
      if (!sameContent && !sameRevision(row.contentRevision ?? row.revision, await contentBase(view, expectedContent))) {
        return copy(view, policy, context, own, id, composer.compose(row.value, content, delta));
      }
      const value = composer.compose(row.value, sameContent ? null : named, delta);
      if (value.length > policy.maxUnits) return refused('too_long', id);
      if (value === row.value) return effect('noop', id, null, row.revision);
      return effect('applied', id, { id, state: 'live', value, contentChanged: composer.contentOf(value) !== current }, own);
    }
    case 'claim': {
      const { id, value } = mutation.args;
      if (value.length > policy.maxUnits) return refused('too_long', id);
      const row = await view.row(id);
      if (row === null) {
        if ((await view.liveCount()) >= policy.maxRows) return refused('full', id);
        return effect('applied', id, { id, state: 'live', value, contentChanged: true }, own);
      }
      const same = row.state === 'live' && row.value !== null && (policy.composer?.sameClaim(row.value, value) ?? row.value === value);
      return same ? effect('noop', id, null, row.revision) : refused('occupied', id);
    }
  }
}

/** A row as a client holds it when it plans a save: its value, the revision it was made against, and whether it is held only here. */
export interface PlannedRow {
  id: string;
  value: string;
  /** The revision of the row the client shows, or null for a row the server never had. */
  revision: Revision | null;
  /** The content revision of the row the client shows, or null for a row the server never had. */
  contentRevision?: Revision | null;
  /** True for a row this browser keeps alone (refused, or kept across a restore), which a save creates again. */
  local: boolean;
}

/** Two rows of one save named by the same id. */
export class DuplicateRowId extends Error {
  constructor() {
    super('a save names a row id twice');
    this.name = 'DuplicateRowId';
  }
}

/**
 * The mutations that take `before` to `after`: a create (a claim for a row marked so) for a new id or a local row whose
 * value changed; for a changed row with a revision, an edit at that revision, or with a composer an amend carrying its
 * content when the content changed and its delta when the rest did; a delete at that revision for a row `after` no
 * longer holds. A local row whose value did not change, or that `after` no longer holds, sends nothing. Creates,
 * claims, edits and amends come in `after`'s order, then the deletes in `before`'s.
 */
export function planRowChanges(before: readonly PlannedRow[], after: ReadonlyArray<{ id: string; value: string; claim?: boolean }>, composer?: RowComposer): RowMutation[] {
  const held = new Map(before.map((row) => [row.id, row]));
  const named = new Set<string>();
  const planned: RowMutation[] = [];
  for (const row of after) {
    if (named.has(row.id)) throw new DuplicateRowId();
    named.add(row.id);
    const was = held.get(row.id);
    if (was !== undefined && was.value === row.value) continue;
    if (was === undefined || was.local || was.revision === null) {
      planned.push(row.claim === true ? { name: 'claim', args: { id: row.id, value: row.value } } : { name: 'create', args: { id: row.id, value: row.value } });
      continue;
    }
    if (composer === undefined) {
      planned.push({ name: 'edit', args: { id: row.id, expected: was.revision, value: row.value } });
      continue;
    }
    const content = composer.contentOf(row.value);
    const changed = content !== composer.contentOf(was.value);
    const delta = composer.deltaOf(was.value, row.value);
    if (!changed && delta === null) continue;
    planned.push({ name: 'amend', args: { id: row.id, expected: was.revision, expectedContent: was.contentRevision ?? was.revision, content: changed ? content : null, delta } });
  }
  for (const row of before) {
    if (!named.has(row.id) && !row.local && row.revision !== null) planned.push({ name: 'delete', args: { id: row.id, expected: row.revision } });
  }
  return planned;
}
