import { describe, it, expect } from 'vitest';
import { SqliteFts5 } from '../src/fts/SqliteFts5.js';
import { PostgresFts } from '../src/fts/PostgresFts.js';
import { splitSqlStatements } from '../src/shared/splitSqlStatements.js';

describe('SqliteFts5', () => {
  const fts = new SqliteFts5();

  it('createIndex generates FTS5 virtual table DDL', () => {
    const ddl = fts.createIndex({
      table: 'memory_traces_fts',
      columns: ['content', 'tags'],
      contentTable: 'memory_traces',
      tokenizer: 'porter ascii',
    });
    expect(ddl).toContain('CREATE VIRTUAL TABLE IF NOT EXISTS memory_traces_fts USING fts5');
    expect(ddl).toContain('content, tags');
    expect(ddl).toContain("content='memory_traces'");
    expect(ddl).toContain("tokenize='porter ascii'");
  });

  it('matchClause generates MATCH expression', () => {
    expect(fts.matchClause('memory_traces_fts', '?'))
      .toBe('memory_traces_fts MATCH ?');
  });

  it('rankExpression generates rank reference', () => {
    expect(fts.rankExpression('memory_traces_fts'))
      .toContain('rank');
  });

  it('rebuildCommand generates rebuild insert', () => {
    expect(fts.rebuildCommand('memory_traces_fts'))
      .toBe("INSERT INTO memory_traces_fts(memory_traces_fts) VALUES('rebuild')");
  });

  it('syncInsert generates external-content insert', () => {
    const sql = fts.syncInsert('memory_traces_fts', '(SELECT rowid FROM memory_traces WHERE id = ?)', ['content', 'tags']);
    expect(sql).toContain('INSERT INTO memory_traces_fts');
    expect(sql).toContain('rowid, content, tags');
  });

  it('sanitizeQuery wraps words in quotes', () => {
    const q = fts.sanitizeQuery('dark mode preference');
    expect(q).toContain('"dark"');
    expect(q).toContain('"mode"');
  });

  it('joinClause generates FROM ... JOIN on rowid', () => {
    const clause = fts.joinClause('memory_traces', 't', 'fts', 'memory_traces_fts');
    expect(clause).toContain('memory_traces_fts fts');
    expect(clause).toContain('JOIN');
    expect(clause).toContain('rowid');
  });
});

