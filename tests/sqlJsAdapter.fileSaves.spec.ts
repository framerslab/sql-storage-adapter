import { describe, expect, it, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import initSqlJs from 'sql.js';
import { SqlJsAdapter } from '../src/adapters/sqlJsAdapter';
import { setStorageLogger, type StorageLogger } from '../src/shared/logger';

// With a filePath, the sql.js adapter writes the database image to its file
// after each write outside a transaction. The image comes from sql.js's
// export(), which closes the connection and opens it again. These specs read
// the file as another process opening it would, and the connection's
// settings after a save.

/** The labels in the items table of the image the file holds now. */
const fileLabels = async (file: string): Promise<string[]> => {
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(file));
  try {
    const result = db.exec('SELECT label FROM items ORDER BY id');
    return result.length ? result[0].values.map(([label]) => String(label)) : [];
  } finally {
    db.close();
  }
};

/** A PRAGMA's value in the image the file holds now. */
const filePragma = async (file: string, name: string): Promise<unknown> => {
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(file));
  try {
    return db.exec(`PRAGMA ${name}`)[0]?.values?.[0]?.[0];
  } finally {
    db.close();
  }
};

describe('SqlJsAdapter saves to its file', () => {
  const opened: SqlJsAdapter[] = [];
  const dirs: string[] = [];

  const tempFile = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqljs-file-saves-'));
    dirs.push(dir);
    return path.join(dir, 'app.sqlite3');
  };

  const openAt = async (file: string, foreignKeys?: boolean): Promise<SqlJsAdapter> => {
    const adapter = new SqlJsAdapter();
    opened.push(adapter);
    await adapter.open({ filePath: file, foreignKeys });
    return adapter;
  };

  const openWithItems = async (file: string): Promise<SqlJsAdapter> => {
    const adapter = await openAt(file);
    await adapter.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL)');
    return adapter;
  };

  const labels = async (adapter: SqlJsAdapter): Promise<string[]> =>
    (await adapter.all<{ label: string }>('SELECT label FROM items ORDER BY id')).map((row) => row.label);

  afterEach(async () => {
    for (const adapter of opened.splice(0)) await adapter.close().catch(() => undefined);
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
    setStorageLogger(null);
  });

  describe('writes through all() and get()', () => {
    it('saves a write run through all() or get() outside a transaction at once, as run() does', async () => {
      const file = tempFile();
      const adapter = await openWithItems(file);

      expect(await adapter.all('INSERT INTO items (label) VALUES (?) RETURNING id', ['through all()'])).toEqual([
        { id: 1 },
      ]);
      expect(await fileLabels(file)).toEqual(['through all()']);

      expect(
        await adapter.get('UPDATE items SET label = ? WHERE id = 1 RETURNING label', ['through get()']),
      ).toEqual({ label: 'through get()' });
      expect(await fileLabels(file)).toEqual(['through get()']);
    });

    it('does not write the file for reads through all() and get(), WITH queries included', async () => {
      const file = tempFile();
      const adapter = await openWithItems(file);
      await adapter.run('INSERT INTO items (label) VALUES (?)', ['kept']);

      const writes = vi.spyOn(fs, 'writeFileSync');
      expect(await labels(adapter)).toEqual(['kept']);
      expect(await adapter.get('SELECT count(*) AS n FROM items')).toEqual({ n: 1 });
      expect(await adapter.all('WITH recent AS (SELECT label FROM items) SELECT label FROM recent')).toEqual([
        { label: 'kept' },
      ]);
      // PRAGMA statements that read: a setting, and one that takes a table.
      expect(await adapter.get('PRAGMA user_version')).toEqual({ user_version: 0 });
      expect((await adapter.all<{ name: string }>('PRAGMA table_info(items)')).map((column) => column.name)).toEqual([
        'id',
        'label',
      ]);

      expect(writes).not.toHaveBeenCalled();
    });

    it('saves a PRAGMA that sets a value in the file, run through get(), though it changes no rows', async () => {
      // user_version lives in the database header.
      const file = tempFile();
      const adapter = await openWithItems(file);

      await adapter.get('PRAGMA user_version = 7');

      expect(await filePragma(file, 'user_version')).toBe(7);
    });
  });

  describe('exec() scripts', () => {
    it('saves the statements a script ran before the one that failed', async () => {
      const file = tempFile();
      const adapter = await openWithItems(file);

      await expect(
        adapter.exec(
          "INSERT INTO items (label) VALUES ('before the failure'); INSERT INTO missing (label) VALUES ('never')",
        ),
      ).rejects.toThrow(/no such table: missing/);

      expect(await labels(adapter)).toEqual(['before the failure']);
      expect(await fileLabels(file)).toEqual(['before the failure']);
    });

    it('leaves open a transaction a script began, and saves its writes once COMMIT ends it', async () => {
      const file = tempFile();
      const adapter = await openWithItems(file);

      await adapter.exec("BEGIN; INSERT INTO items (label) VALUES ('in the script')");
      await adapter.run('INSERT INTO items (label) VALUES (?)', ['after the script']);
      expect(await fileLabels(file)).toEqual([]);

      await adapter.run('COMMIT');
      expect(await fileLabels(file)).toEqual(['in the script', 'after the script']);
    });

    it('leaves open a transaction a script began, so ROLLBACK undoes its writes', async () => {
      const file = tempFile();
      const adapter = await openWithItems(file);
      await adapter.run('INSERT INTO items (label) VALUES (?)', ['kept']);

      await adapter.exec("BEGIN; INSERT INTO items (label) VALUES ('rolled back')");
      await adapter.run('ROLLBACK');

      expect(await labels(adapter)).toEqual(['kept']);
      expect(await fileLabels(file)).toEqual(['kept']);
    });

    it('saves a script that commits a transaction run() began, and the writes after it', async () => {
      const file = tempFile();
      const adapter = await openWithItems(file);

      await adapter.run('BEGIN');
      await adapter.exec("INSERT INTO items (label) VALUES ('in the transaction'); COMMIT");
      expect(await fileLabels(file)).toEqual(['in the transaction']);

      await adapter.run('INSERT INTO items (label) VALUES (?)', ['after it']);
      expect(await fileLabels(file)).toEqual(['in the transaction', 'after it']);
    });
  });

  describe('transactions begun with statements', () => {
    it('keeps a savepoint open across ROLLBACK TO, so RELEASE ends it and saves what it kept', async () => {
      const file = tempFile();
      const adapter = await openWithItems(file);

      await adapter.run('SAVEPOINT outer_work');
      await adapter.run('INSERT INTO items (label) VALUES (?)', ['undone']);
      await adapter.run('ROLLBACK TO SAVEPOINT outer_work');
      await adapter.run('INSERT INTO items (label) VALUES (?)', ['kept']);
      expect(await fileLabels(file)).toEqual([]);

      await adapter.run('RELEASE outer_work');
      expect(await labels(adapter)).toEqual(['kept']);
      expect(await fileLabels(file)).toEqual(['kept']);
    });

    it('saves again after close() rolled back a transaction the caller left open', async () => {
      const file = tempFile();
      const adapter = await openWithItems(file);
      await adapter.run('INSERT INTO items (label) VALUES (?)', ['committed']);
      await adapter.run('BEGIN');
      await adapter.run('INSERT INTO items (label) VALUES (?)', ['never committed']);

      await adapter.close();
      expect(await fileLabels(file)).toEqual(['committed']);

      await adapter.open({ filePath: file });
      await adapter.run('INSERT INTO items (label) VALUES (?)', ['after the reopen']);
      expect(await fileLabels(file)).toEqual(['committed', 'after the reopen']);
    });
  });

  describe('connection settings across a save', () => {
    it('keeps a PRAGMA a statement set, which the save after that statement reset', async () => {
      const file = tempFile();
      const adapter = await openAt(file);
      await adapter.exec('PRAGMA foreign_keys = ON');
      await adapter.exec(
        'CREATE TABLE parent (id INTEGER PRIMARY KEY);' +
          'CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent (id));',
      );

      expect(await adapter.get('PRAGMA foreign_keys')).toEqual({ foreign_keys: 1 });
      await expect(adapter.run('INSERT INTO child (parent_id) VALUES (?)', [999])).rejects.toThrow(
        /FOREIGN KEY constraint failed/,
      );
    });

    it('keeps PRAGMA foreign_keys = OFF run after foreignKeys: true at open', async () => {
      // SQLite's procedure for changing a table turns enforcement off around the rebuild.
      const file = tempFile();
      const adapter = await openAt(file, true);
      expect(await adapter.get('PRAGMA foreign_keys')).toEqual({ foreign_keys: 1 });

      await adapter.exec('PRAGMA foreign_keys = OFF');
      await adapter.exec('CREATE TABLE parent (id INTEGER PRIMARY KEY)');

      expect(await adapter.get('PRAGMA foreign_keys')).toEqual({ foreign_keys: 0 });
    });

    it('keeps PRAGMA secure_delete = FAST, which reads back as 2', async () => {
      const file = tempFile();
      const adapter = await openWithItems(file);

      await adapter.exec('PRAGMA secure_delete = FAST');
      await adapter.run('INSERT INTO items (label) VALUES (?)', ['saved']);

      expect(await fileLabels(file)).toEqual(['saved']);
      expect(await adapter.get('PRAGMA secure_delete')).toEqual({ secure_delete: 2 });
    });

    it('warns once, through the host logger, that a save dropped TEMP tables', async () => {
      const warn = vi.fn();
      const logger: StorageLogger = { info: vi.fn(), warn, error: vi.fn() };
      setStorageLogger(logger);
      const file = tempFile();
      const adapter = await openWithItems(file);

      await adapter.exec('CREATE TEMP TABLE scratch (x INTEGER)');
      await adapter.exec('CREATE TEMP TABLE scratch_again (x INTEGER)');

      const tempWarnings = warn.mock.calls.filter((call) => /TEMP/.test(String(call[1])));
      expect(tempWarnings).toHaveLength(1);
      expect(tempWarnings[0][0]).toMatchObject({ scope: 'sqljs' });
    });
  });
});
