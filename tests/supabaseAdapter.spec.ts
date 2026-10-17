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

describe.skipIf(!POSTGRES_TEST_URL)('SupabaseAdapter', () => {
  const table = `supabase_${Math.random().toString(36).slice(2, 8)}`;
  const lines: Array<{ fields: Record<string, unknown>; message: string }> = [];
  const logger: StorageLogger = {
    info: () => undefined,
    warn: (fields, message) => lines.push({ fields, message }),
    error: () => undefined,
  };
  let db: SupabaseAdapter;

  beforeAll(async () => {
    setStorageLogger(logger);
    db = new SupabaseAdapter();
    await db.open({ connectionString: POSTGRES_TEST_URL, ssl: false });
    await db.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, label TEXT NOT NULL)`);
  });

  afterAll(async () => {
    await db.exec(`DROP TABLE IF EXISTS ${table}`).catch(() => undefined);
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
  });
});