describe('PostgresFts', () => {
  const fts = new PostgresFts();

  it('createIndex generates tsvector column + GIN index', () => {
    const ddl = fts.createIndex({
      table: 'memory_traces_fts',
      columns: ['content', 'tags'],
      contentTable: 'memory_traces',
      tokenizer: 'simple',
    });
    expect(ddl).toContain('ADD COLUMN IF NOT EXISTS _tsv tsvector');
    expect(ddl).toContain('USING GIN');
    expect(ddl).toContain("to_tsvector('simple'");
  });

  it('createIndex reads the catalog before it alters the table or creates the index, and backfills only the rows without a vector', () => {
    // Split as exec() splits it: each DO block keeps the semicolons inside it.
    const statements = splitSqlStatements(
      fts.createIndex({ table: 'notes_fts', columns: ['title', 'body'], contentTable: 'app.notes', tokenizer: 'porter' }),
    );
    expect(statements).toHaveLength(3);
    const [column, index, backfill] = statements;

    expect(column).toMatch(/^DO \$fts\$\nBEGIN\n[\s\S]*\nEND\n\$fts\$$/);
    const columnCheck =
      "IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('app.notes') AND attname = '_tsv' AND NOT attisdropped) THEN";
    const alter = 'ALTER TABLE app.notes ADD COLUMN IF NOT EXISTS _tsv tsvector;';
    expect(column.indexOf(columnCheck)).toBeGreaterThan(-1);
    expect(column.indexOf(alter)).toBeGreaterThan(column.indexOf(columnCheck));
    expect(column.indexOf('END IF;')).toBeGreaterThan(column.indexOf(alter));

    expect(index).toMatch(/^DO \$fts\$\nBEGIN\n[\s\S]*\nEND\n\$fts\$$/);
    const indexCheck =
      "IF to_regclass((SELECT relnamespace::regnamespace::text FROM pg_class WHERE oid = to_regclass('app.notes')) || '.idx_notes_fts_tsv') IS NULL THEN";
    const create = 'CREATE INDEX IF NOT EXISTS idx_notes_fts_tsv ON app.notes USING GIN(_tsv);';
    expect(index.indexOf(indexCheck)).toBeGreaterThan(-1);
    expect(index.indexOf(create)).toBeGreaterThan(index.indexOf(indexCheck));
    // A CREATE INDEX that loses the race to another session's takes the catalog's refusal as the index made.
    const lostRace = 'EXCEPTION WHEN unique_violation OR duplicate_table THEN NULL; END;';
    expect(index.indexOf(lostRace)).toBeGreaterThan(index.indexOf(create));
    expect(index.indexOf('END IF;')).toBeGreaterThan(index.indexOf(lostRace));

    expect(backfill).toBe(
      "UPDATE app.notes SET _tsv = to_tsvector('english', COALESCE(title, '') || ' ' || COALESCE(body, '')) WHERE _tsv IS NULL",
    );
  });

  it('createIndex doubles the quotes of the content table in its catalog reads, and picks a block tag the name does not hold', () => {
    const statements = splitSqlStatements(fts.createIndex({ table: 'odd_fts', columns: ['body'], contentTable: `"it's$fts$odd"` }));
    expect(statements).toHaveLength(3);
    const [column, index, backfill] = statements;

    expect(column).toMatch(/^DO \$fts1\$\nBEGIN\n[\s\S]*\nEND\n\$fts1\$$/);
    expect(column).toContain(`attrelid = to_regclass('"it''s$fts$odd"')`);
    expect(column).toContain(`ALTER TABLE "it's$fts$odd" ADD COLUMN IF NOT EXISTS _tsv tsvector;`);
    expect(index).toMatch(/^DO \$fts1\$\nBEGIN\n[\s\S]*\nEND\n\$fts1\$$/);
    expect(index).toContain(`oid = to_regclass('"it''s$fts$odd"')`);
    expect(backfill).toMatch(/^UPDATE "it's\$fts\$odd" SET _tsv = .* WHERE _tsv IS NULL$/);
  });

  it('matchClause generates @@ expression', () => {
    const clause = fts.matchClause('memory_traces_fts', '$1');
    expect(clause).toContain('@@');
    expect(clause).toContain('websearch_to_tsquery');
  });

  it('rankExpression generates ts_rank', () => {
    const expr = fts.rankExpression('memory_traces_fts', '$1');
    expect(expr).toContain('ts_rank');
  });

  it('syncInsert updates by id using bound values instead of rowid', () => {
    fts.createIndex({
      table: 'memory_traces_fts',
      columns: ['content', 'tags'],
      contentTable: 'memory_traces',
      tokenizer: 'simple',
    });
    const sql = fts.syncInsert('memory_traces_fts', '?', ['content', 'tags']);
    expect(sql).toContain('WHERE id = $1');
    expect(sql).toContain("COALESCE($2, '')");
    expect(sql).toContain("COALESCE($3, '')");
    expect(sql).toContain("to_tsvector('simple'");
  });

  it('rebuildCommand generates UPDATE with to_tsvector', () => {
    const cmd = fts.rebuildCommand('memory_traces_fts');
    expect(cmd).toContain('UPDATE');
    expect(cmd).toContain('to_tsvector');
  });

  it('joinClause returns content table only (no JOIN — tsvector is on the table)', () => {
    const clause = fts.joinClause('memory_traces', 't', 'fts', 'memory_traces_fts');
    expect(clause).toContain('memory_traces t');
    expect(clause).not.toContain('JOIN');
  });
});
