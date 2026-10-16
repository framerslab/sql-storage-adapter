/**
 * An Auth.js database adapter over StorageAdapter: users, accounts, sessions
 * and verification tokens kept through this library on PostgreSQL and SQLite
 * alike, so a product's own Auth.js (NextAuth v5, `@auth/core`) stores its
 * auth data where the rest of its data lives.
 *
 * The object `createAuthJsAdapter()` returns has the shape of `Adapter` from
 * `@auth/core/adapters`, without a dependency on it: pass it as `adapter` to
 * `NextAuth()` or `Auth()`. WebAuthn authenticators are not stored.
 *
 * @module
 */
import type { StorageAdapter } from '../../core/contracts';
import { createStorageFeatures } from '../../core/contracts/features';

/** A user as Auth.js reads it (`AdapterUser`). */
export interface AuthJsUser {
  id: string;
  email: string;
  emailVerified: Date | null;
  name?: string | null;
  image?: string | null;
}

/**
 * An account as Auth.js reads it (`AdapterAccount`). A type, not an
 * interface, so it fits Auth.js's account, which allows more token fields.
 * Fields the provider did not give are left out.
 */
export type AuthJsAccount = {
  userId: string;
  type: 'oauth' | 'oidc' | 'email' | 'webauthn';
  provider: string;
  providerAccountId: string;
  refresh_token?: string;
  access_token?: string;
  expires_at?: number;
  token_type?: Lowercase<string>;
  scope?: string;
  id_token?: string;
  session_state?: string;
};

/** A session as Auth.js reads it (`AdapterSession`). */
export interface AuthJsSession {
  sessionToken: string;
  userId: string;
  expires: Date;
}

/** A verification token as Auth.js reads it (`VerificationToken`). */
export interface AuthJsVerificationToken {
  identifier: string;
  token: string;
  expires: Date;
}

/** The methods of Auth.js's `Adapter` this adapter implements. */
export interface AuthJsAdapter {
  createUser(user: Omit<AuthJsUser, 'id'> & { id?: string }): Promise<AuthJsUser>;
  getUser(id: string): Promise<AuthJsUser | null>;
  getUserByEmail(email: string): Promise<AuthJsUser | null>;
  getUserByAccount(account: Pick<AuthJsAccount, 'provider' | 'providerAccountId'>): Promise<AuthJsUser | null>;
  updateUser(user: Partial<AuthJsUser> & Pick<AuthJsUser, 'id'>): Promise<AuthJsUser>;
  deleteUser(userId: string): Promise<AuthJsUser | null>;
  linkAccount(account: AuthJsAccount): Promise<AuthJsAccount>;
  unlinkAccount(account: Pick<AuthJsAccount, 'provider' | 'providerAccountId'>): Promise<void>;
  getAccount(providerAccountId: string, provider: string): Promise<AuthJsAccount | null>;
  createSession(session: AuthJsSession): Promise<AuthJsSession>;
  getSessionAndUser(sessionToken: string): Promise<{ session: AuthJsSession; user: AuthJsUser } | null>;
  updateSession(session: Partial<AuthJsSession> & Pick<AuthJsSession, 'sessionToken'>): Promise<AuthJsSession | null>;
  deleteSession(sessionToken: string): Promise<void>;
  createVerificationToken(token: AuthJsVerificationToken): Promise<AuthJsVerificationToken>;
  useVerificationToken(params: { identifier: string; token: string }): Promise<AuthJsVerificationToken | null>;
}

/** Where the adapter keeps its tables, and how it makes ids. */
export interface AuthJsAdapterOptions {
  /** Put before each table name: `<prefix>users`, `<prefix>accounts`, `<prefix>sessions`, `<prefix>verification_tokens`. Default `auth_`. */
  tablePrefix?: string;
  /** Makes a user or account id when Auth.js passes none. Default: `crypto.randomUUID()`. */
  generateId?: () => string;
}

const PREFIX = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface Tables {
  users: string;
  accounts: string;
  sessions: string;
  verificationTokens: string;
}

const tablesFor = (options: AuthJsAdapterOptions): Tables => {
  const prefix = options.tablePrefix ?? 'auth_';
  if (!PREFIX.test(prefix)) {
    throw new Error(`tablePrefix must be letters, digits and underscores, starting with a letter or an underscore; got ${JSON.stringify(prefix)}.`);
  }
  return {
    users: `${prefix}users`,
    accounts: `${prefix}accounts`,
    sessions: `${prefix}sessions`,
    verificationTokens: `${prefix}verification_tokens`,
  };
};

/**
 * The statements that create the adapter's tables and indexes on `db`'s
 * engine, each `IF NOT EXISTS`, for a migration file or for
 * ensureAuthJsTables.
 */
