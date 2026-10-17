import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MutationServer, type MutationServerStore, type ValueCodec } from '../../src/features/sync/mutations/server';
import { backends } from './backends';
import { A, B, hex, pulled, pushOf, testCodec, world, type World } from './harness';

const BACKENDS = await backends();

describe.each(BACKENDS.map((backend) => [backend.name, backend] as const))('the server push on %s', (_name, backend) => {
  let w: World;

  beforeEach(async () => {
    w = await world(backend);
  });

  afterEach(async () => {
    await w.close();
  });

  it('commits effects, results, the last id and the version together, and a repeated push applies nothing twice', async () => {
    const request = pushOf(w, A, [
      { name: 'create', args: { id: hex(1), value: 'one' } },
      { name: 'create', args: { id: hex(2), value: 'two' } },
    ]);
    expect(await w.server.push(w.context(), request)).toEqual({ kind: 'ok', processed: 2 });
    // the answer was lost: the client sends the same mutations again
    expect(await w.server.push(w.context(), request)).toEqual({ kind: 'ok', processed: 0 });
    const answer = await pulled(w, A);
    expect(answer).toMatchObject({ cookie: '1', full: true, lastMutationIds: { [A]: '2' } });
    expect(answer.patch.map((entry) => [entry.op, entry.id, entry.version])).toEqual([['put', hex(1), '1'], ['put', hex(2), '1']]);
    expect(answer.results.map((result) => [result.mutationId, result.outcome])).toEqual([['1', 'applied'], ['2', 'applied']]);
  });

  it('aborts a batch past the next expected id with nothing written', async () => {
    expect(await w.server.push(w.context(), pushOf(w, A, [{ name: 'create', args: { id: hex(1), value: 'one' } }], 2))).toEqual({ kind: 'gap', expected: '1' });
    const answer = await pulled(w, A);
    expect(answer.cookie).toBe('0');
    expect(answer.patch).toEqual([]);
    expect(answer.lastMutationIds).toEqual({ [A]: '0' });
  });

  it('hands the hook the accepted deletes alone, rolls back whole when it throws, and takes the batch again after the deletion is replayed', async () => {
    await w.server.push(w.context(), pushOf(w, B, [
      { name: 'create', args: { id: hex(1), value: 'one' } },
      { name: 'create', args: { id: hex(2), value: 'two' } },
      { name: 'edit', args: { id: hex(2), expected: { client: B, mutation: '2' }, value: 'two, edited' } },
    ]));
    const fenced: string[][] = [];
    const batch = pushOf(w, A, [
      { name: 'delete', args: { id: hex(1), expected: { client: B, mutation: '1' } } },
      { name: 'delete', args: { id: hex(2), expected: { client: B, mutation: '2' } } },
      { name: 'create', args: { id: hex(3), value: 'three' } },
    ]);
    await expect(
      w.server.push(w.context(), batch, {
        beforeWrite: async (_trx, plan) => {
          fenced.push(plan.acceptedDeletes.map((deleted) => deleted.id));
          throw new Error('the host went down after the fence');
        },
      }),
    ).rejects.toThrow('the host went down after the fence');
    expect(fenced).toEqual([[hex(1)]]);
    let answer = await pulled(w, A);
    expect(answer.lastMutationIds[A]).toBe('0');
    expect(answer.patch.find((entry) => entry.id === hex(1))?.op).toBe('put');
    // recovery replays the accepted deletion alone; then the client sends the batch again with its ids
    expect(await w.server.replayTombstone({ scope: w.scope, group: w.group, id: hex(1), revision: { client: A, mutation: '1' }, deletedAt: '2026-10-15T10:00:00.000Z' })).toBe('written');
    expect((await pulled(w, A)).lastMutationIds[A]).toBe('0');
    expect(
      await w.server.push(w.context(), batch, {
        beforeWrite: async (_trx, plan) => {
          fenced.push(plan.acceptedDeletes.map((deleted) => deleted.id));
        },
      }),
    ).toEqual({ kind: 'ok', processed: 3 });
    expect(fenced[1]).toEqual([hex(1)]);
    answer = await pulled(w, A);
    expect(answer.patch.find((entry) => entry.id === hex(1))).toMatchObject({ op: 'del', revision: { client: A, mutation: '1' } });
    expect(answer.patch.find((entry) => entry.id === hex(2))).toMatchObject({ op: 'put', value: 'two, edited' });
    expect(answer.patch.find((entry) => entry.id === hex(3))?.op).toBe('put');
    expect(answer.results.map((result) => [result.mutationId, result.outcome, result.reason])).toEqual([['1', 'noop', null], ['2', 'refused', 'stale'], ['3', 'applied', null]]);
    // the no-op's result carries the revision the row had: the replayed tombstone's
    expect(answer.results[0]?.revision).toEqual({ client: A, mutation: '1' });
    expect(await w.server.replayTombstone({ scope: w.scope, group: w.group, id: hex(1), revision: { client: A, mutation: '1' }, deletedAt: '2026-10-15T10:00:00.000Z' })).toBe('kept');
  });

  it("records a no-op's resulting revision, and compares a dependent mutation from that client against it", async () => {
    await w.server.push(w.context(), pushOf(w, A, [{ name: 'create', args: { id: hex(1), value: 'v' } }, { name: 'create', args: { id: hex(2), value: 'y' } }]));
    // B, offline until now, created the same two rows under the same ids, then deleted one and edited the other
    expect(
      await w.server.push(w.context(), pushOf(w, B, [
        { name: 'create', args: { id: hex(1), value: 'v' } },
        { name: 'create', args: { id: hex(2), value: 'y' } },
        { name: 'delete', args: { id: hex(1), expected: { client: B, mutation: '1' } } },
        { name: 'edit', args: { id: hex(2), expected: { client: B, mutation: '2' }, value: 'y, edited' } },
      ])),
    ).toEqual({ kind: 'ok', processed: 4 });
    const answer = await pulled(w, B);
    expect(answer.results.map((result) => [result.outcome, result.revision])).toEqual([
      ['noop', { client: A, mutation: '1' }],
      ['noop', { client: A, mutation: '2' }],
      ['applied', { client: B, mutation: '3' }],
      ['applied', { client: B, mutation: '4' }],
    ]);
    expect(answer.patch.find((entry) => entry.id === hex(1))).toMatchObject({ op: 'del', revision: { client: B, mutation: '3' } });
    expect(answer.patch.find((entry) => entry.id === hex(2))).toMatchObject({ op: 'put', value: 'y, edited', revision: { client: B, mutation: '4' } });
  });

  it('consumes the id of a permanent refusal and goes on; a failure on the way rolls the push back and consumes nothing', async () => {
    expect(await w.server.push(w.context(), pushOf(w, A, [
      { name: 'create', args: { id: hex(1), value: 'x'.repeat(30_001) } },
      { name: 'create', args: { id: hex(2), value: 'fits' } },
    ]))).toEqual({ kind: 'ok', processed: 2 });
    let answer = await pulled(w, A);
    expect(answer.results.map((result) => [result.mutationId, result.outcome, result.reason])).toEqual([['1', 'refused', 'too_long'], ['2', 'applied', null]]);
    expect(answer.patch.map((entry) => entry.id)).toEqual([hex(2)]);
    let fails = true;
    const flaky: ValueCodec = {
      seal: async (value, place) => {
        if (fails) {
          fails = false;
          throw new Error('the key service did not answer');
        }
        return testCodec.seal(value, place);
      },
      open: testCodec.open,
    };
    const flakyServer = new MutationServer({ ...w.options, codec: flaky });
    const next = pushOf(w, A, [{ name: 'create', args: { id: hex(3), value: 'three' } }], 3);
    await expect(flakyServer.push(w.context(), next)).rejects.toThrow('the key service did not answer');
    answer = await pulled(w, A);
    expect(answer.lastMutationIds[A]).toBe('2');
    expect(answer.cookie).toBe('1');
    expect(await flakyServer.push(w.context(), next)).toEqual({ kind: 'ok', processed: 1 });
  });

  it('refuses a create of a deleted id any time later: a tombstone lasts the group's life', async () => {
    let now = new Date('2026-10-15T10:00:00Z');
    const timed = await world(backend, { clock: () => now });
    try {
      await timed.server.push(timed.context(), pushOf(timed, A, [
        { name: 'create', args: { id: hex(1), value: 'one' } },
        { name: 'delete', args: { id: hex(1), expected: { client: A, mutation: '1' } } },
      ]));
      now = new Date(now.getTime() + 91 * 86_400_000);
      await timed.server.push(timed.context(), pushOf(timed, B, [{ name: 'create', args: { id: hex(1), value: 'back' } }]));
      const answer = await pulled(timed, B);
      expect(answer.patch).toEqual([{ op: 'del', id: hex(1), revision: { client: A, mutation: '2' }, version: '1', deletedAt: '2026-10-15T10:00:00.000Z' }]);
      expect(answer.results).toMatchObject([{ mutationId: '1', outcome: 'refused', reason: 'removed' }]);
    } finally {
      await timed.close();
    }
  });

  it('skips a create resent after another client deleted its row, and refuses a stale edit that meets the tombstone', async () => {
    await w.server.push(w.context(), pushOf(w, A, [{ name: 'create', args: { id: hex(1), value: 'one' } }]));
    await w.server.push(w.context(), pushOf(w, B, [{ name: 'delete', args: { id: hex(1), expected: { client: A, mutation: '1' } } }]));
    expect(await w.server.push(w.context(), pushOf(w, A, [{ name: 'create', args: { id: hex(1), value: 'one' } }]))).toEqual({ kind: 'ok', processed: 0 });
    expect(await w.server.push(w.context(), pushOf(w, A, [{ name: 'edit', args: { id: hex(1), expected: { client: A, mutation: '1' }, value: 'edited' } }], 2))).toEqual({ kind: 'ok', processed: 1 });
    const answer = await pulled(w, A);
    expect(answer.patch).toMatchObject([{ op: 'del', id: hex(1) }]);
    expect(answer.results.map((result) => [result.mutationId, result.outcome, result.reason])).toEqual([['1', 'applied', null], ['2', 'refused', 'removed']]);
  });

  it('answers a changed epoch before it reads anything, and another group after its group row alone', async () => {
    const calls: string[] = [];
    const counted = new Proxy(w.store, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver) as unknown;
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          calls.push(String(property));
          return (value as (...inner: unknown[]) => unknown).apply(target, args);
        };
      },
    }) as MutationServerStore;
    const watched = new MutationServer({ ...w.options, store: counted });
    const request = pushOf(w, A, [{ name: 'create', args: { id: hex(1), value: 'one' } }]);
    w.epoch.current = hex(0xe2);
    expect(await watched.push(w.context(), request)).toEqual({ kind: 'epoch_changed', epoch: hex(0xe2) });
    expect(calls).toEqual([]);
    expect(await watched.push(w.context(), { ...request, epoch: hex(0xe2), group: hex(0x0de) })).toEqual({ kind: 'group_gone' });
    expect(calls).toEqual(['begin', 'lockGroup']);
  });
});
