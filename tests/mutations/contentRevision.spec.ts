import { describe, expect, it } from 'vitest';
import {
  applyRowMutation,
  copyIdOf,
  incomingValue,
  planRowChanges,
  type MutationContext,
  type PlannedRow,
  type Row,
  type RowComposer,
  type RowEffect,
  type RowMutation,
  type RowPolicy,
  type RowView,
} from '../../src/features/sync/mutations/rows';
import type { Outcome, Refusal, Revision } from '../../src/features/sync/mutations/wire';

const hex = (n: number): string => n.toString(16).padStart(32, '0');
const A = hex(0xa);
const B = hex(0xb);
const C = hex(0xc);
const GROUP = hex(0x9);
const rev = (client: string, mutation: number): Revision => ({ client, mutation: String(mutation) });
const at = (client: string, mutation: number): MutationContext => ({ group: GROUP, clientId: client, mutationId: String(mutation) });
const delta = (add: string[], remove: string[] = []): string => JSON.stringify({ add, remove });

/** A value "content|tag,tag": its content precedes the bar; a delta removes tags, then adds the new ones in order. */
const composer: RowComposer = {
  contentOf: (value) => value.split('|')[0] ?? '',
  compose: (current, content, change) => {
    const [base = '', list = ''] = current.split('|');
    let tags = list === '' ? [] : list.split(',');
    if (change !== null) {
      const { add, remove } = JSON.parse(change) as { add: string[]; remove: string[] };
      tags = tags.filter((tag) => !remove.includes(tag));
      for (const tag of add) if (!tags.includes(tag)) tags.push(tag);
    }
    return `${content ?? base}|${tags.join(',')}`;
  },
  deltaOf: (before, after) => {
    const was = (before.split('|')[1] ?? '').split(',').filter((tag) => tag !== '');
    const now = (after.split('|')[1] ?? '').split(',').filter((tag) => tag !== '');
    const add = now.filter((tag) => !was.includes(tag));
    const remove = was.filter((tag) => !now.includes(tag));
    return add.length === 0 && remove.length === 0 ? null : delta(add, remove);
  },
  sameClaim: (current, incoming) => current === incoming,
};

const POLICY: RowPolicy = {
  maxRows: 5,
  maxUnits: 40,
  copyValue: (value) => {
    const [text = '', tags = ''] = value.split('|');
    return `${text} (copy)|${tags}`;
  },
  composer,
};

/** Rows and recorded results, and `apply`, which runs a mutation and writes its effect and result as the server does. */
function world(initial: Row[], policy: RowPolicy = POLICY) {
  const rows = new Map(initial.map((row) => [row.id, row]));
  const results = new Map<string, { outcome: Outcome; reason: Refusal | null; targetId: string; revision: Revision | null; contentRevision: Revision | null }>();
  const view: RowView = {
    row: async (id) => rows.get(id) ?? null,
    liveCount: async () => [...rows.values()].filter((row) => row.state !== 'tombstone').length,
    result: async (client, mutation) => results.get(`${client}:${mutation}`) ?? null,
  };
  return {
    rows,
    async apply(context: MutationContext, mutation: RowMutation): Promise<RowEffect> {
      const effect = await applyRowMutation(view, policy, context, mutation);
      const revision = { client: context.clientId, mutation: context.mutationId };
      if (effect.write !== null) {
        const prior = rows.get(effect.write.id);
        rows.set(effect.write.id, {
          id: effect.write.id,
          state: effect.write.state,
          value: effect.write.value,
          revision,
          contentRevision: effect.write.contentChanged || prior === undefined ? revision : (prior.contentRevision ?? prior.revision),
        });
      }
      const target = rows.get(effect.targetId);
      results.set(`${context.clientId}:${context.mutationId}`, {
        outcome: effect.outcome,
        reason: effect.reason,
        targetId: effect.targetId,
        revision: effect.revision,
        contentRevision: effect.outcome === 'refused' ? null : (target?.contentRevision ?? target?.revision ?? null),
      });
      return effect;
    },
  };
}

const base = (value = 'text|'): Row[] => [{ id: hex(1), state: 'live', value, revision: rev(B, 1), contentRevision: rev(B, 1) }];
const tagsOnly = (add: string[], remove: string[] = [], expected = rev(B, 1)): RowMutation => ({ name: 'amend', args: { id: hex(1), expected, expectedContent: expected, content: null, delta: delta(add, remove) } });
const content = (text: string, expected = rev(B, 1), expectedContent = expected, change: string | null = null): RowMutation => ({ name: 'amend', args: { id: hex(1), expected, expectedContent, content: text, delta: change } });

