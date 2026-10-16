import type { IFullTextSearch } from '../core/contracts/fts.js';

/**
 * SQLite FTS4 full-text search, for sql.js and the IndexedDB adapter: the
 * stock sql.js build compiles SQLite with FTS3 and FTS4 and without FTS5.
 *
 * Uses FTS4 virtual tables with external content, the porter, unicode61 or
 * simple tokenizer, and rowid joins to the content table. FTS4 has no rank
 * column; relevanceOrder orders by the length of `offsets()`, which grows with
 * the number of matching terms, so the best match comes first.
 */
export class SqliteFts4 implements IFullTextSearch {
  createIndex(config: { table: string; columns: string[]; contentTable?: string; tokenizer?: string }): string {
    const parts = [...config.columns];
    if (config.contentTable) parts.push(`content="${config.contentTable}"`);
    parts.push(`tokenize=${this.tokenizer(config.tokenizer)}`);
    return `CREATE VIRTUAL TABLE IF NOT EXISTS ${config.table} USING fts4(${parts.join(', ')})`;
  }

  matchClause(indexName: string, queryPlaceholder: string): string {
    return `${indexName} MATCH ${queryPlaceholder}`;
  }

  rankExpression(indexName: string, _queryPlaceholder?: string): string {
    return `length(offsets(${indexName}))`;
  }

  relevanceOrder(indexName: string, _queryPlaceholder?: string): string {
    return `length(offsets(${indexName})) DESC`;
  }

  rebuildCommand(indexName: string): string {
    return `INSERT INTO ${indexName}(${indexName}) VALUES('rebuild')`;
  }

  syncInsert(indexName: string, rowIdExpr: string, columns: string[]): string {
    const placeholders = columns.map(() => '?').join(', ');
    return `INSERT INTO ${indexName} (docid, ${columns.join(', ')}) VALUES (${rowIdExpr}, ${placeholders})`;
  }

  sanitizeQuery(input: string): string {
    return input
      .replace(/[*()":^~{}[\]\\]/g, '')
      .split(/\s+/)
      .filter((word) => word.length > 0)
      .map((word) => `"${word}"`)
      .join(' OR ');
  }

  joinClause(contentTable: string, contentAlias: string, ftsAlias: string, indexName: string): string {
    return `${indexName} ${ftsAlias} JOIN ${contentTable} ${contentAlias} ON ${contentAlias}.rowid = ${ftsAlias}.docid`;
  }

  /** An FTS5-style tokenizer string as an FTS4 tokenizer name. */
  private tokenizer(tokenizer?: string): string {
    if (!tokenizer) return 'unicode61';
    if (tokenizer.includes('porter')) return 'porter';
    if (tokenizer.includes('unicode61')) return 'unicode61';
    return 'simple';
  }
}
