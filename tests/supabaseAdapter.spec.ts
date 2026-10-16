import { describe, expect, it, afterAll, beforeAll } from 'vitest';
import { SupabaseAdapter, isUniqueViolation, setStorageLogger, type StorageLogger } from '../src/index.js';

// The Supabase adapter is deprecated in favour of the PostgreSQL adapter,
// which reaches Supabase with its connection string. Until it goes, it reads
// `?` and `@name` placeholders as the PostgreSQL adapter does, keeps
// PostgreSQL's error code on the errors it throws, and says once, through the
// host logger, that it is deprecated and does not verify the server's
// certificate. These specs run when POSTGRES_TEST_URL names a server.

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
});
