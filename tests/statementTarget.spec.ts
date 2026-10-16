import { describe, expect, it } from 'vitest';
import { writtenTables } from '../src/shared/statementTarget.js';

describe('the tables a statement writes', () => {
  it.each([
    ['INSERT OR IGNORE INTO notes VALUES (1)', 'notes', 'insert'],
    ['INSERT OR REPLACE INTO main.notes VALUES (1)', 'main.notes', 'insert'],
    ['REPLACE INTO `note``book` VALUES (1)', 'note`book', 'insert'],
    ['UPDATE OR FAIL [notes] SET label = 1', 'notes', 'update'],
    ['UPDATE ONLY "App"."Note""Book" SET label = $1', 'App.Note"Book', 'update'],
    ['DELETE FROM ONLY app.notes WHERE id = $1', 'app.notes', 'delete'],
    ['-- DELETE FROM decoy\n/* INSERT INTO decoy */ update notes SET label = 1', 'notes', 'update'],
    ["WITH picked AS (SELECT 'it''s; UPDATE decoy' AS label) INSERT INTO notes SELECT * FROM picked", 'notes', 'insert'],
    ['WITH picked AS (SELECT $$); DELETE FROM decoy; ($$) UPDATE notes SET label = 1', 'notes', 'update'],
    ['WITH picked AS (SELECT $body$); INSERT INTO decoy; ($body$) DELETE FROM notes', 'notes', 'delete'],
    ['WITH RECURSIVE picked(id) AS (SELECT 1 UNION ALL SELECT id + 1 FROM picked WHERE id < 3) DELETE FROM notes', 'notes', 'delete'],
    ['WITH a AS (SELECT (1)), b AS (SELECT * FROM a) REPLACE INTO notes SELECT * FROM b', 'notes', 'insert'],
    ['INSERT INTO notes VALUES (1); DELETE FROM other', 'notes', 'insert'],
  ])('names the target of %s', (statement, table, operation) => {
    expect(writtenTables(statement)).toEqual([{ table, operation }]);
  });

  it.each([
    'TRUNCATE notes, app.other RESTART IDENTITY CASCADE',
    'TRUNCATE TABLE ONLY notes, ONLY app.other CONTINUE IDENTITY RESTRICT',
  ])('reports every truncated table as a delete: %s', (statement) => {
    expect(writtenTables(statement)).toEqual([
      { table: 'notes', operation: 'delete' },
      { table: 'app.other', operation: 'delete' },
    ]);
  });

  it.each([
    '', ' \n\t ', '-- UPDATE notes', '/* DELETE FROM notes',
    'SELECT * FROM notes; DELETE FROM notes',
    'WITH picked AS (SELECT 1) SELECT * FROM picked',
    'WITH picked AS (SELECT 1)',
    "WITH picked AS (SELECT 'unterminated DELETE FROM notes",
    'WITH picked AS (SELECT $body$unterminated DELETE FROM notes',
    'WITH picked AS (SELECT $$unterminated DELETE FROM notes',
    'INSERT notes VALUES (1)', 'INSERT INTO', 'INSERT INTO (',
    'REPLACE notes', 'UPDATE', 'UPDATE ONLY (',
    'DELETE notes', 'DELETE FROM', 'DELETE FROM ONLY (', 'TRUNCATE TABLE',
    'CREATE FUNCTION f() RETURNS void AS $$BEGIN DELETE FROM notes; END$$ LANGUAGE plpgsql',
  ])('does not invent a target for a read, comment, body or incomplete write: %s', (statement) => {
    expect(writtenTables(statement)).toEqual([]);
  });
});
