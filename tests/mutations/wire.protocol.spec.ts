import { describe, expect, it } from 'vitest';
import { parseRowArgs } from '../../src/features/sync/mutations/rows';
import { parsePullRefusal, parsePullRequest, parsePullResponse, parsePushAnswer, parsePushRequest, PROTOCOL, WireError } from '../../src/features/sync/mutations/wire';

const hex = (n: number): string => n.toString(16).padStart(32, '0');
const rev = { client: hex(0xa), mutation: '1' };

describe('protocol 2 on the wire', () => {
  it('reads a push of protocol 2 with amend and claim, and a push with no protocol as protocol 1', () => {
    const push = {
      group: hex(1),
      epoch: hex(2),
      clientId: hex(3),
      protocol: PROTOCOL,
      mutations: [
        { id: '1', name: 'amend', args: { id: hex(4), expected: rev, expectedContent: rev, content: null, delta: '{"add":["a"],"remove":[]}' } },
        { id: '2', name: 'claim', args: { id: hex(5), value: 'v' } },
      ],
    };
    expect(parsePushRequest(push, 10, parseRowArgs)).toMatchObject({ protocol: 2, mutations: [{ name: 'amend' }, { name: 'claim' }] });
    const { protocol: _two, ...old } = push;
    expect(parsePushRequest({ ...old, mutations: [{ id: '1', name: 'create', args: { id: hex(4), value: 'v' } }] }, 10, parseRowArgs).protocol).toBeUndefined();
    expect(parsePullRequest({ group: hex(1), epoch: hex(2), clientId: hex(3), cookie: null, protocol: 2 }).protocol).toBe(2);
  });

  it('refuses an amend with neither content nor delta, an unknown key, and a protocol that is not a small integer', () => {
    const args = { id: hex(4), expected: rev, expectedContent: rev, content: null, delta: null };
    expect(() => parseRowArgs('amend', args)).toThrow(WireError);
    expect(() => parseRowArgs('amend', { ...args, delta: 'x', extra: 1 })).toThrow(WireError);
    expect(() => parsePullRequest({ group: hex(1), epoch: hex(2), clientId: hex(3), cookie: null, protocol: 'two' })).toThrow(WireError);
  });

  it("reads a put entry's and a result's content revision, a refused result's null one, and protocol_changed", () => {
    const answer = parsePullResponse({
      kind: 'pull',
      group: hex(1),
      epoch: hex(2),
      cookie: '3',
      full: false,
      lastMutationIds: { [hex(3)]: '2' },
      patch: [{ op: 'put', id: hex(4), value: 'v', revision: rev, version: '3', contentRevision: rev }],
      results: [
        { clientId: hex(3), mutationId: '1', outcome: 'applied', reason: null, targetId: hex(4), revision: rev, version: '3', contentRevision: rev },
        { clientId: hex(3), mutationId: '2', outcome: 'refused', reason: 'occupied', targetId: hex(5), revision: null, version: '3', contentRevision: null },
      ],
    });
    expect(answer.patch[0]).toMatchObject({ contentRevision: rev });
    expect(answer.results.map((result) => result.contentRevision)).toEqual([rev, null]);
    expect(parsePushAnswer({ kind: 'protocol_changed', protocols: [2] })).toEqual({ kind: 'protocol_changed', protocols: [2] });
    expect(parsePullRefusal({ kind: 'protocol_changed', protocols: [1, 2] })).toEqual({ kind: 'protocol_changed', protocols: [1, 2] });
  });

  it('refuses a protocol outside 1 to 99, an empty protocols list, a content revision on a deleted row, a malformed one, and a refused result that carries one', () => {
    const pull = { group: hex(1), epoch: hex(2), clientId: hex(3), cookie: null };
    for (const protocol of [0, 100, 1.5, null]) expect(() => parsePullRequest({ ...pull, protocol })).toThrow(WireError);
    expect(() => parsePushRequest({ group: hex(1), epoch: hex(2), clientId: hex(3), protocol: 0, mutations: [{ id: '1', name: 'claim', args: { id: hex(5), value: 'v' } }] }, 10, parseRowArgs)).toThrow(WireError);
    expect(() => parsePushAnswer({ kind: 'protocol_changed', protocols: [] })).toThrow(WireError);
    expect(() => parsePullRefusal({ kind: 'protocol_changed', protocols: [2, 'three'] })).toThrow(WireError);
    expect(() => parsePullRefusal({ kind: 'protocol_changed', protocols: [2], epoch: hex(2) })).toThrow(WireError);
    const answer = { kind: 'pull', group: hex(1), epoch: hex(2), cookie: '3', full: false, lastMutationIds: {}, patch: [], results: [] };
    expect(() => parsePullResponse({ ...answer, patch: [{ op: 'del', id: hex(4), revision: rev, version: '3', deletedAt: '2026-01-01T00:00:00.000Z', contentRevision: rev }] })).toThrow(WireError);
    expect(() => parsePullResponse({ ...answer, patch: [{ op: 'put', id: hex(4), value: 'v', revision: rev, version: '3', contentRevision: { client: 'c', mutation: '1' } }] })).toThrow(WireError);
    const refused = { clientId: hex(3), mutationId: '2', outcome: 'refused', reason: 'occupied', targetId: hex(5), revision: null, version: '3' };
    expect(() => parsePullResponse({ ...answer, results: [{ ...refused, contentRevision: rev }] })).toThrow(WireError);
    expect(parsePullResponse({ ...answer, results: [refused] }).results[0]).not.toHaveProperty('contentRevision');
  });
});
