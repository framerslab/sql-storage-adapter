import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPostgresAdapter, type PostgresAdapterOptions } from '../src/adapters/postgresAdapter';
import type { StorageAdapter } from '../src/types';

/**
 * PostgreSQL Integration Tests
 *
 * These tests run against a real PostgreSQL server: connection string and
 * granular configuration, pool settings, CRUD, transactions, JSONB, arrays and
 * CTEs. The "Remote Connection Examples" only build configuration objects.
 *
 * They run when POSTGRES_TEST_URL names a server; CI starts a PostgreSQL 16
 * service and sets it. TEST_POSTGRES_URL, the name this suite read before, is
 * read when POSTGRES_TEST_URL is unset. Locally:
 * ```bash
 * docker run --name test-postgres -e POSTGRES_PASSWORD=test123 -e POSTGRES_DB=testdb -p 5432:5432 -d postgres:16
 * POSTGRES_TEST_URL="postgresql://postgres:test123@localhost:5432/testdb" npm test
 * ```
 * When the variable is set and the server cannot be reached, the suite fails.
 */

const POSTGRES_TEST_URL = process.env.POSTGRES_TEST_URL || process.env.TEST_POSTGRES_URL;

describe.skipIf(!POSTGRES_TEST_URL)('PostgreSQL Integration Tests', () => {
  const TEST_CONNECTION_STRING = POSTGRES_TEST_URL as string;
  let adapter: StorageAdapter;

  afterAll(async () => {
    if (adapter) {
      try {
        await adapter.exec('DROP TABLE IF EXISTS test_users CASCADE');
        await adapter.exec('DROP TABLE IF EXISTS test_accounts CASCADE');
        await adapter.exec('DROP TABLE IF EXISTS test_json CASCADE');
        await adapter.exec('DROP TABLE IF EXISTS test_arrays CASCADE');
        await adapter.close();
      } catch (err) {
        // Ignore cleanup errors
      }
    }
  });

  describe('Connection Methods', () => {
    it('should connect with connection string', async () => {
      adapter = createPostgresAdapter(TEST_CONNECTION_STRING);
      await adapter.open();

      expect(adapter.kind).toBe('postgres');
      expect(adapter.capabilities.has('transactions')).toBe(true);
      
      await adapter.close();
    });

    it('should connect with granular configuration', async () => {
      // The same server, named by its parts instead of a connection string.
      const parsed = new URL(TEST_CONNECTION_STRING);
      const options: PostgresAdapterOptions = {
        host: parsed.hostname,
        port: Number(parsed.port || 5432),
        database: decodeURIComponent(parsed.pathname.slice(1)),
        user: decodeURIComponent(parsed.username),
        password: decodeURIComponent(parsed.password),
      };

      adapter = createPostgresAdapter(options);
      await adapter.open();

      const result = await adapter.get<{ version: string }>('SELECT version()');
      expect(result?.version).toContain('PostgreSQL');

      await adapter.close();
    });

    it('should support connection pool configuration', async () => {
      const options: PostgresAdapterOptions = {
        connectionString: TEST_CONNECTION_STRING,
        max: 5,
        min: 1,
        idleTimeoutMillis: 5000,
        application_name: 'integration-test',
      };

      adapter = createPostgresAdapter(options);
      await adapter.open();

      const result = await adapter.get<{ application_name: string }>(
        'SELECT application_name FROM pg_stat_activity WHERE pid = pg_backend_pid()'
      );

      expect(result?.application_name).toBe('integration-test');

      await adapter.close();
    });
  });

  describe('CRUD Operations', () => {
    beforeAll(async () => {
      adapter = createPostgresAdapter(TEST_CONNECTION_STRING);
      await adapter.open();

      await adapter.exec('DROP TABLE IF EXISTS test_users CASCADE');
      await adapter.exec(`
        CREATE TABLE test_users (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          email TEXT UNIQUE,
          metadata JSONB,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
    });

    it('should insert and retrieve data', async () => {
      await adapter.run(
        'INSERT INTO test_users (name, email) VALUES ($1, $2)',
        ['Alice', 'alice@example.com']
      );

      const user = await adapter.get<{ name: string; email: string }>(
        'SELECT name, email FROM test_users WHERE email = $1',
        ['alice@example.com']
      );

      expect(user).toBeDefined();
      expect(user?.name).toBe('Alice');
      expect(user?.email).toBe('alice@example.com');
    });

    it('should query multiple rows', async () => {
      await adapter.run('INSERT INTO test_users (name, email) VALUES ($1, $2)', ['Bob', 'bob@example.com']);
      await adapter.run('INSERT INTO test_users (name, email) VALUES ($1, $2)', [
        'Charlie',
        'charlie@example.com',
      ]);

      const users = await adapter.all<{ name: string }>('SELECT name FROM test_users ORDER BY name');

      expect(users.length).toBeGreaterThanOrEqual(3);
      expect(users.map(u => u.name)).toContain('Alice');
      expect(users.map(u => u.name)).toContain('Bob');
      expect(users.map(u => u.name)).toContain('Charlie');
    });

    it('should update data', async () => {
      await adapter.run('UPDATE test_users SET email = $1 WHERE name = $2', [
        'alice.new@example.com',
        'Alice',
      ]);

      const user = await adapter.get<{ email: string }>(
        'SELECT email FROM test_users WHERE name = $1',
        ['Alice']
      );

      expect(user?.email).toBe('alice.new@example.com');
    });

    it('should delete data', async () => {
      await adapter.run('DELETE FROM test_users WHERE name = $1', ['Charlie']);

      const user = await adapter.get('SELECT * FROM test_users WHERE name = $1', ['Charlie']);
      expect(user).toBeNull();
    });

    it('should handle NULL values', async () => {
      await adapter.run('INSERT INTO test_users (name, email) VALUES ($1, $2)', ['NoEmail', null]);

      const user = await adapter.get<{ email: string | null }>(
        'SELECT email FROM test_users WHERE name = $1',
        ['NoEmail']
      );

      expect(user?.email).toBeNull();
    });
  });

  describe('Transactions', () => {
    beforeAll(async () => {
      await adapter.exec('DROP TABLE IF EXISTS test_accounts');
      await adapter.exec(`
        CREATE TABLE test_accounts (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          balance DECIMAL(10,2) DEFAULT 0
        )
      `);

      await adapter.run('INSERT INTO test_accounts (name, balance) VALUES ($1, $2)', [
        'Account A',
        1000.0,
      ]);
      await adapter.run('INSERT INTO test_accounts (name, balance) VALUES ($1, $2)', ['Account B', 500.0]);
    });

    it('should commit successful transaction', async () => {
      await adapter.transaction(async tx => {
        await tx.run('UPDATE test_accounts SET balance = balance - $1 WHERE name = $2', [100, 'Account A']);
        await tx.run('UPDATE test_accounts SET balance = balance + $1 WHERE name = $2', [100, 'Account B']);
      });

      const accountA = await adapter.get<{ balance: string }>(
        'SELECT balance FROM test_accounts WHERE name = $1',
        ['Account A']
      );
      const accountB = await adapter.get<{ balance: string }>(
        'SELECT balance FROM test_accounts WHERE name = $1',
        ['Account B']
      );

      expect(parseFloat(accountA!.balance)).toBe(900.0);
      expect(parseFloat(accountB!.balance)).toBe(600.0);
    });

    it('should rollback failed transaction', async () => {
      const balanceBefore = await adapter.get<{ balance: string }>(
        'SELECT balance FROM test_accounts WHERE name = $1',
        ['Account A']
      );

      try {
        await adapter.transaction(async tx => {
          await tx.run('UPDATE test_accounts SET balance = balance - $1 WHERE name = $2', [
            100,
            'Account A',
          ]);
          throw new Error('Simulated failure');
        });
      } catch {
        // Expected error
      }

      const balanceAfter = await adapter.get<{ balance: string }>(
        'SELECT balance FROM test_accounts WHERE name = $1',
        ['Account A']
      );

      expect(balanceAfter?.balance).toBe(balanceBefore?.balance);
    });
  });

  describe('Advanced PostgreSQL Features', () => {
    it('should support JSONB operations', async () => {
      const metadata = { role: 'admin', permissions: ['read', 'write'], active: true };

      await adapter.run('INSERT INTO test_users (name, email, metadata) VALUES ($1, $2, $3)', [
        'JSONUser',
        'json@example.com',
        JSON.stringify(metadata),
      ]);

      const user = await adapter.get<{ metadata: any }>(
        "SELECT metadata FROM test_users WHERE metadata->>'role' = $1",
        ['admin']
      );

      expect(user?.metadata.role).toBe('admin');
      expect(user?.metadata.permissions).toEqual(['read', 'write']);
    });

    it('should support array types', async () => {
      await adapter.exec('DROP TABLE IF EXISTS test_arrays');
      await adapter.exec(`
        CREATE TABLE test_arrays (
          id SERIAL PRIMARY KEY,
          tags TEXT[],
          numbers INTEGER[]
        )
      `);

      await adapter.run('INSERT INTO test_arrays (tags, numbers) VALUES ($1, $2)', [
        '{typescript,nodejs,postgres}',
        '{1,2,3,4,5}',
      ]);

      const result = await adapter.get<{ tags: string[]; numbers: number[] }>(
        'SELECT tags, numbers FROM test_arrays WHERE $1 = ANY(tags)',
        ['nodejs']
      );

      expect(result?.tags).toContain('nodejs');
      expect(result?.numbers).toEqual([1, 2, 3, 4, 5]);
    });

    it('should support CTEs (Common Table Expressions)', async () => {
      const result = await adapter.all<{ name: string; email: string }>(`
        WITH active_users AS (
          SELECT name, email FROM test_users WHERE email IS NOT NULL
        )
        SELECT * FROM active_users ORDER BY name LIMIT 3
      `);

      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('Remote Connection Examples', () => {
    it('should demonstrate AWS RDS-style connection', () => {
      // Example configuration (not actually connecting)
      const awsConfig: PostgresAdapterOptions = {
        host: 'mydb.abc123.us-east-1.rds.amazonaws.com',
        port: 5432,
        database: 'myapp',
        user: 'admin',
        password: 'secure_password',
        ssl: { rejectUnauthorized: true },
        max: 20,
        idleTimeoutMillis: 10000,
      };

      expect(awsConfig.host).toBeDefined();
      expect(awsConfig.ssl).toBeDefined();
    });

    it('should demonstrate Heroku Postgres connection', () => {
      // Example configuration (not actually connecting)
      const herokuConfig: PostgresAdapterOptions = {
        connectionString: 'postgresql://user:pass@ec2-host.compute-1.amazonaws.com:5432/dbname',
        ssl: { rejectUnauthorized: false }, // Heroku uses self-signed certs
      };

      expect(herokuConfig.connectionString).toBeDefined();
      expect(herokuConfig.ssl).toBeDefined();
    });

    it('should demonstrate Supabase connection', () => {
      // Example configuration (not actually connecting)
      const supabaseConfig: PostgresAdapterOptions = {
        connectionString:
          'postgresql://postgres:[YOUR-PASSWORD]@db.project.supabase.co:5432/postgres',
        ssl: true,
        max: 10,
      };

      expect(supabaseConfig.connectionString).toBeDefined();
      expect(supabaseConfig.ssl).toBe(true);
    });

    it('should demonstrate DigitalOcean Managed Database', () => {
      // Example configuration (not actually connecting)
      const doConfig: PostgresAdapterOptions = {
        host: 'db-postgresql-nyc3-12345.ondigitalocean.com',
        port: 25060,
        database: 'defaultdb',
        user: 'doadmin',
        password: 'secure_password',
        ssl: { rejectUnauthorized: true },
      };

      expect(doConfig.host).toContain('ondigitalocean.com');
      expect(doConfig.port).toBe(25060);
    });
  });
});
