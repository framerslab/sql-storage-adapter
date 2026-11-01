/**
 * The databases the sync suites run on: sql.js always, better-sqlite3 where its binding loads, and Postgres where the
 * run names one in SYNC_TEST_POSTGRES_URL. A run that sets SYNC_TEST_REQUIRE_POSTGRES=1 fails without Postgres instead
 * of skipping it, so CI can never pass a Postgres case by leaving it out.
 */
import { randomBytes } from 'node:crypto';
import { createBetterSqliteAdapter } from '../../src/adapters/betterSqliteAdapter';
import { createPostgresAdapter } from '../../src/adapters/postgresAdapter';
import { createSqlJsAdapter } from '../../src/adapters/sqlJsAdapter';
import type { StorageAdapter } from '../../src/core/contracts';

/** One database a suite opens, with a table prefix no other test uses and its cleanup. */
export interface OpenedBackend {
  adapter: StorageAdapter;
  prefix: string;
  close(): Promise<void>;
}

/** One kind of database. */
export interface Backend {
  name: 'sqljs' | 'better-sqlite3' | 'postgres';
  open(): Promise<OpenedBackend>;
}

const POSTGRES_URL = process.env.SYNC_TEST_POSTGRES_URL ?? '';

/** `t<12 hex>_`: a prefix that keeps one test's tables apart from another's in a shared Postgres database. */
export function freshPrefix(): string {
  return `t${randomBytes(6).toString('hex')}_`;
}

/** Every table a suite may make under its prefix, dropped when it closes. */
const TABLES = ['results', 'clients', 'rows', 'groups', 'kv_entries', 'probe', 'membership', 'base', 'pending', 'journal', 'kept', 'old_results', 'old_rows'];

async function betterSqliteLoads(): Promise<boolean> {
  try {
    const adapter = createBetterSqliteAdapter(':memory:');
    await adapter.open();
    await adapter.close();
    return true;
  } catch {
    return false;
  }
}

/** The backends this run has. */
export async function backends(): Promise<Backend[]> {
  if (process.env.SYNC_TEST_REQUIRE_POSTGRES === '1' && POSTGRES_URL === '') {
    throw new Error('this run requires the sync suites on Postgres: SYNC_TEST_POSTGRES_URL is not set');
  }
  const list: Backend[] = [
    {
      name: 'sqljs',
      open: async () => {
        const adapter = createSqlJsAdapter();
        await adapter.open();
        return { adapter, prefix: freshPrefix(), close: () => adapter.close() };
      },
    },
  ];
  if (await betterSqliteLoads()) {
    list.push({
      name: 'better-sqlite3',
      open: async () => {
        const adapter = createBetterSqliteAdapter(':memory:');
        await adapter.open();
        return { adapter, prefix: freshPrefix(), close: () => adapter.close() };
      },
    });
  }
  if (POSTGRES_URL !== '') {
    list.push({
      name: 'postgres',
      open: async () => {
        const adapter = createPostgresAdapter(POSTGRES_URL);
        await adapter.open();
        const prefix = freshPrefix();
        return {
          adapter,
          prefix,
          close: async () => {
            for (const table of TABLES) await adapter.exec(`DROP TABLE IF EXISTS ${prefix}${table} CASCADE`);
            await adapter.close();
          },
        };
      },
    });
  }
  return list;
}
