/**
 * Content revisions, amend, claim and protocol 2 as a consumer meets them. The server half comes from the package's
 * `./sync` entry and answers two HTTP routes on a real socket, as a product's routes call it; each page's half comes
 * from the `./browser` entry, keeps its data in an in-memory IndexedDB adapter and reaches the routes over the fetch
 * transport. The store runs on every database the sync suites run on. Each case drives the pages as a person's edits
 * and reloads do (join, save, push, pull, reopen) and reads what reached the routes, what they answered and what each
 * page shows.
 */
import 'fake-indexeddb/auto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import * as browser from '../../src/browser';
import * as sync from '../../src/features/sync';
import type { ClientSnapshot, RowComposer, RowPolicy, SaveResult, StorageAdapter, SyncOutcome, TabLock, VisibleChange } from '../../src/browser';
import type { MutationServer, MutationServerOptions, PullRequest, PullResponse, PushRequest, ValueCodec } from '../../src/features/sync';
import { backends, type Backend, type OpenedBackend } from './backends';

const BACKENDS = await backends();

const hex = (n: number): string => n.toString(16).padStart(32, '0');
const delta = (add: string[], remove: string[] = []): string => JSON.stringify({ add, remove });

/** A note's value, "content|tag,tag": its content before the bar, its tags after it; a delta removes tags, then adds the new ones in order. */
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

/** The limits, the copy's naming and the composer, the same on the server and on every page. */
const POLICY: RowPolicy = {
  maxRows: 50,
  maxUnits: 30_000,
  copyValue: (value) => {
    const [text = '', tags = ''] = value.split('|');
    return `${text} (copy)|${tags}`;
  },
  composer,
};

/** Seals a value with its scope and row, as an encrypting codec's authenticated data binds it. */
const codec: ValueCodec = {
  async seal(value, place) {
    return Buffer.from(JSON.stringify([place.scope, place.id, value]), 'utf8').toString('base64');
  },
  async open(stored, place) {
    const opened = JSON.parse(Buffer.from(stored, 'base64').toString('utf8')) as unknown;
    if (!Array.isArray(opened) || opened[0] !== place.scope || opened[1] !== place.id || typeof opened[2] !== 'string') throw new sync.UnreadableValue();
    return opened[2];
  },
};

/** The store's tables as the release before content revisions made them: the same statements without the content columns. */
function previousStoreDdl(prefix: string): string[] {
  return sync.mutationStoreDdl(prefix).map((statement) => statement.replaceAll(', content_for TEXT', '').replaceAll(', content_client TEXT, content_mutation BIGINT', ''));
}

/** A request body as it reached a route. */
interface WireBody {
  clientId: string;
  protocol?: number;
  mutations?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
}

/** The server, its database and its two routes. */
interface Site {
  opened: OpenedBackend;
  scope: string;
  group: string;
  epoch: string;
  options: MutationServerOptions;
  /** The server the routes call; a case replaces it to narrow its protocols. */
  server: MutationServer;
  /** Every body the routes read, in order. */
  bodies: Array<{ route: 'push' | 'pull'; body: WireBody }>;
  pushUrl: string;
  pullUrl: string;
  close(): Promise<void>;
}

/** The two routes, as a product's call the server: the scope from the session, the body read by the server's parsers. */
async function route(at: Site, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  let text = '';
  request.setEncoding('utf8');
  for await (const chunk of request) text += chunk;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    response.writeHead(400).end();
    return;
  }
  const context = { scope: at.scope, epoch: at.epoch };
  if (path === '/push') {
    at.bodies.push({ route: 'push', body: body as WireBody });
    let parsed: PushRequest;
    try {
      parsed = at.server.parsePush(body);
    } catch (error) {
      if (!(error instanceof sync.WireError)) throw error;
      response.writeHead(400).end();
      return;
    }
    const answer = await at.server.push(context, parsed);
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer));
    return;
  }
  if (path === '/pull') {
    at.bodies.push({ route: 'pull', body: body as WireBody });
    let parsed: PullRequest;
    try {
      parsed = sync.parsePullRequest(body);
    } catch (error) {
      if (!(error instanceof sync.WireError)) throw error;
      response.writeHead(400).end();
      return;
    }
    const opening = await at.server.pull(context, parsed);
    if (opening.kind !== 'stream') {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(opening));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    for await (const chunk of opening.chunks) response.write(chunk);
    response.end();
    await opening.done;
    return;
  }
  response.writeHead(404).end();
}

