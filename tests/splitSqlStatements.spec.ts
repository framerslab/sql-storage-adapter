import { describe, expect, it } from 'vitest';
import { splitSqlStatements, sqliteStatementSpans } from '../src/shared/splitSqlStatements.js';

describe('splitSqlStatements', () => {
  it('returns an empty array for empty or whitespace-only input', () => {
    expect(splitSqlStatements('')).toEqual([]);
    expect(splitSqlStatements('   \n\t  ')).toEqual([]);
    expect(splitSqlStatements(';;;')).toEqual([]);
  });

  it('splits simple multi-statement SQL on top-level semicolons', () => {
    const script = 'SELECT 1; SELECT 2; SELECT 3';
    expect(splitSqlStatements(script)).toEqual(['SELECT 1', 'SELECT 2', 'SELECT 3']);
  });

  it('drops trailing whitespace and empty fragments produced by trailing semicolons', () => {
    const script = 'SELECT 1;\n\nSELECT 2;\n';
    expect(splitSqlStatements(script)).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('preserves semicolons inside single-quoted strings', () => {
    const script = "INSERT INTO t (v) VALUES ('a;b;c'); SELECT 1";
    expect(splitSqlStatements(script)).toEqual([
      "INSERT INTO t (v) VALUES ('a;b;c')",
      'SELECT 1',
    ]);
  });

  it("preserves doubled-up '' escape inside single-quoted strings", () => {
    const script = "INSERT INTO t (v) VALUES ('it''s; fine'); SELECT 1";
    expect(splitSqlStatements(script)).toEqual([
      "INSERT INTO t (v) VALUES ('it''s; fine')",
      'SELECT 1',
    ]);
  });

  it('preserves semicolons inside double-quoted identifiers', () => {
    const script = 'SELECT "weird;col" FROM t; SELECT 1';
    expect(splitSqlStatements(script)).toEqual([
      'SELECT "weird;col" FROM t',
      'SELECT 1',
    ]);
  });

  it('preserves "" escape inside double-quoted identifiers', () => {
    const script = 'SELECT "a""b;c" FROM t; SELECT 1';
    expect(splitSqlStatements(script)).toEqual([
      'SELECT "a""b;c" FROM t',
      'SELECT 1',
    ]);
  });

  it('preserves semicolons inside `--` line comments', () => {
    const script = [
      'CREATE TABLE foo (',
      '  -- this comment has a ; in it which used to split the DDL',
      '  id TEXT PRIMARY KEY',
      ');',
      'CREATE INDEX idx ON foo(id)',
    ].join('\n');
    const result = splitSqlStatements(script);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain('CREATE TABLE foo');
    expect(result[0]).toContain('PRIMARY KEY');
    expect(result[0]).toMatch(/\)\s*$/);
    expect(result[1]).toBe('CREATE INDEX idx ON foo(id)');
  });

  it('preserves semicolons in `--` comments that end at EOF without a newline', () => {
    const script = 'SELECT 1; -- trailing; comment with semis';
    // The trailing comment is kept intact as its own fragment (Postgres treats
    // a comment-only query as a no-op). The point of this test is that the
    // splitter did NOT slice the comment at its embedded `;`.
    expect(splitSqlStatements(script)).toEqual([
      'SELECT 1',
      '-- trailing; comment with semis',
    ]);
  });

  it('preserves semicolons inside `/* */` block comments', () => {
    const script = 'SELECT 1 /* block; with; semis */ ; SELECT 2';
    expect(splitSqlStatements(script)).toEqual([
      'SELECT 1 /* block; with; semis */',
      'SELECT 2',
    ]);
  });

  it('preserves semicolons inside nested block comments (Postgres allows nesting)', () => {
    const script = 'SELECT 1 /* outer; /* inner; */ still outer; */ ; SELECT 2';
    expect(splitSqlStatements(script)).toEqual([
      'SELECT 1 /* outer; /* inner; */ still outer; */',
      'SELECT 2',
    ]);
  });

  it('preserves semicolons inside untagged dollar-quoted strings', () => {
    const script = "INSERT INTO t (b) VALUES ($$body; with; semis$$); SELECT 1";
    expect(splitSqlStatements(script)).toEqual([
      'INSERT INTO t (b) VALUES ($$body; with; semis$$)',
      'SELECT 1',
    ]);
  });

  it('preserves semicolons inside tagged dollar-quoted strings', () => {
    const script = "CREATE FUNCTION f() RETURNS void AS $func$ BEGIN PERFORM 1; PERFORM 2; END $func$ LANGUAGE plpgsql; SELECT 1";
    const result = splitSqlStatements(script);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain('$func$ BEGIN PERFORM 1; PERFORM 2; END $func$');
    expect(result[1]).toBe('SELECT 1');
  });

  it('does not confuse $ inside identifiers with dollar-quote start', () => {
    // `$1`, `$2` are positional params, not dollar-quote openers.
    const script = 'SELECT $1, $2 FROM t WHERE id = $3; SELECT 1';
    expect(splitSqlStatements(script)).toEqual([
      'SELECT $1, $2 FROM t WHERE id = $3',
      'SELECT 1',
    ]);
  });

  it('handles the exact foundation_session_npcs DDL that broke production', () => {
    // Reproduction of the comment text that broke wilds-ai prod at 320604d81.
    // Two `--` line comments each contained an embedded semicolon which the
    // naive `.split(';')` sliced at, leaving an unclosed CREATE TABLE paren
    // that Postgres rejected with 42601 "syntax error at end of input".
    const script = `
      CREATE TABLE IF NOT EXISTS foundation_session_npcs (
        id TEXT PRIMARY KEY,
        -- FK constraints mirror migration 085. Without them a session
        -- delete leaves orphan rows and a companion delete leaves
        -- exported_companion_id pointing nowhere. SQLite enforces FK
        -- constraints only when PRAGMA foreign_keys = ON; the adapter
        -- sets this at connection time.
        session_id TEXT NOT NULL REFERENCES foundation_sessions(session_id) ON DELETE CASCADE,
        npc_id TEXT NOT NULL,
        exported_companion_id TEXT REFERENCES foundation_companions(companion_id) ON DELETE SET NULL,
        created_at_ms BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_session_npcs_session ON foundation_session_npcs(session_id);
      -- Partial index matches migration 085: only NPCs that have been
      -- exported as companions need indexed lookup; NULL exported_companion_id
      -- is the common case and indexing those rows just bloats the index.
      CREATE INDEX IF NOT EXISTS idx_session_npcs_exported ON foundation_session_npcs(exported_companion_id)
        WHERE exported_companion_id IS NOT NULL;
    `;
    const result = splitSqlStatements(script);
    expect(result).toHaveLength(3);

    // Statement 1: the CREATE TABLE must be intact -- balanced parens, ends with )
    const createTable = result[0];
    expect(createTable).toMatch(/^CREATE TABLE IF NOT EXISTS foundation_session_npcs/);
    expect(createTable).toMatch(/\)$/);
    const opens = (createTable.match(/\(/g) ?? []).length;
    const closes = (createTable.match(/\)/g) ?? []).length;
    expect(opens).toBe(closes);

    // Statement 2: the first CREATE INDEX, intact
    expect(result[1]).toMatch(/^CREATE INDEX IF NOT EXISTS idx_session_npcs_session/);

    // Statement 3: the partial-index CREATE INDEX (with leading `--` comments
    // attached to the same fragment, which Postgres accepts), WHERE intact
    expect(result[2]).toContain('CREATE INDEX IF NOT EXISTS idx_session_npcs_exported');
    expect(result[2]).toContain('WHERE exported_companion_id IS NOT NULL');
  });

  it('does not start a dollar-quote on a bare `$` followed by non-identifier', () => {
    // `$ ` (space) and `$,` etc. should NOT open a dollar-quote.
    const script = "SELECT '$' || ' literal'; SELECT 1";
    expect(splitSqlStatements(script)).toEqual([
      "SELECT '$' || ' literal'",
      'SELECT 1',
    ]);
  });
});

