import { describe, expect, it, afterAll, afterEach, beforeAll } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createDatabase,
  createPostgresAdapter,
  createSqlJsAdapter,
  readSchemaMigrations,
  runSchemaMigrations,
  schemaMigrationStatus,
  type SchemaMigration,
  type StorageAdapter,
} from '../src/index.js';

// The schema-migration runner applies a folder of SQL files in order, each in
// its own transaction under a lock, records each with its SHA-256, refuses an
// applied file that changed or a ledger row the code lacks, and runs a marked
// file outside a transaction. It runs on PostgreSQL (CI's service, when
// POSTGRES_TEST_URL names it), better-sqlite3 and sql.js, and reads the ledgers
// two existing runners wrote (`schema_migrations` with `checksum`, and
// `_migrations` with `content_hash`).

const POSTGRES_TEST_URL = process.env.POSTGRES_TEST_URL;

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

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

describe('readSchemaMigrations', () => {
  const dirs: string[] = [];
  const folder = (files: Record<string, string>): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-migrations-'));
    dirs.push(dir);
    for (const [name, sql] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      fs.writeFileSync(path.join(dir, name), sql);
    }
    return dir;
  };

  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads NNN_ and NNNN_ files in number order, skipping files that are not .sql', async () => {
    const dir = folder({ '010_c.sql': 'SELECT 3;', '002_b.sql': 'SELECT 2;', '0001_a.sql': 'SELECT 1;', 'README.md': '#' });

    expect((await readSchemaMigrations(dir)).map((migration) => migration.name)).toEqual(['0001_a.sql', '002_b.sql', '010_c.sql']);
  });

  it('refuses a name out of form and a number used twice', async () => {
    await expect(readSchemaMigrations(folder({ '001-bad name.sql': 'SELECT 1;' }))).rejects.toThrow(/001-bad name\.sql/);
    await expect(readSchemaMigrations(folder({ '001_a.sql': 'SELECT 1;', '001_b.sql': 'SELECT 2;' }))).rejects.toThrow(/used twice/);
  });

  it("reads the dialect's own folder when it has one, and the shared folder otherwise", async () => {
    const dir = folder({ '001_shared.sql': 'SELECT 1;', 'postgres/001_pg.sql': 'SELECT 2;' });

    expect((await readSchemaMigrations(dir, { dialect: 'postgres' })).map((m) => m.name)).toEqual(['001_pg.sql']);
    expect((await readSchemaMigrations(dir, { dialect: 'sqlite' })).map((m) => m.name)).toEqual(['001_shared.sql']);
  });
});

