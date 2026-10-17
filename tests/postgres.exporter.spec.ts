import { describe, expect, it, afterAll, afterEach, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { createPostgresAdapter, createStorageFeatures, type StorageAdapter } from '../src/index.js';

// The feature exporter runs pg_dump against the PostgreSQL that
// POSTGRES_TEST_URL names (CI's service); the runner has the PostgreSQL client
// tools, and pg_restore lists what each dump holds. A dump of a whole database
// runs on a database of its own, where no other suite drops tables while
// pg_dump reads.

const POSTGRES_TEST_URL = process.env.POSTGRES_TEST_URL;

/** A name no other run of this suite uses: lower-case letters and digits. */
const unique = (prefix: string): string => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;

/** The tables a custom-format dump holds, as schema.table, from pg_restore's list of it. */
const dumpedTables = (file: string): string[] =>
  execFileSync('pg_restore', ['--list', file], { encoding: 'utf8' })
    .split('\n')
    .flatMap((line) => {
      const match = /^\d+; \d+ \d+ TABLE (?!DATA )(\S+) (\S+) /.exec(line);
      return match ? [`${match[1]}.${match[2]}`] : [];
    })
    .sort();

describe.skipIf(!POSTGRES_TEST_URL)('the PostgreSQL exporter, through pg_dump', () => {
  const url = POSTGRES_TEST_URL as string;
  const schemas: string[] = [];
  const databases: string[] = [];
  const opened: StorageAdapter[] = [];
  let admin: StorageAdapter;
  let dir: string;

  const segmentAdapter = async (segment: string): Promise<StorageAdapter> => {
    schemas.push(segment);
    const adapter = createPostgresAdapter({ connectionString: url, segment });
    opened.push(adapter);
    await adapter.open();
    return adapter;
  };

  beforeAll(async () => {
    admin = createPostgresAdapter(url);
    await admin.open();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-export-'));
  });

  afterEach(async () => {
    for (const adapter of opened.splice(0)) {
      await adapter.close().catch(() => undefined);
    }
  });

  afterAll(async () => {
    for (const schema of schemas) {
      await admin.exec(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
    }
    for (const database of databases) {
      await admin.exec(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`).catch(() => undefined);
    }
    await admin.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("exports a segment's schema alone, to a file and to bytes", async () => {
    const segment = unique('seg');
    const neighbour = await segmentAdapter(unique('seg'));
    await neighbour.exec('CREATE TABLE neighbour_items (id INTEGER PRIMARY KEY)');
    const adapter = await segmentAdapter(segment);
    await adapter.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL)');
    await adapter.run('INSERT INTO items (id, label) VALUES (?, ?)', [1, 'exported']);
    const hostTable = unique('host');
    await admin.exec(`CREATE TABLE public.${hostTable} (id INTEGER)`);
    try {
      const { exporter } = createStorageFeatures(adapter);

      const file = path.join(dir, `${segment}.dump`);
      await exporter.exportToFile(file);
      expect(dumpedTables(file)).toEqual([`${segment}.items`]);

      const bytesFile = path.join(dir, `${segment}-bytes.dump`);
      fs.writeFileSync(bytesFile, await exporter.exportToBytes());
      expect(dumpedTables(bytesFile)).toEqual([`${segment}.items`]);
    } finally {
      await admin.exec(`DROP TABLE IF EXISTS public.${hostTable}`);
    }
  });

  it('exports through a pool of the caller, from the settings the pool was made with', async () => {
    const database = unique('export');
    databases.push(database);
    await admin.exec(`CREATE DATABASE ${database}`);
    const parsed = new URL(url);
    parsed.pathname = `/${database}`;
    const pool = new pg.Pool({ connectionString: parsed.toString() });
    const adapter = createPostgresAdapter({ pool });
    try {
      await adapter.exec('CREATE TABLE pooled_items (id INTEGER PRIMARY KEY)');

      const file = path.join(dir, `${database}.dump`);
      await createStorageFeatures(adapter).exporter.exportToFile(file);

      expect(dumpedTables(file)).toEqual(['public.pooled_items']);
    } finally {
      await adapter.close();
      await pool.end();
    }
  });

  // open({ connectionString }) gives the adapter a database its options do not
  // name: the exporter reads the pool the adapter runs on when an export runs.
  it('exports an adapter given its connection string at open(), from features made before it opened', async () => {
    const segment = unique('seg');
    schemas.push(segment);
    const adapter = createPostgresAdapter({ segment });
    opened.push(adapter);
    const { exporter } = createStorageFeatures(adapter);
    await adapter.open({ connectionString: url });
    await adapter.exec('CREATE TABLE opened_items (id INTEGER PRIMARY KEY)');

    const file = path.join(dir, `${segment}-opened.dump`);
    await exporter.exportToFile(file);

    expect(dumpedTables(file)).toEqual([`${segment}.opened_items`]);
  });
});
