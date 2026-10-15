## [Unreleased]

### Added
- `foreignKeys` on `createDatabase()`, and on `StorageOpenOptions` for the resolver's `openOptions` and `open()`, sets SQLite's foreign-key enforcement (`true` on, `false` off) when better-sqlite3, sql.js, IndexedDB or Capacitor opens. Left out, each engine keeps its default, and they differ: better-sqlite3 is built with `SQLITE_DEFAULT_FOREIGN_KEYS=1` and enforces foreign keys, while sql.js, IndexedDB and Capacitor do not, so one schema behaved differently per engine. `foreignKeys: true` makes them agree. sql.js resets PRAGMAs whenever `export()` reopens its connection, on every save to a file or to IndexedDB, on `exportDatabase()` and on `importDatabase()`, so the sql.js and IndexedDB adapters apply it again after each. On Capacitor it runs outside the plugin's transaction, where SQLite ignores it. Each engine's default holds without the option, as before.
- `isUniqueViolation(error)` recognises a unique or primary-key violation from any adapter: PostgreSQL's SQLSTATE 23505, better-sqlite3's `SQLITE_CONSTRAINT_UNIQUE` and `SQLITE_CONSTRAINT_PRIMARYKEY`, and the "UNIQUE constraint failed" message from sql.js, IndexedDB and Capacitor. It follows `cause` up to ten levels and does not loop on a cycle, so an error a product wraps still counts.
- The SQLite adapters (better-sqlite3, sql.js, IndexedDB, Capacitor) take `$1`, `$2`, ... bound from a positional array, as PostgreSQL does, so one statement runs on both. SQLite reads `$1` as a named parameter: better-sqlite3 refused to bind it from an array ("Too many parameter values were provided"), and sql.js bound it in order of first appearance, so `$2, $1` got the values swapped. Each `$n` outside literals and comments becomes `?` with the values in `$n` order, repeats included. A statement that mixes `?` and `$n` is refused with an error.

### Fixed
- PostgreSQL placeholder rewriting reads SQL as the server does. A `?` or `@name` inside a string literal (`'What should this week hold?'`), an `E'...'` string, a quoted identifier, a dollar-quoted string or a comment was rewritten to `$n`. The text was stored corrupted, or the statement failed with a parameter-count error. Such text is left as written now. The jsonb operators work: `??` is the `?` operator in a statement with `?` placeholders, and `?|` and `?&` are never placeholders. A statement that already uses `$n` is sent as written, where its `?` operators were rewritten. A statement run without parameters keeps its `?`, where each became an unbound `$n`.

## [0.6.15] - 2026-10-15

