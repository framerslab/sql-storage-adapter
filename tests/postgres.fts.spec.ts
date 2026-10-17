import { describe, expect, it, afterAll, beforeAll } from 'vitest';
import { PostgresAdapter, PostgresFts, type StorageAdapter } from '../src/index.js';
import { splitSqlStatements } from '../src/shared/splitSqlStatements.js';

// PostgresFts.createIndex runs on every open of a store. ALTER TABLE takes its
// ACCESS EXCLUSIVE lock, and CREATE INDEX its SHARE lock, before either reads
// IF NOT EXISTS, and a lock request waits behind every queued request it
// conflicts with: an open behind a long read of the table would hold up each
// later read and write of it until the read ended. These specs prove that an
// open which finds the _tsv column and the GIN index takes no lock on the table
// beyond the backfill's ROW EXCLUSIVE, that it completes while another
// connection holds a long read, that the first open still adds the column and
// the index and fills the column, and that of two first opens which both find
// no index, the later one takes the catalog's refusal of its CREATE INDEX as
// the index made. They run when POSTGRES_TEST_URL names a server (CI starts a
// PostgreSQL 16 service for them).

const POSTGRES_TEST_URL = process.env.POSTGRES_TEST_URL;

/** A name no other run of this suite uses: lower-case letters, digits and underscores. */
const unique = (prefix: string): string => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;

