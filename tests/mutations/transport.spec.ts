import { describe, expect, it, vi } from 'vitest';
import { createFetchMutationTransport, SyncUnavailable } from '../../src/features/sync/mutations/transport';
import { parsePullRequest, type PullRequest, type PushRequest } from '../../src/features/sync/mutations/wire';
import { backends } from './backends';
import { A, hex, pulled, pullOf, pushOf, world, type World } from './harness';

const BACKENDS = await backends();

/** A push and a pull route over the world's server: the push's answer as JSON, the pull's stream as one body. */
function route(w: World): typeof fetch {
  return async (input, init) => {
    const body = JSON.parse(String(init?.body)) as unknown;
    if (String(input).endsWith('/push')) {
      return new Response(JSON.stringify(await w.server.push(w.context(), w.server.parsePush(body))), { status: 200 });
    }
    const opening = await w.server.pull(w.context(), parsePullRequest(body));
    if (opening.kind !== 'stream') return new Response(JSON.stringify(opening), { status: 200 });
    let text = '';
    for await (const chunk of opening.chunks) text += chunk;
    return new Response(text, { status: 200 });
  };
}

describe.each(BACKENDS.map((backend) => [backend.name, backend] as const))('the fetch transport against a server on %s', (_name, backend) => {
  it("carries a push and a whole pull through the routes' JSON, and a refusal the pull route answers", async () => {
    const w = await world(backend);
    try {
      const transport = createFetchMutationTransport({ pushUrl: 'https://sync.test/push', pullUrl: 'https://sync.test/pull', fetch: route(w) });
      expect(await transport.push(pushOf(w, A, [{ name: 'create', args: { id: hex(1), value: 'one "quoted"\n中 ' } }]))).toEqual({ kind: 'ok', processed: 1 });
      const answer = await transport.pull(pullOf(w, A));
      expect(answer).toEqual(await pulled(w, A));
      expect(answer).toMatchObject({ kind: 'pull', patch: [{ op: 'put', id: hex(1), value: 'one "quoted"\n中 ' }] });
      const before = w.epoch.current;
      w.epoch.current = hex(0xe2);
      expect(await transport.pull({ ...pullOf(w, A), epoch: before })).toEqual({ kind: 'epoch_changed', epoch: hex(0xe2) });
    } finally {
      await w.close();
    }
  });
});

describe('the fetch transport', () => {
  const push: PushRequest = { group: hex(1), epoch: hex(2), clientId: hex(3), mutations: [{ id: '1', name: 'create', args: { id: hex(4), value: 'v' } }] };
  const pull: PullRequest = { group: hex(1), epoch: hex(2), clientId: hex(3), cookie: null };
  const reply =
    (status: number, body: string, headers: Record<string, string> = {}) =>
    (): Promise<Response> =>
      Promise.resolve(new Response(body, { status, headers }));

  it('maps the refusals it knows, and turns a failed request, a cut answer and a body that is not an answer into SyncUnavailable', async () => {
    const answers: Array<() => Promise<Response>> = [];
    const fetchImpl = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => (answers.shift() as () => Promise<Response>)());
    const transport = createFetchMutationTransport({
      pushUrl: 'https://sync.test/push',
      pullUrl: 'https://sync.test/pull',
      fetch: fetchImpl as unknown as typeof fetch,
      refusal: (status) => (status === 410 ? { kind: 'group_gone' } : null),
    });
    answers.push(reply(413, 'too large'));
    expect(await transport.push(push)).toEqual({ kind: 'too_large' });
    answers.push(reply(429, '', { 'retry-after': '3' }));
    expect(await transport.push(push)).toEqual({ kind: 'rate_limited', retryAfterMs: 3000 });
    answers.push(reply(400, '{}'));
    expect(await transport.push(push)).toEqual({ kind: 'malformed' });
    answers.push(reply(410, '{"error":"gone"}'));
    expect(await transport.pull(pull)).toEqual({ kind: 'group_gone' });
    answers.push(reply(429, ''));
    expect(await transport.pull(pull)).toEqual({ kind: 'rate_limited', retryAfterMs: 2000 });
    // an answer the server never finished, a body that is not an answer of the protocol, and statuses the pull does not take
    for (const [status, body] of [
      [200, '{"kind":"pull","group":"'],
      [200, 'null'],
      [200, '7'],
      [200, '{"kind":"ok","processed":1}'],
      [500, ''],
      [413, ''],
    ] as const) {
      answers.push(reply(status, body));
      await expect(transport.pull(pull)).rejects.toBeInstanceOf(SyncUnavailable);
    }
    answers.push(reply(200, 'null'));
    await expect(transport.push(push)).rejects.toBeInstanceOf(SyncUnavailable);
    answers.push(() => Promise.reject(new TypeError('the network failed')));
    await expect(transport.push(push)).rejects.toBeInstanceOf(SyncUnavailable);
    expect(fetchImpl).toHaveBeenCalledTimes(13);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://sync.test/push');
    expect(fetchImpl.mock.calls[3][0]).toBe('https://sync.test/pull');
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store', body: JSON.stringify(push) });
  });

  it('gives a request up at its deadline as SyncUnavailable', async () => {
    const transport = createFetchMutationTransport({
      pushUrl: 'https://sync.test/push',
      pullUrl: 'https://sync.test/pull',
      deadlineMs: 20,
      fetch: ((_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })) as typeof fetch,
    });
    await expect(transport.pull(pull)).rejects.toBeInstanceOf(SyncUnavailable);
  });
});
