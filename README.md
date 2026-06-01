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

// Cloud (Node): Uses PostgreSQL
const cloudDb = await createDatabase({ 
  postgres: { connectionString: process.env.DATABASE_URL }
});
```

See [Platform Strategy Guide](./PLATFORM_STRATEGY.md) for detailed pros/cons and architecture.

## Adapter Matrix

| Adapter | Package | Ideal for | Pros | Considerations |
| --- | --- | --- | --- | --- |
| **🆕 `electron`** | bundled | **Electron desktop apps** | IPC bridge, multi-window, WAL, auto-migrations, crash recovery | Requires Electron runtime |
| **🆕 `indexeddb`** | bundled (sql.js) | **Browsers, PWAs** | sql.js + IndexedDB persistence wrapper, browser-native storage, 50MB-1GB+ quota, offline-first | IndexedDB quotas vary, WASM overhead (sql.js), not a separate SQL engine |
| `better-sqlite3` | `better-sqlite3` | Node/Electron, CLI, CI | Native performance, transactional semantics, WAL support | Needs native toolchain; version must match Node ABI |
| `postgres` | `pg` | Hosted or on-prem PostgreSQL | Connection pooling, rich SQL features, cloud friendly | Requires `DATABASE_URL`/credentials |
| `sqljs` | bundled | Browsers, serverless edge, native fallback | Pure WASM SQLite, no native deps, optional filesystem persistence | Write performance limited vs native, in-memory by default |
| `capacitor` | `@capacitor-community/sqlite` | Mobile (iOS/Android, Capacitor) | Native SQLite on mobile, encryption | Requires Capacitor runtime |
| `memory` | built-in | Unit tests, storybooks, constrained sandboxes | Zero dependencies, instant startup | Non-durable, single-process only |

### Platform Priorities

| Platform | Primary Adapter | Fallback | Use Case |
|----------|----------------|----------|----------|
| **Web (Browser)** | IndexedDB | sql.js | PWAs, offline-first web apps |
| **Electron (Desktop)** | electron | better-sqlite3 | Desktop apps, dev tools |
| **Capacitor (Mobile)** | capacitor | IndexedDB | iOS/Android native apps |
| **Node.js** | better-sqlite3 | Postgres, sql.js | CLI tools, local servers |
| **Cloud (Serverless)** | Postgres | better-sqlite3 | Multi-tenant SaaS, APIs |

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
- Provide `priority: ['indexeddb', 'sqljs']` for browser bundles or tests where native modules shouldn't load.
- Use `createCloudBackupManager` for S3-compatible backups with gzip compression and retention limits.

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

## Platform Strategy

See [**PLATFORM_STRATEGY.md**](./PLATFORM_STRATEGY.md) for a comprehensive guide on:
- Graceful degradation patterns
- Platform-specific pros/cons
- Performance benchmarks
- Offline-first architectures
- Browser-friendly bundling (dynamic imports prevent server-only dependencies from being bundled)

**TL;DR:** Use IndexedDB for web, better-sqlite3 for desktop, capacitor for mobile, Postgres for cloud.

## Performance Tiers & Cost Optimization

The adapter supports configurable performance tiers for different use cases:

```typescript
import { createDatabase } from '@framers/sql-storage-adapter';

// Development: Fast tier - prioritize speed
const devDb = await createDatabase({
  type: 'memory',
  performance: { tier: 'fast' }
});

// Production: Balanced tier (default)
const prodDb = await createDatabase({
  priority: ['indexeddb', 'sqljs'],
  performance: { tier: 'balanced' }
});

// Analytics/Reporting: Accurate tier - no caching, full validation
const analyticsDb = await createDatabase({
  postgres: { connectionString: process.env.DATABASE_URL },
  performance: { tier: 'accurate', trackMetrics: true }
});

// Mobile: Efficient tier - battery optimization
const mobileDb = await createDatabase({
  priority: ['capacitor', 'indexeddb'],
  performance: { tier: 'efficient', batchWrites: true }
});
```

| Tier | Caching | Batching | Validation | Use Case |
|------|---------|----------|------------|----------|
| `fast` | Aggressive | Yes | Minimal | Development, testing |
| `balanced` | Moderate | No | Standard | General production |
| `accurate` | Disabled | No | Full | Analytics, reporting |
| `efficient` | Moderate | Yes | Minimal | Mobile, IoT |

See [**guides/OPTIMIZATION_GUIDE.md**](./guides/OPTIMIZATION_GUIDE.md) for detailed configuration options.

## Lifecycle Hooks

The adapter provides lifecycle hooks for extending behavior:

```typescript
import { createDatabase, type StorageHooks } from '@framers/sql-storage-adapter';

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

const db = await createDatabase({
  performance: { tier: 'balanced' },
  hooks: myHooks
});
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
  - `ci.yml` runs lint, tests, and coverage on every branch.
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