### Added
- Pool control on the PostgreSQL adapter. `withConnection(fn)` holds one pooled connection for `fn`, for session settings, session advisory locks, temporary tables and statements outside a transaction. It returns the connection to the pool when `fn` resolves. It closes the connection when `fn` throws (rethrowing `fn`'s error) or returns inside a transaction it began (rejecting; pg 8.21 and later report the status). The connection refuses statements after `fn` ends. `getPoolStats()` returns `{ total, idle, waiting }`, or `null` when the adapter is not open. `transaction(fn, { isolationLevel, readOnly, deferrable })` sets how the transaction begins, on the adapter and on a held connection, and refuses an unknown isolation level before any SQL is sent. The `allowExitOnIdle` option passes pg's option to the pool, so Node can exit while the pool is idle. The types are `PostgresConnection`, `PostgresPoolStats`, `PostgresTransactionOptions` and `PostgresIsolationLevel`.
- `strict` on `createDatabase()` and `resolveStorageAdapter()`, for servers: only the database the options name opens. A postgres candidate that fails ends resolution with a `StorageResolutionError` whose `causes` hold its error, whatever `priority` lists after it; without `strict` it falls through to better-sqlite3, IndexedDB and sql.js. With `DATABASE_URL` or Postgres options that name a server and no `priority`, `['postgres']` is the whole list. An explicit file path outranks `DATABASE_URL`, which is then not read. A `url` or `postgres` option that names no server (`{ url: process.env.DATABASE_URL }` with the variable unset), or Postgres options given to the resolver with no `DATABASE_URL` to fill them in, fails instead of opening the local default, unless a file is given. `strict` is off by default, and resolution without it is unchanged.

### Changed
- CI runs the PostgreSQL integration suite (17 tests) and the dialect and full-text search suite (9 tests) against its PostgreSQL 16 service; both skipped in CI before. They read `POSTGRES_TEST_URL`, as the `createDatabase` specs do: the integration suite read `TEST_POSTGRES_URL`, which it still reads when `POSTGRES_TEST_URL` is unset, and the dialect suite read `DATABASE_URL`, which also moves the resolver's default to Postgres. The integration suite fails when its server cannot be reached, where its tests returned early and passed, and its granular-configuration test takes the host, port, database, user and password from the URL.

### Fixed
- PostgreSQL `transaction()`: when the connection broke and ROLLBACK failed too, the ROLLBACK error replaced the transaction's own error. A caller looking for a unique violation, or its own exception, saw "Client has encountered a connection error and is not queryable" instead. The transaction's own error (the callback's, or COMMIT's) is thrown now, with the ROLLBACK error on it as a non-enumerable `rollbackError` property, and the adapter logs one warning. The broken connection is closed instead of returned to the pool. It was released as healthy.
- PostgreSQL `transaction()` and `withConnection()`: a connection the server closed while a callback held it, between statements, ended the process. pg emits that error on the client when no query is running, and pg-pool listens only on idle clients. Examples are `idle_in_transaction_session_timeout`, a failover and an administrator's `pg_terminate_backend`. A checked-out connection now has a listener; the error closes the connection when it is released, and the pool opens a new one. A BEGIN that fails closes the connection too.
- PostgreSQL: a transaction's handle used after its transaction ended ran its statements on the pooled connection it had held. When another caller held that connection inside a transaction, the statements ran in that caller's transaction and were undone by its rollback, after the handle's caller had been told they succeeded. Once its transaction has ended, the handle now runs on the pool, as the adapter's own statements do. Its `transaction()` begins a new transaction; before, it ran the callback with no transaction at all. This matches better-sqlite3, where a handle used after its transaction waits like any other caller.
- The `createDatabase()` documentation and the remote-connection guide said that `createDatabase()` with no options opens PostgreSQL when `DATABASE_URL` is set. It opens the local default; pass `url: process.env.DATABASE_URL`. The README's cloud example passed `postgres: { connectionString: process.env.DATABASE_URL }`, which opens a local SQLite file when the variable is unset; it passes `url` with `strict` now.
- The README showed `createDatabase()` taking `performance` and `hooks` options. `DatabaseOptions` has neither, and no adapter applies a tier or runs hooks: the README now shows the exported `resolvePerformanceConfig()` and `combineHooks()` instead, and the optimization guide says so at its top.

## [0.6.14] - 2026-10-15

### Fixed
- IndexedDB adapter: the auto-save tick no longer saves while a transaction is open. sql.js's `export()` closes and reopens the connection, so a tick that fired while a `transaction()` callback awaited, or while a transaction begun with `BEGIN` was open, ended that transaction: its later statements ran outside it, and its `COMMIT` or `ROLLBACK` failed. The tick skips while a transaction is open and saves once it has committed. `exportDatabase()` throws while a transaction is open instead of ending it.
- IndexedDB and Capacitor adapters: `transaction()` runs its callbacks one at a time. Both run every transaction on one connection, and a second `transaction()` called while one was open ran `BEGIN` inside it and failed.
- IndexedDB and Capacitor adapters: a statement from outside an open transaction waits until the transaction commits or rolls back, as on better-sqlite3 since 0.6.12. It ran inside the transaction: a write was undone when the transaction rolled back, after its caller had been told it succeeded, and a read saw rows the transaction had not committed.
- IndexedDB adapter: a save counts as done when IndexedDB commits it. The adapter marked its writes saved when the put request succeeded, but the IndexedDB transaction can abort after that (a quota error at commit), and the image was then lost while the adapter counted it saved; a write made while a save was in flight was marked saved too and never written. A save settles on the transaction's `complete` event and fails on `abort`, and it marks saved only the writes its image held, so the next tick saves the rest. A failed save is reported once and tried again on the next tick.
- IndexedDB adapter: a transaction whose writes went through `all()` or `get()` (`INSERT ... RETURNING`) is saved: its commit marks it for saving. `importDatabase()` saves the imported image before it resolves, and two `close()` calls at once close the adapter once.
- Capacitor adapter: `transaction()` uses the plugin's `beginTransaction()`, `commitTransaction()` and `rollbackTransaction()` (plugin 5.0.7 and later, inside the `^6.0.0` peer range) and sends the callback's statements with `transaction` false. It ran `execute('BEGIN TRANSACTION;')`, which the plugin runs inside a transaction of its own: the transaction failed on iOS and did not hold the callback's statements together on Android. `run()` reads the plugin's nested answer, `{ changes: { changes, lastId } }`, and returns the number of changed rows and the inserted row's id; it returned the nested object and `null`.
- The resolver refuses the adapter kinds it cannot build. `electron-main`, `electron-renderer`, `supabase` and any unknown name, from `priority` or `STORAGE_ADAPTER`, fail as candidates with an error that names the kind and says how to create it, and the next candidate is tried. They built sql.js. `memory` builds sql.js as before.
- On Node, `createDatabase({ url })`, `createDatabase({ postgres })` and `connectDatabase()` open PostgreSQL. With no `priority` or `type`, they chose `['better-sqlite3', 'sqljs']` and opened a SQLite file at `db_data/app.sqlite3` whatever the URL said. A URL, or Postgres options that name a server (a connection string, or a host, database or user), choose `['postgres']` with no SQLite fallback. Options that name no server (`{ connectionString: process.env.DATABASE_URL }` with `DATABASE_URL` unset) keep the local default, `DATABASE_URL` in the environment does not change what `createDatabase()` chooses, and a browser and Deno keep sql.js.
- `createDatabase()` and `resolveStorageAdapter()` pass every Postgres option to the pool: its size, SSL, the timeouts and the application name, and host, port, database, user and password without a connection string. Only the connection string reached it. Options that name a server are used instead of `DATABASE_URL`.

### Changed
- On the IndexedDB and Capacitor adapters, a statement that a transaction's callback issues through the adapter itself, not through the handle it receives, waits for the transaction like any other caller's: a browser or a WebView has no async context to tell the two apart. The callback then waits on itself, and the adapter logs a warning after 10 seconds. Run a callback's statements through its handle.
- A `STORAGE_ADAPTER` value or a `priority` entry outside the kinds above no longer opens sql.js on the resolver's file path. When it was the only candidate, resolution fails with an error that names it; `sqljs` opens the same file as before.
- `createSyncManager()` with a `primary.url` or a `remote` URL opens PostgreSQL on Node, as its documentation says; both opened the local SQLite file.
- CI starts a PostgreSQL 16 service, and the specs that need a server read its URL from `POSTGRES_TEST_URL`. `fake-indexeddb` is a dev dependency, for the IndexedDB specs.

## [0.6.13] - 2026-10-15

### Fixed
- The declaration files name the files they import. tsc copies relative specifiers as the source writes them, and the build gave them their extensions in the JavaScript files only, so `dist/index.d.ts` carried `export * from './types'`. Under `--moduleResolution node16` or `nodenext`, TypeScript reads the package's declarations as ES modules, where a relative specifier resolves only when it names its file, so a consumer on those settings saw none of the package's exports (`error TS2305: Module '"@framers/sql-storage-adapter"' has no exported member 'createPostgresAdapter'`). The build now gives every relative specifier in the declarations the `.js` file or `/index.js` folder index it names, as it does in the JavaScript. Consumers on `bundler` or `node10` resolution read the same declarations as before.

### Changed
- CI packs the package, installs the tarball into a new ES module project and type-checks a consumer of `createDatabase`, `resolveStorageAdapter`, `createPostgresAdapter` and `StorageAdapter` with `--module nodenext --moduleResolution nodenext --strict`.

## [0.6.12] - 2026-10-12

### Fixed
- The better-sqlite3 adapter keeps another caller's statements out of an open transaction. The adapter runs every transaction on its one connection, and a statement issued while a transaction's callback awaited ran at once on that connection, inside the transaction: a write was undone when the transaction rolled back, and a read saw rows the transaction had not committed. Such a statement now waits until the transaction commits or rolls back. The transaction's own statements run in it: those through the callback's handle carry the transaction's token and are admitted whatever async context runs them, and those through the adapter from code the callback runs are told apart by the callback's async context (Node's `AsyncLocalStorage`, loaded when the adapter opens). A handle used after its transaction ended waits like any other caller.
- A transaction callback that calls `transaction()` on the adapter itself, not on its handle, joins the open transaction instead of queueing behind it and never running; the handle it receives carries the open transaction's token too.
- Closing the adapter disables its `AsyncLocalStorage`, so a process that opens and closes adapters does not keep one enabled store per adapter.

### Changed
- Inside a transaction callback, await only the database: a statement from another caller waits for the transaction to end, so a callback that waits on work which itself needs the database stalls both.
- The sql.js adapter, which also shares one connection, is unchanged in this release.

## [0.6.11] - 2026-10-12

### Fixed
- The Node-API check of 0.6.10 reads the version of the better-sqlite3 the adapter loaded. When the import from the package's own directory failed and the fallback loaded better-sqlite3 from the working directory, the check could read the other install's version, refusing a better-sqlite3 12 that runs or passing a 13 that crashes.

## [0.6.10] - 2026-10-12

### Fixed
- The better-sqlite3 adapter refuses to open better-sqlite3 13 or later on a runtime without Node-API 10 (Node.js older than 22.14 or 23.6, Electron older than 35), where its binding crashes the process inside `new Database()`, and `resolveStorageAdapter` goes on to the next adapter, sql.js by default. 0.6.9 said that version 13 needs Node.js 22 or later; it needs Node-API 10: Node.js 22.14+ or 23.6+, or Electron 35+.
- The README says that npm can run `node-gyp rebuild` for better-sqlite3 13 although it ships prebuilt binaries: always when it installs from a lockfile, and on some platforms on a fresh install too.

## [0.6.9] - 2026-10-07

### Changed
- `better-sqlite3` 13 is accepted as a peer (`^12.0.0 || ^13.0.0`). Version 13 moved to Node-API and ships its prebuilt binaries inside the package; it needs Node.js 22 or later.
- CI installs `better-sqlite3` 13 as a dev dependency, so the native adapter suites run instead of skipping, and the workflows run on Node.js 22.

## [0.6.7] - 2026-07-11

### Fixed
- PostgreSQL transaction callbacks now remain bound to their own checked-out clients during overlapping transactions.

## [0.6.5] - 2026-05-12

### Fixed
- **Postgres `exec()` statement splitter is now comment- and string-aware.** The prior splitter called `script.split(';')` with no awareness of `--` line comments, `/* */` block comments, single/double-quoted strings, or `$tag$...$tag$` dollar-quoted strings. A migration whose `CREATE TABLE` body included a `--` comment with an embedded `;` would be sliced at the comment's semicolon, leaving an unclosed paren that Postgres rejected with 42601 (`syntax error at end of input`). The new `splitSqlStatements` helper walks the script as a single-pass char state machine and only splits on top-level `;`. `dataImport.importFromSQL` now uses the same splitter, replacing its previous line-comment pre-pass.

## [0.6.0] - 2026-03-27

### Added
- **SqlDialect interface** with `SqliteDialect` and `PostgresDialect` implementations for cross-platform SQL generation (`insertOrIgnore`, `insertOrReplace`, `jsonExtract`, `ifnull`, `autoIncrementPrimaryKey`, `pragma`, `placeholder`)
- **IFullTextSearch interface** with `SqliteFts5` (FTS5 virtual tables) and `PostgresFts` (tsvector/GIN) implementations for cross-platform full-text search (`createIndex`, `matchClause`, `rankExpression`, `rebuildCommand`, `syncInsert`, `sanitizeQuery`, `joinClause`)
- **IBlobCodec interface** with `NodeBlobCodec` (Buffer) and `BrowserBlobCodec` (DataView/Uint8Array) implementations for cross-platform binary vector encoding
- **IDatabaseExporter interface** with `SqliteFileExporter` (VACUUM INTO) and `PostgresExporter` (pg_dump) implementations
- **`createStorageFeatures(adapter)`** factory function that returns the correct `StorageFeatures` bundle based on adapter kind and runtime environment
- **Postgres dialect integration test** (skipped without `DATABASE_URL`)

## [0.5.2] - 2026-02-06

### Added
- `ensureColumnExists` helper for SQLite schema migrations — safely adds columns to existing tables without failing if the column already exists

## [0.5.1] - 2025-12-26

### Added
- **Electron Adapter** - Full-featured Electron support with IPC bridge architecture
  - `ElectronMainAdapter`: Main process adapter wrapping better-sqlite3 with WAL, recovery, and multi-window support
  - `ElectronRendererAdapter`: Renderer process proxy with transparent IPC communication
  - Preload script with `contextBridge` for secure renderer access
  - Type-safe IPC protocol with request/response correlation
  - WAL checkpoint management and corruption detection
  - Auto-migration system with app version tracking
  - Multi-window database change broadcasting
  - Export: `@framers/sql-storage-adapter/electron`

- **Cross-Platform Sync Module** - Real-time delta synchronization across platforms
  - `CrossPlatformSync`: Main sync orchestrator with configurable table priorities
  - **Vector Clocks**: Distributed causality tracking for conflict detection
  - **WebSocket Transport**: Real-time bidirectional sync with auto-reconnection and heartbeats
  - **HTTP Transport**: Polling fallback for firewalls/proxies that block WebSocket
  - **Conflict Resolution**: Strategies include `last-write-wins`, `local-wins`, `remote-wins`, `merge`, `manual`
  - **Device Registry**: Track and manage syncing devices with presence status
  - **SyncLogManager**: Change log and conflict tables for delta tracking
  - UI hooks for custom conflict resolution dialogs
  - Export: `@framers/sql-storage-adapter/sync`

### Changed
- Updated package exports to include `/electron`, `/electron/preload`, and `/sync` entry points
- Enhanced `StorageContext` with Electron-specific properties

### Technical Details
- Vector clocks use `Record<string, number>` for causality comparison
- Sync protocol messages use underscore naming (`delta_push`, `handshake_response`)
- Transport layer abstracts WebSocket/HTTP with unified event system
- Field mergers support custom merge logic for complex data types

## [0.5.0] - 2025-12-14

### Fixed
- **IndexedDB options**: Exposed `indexedDb` options in `DatabaseOptions` for browser WASM configuration

## [0.4.2] - 2025-12-11

### Fixed
- **better-sqlite3 directory creation**: Adapter now creates parent directories before opening database file (fixes SQLITE_CANTOPEN when directory doesn't exist)
- **ESLint monorepo conflict**: Added `tsconfigRootDir` to ESLint config to resolve parsing errors in monorepo setups
- **TypeDoc build**: Moved guide docs from `docs/` to `guides/` to prevent deletion by TypeDoc's `cleanOutputDir`
- **README logo**: Fixed Frame.dev logo URL (was 404ing due to incorrect path format)

### Added
- New test file `betterSqliteAdapter.spec.ts` for directory creation tests

## [0.3.6] - 2025-11-12

### Fixed
- Release workflow: replace Node heredoc with robust bash/awk; always set notes output. Ensures GitHub Release is created even if npm publish step is skipped or fails.

## [0.3.5] - 2025-11-12

### Changed
- Release automation: fixed GitHub Actions release-on-tag workflow (pnpm install, bash env handling, README/Typedoc sync). No runtime code changes.

## [0.3.4] - 2025-11-11

### Fixed
- Normalized all ESM export/import specifiers in the published bundle so Node.js can resolve the adapter without additional build-time patches.

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.3] - 2025-01-08

### Changed
- **Browser-friendly by default**: Made `sql-storage-adapter` more browser-friendly to prevent bundling issues
  - **PostgreSQL adapter**: Changed from top-level `import { Pool } from 'pg'` to dynamic `await import('pg')` to prevent bundlers from trying to bundle `pg` in browser builds
  - **Resolver**: Replaced `import path from 'path'` with browser-safe dynamic import and conditional usage
  - **Process access**: Added browser-safe wrappers for `process.env` and `process.cwd()` that gracefully handle browser environments
  - These changes prevent Vite and other bundlers from trying to bundle Node.js-only modules (`pg`, `path`) in browser builds

### Fixed
- **Browser compatibility**: Fixed issues where bundlers would try to analyze and bundle server-only dependencies (`pg`, `path`) when `sql-storage-adapter` was imported in browser code
- **No breaking changes**: All changes are backward compatible - server-side behavior is unchanged

### Technical Details
- `postgresAdapter.ts`: Now uses lazy dynamic import of `pg` module (similar to `betterSqliteAdapter.ts`)
- `resolver.ts`: Uses browser-safe path utilities and process access that don't require Node.js modules at module load time
- Browser detection: Added runtime checks to avoid Node.js module imports in browser environments

## [0.3.2] - 2025-11-07

### Changed
- **Documentation clarifications**: Updated all docs to clarify that IndexedDB adapter is sql.js + IndexedDB persistence wrapper (not a separate SQL engine)
- **Capability updates**: Added `json` and `prepared` capabilities to IndexedDB and sql.js adapters
  - Both adapters now correctly declare JSON support (via SQLite JSON1 extension)
  - Prepared statements capability added for both adapters
- **README updates**: Clarified IndexedDB adapter relationship with sql.js throughout documentation

### Documentation
- Updated README.md adapter matrix to clarify IndexedDB is sql.js wrapper
- Updated PLATFORM_STRATEGY.md with detailed explanation of IndexedDB + sql.js architecture
- Updated ARCHITECTURE.md to note IndexedDB adapter is not a separate SQL engine
- Added notes about JSON support via SQLite JSON1 extension for IndexedDB/sql.js adapters

## [0.3.0] - 2025-11-06

### Added
- **IndexedDB Adapter** (`IndexedDbAdapter`) - sql.js + IndexedDB persistence wrapper for browser-native SQL storage
  - **Note**: This adapter uses sql.js (WASM SQLite) for all SQL execution and IndexedDB only for storing the database file as a binary blob
  - Automatic persistence to IndexedDB with configurable auto-save intervals
  - Full SQL support via sql.js (SQLite compiled to WebAssembly)
  - Export/import functionality for data portability
  - Optimized for Progressive Web Apps (PWAs) and offline-first workflows
  - Privacy-first: data never leaves the browser
- **AgentOS Integration Layer** (`createAgentOSStorage`, `AgentOSStorageAdapter`)
  - Pre-configured schema for AgentOS entities (conversations, sessions, personas, telemetry)
  - Auto-detection of platform (web, electron, capacitor, node, cloud)
  - Typed query builders for common AgentOS operations
  - Graceful degradation across platforms
  - Export available via `@framers/sql-storage-adapter/agentos`
- **Enhanced Graceful Degradation**
  - IndexedDB added to resolver priority chain for browser environments
  - Automatic fallback: IndexedDB → sql.js → memory for web
  - Improved platform detection for Electron, Capacitor, and Node.js
- **Platform Strategy Documentation**
  - New `PLATFORM_STRATEGY.md` with comprehensive pros/cons analysis
  - Updated `docs/media/ARCHITECTURE.md` with IndexedDB adapter details
  - Client-side storage guide for AgentOS deployments

### Changed
- Resolver now prioritizes `indexeddb` for browser environments
- `AdapterKind` type now includes `'indexeddb'` option
- Improved adapter selection logic with better fallback chains

### Documentation
- Added IndexedDB adapter to README adapter matrix
- Comprehensive TSDoc comments for IndexedDB adapter
- Platform strategy guide with detailed comparison tables
- AgentOS integration examples and best practices

## [0.2.0] - 2025-11-04

### Added
- Barrel export available via `@framers/sql-storage-adapter/types` so bundlers can import the public type surface without reaching into `dist/`.

### Changed
- Hardened adapter modules (PostgreSQL, better-sqlite3, Capacitor, SQL.js) to avoid top-level side effects and provide clearer runtime errors when optional dependencies are missing.
- Normalised `lastInsertRowid` values returned by PostgreSQL, better-sqlite3, and SQL.js adapters so they are always plain numbers or strings.
- Improved `createDatabase` automatic adapter resolution for Node.js, browser, and Deno environments with clearer fallbacks.
- Restructured the source tree into `core/`, `adapters/`, `features/`, and `shared/` folders so contributors can navigate contracts, runtime APIs, and higher-level utilities independently.

### Fixed
- Sanitised Sync Manager merge inputs and conflict handling so records lacking IDs or timestamps no longer crash synchronisation.
- Tightened Supabase adapter caching/stream typings and connection pool metrics reporting to prevent `unknown` leak-through at runtime.
- Updated offline sync example merge helper to defensively parse profile data before combining settings.
- Migration tests now fall back to the `sql.js` adapter when `better-sqlite3` is unavailable, keeping CI and contributors unblocked.

## [0.1.0] - 2025-11-01

### Added
- Initial release of SQL Storage Adapter
- Support for multiple SQL backends:
  - PostgreSQL (via `pg`)
  - Better-SQLite3 (native SQLite)
  - SQL.js (WebAssembly SQLite)
  - Capacitor SQLite (mobile)
- Automatic runtime detection and adapter selection
- Graceful fallback mechanisms
- Full TypeScript support with comprehensive type definitions
- Transaction support across all adapters
- Prepared statement support (where available)
- Batch operations for bulk inserts
- Connection pooling for PostgreSQL
- Comprehensive documentation with pros/cons for each adapter
- Extensive error handling and recovery mechanisms

### Features
- **Automatic Adapter Resolution**: Intelligently selects the best available adapter
- **Cross-Platform**: Works in Node.js, browsers, Electron, and mobile apps
- **Type Safety**: Full TypeScript support with detailed interfaces
- **Performance**: Optimized for each platform with adapter-specific enhancements
- **Security**: SQL injection prevention through parameterized queries
- **Flexibility**: Support for both named and positional parameters

### Supported Capabilities by Adapter
- **PostgreSQL**: transactions, locks, persistence, concurrent, json, arrays, prepared
- **Better-SQLite3**: sync, transactions, wal, locks, persistence, prepared, batch
- **SQL.js**: transactions, persistence (Node.js only)
- **Capacitor**: transactions, wal, persistence

### Documentation
- Comprehensive README with usage examples
- Detailed pros/cons for each adapter
- Migration guides from raw database drivers
- Troubleshooting section
- Performance considerations

### Security
- SQL injection prevention through parameterized queries
- Connection security guidelines
- Secure default configurations

---

For more information, see the [README](README.md) or visit our [GitHub repository](https://github.com/framerslab/sql-storage-adapter).
