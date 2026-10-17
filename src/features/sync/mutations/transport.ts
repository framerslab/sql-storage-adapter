/**
 * How a client reaches the server: a push and a pull, each answered with the protocol's answer or a refusal the
 * transport read from the response. The fetch transport reads a response's whole body before it parses any of it, so a
 * cut or malformed answer is a `SyncUnavailable` and nothing of it is applied. A route that answers its own error
 * shape passes `refusal` to map it.
 */
import { parsePullRefusal, parsePullResponse, parsePushAnswer, type PullRefusal, type PullRequest, type PullResponse, type PushAnswer, type PushRequest } from './wire';

/** A request that did not reach the server, did not finish, or came back unreadable: try again later. */
export class SyncUnavailable extends Error {
  constructor(readonly reason: unknown) {
    super('the sync request did not complete');
    this.name = 'SyncUnavailable';
  }
}

/** The refusals a transport reads from a response's status. */
export type TransportRefusal = { kind: 'too_large' } | { kind: 'rate_limited'; retryAfterMs: number } | { kind: 'malformed' } | { kind: 'group_gone' };

/** What a push is answered with through a transport. */
export type TransportPushAnswer = PushAnswer | TransportRefusal;

/** What a pull is answered with through a transport. */
export type TransportPullAnswer = PullResponse | PullRefusal | { kind: 'rate_limited'; retryAfterMs: number };

/** A client's way to the server. */
export interface MutationTransport {
  push(request: PushRequest): Promise<TransportPushAnswer>;
  pull(request: PullRequest): Promise<TransportPullAnswer>;
}

/** The fetch transport's settings. */
export interface FetchTransportOptions {
  pushUrl: string;
  pullUrl: string;
  fetch?: typeof globalThis.fetch;
  headers?: Record<string, string>;
  /** How long one request may take, in milliseconds (default 120,000). */
  deadlineMs?: number;
  /** Maps a status and body the route answers in its own shape; null leaves it to the defaults. */
  refusal?: (status: number, text: string, headers: Headers) => TransportRefusal | null;
}

/**
 * How long a rate refusal asks to wait: Retry-After's delay in seconds, or the time until its HTTP date (RFC 9110,
 * section 10.2.3); two seconds for a value it cannot read, a delay of zero or a date already past.
 */
function retryAfterMs(headers: Headers): number {
  const value = (headers.get('retry-after') ?? '').trim();
  if (value === '') return 2000;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) && ms > 0 ? ms : 2000;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new SyncUnavailable(error);
  }
}

/** The transport over `fetch`, with the page's cookies and no cache. */
export function createFetchMutationTransport(options: FetchTransportOptions): MutationTransport {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  async function exchange(url: string, body: unknown): Promise<{ status: number; text: string; headers: Headers }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.deadlineMs ?? 120_000);
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...options.headers },
        credentials: 'same-origin',
        cache: 'no-store',
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      return { status: response.status, text: await response.text(), headers: response.headers };
    } catch (error) {
      throw new SyncUnavailable(error);
    } finally {
      clearTimeout(timer);
    }
  }
  function refusal(status: number, text: string, headers: Headers): TransportRefusal | null {
    const mapped = options.refusal?.(status, text, headers) ?? null;
    if (mapped !== null) return mapped;
    if (status === 413) return { kind: 'too_large' };
    if (status === 429) return { kind: 'rate_limited', retryAfterMs: retryAfterMs(headers) };
    if (status === 400) return { kind: 'malformed' };
    return null;
  }
  function checked<T>(read: () => T): T {
    try {
      return read();
    } catch (error) {
      throw new SyncUnavailable(error);
    }
  }
  return {
    async push(request) {
      const { status, text, headers } = await exchange(options.pushUrl, request);
      if (status === 200) return checked(() => parsePushAnswer(parseJson(text)));
      const refused = refusal(status, text, headers);
      if (refused !== null) return refused;
      throw new SyncUnavailable(new Error(`the push was answered ${status}`));
    },
    async pull(request) {
      const { status, text, headers } = await exchange(options.pullUrl, request);
      if (status === 200) {
        const value = parseJson(text) as { kind?: unknown };
        return checked(() => (value.kind === 'pull' ? parsePullResponse(value) : parsePullRefusal(value)));
      }
      const refused = refusal(status, text, headers);
      if (refused !== null && (refused.kind === 'rate_limited' || refused.kind === 'group_gone')) return refused;
      throw new SyncUnavailable(new Error(`the pull was answered ${status}`));
    },
  };
}
