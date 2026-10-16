import { describe } from 'vitest';
import {
  createAuthJsAdapter,
  createBetterSqliteAdapter,
  createPostgresAdapter,
  createSqlJsAdapter,
  ensureAuthJsTables,
  type StorageAdapter,
} from '../src/index.js';
import { runBasicTests } from './vendor/authjs-adapter-tests';

// Auth.js's own adapter test suite (vendored from nextauthjs/next-auth) runs
// against createAuthJsAdapter on PostgreSQL (CI's service, when
// POSTGRES_TEST_URL names it), better-sqlite3 and sql.js: users, accounts,
// sessions and verification tokens kept through the library.

const POSTGRES_TEST_URL = process.env.POSTGRES_TEST_URL;

const engines: Array<[string, () => StorageAdapter]> = [
  ['better-sqlite3', () => createBetterSqliteAdapter(':memory:')],
  ['sql.js', () => createSqlJsAdapter()],
];
if (POSTGRES_TEST_URL) engines.push(['PostgreSQL', () => createPostgresAdapter(POSTGRES_TEST_URL)]);

const toDate = (value: unknown): Date | null => (value == null ? null : value instanceof Date ? value : new Date(String(value)));

describe.each(engines)('createAuthJsAdapter on %s', (_engine, makeAdapter) => {
  const db = makeAdapter();
  const tablePrefix = `authjs_${Math.random().toString(36).slice(2, 8)}_`;
  const t = (name: string): string => `${tablePrefix}${name}`;

  runBasicTests({
    adapter: createAuthJsAdapter(db, { tablePrefix }),
    db: {
      connect: async () => {
        await db.open();
        await ensureAuthJsTables(db, { tablePrefix });
      },
      disconnect: async () => {
        for (const name of ['sessions', 'accounts', 'verification_tokens', 'users']) {
          await db.exec(`DROP TABLE IF EXISTS ${t(name)}`).catch(() => undefined);
        }
        await db.close();
      },
      user: async (id: string) => {
        const row = await db.get<Record<string, unknown>>(`SELECT * FROM ${t('users')} WHERE id = ?`, [id]);
        return row
          ? { id: row.id, name: row.name, email: row.email, emailVerified: toDate(row.email_verified), image: row.image }
          : null;
      },
      account: async ({ provider, providerAccountId }: { provider: string; providerAccountId: string }) => {
        const row = await db.get<Record<string, unknown>>(
          `SELECT * FROM ${t('accounts')} WHERE provider = ? AND provider_account_id = ?`,
          [provider, providerAccountId],
        );
        return row
          ? {
              id: row.id,
              userId: row.user_id,
              type: row.type,
              provider: row.provider,
              providerAccountId: row.provider_account_id,
              refresh_token: row.refresh_token,
              access_token: row.access_token,
              expires_at: row.expires_at == null ? null : Number(row.expires_at),
              token_type: row.token_type,
              scope: row.scope,
              id_token: row.id_token,
              session_state: row.session_state,
            }
          : null;
      },
      session: async (sessionToken: string) => {
        const row = await db.get<Record<string, unknown>>(`SELECT * FROM ${t('sessions')} WHERE session_token = ?`, [sessionToken]);
        return row ? { sessionToken: row.session_token, userId: row.user_id, expires: toDate(row.expires) } : null;
      },
      verificationToken: async ({ identifier, token }: { identifier: string; token: string }) => {
        const row = await db.get<Record<string, unknown>>(
          `SELECT * FROM ${t('verification_tokens')} WHERE identifier = ? AND token = ?`,
          [identifier, token],
        );
        return row ? { identifier: row.identifier, token: row.token, expires: toDate(row.expires) } : null;
      },
    },
  });
});
