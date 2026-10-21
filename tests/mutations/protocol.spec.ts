import { describe, expect, it } from 'vitest';
import { CounterError, nextCounter, readCounter, writeCounter } from '../../src/features/sync/mutations/counter';
import {
  applyRowMutation,
  copyIdOf,
  DuplicateRowId,
  parseRowArgs,
  planRowChanges,
  type MutationContext,
  type Row,
  type RowPolicy,
  type RowView,
} from '../../src/features/sync/mutations/rows';
import { parsePullResponse, parsePushRequest, WireError, type Outcome, type Revision } from '../../src/features/sync/mutations/wire';

/** A 32-hex id from a small number, so a test reads its ids. */
export const hex = (n: number): string => n.toString(16).padStart(32, '0');

const GROUP = hex(0xa);
const A = hex(0xa1);
const B = hex(0xb1);
const POLICY: RowPolicy = { maxRows: 3, maxUnits: 20, copyValue: (value) => `${value} (copy)` };
const rev = (client: string, mutation: number): Revision => ({ client, mutation: String(mutation) });
const at = (clientId: string, mutation: number): MutationContext => ({ group: GROUP, clientId, mutationId: String(mutation) });

function view(rows: Row[], results: Record<string, { outcome: Outcome; targetId: string; revision: Revision | null }> = {}): RowView {
  const map = new Map(rows.map((row) => [row.id, row]));
  return {
    row: async (id) => map.get(id) ?? null,
    liveCount: async () => [...map.values()].filter((row) => row.state !== 'tombstone').length,
    result: async (client, mutation) => results[`${client}:${mutation}`] ?? null,
  };
}

const live = (id: number, value: string, revision: Revision): Row => ({ id: hex(id), state: 'live', value, revision });

describe('counters', () => {
  it('read decimal text and numbers of safe non-negative integers, and nothing else', () => {
    expect(readCounter('0')).toBe(0);
    expect(readCounter('42')).toBe(42);
    expect(readCounter(7)).toBe(7);
    expect(readCounter(9007199254740991n)).toBe(9007199254740991);
    for (const bad of ['01', '-1', '1.5', '', ' 1', '9007199254740992', 1.5, -1, null]) expect(() => readCounter(bad)).toThrow(CounterError);
    expect(writeCounter(12)).toBe('12');
    expect(nextCounter(1)).toBe(2);
    expect(() => nextCounter(Number.MAX_SAFE_INTEGER)).toThrow(CounterError);
  });
});

describe('the wire contract', () => {
  const push = { group: GROUP, epoch: hex(0xe), clientId: A, mutations: [{ id: '1', name: 'create', args: { id: hex(1), value: 'x' } }, { id: '2', name: 'delete', args: { id: hex(1), expected: rev(A, 1) } }] };

  it('reads a push whose ids rise from 1, its arguments checked by the row mutators', () => {
    expect(parsePushRequest(push, 50, parseRowArgs).mutations.map((m) => m.id)).toEqual(['1', '2']);
  });

  it('refuses a push with a stray key, a bad id, ids that do not rise, too many mutations, an unknown name or bad arguments', () => {
    const refuse = (value: unknown, max = 50) => expect(() => parsePushRequest(value, max, parseRowArgs)).toThrow(WireError);
    refuse({ ...push, extra: 1 });
    refuse({ ...push, group: 'G' });
    refuse({ ...push, mutations: [push.mutations[1], push.mutations[0]] });
    refuse({ ...push, mutations: [{ ...push.mutations[0], id: '0' }] });
    refuse(push, 1);
    refuse({ ...push, mutations: [{ ...push.mutations[0], name: 'drop' }] });
    refuse({ ...push, mutations: [{ ...push.mutations[0], args: { id: hex(1), value: 3 } }] });
    refuse({ ...push, mutations: [] });
  });

  it('refuses a pull answer that names a row twice or a refusal with no reason', () => {
    const answer = { kind: 'pull', group: GROUP, epoch: hex(0xe), cookie: '3', full: false, lastMutationIds: { [A]: '2' }, patch: [{ op: 'put', id: hex(1), value: 'x', revision: rev(A, 1), version: '3' }], results: [] };
    expect(parsePullResponse(answer).cookie).toBe('3');
    expect(() => parsePullResponse({ ...answer, patch: [answer.patch[0], answer.patch[0]] })).toThrow(WireError);
    expect(() => parsePullResponse({ ...answer, results: [{ clientId: A, mutationId: '1', outcome: 'refused', reason: null, targetId: hex(1), revision: null, version: '3' }] })).toThrow(WireError);
  });
});

