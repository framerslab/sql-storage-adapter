<!-- BRANDING-LOGOS -->

# SQL Storage Adapter

<p align="center">
  <a href="https://frame.dev" target="_blank" rel="noopener">
    <img src="https://raw.githubusercontent.com/framerslab/sql-storage-adapter/master/logos/frame-square-black-1024x1024-transparent.png" alt="Frame.dev" width="120">
  </a>
  <br>
</p>

[![npm version](https://img.shields.io/npm/v/@framers/sql-storage-adapter.svg?logo=npm&label=npm)](https://www.npmjs.com/package/@framers/sql-storage-adapter)
[![CI](https://github.com/framerslab/sql-storage-adapter/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/framerslab/sql-storage-adapter/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/framerslab/sql-storage-adapter/branch/master/graph/badge.svg)](https://codecov.io/gh/framerslab/sql-storage-adapter)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-blue.svg)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/npm/l/@framers/sql-storage-adapter.svg)](./LICENSE)

> Cross-platform SQL access for Node.js, web, and native runtimes with automatic adapter selection and consistent APIs.

The SQL Storage Adapter provides a single, ergonomic interface over SQLite (native and WASM), PostgreSQL, Capacitor, IndexedDB, and in-memory stores. It handles adapter discovery, capability detection, and advanced features like cloud backups so you can focus on your application logic.

**🆕 NEW in v0.6.0:** SQL Dialect abstractions for SQLite/Postgres parity + Cross-platform BLOB codec + Full-text search interface!

---

- [Features](#features)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Adapter Matrix](#adapter-matrix)
- [Electron Adapter](#electron-adapter)
- [Cross-Platform Sync](#cross-platform-sync)
- [Configuration & Resolution](#configuration--resolution)
- [Segments](#segments)
- [A PostgreSQL Pool of Your Own](#a-postgresql-pool-of-your-own)
- [Key-Value Store](#key-value-store)
- [Platform Strategy](#platform-strategy)
- [SQL Dialect & Feature Abstractions](#sql-dialect--feature-abstractions)
- [CI, Releases, and Badges](#ci-releases-and-badges)
- [Contributing](#contributing)
- [License](#license)

## Features

- **Auto-detected adapters** – `createDatabase()` inspects environment signals and picks the best backend (native SQLite, PostgreSQL, Capacitor, sql.js, **IndexedDB**, memory, etc.).
- **Capability-aware API** – consistent CRUD, transactions, batching, and event hooks across adapters with runtime capability introspection.
- **🆕 IndexedDB** – sql.js + IndexedDB persistence wrapper for browser-native, offline-first web apps (uses sql.js for SQL execution, IndexedDB for storage).
- **🆕 Electron Adapter** – Full IPC bridge with main/renderer process split, WAL management, auto-migrations, multi-window support.
- **🆕 Cross-Platform Sync** – Real-time delta sync with vector clocks, WebSocket/HTTP transports, conflict resolution UI hooks, and device registry.
- **🆕 Performance Tiers** – Configurable `fast`, `balanced`, `accurate`, `efficient` presets for cost/accuracy tradeoffs. See [Optimization Guide](./guides/OPTIMIZATION_GUIDE.md).
- **🆕 Lifecycle Hooks** – Extensible hooks (`onBeforeQuery`, `onAfterQuery`, `onBeforeWrite`, `onAfterWrite`) for logging, analytics, caching, and custom extensions.
- **Cloud backups & migrations** – built-in backup manager with compression, retention policies, and restore helpers plus migration utilities.
- **Portable packaging** – optional native dependencies; falls back to pure TypeScript/WASM adapters when native modules are unavailable.
- **Browser-friendly** – Dynamic imports prevent bundlers from including server-only dependencies (`pg`, `path`) in browser builds.
- **Mobile/Offline Parity** – Same APIs work across desktop, mobile (Capacitor), and browser with automatic sync support.
- **🆕 SQL Dialect** – Write cross-platform SQL with `SqlDialect` interface. Automatically translates `INSERT OR IGNORE`, `json_extract`, `ifnull`, `PRAGMA` between SQLite and PostgreSQL.
- **🆕 Full-Text Search** – `IFullTextSearch` interface abstracts FTS5 (SQLite) and tsvector/GIN (PostgreSQL) with unified `createIndex`, `matchClause`, `rankExpression`, and `rebuildCommand` APIs.
- **🆕 BLOB Codec** – `IBlobCodec` for cross-platform binary vector storage. `NodeBlobCodec` (Buffer) for server, `BrowserBlobCodec` (DataView) for web.
- **🆕 Database Export** – `IDatabaseExporter` with `SqliteFileExporter` (VACUUM INTO) and `PostgresExporter` (pg_dump).
- **CI-first design** – Vitest coverage, Codecov integration, and GitHub Actions workflows for linting, testing, releasing, and npm publish/tag automation.

## Installation

```bash
# Core package
npm install @framers/sql-storage-adapter

# Install only the adapters you plan to use
npm install better-sqlite3            # Native SQLite for Node/Electron
npm install pg                        # PostgreSQL
npm install @capacitor-community/sqlite  # Capacitor / mobile
npm install sql.js                    # WASM SQLite (auto-included for IndexedDB)
# IndexedDB uses sql.js (no extra install needed)
```

> Windows users: ensure the Visual Studio Build Tools (C++ workload) are installed before adding `better-sqlite3`. On Linux, install `python3`, `build-essential`, and `libssl-dev` prior to `npm install`.

> Note: If `better-sqlite3` cannot be required, install native build tools before `npm install`, ensure your Node version matches available prebuilt binaries, or fall back to `sql.js` or `indexeddb` by setting `STORAGE_ADAPTER=sqljs` or `STORAGE_ADAPTER=indexeddb`.

> `better-sqlite3` 13 needs Node-API 10: Node.js 22.14+ or 23.6+, or Electron 35+ (whose Node is 22.14). On an older runtime (Node.js 20, Node.js 22.13 and earlier, Electron 34 and earlier) install `better-sqlite3@12`; with 13 installed there, the adapter refuses to open, so the resolver falls back to `sql.js`, rather than letting the native binding crash the process. `better-sqlite3` 13 ships prebuilt binaries, but npm can still run `node-gyp rebuild` for it, which needs the build tools above (Python, and make and a C++ compiler, or the Visual Studio Build Tools on Windows): always when it installs from a lockfile (`npm ci`, or `npm install` with a `package-lock.json`), and on some platforms on a fresh install too ([WiseLibs/better-sqlite3#1516](https://github.com/WiseLibs/better-sqlite3/issues/1516)).

### Entries

The root entry exports everything and imports every adapter. A server takes its adapter from that adapter's own entry, with the rest from `./core`, so its bundle carries neither sql.js nor the S3 client:

```typescript
import { createPostgresAdapter } from '@framers/sql-storage-adapter/postgres';
import { createStorageFeatures, runSchemaMigrations, isUniqueViolation } from '@framers/sql-storage-adapter/core';
```

| Entry | Holds |
| --- | --- |
| `@framers/sql-storage-adapter` | Everything, with `createDatabase` and the resolver |
| `./core` | Contracts and errors, dialects, full-text search, codecs, exporters, `createStorageFeatures`, the schema-migration runner, `isUniqueViolation`, the logger. No adapter |
| `./postgres`, `./better-sqlite3`, `./sqljs`, `./indexeddb`, `./capacitor` | One adapter each |
| `SupabaseAdapter` (root) | Deprecated: use `./postgres` with the Supabase connection string |
| `./backup` | S3-compatible backups (`@aws-sdk/client-s3`) |
| `./authjs` | The Auth.js database adapter (also in `./core`) |
| `./electron`, `./electron/renderer`, `./electron/preload` | The Electron adapters. `./electron/renderer` holds only what a window uses; `require('./electron/preload')` gives one bundled CommonJS file for a sandboxed preload |
| `./sync`, `./kv`, `./types` | Cross-platform sync, the key-value store, the types |

Every entry has an `import` and a `require` condition. The CommonJS build under `dist/cjs` is made from the ES module build file by file, so a class has one identity whichever entry a caller takes it from. It carries its own declarations, so a CommonJS TypeScript consumer under `node16` resolution type-checks against them. CI packs the package, installs it in a new project and checks each of these: `require()` of every entry, what each server entry bundles, and the preload.

## Quick Start

```typescript
import { createDatabase } from '@framers/sql-storage-adapter';

async function main() {
  // Automatically selects the best adapter for the current runtime
  const db = await createDatabase();

  await db.exec(`
    CREATE TABLE IF NOT EXISTS todos (
      id INTEGER PRIMARY KEY,
      task TEXT NOT NULL,
      done INTEGER DEFAULT 0
    )
  `);

  await db.run('INSERT INTO todos (task) VALUES (?)', ['Ship cross-platform builds']);
  const items = await db.all<{ id: number; task: string; done: number }>('SELECT * FROM todos');
  console.log(items);

  await db.close();
}

main().catch((error) => {
  console.error('Database bootstrap failed', error);
  process.exit(1);
});
```

## Platform-Specific Examples

```typescript
import { createDatabase, IndexedDbAdapter } from '@framers/sql-storage-adapter';

// Web (Browser): Uses IndexedDB
const webDb = await createDatabase({ priority: ['indexeddb', 'sqljs'] });

// Desktop (Electron): Uses better-sqlite3
const desktopDb = await createDatabase({ priority: ['better-sqlite3', 'sqljs'] });

// Mobile (Capacitor): Uses native SQLite
const mobileDb = await createDatabase({ priority: ['capacitor', 'indexeddb'] });

// Cloud (Node): Uses PostgreSQL. strict fails when DATABASE_URL is unset,
// where it would otherwise open a local SQLite file.
const cloudDb = await createDatabase({
  url: process.env.DATABASE_URL,
  strict: true
});
```

See [Platform Strategy Guide](./PLATFORM_STRATEGY.md) for detailed pros/cons and architecture.

## Adapter Matrix

| Adapter | Package | Ideal for | Pros | Considerations |
| --- | --- | --- | --- | --- |
| **🆕 `electron`** | bundled | **Electron desktop apps** | IPC bridge, multi-window, WAL, auto-migrations, crash recovery | Requires Electron runtime; create it from `@framers/sql-storage-adapter/electron` (the resolver does not build the `electron-main` and `electron-renderer` kinds) |
| **🆕 `indexeddb`** | bundled (sql.js) | **Browsers, PWAs** | sql.js + IndexedDB persistence wrapper, browser-native storage, 50MB-1GB+ quota, offline-first | IndexedDB quotas vary, WASM overhead (sql.js), not a separate SQL engine |
| `better-sqlite3` | `better-sqlite3` | Node/Electron, CLI, CI | Native performance, transactional semantics, WAL support | Needs native toolchain; version must match Node ABI; 13.x needs Node-API 10 (Node.js 22.14+, Electron 35+) |
| `postgres` | `pg` | Hosted or on-prem PostgreSQL | Connection pooling, rich SQL features, cloud friendly | Requires `DATABASE_URL`/credentials |
| `sqljs` | bundled | Browsers, serverless edge, native fallback | Pure WASM SQLite, no native deps, optional filesystem persistence | Write performance limited vs native, in-memory by default |
| `capacitor` | `@capacitor-community/sqlite` | Mobile (iOS/Android, Capacitor) | Native SQLite on mobile, encryption | Requires Capacitor runtime |
| `memory` | bundled (sql.js) | Unit tests, storybooks, constrained sandboxes | Zero dependencies, instant startup | The resolver builds the sql.js adapter for it, as for `sqljs`: in memory in a browser, persisted to the resolver's file path on Node |

### Platform Priorities

| Platform | Primary Adapter | Fallback | Use Case |
|----------|----------------|----------|----------|
| **Web (Browser)** | IndexedDB | sql.js | PWAs, offline-first web apps |
| **Electron (Desktop)** | electron | better-sqlite3 | Desktop apps, dev tools |
| **Capacitor (Mobile)** | capacitor | IndexedDB | iOS/Android native apps |
| **Node.js** | better-sqlite3 | Postgres, sql.js | CLI tools, local servers |
| **Cloud (Serverless)** | Postgres | None with `strict` or `createDatabase({ url })`; better-sqlite3 from `resolveStorageAdapter()` otherwise | Multi-tenant SaaS, APIs |

## Electron Adapter

The Electron adapter provides a complete IPC bridge architecture for Electron apps with main/renderer process split.

```typescript
// Main process (main.ts)
import { createElectronMainAdapter } from '@framers/sql-storage-adapter/electron';

const db = await createElectronMainAdapter({
  filePath: path.join(app.getPath('userData'), 'app.db'),
  wal: { enabled: true, checkpointInterval: 30000 },
  autoMigration: { enabled: true, migrationsPath: './migrations' },
  multiWindow: { enabled: true, broadcastChanges: true },
});

await db.open();
```

```typescript
// Renderer process
import { createElectronRendererAdapter } from '@framers/sql-storage-adapter/electron';

const db = createElectronRendererAdapter();
await db.open();

const users = await db.all('SELECT * FROM users');
```

**Features:**
- ✅ Type-safe IPC protocol with request/response correlation
- ✅ WAL checkpoint management and corruption detection
- ✅ Auto-migration on app version change
- ✅ Multi-window database change broadcasting
- ✅ Preload script with secure `contextBridge` API

## Cross-Platform Sync

Real-time delta synchronization across Electron, Capacitor, browser, and server platforms.

```typescript
import { createCrossPlatformSync } from '@framers/sql-storage-adapter/sync';

const sync = await createCrossPlatformSync({
  localAdapter: db,
  endpoint: 'wss://sync.example.com',
  authToken: 'bearer-token',
  device: { name: 'MacBook Pro', type: 'electron' },
  tables: {
    notes: { priority: 'high', conflictStrategy: 'merge' },
    settings: { priority: 'critical', conflictStrategy: 'local-wins' },
  },
  hooks: {
    onConflictNeedsResolution: async (conflict) => {
      // Show UI for manual conflict resolution
      return showConflictDialog(conflict);
    },
    onSyncComplete: (result) => {
      console.log(`Synced: ${result.changesPushed} pushed, ${result.changesPulled} pulled`);
    },
  },
});

// Manual sync
await sync.sync();

// Or enable real-time sync
await sync.connect();
```

**Features:**
- ✅ **Vector Clocks** – Distributed causality tracking for accurate conflict detection
- ✅ **WebSocket Transport** – Real-time bidirectional sync with auto-reconnection
- ✅ **HTTP Fallback** – Polling transport for firewalls that block WebSocket
- ✅ **Conflict Resolution** – Strategies: `last-write-wins`, `local-wins`, `remote-wins`, `merge`, `manual`
- ✅ **Device Registry** – Track syncing devices with presence status (online/offline/syncing)
- ✅ **UI Hooks** – Custom conflict resolution dialogs

**Conflict Strategies:**

| Strategy | Description |
|----------|-------------|
| `last-write-wins` | Most recent change wins (by timestamp) |
| `local-wins` | Local changes always take priority |
| `remote-wins` | Remote changes always take priority |
| `merge` | Field-level merge with custom mergers |
| `manual` | Defer to UI hook for user decision |

## Configuration & Resolution

- `resolveStorageAdapter` inspects:
  - explicit options (`priority`, `type`, adapter configs),
  - environment variables (`STORAGE_ADAPTER`, `DATABASE_URL`),
  - runtime hints (Capacitor detection, browser globals, IndexedDB availability).
- Adapters are attempted in priority order until one opens successfully; a `StorageResolutionError` includes the full failure chain.
- The resolver builds `postgres`, `better-sqlite3`, `capacitor`, `indexeddb` and `sqljs`, and builds sql.js for `memory`. Any other kind (`electron-main`, `electron-renderer`, `supabase`, or an unknown name, from `priority` or `STORAGE_ADAPTER`) fails as a candidate with an error that names it, and the next candidate is tried.
- On Node, `createDatabase({ url })`, `createDatabase({ postgres })` and `connectDatabase()` open PostgreSQL, with every Postgres option (pool size, SSL, timeouts, application name, or host, port, database, user and password without a connection string, or a `pool` of your own) passed on, and do not fall back to SQLite. `DATABASE_URL` in the environment does not change what `createDatabase()` picks; `resolveStorageAdapter()` without a `priority` tries Postgres first when it is set.
- In a browser, `createDatabase()` keeps the database in IndexedDB (`['indexeddb', 'sqljs']`, sql.js in memory where IndexedDB cannot open), whatever the Postgres options say; `createDatabase({ file: ':memory:' })` and `createMemoryDatabase()` keep sql.js in memory. In a Capacitor app on a phone it chooses `['capacitor', 'indexeddb', 'sqljs']`, as the resolver does. On Deno it opens sql.js. `indexedDb` options (`dbName`, `durability`, `crossTab` and the rest) reach the IndexedDB adapter whole.
- `strict: true` (on `createDatabase` and `resolveStorageAdapter`) is for servers: only the database the options name opens. A postgres candidate that fails ends resolution with a `StorageResolutionError`, whatever `priority` lists after it; with `DATABASE_URL` or Postgres options that name a server and no `priority`, `['postgres']` is the whole list; an explicit file path (`file`, `filePath`) outranks `DATABASE_URL`; and a `url` or `postgres` option that names no server fails instead of opening the local default, unless a file is given. Without `strict`, `resolveStorageAdapter()` falls back from a failed Postgres to better-sqlite3, IndexedDB and sql.js, and `DATABASE_URL` comes before a `filePath`.
- `foreignKeys` (on `createDatabase`, or in `openOptions` for the resolver and `open()`) sets SQLite's foreign-key enforcement when a SQLite adapter opens: `true` turns it on and `false` off, on better-sqlite3, sql.js, IndexedDB and Capacitor. The setting holds across the sql.js saves, exports and imports, which reopen the connection and reset its PRAGMAs. Left out, each engine keeps its default, and the defaults differ: better-sqlite3 enforces foreign keys (it is built with `SQLITE_DEFAULT_FOREIGN_KEYS=1`, per its [compilation options](https://github.com/WiseLibs/better-sqlite3/blob/v13.0.3/docs/compilation.md)), while sql.js, IndexedDB and Capacitor do not, as SQLite leaves [foreign keys off by default](https://www.sqlite.org/foreignkeys.html#fk_enable). Until a product passes `foreignKeys`, the same schema behaves differently per engine. Pass `foreignKeys: true` for the same behaviour everywhere. PostgreSQL always enforces foreign keys and ignores the option.
- Provide `priority: ['indexeddb', 'sqljs']` for browser bundles or tests where native modules shouldn't load.
- Use `createCloudBackupManager` for S3-compatible backups with gzip compression and retention limits.

### Transactions

`transaction(fn)` commits when `fn` resolves and rolls back when it throws. Run the callback's statements through the handle it receives:

```typescript
await db.transaction(async (trx) => {
  await trx.run('UPDATE accounts SET balance = balance - ? WHERE id = ?', [100, 'a']);
  await trx.run('UPDATE accounts SET balance = balance + ? WHERE id = ?', [100, 'b']);
});
```

The IndexedDB, Capacitor and better-sqlite3 adapters run every transaction on one connection, so they run transactions one at a time, and a statement from another caller waits until the open transaction ends: it neither joins the transaction (and vanishes in its rollback) nor reads what the transaction has not committed. A browser or a WebView has no async context to tell the callback's own statements apart, so on the IndexedDB and Capacitor adapters a statement the callback issues through the adapter itself, not through its handle, waits for the transaction too. The two then wait on each other, and the adapter logs a warning after 10 seconds. (On Node, better-sqlite3 tells them apart with `AsyncLocalStorage`.) Inside a callback, run every statement through the handle, and do not await work that itself needs the database.

The PostgreSQL adapter runs each transaction on its own pooled connection, so transactions run side by side. When the connection breaks during a transaction and its ROLLBACK fails too, `transaction()` still throws the transaction's own error (the callback's, or COMMIT's), with the ROLLBACK error on it as a non-enumerable `rollbackError` property. The broken connection is closed, not returned to the pool. A connection the server closes while a callback holds it, between statements, does not end the process. Once a transaction has ended, its handle runs on the pool, as the adapter's own statements do, and its `transaction()` begins a new transaction.

### Segments

A segment keeps one user's tables apart from another's in a database they share: AgentOS's tables beside an app's, in one PostgreSQL database or one browser.

```typescript
import { createDatabase } from '@framers/sql-storage-adapter';

// The app's own tables, and AgentOS's in a segment of the same database
const app = await createDatabase({ url: process.env.DATABASE_URL });
const agentos = await createDatabase({ url: process.env.DATABASE_URL, segment: 'agentos' });
```

| Backend | What a segment is | `segment: 'agentos'` |
| --- | --- | --- |
| PostgreSQL | A schema of its own | Every connection of the pool starts with `search_path` set to `agentos, public`; `open()` creates the schema when it is missing |
| better-sqlite3, sql.js, Electron | A file of its own | `app.sqlite3` becomes `app-agentos.sqlite3`; `:memory:` stays as it is |
| IndexedDB | A database of its own | `app-db` becomes `app-db-agentos` |
| Capacitor | A database of its own | `app` becomes `app-agentos` |

A segment name is lower-case letters, digits and underscores, starts with a letter or an underscore, and has at most 63 characters; it is not `public`, `information_schema` or a name beginning with `pg_`. A name outside that is refused before any adapter is tried. `segment` goes on `createDatabase()`, `resolveStorageAdapter()` and each adapter's own options, and `segmentName()` and `segmentFilePath()` give the name a segment's database or file has.

On PostgreSQL:

- The `search_path` is a startup option of each connection, so a connection the pool opens to replace one the server ended starts in the segment too, and `RESET search_path` and `DISCARD ALL` return to it. `PGOPTIONS` is kept beside it. A connection string that sets its own `options` parameter is refused with a segment, since pg would send it in place of the segment's.
- `public` stays on the path, so the types, functions and operators of extensions installed there resolve in every segment: pgvector's `vector` and `<->`. A `CREATE EXTENSION` that names no schema installs the extension into `public`, as it would without a segment, instead of into the segment, where no other segment and not the host would find it. When an extension a segment asks for is already installed in another segment's schema, the adapter warns once and names the `ALTER EXTENSION ... SET SCHEMA public` that moves it.
- A name the segment does not hold falls through to `public`. Create a segment's tables before reading them (`CREATE TABLE IF NOT EXISTS` creates the table in the segment even when `public` has one of that name), and name the schema in a `DROP` or `ALTER` that `public` could also answer.
- `exportData()` exports the tables of the current schema: the segment's, or `public` without one.
- A segment cannot run on a pool of your own: the adapter sets `search_path` when it starts a connection, and it does not start the connections of a pool it did not make. `createDatabase()` and `resolveStorageAdapter()` refuse a segment with `postgres.pool` before they try any adapter.

On the Electron main adapter, a segmented adapter serves the main process alone: the renderer's IPC channels are one set per process, and they stay with the adapter without a segment.

### A PostgreSQL Pool of Your Own

The Postgres adapter runs on a `pg` `Pool` you made, from the start, with no `open()` needed:

```typescript
import pg from 'pg';
import { PostgresAdapter } from '@framers/sql-storage-adapter';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
const db = new PostgresAdapter({ pool, onError: (error) => console.warn('idle connection failed', error) });

await db.close(); // leaves the pool open; pool.end() is yours
```

- `close()` leaves a pool of yours open. Pass `ownsPool: true` when the adapter is the pool's one holder and closing the adapter is how the pool ends: `close()` then ends it once, however often it is called. `open()` after `close()` takes the pool up again, unless it has ended.
- `onError` is called with the error an idle connection of the pool reports (the server ended it, the network dropped). pg raises such an error as an event that ends the process when nothing listens. On a pool of yours the adapter listens only when given `onError`, and takes its listener off on `close()`; on a pool it makes or owns it listens anyway, and logs a warning when no `onError` was given.
- `getPool()` returns the pool the adapter runs on: yours, or the one it made, while it is open.
- The settings that configure a pool when one is made (`connectionString`, `host`, `max`, `ssl`, the timeouts, `typeParsers` and the rest) and `segment` cannot be given with `pool`: set them on the pool (`typeParsers` as the pool's own `types`).
- `createDatabase({ postgres: { pool } })` opens PostgreSQL on it.

A host on 0.6 that wrote its Pool into the adapter's `pool` field before `open()` keeps working: the adapter runs on that Pool and ends it on `close()`, as 0.6 did. Moving to `{ pool }`, such a host passes `ownsPool: true` to keep `close()` ending the Pool.

### Placeholders

Bind `?` placeholders from an array, `@name` placeholders from an object, or `$1`, `$2`, ... from an array on PostgreSQL and SQLite alike:

```typescript
await db.run('INSERT INTO notes (id, body) VALUES (?, ?)', [1, 'Is this saved?']);
await db.get('SELECT * FROM notes WHERE id = @id', { id: 1 });
await db.all('SELECT * FROM notes WHERE id = $1 OR parent_id = $1', [1]);
```

- A `?`, `@name` or `$1` inside a string literal, a quoted identifier, a PostgreSQL dollar-quoted string or a comment is text, never a placeholder.
- On PostgreSQL, `??` is the jsonb `?` (key exists) operator, and `?|` and `?&` stay operators; put a space between a placeholder and a following `|` or `&`. A statement that already uses `$n` is sent as written, so its `?` operators need no escape, and a statement run without parameters keeps its `?`.
- On SQLite, `$1`, `$2`, ... become `?` with the values in their order, repeats included. A statement that mixes `?` and `$n` is refused.

### Schema migrations

`runSchemaMigrations()` applies hand-written SQL files in number order, on PostgreSQL and SQLite alike:
- each file runs in its own transaction and is recorded in a ledger table with the SHA-256 of its text;
- a file already in the ledger is skipped;
- an applied file whose text changed is refused, as is a ledger row the list lacks (the database is ahead of the code);
- a failing file is rolled back, and the error names it.

```typescript
import { readSchemaMigrations, runSchemaMigrations, schemaMigrationStatus } from '@framers/sql-storage-adapter';

// migrations/0001_accounts.sql, migrations/0002_billing.sql, ...; or migrations/postgres/ and migrations/sqlite/ per dialect
const migrations = await readSchemaMigrations('migrations', { dialect: 'postgres' });
const report = await runSchemaMigrations(db, migrations);              // { applied, skipped, ... }
const status = await schemaMigrationStatus(db, migrations);            // { applied, pending, changed, unknown }; applies nothing
```

- **Files.** File names are digits, an underscore and a lower-case name (`001_init.sql`, `0001_accounts.sql`). They are ordered by number, and a number used twice is refused. `readSchemaMigrations(dir, { dialect })` reads `dir/postgres` or `dir/sqlite` when that folder exists, else `dir`. A file holds no `BEGIN` or `COMMIT`.
- **Ledger.** `table` (default `schema_migrations`) and `checksumColumn` (default `checksum`) name the ledger. An existing ledger with `name` and a SHA-256 column is read as it is, for example `{ table: '_migrations', checksumColumn: 'content_hash' }`.
- **Locking.** On PostgreSQL each file's transaction takes `pg_advisory_xact_lock(lockKey)` and checks the ledger again, so two runners at once apply each file once. `lockKey` is an integer, or text hashed with `hashtext()`. On SQLite the file's write transaction is the lock.
- **Outside a transaction.** A file whose first line is `-- outside transaction` (`outsideTransactionMarker`) runs outside a transaction, for `CREATE INDEX CONCURRENTLY` or `VACUUM`. On PostgreSQL it runs under the session lock on one held connection (`withConnection`).
- **Unknown rows.** `unknown: 'ignore'` lets a run go on past ledger rows the list lacks.

### Auth.js

`createAuthJsAdapter(db)` is an Auth.js database adapter. It keeps users, accounts, sessions and verification tokens in the product's own database through this library, on PostgreSQL or SQLite. Pass it to NextAuth v5 or `@auth/core`; it has the shape of `Adapter` from `@auth/core/adapters`, which CI checks, and needs no dependency on it.

```typescript
import NextAuth from 'next-auth';
import { createDatabase } from '@framers/sql-storage-adapter';
import { createAuthJsAdapter, ensureAuthJsTables } from '@framers/sql-storage-adapter/authjs';

const db = await createDatabase({ url: process.env.DATABASE_URL, strict: true });
await ensureAuthJsTables(db); // or put authJsTablesSql(db) in a migration
export const { handlers, auth, signIn, signOut } = NextAuth({ adapter: createAuthJsAdapter(db), providers: [/* ... */] });
```

- **Tables.** They are `auth_users`, `auth_accounts`, `auth_sessions` and `auth_verification_tokens`; `tablePrefix` changes the `auth_`. Ids are text, from `crypto.randomUUID()` unless Auth.js passes one or `generateId` is given. Times are `timestamptz` on PostgreSQL and ISO 8601 text on SQLite, and Dates either way in JavaScript.
- **Deletes.** `deleteUser` deletes the user's sessions and accounts first, in one transaction, so it holds on engines that leave foreign keys off.
- **Verification tokens.** `useVerificationToken` deletes and returns the token in one statement (`DELETE ... RETURNING`), so a token works once.
- **Passkeys.** WebAuthn authenticators are not stored.
- **Tests.** Auth.js's own adapter test suite runs against it on PostgreSQL, better-sqlite3 and sql.js.

### Values

On SQLite, values convert as they bind, positional and named alike:
- a boolean binds as 1 or 0;
- a Date binds as its ISO 8601 text;
- an array or a plain object binds as JSON text;
- undefined binds as NULL;
- bytes (`Uint8Array`, `Buffer`) bind as a blob.

On PostgreSQL, pg binds them itself: an array as a PostgreSQL array, an object as JSON, a Date as a timestamp.

Reading back, pg returns int8 and numeric as strings and a DATE as a Date at local midnight. `typeParsers` in the PostgreSQL options sets that per pool:

```typescript
const db = await createDatabase({
  url: process.env.DATABASE_URL,
  strict: true,
  postgres: { typeParsers: { int8: 'bigint', numeric: 'number', date: 'string' } },
});
```

- `int8`: `'string'` (pg's default), `'number'` (refuses a value past `Number.MAX_SAFE_INTEGER`) or `'bigint'`.
- `numeric`: `'string'` (pg's default) or `'number'` (a double, so it can round).
- `date`: `'date'` (pg's default) or `'string'` (`YYYY-MM-DD`).
- `json` (json and jsonb): `'parse'` (pg's default) or `'string'`, the text SQLite returns.

### Errors

`isUniqueViolation(error)` recognises a unique or primary-key violation from any adapter:
- PostgreSQL's SQLSTATE 23505;
- better-sqlite3's `SQLITE_CONSTRAINT_UNIQUE` and `SQLITE_CONSTRAINT_PRIMARYKEY`;
- the "UNIQUE constraint failed" message from sql.js, IndexedDB and Capacitor.

It follows `cause`, so an error your code wraps still counts.

```typescript
import { isUniqueViolation } from '@framers/sql-storage-adapter';

try {
  await db.run('INSERT INTO users (email) VALUES (?)', [email]);
} catch (error) {
  if (isUniqueViolation(error)) return { taken: true };
  throw error;
}
```

### Logging

The library writes its log lines to the console unless a host hands it a logger: which adapter it chose, a fallback, a failed ROLLBACK, an adapter's warnings. pino's logger fits as it is, since each line is a fields object and a message.

```typescript
import pino from 'pino';
import { createDatabase, setStorageLogger } from '@framers/sql-storage-adapter';

// Every line, from every call
setStorageLogger(pino({ name: 'storage' }));

// Or one call's resolver lines
const db = await createDatabase({ url: process.env.DATABASE_URL, strict: true, logger: requestLogger });
```

`setStorageLogger(null)` writes to the console again, and `quiet: true` silences the resolver's choice and fallback lines whatever the logger.

The logger takes the lines of the resolver, the PostgreSQL adapter and the adapter base class. The IndexedDB, Capacitor, sync and Electron modules write to the console directly.

### PostgreSQL pool control

`PostgresAdapter` holds a `pg` pool. Narrow an adapter to it with `db instanceof PostgresAdapter` (or `db.kind === 'postgres'`) to reach these:

```typescript
import { createDatabase, PostgresAdapter } from '@framers/sql-storage-adapter';

const db = await createDatabase({ url: process.env.DATABASE_URL, strict: true, postgres: { max: 10, allowExitOnIdle: true } });

if (db instanceof PostgresAdapter) {
  // One connection for the callback: a session advisory lock, then statements on the same session
  await db.withConnection(async (connection) => {
    await connection.get('SELECT pg_advisory_lock(?)', [42]);
    try {
      await connection.run('UPDATE jobs SET owner = ? WHERE owner IS NULL', ['worker-1']);
    } finally {
      await connection.get('SELECT pg_advisory_unlock(?)', [42]);
    }
  });

  // Isolation level and read-only and deferrable modes
  await db.transaction(async (trx) => trx.all('SELECT * FROM ledger'), { isolationLevel: 'serializable', readOnly: true, deferrable: true });

  // { total, idle, waiting }, or null before open() and after close()
  console.log(db.getPoolStats());
}
```

- `withConnection(fn)` returns the connection to the pool when `fn` resolves, with whatever session state `fn` left (undo `SET` and release session locks before returning, or use `SET LOCAL` inside a transaction). When `fn` throws, the connection is closed, and `fn`'s error is rethrown. When `fn` returns inside a transaction it began and did not end, the connection is closed (rolling it back) and the call rejects; pg 8.21 and later report the transaction status this needs. The connection refuses statements once `fn` has ended, and `connection.transaction()` runs one transaction at a time.
- `transaction(fn, options)` refuses an isolation level outside `'read uncommitted'`, `'read committed'`, `'repeatable read'` and `'serializable'` before it checks out a connection.
- `allowExitOnIdle` is pg's option: Node can exit while every pooled connection is idle. Without it, idle connections keep the process running until `idleTimeoutMillis` (10 seconds by default) closes them.
- On a segmented adapter, `withConnection()` and `transaction()` run in the segment, as every connection of its pool does, and a `CREATE EXTENSION` that names no schema still installs into `public`. `getPoolStats()` counts a pool of yours too.

### IndexedDB-Specific Config

```typescript
import { IndexedDbAdapter } from '@framers/sql-storage-adapter';

const adapter = new IndexedDbAdapter({
  dbName: 'my-app-db',       // IndexedDB database name
  storeName: 'sqliteDb',     // Object store name
  autoSave: true,            // Auto-save to IndexedDB on a timer
  saveIntervalMs: 5000,      // Batch writes every 5s
  durability: 'commit',      // Or 'interval' (the default): see below
  crossTab: true,            // Two tabs of the site keep each other's writes
});

await adapter.open();
await adapter.run('INSERT INTO notes (text) VALUES (?)', ['kept']); // in IndexedDB when this resolves
await adapter.flush();                                              // stores every write made so far
```

**Key Features:**
- ✅ SQL execution via sql.js (WASM SQLite)
- ✅ **Automatic persistence** via IndexedDB (stores SQLite database file as blob)
- ✅ JSON support (SQLite JSON1 extension: json_extract, json_object, json_array, etc.)
- ✅ Prepared statements for performance and security
- ✅ Export/import (Uint8Array SQLite file format)
- ✅ Auto-save with batching (reduce IDB overhead), or each write stored before it resolves (`durability: 'commit'`)
- ✅ Several tabs on one database (`crossTab`)
- ✅ A database of its own per segment (`segment`)

**Durability.** With `durability: 'interval'`, the default, the auto-save tick stores the writes made since the last save every `saveIntervalMs`, and a write can be lost when the page goes before the next tick. With `durability: 'commit'`, `run()`, `exec()`, a write through `all()` or `get()` (`INSERT ... RETURNING`), `transaction()` and `importDatabase()` resolve once their write is in IndexedDB, committed there (the IndexedDB transaction's `complete` event, not the put request's success), and reject when IndexedDB refuses or aborts it; the write stays in the database and the next save stores it. Each save writes the whole database image, so batch many writes in one `transaction()`. While a transaction begun with `BEGIN` is open nothing can be saved: its statements resolve at once, and its rows are stored when its `COMMIT` resolves. `flush()` stores every write made so far in either mode: it waits for an open `transaction()`, and rejects while a transaction begun with `BEGIN` is open, which sql.js's export would end.

**Several tabs.** Each tab holds the whole database in memory and writes it back whole, so without coordination the tab that saves last overwrites the other's writes. With `crossTab`, every statement and transaction runs under a [Web Lock](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API) on the database, on the newest stored image (a tab reloads it when a version stamp stored beside the image says another tab has saved), and is stored before the lock is let go: `durability` is `'commit'` whatever it says, and a tab reads what another tab stored. A transaction holds the other tabs' statements until it commits or rolls back. A transaction begun with `BEGIN` through `run()` or `exec()` cannot be held across tabs: it is rolled back and refused, so use `transaction()`. Web Locks need a secure context and are in Chrome 69, Firefox 96 and Safari 15.4 and later (on WebKit the feature is on by default and off in Lockdown Mode). Where there are none, the version stamp alone keeps both tabs' writes: a statement that finds another tab saved first runs again on that tab's image, and a `transaction()` another tab saved over is refused with `IndexedDbConflictError`, storing nothing of it, for its caller to run again. The adapter says once when it runs without Web Locks. A tab running a version of this package before 0.7 writes no stamp, so a tab with `crossTab` does not see its saves.

**When it saves:** every `saveIntervalMs`, the adapter writes the database image to IndexedDB if anything changed. It skips the tick while a transaction is open, its own or one begun with `BEGIN`, because sql.js's export closes and reopens the connection, which would end the transaction; the next tick saves it once it has committed. A save counts as done when IndexedDB commits it, not when the put request succeeds. A save that fails or aborts is reported once, and the next tick tries again. A write made while a save is in flight is saved by the next one. A transaction's commit marks its writes for saving, including writes made through `all()` or `get()` (`INSERT ... RETURNING`). `close()` rolls back a transaction still open and saves the committed state. `importDatabase()` saves the imported image before it resolves. `exportDatabase()` throws while a transaction is open.

**Why IndexedDB Adapter vs sql.js Adapter?**

| Feature | IndexedDB Adapter | sql.js Adapter |
|---------|------------------|----------------|
| **SQL Engine** | sql.js (WASM) | sql.js (WASM) |
| **Persistence** | ✅ **Automatic** (saves to IndexedDB after writes) | ⚠️ **Manual** (you must call `db.export()` and save yourself) |
| **Data survives refresh** | ✅ Yes | ❌ No (unless you manually saved) |
| **Use Case** | Production PWAs, offline-first apps | Edge functions, temporary data, prototyping |

**Is IndexedDB Adapter Necessary?**

**✅ YES, if you need:**
- Data to survive page refreshes (production apps)
- Offline-first functionality (PWAs)
- Privacy-first apps (data never leaves browser)
- Zero manual save logic (just works)

**❌ NO, if you:**
- Only need temporary/in-memory data (edge functions, Cloudflare Workers)
- Are prototyping and don't care about persistence
- Want to manually control when data is saved
- Don't need data to survive refreshes

**The Value:** IndexedDB adapter provides **automatic persistence** that sql.js doesn't have. With sql.js alone, your data is lost on page refresh unless you manually export and save it. IndexedDB adapter does this automatically, making it production-ready for persistent client-side storage.

**Alternative:** You could use sql.js directly and manually save to IndexedDB yourself, but you'd lose:
- Automatic batched saves (performance)
- Reliable persistence (easy to forget manual saves)
- Consistent API across platforms
- Production-ready defaults

**Bottom line:** IndexedDB adapter is **necessary for production web apps** that need persistence. For prototypes or edge functions, sql.js alone is fine.

**Note:** IndexedDB adapter is a wrapper around sql.js that adds IndexedDB persistence. It's not a separate SQL engine—it uses sql.js for all SQL operations and IndexedDB only for storing the database file. Since sql.js is full SQLite WASM, it supports all SQLite features including JSON functions, BLOBs, and full-text search.

## Key-Value Store

`@framers/sql-storage-adapter/kv` holds one key-value contract and its stores. It imports no adapter, so a page that loads it for its key-value store loads neither sql.js nor pg.

```typescript
import { createDatabase } from '@framers/sql-storage-adapter';
import { createSqlKeyValueStore, namespaced, openIndexedDbStore } from '@framers/sql-storage-adapter/kv';

// In a SQL table, on any adapter: a file, IndexedDB, Capacitor or PostgreSQL
const db = await createDatabase({ segment: 'agentos' });
const kv = await createSqlKeyValueStore(db, { table: 'agentos_kv' });
await kv.set('notes/1', { title: 'One', saved: new Date() });
const mine = namespaced(kv, 'user-42/');

// In one IndexedDB object store, where a page already keeps its values
const page = await openIndexedDbStore({ dbName: 'sayshere', storeName: 'kv' });
```

`KeyValueStore` has `get`, `set`, `delete`, `keys(prefix)` and `deletePrefix(prefix)`, and `memoryOnly`, true when nothing outlives the page or the process. `namespaced(store, prefix)` scopes a store to a prefix: end each prefix with a character no id holds (`ann/`, `anna/`), since the keys under `anna` are among those under `ann`.

- `openIndexedDbStore({ dbName, storeName, version })` keeps values in one IndexedDB object store with out-of-line keys. It opens the database at `version` (1 by default) and creates the object store only when the open upgrades the database, so a database another page made at that version is read in place. A browser that refuses IndexedDB gets the memory store, and `memoryOnly` says so. This is the store AgentOS's `src/core/storage/browser` held, moved unchanged: the same database, object store, version and keys.
- `createSqlKeyValueStore(adapter, { table })` keeps values in a table it makes when it is missing, with a `key` and a `value` column. Each call is one statement on the adapter, and through a transaction's handle it joins the transaction. Keys are listed in the order of their UTF-16 code units, as IndexedDB orders them, and a prefix is read literally (`%`, `_` and `*` are characters). Each value is kept as text and comes back as the structured clone, which IndexedDB applies to every value it stores, gives it back: `undefined`, `-0`, `NaN`, bigints, `Date`, `RegExp`, `Map`, `Set`, `ArrayBuffer`, typed arrays and `DataView`, boxed primitives, errors with their message, stack and cause, objects reached twice and cycles. A value the structured clone refuses (a function, a symbol, a `WeakMap`, a promise) is refused with a `DataCloneError` before anything is written, as are the host objects text cannot hold (`Blob`, `File`, `CryptoKey`).
- `MemoryKeyValueStore` holds values for the page alone, copied in and out with `structuredClone`.

## Platform Strategy

See [**PLATFORM_STRATEGY.md**](./PLATFORM_STRATEGY.md) for a comprehensive guide on:
- Graceful degradation patterns
- Platform-specific pros/cons
- Performance benchmarks
- Offline-first architectures
- Browser-friendly bundling (dynamic imports prevent server-only dependencies from being bundled)

**TL;DR:** Use IndexedDB for web, better-sqlite3 for desktop, capacitor for mobile, Postgres for cloud.

## Performance Tiers & Cost Optimization

The package exports performance-tier types, the tier presets (`TIER_DEFAULTS`) and `resolvePerformanceConfig()`, which turns a tier and overrides into settings. `createDatabase()` takes no `performance` option, and no adapter applies a tier: a host that wants one reads the settings and acts on them itself.

```typescript
import { resolvePerformanceConfig } from '@framers/sql-storage-adapter';

// Analytics/Reporting: the accurate tier's settings (no caching, full validation)
const settings = resolvePerformanceConfig({ tier: 'accurate' });
```

| Tier | Caching | Batching | Validation | Use Case |
|------|---------|----------|------------|----------|
| `fast` | Aggressive | Yes | Minimal | Development, testing |
| `balanced` | Moderate | No | Standard | General production |
| `accurate` | Disabled | No | Full | Analytics, reporting |
| `efficient` | Moderate | Yes | Minimal | Mobile, IoT |

See [**guides/OPTIMIZATION_GUIDE.md**](./guides/OPTIMIZATION_GUIDE.md) for detailed configuration options.

## Lifecycle Hooks

The package exports the `StorageHooks` types and the `combineHooks()` and `filterHooks()` helpers. `createDatabase()` takes no `hooks` option, and no adapter runs hooks: a host that wants them calls them around its own adapter calls.

```typescript
import { combineHooks, type StorageHooks } from '@framers/sql-storage-adapter';

const myHooks: StorageHooks = {
  // Log all writes
  onBeforeWrite: async (context) => {
    console.log(`Write operation: ${context.statement}`);
    return context;
  },
  
  // Track metrics after writes
  onAfterWrite: async (context, result) => {
    if (result.changes > 0) {
      console.log(`Modified ${result.changes} rows`);
    }
  },
  
  // Log slow queries for optimization
  onAfterQuery: async (context, result) => {
    const duration = Date.now() - context.startTime;
    if (duration > 100) {
      console.warn(`Slow query (${duration}ms):`, context.statement);
    }
    return result;
  }
};

// One StorageHooks object from several; the host calls its hooks itself
const hooks = combineHooks(myHooks);
```

### Available Hooks

| Hook | Trigger | Use Cases |
|------|---------|-----------|
| `onBeforeQuery` | Before SELECT/exec | Query transformation, caching, logging |
| `onAfterQuery` | After successful query | Result transformation, metrics |
| `onBeforeWrite` | Before INSERT/UPDATE/DELETE | Validation, auditing, transformation |
| `onAfterWrite` | After successful write | Cache invalidation, sync triggers |
| `onError` | On any error | Error transformation, alerting |

See [**guides/OPTIMIZATION_GUIDE.md**](./guides/OPTIMIZATION_GUIDE.md) for complete configuration options.

## SQL Dialect & Feature Abstractions

Write cross-platform SQL that works on both SQLite and PostgreSQL without changing your application code.

### StorageFeatures Factory

```typescript
import { resolveStorageAdapter, createStorageFeatures } from '@framers/sql-storage-adapter';

const adapter = await resolveStorageAdapter({ filePath: './app.db' });
const features = createStorageFeatures(adapter);
// features.dialect  → SqliteDialect or PostgresDialect
// features.fts      → SqliteFts5 or PostgresFts
// features.blobCodec → NodeBlobCodec or BrowserBlobCodec
// features.exporter → SqliteFileExporter or PostgresExporter
```

### SqlDialect — Cross-Platform SQL

Each form below returns the same rows on PostgreSQL, better-sqlite3 and sql.js; `tests/dialect.parity.spec.ts` runs every one on all three.

```typescript
const { dialect: d } = features;

// Upserts that update the row in place on both engines (ON CONFLICT ... DO UPDATE)
await db.run(d.upsert('users', ['id', 'email', 'name'], ['?', '?', '?'], ['email']), [1, 'a@x.io', 'Ann']);
await db.run(d.insertOrReplace('users', ['id', 'name'], ['?', '?'], 'id'), [1, 'Ann']);
await db.run(d.insertOrIgnore('users', ['id', 'name'], ['?', '?']), [1, 'Ann']);

// Times: now() and arithmetic in exact seconds, buckets as ISO 8601 UTC text
const recent = `created_at > ${d.addInterval(d.now(), -7, 'days')}`;
const perDay = `SELECT ${d.dateBucket('day', 'created_at')} AS day, count(*) AS n FROM events GROUP BY 1`;

// Matching and membership
const byName = `${d.ilike('name', '?')}`;                    // ILIKE / LIKE
const someIds = d.inList('id', ['?', '?']);                  // an empty list matches nothing
const idsFromArray = d.inArray('id', '?');                   // bind one JavaScript array
const tagged = d.jsonArrayContains(d.jsonExtractAs('doc', '$.tags', 'json'), '?');

// JSON values with a type, from a checked path
const count = d.jsonExtractAs('doc', '$.stats.count', 'integer');

// Locks: FOR UPDATE ... and pg_advisory_xact_lock on PostgreSQL, nothing on SQLite
const lock = d.advisoryTransactionLock('?');
const claim = `SELECT id FROM jobs WHERE state = 'queued' LIMIT 1${d.rowLock('update', 'skipLocked')}`;

// Values and DDL
const best = d.greatest('a', 'b', 'c');                      // NULLs skipped on both engines
const asInt = d.cast('?', 'integer');
const ddl = `CREATE TABLE notes (id ${d.columnType('uuid')} PRIMARY KEY DEFAULT (${d.uuid()}), body ${d.columnType('json')}, at ${d.columnType('timestamp')})`;
```

- `insertOrReplace` updates the existing row in place on SQLite as on PostgreSQL. `INSERT OR REPLACE` deletes the conflicting row first, which fires `ON DELETE` actions on its dependents and resets the columns the statement does not name.
- Times on SQLite are ISO 8601 UTC text with milliseconds (`2026-10-15T12:34:56.789Z`), the form a bound `Date` takes, so text comparisons order correctly; on PostgreSQL they are `timestamptz`. `addInterval` takes seconds, minutes, hours and days, as exact seconds on both engines; months and years are left out because the engines clamp a month's end differently.
- SQLite's LIKE folds only ASCII letters. `jsonArrayContains` compares elements as text, so strings and numbers match on both engines.
- Column values follow each engine: a PostgreSQL `BOOLEAN` returns `true` and the SQLite `INTEGER` returns `1`, and a `TIMESTAMPTZ` returns a `Date` where SQLite returns text. `typeParsers` (see "Values") narrows the PostgreSQL side.
- `pragma()` returns null on PostgreSQL and `advisoryTransactionLock()` returns null on SQLite: skip the statement when it is null.

### IFullTextSearch — FTS5, FTS4 & tsvector

`createStorageFeatures` gives each engine the full-text search it has:
- FTS5 on better-sqlite3;
- FTS4 on sql.js and IndexedDB, whose stock sql.js build compiles FTS3 and FTS4 and no FTS5;
- a tsvector column with a GIN index on PostgreSQL, the Supabase adapter included. (`SupabaseAdapter` is deprecated: reach Supabase with `createPostgresAdapter({ connectionString })`, which gives it the same features.)

The same calls return the same rows on all three, and `tests/fts.parity.spec.ts` runs them on each.

```typescript
const { fts } = features;

// FTS5 or FTS4 virtual table (SQLite), or a _tsv column with a GIN index (PostgreSQL)
await db.exec(fts.createIndex({
  table: 'docs_fts',
  columns: ['title', 'body'],
  contentTable: 'documents',
  tokenizer: 'porter ascii',
  weights: { title: 'A', body: 'C' },   // PostgreSQL ranks with them; SQLite ignores them
}));
await db.exec(fts.rebuildCommand('docs_fts'));

// The best match first on every engine; a named placeholder binds once wherever it appears
const rows = await db.all(
  `SELECT t.id FROM ${fts.joinClause('documents', 't', 'docs_fts', 'docs_fts')}
   WHERE ${fts.matchClause('docs_fts', '@q')} ORDER BY ${fts.relevanceOrder('docs_fts', '@q')}`,
  { q: fts.sanitizeQuery(userText) },
);
```

- **Ordering.** `relevanceOrder` orders best first everywhere. `rankExpression` keeps each engine's own direction: FTS5's `rank` is lower-better, FTS4's `length(offsets())` and PostgreSQL's `ts_rank` are higher-better.
- **Queries.** `sanitizeQuery` turns text into its words, quoted and joined with OR, on every engine. PostgreSQL reads queries with `websearch_to_tsquery`: words are ANDed, and `or`, `-word` and quoted phrases work as in a search box.
- **One index, many features objects.** On PostgreSQL, `createIndex` records each index's table, columns, language and weights for the whole process, so a features object made later syncs, rebuilds and queries an index another one created, and each index keeps its own language. Run `createIndex` (it is idempotent) in each process before `syncInsert` or `rebuildCommand`.
- **Aliases.** On SQLite, alias the index as itself in `joinClause` (or pass the alias as `indexName` to `matchClause`), since a MATCH names the table as the query writes it.


### IBlobCodec — Cross-Platform Binary Encoding

```typescript
const { blobCodec } = features;

// Encode a float vector for storage
const blob = blobCodec.encode([0.1, 0.2, -0.5, 1.0]);
await adapter.run('INSERT INTO embeddings (vec) VALUES (?)', [blob]);

// Decode a stored vector
const row = await adapter.get<{ vec: Uint8Array }>('SELECT vec FROM embeddings WHERE id = ?', [id]);
const vector = blobCodec.decode(row!.vec);

// Cross-platform SHA-256
const hash = await blobCodec.sha256('content to hash');
```

### IDatabaseExporter — Portable Backups

```typescript
const { exporter } = features;

// Export to file (VACUUM INTO on SQLite, pg_dump on Postgres)
await exporter.exportToFile('/backups/snapshot.db');

// Export to bytes (for browser download or cloud upload)
const bytes = await exporter.exportToBytes();
```

On Postgres, `features.exporter` requires a Node runtime plus an adapter that was created with a connection string in `adapter.options.connectionString`, since `pg_dump` runs out-of-process.

## CI, Releases, and Badges

- GitHub Actions workflows:
  - `ci.yml` runs on pushes and pull requests to `master`: lint, type check, tests with coverage and the build, then it packs the package, installs the tarball into a new ES module project and type-checks a consumer with `--module nodenext --moduleResolution nodenext`. The job starts a PostgreSQL 16 service, and the specs that need a server read its URL from `POSTGRES_TEST_URL`.
  - `release.yml` publishes new versions to npm, tags the commit (`vX.Y.Z`), and creates/updates the GitHub Release when `CHANGELOG.md` and `package.json` bump the version.
- Check badge health whenever builds fail:
  - CI badge should be green for `master`.
  - Codecov badge updates after coverage reports upload.
  - npm badge reflects the latest published version.
- Manual verification commands:
  ```bash
  npm info @framers/sql-storage-adapter version
  pnpm --filter sql-storage-adapter test
  pnpm --filter sql-storage-adapter build
  ```
- See [RELEASING.md](./RELEASING.md) for the automated release flow, required secrets (`NPM_TOKEN`), and manual fallback steps.

 

## Contributing

- Read [CONTRIBUTING.md](./CONTRIBUTING.md) for coding standards, lint/test commands, and pull request guidelines.
- Architecture notes live in [ARCHITECTURE.md](./ARCHITECTURE.md); API docs can be regenerated with `pnpm --filter sql-storage-adapter run docs`.

## License

[MIT](./LICENSE)

---

<p align="center">
  Built and maintained by <a href="https://frame.dev" target="_blank" rel="noopener"><strong>Frame.dev</strong></a>
</p>

## Links
- Website: https://frame.dev
- AgentOS: https://agentos.sh
- Marketplace: https://vca.chat
- GitHub: https://github.com/framerslab/sql-storage-adapter
- npm: https://www.npmjs.com/package/@framers/sql-storage-adapter
## Contributing & Security
- Contributing: ./\.github/CONTRIBUTING.md
- Code of Conduct: ./\.github/CODE_OF_CONDUCT.md
- Security Policy: ./\.github/SECURITY.md
