/**
 * The wire contract of the mutation sync. A client pushes its mutations in id order and pulls the server's changes;
 * the server answers each from one transaction. Group, client, epoch and row ids are 32 lower-case hexadecimal
 * characters, and every counter is a decimal string. The parsers check a message from the network before anything
 * reads it, and name the field that failed, never its value.
 */
import { CounterError, readCounter } from './counter';

/** A group's, a client's, an epoch's or a row's id. */
export const HEX_ID = /^[0-9a-f]{32}$/;

/** A mutation's name: a lower-case word of at most 32 characters. */
export const MUTATION_NAME = /^[a-z][a-z_]{0,31}$/;

/** Who last changed a row: a client and one of its mutation ids. A revision is never a time. */
export interface Revision {
  client: string;
  mutation: string;
}

/** One mutation as a client sends it; its id, name and arguments never change on a retry or a rebase. */
export interface MutationRecord {
  id: string;
  name: string;
  args: unknown;
}

/** A push: the client's group, the epoch it last read, its id and its mutations in id order. */
export interface PushRequest {
  group: string;
  epoch: string;
  clientId: string;
  mutations: MutationRecord[];
}

/** A pull: the client's group, epoch and id, and the cookie of its canonical state, or null for a full snapshot. */
export interface PullRequest {
  group: string;
  epoch: string;
  clientId: string;
  cookie: string | null;
}

/** One change of a pull: a readable row, a deleted one, or one the server cannot open. */
export type PatchEntry =
  | { op: 'put'; id: string; value: string; revision: Revision; version: string }
  | { op: 'del'; id: string; revision: Revision; version: string; deletedAt: string }
  | { op: 'unreadable'; id: string; revision: Revision; version: string };

/** What processing did with a mutation. */
export type Outcome = 'applied' | 'noop' | 'copied' | 'refused';

/**
 * Why a mutation was refused for good: its value too long, the rows full, its row deleted, its revision stale, or its
 * id taken by another value (a claim).
 */
export type Refusal = 'too_long' | 'full' | 'removed' | 'stale' | 'occupied';

/** The recorded result of one processed mutation: ids, an outcome and a version, never a value. */
export interface MutationResult {
  clientId: string;
  mutationId: string;
  outcome: Outcome;
  reason: Refusal | null;
  /** The row the effect landed on, or would have: the copy's id for a copy. */
  targetId: string;
  /**
   * The row's revision after it: the mutation's own for a write, the row's current one for a no-op (a dependent
   * mutation from the client targets this recorded result); null for a refusal, and for nothing else.
   */
  revision: Revision | null;
  /** The version of the transaction that processed it. */
  version: string;
}

/** A pull's answer, from one snapshot: the patch, the cookie, every client's last mutation id and this client's results. */
export interface PullResponse {
  kind: 'pull';
  group: string;
  epoch: string;
  cookie: string;
  /** True for a full snapshot, which replaces the client's canonical state. */
  full: boolean;
  lastMutationIds: Record<string, string>;
  patch: PatchEntry[];
  results: MutationResult[];
}

/** What a push is answered with. */
export type PushAnswer =
  | { kind: 'ok'; processed: number }
  | { kind: 'epoch_changed'; epoch: string }
  | { kind: 'group_gone' }
  | { kind: 'gap'; expected: string };

/** What a pull is answered with when no patch streams. */
export type PullRefusal = { kind: 'epoch_changed'; epoch: string } | { kind: 'group_gone' } | { kind: 'cookie_ahead' };

/** A message that is not the contract's shape; `field` says where, never what it held. */
export class WireError extends Error {
  constructor(readonly field: string) {
    super(`the sync message is malformed at ${field}`);
    this.name = 'WireError';
  }
}

function objectAt(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new WireError(field);
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[], field: string): void {
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new WireError(`${field}.${key}`);
}

/** A 32-hex id at `field`. */
export function hexIdAt(value: unknown, field: string): string {
  if (typeof value !== 'string' || !HEX_ID.test(value)) throw new WireError(field);
  return value;
}