describe('the row mutators', () => {
  it('create: an unused id is written, the same value is a no-op, a different one a copy, a deleted id refused, a long one refused', async () => {
    const rows = [live(1, 'one', rev(B, 1)), { id: hex(2), state: 'tombstone' as const, value: null, revision: rev(B, 2) }];
    expect(await applyRowMutation(view(rows), POLICY, at(A, 1), { name: 'create', args: { id: hex(3), value: 'new' } })).toMatchObject({ outcome: 'applied', targetId: hex(3), revision: rev(A, 1), write: { id: hex(3), state: 'live', value: 'new' } });
    expect(await applyRowMutation(view(rows), POLICY, at(A, 1), { name: 'create', args: { id: hex(1), value: 'one' } })).toMatchObject({ outcome: 'noop', revision: rev(B, 1), write: null });
    const copied = await applyRowMutation(view(rows), POLICY, at(A, 1), { name: 'create', args: { id: hex(1), value: 'mine' } });
    expect(copied).toMatchObject({ outcome: 'copied', targetId: await copyIdOf(at(A, 1)), write: { value: 'mine (copy)' } });
    expect(await applyRowMutation(view(rows), POLICY, at(A, 1), { name: 'create', args: { id: hex(2), value: 'back' } })).toMatchObject({ outcome: 'refused', reason: 'removed' });
    expect(await applyRowMutation(view(rows), POLICY, at(A, 1), { name: 'create', args: { id: hex(3), value: 'x'.repeat(21) } })).toMatchObject({ outcome: 'refused', reason: 'too_long' });
  });

  it('derives the same copy id from the same group, client and mutation, and another from another mutation', async () => {
    expect(await copyIdOf(at(A, 5))).toBe(await copyIdOf(at(A, 5)));
    expect(await copyIdOf(at(A, 5))).not.toBe(await copyIdOf(at(A, 6)));
    expect(await copyIdOf(at(A, 5))).toMatch(/^[0-9a-f]{32}$/);
  });

  it('edit: the expected revision replaces, another revision copies a different value and skips the same one, a missing or deleted row is refused', async () => {
    const rows = [live(1, 'one', rev(B, 1)), { id: hex(2), state: 'tombstone' as const, value: null, revision: rev(B, 2) }];
    expect(await applyRowMutation(view(rows), POLICY, at(A, 1), { name: 'edit', args: { id: hex(1), expected: rev(B, 1), value: 'two' } })).toMatchObject({ outcome: 'applied', write: { value: 'two' } });
    expect(await applyRowMutation(view(rows), POLICY, at(A, 1), { name: 'edit', args: { id: hex(1), expected: rev(A, 9), value: 'two' } })).toMatchObject({ outcome: 'copied', write: { value: 'two (copy)' } });
    expect(await applyRowMutation(view(rows), POLICY, at(A, 1), { name: 'edit', args: { id: hex(1), expected: rev(A, 9), value: 'one' } })).toMatchObject({ outcome: 'noop' });
    expect(await applyRowMutation(view(rows), POLICY, at(A, 1), { name: 'edit', args: { id: hex(9), expected: rev(B, 1), value: 'x' } })).toMatchObject({ outcome: 'refused', reason: 'removed' });
    expect(await applyRowMutation(view(rows), POLICY, at(A, 1), { name: 'edit', args: { id: hex(2), expected: rev(B, 2), value: 'x' } })).toMatchObject({ outcome: 'refused', reason: 'removed' });
  });

  it('follows a dependent edit to the copy its earlier mutation made', async () => {
    const copyId = await copyIdOf(at(A, 1));
    const rows = [live(1, 'theirs', rev(B, 1)), { id: copyId, state: 'live' as const, value: 'mine (copy)', revision: rev(A, 1) }];
    const results = { [`${A}:1`]: { outcome: 'copied' as const, targetId: copyId, revision: rev(A, 1) } };
    expect(await applyRowMutation(view(rows, results), POLICY, at(A, 2), { name: 'edit', args: { id: hex(1), expected: rev(A, 1), value: 'mine, later' } })).toMatchObject({ outcome: 'applied', targetId: copyId, write: { id: copyId, value: 'mine, later (copy)' } });
  });

  it("follows a dependent delete or edit to the revision its earlier no-op recorded, so a same-text create followed by a delete removes the row", async () => {
    // A holds the row at (B, 1); client A's mutation 1 created the same text under the same id and was a no-op
    const rows = [live(1, 'v', rev(B, 1))];
    const results = { [`${A}:1`]: { outcome: 'noop' as const, targetId: hex(1), revision: rev(B, 1) } };
    expect(await applyRowMutation(view(rows, results), POLICY, at(A, 2), { name: 'delete', args: { id: hex(1), expected: rev(A, 1) } })).toMatchObject({ outcome: 'applied', acceptedDelete: true, write: { id: hex(1), state: 'tombstone' } });
    expect(await applyRowMutation(view(rows, results), POLICY, at(A, 2), { name: 'edit', args: { id: hex(1), expected: rev(A, 1), value: 'w' } })).toMatchObject({ outcome: 'applied', targetId: hex(1), write: { id: hex(1), value: 'w' } });
    // a row changed since the no-op is compared against its own revision, as the server's order requires
    const changed = [live(1, 'theirs', rev(B, 7))];
    expect(await applyRowMutation(view(changed, results), POLICY, at(A, 2), { name: 'delete', args: { id: hex(1), expected: rev(A, 1) } })).toMatchObject({ outcome: 'refused', reason: 'stale' });
    expect(await applyRowMutation(view(changed, results), POLICY, at(A, 2), { name: 'edit', args: { id: hex(1), expected: rev(A, 1), value: 'w' } })).toMatchObject({ outcome: 'copied', write: { value: 'w (copy)' } });
    // without a recorded result the mutation is compared as it was sent
    expect(await applyRowMutation(view(rows), POLICY, at(A, 2), { name: 'delete', args: { id: hex(1), expected: rev(A, 1) } })).toMatchObject({ outcome: 'refused', reason: 'stale' });
  });

  it('delete: the expected revision leaves a tombstone, a missing or deleted row is a delete accepted, another revision is refused as stale', async () => {
    const rows = [live(1, 'one', rev(B, 1)), { id: hex(2), state: 'tombstone' as const, value: null, revision: rev(B, 2) }];
    expect(await applyRowMutation(view(rows), POLICY, at(A, 1), { name: 'delete', args: { id: hex(1), expected: rev(B, 1) } })).toMatchObject({ outcome: 'applied', acceptedDelete: true, write: { state: 'tombstone', value: null } });
    expect(await applyRowMutation(view(rows), POLICY, at(A, 1), { name: 'delete', args: { id: hex(9), expected: rev(B, 1) } })).toMatchObject({ outcome: 'applied', acceptedDelete: true, write: { id: hex(9), state: 'tombstone' } });
    expect(await applyRowMutation(view(rows), POLICY, at(A, 1), { name: 'delete', args: { id: hex(2), expected: rev(A, 3) } })).toMatchObject({ outcome: 'noop', acceptedDelete: true });
    expect(await applyRowMutation(view(rows), POLICY, at(A, 1), { name: 'delete', args: { id: hex(1), expected: rev(A, 3) } })).toMatchObject({ outcome: 'refused', reason: 'stale', acceptedDelete: false });
  });

  it('repair replaces an unreadable row at its exact revision and nothing else', async () => {
    const rows: Row[] = [{ id: hex(1), state: 'unreadable', value: null, revision: rev(B, 4) }, live(2, 'two', rev(B, 2))];
    expect(await applyRowMutation(view(rows), POLICY, at(A, 1), { name: 'repair', args: { id: hex(1), expected: rev(B, 4), value: 'healthy' } })).toMatchObject({ outcome: 'applied', write: { state: 'live', value: 'healthy' } });
    expect(await applyRowMutation(view(rows), POLICY, at(A, 1), { name: 'repair', args: { id: hex(1), expected: rev(B, 5), value: 'healthy' } })).toMatchObject({ outcome: 'refused', reason: 'stale' });
    expect(await applyRowMutation(view(rows), POLICY, at(A, 1), { name: 'repair', args: { id: hex(2), expected: rev(B, 2), value: 'x' } })).toMatchObject({ outcome: 'refused', reason: 'stale' });
  });

  it('counts unreadable rows and copies toward the limit', async () => {
    const rows: Row[] = [live(1, 'one', rev(B, 1)), live(2, 'two', rev(B, 2)), { id: hex(3), state: 'unreadable', value: null, revision: rev(B, 3) }];
    expect(await applyRowMutation(view(rows), POLICY, at(A, 1), { name: 'create', args: { id: hex(4), value: 'four' } })).toMatchObject({ outcome: 'refused', reason: 'full' });
    expect(await applyRowMutation(view(rows), POLICY, at(A, 1), { name: 'edit', args: { id: hex(1), expected: rev(A, 7), value: 'other' } })).toMatchObject({ outcome: 'refused', reason: 'full' });
  });
});

describe('the save planner', () => {
  it('creates new and local rows, edits changed ones at their revision, deletes the ones gone, and leaves the rest', () => {
    const before = [
      { id: hex(1), value: 'same', revision: rev(A, 1), local: false },
      { id: hex(2), value: 'old', revision: rev(A, 2), local: false },
      { id: hex(3), value: 'gone', revision: rev(B, 3), local: false },
      { id: hex(4), value: 'long', revision: null, local: true },
      { id: hex(5), value: 'local gone', revision: null, local: true },
    ];
    const after = [
      { id: hex(1), value: 'same' },
      { id: hex(2), value: 'new' },
      { id: hex(4), value: 'short' },
      { id: hex(6), value: 'brand new' },
    ];
    expect(planRowChanges(before, after)).toEqual([
      { name: 'edit', args: { id: hex(2), expected: rev(A, 2), value: 'new' } },
      { name: 'create', args: { id: hex(4), value: 'short' } },
      { name: 'create', args: { id: hex(6), value: 'brand new' } },
      { name: 'delete', args: { id: hex(3), expected: rev(B, 3) } },
    ]);
    expect(() => planRowChanges(before, [after[0], after[0]])).toThrow(DuplicateRowId);
  });
});
