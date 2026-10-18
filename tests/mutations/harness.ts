/**
 * The world the server suites run in: one database from `backends.ts`, the reference store's tables under the test's
 * prefix, one scope with one group, an epoch the test can change, and a codec that binds a value to its scope and row
 * as an encrypting codec's authenticated data would, so a value moved to another row does not open. Its browser half
 * makes clients over an in-memory IndexedDB adapter with a loopback transport into the world's server, and dumps and
 * restores the server's tables as a restore of the database does.
 */
import { IndexedDbAdapter } from '../../src/adapters/indexedDbAdapter';
import type { StorageAdapter } from '../../src/core/contracts';
import { MutationClient, type SaveResult, type SyncOutcome, type VisibleChange } from '../../src/features/sync/mutations/client';
import { requestBytes } from '../../src/features/sync/mutations/packing';
import { memoryTabLock, type TabLock } from '../../src/features/sync/mutations/tabLock';
import { SyncUnavailable, type MutationTransport, type TransportPullAnswer, type TransportPushAnswer } from '../../src/features/sync/mutations/transport';
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

/** A transport straight into the world's server, with the faults the suites inject. */
export interface Loopback extends MutationTransport {
  /** Every request fails as a network failure. */
  offline: boolean;
  /** A push larger than this many bytes of UTF-8 JSON is refused with 413, as a route's body limit refuses it. */
  tooLargeOver: number | null;
  /** The next push is processed and its answer lost. */
  dropNextPushAnswer(): void;
  /** The next pull reads its snapshot at once and answers when released. */
  holdNextPull(): { release(): void };
  pushes: number;
  pulls: number;
}

/** A loopback transport into the world's server. */
export function loopback(w: World): Loopback {
  let drop = false;
  let hold: Promise<void> | null = null;
  const transport: Loopback = {
    offline: false,
    tooLargeOver: null,
    pushes: 0,
    pulls: 0,
    dropNextPushAnswer() {
      drop = true;
    },
    holdNextPull() {
      let release!: () => void;
      hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { release };
    },
    async push(request): Promise<TransportPushAnswer> {
      if (transport.offline) throw new SyncUnavailable(new Error('offline'));
      transport.pushes += 1;
      if (transport.tooLargeOver !== null && requestBytes(request) > transport.tooLargeOver) return { kind: 'too_large' };
      const answer = await w.server.push(w.context(), w.server.parsePush(JSON.parse(JSON.stringify(request))));
      if (drop) {
        drop = false;
        throw new SyncUnavailable(new Error('the answer was lost'));
      }
      return answer;
    },
    async pull(request): Promise<TransportPullAnswer> {
      if (transport.offline) throw new SyncUnavailable(new Error('offline'));
      transport.pulls += 1;
      const held = hold;
      hold = null;
      const answer = await pullWhole(w, JSON.parse(JSON.stringify(request)) as PullRequest);
      if (held !== null) await held;
      return answer;
    },
  };
  return transport;
}

/** The browser's own data: blocks in order, each with its row id or none, as a product's text holds its rows. */
const BLOCKS = 'CREATE TABLE IF NOT EXISTS test_blocks (pos INTEGER PRIMARY KEY, id TEXT, value TEXT NOT NULL)';

/** Writes a change of the visible rows into the blocks: ids given to unmarked blocks, values replaced or added, rows removed. */
export async function materialize(trx: StorageAdapter, change: VisibleChange): Promise<void> {
  for (const { value, id } of change.assign) {
    const row = await trx.get<{ pos: number }>('SELECT pos FROM test_blocks WHERE id IS NULL AND value = ? ORDER BY pos LIMIT 1', [value]);
    if (row !== null) await trx.run('UPDATE test_blocks SET id = ? WHERE pos = ?', [id, row.pos]);
  }
  for (const { id, value } of change.puts) {
    const updated = await trx.run('UPDATE test_blocks SET value = ? WHERE id = ?', [value, id]);
    if (updated.changes === 0) await trx.run('INSERT INTO test_blocks (pos, id, value) VALUES ((SELECT COALESCE(MAX(pos), 0) + 1 FROM test_blocks), ?, ?)', [id, value]);
  }
  for (const id of change.deletes) await trx.run('DELETE FROM test_blocks WHERE id = ?', [id]);
}