describe('sqliteStatementSpans', () => {
  const texts = (script: string): string[] => sqliteStatementSpans(script).map(({ start, end }) => script.slice(start, end));

  it('cuts a script at the semicolons outside strings, quoted names and comments, and leaves the whitespace out', () => {
    const script =
      'PRAGMA foreign_keys = OFF;\n' +
      'CREATE TABLE [a;b] (id INTEGER PRIMARY KEY, "x;y" TEXT, `p;q` TEXT);\n' +
      "INSERT INTO [a;b] VALUES (1, 'it''s; fine', 'two'); -- a comment; with a semicolon\n" +
      '/* a block; comment */ PRAGMA foreign_keys = ON;';
    expect(texts(script)).toEqual([
      'PRAGMA foreign_keys = OFF',
      'CREATE TABLE [a;b] (id INTEGER PRIMARY KEY, "x;y" TEXT, `p;q` TEXT)',
      "INSERT INTO [a;b] VALUES (1, 'it''s; fine', 'two')",
      '-- a comment; with a semicolon\n/* a block; comment */ PRAGMA foreign_keys = ON',
    ]);
  });

  it('answers no span for an empty script, and one for a script with no semicolon', () => {
    expect(sqliteStatementSpans('')).toEqual([]);
    expect(sqliteStatementSpans(' ;; \n')).toEqual([]);
    expect(texts('SELECT 1')).toEqual(['SELECT 1']);
  });

  it('runs an unterminated quote or comment to the end of the script', () => {
    expect(texts("SELECT 'open; still the string")).toEqual(["SELECT 'open; still the string"]);
    expect(texts('SELECT 1; -- trailing; comment')).toEqual(['SELECT 1', '-- trailing; comment']);
  });

  it('gives offsets that slice the script', () => {
    const script = '  SELECT 1 ;SELECT 2';
    expect(sqliteStatementSpans(script)).toEqual([
      { start: 2, end: 10 },
      { start: 12, end: 20 },
    ]);
  });
});
