import { describe, it, expect } from 'vitest';
import { createStorageFeatures } from '../src/core/contracts/features.js';
import { SqliteDialect } from '../src/dialects/SqliteDialect.js';
import { PostgresDialect } from '../src/dialects/PostgresDialect.js';
import { SqliteFts5 } from '../src/fts/SqliteFts5.js';
import { SqliteFts4 } from '../src/fts/SqliteFts4.js';
import { PostgresFts } from '../src/fts/PostgresFts.js';
import { NodeBlobCodec } from '../src/codecs/NodeBlobCodec.js';
import { SqliteFileExporter } from '../src/exporters/SqliteFileExporter.js';
import { PostgresExporter } from '../src/exporters/PostgresExporter.js';
import type { StorageAdapter } from '../src/core/contracts/index.js';

function mockAdapter(kind: string, extra: Record<string, unknown> = {}): StorageAdapter {
  return {
    kind,
    capabilities: new Set(),
    open: async () => {},
    run: async () => ({ changes: 0 }),
    get: async () => null,
    all: async () => [],
    exec: async () => {},
    transaction: async (fn) => fn({} as StorageAdapter),
    close: async () => {},
    ...extra,
  } as StorageAdapter;
}

describe('createStorageFeatures', () => {
  it('returns SqliteDialect + SqliteFts5 for better-sqlite3 adapter', () => {
    const features = createStorageFeatures(mockAdapter('better-sqlite3'));
    expect(features.dialect).toBeInstanceOf(SqliteDialect);
    expect(features.fts).toBeInstanceOf(SqliteFts5);
    expect(features.blobCodec).toBeInstanceOf(NodeBlobCodec);
    expect(features.exporter).toBeInstanceOf(SqliteFileExporter);
  });

  it('returns SqliteDialect and FTS4 for the sqljs adapter, whose build has no FTS5', () => {
    const features = createStorageFeatures(mockAdapter('sqljs'));
    expect(features.dialect).toBeInstanceOf(SqliteDialect);
    expect(features.fts).toBeInstanceOf(SqliteFts4);
  });

  it('returns PostgresDialect + PostgresFts for postgres adapter', () => {
    const features = createStorageFeatures(
      mockAdapter('postgres', {
        options: { connectionString: 'postgresql://user:pass@localhost:5432/testdb' },
      }),
    );
    expect(features.dialect).toBeInstanceOf(PostgresDialect);
    expect(features.fts).toBeInstanceOf(PostgresFts);
    expect(features.exporter).toBeInstanceOf(PostgresExporter);
    // The exporter may name the adapter's database when an export runs.
    const target = (features.exporter as unknown as { connectionString?: string | (() => string | undefined) })[
      'connectionString'
    ];
    expect(typeof target === 'function' ? target() : target).toBe('postgresql://user:pass@localhost:5432/testdb');
  });
});
