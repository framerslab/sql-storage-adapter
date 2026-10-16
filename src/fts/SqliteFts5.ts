import type { IFullTextSearch } from '../core/contracts/fts.js';

/**
 * SQLite FTS5 full-text search implementation.
 *
 * Uses FTS5 virtual tables with external-content support, porter/ascii
 * tokenizers, and rowid-based joins to the content table.
 */
export class SqliteFts5 implements IFullTextSearch {
  createIndex(config: { table: string; columns: string[]; contentTable?: string; tokenizer?: string }): string {
    const parts = [...config.columns];
    if (config.contentTable) {
      parts.push(`content='${config.contentTable}'`);
      parts.push(`content_rowid='rowid'`);
    }
    if (config.tokenizer) {
      parts.push(`tokenize='${config.tokenizer}'`);
    }
    return `CREATE VIRTUAL TABLE IF NOT EXISTS ${config.table} USING fts5(${parts.join(', ')})`;
  }

  matchClause(indexName: string, queryPlaceholder: string): string {
    return `${indexName} MATCH ${queryPlaceholder}`;
  }

  rankExpression(indexName: string, _queryPlaceholder?: string): string {
    return `${indexName}.rank`;
  }

  relevanceOrder(indexName: string, _queryPlaceholder?: string): string {
    return `${indexName}.rank`;
  }

  rebuildCommand(indexName: string): string {
    return `INSERT INTO ${indexName}(${indexName}) VALUES('rebuild')`;
  }

  syncInsert(indexName: string, rowIdExpr: string, columns: string[]): string {
    const placeholders = columns.map(() => '?').join(', ');
    return `INSERT INTO ${indexName} (rowid, ${columns.join(', ')}) VALUES (${rowIdExpr}, ${placeholders})`;
  }

  sanitizeQuery(input: string): string {
    return input
      .replace(/[*()":^~{}[\]\\]/g, '')
      .split(/\s+/)
      .filter((w) => w.length > 0)
      .map((w) => `"${w}"`)
      .join(' OR ');
  }

  joinClause(contentTable: string, contentAlias: string, ftsAlias: string, indexName: string): string {
    return `${indexName} ${ftsAlias} JOIN ${contentTable} ${contentAlias} ON ${contentAlias}.rowid = ${ftsAlias}.rowid`;
  }
}
