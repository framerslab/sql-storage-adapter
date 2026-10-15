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

## Configuration & Resolution

- `resolveStorageAdapter` inspects:
  - explicit options (`priority`, `type`, adapter configs),
  - environment variables (`STORAGE_ADAPTER`, `DATABASE_URL`),
  - runtime hints (Capacitor detection, browser globals, IndexedDB availability).
- Adapters are attempted in priority order until one opens successfully; a `StorageResolutionError` includes the full failure chain.
- The resolver builds `postgres`, `better-sqlite3`, `capacitor`, `indexeddb` and `sqljs`, and builds sql.js for `memory`. Any other kind (`electron-main`, `electron-renderer`, `supabase`, or an unknown name, from `priority` or `STORAGE_ADAPTER`) fails as a candidate with an error that names it, and the next candidate is tried.
- On Node, `createDatabase({ url })` and `createDatabase({ postgres })` open PostgreSQL when the options name a server: a `postgres://` or `postgresql://` URL or connection string, or a host, database or user. Every Postgres option (pool size, SSL, timeouts, application name, or host, port, database, user and password without a connection string) is passed on, and there is no fallback to SQLite. A connection string of another scheme names no server (`file:./dev.db`, which `DATABASE_URL` holds in a project that runs SQLite through Prisma, or `sqlite:...`), and neither does an empty or unset one: the local default opens, or, with `strict`, the call fails. For a `socket:` URL or a socket path, pass `type: 'postgres'` or use `connectDatabase()`. In a browser and on Deno, `createDatabase()` opens sql.js whatever the options say. `DATABASE_URL` in the environment does not change what `createDatabase()` picks; `resolveStorageAdapter()` without a `priority` tries Postgres first when it is set.
- **Behaviour change in 0.6.14, a patch release:** through 0.6.13, `createDatabase({ url })` and `createDatabase({ postgres: { connectionString } })` with no `priority` or `type` opened the SQLite file `db_data/app.sqlite3` under the working directory on Node, whatever the URL said; since 0.6.14 they open PostgreSQL. A caller whose data is in that file passes `priority: ['better-sqlite3', 'sqljs']` or `type: 'sqlite'` to keep opening it.
- `connectDatabase()` opens PostgreSQL alone, in every runtime, from any connection string pg reads or from options with a host, database or user; a server it cannot reach fails the call. Given no server, as `connectDatabase(process.env.DATABASE_URL)` is with the variable unset, it throws before it opens anything. It does not read `DATABASE_URL` on its own.
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

### IndexedDB-Specific Config

```typescript
import { IndexedDbAdapter } from '@framers/sql-storage-adapter';

const adapter = new IndexedDbAdapter({
  dbName: 'my-app-db',       // IndexedDB database name
  storeName: 'sqliteDb',     // Object store name
  autoSave: true,            // Auto-save to IndexedDB after writes
  saveIntervalMs: 5000,      // Batch writes every 5s
});

await adapter.open();
```

**Key Features:**
- ✅ SQL execution via sql.js (WASM SQLite)
- ✅ **Automatic persistence** via IndexedDB (stores SQLite database file as blob)
- ✅ JSON support (SQLite JSON1 extension: json_extract, json_object, json_array, etc.)
- ✅ Prepared statements for performance and security
- ✅ Export/import (Uint8Array SQLite file format)
- ✅ Auto-save with batching (reduce IDB overhead)

**When it saves:** every `saveIntervalMs`, the adapter writes the database image to IndexedDB if anything changed. It skips the tick while a transaction is open, its own or one begun with `BEGIN`, because sql.js's export closes and reopens the connection, which would end the transaction; the next tick saves it once it has committed. A save counts as done when IndexedDB commits it, not when the put request succeeds. A save that fails or aborts is reported once, and the next tick tries again. A write made while a save is in flight is saved by the next one. A transaction's commit marks its writes for saving, including writes made through `all()` or `get()` (`INSERT ... RETURNING`). Outside a transaction, a statement through `all()` or `get()` marks the database changed unless it is a `SELECT`, `VALUES` or `EXPLAIN`; a `WITH` statement does when it changed rows. `close()` rolls back a transaction still open and saves the committed state. `exportDatabase()` throws while a transaction is open.

