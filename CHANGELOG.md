## [Unreleased]

### Security
- `PostgresExporter` refuses, before `pg_dump` starts, a connection string whose password it cannot move to `PGPASSWORD`: a URI password that is not valid percent-encoding (`%zz`, a `%` at its end, bytes that are not UTF-8) or that decodes to a NUL, and a connection string that holds a NUL. Versions through 0.8.2 passed such a URI whole, its password in `--dbname`, where the process list shows it. The refusal never holds the connection string.
- `PostgresExporter` moves the `password` of keyword=value settings (`host=db.example password='a b'`) to `PGPASSWORD` too, read as libpq reads them: a value runs to whitespace or sits in single quotes, a backslash takes the character after it, and the later of two passwords wins. An empty password goes to `PGPASSWORD` empty, as libpq reads an empty setting, so the environment's `PGPASSWORD` is never sent in its place. Settings libpq refuses (an unterminated quote, a setting with no `=`) are refused before `pg_dump` starts. Versions through 0.8.2 passed them whole on the command line.
- The exporter of a PostgreSQL adapter leaves `sslpassword`, `oauth_client_secret` and the SCRAM keys of a pool's connection string off `pg_dump`'s command line, where libpq takes them alone: pg reads none of them.
- The exporter of a PostgreSQL adapter has `pg_dump` check the server as the pool's pg does. pg's TLS is Node's, which checks the server's certificate and its host name, and versions through 0.8.2 wrote `sslmode=require` for it, with which libpq checks neither without a root certificate file: an export connected to a server whose certificate the pool refuses. `pg_dump` gets `sslmode=verify-full`, or `verify-ca` where pg checks no host name (`uselibpqcompat=true` with `verify-ca`, or `require` beside a root certificate), against the root certificate file the connection string names, else the file `PGSSLROOTCERT` names, else the system's certificate authorities (`sslrootcert=system`, which libpq reads from PostgreSQL 16 on; with an older libpq the export fails, saying what to do). `uselibpqcompat=true` with `sslmode=verify-ca` and no root certificate is refused before `pg_dump` starts, as pg refuses it.

### Changed
- `new PostgresExporter(connectionString)` takes a function that gives the connection string, or a promise of it, when an export runs.

### Fixed
- `createStorageFeatures(adapter).exporter` on PostgreSQL reads the connection of the adapter's pool as pg reads it, and hands `pg_dump` a libpq URI of it, so `pg_dump` reaches the server, the database and the user the pool reaches:
  - A connection string pg and libpq read apart: `postgresql://db.example?application_name=x@y` names the host `db.example` to pg and `y` to libpq, and `pg_dump` connected to `y`. An `@` in a URL's password, a host left out, `ssl=1`, `sslmode=no-verify` and pg's own parameters are written as libpq reads them.
  - A pool made without a host, a port, a user or a database: `PGHOST`, `PGPORT`, `PGUSER` and `PGDATABASE`, then localhost, 5432, the operating system's user and the user's name for the database, as pg fills them. Versions through 0.8.2 wrote localhost and 5432 for a pool that named no host or port, and refused one that named no database. The adapter's own settings keep the localhost and 5432 of the pool it makes.
  - A pool whose password is a function: the function is asked when the export runs, as the pool asks it for each connection: through the `Client` the pool makes its connections with, which pg-pool keeps as the pool's `Client`, whose own routine calls it as a method of a client made of the pool's settings, with no arguments before pg 8.19.0 and from 8.19.0 with the client's `ConnectionParameters` (node-postgres #3602). So a pool made with another copy of pg than the one this library loads, or with a `Client` of its own, is asked as its own pg asks; a pool whose `Client` has no such routine (pg's native one) is asked as the pg this library loads asks. The client is never connected and is made without the settings' `stream`. Its answer goes to `PGPASSWORD`. A function that answers no password gives `pg_dump` an empty `PGPASSWORD`: pg then connects with no password and reads no `PGPASSWORD`, so the environment's is not sent. A function that fails, or answers anything but a string or `undefined`, refuses the export. Versions through 0.8.2 left the function's password out, so `pg_dump` logged in with `PGPASSWORD`, or not at all.
  - A pool whose `ssl` holds `ca`, `cert`, `key`, `pfx` or another TLS option is refused, naming the options and what to do instead: `pg_dump` reads TLS material from files alone. Versions through 0.8.2 wrote `sslmode=require` in its place, so `pg_dump` connected without the client certificate, or checked the server against no certificate authority.
  - TLS follows pg's. A pool that checks no certificate (`ssl: { rejectUnauthorized: false }`, pg's `no-verify`) gets `sslmode=require` over any `PGSSLMODE`: a `PGSSLMODE` of `verify-ca` or `verify-full` refused the certificate pg accepts. A pool that chose no TLS (`ssl: false`, `ssl=0`, `sslmode=disable`) gets `sslmode=disable`, where libpq's `prefer` or `allow` would use TLS. Where no TLS is pg's default, libpq's default stays, and an empty `PGSSLMODE` or one libpq does not know, which pg reads as no TLS and libpq refuses, gives way to `sslmode=disable`. A certificate file in the connection string turns TLS on over `ssl=0`, and an `sslmode` libpq does not know means TLS, as pg reads them.
  - pg takes the database from the URL's path alone and drops a `database` parameter, and reads an empty `host` parameter as none; the URI holds that reading (pg-connection-string, `index.js`). libpq's own variables, which pg does not read (`PGHOSTADDR`, `PGSERVICE`, `PGREQUIRESSL`, `PGSSLROOTCERT`), configure `pg_dump` as they configure psql.
  - The port is read as pg reads it, with `parseInt` after the setting, `PGPORT` and 5432: a port of `5432x` is 5432, which libpq refused as no number, and a port of 0 gives way to `PGPORT`, where versions through 0.8.2 wrote 0. A port pg reads no number in is refused before `pg_dump` starts, since the pool makes no connection with it.
  - Of a connection string's parameters the URI holds the ones pg reads and libpq takes: `options`, `application_name`, `fallback_application_name`, `client_encoding`, `replication`, `sslnegotiation` and the certificate files. libpq's others, which pg does not read (`passfile`, `target_session_attrs`, `require_auth`, `channel_binding`, `gssencmode`, `connect_timeout`, `sslcrl` and the rest), are left out: given them, `pg_dump` read another password file than the pool, or refused a server, an authentication or a session the pool takes.
