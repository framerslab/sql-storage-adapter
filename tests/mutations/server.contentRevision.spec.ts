import { afterEach, describe, expect, it } from 'vitest';
import type { StorageAdapter, StorageParameters } from '../../src/core/contracts';
import type { RowComposer, RowMutation } from '../../src/features/sync/mutations/rows';
import { MutationServer } from '../../src/features/sync/mutations/server';
import { mutationStoreDdl, upgradeSqlMutationStore } from '../../src/features/sync/mutations/sqlStore';
import { PROTOCOL, WireError, type PushRequest } from '../../src/features/sync/mutations/wire';
import { backends } from './backends';
import { hex, pullOf, pullWhole, pushOf, world, type World } from './harness';

const BACKENDS = await backends();
const A = hex(0xa1);
const B = hex(0xb1);

/** The same toy composer as the rows suite: "content|tag,tag". */
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
  deltaOf: () => null,
  sameClaim: (current, incoming) => current === incoming,
};

const v2 = (request: PushRequest): PushRequest => ({ ...request, protocol: PROTOCOL });

/** These cases ask for protocol 2 explicitly; the shared harness remains a protocol 1 client. */
async function pulled(w: World, clientId: string) {
  const answer = await pullWhole(w, { ...pullOf(w, clientId), protocol: PROTOCOL });
  if (answer.kind !== 'pull') throw new Error(`the pull was refused: ${answer.kind}`);
  return answer;
}

