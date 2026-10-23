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
- [Mutation Sync](#mutation-sync)
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
- **Browser-friendly** – `./browser` imports no Node built-in and no pg, and the `browser` field of `package.json` maps `async_hooks`, which the better-sqlite3 adapter loads only when it opens on Node, to an empty module in a page that bundles the root entry.
- **Mobile/Offline Parity** – Same APIs work across desktop, mobile (Capacitor), and browser with automatic sync support.
- **🆕 SQL Dialect** – Write cross-platform SQL with `SqlDialect` interface. Automatically translates `INSERT OR IGNORE`, `json_extract`, `ifnull`, `PRAGMA` between SQLite and PostgreSQL.
- **🆕 Full-Text Search** – `IFullTextSearch` interface abstracts FTS5 (SQLite) and tsvector/GIN (PostgreSQL) with unified `createIndex`, `matchClause`, `rankExpression`, and `rebuildCommand` APIs.
- **🆕 BLOB Codec** – `IBlobCodec` for cross-platform binary vector storage. `NodeBlobCodec` (Buffer) for server, `BrowserBlobCodec` (DataView) for web.
- **🆕 Database Export** – `IDatabaseExporter` with `SqliteFileExporter` (VACUUM INTO) and `PostgresExporter` (pg_dump).
- **CI-first design** – Vitest coverage, Codecov integration, and GitHub Actions workflows for linting, testing, releasing, and npm publish/tag automation.

## Installation

```bash
# Core package: brings pg (PostgreSQL) and sql.js (WASM SQLite, and IndexedDB)
npm install @framers/sql-storage-adapter

# Install only the other engines you plan to use
npm install better-sqlite3            # Native SQLite for Node/Electron
npm install @capacitor-community/sqlite  # Capacitor / mobile
```

`pg` and `sql.js` are dependencies of the package, listed once each, so they install with it. `better-sqlite3`, `@capacitor-community/sqlite`, `electron` and `@aws-sdk/client-s3` are optional peers: install the ones you use.

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
| `./sync`, `./kv`, `./types` | Cross-platform sync and the mutation sync, the key-value store, the types |
| `./browser` | What a page needs, in one entry: the IndexedDB adapter, the key-value module with its migration, the tab lock, and the mutation sync's client with its wire contract, transport, loop and change channel. Its modules import no Node built-in and no pg: the one package they import is sql.js |

Every entry has an `import` and a `require` condition. The CommonJS build under `dist/cjs` is made from the ES module build file by file, so a class has one identity whichever entry a caller takes it from. It carries its own declarations, so a CommonJS TypeScript consumer under `node16` resolution type-checks against them. CI packs the package, installs it in a new project and checks each of these: `require()` of every entry, what each server entry and `./browser` bundle, the preload, and that the CommonJS build repeats the `browser` field.

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
| `capacitor` | `@capacitor-community/sqlite` | Mobile (iOS/Android, Capacitor) | Native SQLite on mobile, WAL | Requires Capacitor runtime; the adapter opens databases unencrypted. See [Capacitor Notes](#capacitor-notes) |
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

## Mutation Sync

`@framers/sql-storage-adapter/sync` also holds a mutation sync for named text rows that a server and many browsers keep the same. A browser saves its rows with the mutations that make them in one transaction of its own database and never waits on the network. The server runs every client's mutations in one order, each push in one transaction that records the client's last mutation id, so a push sent again applies nothing twice, and settles each conflict by that order, keeping a differing value as a copy whose id every side derives alike. A pull streams the server's changes from one snapshot, and the browser replays what the server has not answered over them with the same functions the server runs. The protocol also recovers a browser after a restore of the server's database, keeps a value the server cannot read in the browser that has it, and checks that the server holds every row before a browser removes its own. The server's half (`MutationServer` over your own tables or the reference `createSqlMutationStore`, and `DrainGate`) is in `./sync`; the client's half (`MutationClient`, `createFetchMutationTransport`, `SyncLoop` and `createTabLock`) is in `./sync` and `./browser`. See [**guides/MUTATION_SYNC.md**](./guides/MUTATION_SYNC.md) for both halves, with an example server, its routes and a page.

## Configuration & Resolution

- `resolveStorageAdapter` inspects:
  - explicit options (`priority`, `type`, adapter configs),
  - environment variables (`STORAGE_ADAPTER`, `DATABASE_URL`),
  - runtime hints (Capacitor detection, browser globals, IndexedDB availability).
- Adapters are attempted in priority order until one opens successfully; a `StorageResolutionError` includes the full failure chain.
- The resolver builds `postgres`, `better-sqlite3`, `capacitor`, `indexeddb` and `sqljs`, and builds sql.js for `memory`. Any other kind (`electron-main`, `electron-renderer`, `supabase`, or an unknown name, from `priority` or `STORAGE_ADAPTER`) fails as a candidate with an error that names it, and the next candidate is tried.
- On Node, `createDatabase({ url })` and `createDatabase({ postgres })` open PostgreSQL when the options name a server: a `pool` of your own, a `postgres://` or `postgresql://` URL or connection string, or a host, database or user. Every Postgres option (pool size, SSL, timeouts, application name, or host, port, database, user and password without a connection string) is passed on, and there is no fallback to SQLite. A connection string of another scheme names no server (`file:./dev.db`, which `DATABASE_URL` holds in a project that runs SQLite through Prisma, or `sqlite:...`), and neither does an empty or unset one: the local default opens, or, with `strict`, the call fails. For a `socket:` URL or a socket path, pass `type: 'postgres'` or use `connectDatabase()`. `DATABASE_URL` in the environment does not change what `createDatabase()` picks; `resolveStorageAdapter()` without a `priority` tries Postgres first when it is set.
- In a browser, `createDatabase()` keeps the database in IndexedDB (`['indexeddb', 'sqljs']`, sql.js in memory where IndexedDB cannot open), whatever the Postgres options say; `createDatabase({ file: ':memory:' })` and `createMemoryDatabase()` keep sql.js in memory. In a Capacitor app on a phone it chooses `['capacitor', 'indexeddb', 'sqljs']`, as the resolver does. On Deno it opens sql.js. `indexedDb` options (`dbName`, `durability`, `crossTab` and the rest) reach the IndexedDB adapter whole.
- **Behaviour changes in patch releases.** Through 0.6.13, `createDatabase({ url })` and `createDatabase({ postgres: { connectionString } })` with no `priority` or `type` opened the SQLite file `db_data/app.sqlite3` under the working directory on Node, whatever the URL said. Since 0.6.14 a `postgres://` or `postgresql://` URL opens PostgreSQL, with no fallback to that file. A caller whose data is in that file passes `priority: ['better-sqlite3', 'sqljs']` or `type: 'sqlite'` to keep opening it. From 0.6.14 through 0.8.2 a URL of any other scheme (`file:./dev.db`) chose PostgreSQL too and failed at start; it opens the local default again. `connectDatabase()` given no server throws, where versions through 0.8.2 opened `db_data/app.sqlite3` on Node.
- `connectDatabase()` opens PostgreSQL alone, in every runtime, from any connection string pg reads, from a `pool` of your own, or from options with a host, database or user; a server it cannot reach fails the call. Given no server, as `connectDatabase(process.env.DATABASE_URL)` is with the variable unset, it throws before it opens anything: the function is for a remote database, and data meant for one does not land in a local file. It does not read `DATABASE_URL` on its own.
- `strict: true` (on `createDatabase` and `resolveStorageAdapter`) is for servers: only the database the options name opens. A postgres candidate that fails ends resolution with a `StorageResolutionError`, whatever `priority` lists after it; with `DATABASE_URL` or Postgres options that name a server and no `priority`, `['postgres']` is the whole list; an explicit file path (`file`, `filePath`) outranks `DATABASE_URL`; and a `url` or `postgres` option that names no server fails instead of opening the local default, unless a file is given. Without `strict`, `resolveStorageAdapter()` falls back from a failed Postgres to better-sqlite3, IndexedDB and sql.js, and `DATABASE_URL` comes before a `filePath`.
- `foreignKeys` (on `createDatabase`, or in `openOptions` for the resolver and `open()`) sets SQLite's foreign-key enforcement when a SQLite adapter opens: `true` turns it on and `false` off, on better-sqlite3, sql.js, IndexedDB and Capacitor. On sql.js and IndexedDB it holds across the saves, exports and imports that reopen the connection, as a `PRAGMA foreign_keys` statement run later does (see [What a sql.js Save Keeps](#what-a-sqljs-save-keeps)). Left out, each engine keeps its default, and the defaults differ: better-sqlite3 enforces foreign keys (it is built with `SQLITE_DEFAULT_FOREIGN_KEYS=1`, per its [compilation options](https://github.com/WiseLibs/better-sqlite3/blob/v13.0.3/docs/compilation.md)), and so does Capacitor, whose plugin turns them on when it opens a database ([Android](https://github.com/capacitor-community/sqlite/blob/v8.1.1/android/src/main/java/com/getcapacitor/community/database/sqlite/SQLite/Database.java#L282-L284), [iOS](https://github.com/capacitor-community/sqlite/blob/v8.1.1/ios/Plugin/Database.swift#L170-L173), [Electron](https://github.com/capacitor-community/sqlite/blob/v8.1.1/electron/src/electron-utils/utilsSQLite.ts#L63)), while sql.js and IndexedDB do not, as SQLite leaves [foreign keys off by default](https://www.sqlite.org/foreignkeys.html#fk_enable). Until a product passes `foreignKeys`, the same schema behaves differently per engine. Pass `foreignKeys: true` for the same behaviour everywhere. PostgreSQL always enforces foreign keys and ignores the option.
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

The PostgreSQL adapter runs each transaction on its own pooled connection, so transactions run side by side. When the connection breaks during a transaction and its ROLLBACK fails too, `transaction()` still throws the transaction's own error (the callback's, or COMMIT's), with the ROLLBACK error on it as a non-enumerable `rollbackError` property. An error aborts a PostgreSQL transaction, and PostgreSQL answers the COMMIT of an aborted transaction with ROLLBACK and no error of its own ([utility.c](https://github.com/postgres/postgres/blob/REL_18_STABLE/src/backend/tcop/utility.c#L633-L640)), so when a statement in the callback fails and the callback catches its error and goes on, nothing of the transaction is written, and `transaction()` rejects. A statement that may fail inside a transaction runs under a savepoint of its own, as `batch()` runs each operation. The broken connection is closed, not returned to the pool. A connection the server closes while a callback holds it, between statements, does not end the process. Once a transaction has ended, its handle runs on the pool, as the adapter's own statements do, and its `transaction()` begins a new transaction.

### Batches

`batch(operations)` runs its operations in one transaction and goes on past one that fails, on better-sqlite3 and PostgreSQL (`capabilities.has('batch')`):

```typescript
const result = await db.batch([
  { statement: 'INSERT INTO tags (id, name) VALUES (?, ?)', parameters: [1, 'red'] },
  { statement: 'INSERT INTO tags (id, name) VALUES (?, ?)', parameters: [1, 'red again'] }, // the id is taken
  { statement: 'INSERT INTO tags (id, name) VALUES (?, ?)', parameters: [2, 'blue'] },
]);
// { successful: 2, failed: 1, results: [...], errors: [{ index: 1, error }] }
```

- The operations that succeed commit together.
- An error aborts a PostgreSQL transaction until it rolls back to a savepoint ([Transactions](https://www.postgresql.org/docs/current/tutorial-transactions.html)), so the PostgreSQL adapter runs each operation under a savepoint and rolls back to it when the operation fails ([ROLLBACK TO SAVEPOINT](https://www.postgresql.org/docs/current/sql-rollback-to.html)).
- When the transaction itself fails (its BEGIN or COMMIT), nothing commits, and the result reports every operation failed, with the error at index -1.
- A transaction handle's `batch()` runs in that transaction, and its operations commit or roll back with it. On a held PostgreSQL connection (`withConnection`), `batch()` runs in a transaction of its own.

### SQL functions

`registerFunction(name, fn, { deterministic })` on the better-sqlite3, sql.js and IndexedDB adapters makes a JavaScript function callable from SQL:

```typescript
db.registerFunction('slugify', (title) => String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-'), { deterministic: true });
const rows = await db.all('SELECT slugify(title) AS slug FROM posts');
```

- The name must be an identifier: letters, digits and underscores.
- The function takes as many arguments as it declares (`fn.length`), on both engines, so a rest parameter declares none ([better-sqlite3](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md#functionname-options-function---this), [sql.js](https://github.com/sql-js/sql.js/blob/v1.15.0/src/api.js#L1282)).
- sql.js drops its functions when `export()` closes and reopens the connection ([source](https://github.com/sql-js/sql.js/blob/v1.15.0/src/api.js#L1115)): a save to a file, an IndexedDB save, `exportDatabase()` and `importDatabase()`. The sql.js and IndexedDB adapters register them again after each reopening.
- `deterministic: true` tells better-sqlite3 that the function returns the same result for the same arguments, which SQLite requires of a function in an expression index, a partial index's WHERE clause or a generated column ([SQLite](https://www.sqlite.org/deterministic.html)). sql.js registers every function as non-deterministic.
- The better-sqlite3 adapter must be open; the sql.js and IndexedDB adapters keep a function registered before `open()` and register it when they open.

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

A segment name is lower-case letters, digits and underscores, starts with a letter or an underscore, and has at most 63 characters; it is not `public`, `information_schema` or a name beginning with `pg_`. A name outside that is refused before any adapter is tried, whether it is given to `createDatabase()` or `resolveStorageAdapter()` or in their `postgres`, `indexedDb` or `capacitor` options. `segment` goes on `createDatabase()`, `resolveStorageAdapter()` and each adapter's own options, and `segmentName()` and `segmentFilePath()` give the name a segment's database or file has.

A `segment` on `createDatabase()` or `resolveStorageAdapter()` applies to every adapter they try. A segment in the options of one adapter (`postgres: { segment }`) applies to that adapter, and to each local adapter (better-sqlite3, sql.js, IndexedDB, Capacitor) tried after it whose options name none: without `strict`, a PostgreSQL that cannot be reached falls through to a local file in the same segment (`app-agentos.sqlite3`), never to the file every user shares. A PostgreSQL adapter opens in the segment of its own options or of `createDatabase()` and `resolveStorageAdapter()` alone: a segment in `indexedDb` or `capacitor` names a browser's or a device's database, and a server tried after it keeps the schemas its own options choose, a pool of your own included. An adapter tried before it is left as it is.

On PostgreSQL:

- The `search_path` is a startup option of each connection, so a connection the pool opens to replace one the server ended starts in the segment too, and `RESET search_path` and `DISCARD ALL` return to it. `PGOPTIONS` is kept beside it. A connection string that sets its own `options` parameter is refused with a segment, since pg would send it in place of the segment's.
- `public` stays on the path, so the types, functions and operators of extensions installed there resolve in every segment: pgvector's `vector` and `<->`. A `CREATE EXTENSION` that names no schema installs the extension into `public`, as it would without a segment, instead of into the segment, where no other segment and not the host would find it. When an extension a segment asks for is already installed in another segment's schema, the adapter warns once and names the `ALTER EXTENSION ... SET SCHEMA public` that moves it.
- A name the segment does not hold falls through to `public`. Create a segment's tables before reading them (`CREATE TABLE IF NOT EXISTS` creates the table in the segment even when `public` has one of that name), and name the schema in a `DROP` or `ALTER` that `public` could also answer.
- `open()` checks that the segment is the current schema of its first connection, and fails when it is not. PostgreSQL leaves a schema the role has no `USAGE` privilege on out of the `search_path` without a word, so on an existing schema another role made, the segment's statements would otherwise read and create tables in `public`; a pooler that drops startup options leaves the segment out the same way. The role needs `USAGE` and `CREATE` on the segment's schema.
- `exportData()` exports the tables of the current schema: the segment's, or `public` without one. `createStorageFeatures(adapter).exporter` dumps the segment's schema alone (`pg_dump --schema`).
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

`ensureColumnExists(db, table, column, definition)` adds a column when the table lacks it, on PostgreSQL and SQLite, and resolves `true` when it added the column, `false` when the table had it:

```typescript
import { ensureColumnExists } from '@framers/sql-storage-adapter';

await ensureColumnExists(db, 'notes', 'archived_at', 'TEXT');
await ensureColumnExists(db, 'app.notes', 'pinned', 'BOOLEAN NOT NULL DEFAULT false'); // schema-qualified, PostgreSQL only
```

The table and column must be identifiers (letters, digits and underscores); the definition is SQL, written for the engine. PostgreSQL reads `information_schema.columns` and adds the column with `ADD COLUMN IF NOT EXISTS`; SQLite reads `pragma_table_info`. Names are matched as PostgreSQL folds unquoted names, in lower case.

### Copying data between engines

`migrateAdapter(source, target, options)` copies tables and rows from one adapter to another, on one engine or between SQLite and PostgreSQL. `exportData()` and `importData()` are its two halves, and `migrateAdapters()`, `cloneAdapter()` and `createBackup()` run on them.

```typescript
import { migrateAdapter } from '@framers/sql-storage-adapter';

const sqlite = await createDatabase({ file: './app.db' });
const postgres = await createDatabase({ url: process.env.DATABASE_URL });

const result = await migrateAdapter(sqlite, postgres);
// { success, tablesImported, rowsImported, errors?, warnings?, duration }
```

What the target table gets:

| Source column | PostgreSQL target | SQLite target |
|---|---|---|
| SQLite `INTEGER PRIMARY KEY`, PostgreSQL identity or serial | `INTEGER GENERATED BY DEFAULT AS IDENTITY` (or `BIGINT` when copied ids exceed INTEGER) (a PostgreSQL identity keeps its type and `ALWAYS`) | `INTEGER PRIMARY KEY AUTOINCREMENT` |
| integers | `INTEGER`, or `BIGINT` when a copied value is outside `INTEGER`'s range | `INTEGER` |
| PostgreSQL `NUMERIC`, `DECIMAL` | exact source type | `TEXT` to preserve decimal precision |
| `REAL`, `DOUBLE`, `FLOAT` | `DOUBLE PRECISION` | `REAL` |
| `BOOLEAN` | `BOOLEAN` | `INTEGER` |
| `DATETIME`, `TIMESTAMP` | `TIMESTAMPTZ` | `TEXT` |
| `DATE`, `TIME` | `DATE`, `TIME` | `TEXT` |
| `JSON`, arrays | `JSONB` | `TEXT` |
| `BLOB` | `BYTEA` | `BLOB` |
| text, `UUID`, others | `TEXT`, `UUID`, `NUMERIC` by SQLite's affinity rules | `TEXT` |

- **SQLite foreign keys.** Imports suspend enforcement while loading, report `foreign_key_check` violations, and restore the original setting even on failure. Import outside an active transaction so SQLite can change enforcement.
- **Same engine.** SQLite to SQLite runs the `CREATE TABLE` statement SQLite keeps for the table, so its keys, `AUTOINCREMENT`, constraints and generated columns come along. SQLite copies and SQL dumps also carry the AUTOINCREMENT high-water mark, including deleted ids and empty tables. PostgreSQL to PostgreSQL keeps each type as `format_type` names it (`character varying(20)`, `numeric(10,2)`, `integer[]`), and regenerates stored and PostgreSQL 18 virtual columns from their expressions. Virtual definitions require PostgreSQL 18 or later on the target.
- **Keys and NOT NULL.** The primary key and NOT NULL carry over between engines, including exports by a PostgreSQL role with only SELECT permission. Other constraints and indexes do not; create them with your schema migrations.
- **Array and numeric defaults.** PostgreSQL empty-array defaults become JSON `[]` on SQLite; other array defaults are omitted with a warning. PostgreSQL NUMERIC values and literal defaults become text so SQLite numeric affinity cannot round them. SQLite `strftime('%S','now')` keeps seconds within the minute; `%s` keeps epoch seconds.
- **Defaults.** Compatible literals carry over; `true` and `false` become 1 and 0 on SQLite and for numeric PostgreSQL columns. Invalid or unrecognized SQLite calendar defaults are omitted with a warning, and the current-time defaults map to the target engine's (`CURRENT_TIMESTAMP` and `datetime('now')` to `CURRENT_TIMESTAMP` on PostgreSQL; `now()` to the ISO `strftime` on SQLite). A default with no form on the target engine is left off, and `warnings` names it.
- **Ids.** Explicit id columns keep their values. SQLite FTS rowids are included so external-content indexes keep pointing to the same rows. Implicit rowids of ordinary tables are not preserved; use an explicit INTEGER PRIMARY KEY for stable references. On PostgreSQL each identity or serial column that took ids has its sequence moved past the largest one without lowering its existing allocation ([setval](https://www.postgresql.org/docs/current/functions-sequence.html)). A target table that already exists is written as it is, and an identity `GENERATED ALWAYS` takes the ids through `OVERRIDING SYSTEM VALUE` ([INSERT](https://www.postgresql.org/docs/current/sql-insert.html)).
- **Sequence state.** Run imports and sequence synchronization while writers are stopped. PostgreSQL synchronization may leave gaps; custom descending or cycling sequences are not preserved. SQLite AUTOINCREMENT high-water marks are restored for SQLite targets.
- **Timestamps.** Text without a zone, as SQLite's `CURRENT_TIMESTAMP` writes it in UTC ([SQLite](https://www.sqlite.org/lang_createtable.html#dfltval)), goes into a `TIMESTAMPTZ` column as UTC, where PostgreSQL would read it in the session's time zone ([PostgreSQL](https://www.postgresql.org/docs/current/datatype-datetime.html)).
- **Views.** Views explicitly named in `tables` are read in one query and imported as ordinary tables containing their current rows; view definitions are not recreated.
- **SQL dumps.** PostgreSQL inserts use `OVERRIDING SYSTEM VALUE` for existing ALWAYS identities. `includeSchema: false` omits DDL while retaining type-aware literals, generated-column omission and sequence synchronization.
- **JSON.** PostgreSQL JSON arrays, objects and scalars are encoded as JSON for imports and SQL dumps, including string, number and boolean scalars.
- **Conflicts.** `onConflict: 'ignore'` and `'replace'` use `INSERT OR IGNORE` and `INSERT OR REPLACE` on SQLite, and `ON CONFLICT DO NOTHING` and `ON CONFLICT (primary key) DO UPDATE` on PostgreSQL. On PostgreSQL, replacement keeps an existing ALWAYS identity outside the key; new rows still take explicit identity values. `rowsImported` counts the rows written. Insert failures not handled by the SQL conflict clause are reported in `errors`, including under `ignore` and `replace`.
- **Options.** `columnTypes: { 'events.at_ms': 'BIGINT' }` sets a column's type. `sourceDialect` names the source engine for an export made before `ExportedData.dialect` recorded it. Exports preserve PostgreSQL `DATE` and zone-less `TIMESTAMP` as local calendar text, so the day and clock time do not shift with the process time zone. Zoned timestamps keep their UTC instant.

`syncIdentitySequence` is optional on `SqlDialect` so existing custom implementations remain compatible; call it conditionally. Built-in dialects implement it.

The identity column the dialect writes refuses an id an insert gives, as PostgreSQL's `GENERATED ALWAYS` does. `autoIncrementPrimaryKey({ acceptExplicitIds: true })` writes one that takes it, and `syncIdentitySequence(table, column)` gives the statement that moves the sequence past the inserted ids (null on SQLite, which follows the largest id by itself):

```typescript
const d = createStorageFeatures(db).dialect;
await db.exec(`CREATE TABLE tags (id ${d.autoIncrementPrimaryKey({ acceptExplicitIds: true })}, label TEXT)`);
await db.run('INSERT INTO tags (id, label) VALUES (?, ?)', [41, 'imported']);
const sync = d.syncIdentitySequence?.('tags', 'id') ?? null;
if (sync) await db.get(sync);
```

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

The logger takes the lines of the resolver, the PostgreSQL and sql.js adapters, the schema-migration runner and the adapter base class. The IndexedDB, Capacitor, sync and Electron modules write to the console directly.

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

### sql.js Saves to a File

```typescript
import { SqlJsAdapter } from '@framers/sql-storage-adapter';

const db = new SqlJsAdapter();
await db.open({ filePath: './data/app.sqlite3' });                 // loads the file, and saves to it
await db.exec('CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, text TEXT NOT NULL)');
await db.run('INSERT INTO notes (text) VALUES (?)', ['kept']);     // in the file when this resolves
```

With a `filePath` on Node, the sql.js adapter writes the whole database image to the file after each write, once SQLite has no transaction open:

- a statement through `run()`, and a script through `exec()`, the statements before a failure included;
- a statement through `all()` or `get()` that can write, by the rule the IndexedDB adapter saves by: anything but a `SELECT`, `VALUES` or `EXPLAIN`, where a `WITH` statement, or a `PRAGMA` that writes no header field or file setting, counts when it changed rows. `INSERT ... RETURNING` and `PRAGMA user_version = 3` are saved, `PRAGMA table_info(notes)` and `PRAGMA foreign_keys = ON` are not;
- the end of a `transaction()`.

While SQLite has a transaction open, whatever began it (`transaction()`, `BEGIN` or `SAVEPOINT` through `run()`, or a script such as `BEGIN; INSERT ...`), nothing is saved: sql.js's export closes and reopens the connection, which would roll the transaction back. The save after its `COMMIT` or `RELEASE` writes it, and a script that ends it (`INSERT ...; COMMIT`) is saved. `close()` rolls back a transaction still open, saves the committed state and closes; a second `close()` made meanwhile waits for the first.

### What a sql.js Save Keeps

The sql.js adapter's saves to its file, and the IndexedDB adapter's saves, `exportDatabase()` and `importDatabase()`, go through sql.js's [`export()`](https://github.com/sql-js/sql.js/blob/v1.15.1/src/api.js#L1111-L1123), which closes the connection and opens it again. The adapters read the connection's PRAGMA settings first and set them again on the reopened connection: `foreign_keys`, `recursive_triggers`, `ignore_check_constraints`, `legacy_alter_table`, `reverse_unordered_selects`, `trusted_schema`, `automatic_index`, `cell_size_check`, `secure_delete`, `cache_size`, `cache_spill`, `temp_store`, `synchronous`, `journal_mode`, `busy_timeout` and `query_only`. Each holds as it would on a connection that is never reopened, whether `open()` set it (`foreignKeys`) or a statement did later (`PRAGMA foreign_keys = OFF` around a table rebuild). An imported database takes them too, and the functions `registerFunction()` made are registered again (see [SQL functions](#sql-functions)).

The rest of the connection's state does not survive a save, an export or an import:

- PRAGMA settings outside that list, and `PRAGMA case_sensitive_like`, which cannot be read back;
- TEMP tables, views, indexes and triggers;
- attached databases;
- functions registered on the underlying sql.js database itself, outside `registerFunction()`.

These are limits of sql.js: it reads the database image only by closing the connection, and its build [exports](https://github.com/sql-js/sql.js/blob/v1.15.1/src/exported_functions.json) no `sqlite3_serialize`. The adapters warn once when a save drops TEMP objects: the sql.js adapter through the host logger, the IndexedDB adapter on the console. Keep such state in the main database, or create it again after a save.

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

**Durability.** With `durability: 'interval'`, the default, the auto-save tick stores the writes made since the last save every `saveIntervalMs`, and a write can be lost when the page goes before the next tick. With `durability: 'commit'`, `run()`, `exec()`, a write through `all()` or `get()` (`INSERT ... RETURNING`, or a PRAGMA that sets `user_version`, `application_id`, `schema_version`, `default_cache_size`, `page_size`, `auto_vacuum` or `encoding`, read as SQLite reads it, a comment between two of its words or a name in single quotes included), `transaction()` and `importDatabase()` resolve once their write is in IndexedDB, committed there (the IndexedDB transaction's `complete` event, not the put request's success), and reject when IndexedDB refuses or aborts it; the write stays in the database and the next save stores it, unless `crossTab`'s `rollbackRefusedSaves` gives it up (below). Each save writes the whole database image, so batch many writes in one `transaction()`. While a transaction begun with `BEGIN` is open nothing can be saved: its statements resolve at once, and its rows are stored when its `COMMIT` resolves. `flush()` stores every write made so far in either mode: it waits for an open `transaction()`, and rejects while a transaction begun with `BEGIN` is open, which sql.js's export would end.

**Several tabs.** Each tab holds the whole database in memory and writes it back whole, so without coordination the tab that saves last overwrites the other's writes. With `crossTab`, every statement and transaction runs under a [Web Lock](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API) on the database, on the newest stored image (a tab reloads it when a version stamp stored beside the image says another tab has saved), and is stored before the lock is let go: `durability` is `'commit'` whatever it says, and a tab reads what another tab stored. A transaction holds the other tabs' statements until it commits or rolls back. A transaction begun with `BEGIN` through `run()` or `exec()` cannot be held across tabs: it is rolled back and refused, so use `transaction()`. Web Locks need a secure context and are in Chrome 69, Firefox 96 and Safari 15.4 and later (on WebKit the feature is on by default and off in Lockdown Mode). Where there are none, the version stamp alone keeps both tabs' writes: a statement that finds another tab saved first runs again on that tab's image, and a `transaction()` another tab saved over is refused with `IndexedDbConflictError`, storing nothing of it, for its caller to run again. The adapter says once when it runs without Web Locks. A tab running a version of this package before 0.7 writes no stamp, so a tab with `crossTab` does not see its saves.

**When it saves:** every `saveIntervalMs`, the adapter writes the database image to IndexedDB if anything changed. It skips the tick while a transaction is open, its own or one begun with `BEGIN`, because sql.js's export closes and reopens the connection, which would end the transaction; the next tick saves it once it has committed. A save counts as done when IndexedDB commits it, not when the put request succeeds. A save that fails or aborts is reported once, and the next tick tries again. A write made while a save is in flight is saved by the next one. A transaction's commit marks its writes for saving, including writes made through `all()` or `get()` (`INSERT ... RETURNING`). Outside a transaction, a statement through `all()` or `get()` marks the database changed unless it is a `SELECT`, `VALUES` or `EXPLAIN`; a `WITH` statement, or a `PRAGMA` that writes no header field or file setting, does when it changed rows. `INSERT ... RETURNING` and `PRAGMA user_version = 3` are saved, `PRAGMA table_info(notes)` and `PRAGMA foreign_keys = ON` are not. `close()` rolls back a transaction still open and saves the committed state. `exportDatabase()` throws while a transaction is open.

**Importing:** `importDatabase()` checks the image before it replaces anything: it must start with the SQLite header and pass SQLite's [`quick_check`](https://www.sqlite.org/pragma.html#pragma_quick_check), which reads every page (an empty image imports as an empty database). sql.js opens any bytes, and a damaged page fails only the statement that reaches it, so without the check such an image would replace the database and be saved over the stored one. It throws on an image that fails, and the adapter keeps the database it had, in memory and in IndexedDB. The imported database replaces the current one once an open `transaction()` has ended and a save already running has finished, takes the connection's PRAGMA settings, and is saved to IndexedDB before the call resolves.

**What a save keeps:** the connection's PRAGMA settings, as [What a sql.js Save Keeps](#what-a-sqljs-save-keeps) lists them, and the functions `registerFunction()` made; TEMP tables, attached databases and functions registered on the sql.js database itself do not survive a save, an export or an import.

**Memory alone, and the stored image put back:**
- `memoryOnly: true` keeps the database in memory alone, for a browser that refuses IndexedDB (a private window, a blocked storage setting), where `open()` would otherwise reject: IndexedDB is never opened, nothing is stored, and `capabilities` carries no `persistence`. `durability` reads `'interval'` and `crossTab` is off, since there is nothing to store or to share; `flush()` and `close()` store nothing, and `exportDatabase()` and `importDatabase()` work on the image in memory.
- `reload()` puts the stored image in place of the one in memory, whatever the version stamp says, and resolves with whether anything changed: `true` when another connection stored a newer image since this one loaded or saved, or when this connection holds writes that are not stored (one IndexedDB refused, which a `durability: 'commit'` call reports by rejecting, or with `durability: 'interval'` one the auto-save has not stored yet), which are then gone; `false` when the memory image already is the stored one, and in memory-only mode. A caller whose commit was refused runs it before its next statement: the next save, under `crossTab` the next coordinated statement, would store the refused writes with its own. A connection without `crossTab` runs it to read what another connection stored; there, a `durability: 'commit'` write or a `flush()` still waiting for the save of a write it puts back rejects instead of resolving as stored. It waits for an open `transaction()` to end, holds statements while it runs, and refuses while a transaction begun with `BEGIN` is open.
- `crossTab: { rollbackRefusedSaves: true }` gives refused writes up inside the lock. A statement already waiting on the lock when a refusal reaches its caller runs before anything the caller's `catch` does under the lock, and without this option it stores the refused writes with its own, a read included, so a `reload()` in that `catch` comes too late. With it, when IndexedDB refuses a save made under the coordination (a statement's, a transaction's, an import's or `close()`'s), the adapter reads the stored image back in place of the one in memory before the next coordinated call runs, and the call still rejects. When IndexedDB cannot be read back either, no save stores the refused writes, and the next statement or transaction reads the stored image before it runs, failing while it cannot.

**Why IndexedDB Adapter vs sql.js Adapter?**

| Feature | IndexedDB Adapter | sql.js Adapter |
|---------|------------------|----------------|
| **SQL Engine** | sql.js (WASM) | sql.js (WASM) |
| **Persistence** | ✅ **Automatic** (saves to IndexedDB after writes) | ⚠️ **Manual** in a browser (call `db.export()` and save it yourself); ✅ **Automatic** on Node with a `filePath` (see [sql.js Saves to a File](#sqljs-saves-to-a-file)) |
| **Data survives refresh** | ✅ Yes | ❌ No in a browser (unless you saved the export); on Node, a reopened `filePath` holds every save |
| **Use Case** | Production PWAs, offline-first apps | Edge functions, temporary data, prototyping; a file-backed database on Node without native modules |

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

### Capacitor Notes

```typescript
import { createDatabase } from '@framers/sql-storage-adapter';

const db = await createDatabase({
  priority: ['capacitor', 'indexeddb'],
  mobile: { database: 'my-app', enableWal: true },
});
```

- The adapter opens its database through the plugin's `SQLiteConnection`, which every Capacitor adapter of the page shares, and `close()` closes the plugin's connection too, so the database opens again. The plugin keeps its connections across a reload of the page; `open()` closes one a reload left behind and makes it again.
- One adapter at a time holds a database: `open()` fails while another adapter of the page has the same database open. The plugin [drops a trailing `.db`](https://github.com/capacitor-community/sqlite/blob/v8.1.1/src/definitions.ts#L1453) from a database name, so `notes.db` and `notes` are one database.
- `enableWal` (default true) sends `PRAGMA journal_mode = WAL` through the plugin's `query()`, outside the transaction the plugin wraps `execute()` in, where SQLite [refuses to change the journal mode](https://www.sqlite.org/pragma.html#pragma_journal_mode), and warns when SQLite answers another mode.
- The plugin runs `execute()` and `run()` inside a transaction of its own, where SQLite [ignores `PRAGMA foreign_keys`](https://www.sqlite.org/pragma.html#pragma_foreign_keys) and refuses to change the journal mode, and on Android through SQLCipher's `execSQL` and compiled statements, which [fail on a statement that answers a row](https://github.com/sqlcipher/sqlcipher-android/blob/master/sqlcipher/src/main/jni/sqlcipher/android_database_SQLiteConnection.cpp) ("Queries can be performed using SQLiteDatabase query or rawQuery methods only"), as `PRAGMA journal_mode = WAL` does. So a `PRAGMA` in `run()`, or at the start or the end of an `exec()` script, goes through `query()` instead, outside that transaction. A script that turns foreign keys off, rebuilds a table and turns them on again runs as SQLite's procedure for changing a table expects. A `PRAGMA` between two other statements of a script stays inside the plugin's transaction.
- The plugin turns foreign keys on when it opens a database, so Capacitor enforces them by default; `foreignKeys: false` in the open options turns them off. The adapter sets the option through `query()` while it opens, and a failure there closes the plugin's connection and fails `open()`, leaving the adapter closed.

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
const page = await openIndexedDbStore({ dbName: 'app', storeName: 'kv' });
```

`KeyValueStore` has `get`, `set`, `delete`, `keys(prefix)` and `deletePrefix(prefix)`, and `memoryOnly`, true when nothing outlives the page or the process. `namespaced(store, prefix)` scopes a store to a prefix: end each prefix with a character no id holds (`ann/`, `anna/`), since the keys under `anna` are among those under `ann`.

- `openIndexedDbStore({ dbName, storeName, version })` keeps values in one IndexedDB object store with out-of-line keys. It opens the database at `version` (1 by default) and creates the object store only when the open upgrades the database, so a database another page made at that version is read in place. A browser that refuses IndexedDB gets the memory store, and `memoryOnly` says so. This is the store AgentOS's `src/core/storage/browser` held, moved unchanged: the same database, object store, version and keys.
- `createSqlKeyValueStore(adapter, { table })` keeps values in a table it makes when it is missing, with a `key` and a `value` column. Each call is one statement on the adapter, and through a transaction's handle it joins the transaction. Keys are listed in the order of their UTF-16 code units, as IndexedDB orders them, and a prefix is read literally (`%`, `_` and `*` are characters). Each value is kept as text and comes back as the structured clone, which IndexedDB applies to every value it stores, gives it back: `undefined`, `-0`, `NaN`, bigints, `Date`, `RegExp`, `Map`, `Set`, `ArrayBuffer`, typed arrays and `DataView`, boxed primitives, errors with their message, stack and cause, objects reached twice and cycles. A value the structured clone refuses (a function, a symbol, a `WeakMap`, a promise, a `Proxy`) is refused with a `DataCloneError` before anything is written, as are the host objects text cannot hold (`Blob`, `File`, `CryptoKey`). The text is written from the runtime's own `structuredClone` of the value, which alone tells a proxy apart from the object the proxy wraps, and which reads each property once, as IndexedDB's put does: a getter is read once, and its first answer is what is stored.
- `migrateIndexedDbKeyValue({ source, adapter, into })` moves one namespace of an old IndexedDB key-value store (the one `openIndexedDbStore` opens) into a `KeyValueStore` over an adapter, behind a marker, its old writers locked out by the database's version. It opens the old database at `source.lockVersion`, above the `fromVersion` its writers open it at, so their open fails from then on and `openIndexedDbStore` answers from memory; writes the records under `source.prefix`, without it, into the store `into(trx)` makes, with the marker `{ phase: 'copied' }` under `MIGRATION_MARKER`, in one transaction of the adapter; flushes an adapter that answers `flush()`, so one that stores on an interval holds the copy; deletes the old records; and marks the move `done`. It answers `migrated`, `already`, `none` (nothing under the prefix) or `blocked` (a tab holds the old version open, and nothing moved: run it again once that tab is closed). A reload resumes from the committed side, and two moves at once copy once. It refuses a store that keeps nothing past the page (`memoryOnly`: an adapter without `persistence`) before it opens the old database, so the old records are never deleted while their one copy is in memory. A call made while an earlier one waits on an old tab waits behind it, since IndexedDB runs a database's opens in order.
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

`createDatabase({ hooks })`, or `withHooks(adapter, hooks)` on any adapter, puts lifecycle hooks around each query, write, transaction and error.
- A `before` hook returns the context, changed or not, to go on, or undefined to stop the call. A stopped `get` returns null, `all` an empty list, and `run` no changes.
- `onAfterQuery` can replace the result.
- `onError` returns the error to throw, or undefined to swallow it.
- The statements inside a transaction pass through the hooks too, and `onAfterTransaction` sees `outcome: 'committed'` or `'rolled_back'`.
- The adapter keeps its kind, its own methods and its class.

`combineHooks()` and `filterHooks()` compose hook sets.

```typescript
import { createDatabase, combineHooks, type StorageHooks } from '@framers/sql-storage-adapter';

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

const db = await createDatabase({ url: process.env.DATABASE_URL, strict: true, hooks: combineHooks(myHooks) });
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

## Row-Change Events

`withChangeEvents(adapter)` reports each write made through the adapter, on every engine:

```typescript
import { createDatabase, withChangeEvents } from '@framers/sql-storage-adapter';

const db = withChangeEvents(await createDatabase());
const stop = db.onChange((change) => cache.invalidate(change.table), { tables: ['notes'] });
// change: { table: 'notes', operation: 'insert' | 'update' | 'delete', changes?, lastInsertRowid?, statement }

await db.run('UPDATE notes SET title = ? WHERE id = ?', ['Plans', 7]); // reports { table: 'notes', operation: 'update', changes: 1 }
stop();
```

- **What counts.** An INSERT (with `OR REPLACE`, `REPLACE` and upserts), UPDATE, DELETE or TRUNCATE, through `run()`, `batch()`, `get()`, `all()`, `exec()`, `transaction()` and, on PostgreSQL, `withConnection()`. A `WITH` clause before the statement and quoted or schema-qualified names are read as SQL reads them.
- **When.** At once outside a transaction; when `transaction()` commits inside one; not at all when it rolls back.
- **Counts.** `run()` and `batch()` give the engine's count and report only a statement that changed a row. `get()`, `all()` and `exec()` report the statement without a count.
- **Scope.** Writes made through this adapter. Another adapter, another process, prepared statements, and a transaction begun with `BEGIN` through `run()` (reported as its statements run) are outside it.
- **Listeners.** A listener that throws, or whose promise rejects, is logged through the host logger, and the write stands.

On PostgreSQL, `listen()` and `notify()` carry notifications between sessions ([LISTEN](https://www.postgresql.org/docs/current/sql-listen.html), [NOTIFY](https://www.postgresql.org/docs/current/sql-notify.html)), and the dialect's `changeNotificationSql(table, channel)` installs a statement-level trigger that sends one for each write to the table, from any session:

```typescript
const db = new PostgresAdapter(process.env.DATABASE_URL);
await db.open();
for (const statement of createStorageFeatures(db).dialect.changeNotificationSql('runs', 'run_changes') ?? []) {
  await db.exec(statement);
}
const stop = await db.listen('run_changes', (payload) => {
  const { schema, table, operation } = JSON.parse(payload); // operation: 'insert' | 'update' | 'delete'
});
await db.notify('run_changes', 'any text under 8000 bytes');
```

- One connection of the pool is held while any channel has a handler. When the server ends it, the adapter listens again on a new one after 1 second, then 2, up to 30, and logs it; notifications sent meanwhile are lost, since PostgreSQL keeps none for a session that is not listening.
- A notification arrives when the transaction that sent it commits. PostgreSQL delivers identical payloads sent on one channel in one transaction once, so the trigger sends one notification per table and operation per transaction.
- The channel name is exact, case included. `close()` stops every channel. SQLite has no notifications between connections: its `changeNotificationSql` returns null.

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
- **Opening an existing index.** On PostgreSQL, `createIndex` reads the catalog before it alters the table or creates the index, so an open that finds the `_tsv` column and the index takes no lock on the table beyond the backfill's ROW EXCLUSIVE, and does not queue behind a long read of the table such as an export. Run its script with `exec()`: it holds `DO` blocks, which a split on `;` would cut.
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

On Postgres, `features.exporter` runs `pg_dump` in its custom format, so it needs a Node runtime with `pg_dump` on the PATH, and an adapter whose database it can name: one made with a connection string, or with a host (a Unix-socket directory too), database and user, or with a `pg` `Pool`, or one given its connection string at `open()`. When an export runs, the exporter reads the connection of the pool the adapter runs on as pg reads it, and hands `pg_dump` a libpq URI that reaches the same server, database and user: a connection string's parts over the pool's other settings, then `PGHOST`, `PGPORT`, `PGUSER` and `PGDATABASE`, then localhost, 5432, the operating system's user, and the user's name for the database. A password function of the pool's is asked at each export as the pool asks it for each connection: through the `Client` the pool makes its connections with, which pg-pool keeps as the pool's `Client`, whose own routine calls the function as a method of a client made of the pool's settings, with no arguments before pg 8.19.0 and from 8.19.0 with the client's `ConnectionParameters`. So a pool made with another copy of pg than the one this library loads, or with a `Client` of its own, is asked as its own pg asks. That client is never connected, and it is made without the settings' `stream`, so a connector's socket function is not called. A pool whose `Client` has no such routine (pg's native one) is asked as the pg this library loads asks; where the exporter cannot read that pg's version or its `Client` either (a bundle that holds pg in itself), it calls the function on no client, with no arguments where the version it read is older than 8.19.0 and otherwise with the connection's user, database, host and port, and the storage logger says so once. Its answer goes to `PGPASSWORD`; a function that answers no password gives `pg_dump` an empty `PGPASSWORD` and a `passfile` that does not exist, since pg then connects with none and reads neither `PGPASSWORD` nor a password file, where libpq given an empty password reads `PGPASSFILE`'s file or `~/.pgpass`; and a function that fails or answers anything but a string or `undefined` refuses the export. A pool with no password leaves `PGPASSWORD`, then `~/.pgpass`, to `pg_dump`, as pg reads them. pg and libpq read some connection strings apart (an `@` in a parameter of a string with no path, a host left out), and the URI holds pg's reading: pg takes the database from the URL's path alone, so a `database` parameter is dropped, an empty `host` parameter leaves the URL's host, and the port is read with `parseInt`, so `5432x` is 5432 and a port of 0 gives way to `PGPORT`; a port pg reads no number in is refused before `pg_dump` starts. Of a connection string's parameters the URI holds the ones pg reads and libpq takes: `options`, `application_name`, `fallback_application_name`, `client_encoding`, `replication` and the certificate files. libpq's others, which pg does not read (`passfile`, `target_session_attrs`, `require_auth`, `channel_binding`, `gssencmode`, `connect_timeout`, `sslcrl` and the rest), are left out, so `pg_dump` reads the password file the pool reads and refuses no server, authentication or session the pool takes. The variables pg reads are read as pg reads them; libpq's own, which pg does not read (`PGHOSTADDR`, `PGSERVICE`, `PGREQUIRESSL`, `PGSSLROOTCERT` and the rest), configure `pg_dump` as they configure psql. Before the adapter opens, the exporter reads the settings of the pool the adapter will make, whose host and port default to localhost and 5432. A segmented adapter's export holds its segment's schema alone (`--schema`).

TLS follows pg's, and so does the check of the server. pg's TLS is Node's, which checks the server's certificate and its host name unless `rejectUnauthorized` is false. A pool that checks no certificate (`ssl: { rejectUnauthorized: false }`, pg's `no-verify`, and with `uselibpqcompat=true` `sslmode=prefer`, or `require` with no root certificate) gets `sslmode=require` over any `PGSSLMODE`, since `verify-ca` or `verify-full` would refuse the certificate pg accepts; libpq's `require` still checks the certificate against a root certificate file it finds (the connection string's `sslrootcert`, `PGSSLROOTCERT`, `~/.postgresql/root.crt`), so there `pg_dump` can refuse a server pg reaches. A pool that checks the certificate (`ssl: true`, `{}`, `ssl=1`, a certificate file or any other `sslmode` but `disable` in the connection string, or a `PGSSLMODE` pg reads as TLS) gets `sslmode=verify-full` over any `PGSSLMODE`, and `sslmode=verify-ca` where pg checks no host name (`uselibpqcompat=true` with `verify-ca`, or `require` beside a root certificate). libpq checks the certificate against the root certificate file the connection string names, which pg reads too, else the file `PGSSLROOTCERT` names, else the system's certificate authorities (`sslrootcert=system`: OpenSSL's default locations, which `SSL_CERT_FILE` and `SSL_CERT_DIR` move), where Node checks against the authorities it trusts by default (the Mozilla list it bundles, and `NODE_EXTRA_CA_CERTS`): an authority one trusts and the other does not is named in the connection string's `sslrootcert` or in `PGSSLROOTCERT`. libpq reads `sslrootcert=system` from PostgreSQL 16 on; an older one looks for a file named `system`, and the export fails, saying what to do. `uselibpqcompat=true` with `sslmode=verify-ca` and no root certificate is refused before `pg_dump` starts, as pg refuses it. A pool that chose no TLS (`ssl: false`, `ssl=0`, `sslmode=disable`) gets `sslmode=disable`, whatever `PGSSLMODE` says. Where no TLS is pg's default, libpq's default (`prefer`, TLS where the server offers it) and a `PGSSLMODE` of `disable` or `allow` stay, and an empty `PGSSLMODE` or one libpq does not know, which libpq refuses, gives way to `sslmode=disable`. `pg_dump` reads certificates and keys from files alone, so an export from a pool whose `ssl` holds `ca`, `cert`, `key` or another TLS option is refused, naming them: give the pool a connection string whose `sslrootcert`, `sslcert` and `sslkey` parameters name the files, or set `PGSSLROOTCERT`, `PGSSLCERT` and `PGSSLKEY` and give the pool `ssl: true`. `sslnegotiation` follows the pool's own pg too. pg reads it from 8.22.0 (the connection string's over the settings', an empty one as none, then `PGSSLNEGOTIATION`) and with `direct` starts TLS at once, where pg 8.13.1 to 8.21.x read none and start TLS with an SSLRequest; the exporter reads it on a client of the pool's `Client`, never connected, so `pg_dump` gets the `sslnegotiation` that pg reads, none where it reads none, and TLS for `sslnegotiation=direct` only where that pg's parse turns TLS on for it (pg-connection-string 2.14.0 and later). `pg_dump` runs without `PGSSLNEGOTIATION`, which libpq 17 and later would read beside the URI. A value pg refuses (one but `direct` or `postgres`, or `direct` without TLS) refuses the export. libpq reads `sslnegotiation` from PostgreSQL 17 on; an older one refuses it as a parameter it does not know, and the export fails, saying what to do.

`pg_dump` runs with no shell between and with `--no-password`, so it never waits for a password on a terminal or on its standard input, and the password of the connection string reaches it through `PGPASSWORD`, not its command line: a `postgres://` or `postgresql://` URI's, in its user part or its `password` parameter, and the `password` of keyword=value settings (`host=db.example password='a b'`), each read as libpq reads it. An empty password given in the string goes to `PGPASSWORD` empty, so the environment's is never sent in its place. A connection string that holds a NUL character, or a password that is not valid percent-encoding or decodes to a NUL, is refused before `pg_dump` starts, without the string in the message. libpq reads `sslpassword` and `oauth_client_secret` from the connection string alone, so a string handed to `new PostgresExporter()` with them keeps them in `--dbname`; the features exporter leaves them out, since pg reads neither. `new PostgresExporter(connectionString, { schema })` exports one schema of any database; `connectionString` may be a function that gives it, or a promise of it, when an export runs, and `unsetEnvironment` names libpq variables to leave out of `pg_dump`'s environment.

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
