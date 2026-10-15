import { describe, expect, it, afterAll, beforeAll } from 'vitest';
import {
  createDatabase,
  createPostgresAdapter,
  createSqlJsAdapter,
  createStorageFeatures,
  type SqlDialect,
  type StorageAdapter,
} from '../src/index.js';

// Every SqlDialect form runs on PostgreSQL (CI's service, when
// POSTGRES_TEST_URL names it), better-sqlite3 and sql.js, and each spec expects
// the same rows on all three: parity is proven, not claimed.

const POSTGRES_TEST_URL = process.env.POSTGRES_TEST_URL;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const engines: Array<[string, () => Promise<StorageAdapter>]> = [
  ['better-sqlite3', () => createDatabase({ type: 'memory', foreignKeys: true })],
  [
    'sql.js',
    async () => {
      const adapter = createSqlJsAdapter();
      await adapter.open({ foreignKeys: true });
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

describe.each(engines)('SqlDialect parity on %s', (_engine, openAdapter) => {
  let db: StorageAdapter;
  let d: SqlDialect;
  const suffix = Math.random().toString(36).slice(2, 8);
  const items = `parity_items_${suffix}`;
  const children = `parity_children_${suffix}`;

  beforeAll(async () => {
    db = await openAdapter();
    d = createStorageFeatures(db).dialect;
    await db.exec(`
      CREATE TABLE ${items} (
        id ${d.columnType('integer')} PRIMARY KEY,
        name ${d.columnType('text')},
        a ${d.columnType('integer')},
        b ${d.columnType('integer')},
        c ${d.columnType('integer')},
        doc ${d.columnType('json')},
        note ${d.columnType('text')}
      );
      CREATE TABLE ${children} (
        id ${d.columnType('integer')} PRIMARY KEY,
        item_id ${d.columnType('integer')} REFERENCES ${items} (id) ON DELETE CASCADE
      );
    `);
    const rows: Array<[number, string, number | null, number | null, number | null, string]> = [
      [1, 'Alice', 3, null, 7, '{"a":{"b":2,"c":"x","d":1.5},"arr":[10,20],"tags":["red","blue"]}'],
      [2, 'bob', 1, 2, null, '{"a":{"b":5,"c":"y","d":2.5},"arr":[30],"tags":[1,2]}'],
      [3, 'ALBERT', null, null, null, '{"a":{"b":9,"c":"z","d":0.5},"arr":[],"tags":[]}'],
    ];
    for (const row of rows) {
      await db.run(`INSERT INTO ${items} (id, name, a, b, c, doc) VALUES (?, ?, ?, ?, ?, ?)`, row);
    }
    await db.run(`INSERT INTO ${children} (id, item_id) VALUES (?, ?)`, [100, 1]);
  });

  afterAll(async () => {
    await db.exec(`DROP TABLE IF EXISTS ${children}; DROP TABLE IF EXISTS ${items};`).catch(() => undefined);
    await db.close();
  });

  it('upserts on an explicit conflict target, updating the row in place', async () => {
    const sql = d.upsert(items, ['id', 'name'], ['?', '?'], ['id']);
    await db.run(sql, [1, 'Alicia']);
    await db.run(sql, [4, 'Dora']);

    expect(await db.all(`SELECT id, name, a, c FROM ${items} WHERE id IN (1, 4) ORDER BY id`)).toEqual([
      { id: 1, name: 'Alicia', a: 3, c: 7 },
      { id: 4, name: 'Dora', a: null, c: null },
    ]);
    // An update in place keeps the row's dependents; a delete would have cascaded.
    expect(await db.all(`SELECT id FROM ${children}`)).toEqual([{ id: 100 }]);
    await db.run(`DELETE FROM ${items} WHERE id = ?`, [4]);
  });

  it('keeps the row and its dependents on insertOrReplace, and does nothing when every column is the key', async () => {
    await db.run(d.insertOrReplace(items, ['id', 'note'], ['?', '?'], 'id'), [1, 'kept']);
    await db.run(d.upsert(items, ['id'], ['?'], ['id']), [1]);

    expect(await db.all(`SELECT id, name, note FROM ${items} WHERE id = 1`)).toEqual([{ id: 1, name: 'Alicia', note: 'kept' }]);
    expect(await db.all(`SELECT id FROM ${children}`)).toEqual([{ id: 100 }]);
  });

  it('reads the clock and moves a time by an interval', async () => {
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
    const row = await db.get(
      `SELECT
         CASE WHEN ${d.now()} > ${d.cast('?', 'timestamp')} THEN 1 ELSE 0 END AS later,
         CASE WHEN ${d.addInterval(d.cast('?', 'timestamp'), 2, 'hours')} = ${d.cast('?', 'timestamp')} THEN 1 ELSE 0 END AS plus_two_hours,
         CASE WHEN ${d.addInterval(d.cast('?', 'timestamp'), -1.5, 'days')} = ${d.cast('?', 'timestamp')} THEN 1 ELSE 0 END AS minus_day_and_half,
         ${d.dateBucket('year', d.now())} AS this_year`,
      [hourAgo, '2026-10-15T12:00:00.000Z', '2026-10-15T14:00:00.000Z', '2026-10-15T12:00:00.000Z', '2026-10-14T00:00:00.000Z'],
    );

    expect(row).toEqual({
      later: 1,
      plus_two_hours: 1,
      minus_day_and_half: 1,
      this_year: `${new Date().getUTCFullYear()}-01-01T00:00:00.000Z`,
    });
  });

  it('buckets times by minute, hour, day, month and year as ISO text', async () => {
    const at = '2026-10-15T12:34:56.789Z';
    const ts = d.cast('?', 'timestamp');

    expect(
      await db.get(
        `SELECT ${d.dateBucket('minute', ts)} AS minute, ${d.dateBucket('hour', ts)} AS hour, ${d.dateBucket('day', ts)} AS day,
                ${d.dateBucket('month', ts)} AS month, ${d.dateBucket('year', ts)} AS year`,
        [at, at, at, at, at],
      ),
    ).toEqual({
      minute: '2026-10-15T12:34:00.000Z',
      hour: '2026-10-15T12:00:00.000Z',
      day: '2026-10-15T00:00:00.000Z',
      month: '2026-10-01T00:00:00.000Z',
      year: '2026-01-01T00:00:00.000Z',
    });
  });

  it('matches LIKE without regard to ASCII case', async () => {
    expect(await db.all(`SELECT id FROM ${items} WHERE ${d.ilike('name', '?')} ORDER BY id`, ['al%'])).toEqual([
      { id: 1 },
      { id: 3 },
    ]);
  });

  it('tests membership in a list, an empty list and an array bound as one parameter', async () => {
    expect(await db.all(`SELECT id FROM ${items} WHERE ${d.inList('id', ['?', '?'])} ORDER BY id`, [2, 3])).toEqual([
      { id: 2 },
      { id: 3 },
    ]);
    expect(await db.all(`SELECT id FROM ${items} WHERE ${d.inList('id', [])}`)).toEqual([]);
    expect(await db.all(`SELECT id FROM ${items} WHERE ${d.inArray('id', '?')} ORDER BY id`, [[1, 3]])).toEqual([
      { id: 1 },
      { id: 3 },
    ]);
  });

  it('tests whether a JSON array holds a value', async () => {
    expect(await db.all(`SELECT id FROM ${items} WHERE ${d.jsonArrayContains(d.jsonExtractAs('doc', '$.tags', 'json'), '?')} ORDER BY id`, ['red'])).toEqual([{ id: 1 }]);
    expect(await db.all(`SELECT id FROM ${items} WHERE ${d.jsonArrayContains(d.jsonExtractAs('doc', '$.tags', 'json'), '?')} ORDER BY id`, [2])).toEqual([{ id: 2 }]);
  });

  it('reads typed values out of JSON', async () => {
    expect(
      await db.get(
        `SELECT ${d.jsonExtractAs('doc', '$.a.b', 'integer')} AS b, ${d.jsonExtractAs('doc', '$.a.c', 'text')} AS c,
                ${d.jsonExtractAs('doc', '$.a.d', 'real')} AS dd, ${d.jsonExtractAs('doc', '$.arr[1]', 'integer')} AS second
         FROM ${items} WHERE id = 1`,
      ),
    ).toEqual({ b: 2, c: 'x', dd: 1.5, second: 20 });
    expect(() => d.jsonExtractAs('doc', "$.a'); DROP TABLE x; --", 'text')).toThrow(/JSON path/);
  });

  it('locks rows and takes an advisory transaction lock where the engine has them, with the same rows', async () => {
    const rows = await db.transaction(async (trx) => {
      const lock = d.advisoryTransactionLock('?');
      if (lock) await trx.get(lock, [424242]);
      return trx.all(`SELECT id FROM ${items} WHERE id IN (1, 2) ORDER BY id${d.rowLock('update', 'skipLocked')}`);
    });

    expect(rows).toEqual([{ id: 1 }, { id: 2 }]);
    expect(d.rowLock('share')).toBe(d.name === 'postgres' ? ' FOR SHARE' : '');
  });

  it('takes the greatest and the least, skipping NULLs', async () => {
    expect(
      await db.all(
        `SELECT id, ${d.greatest('a', 'b', 'c')} AS g, ${d.least('a', 'b', 'c')} AS l FROM ${items} WHERE id IN (1, 2, 3) ORDER BY id`,
      ),
    ).toEqual([
      { id: 1, g: 7, l: 3 },
      { id: 2, g: 2, l: 1 },
      { id: 3, g: null, l: null },
    ]);
  });

  it('casts to text, integer and real the same way', async () => {
    expect(
      await db.get(`SELECT ${d.cast('?', 'integer')} AS i, ${d.cast('?', 'real')} AS r, ${d.cast('?', 'text')} AS t`, ['42', '1.5', 7]),
    ).toEqual({ i: 42, r: 1.5, t: '7' });
  });

  it('makes version 4 UUIDs', async () => {
    const row = await db.get<{ one: string; two: string }>(`SELECT ${d.uuid()} AS one, ${d.uuid()} AS two`);

    expect(row?.one).toMatch(UUID_V4);
    expect(row?.two).toMatch(UUID_V4);
    expect(row?.one).not.toBe(row?.two);
  });

  it('declares columns that take the same values back', async () => {
    const table = `parity_types_${suffix}`;
    await db.exec(`CREATE TABLE ${table} (
      t ${d.columnType('text')}, i ${d.columnType('integer')}, big ${d.columnType('bigint')}, r ${d.columnType('real')},
      flag ${d.columnType('boolean')}, at ${d.columnType('timestamp')}, doc ${d.columnType('json')},
      id ${d.columnType('uuid')}, bytes ${d.columnType('blob')}
    )`);
    await db.run(`INSERT INTO ${table} (t, i, big, r, flag, at, doc, id, bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      'text',
      7,
      9007199254740991,
      2.5,
      true,
      new Date('2026-10-15T12:34:56.789Z'),
      JSON.stringify({ a: 1 }),
      '6f1c1b2e-6a3b-4c1d-8e2f-0a1b2c3d4e5f',
      new Uint8Array([1, 2, 3]),
    ]);

    const row = await db.get<Record<string, unknown>>(`SELECT * FROM ${table}`);
    await db.exec(`DROP TABLE ${table}`);
    expect({
      t: row?.t,
      i: row?.i,
      big: Number(row?.big),
      r: row?.r,
      flag: Boolean(row?.flag),
      at: new Date(row?.at as string | Date).toISOString(),
      doc: typeof row?.doc === 'string' ? JSON.parse(row.doc) : row?.doc,
      id: row?.id,
      bytes: Array.from(row?.bytes as Uint8Array),
    }).toEqual({
      t: 'text',
      i: 7,
      big: 9007199254740991,
      r: 2.5,
      flag: true,
      at: '2026-10-15T12:34:56.789Z',
      doc: { a: 1 },
      id: '6f1c1b2e-6a3b-4c1d-8e2f-0a1b2c3d4e5f',
      bytes: [1, 2, 3],
    });
  });
});
