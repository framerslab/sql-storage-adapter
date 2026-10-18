import { describe, expect, it, afterAll, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { createPostgresAdapter, createStorageFeatures } from '../src/index.js';

// CI starts a PostgreSQL that offers TLS with a certificate made for the run,
// for localhost, which no public certificate authority signed: it reads
// POSTGRES_TLS_TEST_URL, and POSTGRES_TLS_ROOT_CERT names the certificate.
// pg's TLS is Node's, which checks the server's certificate and host name
// unless rejectUnauthorized is false. The export hands pg_dump libpq settings
// that check the server as pg does: libpq's require checks nothing without a
// root certificate file (fe-secure-openssl.c), so pg_dump exported from a
// server pg refuses.

const TLS_URL = process.env.POSTGRES_TLS_TEST_URL;
const ROOT_CERT = process.env.POSTGRES_TLS_ROOT_CERT;

/** The tables a custom-format dump holds, as schema.table, from pg_restore's list of it. */
const dumpedTables = (file: string): string[] =>
  execFileSync('pg_restore', ['--list', file], { encoding: 'utf8' })
    .split('\n')
    .flatMap((line) => {
      const match = /^\d+; \d+ \d+ TABLE (?!DATA )(\S+) (\S+) /.exec(line);
      return match ? [`${match[1]}.${match[2]}`] : [];
    })
    .sort();

describe.skipIf(!TLS_URL || !ROOT_CERT)('the PostgreSQL exporter, through pg_dump, on a server that offers TLS', () => {
  const server = new URL(TLS_URL ?? 'postgresql://localhost');
  const settings = {
    host: server.hostname,
    port: Number(server.port || 5432),
    database: server.pathname.slice(1),
    user: decodeURIComponent(server.username),
    password: decodeURIComponent(server.password),
  };
  const table = `tls_items_${Math.random().toString(36).slice(2, 10)}`;
  let dir: string;
  let admin: pg.Pool;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-export-tls-'));
    admin = new pg.Pool({ ...settings, ssl: { rejectUnauthorized: false } });
    await admin.query(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY)`);
  });

  afterAll(async () => {
    await admin.query(`DROP TABLE IF EXISTS ${table}`).catch(() => undefined);
    await admin.end();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses, as pg does, a server whose certificate no authority the pool trusts signed, with ssl: true', async () => {
    const pool = new pg.Pool({ ...settings, ssl: true });
    try {
      await expect(pool.query('SELECT 1')).rejects.toThrow(/self[- ]signed certificate/i);

      const file = path.join(dir, 'checked.dump');
      await expect(createStorageFeatures(createPostgresAdapter({ pool })).exporter.exportToFile(file)).rejects.toThrow(
        /pg_dump failed.*certificate verify failed/s,
      );
    } finally {
      await pool.end();
    }
  });

  it('exports through a pool that checks no certificate, where pg connects, with rejectUnauthorized: false', async () => {
    const pool = new pg.Pool({ ...settings, ssl: { rejectUnauthorized: false } });
    try {
      await pool.query('SELECT 1');

      const file = path.join(dir, 'unchecked.dump');
      await createStorageFeatures(createPostgresAdapter({ pool })).exporter.exportToFile(file);

      expect(dumpedTables(file)).toContain(`public.${table}`);
    } finally {
      await pool.end();
    }
  });

  // pg reads the root certificate the string names and checks the server and
  // its host name against it; pg_dump gets the same file with verify-full.
  it('exports through a pool whose connection string names the root certificate it checks the server against', async () => {
    const connectionString = `${TLS_URL}${(TLS_URL as string).includes('?') ? '&' : '?'}sslrootcert=${encodeURIComponent(ROOT_CERT as string)}`;
    const pool = new pg.Pool({ connectionString });
    try {
      await pool.query('SELECT 1');

      const file = path.join(dir, 'rooted.dump');
      await createStorageFeatures(createPostgresAdapter({ pool })).exporter.exportToFile(file);

      expect(dumpedTables(file)).toContain(`public.${table}`);
    } finally {
      await pool.end();
    }
  });

  /** The server's URL with another host, which reaches the same server, and these parameters. */
  const urlWith = (host: string, parameters: Record<string, string>): string => {
    const url = new URL(TLS_URL ?? 'postgresql://localhost');
    url.hostname = host;
    for (const [name, value] of Object.entries(parameters)) url.searchParams.set(name, value);
    return url.toString();
  };

  // The certificate names localhost and 127.0.0.1, and 127.0.0.2 reaches the
  // same server. Node's TLS checks the host name, an IP address too, against
  // the certificate, and libpq's verify-full does (fe-secure-common.c,
  // pq_verify_peer_name_matches_certificate).
  it('refuses, as pg does, a host the certificate does not name, though its root certificate signed it', async () => {
    const pool = new pg.Pool({ connectionString: urlWith('127.0.0.2', { sslrootcert: ROOT_CERT as string }) });
    try {
      await expect(pool.query('SELECT 1')).rejects.toThrow(/does not match certificate's altnames/);

      const file = path.join(dir, 'other-host.dump');
      await expect(createStorageFeatures(createPostgresAdapter({ pool })).exporter.exportToFile(file)).rejects.toThrow(
        /pg_dump failed.*does not match host name/s,
      );
    } finally {
      await pool.end();
    }
  });

  // pg reads verify-ca as libpq does with uselibpqcompat=true, and checks the
  // certificate against the root certificate and no host name
  // (pg-connection-string index.js:125-132); pg_dump gets verify-ca.
  it('exports, where pg connects, from a host the certificate does not name with uselibpqcompat=true and verify-ca', async () => {
    const pool = new pg.Pool({
      connectionString: urlWith('127.0.0.2', {
        uselibpqcompat: 'true',
        sslmode: 'verify-ca',
        sslrootcert: ROOT_CERT as string,
      }),
    });
    try {
      await pool.query('SELECT 1');

      const file = path.join(dir, 'verify-ca.dump');
      await createStorageFeatures(createPostgresAdapter({ pool })).exporter.exportToFile(file);

      expect(dumpedTables(file)).toContain(`public.${table}`);
    } finally {
      await pool.end();
    }
  });
});