**Importing:** `importDatabase()` checks the image before it replaces anything: it must start with the SQLite header and pass SQLite's `quick_check` (an empty image imports as an empty database). It throws on an image that fails, and the adapter keeps the database it had, in memory and in IndexedDB. The imported database replaces the current one once an open `transaction()` has ended and a save already running has finished, takes the connection's PRAGMA settings, and is saved to IndexedDB before the call resolves.

**What a save keeps:** each save, `exportDatabase()` and `importDatabase()` goes through sql.js's `export()`, which closes and reopens the connection. The adapter reads the connection's PRAGMA settings first and sets them again on the reopened connection: `foreign_keys`, `recursive_triggers`, `ignore_check_constraints`, `legacy_alter_table`, `reverse_unordered_selects`, `trusted_schema`, `automatic_index`, `cell_size_check`, `secure_delete`, `cache_size`, `cache_spill`, `temp_store`, `synchronous`, `journal_mode` and `query_only`. The rest of the connection's state does not survive a save:

- TEMP tables, views and triggers;
- attached databases;
- functions registered on the underlying sql.js database;
- `PRAGMA case_sensitive_like`, which cannot be read back.

Keep such state in the main database, or create it again where it is used.

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

### Capacitor Notes

```typescript
import { createDatabase } from '@framers/sql-storage-adapter';

const db = await createDatabase({
  priority: ['capacitor', 'indexeddb'],
  mobile: { database: 'my-app', enableWal: true },
});
```

- The adapter opens its database through the plugin's `SQLiteConnection`, which every Capacitor adapter of the page shares, and `close()` closes the plugin's connection too, so the database opens again. The plugin keeps its connections across a reload of the page; `open()` closes one a reload left behind and makes it again.
- One adapter at a time holds a database: `open()` fails while another adapter of the page has the same database open.
- `enableWal` (default true) sends `PRAGMA journal_mode = WAL` through the plugin's `query()` and warns when SQLite answers another mode.
- The plugin runs `execute()` and `run()` inside a transaction of its own, where SQLite ignores `PRAGMA foreign_keys` and refuses to change the journal mode, and on Android through `execSQL`, which fails on a statement that answers a row. So a `PRAGMA` in `run()`, or at the start or the end of an `exec()` script, goes through `query()` instead, outside that transaction. A script that turns foreign keys off, rebuilds a table and turns them on again runs as SQLite's procedure for changing a table expects. A `PRAGMA` between two other statements of a script stays inside the plugin's transaction.
- The plugin turns foreign keys on when it opens a database.

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

```typescript
const { dialect } = features;

// INSERT OR IGNORE (SQLite) → ON CONFLICT DO NOTHING (Postgres)
const sql = dialect.insertOrIgnore('users', ['id', 'name'], ['?', '?']);

// INSERT OR REPLACE (SQLite) → ON CONFLICT DO UPDATE (Postgres)
const upsert = dialect.insertOrReplace('users', ['id', 'name'], ['?', '?'], 'id');

// json_extract(col, '$.key') (SQLite) → (col::jsonb)->>'key' (Postgres)
const expr = dialect.jsonExtract('metadata', '$.theme');

// ifnull(expr, fallback) (SQLite) → COALESCE(expr, fallback) (Postgres)
const safe = dialect.ifnull(dialect.jsonExtract('config', '$.lang'), "'en'");

// PRAGMA (SQLite) → null/no-op (Postgres)
const pragma = dialect.pragma('journal_mode', 'WAL');
if (pragma) await adapter.exec(pragma);
```

### IFullTextSearch — FTS5 & tsvector

```typescript
const { fts } = features;

// Create index: FTS5 virtual table (SQLite) or tsvector + GIN (Postgres)
await adapter.exec(fts.createIndex({
  table: 'docs_fts',
  columns: ['title', 'body'],
  contentTable: 'documents',
  tokenizer: 'porter ascii',
}));

// Search query
const sql = `
  SELECT t.*
  FROM ${fts.joinClause('documents', 't', 'fts', 'docs_fts')}
  WHERE ${fts.matchClause('docs_fts', '?')}
  ORDER BY ${fts.rankExpression('fts')}
`;

// Rebuild index
await adapter.exec(fts.rebuildCommand('docs_fts'));
```

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
