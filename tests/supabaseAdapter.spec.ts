import { runInNewContext } from 'node:vm';
import pg from 'pg';
import { describe, expect, it, afterAll, beforeAll } from 'vitest';
import { SupabaseAdapter, isUniqueViolation, setStorageLogger, type StorageLogger } from '../src/index.js';

// The Supabase adapter is deprecated in favour of the PostgreSQL adapter,
// which reaches Supabase with its connection string. Until it goes, it reads
// `?` and `@name` placeholders as the PostgreSQL adapter does, keeps
// PostgreSQL's error code on the errors it throws, says once, through the
// host logger, that it is deprecated and does not verify the server's
// certificate, and, with its cache on, never answers a row as it stood before
// one of its own writes. These specs run when POSTGRES_TEST_URL names a server.

const POSTGRES_TEST_URL = process.env.POSTGRES_TEST_URL;

/** A name no other run of this suite uses. */
const unique = (prefix: string): string => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!POSTGRES_TEST_URL)('SupabaseAdapter', () => {
  const table = `supabase_${Math.random().toString(36).slice(2, 8)}`;
  const lines: Array<{ fields: Record<string, unknown>; message: string }> = [];
  const logger: StorageLogger = {
    info: () => undefined,
    warn: (fields, message) => lines.push({ fields, message }),
    error: () => undefined,
  };
  let db: SupabaseAdapter;
  /** An adapter with its cache always off, which reads and ends other sessions for the specs that need it. */
  let admin: SupabaseAdapter;
  /** The adapters the specs opened, closed after the suite. */
  const opened: SupabaseAdapter[] = [];

  /** An adapter of a spec's own, with its cache on when asked, on the test server or at `url`. */
  const openAdapter = async (options: { cache?: boolean; url?: string } = {}): Promise<SupabaseAdapter> => {
    const adapter = new SupabaseAdapter();
    await adapter.open({ connectionString: options.url ?? POSTGRES_TEST_URL, ssl: false });
    opened.push(adapter);
    if (options.cache) adapter.enableCache();
    return adapter;
  };

  /** Ends, from `admin`, the server session that is running a statement holding `marker`, once it shows. */
  const endSessionRunning = async (marker: string): Promise<void> => {
    const started = Date.now();
    while (Date.now() - started < 5_000) {
      const row = await admin.get<{ pid: number }>(
        "SELECT pid FROM pg_stat_activity WHERE state = 'active' AND query LIKE ? AND pid <> pg_backend_pid()",
        [`%${marker}%`],
      );
      if (row) {
        await admin.get('SELECT pg_terminate_backend(?) AS ended', [row.pid]);
        return;
      }
      await pause(25);
    }
    throw new Error(`no session ran ${marker}`);
  };

  /** A URL of the test server whose sessions give up on a query after `ms` milliseconds (pg's query_timeout). */
  const timingOutAfter = (ms: number): string => {
    const url = new URL(POSTGRES_TEST_URL as string);
    url.searchParams.set('query_timeout', String(ms));
    return url.toString();
  };

  beforeAll(async () => {
    setStorageLogger(logger);
    db = new SupabaseAdapter();
    await db.open({ connectionString: POSTGRES_TEST_URL, ssl: false });
    await db.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, label TEXT NOT NULL)`);
    admin = new SupabaseAdapter();
    await admin.open({ connectionString: POSTGRES_TEST_URL, ssl: false });
  });

  afterAll(async () => {
    for (const adapter of opened.splice(0)) await adapter.close().catch(() => undefined);
    await db.exec(`DROP TABLE IF EXISTS ${table}`).catch(() => undefined);
    await admin.close().catch(() => undefined);
    await db.close();
    setStorageLogger(null);
  });

  it('says once, through the host logger, that it is deprecated', async () => {
    const again = new SupabaseAdapter();
    await again.open({ connectionString: POSTGRES_TEST_URL, ssl: false });
    await again.close();

    const deprecations = lines.filter((line) => /deprecated/i.test(line.message));
    expect(deprecations).toHaveLength(1);
    expect(deprecations[0].message).toMatch(/createPostgresAdapter/);
  });

  it('reads ? and @name placeholders, and a ? inside a string literal as text', async () => {
    await db.run(`INSERT INTO ${table} (id, label) VALUES (?, ?)`, [1, 'what?']);
    await db.run(`INSERT INTO ${table} (id, label) VALUES (@id, @label)`, { id: 2, label: 'named' });

    expect(await db.all(`SELECT id, label FROM ${table} WHERE id IN (?, ?) ORDER BY id`, [1, 2])).toEqual([
      { id: 1, label: 'what?' },
      { id: 2, label: 'named' },
    ]);
    expect(await db.get(`SELECT label FROM ${table} WHERE id = @id`, { id: 2 })).toEqual({ label: 'named' });
  });

  it('reads them in a transaction too', async () => {
    await db.transaction(async (trx) => {
      await trx.run(`INSERT INTO ${table} (id, label) VALUES (?, ?)`, [3, 'in a transaction']);
    });

    expect(await db.get(`SELECT label FROM ${table} WHERE id = ?`, [3])).toEqual({ label: 'in a transaction' });
  });

  it("keeps PostgreSQL's error code, so isUniqueViolation reads a duplicate", async () => {
    const error = await db.run(`INSERT INTO ${table} (id, label) VALUES (?, ?)`, [1, 'again']).catch((caught: unknown) => caught);

    expect((error as { code?: string }).code).toBe('23505');
    expect(isUniqueViolation(error)).toBe(true);
    expect(String((error as Error).message)).toMatch(/^Query failed: /);
  });

  it('runs each statement of a string of them, and answers no rows for it, as the PostgreSQL adapter does', async () => {
    // pg answers a string of statements sent with no parameters with a list of results, which has no rows of its own:
    // get threw on it and all answered undefined, after PostgreSQL had run every statement.
    const read = `SELECT label FROM ${table} WHERE id = ?`;
    await db.run(`INSERT INTO ${table} (id, label) VALUES (?, ?)`, [46, 'inserted']);

    expect(await db.run(`UPDATE ${table} SET label = 'by run' WHERE id = 46; SELECT 1 AS one`)).toEqual({
      changes: 0,
      lastInsertRowid: 0,
    });
    expect(await db.get(read, [46])).toEqual({ label: 'by run' });
    expect(await db.get(`UPDATE ${table} SET label = 'by get' WHERE id = 46; SELECT 1 AS one`)).toBeNull();
    expect(await db.get(read, [46])).toEqual({ label: 'by get' });
    expect(await db.all(`UPDATE ${table} SET label = 'by all' WHERE id = 46; SELECT 1 AS one`)).toEqual([]);
    expect(await db.get(read, [46])).toEqual({ label: 'by all' });

    const inside = await db.transaction(async (trx) => ({
      got: await trx.get(`UPDATE ${table} SET label = 'in get' WHERE id = 46; SELECT 1 AS one`),
      all: await trx.all(`UPDATE ${table} SET label = 'in all' WHERE id = 46; SELECT 1 AS one`),
    }));
    expect(inside).toEqual({ got: null, all: [] });
    expect(await db.get(read, [46])).toEqual({ label: 'in all' });
  });

  it('commits the operations of a batch that succeed, and reports the one that fails', async () => {
    // A failed statement aborts a PostgreSQL transaction: without a savepoint each operation after it failed too,
    // and the COMMIT rolled everything back while the result said one operation was written.
    await db.run(`INSERT INTO ${table} (id, label) VALUES (?, ?)`, [40, 'taken']);
    const result = await db.batchWrite([
      { statement: '', type: 'insert', table, values: { id: 41, label: 'before' } },
      { statement: '', type: 'insert', table, values: { id: 40, label: 'duplicate' } },
      { statement: '', type: 'insert', table, values: { id: 42, label: 'after' } },
    ]);

    expect(result.successful).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.errors?.map(({ index }) => index)).toEqual([1]);
    expect(isUniqueViolation(result.errors?.[0]?.error)).toBe(true);
    expect(await db.all(`SELECT id, label FROM ${table} WHERE id IN (?, ?, ?) ORDER BY id`, [40, 41, 42])).toEqual([
      { id: 40, label: 'taken' },
      { id: 41, label: 'before' },
      { id: 42, label: 'after' },
    ]);
  });

  it('rejects a transaction that PostgreSQL rolled back at its COMMIT, as a statement in it failed', async () => {
    // The callback caught the duplicate's error and went on. PostgreSQL answers the COMMIT of an aborted
    // transaction with ROLLBACK and no error, so the transaction resolved with nothing written.
    const outcome = await db
      .transaction(async (trx) => {
        await trx.run(`INSERT INTO ${table} (id, label) VALUES (?, ?)`, [43, 'first']);
        await trx.run(`INSERT INTO ${table} (id, label) VALUES (?, ?)`, [43, 'again']).catch(() => undefined);
        return 'committed';
      })
      .catch((caught: unknown) => caught);

    expect(outcome).toBeInstanceOf(Error);
    expect(String((outcome as Error).message)).toMatch(/rolled back/i);
    expect(await db.get(`SELECT label FROM ${table} WHERE id = ?`, [43])).toBeNull();
    expect(await db.transaction(async (trx) => trx.get<{ one: number }>('SELECT 1 AS one'))).toEqual({ one: 1 });
  });

  it("rejects a transaction whose session the server ends while it runs, with the statement's own error", async () => {
    const victim = await openAdapter();
    const marker = unique('ended_transaction');
    const running = victim
      .transaction(async (trx) => trx.get(`SELECT pg_sleep(5) AS slept, '${marker}' AS marker`))
      .catch((caught: unknown) => caught);
    await endSessionRunning(marker);
    const outcome = await running;

    // The ROLLBACK after it cannot run on the ended session; its error is not the one thrown. 57P01 is
    // PostgreSQL's admin_shutdown, what pg_terminate_backend ends a session with.
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as { code?: string }).code).toBe('57P01');
    expect(await victim.get('SELECT 1 AS one')).toEqual({ one: 1 });
  }, 15_000);

  it('carries on when the server ends one of its idle sessions', async () => {
    const victim = await openAdapter();
    const pid = (await victim.get<{ pid: number }>('SELECT pg_backend_pid() AS pid'))?.pid;
    await admin.get('SELECT pg_terminate_backend(?) AS ended', [pid]);
    const started = Date.now();
    while (victim.getPoolStatus().active + victim.getPoolStatus().idle > 0 && Date.now() - started < 5_000) {
      await pause(25);
    }

    expect(victim.getPoolStatus().idle).toBe(0);
    expect(await victim.get('SELECT 2 AS two')).toEqual({ two: 2 });
    expect(lines.some((line) => /idle connection/i.test(line.message))).toBe(true);
  }, 15_000);

  it("gives up a transaction's session whose ROLLBACK could not run, so the next statement commits", async () => {
    // pg's query_timeout rejects a query it gave up on while the server still runs it, and drops a query queued
    // behind it. The ROLLBACK after the timed-out statement was such a query: the session went back to the pool
    // inside its transaction, and the next statement ran there and never committed.
    const victim = await openAdapter({ url: timingOutAfter(500) });
    await db.run(`INSERT INTO ${table} (id, label) VALUES (?, ?)`, [44, 'before']);
    const outcome = await victim
      .transaction(async (trx) => trx.get('SELECT pg_sleep(1.5) AS slept'))
      .catch((caught: unknown) => caught);
    expect(String((outcome as Error).message)).toMatch(/timeout/i);

    await pause(1_500);
    await victim.run(`UPDATE ${table} SET label = ? WHERE id = ?`, ['after', 44]);
    expect(await admin.get(`SELECT label FROM ${table} WHERE id = ?`, [44])).toEqual({ label: 'after' });
  }, 15_000);

  // enableCache() keeps the answers of plain reads. A row it answers must be the row as this adapter's
  // own last write left it, and a statement that writes must run each time it is asked.
  describe('with its cache on', () => {
    beforeAll(() => db.enableCache());
    afterAll(() => db.disableCache());

    const hitsSoFar = (): number => db.getMetrics().cacheHits ?? 0;

    it("answers a row as the adapter's last write left it, whichever call wrote", async () => {
      const read = `SELECT label FROM ${table} WHERE id = ?`;
      await db.run(`INSERT INTO ${table} (id, label) VALUES (?, ?)`, [10, 'first']);
      expect(await db.get(read, [10])).toEqual({ label: 'first' });
      const hits = hitsSoFar();
      expect(await db.get(read, [10])).toEqual({ label: 'first' });
      expect(hitsSoFar()).toBe(hits + 1);

      await db.run(`UPDATE ${table} SET label = ? WHERE id = ?`, ['by run', 10]);
      expect(await db.get(read, [10])).toEqual({ label: 'by run' });
      await db.exec(`UPDATE ${table} SET label = 'by exec' WHERE id = 10`);
      expect(await db.get(read, [10])).toEqual({ label: 'by exec' });
      await db.transaction(async (trx) => {
        await trx.run(`UPDATE ${table} SET label = ? WHERE id = ?`, ['by a transaction', 10]);
      });
      expect(await db.get(read, [10])).toEqual({ label: 'by a transaction' });
      await db.batchWrite([{ statement: '', type: 'update', table, values: { label: 'by a batch' }, where: { id: 10 } }]);
      expect(await db.get(read, [10])).toEqual({ label: 'by a batch' });

      const list = `SELECT id FROM ${table} WHERE id IN (?, ?) ORDER BY id`;
      expect(await db.all(list, [10, 11])).toEqual([{ id: 10 }]);
      await db.run(`INSERT INTO ${table} (id, label) VALUES (?, ?)`, [11, 'second']);
      expect(await db.all(list, [10, 11])).toEqual([{ id: 10 }, { id: 11 }]);
      await db.get(`DELETE FROM ${table} WHERE id = ? RETURNING id`, [11]);
      expect(await db.all(list, [10, 11])).toEqual([{ id: 10 }]);
    });

    it('runs a statement that writes each time it is asked, through get and all too', async () => {
      const insert = `INSERT INTO ${table} (id, label) VALUES (?, ?) RETURNING id`;
      expect(await db.get(insert, [12, 'returned'])).toEqual({ id: 12 });
      const duplicate = await db.get(insert, [12, 'returned']).catch((caught: unknown) => caught);
      expect((duplicate as { code?: string }).code).toBe('23505');

      const append = `UPDATE ${table} SET label = label || '!' WHERE id = ? RETURNING label`;
      expect(await db.all(append, [12])).toEqual([{ label: 'returned!' }]);
      expect(await db.all(append, [12])).toEqual([{ label: 'returned!!' }]);

      // PostgreSQL nests block comments: this one ends after the second */, so the statement is the UPDATE.
      const hidden = `/* one /* two */ SELECT */ UPDATE ${table} SET label = label || '.' WHERE id = ? RETURNING label`;
      expect(await db.get(hidden, [12])).toEqual({ label: 'returned!!.' });
      expect(await db.get(hidden, [12])).toEqual({ label: 'returned!!..' });

      // SELECT ... INTO makes a table.
      const copy = `${table}_copy`;
      const into = `SELECT id INTO ${copy} FROM ${table} WHERE id = 12`;
      expect(await db.all(into)).toEqual([]);
      const made = await db.all(into).catch((caught: unknown) => caught);
      expect((made as { code?: string }).code).toBe('42P07');
      await db.exec(`DROP TABLE ${copy}`);

      expect(await db.get(`SELECT label FROM ${table} WHERE id = ?`, [12])).toEqual({ label: 'returned!!..' });
    });

    it('runs a SELECT that writes through a function each time it is asked, and answers rows as it left them', async () => {
      // A SELECT can call a function that writes: its text alone cannot tell it from a read.
      const bump = `${table}_bump`;
      await db.exec(
        `CREATE FUNCTION ${bump}(target integer) RETURNS text LANGUAGE sql AS ` +
          `$$ UPDATE ${table} SET label = label || '+' WHERE id = target RETURNING label $$`,
      );
      try {
        const read = `SELECT label FROM ${table} WHERE id = ?`;
        await db.run(`INSERT INTO ${table} (id, label) VALUES (?, ?)`, [14, 'n']);
        expect(await db.get(read, [14])).toEqual({ label: 'n' });

        const call = `SELECT ${bump}(?) AS label`;
        expect(await db.get(call, [14])).toEqual({ label: 'n+' });
        expect(await db.get(call, [14])).toEqual({ label: 'n++' });
        expect(await db.get(read, [14])).toEqual({ label: 'n++' });
        expect(await db.all(call, [14])).toEqual([{ label: 'n+++' }]);
        expect(await db.all(call, [14])).toEqual([{ label: 'n++++' }]);
        expect(await db.get(read, [14])).toEqual({ label: 'n++++' });
      } finally {
        await db.exec(`DROP FUNCTION ${bump}(integer)`);
      }
    });

    it('keeps a SELECT that names into only in a literal, a quoted name or a comment, and the reads kept before it', async () => {
      const read = `SELECT label FROM ${table} WHERE id = ?`;
      await db.run(`INSERT INTO ${table} (id, label) VALUES (?, ?)`, [15, 'kept']);
      expect(await db.get(read, [15])).toEqual({ label: 'kept' });

      const word = `SELECT 'into' AS "into" /* into */`;
      expect(await db.get(word)).toEqual({ into: 'into' });
      const hits = hitsSoFar();
      expect(await db.get(word)).toEqual({ into: 'into' });
      expect(await db.get(read, [15])).toEqual({ label: 'kept' });
      expect(hitsSoFar()).toBe(hits + 2);
    });

    it('answers get with a row and all with a list for one statement, whichever was asked first', async () => {
      await db.run(`INSERT INTO ${table} (id, label) VALUES (?, ?)`, [16, 'one']);
      const read = `SELECT label FROM ${table} WHERE id = ? AND label = ?`;
      expect(await db.get(read, [16, 'one'])).toEqual({ label: 'one' });
      expect(await db.all(read, [16, 'one'])).toEqual([{ label: 'one' }]);

      const list = `SELECT id FROM ${table} WHERE id = ? AND label = ?`;
      expect(await db.all(list, [16, 'one'])).toEqual([{ id: 16 }]);
      expect(await db.get(list, [16, 'one'])).toEqual({ id: 16 });
    });

    it('keys a read bound to a bigint, which JSON cannot write', async () => {
      await db.run(`INSERT INTO ${table} (id, label) VALUES (?, ?)`, [17, 'big']);
      const byId = `SELECT label FROM ${table} WHERE id = ?::bigint`;
      expect(await db.get(byId, [17n])).toEqual({ label: 'big' });
      expect(await db.get(byId, [17n])).toEqual({ label: 'big' });
      expect(await db.all(byId, [17n])).toEqual([{ label: 'big' }]);
    });

    it('keys a read bound to NaN or an infinity apart from one bound to null, which JSON writes alike', async () => {
      await db.run(`UPDATE ${table} SET label = label WHERE id = ?`, [17]);
      const shown = 'SELECT ?::float8::text AS shown';
      expect(await db.get(shown, [null])).toEqual({ shown: null });
      expect(await db.get(shown, [Number.NaN])).toEqual({ shown: 'NaN' });
      expect(await db.get(shown, [Number.POSITIVE_INFINITY])).toEqual({ shown: 'Infinity' });
      expect(await db.all(shown, [Number.NEGATIVE_INFINITY])).toEqual([{ shown: '-Infinity' }]);
    });

    it('keys a read bound to a Date apart from one bound to its ISO text, which pg binds as other text', async () => {
      // pg binds a Date as local time with its offset, and JSON writes it as its ISO text.
      await db.run(`UPDATE ${table} SET label = label WHERE id = ?`, [17]);
      const at = new Date(Date.UTC(2026, 9, 17, 22, 4, 37));
      const shown = 'SELECT ?::text AS shown';
      const fromDate = await db.get<{ shown: string }>(shown, [at]);
      expect(new Date(String(fromDate?.shown)).getTime()).toBe(at.getTime());
      expect(await db.get(shown, [at.toISOString()])).toEqual({ shown: at.toISOString() });
      expect(await db.get(shown, [at])).toEqual(fromDate);
    });

    it('answers a copy, so a caller that changes the row or list it was given changes nothing the cache answers next', async () => {
      await db.run(`INSERT INTO ${table} (id, label) VALUES (?, ?)`, [18, 'as stored']);
      const read =
        `SELECT label, ARRAY[id] AS ids, json_build_object('label', label) AS doc, ` +
        `'2026-10-17T22:04:37Z'::timestamptz AS at, decode('ff', 'hex') AS bytes FROM ${table} WHERE id = ?`;
      const stored = {
        label: 'as stored',
        ids: [18],
        doc: { label: 'as stored' },
        at: new Date(Date.UTC(2026, 9, 17, 22, 4, 37)),
        bytes: Buffer.from([0xff]),
      };

      // The first caller's row, which the cache kept, then the row of a hit.
      for (let pass = 0; pass < 2; pass += 1) {
        const row = await db.get<typeof stored>(read, [18]);
        expect(row).toEqual(stored);
        expect(Buffer.isBuffer(row?.bytes)).toBe(true);
        if (!row) return;
        row.label = 'changed';
        row.ids.push(19);
        row.doc.label = 'changed';
        row.at.setTime(0);
        row.bytes[0] = 0;
      }
      expect(await db.get(read, [18])).toEqual(stored);

      const rows = await db.all<typeof stored>(read, [18]);
      expect(rows).toEqual([stored]);
      rows.pop();
      expect(await db.all(read, [18])).toEqual([stored]);
    });

    it('keeps no answer it cannot copy, such as an interval, which pg parses to an object of its own', async () => {
      const span = "SELECT '1 hour'::interval AS span";
      const first = await db.get<{ span: { hours?: number } }>(span);
      expect(first?.span.hours).toBe(1);
      if (!first) return;
      first.span.hours = 5;

      const hits = hitsSoFar();
      expect((await db.get<{ span: { hours?: number } }>(span))?.span.hours).toBe(1);
      expect((await db.all<{ span: { hours?: number } }>(span))[0]?.span.hours).toBe(1);
      expect(hitsSoFar()).toBe(hits);
    });

    it('takes a string of statements for a write, whatever it commits before it ends', async () => {
      const read = `SELECT label FROM ${table} WHERE id = ?`;
      await db.run(`INSERT INTO ${table} (id, label) VALUES (?, ?)`, [20, 'one']);
      expect(await db.get(read, [20])).toEqual({ label: 'one' });

      // With no parameters pg sends the text as one simple query, and PostgreSQL runs each statement in it: the
      // COMMIT ends the transaction the SELECT began in, and the UPDATE commits in one of its own.
      expect(await db.all(`SELECT 1 AS one; COMMIT; UPDATE ${table} SET label = 'two' WHERE id = 20`)).toEqual([]);
      expect(await db.get(read, [20])).toEqual({ label: 'two' });
      expect(await db.get(`SELECT 1 AS one; COMMIT; UPDATE ${table} SET label = 'three' WHERE id = 20`)).toBeNull();
      expect(await db.get(read, [20])).toEqual({ label: 'three' });
    });

    it('keys a read bound to bytes apart from one bound to an object that JSON writes alike', async () => {
      // pg binds bytes as they are and any other object as its JSON text.
      const size = 'SELECT length(?::bytea) AS n';
      expect(await db.get(size, [Buffer.from([1])])).toEqual({ n: 1 });
      expect(await db.get(size, [{ type: 'Buffer', data: [1] }])).toEqual({ n: 28 });
      expect(await db.get(size, [Uint8Array.of(1, 2)])).toEqual({ n: 2 });
      expect(await db.get(size, [{ 0: 1, 1: 2 }])).toEqual({ n: 13 });
    });

    it('keys a read bound to an object with a toPostgres of its own by the text it gives when the call is made', async () => {
      const cents = 'SELECT ?::int AS cents';
      expect(await db.get(cents, [{ toPostgres: () => '1' }])).toEqual({ cents: 1 });
      expect(await db.get(cents, [{ toPostgres: () => '2' }])).toEqual({ cents: 2 });
    });

    it('keys a read bound to a Date made in another realm as a Date', async () => {
      const shown = 'SELECT ?::text AS shown';
      const foreign = runInNewContext('new Date(0)') as Date;
      expect(foreign instanceof Date).toBe(false);
      const iso = foreign.toISOString();
      expect(await db.get(shown, [iso])).toEqual({ shown: iso });

      const fromDate = await db.get<{ shown: string }>(shown, [foreign]);
      expect(fromDate?.shown).not.toBe(iso);
      expect(new Date(String(fromDate?.shown)).getTime()).toBe(0);
    });

    it('answers no read bound to text holding U+0000 from the cache, as PostgreSQL refuses that text', async () => {
      const at = 'SELECT ?::timestamptz AS at';
      expect(await db.get(at, [new Date(0)])).toEqual({ at: new Date(0) });
      await expect(db.get(at, ['\u0000date:0'])).rejects.toThrow(/^Query failed: /);
    });

    it("keeps PostgreSQL's error code on a SELECT that fails, keeps nothing of it, and answers the next read", async () => {
      // More failed SELECTs than the pool holds clients: each one gives its client back.
      for (let attempt = 0; attempt < 25; attempt += 1) {
        const failed = await db.get('SELECT 1 / 0 AS quotient').catch((caught: unknown) => caught);
        expect((failed as { code?: string }).code).toBe('22012');
        expect(String((failed as Error).message)).toMatch(/^Query failed: /);
      }
      expect(await db.all(`SELECT label AS after_failures FROM ${table} WHERE id = ?`, [15])).toEqual([
        { after_failures: 'kept' },
      ]);
    });

    it('keeps nothing of a read that was in flight across a write', async () => {
      await db.run(`INSERT INTO ${table} (id, label) VALUES (?, ?)`, [13, 'before']);
      // A statement reads the rows as they stood when it began; the write commits while this one sleeps.
      const slow = `SELECT label FROM ${table} CROSS JOIN pg_sleep(1) WHERE id = ?`;
      const pending = db.get(slow, [13]);
      await new Promise((resolve) => setTimeout(resolve, 250));
      await db.run(`UPDATE ${table} SET label = ? WHERE id = ?`, ['after', 13]);
      expect(await pending).toEqual({ label: 'before' });
      expect(await db.get(slow, [13])).toEqual({ label: 'after' });
    });

    it('binds and keys each parameter as it was when the call was made, whatever the caller changes after', async () => {
      // A read the cache may keep runs on a client of its own, which it waits for: the values it was given are bound
      // then, and the caller may have changed them by that time.
      await db.run(`INSERT INTO ${table} (id, label) VALUES (?, ?), (?, ?)`, [21, 'twenty-one', 22, 'twenty-two']);

      const byId = `SELECT label FROM ${table} WHERE id = ?`;
      const positional = [21];
      const first = db.get(byId, positional);
      positional[0] = 22;
      expect(await first).toEqual({ label: 'twenty-one' });
      expect(await db.get(byId, [21])).toEqual({ label: 'twenty-one' });
      expect(await db.get(byId, [22])).toEqual({ label: 'twenty-two' });

      const byName = `SELECT label AS named FROM ${table} WHERE id = @id`;
      const named = { id: 21 };
      const second = db.get(byName, named);
      named.id = 22;
      expect(await second).toEqual({ named: 'twenty-one' });
      expect(await db.get(byName, { id: 21 })).toEqual({ named: 'twenty-one' });

      const byDocument = `SELECT label AS from_document FROM ${table} WHERE id = (?::jsonb ->> 'id')::int`;
      const document = { id: 21 };
      const third = db.all(byDocument, [document]);
      document.id = 22;
      expect(await third).toEqual([{ from_document: 'twenty-one' }]);
      expect(await db.all(byDocument, [{ id: 21 }])).toEqual([{ from_document: 'twenty-one' }]);
    });

    it('keys named parameters by the values bound for them, own or inherited, enumerable or not', async () => {
      await db.run(`INSERT INTO ${table} (id, label) VALUES (?, ?), (?, ?)`, [23, 'twenty-three', 24, 'twenty-four']);
      const byName = `SELECT label AS hidden FROM ${table} WHERE id = @id`;
      expect(await db.get(byName, Object.defineProperty({}, 'id', { value: 23 }))).toEqual({ hidden: 'twenty-three' });
      expect(await db.get(byName, Object.defineProperty({}, 'id', { value: 24 }))).toEqual({ hidden: 'twenty-four' });

      // A name the object inherits is bound as well: from a plain object, Object.prototype's constructor.
      const shown = 'SELECT @constructor::text AS shown';
      expect((await db.get<{ shown: string | null }>(shown, {}))?.shown).toMatch(/function Object/);
      expect(await db.get(shown, Object.create(null))).toEqual({ shown: null });
    });

    it('keys a Date by the text pg binds for it when the call is made, which the time zone and pg.defaults decide', async () => {
      const shown = 'SELECT ?::text AS shown';
      const at = new Date(Date.UTC(2026, 0, 1));
      const zone = process.env.TZ;
      const asUtc = pg.defaults.parseInputDatesAsUTC;
      try {
        process.env.TZ = 'America/New_York';
        pg.defaults.parseInputDatesAsUTC = false;
        expect(await db.get(shown, [at])).toEqual({ shown: '2025-12-31T19:00:00.000-05:00' });
        pg.defaults.parseInputDatesAsUTC = true;
        expect(await db.get(shown, [at])).toEqual({ shown: '2026-01-01T00:00:00.000+00:00' });
      } finally {
        if (zone === undefined) delete process.env.TZ;
        else process.env.TZ = zone;
        pg.defaults.parseInputDatesAsUTC = asUtc;
      }
    });

    it('reads a carriage return as the end of a -- comment, as PostgreSQL does', async () => {
      // PostgreSQL ends a -- comment at \r as well as \n: this statement is the VALUES, which begins with a word
      // other than SELECT and so runs each time. nextval() gives no transaction ID on most calls.
      const ids = unique(`${table}_ids`);
      await db.exec(`CREATE SEQUENCE ${ids}`);
      try {
        const next = `-- the next id\rVALUES (nextval('${ids}')) /*\nSELECT */`;
        const drawn: number[] = [];
        for (let call = 0; call < 5; call += 1) {
          drawn.push(Number((await db.get<{ column1: string }>(next))?.column1));
        }
        expect(drawn).toEqual([1, 2, 3, 4, 5]);
      } finally {
        await db.exec(`DROP SEQUENCE ${ids}`);
      }
    });

    it('rejects a read whose session the server ends while the read runs, and the process carries on', async () => {
      const victim = await openAdapter({ cache: true });
      const marker = unique('ended_read');
      const reading = victim
        .get(`SELECT pg_sleep(5) AS slept, '${marker}' AS marker`)
        .catch((caught: unknown) => caught);
      await endSessionRunning(marker);
      const outcome = await reading;

      expect(String((outcome as Error).message)).toMatch(/^Query failed: /);
      expect((outcome as { code?: string }).code).toBe('57P01');
      expect(await victim.get('SELECT 1 AS one')).toEqual({ one: 1 });
    }, 15_000);

    it('gives up a session whose cached read timed out, so the next statement does not run in its transaction', async () => {
      const victim = await openAdapter({ cache: true, url: timingOutAfter(500) });
      await db.run(`INSERT INTO ${table} (id, label) VALUES (?, ?)`, [25, 'before']);
      const outcome = await victim.get('SELECT pg_sleep(1.5) AS slept').catch((caught: unknown) => caught);
      expect(String((outcome as Error).message)).toMatch(/timeout/i);

      await pause(1_500);
      await victim.run(`UPDATE ${table} SET label = ? WHERE id = ?`, ['after', 25]);
      expect(await admin.get(`SELECT label FROM ${table} WHERE id = ?`, [25])).toEqual({ label: 'after' });
    }, 15_000);
  });
});
