import { describe, expect, it, afterAll, afterEach, beforeAll, vi } from 'vitest';
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
    vi.unstubAllEnvs();
    for (const adapter of opened.splice(0)) {
      await adapter.close().catch(() => undefined);
    }
  });

  /** A database of its own for one spec, dropped after the suite. */
  const newDatabase = async (): Promise<string> => {
    const database = unique('export');
    databases.push(database);
    await admin.exec(`CREATE DATABASE ${database}`);
    return database;
  };

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

  // pg calls a pool's password function for each connection it makes; the
  // export asks it too, and pg_dump logs in with its answer. CI's server asks
  // a TCP connection for its password (scram-sha-256), and PGPASSWORD is empty.
  it('exports through a pool of the caller whose password is a function, which it asks when the export runs', async () => {
    const database = await newDatabase();
    const server = new URL(url);
    vi.stubEnv('PGPASSWORD', '');
    let asked = 0;
    const pool = new pg.Pool({
      host: server.hostname,
      port: Number(server.port || 5432),
      database,
      user: decodeURIComponent(server.username),
      password: async () => {
        asked += 1;
        return decodeURIComponent(server.password);
      },
    });
    const adapter = createPostgresAdapter({ pool });
    try {
      await adapter.exec('CREATE TABLE function_items (id INTEGER PRIMARY KEY)');
      const before = asked;

      const file = path.join(dir, `${database}-function.dump`);
      await createStorageFeatures(adapter).exporter.exportToFile(file);

      expect(dumpedTables(file)).toEqual(['public.function_items']);
      expect(asked).toBe(before + 1);
    } finally {
      await adapter.close();
      await pool.end();
    }
  });

  // pg reads a pool's connection string as a WHATWG URL, libpq by its own
  // grammar: given this string as it was, pg_dump read the user part up to the
  // @ in the query and the host y.
  it('exports through a pool whose connection string libpq reads apart from pg, where pg reaches', async () => {
    const database = await newDatabase();
    const server = new URL(url);
    vi.stubEnv('PGUSER', decodeURIComponent(server.username));
    vi.stubEnv('PGPASSWORD', decodeURIComponent(server.password));
    vi.stubEnv('PGDATABASE', database);
    const pool = new pg.Pool({ connectionString: `postgresql://${server.host}?application_name=x@y` });
    const adapter = createPostgresAdapter({ pool });
    try {
      await adapter.exec('CREATE TABLE parsed_items (id INTEGER PRIMARY KEY)');

      const file = path.join(dir, `${database}-parsed.dump`);
      await createStorageFeatures(adapter).exporter.exportToFile(file);

      expect(dumpedTables(file)).toEqual(['public.parsed_items']);
    } finally {
      await adapter.close();
      await pool.end();
    }
  });

  // pg-connection-string sets the database from the URL's path alone, and
  // drops a database parameter (index.js:66-67): pg reaches PGDATABASE. The
  // export reaches the database pg reaches, not the one the parameter names.
  it("exports the database pg reaches for a connection string whose query names another, which pg drops", async () => {
    const database = await newDatabase();
    const server = new URL(url);
    vi.stubEnv('PGDATABASE', database);
    const pool = new pg.Pool({
      connectionString: `postgresql://${server.username}:${server.password}@${server.host}/?database=${server.pathname.slice(1)}`,
    });
    const adapter = createPostgresAdapter({ pool });
    try {
      await adapter.exec('CREATE TABLE query_items (id INTEGER PRIMARY KEY)');

      const file = path.join(dir, `${database}-query.dump`);
      await createStorageFeatures(adapter).exporter.exportToFile(file);

      expect(dumpedTables(file)).toEqual(['public.query_items']);
    } finally {
      await adapter.close();
      await pool.end();
    }
  });

  // pg reads an empty host parameter as none and keeps the URL's host
  // (pg-connection-string index.js:54-56), never PGHOST.
  it('exports through a pool whose connection string has an empty host parameter, where pg reaches', async () => {
    const database = await newDatabase();
    const server = new URL(url);
    vi.stubEnv('PGHOST', 'unreachable.invalid');
    const pool = new pg.Pool({
      connectionString: `postgresql://${server.username}:${server.password}@${server.host}/${database}?host=`,
    });
    const adapter = createPostgresAdapter({ pool });
    try {
      await adapter.exec('CREATE TABLE host_items (id INTEGER PRIMARY KEY)');

      const file = path.join(dir, `${database}-host.dump`);
      await createStorageFeatures(adapter).exporter.exportToFile(file);

      expect(dumpedTables(file)).toEqual(['public.host_items']);
    } finally {
      await adapter.close();
      await pool.end();
    }
  });

  // pg connects with no password where a pool's password function answers
  // none (lib/client.js, _getPassword), which CI's server refuses over TCP.
  // pg_dump gets an empty PGPASSWORD and is refused alike: with PGPASSWORD
  // left as it was, it logged in with the environment's password, which the
  // pool never sends. With no password and --no-password it fails at once.
  // The pool itself never connects here: pg-pool keeps no client whose
  // connection failed and never ends it, so the server would hold that
  // half-done login until authentication_timeout, and DROP DATABASE waits on
  // it (ProcSignalBarrier).
  it("logs pg_dump in with no password where the pool's password function answers none, as the pool does", async () => {
    const database = await newDatabase();
    const server = new URL(url);
    vi.stubEnv('PGPASSWORD', decodeURIComponent(server.password));
    const pool = new pg.Pool({
      host: server.hostname,
      port: Number(server.port || 5432),
      database,
      user: decodeURIComponent(server.username),
      password: async () => undefined,
    });
    const adapter = createPostgresAdapter({ pool });
    try {
      const file = path.join(dir, `${database}-no-password.dump`);
      await expect(createStorageFeatures(adapter).exporter.exportToFile(file)).rejects.toThrow(/pg_dump failed.*password/s);
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