- `resolveStorageAdapter()` and `createDatabase()` open a PostgreSQL candidate in the segment of its own options or the top-level one alone. Tried after an IndexedDB or Capacitor candidate whose options named a segment, it took that segment: on a pool of the caller's the adapter threw, and on a connection string the server got a schema only the browser's options asked for. A local candidate still opens in it.
- IndexedDB adapter: a PRAGMA assignment through `all()` or `get()` with a comment between its words (`PRAGMA user_version /* note */ = 7`), with a quoted name and no space before it (`PRAGMA"user_version"=9`), or with its schema or name in single quotes (`PRAGMA 'user_version' = 10`), which SQLite takes for a name there, is saved; the statement is read as SQLite reads it. Versions through 0.8.2 found no assignment in it, so it was stored neither with `durability: 'commit'` nor by `flush()` or `close()`.
- `createSqlKeyValueStore()` writes a value's text from the copy the runtime's `structuredClone` returns, so each property is read once, as IndexedDB's put reads it, and the value is copied once. Versions through 0.8.2 read each property a second time for the text: a getter's second answer was stored, and a value whose getter answered a function the second time was refused.
- `PostgresExporter` runs `pg_dump` with `--no-password`. Without a password, to a server that asks for one, `pg_dump` asked for it on the terminal, or with no terminal read its standard input, which the export leaves open, and the export never ended.

## [0.8.2] - 2026-10-21

### Fixed
- The Electron auto-migrator records the version Electron's app reports beside each migration it runs. With no `getAppVersion` of the caller's, it asked Electron through `require('electron')`, which the package's ES module build does not have, so it recorded the working directory's `package.json` version, or `0.0.0`, in an Electron app too. It asks through `createRequire(import.meta.url)` now, which both builds have. A spec stands in for Electron's app and checks the version recorded with it and without it.

## [0.8.1] - 2026-10-19

### Fixed
- A page that bundles the root entry no longer meets `async_hooks`. Since 0.6.12 the better-sqlite3 adapter loads Node's `AsyncLocalStorage` with `import('async_hooks')` when it opens, which it refuses to do in a browser, but a bundler resolves that import when it builds the page: webpack, which has no browser stand-in for `async_hooks`, failed the build with "Module not found: Can't resolve 'async_hooks'" (a Next.js static export of an app that imports the root entry did), and esbuild left an import in the page that a browser cannot load. The `browser` field of `package.json` maps `async_hooks` to an empty module, and `dist/cjs/package.json` repeats it, since webpack reads the field from the `package.json` nearest the importing file. On Node nothing changes: the adapter loads `async_hooks` as before. A spec bundles the root entry for a browser with esbuild and checks that `async_hooks` comes out as an empty module, and CI checks that the packed CommonJS build carries the field.

## [0.8.0] - 2026-10-18