describe.each(BACKENDS.map((backend) => [backend.name, backend] as const))('%s: the content revision on the server', (_name, backend) => {
  // each world closes once: a second close of a Postgres world fails on its closed pool
  let w: World | undefined;
  afterEach(async () => {
    const open = w;
    w = undefined;
    await open?.close();
  });

  it('lands a tags-only change and a content change from one base in both push orders, and answers both revisions', async () => {
    for (const order of [['tags', 'content'], ['content', 'tags']] as const) {
      w = await world(backend, { policy: { composer } });
      await w.server.push(w.context(), v2(pushOf(w, A, [{ name: 'create', args: { id: hex(1), value: 'text|' } }])));
      const base = { client: A, mutation: '1' };
      const tags: RowMutation = { name: 'amend', args: { id: hex(1), expected: base, expectedContent: base, content: null, delta: '{"add":["budget"],"remove":[]}' } };
      const text: RowMutation = { name: 'amend', args: { id: hex(1), expected: base, expectedContent: base, content: 'new text', delta: null } };
      for (const which of order) await w.server.push(w.context(), v2(pushOf(w, B, [which === 'tags' ? tags : text], which === order[0] ? 1 : 2)));
      const answer = await pulled(w, B);
      expect(answer.patch).toEqual([expect.objectContaining({ op: 'put', id: hex(1), value: 'new text|budget' })]);
      const contentMutation = order[0] === 'content' ? '1' : '2';
      expect(answer.patch[0]).toMatchObject({ contentRevision: { client: B, mutation: contentMutation } });
      expect(answer.results.map((result) => result.outcome)).toEqual(['applied', 'applied']);
      const done = w;
      w = undefined;
      await done.close();
    }
  });

  it('refuses a claim at an occupied id with no new row, and a protocol it does not take before reading a mutation', async () => {
    w = await world(backend, { policy: { composer } });
    await w.server.push(w.context(), v2(pushOf(w, A, [{ name: 'claim', args: { id: hex(2), value: 'copy|' } }])));
    await w.server.push(w.context(), v2(pushOf(w, A, [{ name: 'amend', args: { id: hex(2), expected: { client: A, mutation: '1' }, expectedContent: { client: A, mutation: '1' }, content: 'edited', delta: null } }], 2)));
    await w.server.push(w.context(), v2(pushOf(w, B, [{ name: 'claim', args: { id: hex(2), value: 'copy|' } }])));
    const answer = await pulled(w, B);
    expect(answer.patch.map((entry) => entry.id)).toEqual([hex(2)]);
    expect(answer.results).toEqual([expect.objectContaining({ outcome: 'refused', reason: 'occupied', contentRevision: null })]);
    const narrow = new MutationServer({ ...w.options, protocols: [2] });
    expect(await narrow.push(w.context(), pushOf(w, B, [{ name: 'create', args: { id: hex(3), value: 'x|' } }], 2))).toEqual({ kind: 'protocol_changed', protocols: [2] });
    expect((await pulled(w, B)).lastMutationIds[B]).toBe('1');
  });

  it('reads a body in a protocol it does not take without its mutations, so the push answers protocol_changed', async () => {
    w = await world(backend);
    const { server } = w;
    const narrow = new MutationServer({ ...w.options, protocols: [2] });
    const body = { ...pushOf(w, A, []), mutations: [{ id: '1', name: 'rename', args: { id: hex(5), to: 'later' } }] };
    expect(await narrow.push(w.context(), narrow.parsePush(JSON.parse(JSON.stringify(body))))).toEqual({ kind: 'protocol_changed', protocols: [2] });
    expect(await server.push(w.context(), server.parsePush({ ...body, protocol: 3 }))).toEqual({ kind: 'protocol_changed', protocols: [1, 2] });
    expect(() => server.parsePush({ ...body, protocol: 2 })).toThrow(WireError);
    expect(() => narrow.parsePush({ ...body, protocol: 2 })).toThrow(WireError);
    expect(() => narrow.parsePush({ ...body, protocol: '3' })).toThrow(WireError);
    expect((await pulled(w, A)).lastMutationIds[A]).toBe('0');
  });

  it('upgrades a store made without content revisions: rows take their revision, and a second run changes nothing', async () => {
    w = await world(backend);
    const p = w.opened.prefix;
    await w.server.push(w.context(), pushOf(w, A, [{ name: 'create', args: { id: hex(4), value: 'old|' } }]));
    await upgradeSqlMutationStore(w.opened.adapter, p);
    await upgradeSqlMutationStore(w.opened.adapter, p);
    const [row] = await w.opened.adapter.all<{ content_client: string; content_mutation: unknown }>(`SELECT content_client, content_mutation FROM ${p}rows WHERE id = ?`, [hex(4)]);
    expect([row?.content_client, Number(row?.content_mutation)]).toEqual([A, 1]);
    expect(mutationStoreDdl(p).some((statement) => statement.includes('content_client'))).toBe(true);
  });

  it.each([undefined, 1])('drains a protocol 1 client with protocol %s and exactly the old response keys', async (protocol) => {
    w = await world(backend);
    const request = pushOf(w, A, [{ name: 'create', args: { id: hex(4), value: 'old|' } }]);
    expect(await w.server.push(w.context(), { ...request, ...(protocol === undefined ? {} : { protocol }) })).toMatchObject({ kind: 'ok' });
    const answer = await pullWhole(w, { ...pullOf(w, A), ...(protocol === undefined ? {} : { protocol }) });
    if (answer.kind !== 'pull') throw new Error('expected a pull');
    expect(answer.patch[0]).toEqual({ op: 'put', id: hex(4), value: 'old|', revision: { client: A, mutation: '1' }, version: '1' });
    expect(answer.results[0]).toEqual({ clientId: A, mutationId: '1', outcome: 'applied', reason: null, targetId: hex(4), revision: { client: A, mutation: '1' }, version: '1' });
    expect(answer.lastMutationIds[A]).toBe('1');
    const modern = await pulled(w, A);
    expect(modern.patch[0]).toHaveProperty('contentRevision', { client: A, mutation: '1' });
    expect(modern.results[0]).toHaveProperty('contentRevision', { client: A, mutation: '1' });
    const cutover = new MutationServer({ ...w.options, protocols: [2] });
    expect(await cutover.push(w.context(), { ...request, mutations: [{ id: '2', name: 'delete', args: { id: hex(4), expected: { client: A, mutation: '1' } } }] })).toEqual({ kind: 'protocol_changed', protocols: [2] });
    expect((await pulled(w, A)).lastMutationIds[A]).toBe('1');
  });

  it('answers a claim no-op with both existing revisions and applies its dependent delete', async () => {
    w = await world(backend, { policy: { composer } });
    await w.server.push(w.context(), v2(pushOf(w, B, [{ name: 'create', args: { id: hex(1), value: 'text|' } }])));
    await w.server.push(w.context(), v2(pushOf(w, A, [
      { name: 'claim', args: { id: hex(1), value: 'text|' } },
      { name: 'delete', args: { id: hex(1), expected: { client: A, mutation: '1' } } },
    ])));
    const answer = await pulled(w, A);
    expect(answer.results[0]).toMatchObject({ outcome: 'noop', revision: { client: B, mutation: '1' }, contentRevision: { client: B, mutation: '1' } });
    expect(answer.results[1]).toMatchObject({ outcome: 'applied', revision: { client: A, mutation: '2' } });
    expect(answer.patch[0]).toMatchObject({ op: 'del', id: hex(1) });
  });

  it.each([
    ['rows', 'content_client'], ['rows', 'content_mutation'],
    ['results', 'content_client'], ['results', 'content_mutation'], ['rows', null],
  ] as const)('resumes the store upgrade with only %s.%s added', async (table, column) => {
    w = await world(backend);
    const p = `${w.opened.prefix}old_`;
    await w.opened.adapter.exec(`CREATE TABLE ${p}rows (scope TEXT NOT NULL, id TEXT NOT NULL, state TEXT NOT NULL, stored TEXT, rev_client TEXT NOT NULL, rev_mutation BIGINT NOT NULL, version BIGINT NOT NULL, deleted_at TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (scope, id))`);
    await w.opened.adapter.exec(`CREATE TABLE ${p}results (scope TEXT NOT NULL, grp TEXT NOT NULL, client_id TEXT NOT NULL, mutation_id BIGINT NOT NULL, outcome TEXT NOT NULL, reason TEXT, target_id TEXT NOT NULL, rev_client TEXT, rev_mutation BIGINT, version BIGINT NOT NULL, PRIMARY KEY (scope, grp, client_id, mutation_id))`);
    await w.opened.adapter.run(`INSERT INTO ${p}rows (scope, id, state, stored, rev_client, rev_mutation, version, deleted_at, updated_at) VALUES (?, ?, 'live', 'x', ?, 3, 3, NULL, '2026-10-15T00:00:00.000Z')`, [w.scope, hex(8), A]);
    if (column !== null) await w.opened.adapter.run(`ALTER TABLE ${p}${table} ADD COLUMN ${column} ${column === 'content_client' ? 'TEXT' : 'BIGINT'}`);
    await upgradeSqlMutationStore(w.opened.adapter, p);
    await upgradeSqlMutationStore(w.opened.adapter, p);
    const [row] = await w.opened.adapter.all<{ content_client: string; content_mutation: unknown; stored: string }>(`SELECT content_client, content_mutation, stored FROM ${p}rows WHERE id = ?`, [hex(8)]);
    expect([row?.content_client, Number(row?.content_mutation), row?.stored]).toEqual([A, 3, 'x']);
    expect(await w.opened.adapter.all(`SELECT content_client, content_mutation FROM ${p}results WHERE 1 = 0`)).toEqual([]);
  });

  it('finishes the store upgrade when another server adds a column between its check and its change', async () => {
    w = await world(backend);
    const p = `${w.opened.prefix}old_`;
    const real = w.opened.adapter;
    await real.exec(`CREATE TABLE ${p}rows (scope TEXT NOT NULL, id TEXT NOT NULL, state TEXT NOT NULL, stored TEXT, rev_client TEXT NOT NULL, rev_mutation BIGINT NOT NULL, version BIGINT NOT NULL, deleted_at TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (scope, id))`);
    await real.exec(`CREATE TABLE ${p}results (scope TEXT NOT NULL, grp TEXT NOT NULL, client_id TEXT NOT NULL, mutation_id BIGINT NOT NULL, outcome TEXT NOT NULL, reason TEXT, target_id TEXT NOT NULL, rev_client TEXT, rev_mutation BIGINT, version BIGINT NOT NULL, PRIMARY KEY (scope, grp, client_id, mutation_id))`);
    await real.run(`INSERT INTO ${p}rows (scope, id, state, stored, rev_client, rev_mutation, version, deleted_at, updated_at) VALUES (?, ?, 'live', 'x', ?, 3, 3, NULL, '2026-10-15T00:00:00.000Z')`, [w.scope, hex(8), A]);
    // the other server's upgrade adds each column after this one found it missing and before its own change runs
    const racing = new Proxy(real, {
      get(target, key) {
        if (key === 'run') {
          return async (statement: string, parameters?: StorageParameters) => {
            if (statement.startsWith('ALTER TABLE')) await target.run(statement);
            return target.run(statement, parameters);
          };
        }
        const value = Reflect.get(target, key) as unknown;
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    }) as StorageAdapter;
    await upgradeSqlMutationStore(racing, p);
    const [row] = await real.all<{ content_client: string; content_mutation: unknown }>(`SELECT content_client, content_mutation FROM ${p}rows WHERE id = ?`, [hex(8)]);
    expect([row?.content_client, Number(row?.content_mutation)]).toEqual([A, 3]);
    expect(await real.all(`SELECT content_client, content_mutation FROM ${p}results WHERE 1 = 0`)).toEqual([]);
  });
});
