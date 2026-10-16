import { describe, expect, it, afterAll, beforeAll } from 'vitest';
import {
  PostgresFts,
  SqliteFts4,
  SqliteFts5,
  createDatabase,
  createPostgresAdapter,
  createSqlJsAdapter,
  createStorageFeatures,
  type IFullTextSearch,
  type StorageAdapter,
} from '../src/index.js';

// Full-text search through createStorageFeatures returns the same rows on
// PostgreSQL (tsvector), better-sqlite3 (FTS5) and sql.js (FTS4: its stock
// build has FTS3 and FTS4, not FTS5). On PostgreSQL each index keeps its own
// language, a features object made later can rebuild and sync an index made
// earlier, and column weights order the results.

const POSTGRES_TEST_URL = process.env.POSTGRES_TEST_URL;

const engines: Array<[string, () => Promise<StorageAdapter>]> = [
  ['better-sqlite3', () => createDatabase({ type: 'memory' })],
  [
    'sql.js',
    async () => {
      const adapter = createSqlJsAdapter();
      await adapter.open();
      return adapter;
    },
  ],
];
if (POSTGRES_TEST_URL) {
  engines.push([
    'PostgreSQL',
    async () => {
      const adapter = createPostgresAdapter(POSTGRES_TEST_URL);
      await adapter.open();
      return adapter;
    },
  ]);
}

describe('createStorageFeatures picks the full-text search each engine has', () => {
  const fake = (kind: string): StorageAdapter => ({ kind }) as unknown as StorageAdapter;

  it('gives sql.js and IndexedDB FTS4, better-sqlite3 FTS5, and the Supabase adapter PostgreSQL', () => {
    expect(createStorageFeatures(fake('sqljs')).fts).toBeInstanceOf(SqliteFts4);
    expect(createStorageFeatures(fake('indexeddb')).fts).toBeInstanceOf(SqliteFts4);
    expect(createStorageFeatures(fake('better-sqlite3')).fts).toBeInstanceOf(SqliteFts5);
    expect(createStorageFeatures(fake('supabase-postgres')).fts).toBeInstanceOf(PostgresFts);
    expect(createStorageFeatures(fake('supabase-postgres')).dialect.name).toBe('postgres');
  });
});

describe.each(engines)('full-text search parity on %s', (_engine, openAdapter) => {
  let db: StorageAdapter;
  let fts: IFullTextSearch;
  const suffix = Math.random().toString(36).slice(2, 8);
  const docs = `fts_docs_${suffix}`;
  const index = `fts_docs_${suffix}_index`;

  const search = (query: string): Promise<Array<{ id: number }>> =>
    db.all<{ id: number }>(
      `SELECT d.id FROM ${fts.joinClause(docs, 'd', index, index)} WHERE ${fts.matchClause(index, '@q')} ORDER BY ${fts.relevanceOrder(index, '@q')}, d.id`,
      { q: query },
    );

  beforeAll(async () => {
    db = await openAdapter();
    fts = createStorageFeatures(db).fts;
    await db.exec(`CREATE TABLE ${docs} (id INTEGER PRIMARY KEY, title TEXT, body TEXT)`);
    const rows: Array<[number, string, string]> = [
      [1, 'Quick fox', 'The quick brown fox jumps'],
      [2, 'Lazy dog', 'A lazy dog sleeps all day'],
      [3, 'Foxes', 'fox fox fox everywhere, foxes'],
    ];
    for (const row of rows) await db.run(`INSERT INTO ${docs} (id, title, body) VALUES (?, ?, ?)`, row);
    await db.exec(fts.createIndex({ table: index, columns: ['title', 'body'], contentTable: docs, tokenizer: 'porter ascii' }));
    await db.exec(fts.rebuildCommand(index));
  });

  afterAll(async () => {
    await db.exec(`DROP TABLE IF EXISTS ${index}`).catch(() => undefined);
    await db.exec(`DROP TABLE IF EXISTS ${docs}`).catch(() => undefined);
    await db.close();
  });

  it('finds the documents a stemmed term matches, the closest match first', async () => {
    expect(await search('fox')).toEqual([{ id: 3 }, { id: 1 }]);
    expect(await search('sleeping')).toEqual([{ id: 2 }]);
    expect(await search('cat')).toEqual([]);
  });

  it('indexes a row added after the index through syncInsert', async () => {
    await db.run(`INSERT INTO ${docs} (id, title, body) VALUES (?, ?, ?)`, [4, 'Den', 'a quiet place for a sleepy dog']);
    await db.run(fts.syncInsert(index, '?', ['title', 'body']), [4, 'Den', 'a quiet place for a sleepy dog']);

    expect((await search('dog')).map((row) => row.id).sort()).toEqual([2, 4]);
  });

  it('searches with a sanitized query the same way', async () => {
    expect((await search(fts.sanitizeQuery('fox "lazy"'))).map((row) => row.id).sort()).toEqual([1, 2, 3]);
  });
});