/** Makes the store's tables (this release's, or the previous one's), the scope's group, the server and its routes. */
async function site(backend: Backend, settings: { previous?: boolean } = {}): Promise<Site> {
  const opened = await backend.open();
  const statements = settings.previous === true ? previousStoreDdl(opened.prefix) : sync.mutationStoreDdl(opened.prefix);
  for (const statement of statements) await opened.adapter.exec(statement);
  const scope = hex(0x5c09e);
  const group = hex(0x6409);
  await sync.createSqlGroup(opened.adapter, opened.prefix, scope, group);
  const options: MutationServerOptions = { adapter: opened.adapter, store: sync.createSqlMutationStore({ prefix: opened.prefix }), codec, policy: POLICY, maxMutations: 50 };
  const at: Site = {
    opened,
    scope,
    group,
    epoch: hex(0xe1),
    options,
    server: new sync.MutationServer(options),
    bodies: [],
    pushUrl: '',
    pullUrl: '',
    close: () => opened.close(),
  };
  const http = createServer((request, response) => {
    void route(at, request, response).catch((error: unknown) => {
      if (response.headersSent) response.destroy(error instanceof Error ? error : new Error(String(error)));
      else response.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', () => resolve()));
  const { port } = http.address() as AddressInfo;
  at.pushUrl = `http://127.0.0.1:${port}/push`;
  at.pullUrl = `http://127.0.0.1:${port}/pull`;
  at.close = async () => {
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await opened.close();
  };
  return at;
}

/** Each mutation that reached the push route, once, as it first came: a page sends a pending one again until a pull acknowledges it. */
function received(at: Site): Array<{ clientId: string; id: string; name: string; args: Record<string, unknown> }> {
  const seen = new Set<string>();
  const mutations: Array<{ clientId: string; id: string; name: string; args: Record<string, unknown> }> = [];
  for (const { route: path, body } of at.bodies) {
    if (path !== 'push') continue;
    for (const mutation of body.mutations ?? []) {
      const key = `${body.clientId}:${mutation.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      mutations.push({ clientId: body.clientId, ...mutation });
    }
  }
  return mutations;
}

/** A whole pull in protocol 2 over the routes, as a page's transport asks for one. */
async function fullPull(at: Site, clientId: string = hex(0xf00d)): Promise<PullResponse> {
  const transport = browser.createFetchMutationTransport({ pushUrl: at.pushUrl, pullUrl: at.pullUrl });
  const answer = await transport.pull({ group: at.group, epoch: at.epoch, clientId, cookie: null, protocol: browser.PROTOCOL });
  if (answer.kind !== 'pull') throw new Error(`the pull was answered ${answer.kind}`);
  return answer;
}

/** A request as a page of the previous release sends it, with the answer's status and JSON. */
async function post(url: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, json: JSON.parse(await response.text()) as Record<string, unknown> };
}

/** The ids of the store's rows, tombstones included. */
async function storedIds(at: Site): Promise<string[]> {
  return (await at.opened.adapter.all<{ id: string }>(`SELECT id FROM ${at.opened.prefix}rows`)).map((row) => row.id).sort();
}

/** The page's own data: its note's blocks in order, each with its row id once it has one. */
const BLOCKS = 'CREATE TABLE IF NOT EXISTS page_blocks (pos INTEGER PRIMARY KEY, id TEXT, value TEXT NOT NULL)';

/** Writes a change of the visible rows into the page's blocks: ids given to unmarked blocks, values put by id, rows removed. */
async function materialize(trx: StorageAdapter, change: VisibleChange): Promise<void> {
  for (const { value, id } of change.assign) {
    const row = await trx.get<{ pos: number }>('SELECT pos FROM page_blocks WHERE id IS NULL AND value = ? ORDER BY pos LIMIT 1', [value]);
    if (row !== null) await trx.run('UPDATE page_blocks SET id = ? WHERE pos = ?', [id, row.pos]);
  }
  for (const { id, value } of change.puts) {
    const updated = await trx.run('UPDATE page_blocks SET value = ? WHERE id = ?', [value, id]);
    if (updated.changes === 0) await trx.run('INSERT INTO page_blocks (pos, id, value) VALUES ((SELECT COALESCE(MAX(pos), 0) + 1 FROM page_blocks), ?, ?)', [id, value]);
  }
  for (const id of change.deletes) await trx.run('DELETE FROM page_blocks WHERE id = ?', [id]);
}

/** One page: its database, its client over the fetch transport, and what a person does there. */
interface Page {
  client: browser.MutationClient;
  adapter: browser.IndexedDbAdapter;
  /** The page's note: its blocks in order, with their row ids. */
  blocks(): Promise<Array<{ id: string; value: string }>>;
  /** The values the page's note holds, sorted. */
  values(): Promise<string[]>;
  /** Saves the note: its blocks written and the rows they hold, a row marked `claim` at an id the page derived. */
  save(rows: ReadonlyArray<{ id: string; value: string; claim?: boolean }>): Promise<SaveResult>;
  /** Joins the site's group with the blocks the page holds. */
  join(): Promise<SyncOutcome>;
  /** The same page loaded again: a new client over the same database and lock, opened. */
  reload(): Promise<Page>;
}

async function pageOn(at: Site, adapter: browser.IndexedDbAdapter, lock: TabLock): Promise<Page> {
  const client = new browser.MutationClient({
    adapter,
    scope: at.scope,
    lock,
    transport: browser.createFetchMutationTransport({ pushUrl: at.pushUrl, pullUrl: at.pullUrl }),
    policy: POLICY,
    materialize,
    reload: () => adapter.reload(),
  });
  await client.open();
  return {
    client,
    adapter,
    blocks: async () =>
      (await adapter.all<{ id: string | null; value: string }>('SELECT id, value FROM page_blocks ORDER BY pos')).flatMap((row) => (row.id === null ? [] : [{ id: row.id, value: row.value }])),
    values: async () => (await adapter.all<{ value: string }>('SELECT value FROM page_blocks')).map((row) => row.value).sort(),
    save: (rows) =>
      client.save({
        rows,
        write: async (trx) => {
          await trx.run('DELETE FROM page_blocks');
          for (const [index, row] of rows.entries()) await trx.run('INSERT INTO page_blocks (pos, id, value) VALUES (?, ?, ?)', [index + 1, row.id, row.value]);
        },
      }),
    join: () =>
      client.join({
        group: at.group,
        epoch: at.epoch,
        readBlocks: async (trx) => (await trx.all<{ id: string | null; value: string }>('SELECT id, value FROM page_blocks ORDER BY pos')).map((row) => ({ id: row.id, value: row.value, derivedId: null })),
      }),
    reload: () => pageOn(at, adapter, lock),
  };
}

/** A new page on the site: an in-memory database with the note's table, its own lock, its client opened. */
async function openPage(at: Site): Promise<Page> {
  const adapter = new browser.IndexedDbAdapter({ memoryOnly: true });
  await adapter.open();
  await adapter.exec(BLOCKS);
  return pageOn(at, adapter, browser.memoryTabLock());
}

/** Pushes and pulls on every page, three rounds, so every answer has come back. */
async function settle(...pages: Page[]): Promise<void> {
  for (let round = 0; round < 3; round += 1) {
    for (const each of pages) {
      await each.client.push();
      await each.client.pull();
    }
  }
}

const idOf = async (page: Page): Promise<string> => (await page.client.snapshot()).membership.clientId as string;
const keptOf = (snapshot: ClientSnapshot): Array<[string, string]> => snapshot.kept.map((row) => [row.reason, row.value]);

describe('the entries a consumer imports', () => {
  it('carry protocol 2 and the content revision parts: the server half through ./sync, the page half through ./browser', () => {
    expect([sync.PROTOCOL, browser.PROTOCOL]).toEqual([2, 2]);
    expect(sync.ROW_MUTATIONS).toEqual(['create', 'edit', 'delete', 'repair', 'amend', 'claim']);
    expect(browser.ROW_MUTATIONS).toBe(sync.ROW_MUTATIONS);
    for (const name of ['MutationServer', 'createSqlMutationStore', 'mutationStoreDdl', 'upgradeSqlMutationStore', 'applyRowMutation', 'planRowChanges', 'incomingValue', 'parsePushAnswer', 'parsePullRefusal', 'MutationClient', 'upgradeClientTables']) {
      expect(sync).toHaveProperty(name);
    }
    for (const name of ['MutationClient', 'upgradeClientTables', 'createFetchMutationTransport', 'IndexedDbAdapter', 'applyRowMutation', 'planRowChanges', 'incomingValue', 'parsePushAnswer', 'parsePullRefusal']) {
      expect(browser).toHaveProperty(name);
    }
    // the page's entry carries no server half
    expect(browser).not.toHaveProperty('MutationServer');
    expect(browser).not.toHaveProperty('upgradeSqlMutationStore');
  });
});

describe.each(BACKENDS.map((backend) => [backend.name, backend] as const))('through the entries, a server on %s behind its routes', (_name, backend) => {
  let current: Site | undefined;
  const start = async (settings?: { previous?: boolean }): Promise<Site> => {
    current = await site(backend, settings);
    return current;
  };
  afterEach(async () => {
    await current?.close();
    current = undefined;
  });

  it.each(['tags', 'content'] as const)('lands a tags-only save and a content save made on one base, the %s push first, with no copy and both revisions answered', async (first) => {
    const s = await start();
    const a = await openPage(s);
    await a.join();
    await a.save([{ id: hex(1), value: 'text|' }]);
    await settle(a);
    const b = await openPage(s);
    await b.join();
    await a.save([{ id: hex(1), value: 'text|budget' }]);
    await b.save([{ id: hex(1), value: 'new text|' }]);
    const [one, two] = first === 'tags' ? [a, b] : [b, a];
    await one.client.push();
    await two.client.push();
    await settle(a, b);
    expect(await a.values()).toEqual(['new text|budget']);
    expect(await b.values()).toEqual(['new text|budget']);
    expect((await a.client.snapshot()).kept).toEqual([]);
    expect((await b.client.snapshot()).kept).toEqual([]);
    const aId = await idOf(a);
    const bId = await idOf(b);
    const base = { client: aId, mutation: '1' };
    // what reached the push route: a delta alone for the tags, the content alone for the text, both on the same base
    const tags = { clientId: aId, id: '2', name: 'amend', args: { id: hex(1), expected: base, expectedContent: base, content: null, delta: delta(['budget']) } };
    const text = { clientId: bId, id: '1', name: 'amend', args: { id: hex(1), expected: base, expectedContent: base, content: 'new text', delta: null } };
    expect(received(s).filter((mutation) => mutation.name === 'amend')).toEqual(first === 'tags' ? [tags, text] : [text, tags]);
    const contentRevision = { client: bId, mutation: '1' };
    expect((await fullPull(s)).patch).toEqual([
      { op: 'put', id: hex(1), value: 'new text|budget', revision: first === 'tags' ? contentRevision : { client: aId, mutation: '2' }, version: expect.any(String), contentRevision },
    ]);
    expect((await fullPull(s, bId)).results).toEqual([expect.objectContaining({ mutationId: '1', outcome: 'applied', targetId: hex(1), revision: contentRevision, contentRevision })]);
    expect(s.bodies.map(({ body }) => body.protocol)).toEqual(s.bodies.map(() => browser.PROTOCOL));
  }, 30_000);

  it('keeps different content made on an older content revision as one copy with the current tags and its own, the note as the other page left it', async () => {
    const s = await start();
    const a = await openPage(s);
    await a.join();
    await a.save([{ id: hex(1), value: 'text|' }]);
    await settle(a);
    const b = await openPage(s);
    await b.join();
    await a.save([{ id: hex(1), value: 'theirs|x' }]);
    await settle(a);
    await b.save([{ id: hex(1), value: 'mine|y' }]);
    await settle(b, a);
    expect(await a.values()).toEqual(['mine (copy)|x,y', 'theirs|x']);
    expect(await b.values()).toEqual(['mine (copy)|x,y', 'theirs|x']);
    const bId = await idOf(b);
    const copyId = await sync.copyIdOf({ group: s.group, clientId: bId, mutationId: '1' });
    expect(await storedIds(s)).toEqual([hex(1), copyId].sort());
    expect((await fullPull(s, bId)).results).toEqual([expect.objectContaining({ mutationId: '1', outcome: 'copied', targetId: copyId })]);
  }, 30_000);

  it.each([
    ['push-first', 'live'],
    ['pull-first', 'tombstone'],
  ] as const)('keeps a claim refused occupied aside with the change made on it, %s, a %s row at its id, through a later save and a reload', async (order, held) => {
    const s = await start();
    const a = await openPage(s);
    let b = await openPage(s);
    await a.join();
    await b.join();
    await a.save([{ id: hex(7), value: 'copy|', claim: true }]);
    await settle(a);
    if (held === 'tombstone') {
      await a.save([]);
      await settle(a);
    }
    await b.save([{ id: hex(7), value: 'copy|x', claim: true }]);
    await b.save([{ id: hex(7), value: 'copy|x,y' }]);
    const shownByServer = held === 'live' ? ['copy|'] : [];
    if (order === 'pull-first') {
      await b.client.pull();
      expect((await b.client.snapshot()).visible.filter((row) => row.id === hex(7)).map((row) => row.value)).toEqual(shownByServer);
      b = await b.reload();
    }
    await settle(b, a);
    const snapshot = await b.client.snapshot();
    expect(snapshot.visible.filter((row) => row.id === hex(7)).map((row) => row.value)).toEqual(shownByServer);
    expect(keptOf(snapshot)).toEqual([['occupied', 'copy|x,y']]);
    expect(snapshot.pending).toBe(0);
    expect(await storedIds(s)).toEqual([hex(7)]);
    const results = (await fullPull(s, await idOf(b))).results;
    expect(results.map((result) => [result.mutationId, result.outcome, result.reason, result.contentRevision])).toEqual([
      ['1', 'refused', 'occupied', null],
      ['2', 'refused', 'occupied', null],
    ]);
    // an unrelated save that leaves the kept row out, a sync and a reload keep it as it was
    await b.save([...snapshot.visible.map(({ id, value }) => ({ id, value })), { id: hex(8), value: 'unrelated|' }]);
    await settle(b, a);
    const reloaded = await b.reload();
    const after = await reloaded.client.snapshot();
    expect(after.kept).toEqual(snapshot.kept);
    expect(after.pending).toBe(0);
    expect(await a.values()).toEqual([...shownByServer, 'unrelated|'].sort());
  }, 30_000);

  it('restores an occupied claim when the person asks: the page gets it, the next save of the note keeps it, and the account holds both values', async () => {
    const s = await start();
    const a = await openPage(s);
    const b = await openPage(s);
    await a.join();
    await b.join();
    await a.save([{ id: hex(7), value: 'copy|', claim: true }]);
    await settle(a);
    await b.save([{ id: hex(7), value: 'copy|x', claim: true }]);
    await settle(b, a);
    const [kept] = (await b.client.snapshot()).kept;
    expect([kept?.reason, kept?.value]).toEqual(['occupied', 'copy|x']);
    expect(await b.values()).toEqual(['copy|']);
    expect(await b.client.restoreKept(kept!.id)).toBe(true);
    // the restored value is in the page's note at once, so the note's next save sends it and deletes nothing
    expect(await b.values()).toEqual(['copy|', 'copy|x']);
    await b.save(await b.blocks());
    await settle(b, a);
    expect(await b.values()).toEqual(['copy|', 'copy|x']);
    expect(await a.values()).toEqual(['copy|', 'copy|x']);
    expect((await b.client.snapshot()).kept).toEqual([]);
    expect((await b.client.snapshot()).pending).toBe(0);
    expect((await fullPull(s)).patch.flatMap((entry) => (entry.op === 'put' ? [entry.value] : [])).sort()).toEqual(['copy|', 'copy|x']);
  }, 30_000);

  it('takes a claim of the same value as a no-op and applies the delete made on it at the existing whole revision', async () => {
    const s = await start();
    const a = await openPage(s);
    const b = await openPage(s);
    await a.join();
    await b.join();
    await a.save([{ id: hex(1), value: 'text|' }]);
    await settle(a);
    await b.save([{ id: hex(1), value: 'text|', claim: true }]);
    await b.save([]);
    await settle(b, a);
    expect(await a.values()).toEqual([]);
    expect(await b.values()).toEqual([]);
    expect((await b.client.snapshot()).kept).toEqual([]);
    const aId = await idOf(a);
    const bId = await idOf(b);
    expect((await fullPull(s, bId)).results.map((result) => [result.outcome, result.revision])).toEqual([
      ['noop', { client: aId, mutation: '1' }],
      ['applied', { client: bId, mutation: '2' }],
    ]);
    expect((await fullPull(s)).patch).toEqual([expect.objectContaining({ op: 'del', id: hex(1) })]);
  }, 30_000);

  it('refuses a delete made before a tags-only change the deleting page had not seen, and gives that page the note back with the tags', async () => {
    const s = await start();
    const a = await openPage(s);
    await a.join();
    await a.save([{ id: hex(1), value: 'text|' }]);
    await settle(a);
    const b = await openPage(s);
    await b.join();
    await a.save([{ id: hex(1), value: 'text|budget' }]);
    await settle(a);
    await b.save([]);
    await settle(b, a);
    expect(await b.values()).toEqual(['text|budget']);
    expect(await a.values()).toEqual(['text|budget']);
    expect((await b.client.snapshot()).kept).toEqual([]);
    expect((await fullPull(s, await idOf(b))).results).toEqual([
      expect.objectContaining({ mutationId: '1', outcome: 'refused', reason: 'stale', revision: null, contentRevision: null }),
    ]);
  }, 30_000);

  it('answers a page of the previous release in protocol 1 with exactly its keys, and once narrowed to protocol 2 refuses it before taking its mutation id', async () => {
    const s = await start();
    const old = hex(0x01d);
    const revision = { client: old, mutation: '1' };
    const create = { group: s.group, epoch: s.epoch, clientId: old, mutations: [{ id: '1', name: 'create', args: { id: hex(4), value: 'old|' } }] };
    const ask = { group: s.group, epoch: s.epoch, clientId: old, cookie: null };
    expect(await post(s.pushUrl, create)).toEqual({ status: 200, json: { kind: 'ok', processed: 1 } });
    const drained = await post(s.pullUrl, ask);
    expect(drained.status).toBe(200);
    expect(drained.json.patch).toEqual([{ op: 'put', id: hex(4), value: 'old|', revision, version: '1' }]);
    expect(drained.json.results).toEqual([{ clientId: old, mutationId: '1', outcome: 'applied', reason: null, targetId: hex(4), revision, version: '1' }]);
    const modern = await post(s.pullUrl, { ...ask, protocol: 2 });
    expect(modern.json.patch).toEqual([{ op: 'put', id: hex(4), value: 'old|', revision, version: '1', contentRevision: revision }]);
    expect(modern.json.results).toEqual([{ clientId: old, mutationId: '1', outcome: 'applied', reason: null, targetId: hex(4), revision, version: '1', contentRevision: revision }]);
    s.server = new sync.MutationServer({ ...s.options, protocols: [2] });
    const removal = { ...create, mutations: [{ id: '2', name: 'delete', args: { id: hex(4), expected: revision } }] };
    expect(await post(s.pushUrl, removal)).toEqual({ status: 200, json: { kind: 'protocol_changed', protocols: [2] } });
    expect(await post(s.pullUrl, ask)).toEqual({ status: 200, json: { kind: 'protocol_changed', protocols: [2] } });
    const after = await fullPull(s, old);
    expect(after.lastMutationIds[old]).toBe('1');
    expect(after.patch).toEqual([expect.objectContaining({ op: 'put', id: hex(4), value: 'old|' })]);
  }, 30_000);

  it('serves a store the previous release made once upgradeSqlMutationStore has run twice: its row takes its revision as its content revision and takes a tags-only save', async () => {
    const s = await start({ previous: true });
    const { adapter, prefix } = s.opened;
    expect(previousStoreDdl(prefix).join('\n')).not.toContain('content_');
    await expect(adapter.all(`SELECT content_client FROM ${prefix}rows WHERE 1 = 0`)).rejects.toThrow();
    // what the previous release's server wrote for one create of an older page
    const old = hex(0x01d);
    const revision = { client: old, mutation: '1' };
    await adapter.run(`UPDATE ${prefix}groups SET version = 1 WHERE scope = ?`, [s.scope]);
    await adapter.run(`INSERT INTO ${prefix}rows (scope, id, state, stored, rev_client, rev_mutation, version, deleted_at, updated_at) VALUES (?, ?, 'live', ?, ?, 1, 1, NULL, ?)`, [
      s.scope,
      hex(4),
      await codec.seal('old|', { scope: s.scope, id: hex(4) }),
      old,
      '2026-10-15T00:00:00.000Z',
    ]);
    await adapter.run(`INSERT INTO ${prefix}clients (scope, grp, client_id, last_mutation_id) VALUES (?, ?, ?, 1)`, [s.scope, s.group, old]);
    await adapter.run(`INSERT INTO ${prefix}results (scope, grp, client_id, mutation_id, outcome, reason, target_id, rev_client, rev_mutation, version) VALUES (?, ?, ?, 1, 'applied', NULL, ?, ?, 1, 1)`, [
      s.scope,
      s.group,
      old,
      hex(4),
      old,
    ]);
    await sync.upgradeSqlMutationStore(adapter, prefix);
    await sync.upgradeSqlMutationStore(adapter, prefix);
    const a = await openPage(s);
    await a.join();
    expect((await a.client.snapshot()).visible).toEqual([expect.objectContaining({ id: hex(4), value: 'old|', revision, contentRevision: revision })]);
    await a.save([{ id: hex(4), value: 'old|kept' }]);
    await settle(a);
    expect(await a.values()).toEqual(['old|kept']);
    expect((await a.client.snapshot()).kept).toEqual([]);
    expect((await fullPull(s)).patch).toEqual([expect.objectContaining({ op: 'put', id: hex(4), value: 'old|kept', revision: { client: await idOf(a), mutation: '1' }, contentRevision: revision })]);
    expect(await storedIds(s)).toEqual([hex(4)]);
  }, 30_000);

  it('retires the queue a page of the previous release left: its pending values kept for recovery, a new client id, and only protocol 2 at the routes after', async () => {
    const s = await start();
    const a = await openPage(s);
    await a.join();
    await a.save([{ id: hex(9), value: 'archived|' }]);
    await settle(a);
    await a.save([]);
    await settle(a); // the archived value is in the journal alone, acknowledged
    await a.save([{ id: hex(1), value: 'one|' }, { id: hex(2), value: 'two|' }]);
    const before = await a.client.snapshot();
    expect(before.pending).toBe(2);
    const oldId = before.membership.clientId as string;
    // the page's database as the previous release left it: no content revisions, no protocol on the membership, no
    // issued value in the journal, no retired clients
    for (const statement of [
      'ALTER TABLE sync_rows DROP COLUMN content_client',
      'ALTER TABLE sync_rows DROP COLUMN content_mutation',
      'ALTER TABLE sync_results DROP COLUMN content_client',
      'ALTER TABLE sync_results DROP COLUMN content_mutation',
      'ALTER TABLE sync_membership DROP COLUMN protocol',
      'ALTER TABLE sync_journal DROP COLUMN incoming_value',
      'DROP TABLE sync_retired_clients',
    ]) {
      await a.adapter.run(statement);
    }
    const sentBefore = s.bodies.length;
    const reloaded = await a.reload();
    const after = await reloaded.client.snapshot();
    expect(after.pending).toBe(0);
    expect(after.membership.state).toBe('joined');
    expect(after.membership.clientId).not.toBe(oldId);
    // only what the queue still held: the archived value the account acknowledged stays in the journal, out of the page
    expect(keptOf(after).sort()).toEqual([
      ['recovery', 'one|'],
      ['recovery', 'two|'],
    ]);
    expect(s.bodies.length).toBe(sentBefore);
    // the note as the page holds it, saved again with a new block, goes out under the new id alone
    await reloaded.save([{ id: hex(1), value: 'one|' }, { id: hex(2), value: 'two|' }, { id: hex(3), value: 'three|' }]);
    await settle(reloaded);
    const sent = s.bodies.slice(sentBefore);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.map(({ body }) => [body.protocol, body.clientId])).toEqual(sent.map(() => [browser.PROTOCOL, after.membership.clientId]));
    expect(received(s).filter((mutation) => mutation.clientId === oldId).map((mutation) => mutation.name)).toEqual(['create', 'delete']);
    expect((await reloaded.client.snapshot()).pending).toBe(0);
    const puts = (await fullPull(s)).patch.flatMap((entry) => (entry.op === 'put' ? [[entry.id, entry.value]] : []));
    expect(puts).toEqual([
      [hex(1), 'one|'],
      [hex(2), 'two|'],
      [hex(3), 'three|'],
    ]);
  }, 30_000);

  it('stops a page sending when the server no longer takes its protocol, keeping its change, and refuses a page that joins then', async () => {
    const s = await start();
    const a = await openPage(s);
    await a.join();
    s.server = new sync.MutationServer({ ...s.options, protocols: [3] });
    await a.save([{ id: hex(1), value: 'one|' }]);
    expect(await a.client.push()).toEqual({ kind: 'blocked' });
    const snapshot = await a.client.snapshot();
    expect([snapshot.membership.sends, snapshot.pending]).toEqual(['malformed', 1]);
    const count = s.bodies.length;
    expect(await a.client.push()).toEqual({ kind: 'idle' });
    expect(s.bodies.length).toBe(count);
    const late = await openPage(s);
    expect(await late.join()).toEqual({ kind: 'blocked' });
    expect((await late.client.snapshot()).membership.state).toBe('off');
    expect(await storedIds(s)).toEqual([]);
  }, 30_000);
});
