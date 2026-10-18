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
 *
 * A copy's id is derived from the group, the client and the mutation id; a mutation that names an earlier mutation's
 * revision follows that mutation's recorded result to its copy, and an edit that does keeps the copy's naming
 * (`copyValue`). Copies and unreadable rows count toward the limit.
 */
import { hexIdAt, revisionAt, WireError, type MutationResult, type Refusal, type Revision } from './wire';

/** The row mutations. */
export const ROW_MUTATIONS = ['create', 'edit', 'delete', 'repair'] as const;

/** One row mutation's name. */
export type RowMutationName = (typeof ROW_MUTATIONS)[number];

/** Each row mutation's arguments. */
export interface RowArgs {
  create: { id: string; value: string };
  edit: { id: string; expected: Revision; value: string };
  delete: { id: string; expected: Revision };
  repair: { id: string; expected: Revision; value: string };
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
}

/** What the mutators read. */
export interface RowView {
  row(id: string): Promise<Row | null>;
  /** The rows that are not tombstones. */
  liveCount(): Promise<number>;
  /** The recorded result of an earlier mutation, or null. */
  result(clientId: string, mutationId: string): Promise<Pick<MutationResult, 'outcome' | 'targetId' | 'revision'> | null>;
}

/** The limits and the copy's value, which the caller sets. */
export interface RowPolicy {
  /** The most rows that are not tombstones, copies and unreadable rows included. */
  maxRows: number;
  /** The longest value, in UTF-16 code units. */
  maxUnits: number;
  /** The value a copy of `value` is kept under, so a person can tell the two apart. */
  copyValue(value: string): string;
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
  /** The row the effect landed on, or would have. */
  targetId: string;
  /**
   * The row's revision after the effect: the mutation's own for a write, the row's current one for a no-op, null for a
   * refusal. The result records it, and a dependent mutation from the same client is compared against it.
   */
  revision: Revision | null;
  /** The row to write with the mutation's revision, or null. */
  write: { id: string; state: RowState; value: string | null } | null;
  /** True for a delete the server accepted, whose row a caller fences before it commits. */
  acceptedDelete: boolean;
}

function textArg(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new WireError(field);
  return value;
}

const ALLOWED: Record<RowMutationName, readonly string[]> = {
  create: ['id', 'value'],
  edit: ['id', 'expected', 'value'],
  delete: ['id', 'expected'],
  repair: ['id', 'expected', 'value'],
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
 * its earlier mutation's result recorded (a copy's id and revision, or the revision a no-op found on the row), else
 * `id` and `expected` as given. A dependent mutation from a client targets that client's recorded result, so a
 * same-text create that was a no-op is followed by its delete or edit at the revision the row had, not at the client's
 * own.
 */
async function targetOf(view: RowView, id: string, expected: Revision): Promise<{ id: string; expected: Revision }> {
  const earlier = await view.result(expected.client, expected.mutation);
  return earlier !== null && earlier.revision !== null ? { id: earlier.targetId, expected: earlier.revision } : { id, expected };
}

/** Keeps `value` as a copy beside the row it differs from, or refuses it when the copy is too long or the rows full. */
async function copy(view: RowView, policy: RowPolicy, context: MutationContext, own: Revision, id: string, value: string): Promise<RowEffect> {
  const copyValue = policy.copyValue(value);
  if (copyValue.length > policy.maxUnits) return refused('too_long', id);
  const copyId = await copyIdOf(context);
  const existing = await view.row(copyId);
  if (existing !== null) return effect('noop', copyId, null, existing.revision);
  if ((await view.liveCount()) >= policy.maxRows) return refused('full', id);
  return effect('copied', copyId, { id: copyId, state: 'live', value: copyValue }, own);
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
        return effect('applied', id, { id, state: 'live', value }, own);
      }
      if (row.state === 'tombstone') return refused('removed', id);
      if (row.state === 'live' && row.value === value) return effect('noop', id, null, row.revision);
      return copy(view, policy, context, own, id, value);
    }
    case 'edit': {
      const { id, expected } = await targetOf(view, mutation.args.id, mutation.args.expected);
      // an edit that follows its earlier mutation to a copy keeps the copy's naming
      const value = id === mutation.args.id ? mutation.args.value : policy.copyValue(mutation.args.value);
      if (value.length > policy.maxUnits) return refused('too_long', id);
      const row = await view.row(id);
      if (row === null || row.state === 'tombstone') return refused('removed', id);
      if (sameRevision(row.revision, expected)) return effect('applied', id, { id, state: 'live', value }, own);
      if (row.state === 'live' && row.value === value) return effect('noop', id, null, row.revision);
      return copy(view, policy, context, own, id, mutation.args.value);
    }
    case 'delete': {
      const { id, expected } = await targetOf(view, mutation.args.id, mutation.args.expected);
      const row = await view.row(id);
      if (row === null) return effect('applied', id, { id, state: 'tombstone', value: null }, own, true);
      if (row.state === 'tombstone') return effect('noop', id, null, row.revision, true);
      if (sameRevision(row.revision, expected)) return effect('applied', id, { id, state: 'tombstone', value: null }, own, true);
      return refused('stale', id);
    }
    case 'repair': {
      const { id, expected, value } = mutation.args;
      if (value.length > policy.maxUnits) return refused('too_long', id);
      const row = await view.row(id);
      if (row !== null && row.state === 'unreadable' && sameRevision(row.revision, expected)) return effect('applied', id, { id, state: 'live', value }, own);
      return refused('stale', id);
    }
  }
}

/** A row as a client holds it when it plans a save: its value, the revision it was made against, and whether it is held only here. */
export interface PlannedRow {
  id: string;
  value: string;
  /** The revision of the row the client shows, or null for a row the server never had. */
  revision: Revision | null;
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
 * The mutations that take `before` to `after`: a create for a new id or a local row whose value changed, an edit at
 * the revision a changed row was shown at, and a delete at that revision for a row `after` no longer holds. A local
 * row whose value did not change, or that `after` no longer holds, sends nothing. Creates and edits come in `after`'s
 * order, then the deletes in `before`'s.
 */
export function planRowChanges(before: readonly PlannedRow[], after: ReadonlyArray<{ id: string; value: string }>): RowMutation[] {
  const held = new Map(before.map((row) => [row.id, row]));
  const named = new Set<string>();
  const planned: RowMutation[] = [];
  for (const row of after) {
    if (named.has(row.id)) throw new DuplicateRowId();
    named.add(row.id);
    const was = held.get(row.id);
    if (was !== undefined && was.value === row.value) continue;
    if (was === undefined || was.local || was.revision === null) {
      planned.push({ name: 'create', args: { id: row.id, value: row.value } });
      continue;
    }
    planned.push({ name: 'edit', args: { id: row.id, expected: was.revision, value: row.value } });
  }
  for (const row of before) {
    if (!named.has(row.id) && !row.local && row.revision !== null) planned.push({ name: 'delete', args: { id: row.id, expected: row.revision } });
  }
  return planned;
}
