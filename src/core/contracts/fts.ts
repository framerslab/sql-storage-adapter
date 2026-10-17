/**
 * Full-text search abstraction.
 *
 * better-sqlite3 uses FTS5 virtual tables; sql.js and IndexedDB use FTS4, which
 * their stock sql.js build has (it has no FTS5). Postgres implementations use
 * tsvector columns with GIN indexes.
 * Methods return SQL strings — no database calls.
 */
export interface IFullTextSearch {
  /**
   * Generate DDL to create the full-text search index.
   *
   * Run it with `exec()`, which runs a script of several statements. On
   * PostgreSQL the script holds `DO` blocks with semicolons inside them, so a
   * caller that splits it on `;` itself would cut them.
   *
   * @param config.table - Name for the FTS index/virtual table.
   * @param config.columns - Columns to index.
   * @param config.contentTable - Source table (for external-content FTS5).
   * @param config.tokenizer - Tokenizer config (e.g. 'porter ascii').
   * @param config.weights - PostgreSQL: a weight per column (A highest, D lowest) for ranking. The SQLite engines rank without it.
   */
  createIndex(config: {
    table: string;
    columns: string[];
    contentTable?: string;
    tokenizer?: string;
    weights?: Record<string, 'A' | 'B' | 'C' | 'D'>;
  }): string;

  /**
   * Generate a WHERE clause fragment for full-text matching.
   * SQLite: `memory_traces_fts MATCH ?`
   * Postgres: `_tsv @@ websearch_to_tsquery('english', $1)`, in the index's own language
   */
  matchClause(indexName: string, queryPlaceholder: string): string;

  /**
   * A rank value, in each engine's own direction.
   * SQLite FTS5: `memory_traces_fts.rank` (lower is better)
   * SQLite FTS4: `length(offsets(memory_traces_fts))` (higher is better)
   * Postgres: `ts_rank(_tsv, websearch_to_tsquery('english', $1))` (higher is better)
   * Use relevanceOrder to order the same way on every engine.
   */
  rankExpression(indexName: string, queryPlaceholder?: string): string;

  /**
   * An ORDER BY fragment that puts the best match first on every engine.
   * SQLite FTS5: `memory_traces_fts.rank`
   * SQLite FTS4: `length(offsets(memory_traces_fts)) DESC`
   * Postgres: `ts_rank(_tsv, websearch_to_tsquery('english', $1)) DESC`
   */
  relevanceOrder(indexName: string, queryPlaceholder?: string): string;

  /**
   * Generate the rebuild/reindex command.
   * SQLite: `INSERT INTO fts_table(fts_table) VALUES('rebuild')`
   * Postgres: `UPDATE content_table SET _tsv = to_tsvector('english', col1 || ' ' || col2)`
   */
  rebuildCommand(indexName: string): string;

  /**
   * Generate an INSERT to sync external-content FTS after a row insert.
   * SQLite: `INSERT INTO fts_table (rowid, col1, col2) VALUES (expr, ?, ?)`
   * Postgres: `UPDATE content_table SET _tsv = to_tsvector(...) WHERE ...`
   */
  syncInsert(indexName: string, rowIdExpr: string, columns: string[]): string;

  /**
   * Sanitize natural-language input into a safe search query.
   * Every engine: the words, quoted, joined with OR, with the operators of
   * the query syntax stripped, so it matches the same rows everywhere.
   */
  sanitizeQuery(input: string): string;

  /**
   * Generate a SELECT joining the FTS index to the content table.
   * This handles the structural difference between FTS5 (separate virtual table
   * joined via rowid) and Postgres (tsvector column on the content table itself).
   *
   * @param contentTable - The base table (e.g. 'memory_traces').
   * @param contentAlias - Alias for the content table (e.g. 't').
   * @param ftsAlias - Alias for the FTS table/column (e.g. 'fts').
   * @param indexName - FTS index/virtual table name.
   * @returns FROM/JOIN clause fragment.
   */
  joinClause(contentTable: string, contentAlias: string, ftsAlias: string, indexName: string): string;
}