export function authJsTablesSql(db: StorageAdapter, options: AuthJsAdapterOptions = {}): string[] {
  const t = tablesFor(options);
  const d = createStorageFeatures(db).dialect;
  const timestamp = d.columnType('timestamp');
  return [
    `CREATE TABLE IF NOT EXISTS ${t.users} (id TEXT PRIMARY KEY, name TEXT, email TEXT UNIQUE, email_verified ${timestamp}, image TEXT)`,
    `CREATE TABLE IF NOT EXISTS ${t.accounts} (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES ${t.users} (id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_account_id TEXT NOT NULL,
      refresh_token TEXT,
      access_token TEXT,
      expires_at ${d.columnType('bigint')},
      token_type TEXT,
      scope TEXT,
      id_token TEXT,
      session_state TEXT,
      UNIQUE (provider, provider_account_id)
    )`,
    `CREATE TABLE IF NOT EXISTS ${t.sessions} (session_token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES ${t.users} (id) ON DELETE CASCADE, expires ${timestamp} NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${t.verificationTokens} (identifier TEXT NOT NULL, token TEXT NOT NULL, expires ${timestamp} NOT NULL, PRIMARY KEY (identifier, token))`,
    `CREATE INDEX IF NOT EXISTS ${t.accounts}_user_id ON ${t.accounts} (user_id)`,
    `CREATE INDEX IF NOT EXISTS ${t.sessions}_user_id ON ${t.sessions} (user_id)`,
  ];
}

/** Creates the adapter's tables and indexes on `db` when they are missing. */
export async function ensureAuthJsTables(db: StorageAdapter, options: AuthJsAdapterOptions = {}): Promise<void> {
  for (const statement of authJsTablesSql(db, options)) {
    await db.exec(statement);
  }
}

type Row = Record<string, unknown>;

/** A stored time as a Date: PostgreSQL returns one, SQLite ISO 8601 text. */
const toDate = (value: unknown): Date | null =>
  value == null ? null : value instanceof Date ? value : new Date(String(value));

const toUser = (row: Row): AuthJsUser => ({
  id: String(row.id),
  name: (row.name as string | null) ?? null,
  email: row.email as string,
  emailVerified: toDate(row.email_verified),
  image: (row.image as string | null) ?? null,
});

const toAccount = (row: Row): AuthJsAccount => {
  const account: AuthJsAccount = {
    userId: String(row.user_id),
    type: row.type as AuthJsAccount['type'],
    provider: row.provider as string,
    providerAccountId: row.provider_account_id as string,
  };
  for (const field of ['refresh_token', 'access_token', 'token_type', 'scope', 'id_token', 'session_state'] as const) {
    if (row[field] != null) (account as Record<string, unknown>)[field] = String(row[field]);
  }
  // PostgreSQL returns a BIGINT as text.
  if (row.expires_at != null) account.expires_at = Number(row.expires_at);
  return account;
};

const toSession = (row: Row): AuthJsSession => ({
  sessionToken: row.session_token as string,
  userId: String(row.user_id),
  expires: toDate(row.expires) as Date,
});

const toVerificationToken = (row: Row): AuthJsVerificationToken => ({
  identifier: row.identifier as string,
  token: row.token as string,
  expires: toDate(row.expires) as Date,
});

const defaultId = (): string => {
  const random = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto?.randomUUID;
  if (!random) throw new Error('crypto.randomUUID() is not available; pass generateId.');
  return random.call(globalThis.crypto);
};

/**
 * An Auth.js database adapter that keeps users, accounts, sessions and
 * verification tokens in `db`, on PostgreSQL or SQLite. Create the tables
 * first with ensureAuthJsTables (or authJsTablesSql in a migration).
 *
 * @example
 * ```typescript
 * import NextAuth from 'next-auth';
 * import { createDatabase } from '@framers/sql-storage-adapter';
 * import { createAuthJsAdapter, ensureAuthJsTables } from '@framers/sql-storage-adapter/authjs';
 *
 * const db = await createDatabase({ url: process.env.DATABASE_URL, strict: true });
 * await ensureAuthJsTables(db);
 * export const { handlers, auth } = NextAuth({ adapter: createAuthJsAdapter(db), providers: [] });
 * ```
 */