/** A decimal counter at `field`, kept as its text. */
export function counterAt(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new WireError(field);
  try {
    readCounter(value);
  } catch (error) {
    if (error instanceof CounterError) throw new WireError(field);
    throw error;
  }
  return value;
}

/** A revision at `field`. */
export function revisionAt(value: unknown, field: string): Revision {
  const record = objectAt(value, field);
  onlyKeys(record, ['client', 'mutation'], field);
  return { client: hexIdAt(record.client, `${field}.client`), mutation: counterAt(record.mutation, `${field}.mutation`) };
}

function textAt(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new WireError(field);
  return value;
}

/** Reads a push: ids strictly rising from 1, at most `maxMutations`; `parseArgs` checks each mutation's arguments. */
export function parsePushRequest(value: unknown, maxMutations: number, parseArgs: (name: string, args: unknown, field: string) => unknown): PushRequest {
  const record = objectAt(value, 'push');
  onlyKeys(record, ['group', 'epoch', 'clientId', 'mutations'], 'push');
  const list = record.mutations;
  if (!Array.isArray(list) || list.length === 0 || list.length > maxMutations) throw new WireError('push.mutations');
  let previous = 0;
  const mutations = list.map((item, index): MutationRecord => {
    const field = `push.mutations.${index}`;
    const each = objectAt(item, field);
    onlyKeys(each, ['id', 'name', 'args'], field);
    const id = counterAt(each.id, `${field}.id`);
    const number = readCounter(id);
    if (number < 1 || number <= previous) throw new WireError(`${field}.id`);
    previous = number;
    if (typeof each.name !== 'string' || !MUTATION_NAME.test(each.name)) throw new WireError(`${field}.name`);
    return { id, name: each.name, args: parseArgs(each.name, each.args, `${field}.args`) };
  });
  return {
    group: hexIdAt(record.group, 'push.group'),
    epoch: hexIdAt(record.epoch, 'push.epoch'),
    clientId: hexIdAt(record.clientId, 'push.clientId'),
    mutations,
  };
}

/** Reads a pull. */
export function parsePullRequest(value: unknown): PullRequest {
  const record = objectAt(value, 'pull');
  onlyKeys(record, ['group', 'epoch', 'clientId', 'cookie'], 'pull');
  return {
    group: hexIdAt(record.group, 'pull.group'),
    epoch: hexIdAt(record.epoch, 'pull.epoch'),
    clientId: hexIdAt(record.clientId, 'pull.clientId'),
    cookie: record.cookie === null ? null : counterAt(record.cookie, 'pull.cookie'),
  };
}

const OUTCOMES: readonly Outcome[] = ['applied', 'noop', 'copied', 'refused'];
const REFUSALS: readonly Refusal[] = ['too_long', 'full', 'removed', 'stale', 'occupied'];

function patchEntryAt(value: unknown, field: string): PatchEntry {
  const record = objectAt(value, field);
  const id = hexIdAt(record.id, `${field}.id`);
  const revision = revisionAt(record.revision, `${field}.revision`);
  const version = counterAt(record.version, `${field}.version`);
  if (record.op === 'put') {
    onlyKeys(record, ['op', 'id', 'value', 'revision', 'version'], field);
    return { op: 'put', id, value: textAt(record.value, `${field}.value`), revision, version };
  }
  if (record.op === 'del') {
    onlyKeys(record, ['op', 'id', 'revision', 'version', 'deletedAt'], field);
    return { op: 'del', id, revision, version, deletedAt: textAt(record.deletedAt, `${field}.deletedAt`) };
  }
  if (record.op === 'unreadable') {
    onlyKeys(record, ['op', 'id', 'revision', 'version'], field);
    return { op: 'unreadable', id, revision, version };
  }
  throw new WireError(`${field}.op`);
}