/** One browser profile: its database, its lock, its transport and its client. */
export interface Browser {
  client: MutationClient;
  adapter: StorageAdapter;
  transport: Loopback;
  lock: TabLock;
  blocks(): Promise<Array<{ id: string | null; value: string }>>;
  /** The blocks' values, sorted. */
  values(): Promise<string[]>;
  /** Saves the whole set of blocks, as a person's save of their text. */
  save(blocks: Array<{ id: string | null; value: string }>, allowDeletes?: number): Promise<SaveResult>;
  /** Joins the world's group with the blocks the browser holds. */
  join(): Promise<SyncOutcome>;
  /** A new client over the same database, lock and transport, as a reload of the page. */
  reopen(): Browser;
}

/** Makes a browser in the world; its database is in memory unless the test gives one. */
export async function browser(w: World, settings: { adapter?: StorageAdapter; lock?: TabLock; transport?: Loopback; clientPolicy?: Partial<RowPolicy> } = {}): Promise<Browser> {
  const adapter = settings.adapter ?? new IndexedDbAdapter({ memoryOnly: true });
  await adapter.open();
  await adapter.exec(BLOCKS);
  const lock = settings.lock ?? memoryTabLock();
  const transport = settings.transport ?? loopback(w);
  const make = (): Browser => {
    const client = new MutationClient({
      adapter,
      scope: w.scope,
      lock,
      transport,
      policy: { ...POLICY, ...settings.clientPolicy },
      materialize,
      reload: async () => {
        await (adapter as { reload?: () => Promise<boolean> }).reload?.();
      },
    });
    const self: Browser = {
      client,
      adapter,
      transport,
      lock,
      blocks: async () => (await adapter.all<{ id: string | null; value: string }>('SELECT id, value FROM test_blocks ORDER BY pos')).map((row) => ({ id: row.id, value: row.value })),
      values: async () => (await self.blocks()).map((block) => block.value).sort(),
      save: (blocks, allowDeletes) =>
        client.save({
          rows: blocks.filter((block): block is { id: string; value: string } => block.id !== null),
          allowDeletes,
          write: async (trx) => {
            await trx.run('DELETE FROM test_blocks');
            for (const [index, block] of blocks.entries()) await trx.run('INSERT INTO test_blocks (pos, id, value) VALUES (?, ?, ?)', [index + 1, block.id, block.value]);
          },
        }),
      join: () =>
        client.join({
          group: w.group,
          epoch: w.epoch.current,
          readBlocks: async (trx) => (await trx.all<{ id: string | null; value: string }>('SELECT id, value FROM test_blocks ORDER BY pos')).map((row) => ({ id: row.id, value: row.value, derivedId: null })),
        }),
      reopen: () => make(),
    };
    return self;
  };
  const made = make();
  await made.client.open();
  return made;
}

/** Push and pull on every browser, three rounds, so every answer has come back. */
export async function settle(...browsers: Browser[]): Promise<void> {
  for (let round = 0; round < 3; round += 1) {
    for (const each of browsers) {
      await each.client.push();
      await each.client.pull();
    }
  }
}

/** The server's four tables, read whole, as a nightly dump keeps them. */
export interface Dump {
  tables: Record<string, Array<Record<string, unknown>>>;
}

const TABLES_OF_STORE = ['groups', 'rows', 'clients', 'results'];

/** Dumps the server's tables. */
export async function dump(w: World): Promise<Dump> {
  const tables: Dump['tables'] = {};
  for (const table of TABLES_OF_STORE) tables[table] = await w.opened.adapter.all<Record<string, unknown>>(`SELECT * FROM ${w.opened.prefix}${table}`);
  return { tables };
}

let restores = 0;

/** Restores a dump over the server's tables and changes the restore epoch, as the restore command does. */
export async function restore(w: World, saved: Dump): Promise<void> {
  await w.opened.adapter.transaction(async (trx) => {
    for (const table of [...TABLES_OF_STORE].reverse()) await trx.run(`DELETE FROM ${w.opened.prefix}${table}`);
    for (const table of TABLES_OF_STORE) {
      for (const row of saved.tables[table]) {
        const columns = Object.keys(row);
        await trx.run(`INSERT INTO ${w.opened.prefix}${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`, columns.map((column) => row[column]));
      }
    }
  });
  restores += 1;
  w.epoch.current = hex(0xe100 + restores);
}