export function createAuthJsAdapter(db: StorageAdapter, options: AuthJsAdapterOptions = {}): AuthJsAdapter {
  const t = tablesFor(options);
  const generateId = options.generateId ?? defaultId;

  const getUser = async (id: string): Promise<AuthJsUser | null> => {
    const row = await db.get<Row>(`SELECT * FROM ${t.users} WHERE id = ?`, [id]);
    return row ? toUser(row) : null;
  };

  const getSession = async (sessionToken: string): Promise<AuthJsSession | null> => {
    const row = await db.get<Row>(`SELECT * FROM ${t.sessions} WHERE session_token = ?`, [sessionToken]);
    return row ? toSession(row) : null;
  };

  return {
    async createUser(user) {
      const id = user.id ?? generateId();
      await db.run(`INSERT INTO ${t.users} (id, name, email, email_verified, image) VALUES (?, ?, ?, ?, ?)`, [
        id,
        user.name ?? null,
        user.email,
        user.emailVerified ?? null,
        user.image ?? null,
      ]);
      return (await getUser(id)) as AuthJsUser;
    },

    getUser,

    async getUserByEmail(email) {
      const row = await db.get<Row>(`SELECT * FROM ${t.users} WHERE email = ?`, [email]);
      return row ? toUser(row) : null;
    },

    async getUserByAccount({ provider, providerAccountId }) {
      const row = await db.get<Row>(
        `SELECT u.* FROM ${t.users} u JOIN ${t.accounts} a ON a.user_id = u.id WHERE a.provider = ? AND a.provider_account_id = ?`,
        [provider, providerAccountId],
      );
      return row ? toUser(row) : null;
    },

    async updateUser(user) {
      const fields: Array<[string, unknown]> = [];
      if ('name' in user) fields.push(['name', user.name ?? null]);
      if ('email' in user) fields.push(['email', user.email]);
      if ('emailVerified' in user) fields.push(['email_verified', user.emailVerified ?? null]);
      if ('image' in user) fields.push(['image', user.image ?? null]);
      if (fields.length) {
        await db.run(`UPDATE ${t.users} SET ${fields.map(([column]) => `${column} = ?`).join(', ')} WHERE id = ?`, [
          ...fields.map(([, value]) => value),
          user.id,
        ]);
      }
      const updated = await getUser(user.id);
      if (!updated) throw new Error(`No user with id ${JSON.stringify(user.id)} to update.`);
      return updated;
    },

    async deleteUser(userId) {
      // Explicit deletes: sql.js and IndexedDB leave foreign keys off, so ON DELETE CASCADE would not run there.
      return db.transaction(async (trx) => {
        const row = await trx.get<Row>(`SELECT * FROM ${t.users} WHERE id = ?`, [userId]);
        await trx.run(`DELETE FROM ${t.sessions} WHERE user_id = ?`, [userId]);
        await trx.run(`DELETE FROM ${t.accounts} WHERE user_id = ?`, [userId]);
        await trx.run(`DELETE FROM ${t.users} WHERE id = ?`, [userId]);
        return row ? toUser(row) : null;
      });
    },

    async linkAccount(account) {
      await db.run(
        `INSERT INTO ${t.accounts} (id, user_id, type, provider, provider_account_id, refresh_token, access_token, expires_at, token_type, scope, id_token, session_state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          generateId(),
          account.userId,
          account.type,
          account.provider,
          account.providerAccountId,
          account.refresh_token ?? null,
          account.access_token ?? null,
          account.expires_at ?? null,
          account.token_type ?? null,
          account.scope ?? null,
          account.id_token ?? null,
          account.session_state ?? null,
        ],
      );
      return account;
    },

    async unlinkAccount({ provider, providerAccountId }) {
      await db.run(`DELETE FROM ${t.accounts} WHERE provider = ? AND provider_account_id = ?`, [provider, providerAccountId]);
    },

    async getAccount(providerAccountId, provider) {
      const row = await db.get<Row>(`SELECT * FROM ${t.accounts} WHERE provider = ? AND provider_account_id = ?`, [
        provider,
        providerAccountId,
      ]);
      return row ? toAccount(row) : null;
    },

    async createSession(session) {
      await db.run(`INSERT INTO ${t.sessions} (session_token, user_id, expires) VALUES (?, ?, ?)`, [
        session.sessionToken,
        session.userId,
        session.expires,
      ]);
      return { sessionToken: session.sessionToken, userId: session.userId, expires: session.expires };
    },

    async getSessionAndUser(sessionToken) {
      const session = await getSession(sessionToken);
      if (!session) return null;
      const user = await getUser(session.userId);
      return user ? { session, user } : null;
    },

    async updateSession(session) {
      const fields: Array<[string, unknown]> = [];
      if (session.expires !== undefined) fields.push(['expires', session.expires]);
      if (session.userId !== undefined) fields.push(['user_id', session.userId]);
      if (fields.length) {
        await db.run(`UPDATE ${t.sessions} SET ${fields.map(([column]) => `${column} = ?`).join(', ')} WHERE session_token = ?`, [
          ...fields.map(([, value]) => value),
          session.sessionToken,
        ]);
      }
      return getSession(session.sessionToken);
    },

    async deleteSession(sessionToken) {
      await db.run(`DELETE FROM ${t.sessions} WHERE session_token = ?`, [sessionToken]);
    },

    async createVerificationToken(token) {
      await db.run(`INSERT INTO ${t.verificationTokens} (identifier, token, expires) VALUES (?, ?, ?)`, [
        token.identifier,
        token.token,
        token.expires,
      ]);
      return { identifier: token.identifier, token: token.token, expires: token.expires };
    },

    async useVerificationToken({ identifier, token }) {
      // One statement: a token is used once, however many requests race for it.
      const row = await db.get<Row>(
        `DELETE FROM ${t.verificationTokens} WHERE identifier = ? AND token = ? RETURNING identifier, token, expires`,
        [identifier, token],
      );
      return row ? toVerificationToken(row) : null;
    },
  };
}