function resultAt(value: unknown, field: string): MutationResult {
  const record = objectAt(value, field);
  onlyKeys(record, ['clientId', 'mutationId', 'outcome', 'reason', 'targetId', 'revision', 'version'], field);
  if (!OUTCOMES.includes(record.outcome as Outcome)) throw new WireError(`${field}.outcome`);
  if (record.reason !== null && !REFUSALS.includes(record.reason as Refusal)) throw new WireError(`${field}.reason`);
  if ((record.outcome === 'refused') !== (record.reason !== null)) throw new WireError(`${field}.reason`);
  if ((record.outcome === 'refused') !== (record.revision === null)) throw new WireError(`${field}.revision`);
  return {
    clientId: hexIdAt(record.clientId, `${field}.clientId`),
    mutationId: counterAt(record.mutationId, `${field}.mutationId`),
    outcome: record.outcome as Outcome,
    reason: record.reason as Refusal | null,
    targetId: hexIdAt(record.targetId, `${field}.targetId`),
    revision: record.revision === null ? null : revisionAt(record.revision, `${field}.revision`),
    version: counterAt(record.version, `${field}.version`),
  };
}

/** Reads a pull's answer; every patch entry names a row once. */
export function parsePullResponse(value: unknown): PullResponse {
  const record = objectAt(value, 'answer');
  onlyKeys(record, ['kind', 'group', 'epoch', 'cookie', 'full', 'lastMutationIds', 'patch', 'results'], 'answer');
  if (record.kind !== 'pull') throw new WireError('answer.kind');
  if (typeof record.full !== 'boolean') throw new WireError('answer.full');
  if (!Array.isArray(record.patch)) throw new WireError('answer.patch');
  if (!Array.isArray(record.results)) throw new WireError('answer.results');
  const lastMutationIds: Record<string, string> = {};
  for (const [client, last] of Object.entries(objectAt(record.lastMutationIds, 'answer.lastMutationIds'))) {
    lastMutationIds[hexIdAt(client, 'answer.lastMutationIds')] = counterAt(last, 'answer.lastMutationIds');
  }
  const patch = record.patch.map((entry, index) => patchEntryAt(entry, `answer.patch.${index}`));
  const seen = new Set<string>();
  for (const entry of patch) {
    if (seen.has(entry.id)) throw new WireError('answer.patch');
    seen.add(entry.id);
  }
  return {
    kind: 'pull',
    group: hexIdAt(record.group, 'answer.group'),
    epoch: hexIdAt(record.epoch, 'answer.epoch'),
    cookie: counterAt(record.cookie, 'answer.cookie'),
    full: record.full,
    lastMutationIds,
    patch,
    results: record.results.map((result, index) => resultAt(result, `answer.results.${index}`)),
  };
}

/** Reads a push's answer. */
export function parsePushAnswer(value: unknown): PushAnswer {
  const record = objectAt(value, 'answer');
  switch (record.kind) {
    case 'ok':
      onlyKeys(record, ['kind', 'processed'], 'answer');
      if (typeof record.processed !== 'number' || !Number.isSafeInteger(record.processed) || record.processed < 0) throw new WireError('answer.processed');
      return { kind: 'ok', processed: record.processed };
    case 'epoch_changed':
      onlyKeys(record, ['kind', 'epoch'], 'answer');
      return { kind: 'epoch_changed', epoch: hexIdAt(record.epoch, 'answer.epoch') };
    case 'group_gone':
      onlyKeys(record, ['kind'], 'answer');
      return { kind: 'group_gone' };
    case 'gap':
      onlyKeys(record, ['kind', 'expected'], 'answer');
      return { kind: 'gap', expected: counterAt(record.expected, 'answer.expected') };
    default:
      throw new WireError('answer.kind');
  }
}

/** Reads a pull's refusal. */
export function parsePullRefusal(value: unknown): PullRefusal {
  const record = objectAt(value, 'answer');
  switch (record.kind) {
    case 'epoch_changed':
      onlyKeys(record, ['kind', 'epoch'], 'answer');
      return { kind: 'epoch_changed', epoch: hexIdAt(record.epoch, 'answer.epoch') };
    case 'group_gone':
      onlyKeys(record, ['kind'], 'answer');
      return { kind: 'group_gone' };
    case 'cookie_ahead':
      onlyKeys(record, ['kind'], 'answer');
      return { kind: 'cookie_ahead' };
    default:
      throw new WireError('answer.kind');
  }
}