/** Waits until `ready` resolves true, for a bounded time. */
const until = async (ready: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> => {
  const started = Date.now();
  while (!(await ready())) {
    if (Date.now() - started > timeoutMs) throw new Error(`Not ready after ${timeoutMs} ms.`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** The modes of the locks the transaction `trx` holds on `table`, each once. */
const lockModes = async (trx: StorageAdapter, table: string): Promise<string[]> =>
  (
    await trx.all<{ mode: string }>(
      "SELECT DISTINCT mode FROM pg_locks WHERE locktype = 'relation' AND pid = pg_backend_pid() AND relation = to_regclass(?) ORDER BY mode",
      [table],
    )
  ).map((row) => row.mode);

describe.skipIf(!POSTGRES_TEST_URL)('PostgresFts.createIndex on an open', () => {
  const url = POSTGRES_TEST_URL as string;
  const fts = new PostgresFts();
  const tables: string[] = [];
  const schemas: string[] = [];
  const opened: PostgresAdapter[] = [];
  let db: PostgresAdapter;

  /** A new table, as SQL names it (schema-qualified or quoted when `name` is), with three rows. */
  const contentTable = async (name: string = unique('fts_open')): Promise<string> => {
    tables.push(name);
    await db.exec(`CREATE TABLE ${name} (id INTEGER PRIMARY KEY, title TEXT, body TEXT)`);
    await db.exec(`INSERT INTO ${name} (id, title, body) VALUES (1, 'running', 'nothing here'), (2, 'nothing', 'running'), (3, 'walking', 'a quiet day')`);
    return name;
  };

  /** The script of an index over `table`'s title and body. */
  const indexScript = (index: string, table: string): string =>
    fts.createIndex({ table: index, columns: ['title', 'body'], contentTable: table, tokenizer: 'porter' });

  /** Runs `script` in a transaction on `adapter`, and the modes of the locks it took on `table`. */
  const locksTakenBy = (adapter: PostgresAdapter, script: string, table: string): Promise<string[]> =>
    adapter.transaction(async (trx) => {
      await trx.exec(script);
      return lockModes(trx, table);
    });

  beforeAll(async () => {
    db = new PostgresAdapter(url);
    await db.open();
  });

  afterAll(async () => {
    for (const adapter of opened.splice(0)) await adapter.close().catch(() => undefined);
    for (const table of tables) await db.exec(`DROP TABLE IF EXISTS ${table}`).catch(() => undefined);
    for (const schema of schemas) await db.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    await db.close();
  });

  it('adds the _tsv column and its GIN index and fills the column of every row on the first open', async () => {
    const table = await contentTable();
    const index = `${table}_index`;

    // The probe sees the locks the statements take: the ALTER's and the CREATE INDEX's.
    expect(await locksTakenBy(db, indexScript(index, table), table)).toEqual(expect.arrayContaining(['AccessExclusiveLock', 'ShareLock']));

    expect(
      await db.get(
        "SELECT format_type(atttypid, atttypmod) AS type FROM pg_attribute WHERE attrelid = to_regclass(?) AND attname = '_tsv' AND NOT attisdropped",
        [table],
      ),
    ).toEqual({ type: 'tsvector' });
    const gin = await db.get<{ indexdef: string }>('SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = ?', [
      `idx_${index}_tsv`,
    ]);
    expect(gin?.indexdef).toMatch(/ON \S+ USING gin \(_tsv\)$/);
    expect(await db.get(`SELECT count(*)::int AS missing FROM ${table} WHERE _tsv IS NULL`)).toEqual({ missing: 0 });
    expect(await db.all(`SELECT id FROM ${table} WHERE ${fts.matchClause(index, '?')} ORDER BY id`, ['run'])).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('takes no lock on the table beyond the backfill\'s ROW EXCLUSIVE once the column and the index exist', async () => {
    const table = await contentTable();
    const index = `${table}_index`;
    await db.exec(indexScript(index, table));

    expect(await locksTakenBy(db, indexScript(index, table), table)).toEqual(['RowExclusiveLock']);
  });

  it('opens while another connection holds a long read of the table, instead of queueing behind it', async () => {
    const table = await contentTable();
    const index = `${table}_index`;
    await db.exec(indexScript(index, table));
    // A row written after the first open without a sync, which the next open's backfill fills.
    await db.exec(`INSERT INTO ${table} (id, title, body) VALUES (4, 'runs', 'later')`);

    await db.transaction(
      async (reader) => {
        // An export's read: the transaction holds the table's ACCESS SHARE lock until it ends.
        expect(await reader.get(`SELECT count(*)::int AS n FROM ${table}`)).toEqual({ n: 4 });
        // The second open runs as an open does, outside a transaction, on another connection. A
        // statement that queued behind the read would fail after lock_timeout instead of waiting.
        await db.withConnection(async (opener) => {
          await opener.exec("SET lock_timeout = '2s'");
          await opener.exec(indexScript(index, table));
          await opener.exec('RESET lock_timeout');
        });
      },
      { isolationLevel: 'repeatable read', readOnly: true },
    );

    expect(await db.get(`SELECT count(*)::int AS missing FROM ${table} WHERE _tsv IS NULL`)).toEqual({ missing: 0 });
  });

  it('checks the table a schema-qualified name names, apart from a table and an index of the same names in another schema', async () => {
    const [first, second] = [unique('fts_a'), unique('fts_b')];
    schemas.push(first, second);
    await db.exec(`CREATE SCHEMA ${first}; CREATE SCHEMA ${second}`);
    const [firstTable, secondTable] = [await contentTable(`${first}.notes`), await contentTable(`${second}.notes`)];
    // One index name for both tables, as the segments of a store each name their index the same.
    const index = unique('notes_index');
    await db.exec(indexScript(index, firstTable));

    // The other schema's notes has neither the column nor the index: its first open adds them there.
    expect(await locksTakenBy(db, indexScript(index, secondTable), secondTable)).toEqual(expect.arrayContaining(['AccessExclusiveLock', 'ShareLock']));
    expect(await db.all('SELECT schemaname, tablename FROM pg_indexes WHERE indexname = ? ORDER BY schemaname', [`idx_${index}_tsv`])).toEqual([
      { schemaname: first, tablename: 'notes' },
      { schemaname: second, tablename: 'notes' },
    ]);
    expect(await db.get(`SELECT count(*)::int AS missing FROM ${secondTable} WHERE _tsv IS NULL`)).toEqual({ missing: 0 });

    expect(await locksTakenBy(db, indexScript(index, firstTable), firstTable)).toEqual(['RowExclusiveLock']);
    expect(await locksTakenBy(db, indexScript(index, secondTable), secondTable)).toEqual(['RowExclusiveLock']);
  });

  it('opens while another open, which found no index either, creates it: the later one takes the catalog\'s refusal as the index made', async () => {
    const table = await contentTable();
    const index = `${table}_index`;
    const indexName = `idx_${index}_tsv`;
    // The column without the index, so the two opens meet at CREATE INDEX alone.
    await db.exec(indexScript(index, table));
    await db.exec(`DROP INDEX ${indexName}`);
    const createIndexBlock = splitSqlStatements(indexScript(index, table))[1];

    let second: Promise<unknown> = Promise.resolve();
    await db.transaction(async (first) => {
      // The earlier open's CREATE INDEX, not yet committed: the later open's check cannot see it.
      await first.exec(createIndexBlock);
      second = db.exec(indexScript(index, table)).then(
        () => 'opened',
        (error: unknown) => error,
      );
      // The later open's CREATE INDEX shares the table's SHARE lock and waits on the catalog row of the same name.
      await until(
        async () => Boolean(await db.get("SELECT 1 AS waiting FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE ?", [`%${indexName}%`])),
        3_000,
      );
    });

    // The earlier open committed; the later one's CREATE INDEX failed on the unique name, which its block takes as made.
    expect(await second).toBe('opened');
    expect(await db.all('SELECT tablename FROM pg_indexes WHERE indexname = ?', [indexName])).toEqual([{ tablename: table }]);
  });

  it('finds an unqualified table through the search path, past a first schema that does not hold it', async () => {
    // A segment's search_path is the segment, then public: a table only public holds resolves to
    // public while current_schema() is the segment.
    const segment = unique('fts_seg');
    schemas.push(segment);
    const segmented = new PostgresAdapter({ connectionString: url, segment });
    opened.push(segmented);
    await segmented.open();
    const table = unique('fts_open');
    await contentTable(`public.${table}`);
    const index = `${table}_index`;
    await segmented.exec(indexScript(index, table));

    expect(await segmented.get('SELECT current_schema() AS schema')).toEqual({ schema: segment });
    expect(await db.get(`SELECT count(*)::int AS missing FROM public.${table} WHERE _tsv IS NULL`)).toEqual({ missing: 0 });
    expect(await locksTakenBy(segmented, indexScript(index, table), `public.${table}`)).toEqual(['RowExclusiveLock']);
  });

  it('reads the catalog for a quoted name that holds an apostrophe and a dollar quote', async () => {
    const plain = unique('fts_quoted');
    const table = await contentTable(`"Fts's$fts$${plain}"`);
    const index = `${plain}_index`;

    expect(await locksTakenBy(db, indexScript(index, table), table)).toEqual(expect.arrayContaining(['AccessExclusiveLock', 'ShareLock']));
    expect(await db.get(`SELECT count(*)::int AS missing FROM ${table} WHERE _tsv IS NULL`)).toEqual({ missing: 0 });
    expect(await locksTakenBy(db, indexScript(index, table), table)).toEqual(['RowExclusiveLock']);
  });
});
