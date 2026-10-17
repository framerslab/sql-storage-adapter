/**
 * The world the server suites run in: one database from `backends.ts`, the reference store's tables under the test's
 * prefix, one scope with one group, an epoch the test can change, and a codec that binds a value to its scope and row
 * as an encrypting codec's authenticated data would, so a value moved to another row does not open.
 */
import { parsePullResponse, type PullRefusal, type PullRequest, type PullResponse, type PushRequest } from '../../src/features/sync/mutations/wire';
import type { RowMutation, RowPolicy } from '../../src/features/sync/mutations/rows';
import { MutationServer, UnreadableValue, type MutationServerOptions, type MutationServerStore, type ScopeContext, type ValueCodec } from '../../src/features/sync/mutations/server';
import { createSqlGroup, createSqlMutationStore, mutationStoreDdl } from '../../src/features/sync/mutations/sqlStore';
import type { Backend, OpenedBackend } from './backends';

/** A 32-hex id from a small number. */
export const hex = (n: number): string => n.toString(16).padStart(32, '0');

/** Two clients of the default group. */
export const A = hex(0xa1);
export const B = hex(0xb1);

/** A codec that seals a value with its scope and row id, and refuses to open it anywhere else. */
export const testCodec: ValueCodec = {
  async seal(value, place) {
    return Buffer.from(JSON.stringify([place.scope, place.id, value]), 'utf8').toString('base64');
  },
  async open(stored, place) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(stored, 'base64').toString('utf8'));
    } catch {
      throw new UnreadableValue();
    }
    if (!Array.isArray(parsed) || parsed[0] !== place.scope || parsed[1] !== place.id || typeof parsed[2] !== 'string') throw new UnreadableValue();
    return parsed[2];
  },
};

/** The suites' limits: generous, but for the cases that set their own. */
export const POLICY: RowPolicy = { maxRows: 50, maxUnits: 30_000, copyValue: (value) => `${value} (copy)` };

/** One test's server world. */
export interface World {
  opened: OpenedBackend;
  store: MutationServerStore;
  options: MutationServerOptions;
  server: MutationServer;
  scope: string;
  group: string;
  epoch: { current: string };
  context(): ScopeContext;
  close(): Promise<void>;
}

/** Makes a world: the tables, the group, the server. */
export async function world(backend: Backend, settings: { policy?: Partial<RowPolicy>; pullBatchRows?: number; clock?: () => Date } = {}): Promise<World> {
  const opened = await backend.open();
  for (const statement of mutationStoreDdl(opened.prefix)) await opened.adapter.exec(statement);
  const scope = hex(0x5c09e);
  const group = hex(0x6409);
  await createSqlGroup(opened.adapter, opened.prefix, scope, group);
  const store = createSqlMutationStore({ prefix: opened.prefix });
  const options: MutationServerOptions = {
    adapter: opened.adapter,
    store,
    codec: testCodec,
    policy: { ...POLICY, ...settings.policy },
    maxMutations: 50,
    pullBatchRows: settings.pullBatchRows,
    clock: settings.clock,
  };
  const epoch = { current: hex(0xe1) };
  return {
    opened,
    store,
    options,
    server: new MutationServer(options),
    scope,
    group,
    epoch,
    context: () => ({ scope, epoch: epoch.current }),
    close: () => opened.close(),
  };
}

/** A push of row mutations from `clientId`, ids from `first`. */
export function pushOf(w: World, clientId: string, mutations: RowMutation[], first = 1): PushRequest {
  return { group: w.group, epoch: w.epoch.current, clientId, mutations: mutations.map((mutation, index) => ({ id: String(first + index), name: mutation.name, args: mutation.args })) };
}

/** A full or delta pull for `clientId`. */
export function pullOf(w: World, clientId: string, cookie: string | null = null): PullRequest {
  return { group: w.group, epoch: w.epoch.current, clientId, cookie };
}

/** Reads a pull's whole stream and parses it, as a client's transport does. */
export async function pullWhole(w: World, request: PullRequest, server: MutationServer = w.server): Promise<PullResponse | PullRefusal> {
  const opening = await server.pull(w.context(), request);
  if (opening.kind !== 'stream') return opening;
  let text = '';
  for await (const chunk of opening.chunks) text += chunk;
  return parsePullResponse(JSON.parse(text));
}

/** The same, for a test that expects a patch. */
export async function pulled(w: World, clientId: string, cookie: string | null = null): Promise<PullResponse> {
  const answer = await pullWhole(w, pullOf(w, clientId, cookie));
  if (answer.kind !== 'pull') throw new Error(`the pull was refused: ${answer.kind}`);
  return answer;
}