### Added
- `@framers/sql-storage-adapter/browser` (#71), one entry with what a page needs: the IndexedDB adapter with `IndexedDbConflictError` and its option types, the key-value module with `migrateIndexedDbKeyValue`, `createTabLock`, and the mutation sync's client with its counters, wire contract, row mutations, packing, fetch transport, loop and change channel. Its import graph holds no Node built-in and no pg: the one package it imports is sql.js. The mutation sync's server half (`MutationServer`, `createSqlMutationStore`, `DrainGate`) stays in `./sync`. CI checks that `require()` loads the entry, that its bundle holds no pg, better-sqlite3 or `@aws-sdk/client-s3`, and that a NodeNext and a CommonJS TypeScript consumer type-check against it.

### Changed
- The release workflow runs one release at a time, in the order the runs began to wait: a run that starts while another runs waits for it, and up to 100 wait (`queue: max`), so a newer run never replaces one still waiting and no version is skipped. Two merges close together whose `package.json` holds the same new version no longer race `npm publish`: the later run publishes nothing, so the version and its tag come from the earlier merge.

### Fixed
- The release workflow publishes when npm holds no release of the commit's exact version. It compared the version with npm's `latest` alone, so a run of an older commit, such as a re-run after a newer release, tried to publish a version npm already held, and failed.

### Documentation
- `guides/MUTATION_SYNC.md` describes the mutation sync: the row mutations and their copies; the server with its store, its push, its streamed pull, its tombstone replay and its drain gate; the client with its saves, joins, kept rows, restores and removal; the fetch transport and the loop; the browser storage the client runs on; the move of an old IndexedDB key-value store; and an example server, its routes and a page. The README's "Mutation Sync" section links it.

## [0.7.17] - 2026-10-18

### Added
- The mutation sync in `./sync` (#65): a push, pull and rebase protocol for named text rows beside the cross-platform sync. `MutationServer`, over a store port, records each client's mutation ids in the push's own transaction, answers a pull from one snapshot with a monotonic version as its cookie, streams the pull's patch in batches, replays deletes from tombstones, and cancels a pull still open `maxPullMs` after its call (120 seconds by default). `createSqlMutationStore` is a store on the library's own tables, and `DrainGate` blocks a scope's requests, cancels the running ones and waits for them to leave. `MutationClient` keeps durable saves and a journal, rebases, applies a pull atomically, packs pushes and splits them on a 413, joins, leaves, restores across restore epochs and removes rows, and `createFetchMutationTransport` is its HTTP transport. `SyncLoop` pushes then pulls at start, on a save, on becoming visible, on reconnecting, on sign-in and every 60 seconds while the page is visible, trying a failed cycle again after 2 seconds, doubling to 300; `attachSyncLoop` wires it to the page's events, `changeChannel` tells the page's other tabs of a commit, and `createTabLock`, in the package since 0.7.13, is exported. No existing export or behaviour changes.

### Fixed
- `transaction()` on the PostgreSQL adapter, on a connection `withConnection()` holds and on `SupabaseAdapter` rejects when PostgreSQL answers its COMMIT with ROLLBACK. A failed statement aborts a PostgreSQL transaction, and PostgreSQL ends the COMMIT of an aborted transaction as a ROLLBACK, with no error of its own, so a callback that caught a statement's error and went on resolved `transaction()` while nothing of it was written. The error says to run a statement that may fail under a savepoint of its own.
- `SupabaseAdapter.batchWrite` runs each operation under a savepoint, as the PostgreSQL adapter's `batch` does: a failed operation rolls back to its savepoint, the batch goes on, and the operations that succeeded commit. Without one, the failed operation aborted the transaction, every operation after it failed, and the COMMIT wrote nothing, while the result counted the operations before the failure as written. An operation whose values cannot be read, as when a getter throws, counts as failed too, and the batch goes on.
- `SupabaseAdapter` hears the connection errors of its clients. The server ending a session (`pg_terminate_backend`, a restart) or a broken socket emitted an `error` event nothing listened to, which ends a Node process, while `transaction()` or a read the cache may keep held the client, and while the client sat idle in the pool. The statement now rejects with its own error and PostgreSQL's code (57P01 for a session the server ended), the client is closed, and an idle client's failure is logged through the host logger.
- A `SupabaseAdapter` transaction, or a read the cache may keep, whose ROLLBACK could not run after a failure closes its client instead of returning it to the pool. pg's `query_timeout` rejects a statement the server still runs and drops the ROLLBACK queued behind it, so the client went back to the pool inside the transaction, and the next statement given it ran there and never committed. `transaction()` throws the transaction's own error, with the ROLLBACK's on it as a non-enumerable `rollbackError`.
- `SupabaseAdapter` with `enableCache()` on sends a `SELECT` it may keep the values pg's own `prepareValue` writes for its parameters when the call is made, and keys the answer by those. It bound the caller's values only once it had a client, so values the caller changed after the call were bound and the answer kept under the key of the old ones; it keyed named parameters by the object's own enumerable fields, where the statement binds the value of each name it holds, inherited and non-enumerable ones too; and it keyed a Date by its time, where pg binds its text in the process's time zone, or in UTC under `pg.defaults.parseInputDatesAsUTC`. With pg before 8.15.0, whose main export has no `utils.prepareValue`, a `SELECT` with parameters runs each time it is asked.
- `SupabaseAdapter`'s `run`, `get` and `all`, and its transaction handle's `get` and `all`, answer a string of several statements, sent with no parameters, as the PostgreSQL adapter does: `get` null, `all` an empty list and `run` no row's id. pg answers such a string with a list of results, which has no rows of its own, so `get` and `run` threw a `TypeError` after PostgreSQL had run every statement, and `all` answered `undefined`.
- `SupabaseAdapter`'s cache ends a `--` comment at a carriage return as well as a line feed, as PostgreSQL does, so `-- note\rVALUES (nextval('ids'))` is not taken for a `SELECT`, and runs each time it is asked.

## [0.7.16] - 2026-10-17

### Fixed
- `SupabaseAdapter` with `enableCache()` on never answers a row as it stood before one of its own writes. `get` and `all` kept each answer by statement and parameters, and no write cleared them, so a row read, then changed through `run`, `exec`, `transaction` or `batchWrite`, came back from the cache unchanged. They also kept the answer of a statement that writes: `get('INSERT ... RETURNING id', params)` ran once, and the second call answered the first row without inserting, and `get('SELECT bump(?)', params)`, whose function writes, did the same. The cache now holds the answers of `SELECT`s alone (a statement whose first word, past white space and comments, is `SELECT`), and of those only the ones that wrote nothing: a `SELECT` the cache does not hold runs once, in a transaction of its own, and its answer is kept only when PostgreSQL gave that transaction no ID, which PostgreSQL gives a transaction when it first writes. That check reads `pg_current_xact_id_if_assigned()`, so the cache needs PostgreSQL 13 or later. Every statement that writes and every transaction clears the cache when it ends, and a read that a write or `clearCache()` overtook keeps nothing. A string of several statements counts as a write: a `COMMIT` in it ended the cache's transaction, and an `UPDATE` after it committed in one of its own, which the check could not see. The key of an answer names its call, so `get` and `all` of one statement no longer answer each other's row or list, and it writes each parameter as pg binds it. It wrote them as JSON: a bigint parameter threw (`JSON.stringify` cannot write one) before the statement reached the database, a statement bound to NaN answered the row kept for null, one bound to a Date, from this realm or another, answered the row kept for the Date's ISO text, which pg binds as other text (local time with its offset), one bound to bytes and one bound to an object JSON writes alike (`{ type: 'Buffer', data: [1] }`) answered each other's row, two objects that pg binds through their own `toPostgres` shared a key whenever JSON wrote them alike, as it writes any two whose state is private, and text spelling a Date's key (U+0000, then the Date's tag and time), which PostgreSQL refuses, answered the row kept for that Date. A `SELECT` bound to an object with a `toPostgres` of its own, or to text holding U+0000, now runs each time it is asked. A hit answered the kept row or list itself, and the first caller got it too, so a caller that changed what it was given changed what the cache answered next; the cache now keeps a copy and answers a copy, with each Date and Buffer copied as itself, and keeps no answer holding a value with no faithful copy, such as an interval, which pg parses to an object of its own. A write through another adapter, pool or process, an effect that writes no row, such as `pg_notify()` or an advisory lock, and a `SELECT` whose answer changes from one call to the next by itself, such as one that calls `random()`, `now()` or `nextval()`, can still answer from the cache until `clearCache()`; run a statement wanted for its effect through `run`, or begin it with a word other than `SELECT`, such as `VALUES (nextval('ids'))`.
- `S3StorageProvider.list` (#64) answers every key under the prefix: it sends `ListObjectsV2` again with each page's `NextContinuationToken` until a page is not truncated. It answered the first page alone.

## [0.7.15] - 2026-10-17

### Added
- `PostgresExporterOptions`, the second argument of `new PostgresExporter(connectionString, { schema })`: `schema` exports one schema alone, by its exact name (`pg_dump --schema`). It is exported from the root and `./core`.
- `new PostgresExporter(connectionString)` also takes a function that gives the connection string when an export runs.
- `migrateIndexedDbKeyValue({ source, adapter, into })` in `./kv` (#63) moves one namespace of an old IndexedDB key-value store, the one `openIndexedDbStore` opens, into a `KeyValueStore` over an adapter, behind a marker (`MIGRATION_MARKER`), with the old store's writers locked out by the database's version. It answers `migrated`, `already`, `none` or `blocked`, resumes from the committed side after a reload, copies once when two moves run at once, and refuses a store that keeps nothing past the page.

### Changed
- `PostgresExporter` reads a `postgres://` or `postgresql://` connection string as libpq reads it, so the password reaches `pg_dump` through `PGPASSWORD`, off its command line, in every form libpq takes: an empty host (`postgresql://app:pw@/app?host=/var/run/postgresql`), several hosts, a `#` or `?` in the password, and a `password` parameter, which libpq takes over the user part's password. 0.7.12 read the string with the WHATWG URL parser, which refuses the first three, so the export threw, and it left a `password` parameter on the command line. The scheme is read in any case, as pg reads it, and handed to `pg_dump` in lower case, the only case libpq reads.
- A failed `pg_dump` rejects with `pg_dump`'s own words and its exit code, never with the command line, which can hold a password. A missing `pg_dump` says to install the PostgreSQL client tools, and a dump larger than 256 MiB from `exportToBytes()` says to use `exportToFile()`.

### Fixed
- `createStorageFeatures(adapter).exporter` on a segmented PostgreSQL adapter dumps the segment's schema alone. It dumped every schema of the database: the other segments' tables and the host's in `public`.
- `createStorageFeatures(adapter).exporter` on an adapter made with a pool of the caller's reaches the database the pool was made for, through the settings a `pg` `Pool` keeps as its `options`. It had no connection string, so both export methods always threw. A pool whose settings name no database says so.
- `createStorageFeatures(adapter).exporter` names the PostgreSQL adapter's database when an export runs, from the pool the adapter runs on. An adapter given its connection string at `open()` had none to export with, and one opened on another connection string than its options held exported the database of its options.
- The exporter of a PostgreSQL adapter or pool whose `host` is a Unix-socket directory (`/var/run/postgresql`) reaches the database through it: the path went into the connection string unencoded, where libpq read it as the database name. A password given with no user name reaches `pg_dump` too.
- A segmented PostgreSQL adapter's `open()` fails when the segment is not the current schema of its first connection, and says what to grant. PostgreSQL leaves a schema the role has no `USAGE` privilege on out of the `search_path` without a word, so on an existing schema another role made, the segment's statements read and created tables in `public`. A pooler that drops startup options did the same.
- `resolveStorageAdapter()` and `createDatabase()` refuse a segment name in `postgres`, `indexedDb` or `capacitor` that cannot be a segment before any adapter is tried, as they refuse their own. A candidate whose options name no segment, tried after a candidate whose options named one, opens in that segment: without `strict`, an unreachable PostgreSQL with `postgres.segment` fell through to better-sqlite3 on the shared file, outside the segment.
- IndexedDB adapter: a PRAGMA through `all()` or `get()` that sets `user_version`, `application_id`, `schema_version`, `page_size`, `auto_vacuum` or `encoding`, or runs `incremental_vacuum` or `optimize`, is saved. SQLite's `total_changes()` counts no PRAGMA, so `get('PRAGMA user_version = 3')` was stored neither with `durability: 'commit'` nor by `flush()` or `close()`. PRAGMA reads and connection settings still write nothing.
- `createSqlKeyValueStore()` refuses a `Proxy` with a `DataCloneError`, as the structured clone and IndexedDB's put do. A proxy reads as the object it wraps to every check but the runtime's own `structuredClone`, which now runs first, so `set()` stored `new Proxy({ x: 1 }, {})` as `{ x: 1 }`.

## [0.7.14] - 2026-10-17

### Fixed
- `PostgresFts.createIndex`: of two first opens that both find no GIN index, the later one no longer rejects. Its `CREATE INDEX` shares the earlier one's SHARE lock, builds an index of its own and fails on `pg_class`'s unique name (`23505`) once the earlier one commits; the index block now takes that failure, or `duplicate_table`, as the index made.

## [0.7.13] - 2026-10-17

### Added
- `memoryOnly: true` on the IndexedDB adapter keeps the database in memory alone, for a browser that refuses IndexedDB (a private window, a blocked storage setting): IndexedDB is never opened, nothing is stored, and `capabilities` carries no `persistence`.
- `reload()` on the IndexedDB adapter puts the stored image in place of the one in memory, whatever the version stamp says, and resolves with whether anything changed. A caller whose durable commit IndexedDB refused runs it before its next statement; a connection without `crossTab` runs it to read what another connection stored.
- `crossTab: { rollbackRefusedSaves: true }` on the IndexedDB adapter reads the stored image back inside the lock when IndexedDB refuses a save made under the coordination, so a statement already waiting on the lock does not store the refused writes with its own. The call still rejects.

### Fixed
- `PostgresFts.createIndex` reads the catalog before it alters the table or creates the index, so an open that finds the `_tsv` column and the GIN index takes no lock on the table beyond the backfill's ROW EXCLUSIVE. `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` took ACCESS EXCLUSIVE, and `CREATE INDEX IF NOT EXISTS` took SHARE, before reading `IF NOT EXISTS`: an open behind a long read of the table (an export, `pg_dump`, a report) queued, and every later read and write of the table queued behind it until the read ended. The two statements run in `DO` blocks that check `pg_attribute` and `to_regclass` first. The script keeps its three statements; run it with `exec()`, since a split on `;` would cut the blocks.
- Without `crossTab`, a `durability: 'commit'` write or a `flush()` on the IndexedDB adapter still waiting for the save of a write that `reload()` puts back rejects instead of resolving as stored.

## [0.7.12] - 2026-10-16

### Security
- `PostgresExporter` starts `pg_dump` with `execFile` and an argument array instead of a shell string, so a quote, `$(...)` or `;` in the output path or the connection string can no longer run a command; a `postgres://` URL's password reaches `pg_dump` in `PGPASSWORD` and no longer shows in the process list. `pgDumpInvocation(connectionString, outputPath?)` builds the invocation.

### Fixed
- The Electron main adapter's cloud backup doubles the quotes of its `VACUUM INTO` path, so a database under a folder with an apostrophe backs up.

## [0.7.11] - 2026-10-16

### Added
- Row-change events: `withChangeEvents(adapter)` adds `onChange(listener, { tables })`, which reports each INSERT, UPDATE, DELETE and TRUNCATE made through the adapter (`run`, `batch`, `get`, `all`, `exec`, `transaction`, `withConnection`) once it commits, with the table, the operation and, from `run` and `batch`, the count. A rolled-back transaction reports nothing.
- PostgreSQL notifications between sessions: `PostgresAdapter.listen(channel, handler)` and `notify(channel, payload)`. The listening connection is taken again when the server ends it.
- `changeNotificationSql(table, channel)` on the dialects: on PostgreSQL a statement-level trigger that sends `{"schema", "table", "operation"}` on the channel for each write to the table from any session; null on SQLite.

## [0.7.10] - 2026-10-16

### Fixed
- Make syncIdentitySequence optional on the exported SqlDialect interface, with conditional callers, so existing custom dialects still compile. Correct README identity widths, rowid scope, sequence state and date semantics.
- Map empty PostgreSQL array defaults to JSON arrays, preserve case-sensitive SQLite strftime directives, and store PostgreSQL NUMERIC values and literal defaults as SQLite text without affinity rounding.
- Keep PostgreSQL sequence allocation from moving backwards in imports, SQL dumps and the dialect helper; preserve SQLite AUTOINCREMENT high-water marks, including empty tables and deleted ids.
- Exclude GENERATED ALWAYS identities from PostgreSQL conflict updates while allowing explicit identity values on new rows.
- Export explicitly selected SQLite and PostgreSQL views without querying unavailable rowid or ctid columns.
- Convert SQLite boolean defaults on numeric columns to numbers and omit invalid calendar defaults with warnings before PostgreSQL table creation.
- Make PostgreSQL SQL dumps load into existing ALWAYS identities; retain column metadata and sequence synchronization when includeSchema is false.
- Read PostgreSQL primary keys from pg_index so SELECT-only source roles preserve single and composite keys.
- Include SQLite FTS rowids in exports so sparse external-content indexes retain their row associations after copies and SQL reloads.
- Encode PostgreSQL JSON arrays and scalar values as JSON in copies and SQL dumps.
- Recognize PostgreSQL 18 virtual generated columns, preserve their expressions and omit their values from inserts; exercise migrations on PostgreSQL 16 and 18 in CI.
- Load SQLite foreign keys independently of row order, check references after import, and restore enforcement on failure.
- Report insert failures under ignore and replace instead of silently dropping rows.
- Preserve PostgreSQL date and zone-less timestamp fields in SQL dumps and copies under non-UTC process time zones.

## [0.7.9] - 2026-10-16

### Added
- `autoIncrementPrimaryKey({ acceptExplicitIds: true })` on the dialects: on PostgreSQL an identity `GENERATED BY DEFAULT`, which takes an id an insert gives. The default stays `GENERATED ALWAYS`.
- `syncIdentitySequence(table, column)` on the dialects: the statement that moves an identity or serial column's sequence past the largest id (PostgreSQL `setval`; null on SQLite).
- `ExportedData.dialect`, and on each table's schema its primary key, the columns the engine fills or generates, and on SQLite the `CREATE TABLE` statement it keeps.
- `importData` and `migrateAdapter` options `columnTypes` (a column's target type) and `sourceDialect` (for an export without `dialect`), and `warnings` on the result.

### Changed
- `migrateAdapter` and `importData` create the target engine's table: its types, the defaults it has a form of, NOT NULL and the primary key, with a column the source engine fills made an identity on PostgreSQL or an `INTEGER PRIMARY KEY AUTOINCREMENT` on SQLite. They copied the source's types and defaults as written and dropped the primary key, so a SQLite table failed on PostgreSQL (`DATETIME`, `BLOB`, `datetime('now')`) and a PostgreSQL one on SQLite (`::` casts, `nextval`).
- SQLite to SQLite recreates each table from the statement SQLite keeps for it, with its keys, `AUTOINCREMENT`, constraints and generated columns. PostgreSQL to PostgreSQL keeps each exact type (`character varying(20)`, `integer[]`), makes a serial an identity, and regenerates a generated column.
- On PostgreSQL, rows keep their ids in an identity `GENERATED ALWAYS` (`OVERRIDING SYSTEM VALUE`), and each identity or serial column that took ids has its sequence moved past them. Text without a zone goes into a `timestamptz` column as UTC. A source column matches a target column of another case.
- `onConflict: 'ignore'` and `'replace'` write `ON CONFLICT` on PostgreSQL. They wrote SQLite's `INSERT OR IGNORE` and `INSERT OR REPLACE`, which failed there, and the failures were skipped without a word, so nothing was imported.
- `rowsImported` counts the rows written, leaving out those `onConflict: 'ignore'` skipped.
- `exportData` pages through each table in primary-key order (else rowid or ctid), so no row repeats or goes missing between pages, and leaves out the shadow tables of a SQLite virtual table.
- `exportAsSQL` writes the primary key and identity columns, leaves generated columns out of its inserts, and moves PostgreSQL sequences past the inserted ids. Its values load back on their engine: bytes as a blob or bytea literal (they were written as text), booleans as `TRUE` and `FALSE` on PostgreSQL, arrays as array literals in PostgreSQL array columns, and other objects as JSON (they were written as `[object Object]`).
- A column the target engine cannot fill (a PostgreSQL identity outside the primary key, on SQLite) is created nullable, so rows that leave it out can still be inserted.

## [0.7.8] - 2026-10-16

### Added
- `batch()` on the PostgreSQL adapter, with `batch` in its capabilities: the operations run in one transaction, each under a savepoint, and the batch goes on past one that fails, as the better-sqlite3 adapter's does. The result has the same shape, a failure of the transaction itself included (index -1). A transaction handle's `batch()` runs in that transaction; a held connection's runs in a transaction of its own.
- `registerFunction(name, fn, { deterministic })` on the better-sqlite3, sql.js and IndexedDB adapters: a JavaScript function callable from SQL. The sql.js and IndexedDB adapters register it again each time sql.js reopens the connection (a save, an export, an import), which drops it.
- `ensureColumnExists(db, table, column, definition)`, named under 0.5.2 below and missing from the package since: it adds a column when the table lacks it, on PostgreSQL and SQLite, and says whether it did.

### Changed
- `pg` is listed once, as a dependency. It was also an optional peer dependency.

## [0.7.7] - 2026-10-16

### Added
- Lifecycle hooks around an adapter's calls: `withHooks(adapter, hooks)` on any adapter, and `createDatabase({ hooks })`.
  - The `StorageHooks` the package exported now run: `onBeforeQuery`, `onAfterQuery`, `onBeforeWrite`, `onAfterWrite`, `onBeforeTransaction`, `onAfterTransaction` and `onError`.
  - A `before` hook returning undefined stops the call, as `combineHooks` already read it.
  - The statements inside a transaction pass through the hooks too.
  - The adapter keeps its kind, its own methods and its class.
  - The performance tiers stay types for a host to apply.

## [0.7.6] - 2026-10-16

### Deprecated
- `SupabaseAdapter`. The PostgreSQL adapter reaches Supabase with its connection string (`createPostgresAdapter({ connectionString, ssl: { rejectUnauthorized: true, ca } })`), with pool control, transaction error handling and `strict` resolution. `open()` says so once per process through the host logger, and adds that `SupabaseAdapter` does not verify the server certificate unless `ssl` is `{ rejectUnauthorized: true, ca }`.

### Fixed
- `SupabaseAdapter` reads `?` and `@name` placeholders as the PostgreSQL adapter does, in and out of a transaction. It passed the statement to pg as written, so a `?` failed with a syntax error and named parameters were dropped.
- `SupabaseAdapter` keeps PostgreSQL's error code (`code`) and the database error (`cause`) on the errors it throws, so `isUniqueViolation` reads a duplicate. It threw a new Error carrying only the message.
- `SupabaseAdapter` passes an `ssl` object it is given to pg. It replaced any `ssl` option other than `false` with `{ rejectUnauthorized: false }`, so certificate verification could not be turned on.

## [0.7.5] - 2026-10-16

### Added
- `SqliteFts4`, the full-text search `createStorageFeatures` gives sql.js and the IndexedDB adapter.
- `relevanceOrder(indexName, placeholder)` on every full-text search: an ORDER BY fragment that puts the best match first on every engine.
- `weights` in the PostgreSQL `createIndex` config: a weight per column (A to D) that `ts_rank` uses.

### Changed
- `createStorageFeatures` gives sql.js and IndexedDB FTS4, where it gave FTS5. Their stock sql.js build has no FTS5, so every FTS5 statement there failed with "no such module: fts5".
- `createStorageFeatures` treats the Supabase adapter (`supabase-postgres`) as PostgreSQL: the PostgreSQL dialect, full-text search and exporter, where it gave the SQLite ones.
- PostgreSQL full-text queries use `websearch_to_tsquery` instead of `plainto_tsquery`. Words are still ANDed, but `or`, `-word` and quoted phrases are now operators.
- `PostgresFts.sanitizeQuery` returns the words quoted and joined with `or`, as the SQLite implementations join them with OR, where it returned the text unchanged.

### Fixed
- `PostgresFts` kept each index's table, columns and language on the instance, from the last `createIndex` call. A second index with another tokenizer changed the first one's language, and a features object made later built `UPDATE  SET ...` with no table for `rebuildCommand` and `syncInsert`. The description of each index is now kept per index for the process, and a rebuild or sync of an index no `createIndex` described throws an error that says so.

## [0.7.4] - 2026-10-16

### Added
- An Auth.js database adapter: `createAuthJsAdapter(db, { tablePrefix?, generateId? })`, with `ensureAuthJsTables()` and `authJsTablesSql()`, from `./authjs`, `./core` and the root.
  - It keeps users, accounts, sessions and verification tokens in text-keyed tables (`auth_` by default) on PostgreSQL or SQLite.
  - It has the shape of `@auth/core`'s `Adapter` (CI type-checks it against `@auth/core`), with no dependency on it.
  - `deleteUser` removes the user's sessions and accounts in one transaction, and `useVerificationToken` deletes and returns a token in one statement.
  - Auth.js's own adapter test suite, vendored with its ISC notice, runs against it on PostgreSQL, better-sqlite3 and sql.js.
  - WebAuthn authenticators are not stored.

## [0.7.3] - 2026-10-15

### Added
- Per-adapter entries (`./postgres`, `./better-sqlite3`, `./sqljs`, `./indexeddb`, `./capacitor`), `./backup`, and an adapter-free `./core`. A server that takes its adapter from its own entry, with the rest from `./core`, bundles neither sql.js nor `@aws-sdk/client-s3`. The root entry imports every adapter, as before.
- `./electron/renderer`: the renderer adapter alone, with nothing from the main process.
- A CommonJS build. Every entry has a `require` condition to `dist/cjs`, transformed from the ES module build file by file and carrying its own declarations, and `main` points at it. `require('@framers/sql-storage-adapter/electron/preload')` gives one bundled CommonJS file that requires only `electron`, as a sandboxed preload must.

### Changed
- `@capacitor-community/sqlite` is accepted as a peer at `^6.0.0 || ^7.0.0 || ^8.0.0`. The connection calls the adapter makes are the same in 7 and 8.
- `sideEffects` names the preload files, which expose their API on import. With `sideEffects: false` a bundler could drop `import '@framers/sql-storage-adapter/electron/preload'`.

## [0.7.2] - 2026-10-15

### Added
- A versioned schema-migration runner: `runSchemaMigrations(adapter, migrations, options)`, `schemaMigrationStatus()` and `readSchemaMigrations(dir, { dialect })`, on PostgreSQL and SQLite.
  - Files run in number order, each in its own transaction, and are recorded in a configurable ledger (`table`, `checksumColumn`) with the SHA-256 of their text.
  - The runner refuses an applied file whose text changed, and a ledger row the list lacks unless `unknown: 'ignore'`. It stops at the first error, which names the file.
  - On PostgreSQL each file takes a transaction-scoped advisory lock (`lockKey`) and checks the ledger again under it, so two runners at once apply each file once. On SQLite the write transaction is the lock.
  - A file marked `-- outside transaction` runs outside one, on PostgreSQL under the session lock on a held connection.
  - Existing ledgers with a name and a SHA-256 column, such as `schema_migrations(name, checksum)` or `_migrations(name, content_hash)`, are read as they are.

## [0.7.1] - 2026-10-15

### Added
- `SqlDialect` additions, each returning the same rows on PostgreSQL, better-sqlite3 and sql.js:
  - `upsert(table, columns, placeholders, conflictColumns, updateColumns?)`: `ON CONFLICT (...) DO UPDATE`, updating the row in place, or `DO NOTHING` when every column is in the conflict target.
  - `now()`, `addInterval(expr, amount, unit)` in exact seconds, minutes, hours or days, and `dateBucket(unit, expr)` as ISO 8601 UTC text. Times on SQLite are ISO 8601 UTC text with milliseconds, the form a bound Date takes.
  - `ilike`, `inList` (an empty list matches nothing), `inArray` over one bound array, and `jsonArrayContains`.
  - `jsonExtractAs(column, path, type)` for text, integer, real or JSON, from a checked path (`$.a.b`, `$.a[0]`).
  - `rowLock(mode, wait?)` (`FOR UPDATE` and `FOR SHARE`, with `SKIP LOCKED` or `NOWAIT`) and `advisoryTransactionLock(key)`. They give an empty clause and null on SQLite.
  - `greatest` and `least`, which skip NULLs on SQLite as on PostgreSQL.
  - `cast(expr, type)` for text, integer, real and timestamp, and `uuid()` (version 4).
  - `columnType(kind)` for DDL.

### Changed
- `SqliteDialect.insertOrReplace` updates the existing row in place (`ON CONFLICT (key) DO UPDATE`), as the PostgreSQL dialect does. `INSERT OR REPLACE` deleted the conflicting row first, which fired `ON DELETE` actions on its dependents (a cascade deleted them) and reset the columns the statement did not name. A conflict on a unique column other than the key now fails, where REPLACE deleted that row too.
- `insertOrReplace` and `upsert` with every column in the conflict target give `DO NOTHING`. The PostgreSQL dialect gave an empty `DO UPDATE SET`, which PostgreSQL refuses.
- `SqlDialect` has the members above; a custom implementation of the interface needs them.

### Fixed
- better-sqlite3 binds a JavaScript integer as an INTEGER. It bound every number as a REAL (`sqlite3_bind_double`), so 7 reached SQL as 7.0: `CAST(? AS TEXT)` gave `'7.0'`, a TEXT column stored `'7.0'`, and a comparison with a JSON element missed. Safe integers now bind as INTEGER, as on sql.js. On sql.js, an integer outside the 32-bit range still binds as a REAL.

## [0.7.0] - 2026-10-15

### Added
- Segments. A `segment` option on `createDatabase()`, `resolveStorageAdapter()` and each adapter keeps one user's tables apart from another's in a database they share. On PostgreSQL a segment is a schema of its own: every connection of the adapter's pool starts with `search_path` set to the segment, then `public`, as a startup option (`-c search_path=<segment>,public`), so a connection the pool opens to replace one the server ended starts in the segment too, `RESET search_path` and `DISCARD ALL` return to it, and the types and operators of extensions in `public` (pgvector's `vector` and `<->`) resolve. `open()` creates the schema when it is missing, and `PGOPTIONS` is kept beside the segment's option. `transaction()` and a `withConnection()` connection run in the segment. On better-sqlite3, sql.js and the Electron main adapter a segment is a file of its own (`app.sqlite3` becomes `app-agentos.sqlite3`; `:memory:` stays as it is), and on IndexedDB and Capacitor a database name of its own (`app-db` becomes `app-db-agentos`). A segment name is lower-case letters, digits and underscores, at most 63 characters, and not `public`, `information_schema` or a name beginning with `pg_`; another is refused before any adapter is tried, and so is a segment given with a pool of the caller's (`postgres.pool`), which a resolution without `strict` would otherwise have passed over for a local file in the segment. `segmentName()`, `segmentFilePath()` and `validateSegment()` are exported. A segmented Electron main adapter leaves the renderer's IPC channels, one set per process, to the adapter without a segment.
- On a segmented PostgreSQL adapter, a `CREATE EXTENSION` that names no schema installs the extension into `public`, where every segment and the host find it, instead of into the segment, where only that segment would: through the adapter, inside a transaction (the rest of the transaction stays in the segment) and on a `withConnection()` connection. When an extension a segment asks for is already installed in a schema its `search_path` does not reach, the adapter warns once, through the host logger, and names the `ALTER EXTENSION ... SET SCHEMA public` that moves it. A connection whose BEGIN or ROLLBACK fails around such a statement, or whose `search_path` cannot be set back, is closed instead of returned to the pool.
- The Postgres adapter runs on a pool its caller made: `createPostgresAdapter({ pool })` or `new PostgresAdapter({ pool })`, from the start, with no `open()` needed. `close()` leaves that pool open unless `ownsPool: true` is given, in which case `close()` ends it once, however often it is called; `open()` after `close()` takes the pool up again. `onError` receives the errors an idle connection of the pool reports, `getPool()` returns the pool the adapter runs on, and `getPoolStats()` counts a pool of the caller's as it counts one the adapter made. The settings that configure a pool when one is made (`allowExitOnIdle` and `typeParsers` among them), and `segment`, are refused with `pool`: set them on the pool (`typeParsers` as its `types`). `createDatabase({ postgres: { pool } })` opens PostgreSQL on it. A host that wrote its Pool into the adapter's `pool` field before `open()`, as hosts on 0.6 did, keeps working: the adapter runs on it and ends it on `close()`, as 0.6 did. `PostgresPoolLike`, `PostgresPoolClientLike` and `PostgresQueryResultLike` describe the part of pg's `Pool` the adapter uses.
- IndexedDB adapter: `durability: 'commit'`. `run()`, `exec()`, a write through `all()` or `get()` (`INSERT ... RETURNING`) and `transaction()` resolve once their write is committed in IndexedDB, on the IndexedDB transaction's `complete` event, and reject when IndexedDB refuses or aborts it; the write stays in the database and the next save stores it. While a transaction begun with `BEGIN` is open, its statements resolve at once and its rows are stored when its `COMMIT` resolves. `'interval'`, the timer, stays the default.
- IndexedDB adapter: `flush()` stores every write made so far: it waits for an open `transaction()`, resolves at once when nothing is waiting, and rejects while a transaction begun with `BEGIN` is open, which sql.js's export would end.
- IndexedDB adapter: `crossTab`, so two tabs of a site on one database keep each other's writes. Every statement and transaction runs under a Web Lock on the database, on the newest stored image, and is stored before the lock is let go; a version stamp stored beside the image tells a tab that another has saved, and the tab reloads before it reads or writes. Where the browser has no Web Locks (Safari before 15.4, an insecure origin, WebKit's Lockdown Mode), the stamp alone keeps both tabs' writes: a statement that finds another tab saved first runs again on that tab's image, and a `transaction()` another tab saved over is refused with `IndexedDbConflictError`, storing nothing of it. `crossTab: { locks }` takes a lock manager of the caller's (`IndexedDbLockManager`), and `crossTab: { locks: null }` the stamp alone. Every save writes the stamp, with `crossTab` or without.
- `@framers/sql-storage-adapter/kv`, a module that imports no adapter: the `KeyValueStore` contract (`get`, `set`, `delete`, `keys(prefix)`, `deletePrefix(prefix)`, `memoryOnly`), `namespaced()`, `MemoryKeyValueStore`, and `openIndexedDbStore()` and `IndexedDbKeyValueStore` with `idb()` and their IndexedDB shapes, moved unchanged from @framers/agentos `src/core/storage/browser`, so a page's database, object store, version and keys stay where they are. `createSqlKeyValueStore(adapter, { table })` keeps the same contract in a SQL table on any adapter: keys in the order IndexedDB gives them, prefixes read literally, and each value kept as text that comes back as the structured clone gives it back (`undefined`, `-0`, `NaN`, bigints, dates, regular expressions, maps, sets, buffers and views, boxed primitives, errors, shared references and cycles); a value the structured clone refuses, or a host object text cannot hold, is refused with a `DataCloneError` before anything is written.

### Changed
- `createDatabase()` in a browser keeps the database in IndexedDB: it chooses `['indexeddb', 'sqljs']`, as the resolver does, where it chose `['sqljs']`, a database in memory that a reload lost. `createDatabase({ file: ':memory:' })` and `createMemoryDatabase()` keep sql.js in memory, and in a Capacitor app on a phone `createDatabase()` chooses `['capacitor', 'indexeddb', 'sqljs']`, as the resolver does. The `indexedDb` options reach the IndexedDB adapter whole, through the resolver too: `durability`, `crossTab`, `segment` and the rest.
- The Postgres adapter listens for the errors idle connections of a pool it makes report, and logs a warning through the host logger (`setStorageLogger()`) when no `onError` was given. pg raises such an error (the server ended the connection, the network dropped) as an event that ended the process when nothing listened.
- A Postgres `open()` that cannot connect ends the pool it made and holds none, so a later `open()` starts again; two `open()` calls at once open once, and two `close()` calls at once close once.
- CI's PostgreSQL service is the pgvector image (`pgvector/pgvector:0.8.7-pg16`), and a `browser` job runs the IndexedDB adapter's and the key-value module's specs in Chromium and WebKit through Playwright (`@vitest/browser` and `playwright` are dev dependencies). The NodeNext consumer check type-checks a pg `Pool` against the `pool` option and imports `@framers/sql-storage-adapter/kv`.

### Fixed
- `exportData()` on PostgreSQL exports the tables of the current schema, the segment's on a segmented adapter, and reads each table's columns from that schema alone, in their order. It listed `public`'s tables, and read the columns of every table of that name in any schema.
- IndexedDB adapter: a save keeps the connection settings a caller made (`PRAGMA foreign_keys = ON` and the rest). sql.js's `export()`, which every save runs, closes the connection and opens it again, which reset them. A write made through `all()` or `get()` outside a transaction is saved, and `importDatabase()` refuses bytes that are not a SQLite database, keeping the database it had.
- Electron main adapter: `run()` resolves with its result. It threw a `TypeError` after every write while multi-window broadcasting was on, the default: three of the patterns that find the statement's tables for the broadcast lacked the global flag `matchAll()` needs.
- sql.js adapter: `open({ filePath: ':memory:' })` keeps the database in memory. It wrote it to a file named `:memory:` in the working directory, which every such adapter then shared.

## [0.6.16] - 2026-10-15

### Added
- `typeParsers` on the PostgreSQL adapter's options sets, per pool, how int8 (`'string'`, `'number'` or `'bigint'`), numeric (`'string'` or `'number'`), date (`'date'` or `'string'`) and json/jsonb (`'parse'` or `'string'`) come back, through pg's per-client type parsers. pg returns int8 and numeric as strings and a DATE as a Date at local midnight. `'number'` for int8 refuses a value past `Number.MAX_SAFE_INTEGER`, and a value the option does not know fails `open()`. Left out, pg's defaults hold.
- A host logger. `setStorageLogger(logger)` routes the library's log lines to it, and `logger` on `createDatabase()` and `resolveStorageAdapter()` takes one call's resolver lines. Each line goes as a fields object and a message, which fits pino as it is (`StorageLogger`). The lines covered are the resolver's (the adapter chosen, each fallback with its error, the Electron hints), the PostgreSQL adapter's failed-ROLLBACK warning and the adapter base class's. `setStorageLogger(null)` writes to the console again, and the console lines read as before. The IndexedDB, Capacitor, sync and Electron modules write to the console directly.
- `foreignKeys` on `createDatabase()`, and on `StorageOpenOptions` for the resolver's `openOptions` and `open()`, sets SQLite's foreign-key enforcement (`true` on, `false` off) when better-sqlite3, sql.js, IndexedDB or Capacitor opens. Left out, each engine keeps its default, and they differ: better-sqlite3 is built with `SQLITE_DEFAULT_FOREIGN_KEYS=1` and enforces foreign keys, while sql.js, IndexedDB and Capacitor do not, so one schema behaved differently per engine. `foreignKeys: true` makes them agree. sql.js resets PRAGMAs whenever `export()` reopens its connection, on every save to a file or to IndexedDB, on `exportDatabase()` and on `importDatabase()`, so the sql.js and IndexedDB adapters apply it again after each. On Capacitor it runs outside the plugin's transaction, where SQLite ignores it. Each engine's default holds without the option, as before.
- `isUniqueViolation(error)` recognises a unique or primary-key violation from any adapter: PostgreSQL's SQLSTATE 23505, better-sqlite3's `SQLITE_CONSTRAINT_UNIQUE` and `SQLITE_CONSTRAINT_PRIMARYKEY`, and the "UNIQUE constraint failed" message from sql.js, IndexedDB and Capacitor. It follows `cause` up to ten levels and does not loop on a cycle, so an error a product wraps still counts.
- The SQLite adapters (better-sqlite3, sql.js, IndexedDB, Capacitor) take `$1`, `$2`, ... bound from a positional array, as PostgreSQL does, so one statement runs on both. SQLite reads `$1` as a named parameter: better-sqlite3 refused to bind it from an array ("Too many parameter values were provided"), and sql.js bound it in order of first appearance, so `$2, $1` got the values swapped. Each `$n` outside literals and comments becomes `?` with the values in `$n` order, repeats included. A statement that mixes `?` and `$n` is refused with an error.

### Changed
- On sql.js and IndexedDB, an array value binds as JSON text, as on better-sqlite3 and Capacitor. sql.js bound it as a blob of its elements.
- On PostgreSQL, a statement that already uses `$n` placeholders is sent as written, and a statement run without parameters keeps its `?`. Both were rewritten before, which broke the jsonb `?` operator in them.

### Fixed
- The SQLite adapters convert values as they bind them, positional and named. A boolean binds as 1 or 0, a Date as its ISO 8601 text (an Invalid Date is refused), an array or a plain object as JSON text, and undefined as NULL. better-sqlite3 threw "SQLite3 can only bind numbers, strings, bigints, buffers, and null" on booleans, Dates and objects. sql.js threw on a Date and bound an array as a blob.
- The IndexedDB adapter binds named parameters written `@id`, `:id` or `$id` from a bare-key object (`{ id }`), as the sql.js adapter does. It passed the object to sql.js as given, and sql.js binds a key only when it matches the placeholder as written, so every named value was NULL.
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
