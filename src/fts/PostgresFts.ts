import type { IFullTextSearch } from '../core/contracts/fts.js';

type Weight = 'A' | 'B' | 'C' | 'D';

/** What createIndex learned about an index: where its column lives, what it covers, how it reads text. */
interface PostgresIndex {
  contentTable: string;
  columns: string[];
  lang: string;
  weights?: Record<string, Weight>;
}

/**
 * The indexes createIndex has described in this process, by index name. It
 * is the module's, not an instance's, so a features object made later (or a
 * second one) syncs, rebuilds and queries an index another one created, and
 * each index keeps its own language.
 */
const INDEXES = new Map<string, PostgresIndex>();

const WEIGHTS = new Set<string>(['A', 'B', 'C', 'D']);

/**
 * Postgres full-text search using tsvector columns and GIN indexes.
 *
 * Unlike FTS5 (separate virtual table), Postgres stores the tsvector as a
 * column `_tsv` on the content table itself. The `createIndex()` call adds the
 * column and creates the GIN index when they are missing, and backfills
 * existing rows. Queries go through `websearch_to_tsquery`, which reads raw
 * user text without syntax errors: words are ANDed, and `or`, `-word` and
 * quoted phrases work as in a web search box.
 */
export class PostgresFts implements IFullTextSearch {
  /**
   * The script that makes the index, three statements for `exec()` to run on
   * each open:
   *
   * 1. A `DO` block that adds the `_tsv` column when the content table has none.
   * 2. A `DO` block that creates the GIN index `idx_<table>_tsv` when the
   *    content table's schema has no relation of that name.
   * 3. An `UPDATE` that fills `_tsv` on the rows where it is null.
   *
   * `ALTER TABLE` takes its ACCESS EXCLUSIVE lock, and `CREATE INDEX` its
   * SHARE lock, before either reads its `IF NOT EXISTS`, and a lock request
   * waits behind every queued request it conflicts with: an open behind a
   * long read of the table would hold up each later read and write of it
   * until that read ended. So each block reads the catalog first, through
   * `to_regclass`, which finds the content table as the statement does (the
   * search path, a schema prefix, quoted names) and locks nothing. An open
   * that finds the column and the index takes no lock on the table beyond the
   * `UPDATE`'s ROW EXCLUSIVE, which no read or write of the table waits for.
   * The statements keep `IF NOT EXISTS` for two first opens that pass the
   * check together.
   */
  createIndex(config: {
    table: string;
    columns: string[];
    contentTable?: string;
    tokenizer?: string;
    weights?: Record<string, Weight>;
  }): string {
    const index: PostgresIndex = {
      contentTable: config.contentTable ?? config.table,
      columns: config.columns,
      lang: tokenizerToLang(config.tokenizer),
      weights: checkWeights(config.columns, config.weights),
    };
    INDEXES.set(config.table, index);
    const ct = index.contentTable;
    const indexName = `idx_${config.table}_tsv`;
    return [
      doBlock(
        `IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass(${literal(ct)}) AND attname = '_tsv' AND NOT attisdropped) THEN\n` +
          `    ALTER TABLE ${ct} ADD COLUMN IF NOT EXISTS _tsv tsvector;\n` +
          `  END IF;`,
      ),
      doBlock(
        `IF to_regclass((SELECT relnamespace::regnamespace::text FROM pg_class WHERE oid = to_regclass(${literal(ct)})) || ${literal(`.${indexName}`)}) IS NULL THEN\n` +
          `    CREATE INDEX IF NOT EXISTS ${indexName} ON ${ct} USING GIN(_tsv);\n` +
          `  END IF;`,
      ),
      `UPDATE ${ct} SET _tsv = ${tsvector(index, index.columns.map((column) => `COALESCE(${column}, '')`))} WHERE _tsv IS NULL`,
    ].join(';\n');
  }