describe('the content revision', () => {
  it('lands a tags-only change and a content change from one base in either order, with no copy', async () => {
    const one = world(base());
    expect((await one.apply(at(A, 1), tagsOnly(['budget']))).write).toMatchObject({ value: 'text|budget', contentChanged: false });
    expect((await one.apply(at(C, 1), content('new text'))).write).toMatchObject({ value: 'new text|budget', contentChanged: true });
    const two = world(base());
    await two.apply(at(C, 1), content('new text'));
    expect((await two.apply(at(A, 1), tagsOnly(['budget']))).write).toMatchObject({ value: 'new text|budget', contentChanged: false });
    expect(one.rows.get(hex(1))).toMatchObject({ value: 'new text|budget', contentRevision: rev(C, 1) });
    expect(two.rows.get(hex(1))).toMatchObject({ value: 'new text|budget', contentRevision: rev(C, 1) });
  });

  it('removes tags before adding, applies two tags-only changes in their order, and takes a change to nothing as a no-op', async () => {
    const one = world(base('text|a,b'));
    expect((await one.apply(at(A, 1), tagsOnly(['c'], ['a']))).write?.value).toBe('text|b,c');
    expect((await one.apply(at(C, 1), tagsOnly(['a'], ['c']))).write?.value).toBe('text|b,a');
    expect(await one.apply(at(C, 2), tagsOnly(['b']))).toMatchObject({ outcome: 'noop', write: null });
  });

  it('keeps a different content made against an older content revision as one copy with the current tags and its delta', async () => {
    const one = world(base());
    await one.apply(at(C, 1), content('theirs', rev(B, 1), rev(B, 1), delta(['x'])));
    const effect = await one.apply(at(A, 1), content('mine', rev(B, 1), rev(B, 1), delta(['y'])));
    expect(effect).toMatchObject({ outcome: 'copied', targetId: await copyIdOf(at(A, 1)), write: { value: 'mine (copy)|x,y', contentChanged: true } });
    expect(one.rows.get(hex(1))!.value).toBe('theirs|x');
  });

  it('needs no copy for an identical content, and still applies its delta', async () => {
    const one = world(base());
    await one.apply(at(C, 1), content('same'));
    expect(await one.apply(at(A, 1), content('same', rev(B, 1), rev(B, 1), delta(['z'])))).toMatchObject({ outcome: 'applied', write: { value: 'same|z', contentChanged: false } });
  });

  it('refuses a missing or deleted target, and a delete made before an unseen tags-only change', async () => {
    const one = world(base());
    expect(await one.apply(at(A, 1), { name: 'amend', args: { id: hex(9), expected: rev(B, 1), expectedContent: rev(B, 1), content: null, delta: delta(['a']) } })).toMatchObject({ outcome: 'refused', reason: 'removed' });
    await one.apply(at(A, 2), tagsOnly(['budget']));
    expect(await one.apply(at(C, 1), { name: 'delete', args: { id: hex(1), expected: rev(B, 1) } })).toMatchObject({ outcome: 'refused', reason: 'stale' });
    await one.apply(at(C, 2), { name: 'delete', args: { id: hex(1), expected: rev(A, 2) } });
    expect(await one.apply(at(A, 3), tagsOnly(['late'], [], rev(A, 2)))).toMatchObject({ outcome: 'refused', reason: 'removed' });
  });

  it('resolves a dependent change to the target and content revision its earlier change left', async () => {
    const one = world(base());
    await one.apply(at(A, 1), tagsOnly(['budget']));
    expect(await one.apply(at(A, 2), content('edited', rev(A, 1), rev(A, 1)))).toMatchObject({ outcome: 'applied', write: { value: 'edited|budget' } });
    const two = world(base());
    await two.apply(at(C, 1), content('theirs'));
    await two.apply(at(A, 1), content('mine'));
    const copy = await copyIdOf(at(A, 1));
    expect(await two.apply(at(A, 2), tagsOnly(['later'], [], rev(A, 1)))).toMatchObject({ outcome: 'applied', targetId: copy, write: { id: copy, value: 'mine (copy)|later' } });
    expect(await two.apply(at(A, 3), tagsOnly(['last'], [], rev(A, 2)))).toMatchObject({ outcome: 'applied', targetId: copy, write: { id: copy, value: 'mine (copy)|later,last' } });
    expect(await two.apply(at(A, 4), tagsOnly(['last'], [], rev(A, 3)))).toMatchObject({ outcome: 'noop', targetId: copy });
    expect(await two.apply(at(A, 5), tagsOnly(['end'], [], rev(A, 4)))).toMatchObject({ outcome: 'applied', targetId: copy, write: { value: 'mine (copy)|later,last,end' } });
    expect(two.rows.get(hex(1))!.value).toBe('theirs|');
  });

  it('creates a claimed id once, takes the same value as a no-op, and refuses an occupied id or a tombstone without a copy', async () => {
    const one = world([]);
    const claim = (value: string): RowMutation => ({ name: 'claim', args: { id: hex(5), value } });
    expect(await one.apply(at(A, 1), claim('copy|a'))).toMatchObject({ outcome: 'applied', write: { id: hex(5), contentChanged: true } });
    expect(await one.apply(at(C, 1), claim('copy|a'))).toMatchObject({ outcome: 'noop', write: null });
    expect(await one.apply(at(C, 2), claim('copy|b'))).toMatchObject({ outcome: 'refused', reason: 'occupied', write: null });
    expect(await one.apply(at(C, 3), { name: 'amend', args: { id: hex(5), expected: rev(C, 2), expectedContent: rev(C, 2), content: null, delta: delta(['q']) } })).toMatchObject({ outcome: 'refused', reason: 'occupied' });
    await one.apply(at(A, 2), { name: 'delete', args: { id: hex(5), expected: rev(A, 1) } });
    expect(await one.apply(at(C, 4), claim('copy|a'))).toMatchObject({ outcome: 'refused', reason: 'occupied' });
  });

  it('plans a tags-only change, a content change, a claim, and an edit without a composer; and names a refused amend\'s value', () => {
    const before: PlannedRow[] = [{ id: hex(1), value: 'text|a', revision: rev(B, 2), contentRevision: rev(B, 1), local: false }];
    expect(planRowChanges(before, [{ id: hex(1), value: 'text|a,b' }], composer)).toEqual([{ name: 'amend', args: { id: hex(1), expected: rev(B, 2), expectedContent: rev(B, 1), content: null, delta: delta(['b']) } }]);
    expect(planRowChanges(before, [{ id: hex(1), value: 'other|a' }], composer)).toEqual([{ name: 'amend', args: { id: hex(1), expected: rev(B, 2), expectedContent: rev(B, 1), content: 'other', delta: null } }]);
    expect(planRowChanges(before, [{ id: hex(1), value: 'text|a' }, { id: hex(6), value: 'copy|', claim: true }], composer)).toEqual([{ name: 'claim', args: { id: hex(6), value: 'copy|' } }]);
    expect(planRowChanges(before, [{ id: hex(1), value: 'text|a,b' }])).toEqual([{ name: 'edit', args: { id: hex(1), expected: rev(B, 2), value: 'text|a,b' } }]);
    const held: Row = { id: hex(1), state: 'live', value: 'text|a', revision: rev(B, 2), contentRevision: rev(B, 1) };
    expect(incomingValue(POLICY, content('x', rev(B, 2), rev(B, 1), delta(['q'])), held)).toBe('x|a,q');
    expect(incomingValue(POLICY, { name: 'delete', args: { id: hex(1), expected: rev(B, 2) } }, held)).toBeNull();
    expect(() => incomingValue(POLICY, tagsOnly(['budget']), { ...held, state: 'tombstone', value: null })).toThrow('amend recovery requires its local base');
  });

  it('refuses an amend under a policy with no composer, and keeps a row without a content revision on its revision', async () => {
    const { composer: _none, ...plain } = POLICY;
    const one = world([{ id: hex(1), state: 'live', value: 'text|', revision: rev(B, 1) }], plain);
    expect(await one.apply(at(A, 1), tagsOnly(['a']))).toMatchObject({ outcome: 'refused', reason: 'stale' });
    expect(await one.apply(at(A, 2), { name: 'edit', args: { id: hex(1), expected: rev(B, 1), value: 'new|' } })).toMatchObject({ outcome: 'applied', write: { contentChanged: true } });
  });

  it('records a no-op whole revision for dependents and still refuses a delete after an unseen change', async () => {
    const claim: RowMutation = { name: 'claim', args: { id: hex(1), value: 'text|' } };
    const remove: RowMutation = { name: 'delete', args: { id: hex(1), expected: rev(A, 1) } };
    const one = world(base());
    expect(await one.apply(at(A, 1), claim)).toMatchObject({ outcome: 'noop', revision: rev(B, 1), write: null });
    expect(await one.apply(at(A, 2), remove)).toMatchObject({ outcome: 'applied', revision: rev(A, 2), write: { state: 'tombstone' } });
    const two = world(base());
    await two.apply(at(A, 1), claim);
    await two.apply(at(C, 1), tagsOnly(['new']));
    expect(await two.apply(at(A, 2), remove)).toMatchObject({ outcome: 'refused', reason: 'stale', revision: null });
    const three = world(base());
    await three.apply(at(A, 1), claim);
    expect(await three.apply(at(A, 2), { name: 'edit', args: { id: hex(1), expected: rev(A, 1), value: 'new|' } })).toMatchObject({ outcome: 'applied', targetId: hex(1), revision: rev(A, 2) });
  });
});
