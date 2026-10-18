import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DrainGate } from '../../src/features/sync/mutations/gate';
import { PullCancelled } from '../../src/features/sync/mutations/handOver';
import { MutationServer } from '../../src/features/sync/mutations/server';
import { parsePullResponse } from '../../src/features/sync/mutations/wire';
import { backends } from './backends';
import { A, B, hex, pullOf, pulled, pushOf, world, type World } from './harness';

const BACKENDS = await backends();

/** B makes rows 1 to `count` in one push. */
async function rows(w: World, count: number): Promise<void> {
  await w.server.push(w.context(), pushOf(w, B, Array.from({ length: count }, (_, index) => ({ name: 'create' as const, args: { id: hex(index + 1), value: `row ${index + 1}` } }))));
}

describe.each(BACKENDS.map((backend) => [backend.name, backend] as const))('the server pull on %s', (name, backend) => {
  let w: World;

  beforeEach(async () => {
    w = await world(backend, { pullBatchRows: 2 });
  });

  afterEach(async () => {
    await w.close();
  });

  it('streams a full pull in batches of two from one snapshot while another push commits', async () => {
    await rows(w, 6);
    const opening = await w.server.pull(w.context(), pullOf(w, A));
    if (opening.kind !== 'stream') throw new Error('no stream');
    const chunks = opening.chunks[Symbol.asyncIterator]();
    let text = '';
    text += (await chunks.next()).value as string;
    text += (await chunks.next()).value as string;
    const pushing = w.server.push(w.context(), pushOf(w, B, [{ name: 'create', args: { id: hex(7), value: 'row 7' } }], 7));
    // Postgres commits the push between the pull's reads; a SQLite connection holds it until the pull's transaction ends
    if (name === 'postgres') expect(await pushing).toEqual({ kind: 'ok', processed: 1 });
    for (let next = await chunks.next(); !next.done; next = await chunks.next()) text += next.value;
    expect(await pushing).toEqual({ kind: 'ok', processed: 1 });
    const answer = parsePullResponse(JSON.parse(text));
    expect(answer.cookie).toBe('1');
    expect(answer.patch.map((entry) => entry.id)).toEqual([1, 2, 3, 4, 5, 6].map(hex));
    expect(answer.lastMutationIds).toEqual({ [A]: '0', [B]: '6' });
    const later = await pulled(w, A, '1');
    expect(later.patch.map((entry) => entry.id)).toEqual([hex(7)]);
    expect(later).toMatchObject({ cookie: '2', full: false, lastMutationIds: { [B]: '7' } });
  });

  it('keeps nothing of a stream dropped before its end, and the next pull reads whole', async () => {
    await rows(w, 5);
    const opening = await w.server.pull(w.context(), pullOf(w, A));
    if (opening.kind !== 'stream') throw new Error('no stream');
    const chunks = opening.chunks[Symbol.asyncIterator]();
    await chunks.next();
    await chunks.return?.();
    await expect(w.server.push(w.context(), pushOf(w, B, [{ name: 'create', args: { id: hex(6), value: 'row 6' } }], 6))).resolves.toEqual({ kind: 'ok', processed: 1 });
    expect((await pulled(w, A)).patch.map((entry) => entry.id)).toEqual([1, 2, 3, 4, 5, 6].map(hex));
  });

  it('ends the transaction of a stream whose request is aborted', async () => {
    await rows(w, 5);
    const controller = new AbortController();
    const opening = await w.server.pull(w.context(), pullOf(w, A), controller.signal);
    if (opening.kind !== 'stream') throw new Error('no stream');
    const chunks = opening.chunks[Symbol.asyncIterator]();
    await chunks.next();
    controller.abort(new Error('the request went away'));
    await expect(chunks.next()).rejects.toThrow('the request went away');
    await expect(w.server.push(w.context(), pushOf(w, B, [{ name: 'create', args: { id: hex(6), value: 'row 6' } }], 6))).resolves.toEqual({ kind: 'ok', processed: 1 });
  });

  it('cancels a stream whose reader stops reading once maxPullMs has passed, and its transaction ends', async () => {
    await rows(w, 5);
    // the deadline counts from the call, so it leaves a slow start of the transaction room to hand over the first chunk,
    // and the wait for the end below stays well past it
    const server = new MutationServer({ ...w.options, maxPullMs: 500 });
    const opening = await server.pull(w.context(), pullOf(w, A));
    if (opening.kind !== 'stream') throw new Error('no stream');
    const chunks = opening.chunks[Symbol.asyncIterator]();
    try {
      await chunks.next();
      // the reader stops reading: the deadline cancels the stream, and its transaction ends without the reader
      const ended = await Promise.race([opening.done.then(() => 'ended'), new Promise<string>((resolve) => setTimeout(() => resolve('still open'), 2000))]);
      expect(ended).toBe('ended');
      await expect(chunks.next()).rejects.toBeInstanceOf(PullCancelled);
    } finally {
      await chunks.return?.();
    }
    await expect(w.server.push(w.context(), pushOf(w, B, [{ name: 'create', args: { id: hex(6), value: 'row 6' } }], 6))).resolves.toEqual({ kind: 'ok', processed: 1 });
  });

  it('carries a row it cannot open as unreadable, and a value moved to another row opens nowhere', async () => {
    await rows(w, 2);
    const first = await w.opened.adapter.get<{ stored: string }>(`SELECT stored FROM ${w.opened.prefix}rows WHERE scope = ? AND id = ?`, [w.scope, hex(1)]);
    await w.opened.adapter.run(`UPDATE ${w.opened.prefix}rows SET stored = ? WHERE scope = ? AND id = ?`, [first?.stored, w.scope, hex(2)]);
    const answer = await pulled(w, A);
    expect(answer.patch).toEqual([
      { op: 'put', id: hex(1), value: 'row 1', revision: { client: B, mutation: '1' }, version: '1' },
      { op: 'unreadable', id: hex(2), revision: { client: B, mutation: '2' }, version: '1' },
    ]);
  });

  it('refuses a cookie past the version, another epoch and another group before any row is read', async () => {
    await rows(w, 1);
    expect(await w.server.pull(w.context(), pullOf(w, A, '9'))).toEqual({ kind: 'cookie_ahead' });
    expect(await w.server.pull(w.context(), { ...pullOf(w, A), epoch: hex(0xe9) })).toEqual({ kind: 'epoch_changed', epoch: w.epoch.current });
    expect(await w.server.pull(w.context(), { ...pullOf(w, A), group: hex(0x0de) })).toEqual({ kind: 'group_gone' });
  });

  it('cancels a stalled reader for a deletion, so the gate drains within its deadline', async () => {
    await rows(w, 5);
    const gate = new DrainGate();
    const controller = new AbortController();
    const lease = gate.enter([`scope:${w.scope}`, `group:${w.group}`], (reason) => controller.abort(reason));
    const opening = await w.server.pull(w.context(), pullOf(w, A), controller.signal);
    if (opening.kind !== 'stream') throw new Error('no stream');
    const chunks = opening.chunks[Symbol.asyncIterator]();
    await chunks.next();
    // the reader stops reading; the route releases its lease once the stream's transaction has ended, however it ended
    const ended = opening.done.finally(() => lease.release());
    const started = Date.now();
    const block = gate.block(`group:${w.group}`);
    expect(await block.drain(5000)).toBe('drained');
    expect(Date.now() - started).toBeLessThan(5000);
    await ended;
    expect(() => gate.enter([`scope:${w.scope}`, `group:${w.group}`], () => undefined)).toThrow();
    block.release();
    await expect(w.server.push(w.context(), pushOf(w, B, [{ name: 'create', args: { id: hex(6), value: 'row 6' } }], 6))).resolves.toEqual({ kind: 'ok', processed: 1 });
  });
});