describe.skipIf(!POSTGRES_TEST_URL)('PostgreSQL full-text search without hidden state', () => {
  let db: StorageAdapter;
  const suffix = Math.random().toString(36).slice(2, 8);
  const english = `fts_en_${suffix}`;
  const simple = `fts_simple_${suffix}`;
  const weighted = `fts_weighted_${suffix}`;

  beforeAll(async () => {
    db = createPostgresAdapter(POSTGRES_TEST_URL as string);
    await db.open();
    for (const table of [english, simple, weighted]) {
      await db.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, title TEXT, body TEXT)`);
      await db.run(`INSERT INTO ${table} (id, title, body) VALUES (1, 'running', 'nothing here'), (2, 'nothing', 'running')`);
    }
  });

  afterAll(async () => {
    for (const table of [english, simple, weighted]) await db.exec(`DROP TABLE IF EXISTS ${table}`).catch(() => undefined);
    await db.close();
  });

  it('keeps each index its own language on one features object', async () => {
    const fts = createStorageFeatures(db).fts;
    await db.exec(fts.createIndex({ table: `${english}_index`, columns: ['title', 'body'], contentTable: english, tokenizer: 'porter' }));
    await db.exec(fts.createIndex({ table: `${simple}_index`, columns: ['title', 'body'], contentTable: simple, tokenizer: 'unicode61' }));

    const count = async (table: string): Promise<number> =>
      (await db.all(`SELECT id FROM ${table} WHERE ${fts.matchClause(`${table}_index`, '?')}`, ['run'])).length;
    expect(await count(english)).toBe(2);
    expect(await count(simple)).toBe(0);
  });

  it('rebuilds and syncs, from a features object made later, an index an earlier one made', async () => {
    const later = createStorageFeatures(db).fts;
    await db.run(`INSERT INTO ${english} (id, title, body) VALUES (3, 'runs', 'later')`);
    await db.run(later.syncInsert(`${english}_index`, '?', ['title', 'body']), [3, 'runs', 'later']);
    await db.exec(later.rebuildCommand(`${english}_index`));

    expect((await db.all(`SELECT id FROM ${english} WHERE ${later.matchClause(`${english}_index`, '?')} ORDER BY id`, ['run'])).length).toBe(3);
  });

  it('orders by the column weights it was given', async () => {
    const fts = createStorageFeatures(db).fts as PostgresFts;
    await db.exec(fts.createIndex({ table: `${weighted}_index`, columns: ['title', 'body'], contentTable: weighted, tokenizer: 'porter', weights: { title: 'A', body: 'D' } }));

    const rows = await db.all<{ id: number }>(
      `SELECT id FROM ${weighted} WHERE ${fts.matchClause(`${weighted}_index`, '@q')} ORDER BY ${fts.relevanceOrder(`${weighted}_index`, '@q')}, id`,
      { q: 'running' },
    );
    expect(rows).toEqual([{ id: 1 }, { id: 2 }]);
  });
});