  matchClause(indexName: string, queryPlaceholder: string): string {
    return `_tsv @@ websearch_to_tsquery('${langOf(indexName)}', ${queryPlaceholder})`;
  }

  rankExpression(indexName: string, queryPlaceholder?: string): string {
    const qp = queryPlaceholder ?? '$1';
    return `ts_rank(_tsv, websearch_to_tsquery('${langOf(indexName)}', ${qp}))`;
  }

  relevanceOrder(indexName: string, queryPlaceholder?: string): string {
    return `${this.rankExpression(indexName, queryPlaceholder)} DESC`;
  }

  rebuildCommand(indexName: string): string {
    const index = described(indexName);
    return `UPDATE ${index.contentTable} SET _tsv = ${tsvector(index, index.columns.map((column) => `COALESCE(${column}, '')`))}`;
  }

  syncInsert(indexName: string, _rowIdExpr: string, columns: string[]): string {
    const index = described(indexName);
    const values = columns.map((_, i) => `COALESCE($${i + 2}, '')`);
    return `UPDATE ${index.contentTable} SET _tsv = ${tsvector({ ...index, columns }, values)} WHERE id = $1`;
  }

  sanitizeQuery(input: string): string {
    return input
      .replace(/[*()":^~{}[\]\\-]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 0 && word.toLowerCase() !== 'or')
      .map((word) => `"${word}"`)
      .join(' or ');
  }

  joinClause(contentTable: string, contentAlias: string, _ftsAlias: string, _indexName: string): string {
    return `${contentTable} ${contentAlias}`;
  }
}

/** Map FTS5-style tokenizer strings to Postgres text search configurations. */
const tokenizerToLang = (tokenizer?: string): string => {
  if (!tokenizer) return 'english';
  if (tokenizer.includes('porter')) return 'english';
  return 'simple';
};

const checkWeights = (columns: string[], weights?: Record<string, Weight>): Record<string, Weight> | undefined => {
  if (!weights) return undefined;
  for (const [column, weight] of Object.entries(weights)) {
    if (!columns.includes(column)) throw new Error(`weights names ${JSON.stringify(column)}, which is not one of the indexed columns.`);
    if (!WEIGHTS.has(weight)) throw new Error(`The weight of ${column} must be 'A', 'B', 'C' or 'D'; got ${JSON.stringify(weight)}.`);
  }
  return weights;
};

/** `text` as an SQL string literal. */
const literal = (text: string): string => `'${text.replace(/'/g, "''")}'`;

/**
 * `body` as a PL/pgSQL `DO` block, dollar-quoted with a tag the body does not
 * hold: a table name can hold `$`, so a fixed tag could end the block early.
 */
const doBlock = (body: string): string => {
  let tag = '$fts$';
  for (let n = 1; body.includes(tag); n += 1) tag = `$fts${n}$`;
  return `DO ${tag}\nBEGIN\n  ${body}\nEND\n${tag}`;
};

/** The tsvector expression over `values`, one per indexed column, weighted when the index has weights. */
const tsvector = (index: PostgresIndex, values: string[]): string => {
  if (!index.weights) return `to_tsvector('${index.lang}', ${values.join(" || ' ' || ")})`;
  return values
    .map((value, i) => {
      const weight = index.weights![index.columns[i]];
      const vector = `to_tsvector('${index.lang}', ${value})`;
      return weight ? `setweight(${vector}, '${weight}')` : vector;
    })
    .join(' || ');
};

const described = (indexName: string): PostgresIndex => {
  const index = INDEXES.get(indexName);
  if (!index) {
    throw new Error(
      `No PostgreSQL full-text index named ${JSON.stringify(indexName)} has been described in this process: run its createIndex() first (it is idempotent).`,
    );
  }
  return index;
};

/** The language of an index, or 'english' for an index this process has not described. */
const langOf = (indexName: string): string => INDEXES.get(indexName)?.lang ?? 'english';
