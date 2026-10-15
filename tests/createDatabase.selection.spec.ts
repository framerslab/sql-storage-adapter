import { describe, expect, it, afterEach, vi } from 'vitest';
import type { StorageAdapter } from '../src/core/contracts';
import type { StorageResolutionOptions } from '../src/core/resolver';
import { connectDatabase, createDatabase } from '../src/core/database';

// createDatabase() chooses the adapter priority and hands it to the resolver.
// These specs read what it hands over: the resolver is a stub here, so no
// database opens. tests/createDatabase.postgres.spec.ts opens real ones.

const { handedOver } = vi.hoisted(() => ({ handedOver: [] as StorageResolutionOptions[] }));

vi.mock('../src/core/resolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/resolver')>();
  return {
    ...actual,
    resolveStorageAdapter: vi.fn(async (options: StorageResolutionOptions) => {
      handedOver.push(options);
      return { open: async () => undefined } as unknown as StorageAdapter;
    }),
  };
});

const POSTGRES_URL = 'postgresql://app@db.internal:5432/app';

describe('createDatabase - adapter priority', () => {
  const last = (): StorageResolutionOptions => handedOver[handedOver.length - 1];

  afterEach(() => {
    handedOver.length = 0;
    vi.unstubAllGlobals();
  });

  it('chooses Postgres alone on Node for a URL, and passes the Postgres options on with it', async () => {
    await createDatabase({ url: POSTGRES_URL, postgres: { max: 4, ssl: true, statement_timeout: 5000 } });

    expect(last().priority).toEqual(['postgres']);
    expect(last().postgres).toEqual({ connectionString: POSTGRES_URL, max: 4, ssl: true, statement_timeout: 5000 });
  });

  it('chooses Postgres alone on Node for options that name a host, database and user', async () => {
    await connectDatabase({ host: 'db.internal', database: 'app', user: 'app' });

    expect(last().priority).toEqual(['postgres']);
  });

  it('keeps the local default on Node when the Postgres options name no server', async () => {
    await createDatabase({ postgres: { connectionString: undefined } });

    expect(last().priority).toEqual(['better-sqlite3', 'sqljs']);
  });

  it('keeps sql.js in a browser, which cannot reach a Postgres URL', async () => {
    vi.stubGlobal('window', { document: {} });

    await createDatabase({ url: POSTGRES_URL });

    expect(last().priority).toEqual(['sqljs']);
  });

  it('keeps sql.js on Deno', async () => {
    vi.stubGlobal('Deno', {});

    await createDatabase({ url: POSTGRES_URL });

    expect(last().priority).toEqual(['sqljs']);
  });

  it('leaves an explicit priority or type as it is', async () => {
    await createDatabase({ url: POSTGRES_URL, priority: ['better-sqlite3'] });
    expect(last().priority).toEqual(['better-sqlite3']);

    await createDatabase({ url: POSTGRES_URL, type: 'sqlite' });
    expect(last().priority).toEqual(['better-sqlite3']);
  });
});