describe.each(engines)('runSchemaMigrations on %s', (engine, openAdapter) => {
  let db: StorageAdapter;
  const suffix = Math.random().toString(36).slice(2, 8);
  const ledger = `ledger_${suffix}`;
  const notes = `notes_${suffix}`;
  const tags = `tags_${suffix}`;

  const migrations: SchemaMigration[] = [
    { name: '001_notes.sql', sql: `CREATE TABLE ${notes} (id INTEGER PRIMARY KEY, body TEXT NOT NULL);` },
    {
      name: '002_tags.sql',
      sql: `-- two statements and a comment; one transaction
CREATE TABLE ${tags} (id INTEGER PRIMARY KEY, label TEXT NOT NULL);
INSERT INTO ${tags} (id, label) VALUES (1, 'first; with a semicolon');`,
    },
  ];

  beforeAll(async () => {
    db = await openAdapter();
  });

  afterAll(async () => {
    for (const table of [notes, tags, `${notes}_more`, ledger, `schema_migrations_${suffix}`, `_migrations_${suffix}`]) {
      await db.exec(`DROP TABLE IF EXISTS ${table}`).catch(() => undefined);
    }
    await db.close();
  });

  it('applies the migrations in order, records each with its SHA-256, and skips them on the next run', async () => {
    const first = await runSchemaMigrations(db, migrations, { table: ledger });
    const second = await runSchemaMigrations(db, migrations, { table: ledger });

    expect(first.applied).toEqual(['001_notes.sql', '002_tags.sql']);
    expect(second).toMatchObject({ applied: [], skipped: ['001_notes.sql', '002_tags.sql'] });
    expect(await db.all(`SELECT name, checksum FROM ${ledger} ORDER BY name`)).toEqual(
      migrations.map((migration) => ({ name: migration.name, checksum: sha256(migration.sql) })),
    );
    expect(await db.all(`SELECT label FROM ${tags}`)).toEqual([{ label: 'first; with a semicolon' }]);
  });

  it('reports pending, applied, changed and unknown migrations without applying any', async () => {
    const status = await schemaMigrationStatus(
      db,
      [{ ...migrations[0], sql: `${migrations[0].sql}\n-- edited` }, { name: '003_more.sql', sql: 'SELECT 1;' }],
      { table: ledger },
    );

    expect(status).toMatchObject({
      applied: [],
      pending: ['003_more.sql'],
      changed: ['001_notes.sql'],
      unknown: ['002_tags.sql'],
    });
  });

  it('refuses an applied migration that changed, and a ledger row the list lacks, before applying anything', async () => {
    const more = { name: '003_more.sql', sql: `CREATE TABLE ${notes}_more (id INTEGER PRIMARY KEY);` };

    await expect(
      runSchemaMigrations(db, [{ ...migrations[0], sql: `${migrations[0].sql} -- edited` }, migrations[1], more], { table: ledger }),
    ).rejects.toThrow(/001_notes\.sql/);
    await expect(runSchemaMigrations(db, [migrations[0], more], { table: ledger })).rejects.toThrow(/002_tags\.sql/);
    expect(await db.all(`SELECT name FROM ${ledger} WHERE name = '003_more.sql'`)).toEqual([]);

    const ignored = await runSchemaMigrations(db, [migrations[0], more], { table: ledger, unknown: 'ignore' });
    expect(ignored.applied).toEqual(['003_more.sql']);
  });

  it('rolls a failing migration back, records nothing for it, and names it in the error', async () => {
    const failing = {
      name: '004_broken.sql',
      sql: `INSERT INTO ${notes} (id, body) VALUES (7, 'kept only if the file commits');\nINSERT INTO nowhere_${suffix} VALUES (1);`,
    };

    const error = await runSchemaMigrations(db, [...migrations, { name: '003_more.sql', sql: `CREATE TABLE ${notes}_more (id INTEGER PRIMARY KEY);` }, failing], {
      table: ledger,
    }).catch((caught: unknown) => caught);

    expect(String(error)).toMatch(/004_broken\.sql/);
    expect(await db.all(`SELECT id FROM ${notes} WHERE id = 7`)).toEqual([]);
    expect(await db.all(`SELECT name FROM ${ledger} WHERE name = '004_broken.sql'`)).toEqual([]);
  });

  it('reads and extends the ledgers two existing runners wrote', async () => {
    const sayshere = `schema_migrations_${suffix}`;
    const swolski = `_migrations_${suffix}`;
    const timestamp = engine === 'PostgreSQL' ? 'timestamp with time zone DEFAULT now() NOT NULL' : "TEXT DEFAULT (datetime('now')) NOT NULL";
    await db.exec(`CREATE TABLE ${sayshere} (name text PRIMARY KEY, checksum text NOT NULL, applied_at ${timestamp})`);
    await db.exec(`CREATE TABLE ${swolski} (name TEXT PRIMARY KEY, content_hash TEXT NOT NULL, applied_at ${timestamp})`);
    await db.run(`INSERT INTO ${sayshere} (name, checksum) VALUES (?, ?)`, [migrations[0].name, sha256(migrations[0].sql)]);
    await db.run(`INSERT INTO ${swolski} (name, content_hash) VALUES (?, ?)`, [migrations[0].name, sha256(migrations[0].sql)]);
    const next = [migrations[0], { name: '0099_next.sql', sql: 'SELECT 1;' }];

    const fromSayshere = await runSchemaMigrations(db, next, { table: sayshere });
    const fromSwolski = await runSchemaMigrations(db, next, { table: swolski, checksumColumn: 'content_hash' });

    expect(fromSayshere).toMatchObject({ applied: ['0099_next.sql'], skipped: ['001_notes.sql'] });
    expect(fromSwolski).toMatchObject({ applied: ['0099_next.sql'], skipped: ['001_notes.sql'] });
  });

  it('runs a marked file outside a transaction', async () => {
    const outside =
      engine === 'PostgreSQL'
        ? `-- outside transaction\nCREATE INDEX CONCURRENTLY IF NOT EXISTS ${notes}_body ON ${notes} (body);`
        : '-- outside transaction\nVACUUM;';
    const table = `ledger_outside_${suffix}`;

    const report = await runSchemaMigrations(db, [{ name: '001_outside.sql', sql: outside }], { table });
    await db.exec(`DROP TABLE IF EXISTS ${table}`);

    expect(report.applied).toEqual(['001_outside.sql']);
  });

  it('refuses a ledger name that is not an identifier', async () => {
    await expect(runSchemaMigrations(db, migrations, { table: 'ledger; DROP TABLE x' })).rejects.toThrow(/table/);
  });
});

describe.skipIf(!POSTGRES_TEST_URL)('runSchemaMigrations from two processes at once on PostgreSQL', () => {
  it('applies each migration once', async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const [a, b] = [createPostgresAdapter(POSTGRES_TEST_URL as string), createPostgresAdapter(POSTGRES_TEST_URL as string)];
    await a.open();
    await b.open();
    const list: SchemaMigration[] = [
      { name: '001_a.sql', sql: `CREATE TABLE race_a_${suffix} (id INTEGER PRIMARY KEY); SELECT pg_sleep(0.2);` },
      { name: '002_b.sql', sql: `CREATE TABLE race_b_${suffix} (id INTEGER PRIMARY KEY);` },
    ];
    try {
      const [first, second] = await Promise.all([
        runSchemaMigrations(a, list, { table: `race_ledger_${suffix}` }),
        runSchemaMigrations(b, list, { table: `race_ledger_${suffix}` }),
      ]);

      expect([...first.applied, ...second.applied].sort()).toEqual(['001_a.sql', '002_b.sql']);
      expect(await a.all(`SELECT name FROM race_ledger_${suffix} ORDER BY name`)).toEqual([{ name: '001_a.sql' }, { name: '002_b.sql' }]);
    } finally {
      await a.exec(`DROP TABLE IF EXISTS race_a_${suffix}; DROP TABLE IF EXISTS race_b_${suffix}; DROP TABLE IF EXISTS race_ledger_${suffix};`);
      await a.close();
      await b.close();
    }
  });
});
