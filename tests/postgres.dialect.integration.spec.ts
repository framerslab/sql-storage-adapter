import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolveStorageAdapter, createStorageFeatures } from '../src/index.js';
import type { StorageAdapter, StorageFeatures } from '../src/index.js';

// Runs against the server POSTGRES_TEST_URL names; CI starts a PostgreSQL 16
// service and sets it. The suite read DATABASE_URL before, which also moves the
// resolver's default to Postgres, so a run that set it changed what the other
// suites opened.
const POSTGRES_TEST_URL = process.env.POSTGRES_TEST_URL;

describe.skipIf(!POSTGRES_TEST_URL)('Postgres dialect integration', () => {
  let adapter: StorageAdapter;
  let features: StorageFeatures;

  beforeAll(async () => {
    adapter = await resolveStorageAdapter({
      postgres: { connectionString: POSTGRES_TEST_URL! },
      priority: ['postgres'],
    });
    features = createStorageFeatures(adapter);

    // Create test table
    await adapter.exec(`
      DROP TABLE IF EXISTS test_memory_traces CASCADE;
      CREATE TABLE test_memory_traces (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        metadata TEXT NOT NULL DEFAULT '{}',
        strength REAL NOT NULL DEFAULT 1.0,
        deleted INTEGER NOT NULL DEFAULT 0
      )
    `);

    // Create FTS index via abstraction
    const ftsDdl = features.fts.createIndex({
      table: 'test_memory_traces_fts',
      columns: ['content', 'tags'],
      contentTable: 'test_memory_traces',
      tokenizer: 'porter ascii',
    });
    await adapter.exec(ftsDdl);
  });

  afterAll(async () => {
    if (adapter) {
      try {
        await adapter.exec('DROP TABLE IF EXISTS test_memory_traces CASCADE');
      } catch { /* ignore cleanup errors */ }
      await adapter.close();
    }
  });

  it('dialect.insertOrIgnore works with ON CONFLICT DO NOTHING', async () => {
    const sql = features.dialect.insertOrIgnore(
      'test_memory_traces',
      ['id', 'content', 'tags'],
      ['$1', '$2', '$3'],
    );
    await adapter.run(sql, ['t1', 'Test trace one', '["test"]']);
    // Insert again — should not throw
    await adapter.run(sql, ['t1', 'Duplicate', '["dup"]']);

    const row = await adapter.get<{ content: string }>(
      'SELECT content FROM test_memory_traces WHERE id = $1',
      ['t1'],
    );
    expect(row?.content).toBe('Test trace one');
  });

  it('dialect.insertOrReplace works with ON CONFLICT DO UPDATE', async () => {
    const sql = features.dialect.insertOrReplace(
      'test_memory_traces',
      ['id', 'content', 'tags'],
      ['$1', '$2', '$3'],
      'id',
    );
    await adapter.run(sql, ['t2', 'Original', '[]']);
    await adapter.run(sql, ['t2', 'Updated', '["new"]']);

    const row = await adapter.get<{ content: string }>(
      'SELECT content FROM test_memory_traces WHERE id = $1',
      ['t2'],
    );
    expect(row?.content).toBe('Updated');
  });

  it('dialect.jsonExtract works with jsonb operators', async () => {
    await adapter.run(
      features.dialect.insertOrReplace(
        'test_memory_traces',
        ['id', 'content', 'metadata'],
        ['$1', '$2', '$3'],
        'id',
      ),
      ['t3', 'With metadata', '{"scopeId": "user-1", "content_hash": "abc123"}'],
    );

    const expr = features.dialect.jsonExtract('metadata', '$.scopeId');
    const row = await adapter.get<{ scope_id: string }>(
      `SELECT ${expr} as scope_id FROM test_memory_traces WHERE id = $1`,
      ['t3'],
    );
    expect(row?.scope_id).toBe('user-1');
  });

  it('dialect.ifnull works with COALESCE', async () => {
    await adapter.run(
      features.dialect.insertOrReplace(
        'test_memory_traces',
        ['id', 'content', 'metadata'],
        ['$1', '$2', '$3'],
        'id',
      ),
      ['t5', 'Null metadata field', '{}'],
    );

    const expr = features.dialect.ifnull(
      features.dialect.jsonExtract('metadata', '$.scopeId'),
      "''",
    );
    const row = await adapter.get<{ scope_id: string }>(
      `SELECT ${expr} as scope_id FROM test_memory_traces WHERE id = $1`,
      ['t5'],
    );
    expect(row?.scope_id).toBe('');
  });

  it('fts.matchClause returns results via tsvector search', async () => {
    await adapter.run(
      features.dialect.insertOrReplace(
        'test_memory_traces',
        ['id', 'content', 'tags'],
        ['$1', '$2', '$3'],
        'id',
      ),
      ['t4', 'The quick brown fox jumps over the lazy dog', '["animals"]'],
    );

    // Rebuild tsvector index
    await adapter.exec(features.fts.rebuildCommand('test_memory_traces_fts'));

    const matchExpr = features.fts.matchClause('test_memory_traces_fts', '$1');
    const rows = await adapter.all<{ id: string }>(
      `SELECT id FROM test_memory_traces WHERE ${matchExpr}`,
      ['quick fox'],
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.some((r) => r.id === 't4')).toBe(true);
  });

  it('fts.rankExpression orders results by relevance', async () => {
    await adapter.run(
      features.dialect.insertOrReplace(
        'test_memory_traces',
        ['id', 'content', 'tags'],
        ['$1', '$2', '$3'],
        'id',
      ),
      ['t6', 'fox fox fox repeated many times fox', '[]'],
    );

    await adapter.exec(features.fts.rebuildCommand('test_memory_traces_fts'));

    const matchExpr = features.fts.matchClause('test_memory_traces_fts', '$1');
    const rankExpr = features.fts.rankExpression('test_memory_traces_fts', '$1');
    // Note: for Postgres we pass the query param twice — once for MATCH, once for rank
    const rows = await adapter.all<{ id: string; relevance: number }>(
      `SELECT id, ${rankExpr} as relevance FROM test_memory_traces WHERE ${matchExpr} ORDER BY relevance DESC`,
      ['fox'],
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it('fts.syncInsert updates the tsvector column for newly inserted rows', async () => {
    await adapter.run(
      'INSERT INTO test_memory_traces (id, content, tags) VALUES ($1, $2, $3)',
      ['t7', 'event sourcing and domain events', '["ddd"]'],
    );

    await adapter.run(
      features.fts.syncInsert('test_memory_traces_fts', '$1', ['content', 'tags']),
      ['t7', 'event sourcing and domain events', '["ddd"]'],
    );

    const rows = await adapter.all<{ id: string }>(
      `SELECT id FROM test_memory_traces WHERE ${features.fts.matchClause('test_memory_traces_fts', '$1')}`,
      ['event sourcing'],
    );
    expect(rows.some((row) => row.id === 't7')).toBe(true);
  });

  it('blobCodec roundtrip works', async () => {
    const testVec = [0.1, 0.2, -0.5, 1.0];
    const encoded = features.blobCodec.encode(testVec);
    const decoded = features.blobCodec.decode(encoded);
    expect(decoded.length).toBe(testVec.length);
    for (let i = 0; i < testVec.length; i++) {
      expect(decoded[i]).toBeCloseTo(testVec[i]!, 5);
    }
  });

  it('blobCodec.sha256 returns consistent hash', async () => {
    const h1 = await features.blobCodec.sha256('hello');
    const h2 = await features.blobCodec.sha256('hello');
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64);
  });
});
