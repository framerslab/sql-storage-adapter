# Mutation Sync Guide

The mutation sync keeps a set of named text rows the same on a server and in many browsers. Each browser writes its rows to its own database first and records each change as a mutation with an id of its own; the server runs every client's mutations in one order and settles each conflict by that order; each browser then pulls the server's state and replays the mutations the server has not answered on top of it, with the same functions the server runs. A save never waits on the network: a browser offline keeps saving and sends its mutations when it can.

The library holds the protocol: the wire contract and its parsers, the row mutations both sides run, the server over a store port, a reference SQL store, a drain gate, the client over any `StorageAdapter`, a fetch transport and a sync loop. The application holds its routes and its session, the codec that seals a value at rest, its own tables when it does not take the reference store, and the rows its pages show.

| Entry | Holds |
| --- | --- |
| `@framers/sql-storage-adapter/sync` | The whole protocol, the server's half included (0.7.17 and later) |
| `@framers/sql-storage-adapter/browser` | The page's half: the client and its parts, with the IndexedDB adapter, the key-value module and the tab lock. Its import graph holds no Node built-in and no pg (0.8.0 and later) |

## Table of Contents

- [Terms](#terms)
- [The row mutations](#the-row-mutations)
- [The server](#the-server)
- [Content revisions, amend and claim](#content-revisions-amend-and-claim)
- [The client](#the-client)
- [The transport and the loop](#the-transport-and-the-loop)
- [The browser's storage](#the-browsers-storage)
- [Moving an old key-value store](#moving-an-old-key-value-store)
- [A server and its routes](#a-server-and-its-routes)
- [A page](#a-page)

## Terms

- **Scope**: what owns one set of rows, such as an account or a workspace. A server takes it from the request's session, never from its body.
- **Group**: one activation of sync for a scope, named by a 32-character lower-case hexadecimal id. A scope has one group at a time; turning sync off removes it, and turning sync on again makes a new one.
- **Client**: one browser profile in a group, with a 32-character hexadecimal id made at its join. Its mutation ids start at 1 and rise by one.
- **Row**: an id of 32 lower-case hexadecimal characters and a text value, opaque to the library: it compares values and counts their length, and reads nothing in them. A row is live, a tombstone (deleted, and kept for the group's life, so its id is never used again), or unreadable (the server holds it, and its codec cannot open it).
- **Revision**: the identity of the mutation that last changed a row, a client id and a mutation id. No order in the protocol reads a clock.
- **Version and cookie**: the group's version rises by one with each push that processes a mutation and with each tombstone a replay writes, and every row records the version that wrote it. A client's cookie is the version its copy of the rows reflects; a pull sends it and gets back what changed after it.
- **Epoch**: a 32-character hexadecimal id the deployment keeps and changes each time it restores its database from a backup. A request made under another epoch is answered `epoch_changed`, and the client recovers ([restores](#restores-the-epoch-and-the-journal)).

Mutation ids, versions and cookies travel as decimal strings and are read back as safe integers: `readCounter`, `writeCounter` and `nextCounter` throw `CounterError` for anything else.

## The row mutations

Four mutations change rows in every protocol, and protocol 2 adds `amend` and `claim` ([content revisions, amend and claim](#content-revisions-amend-and-claim)). The server runs them inside each push's transaction, and the client runs the same function, `applyRowMutation`, to replay its unanswered mutations over the server's state.

| Mutation | Arguments | Effect |
| --- | --- | --- |
| `create` | `id`, `value` | Writes the row when its id is unused. A live row holding the same value makes it a no-op; beside a live row holding another value, or an unreadable row, the value is kept as a copy; a deleted id is refused `removed`. |
| `edit` | `id`, `expected`, `value` | Replaces the row, an unreadable one included, when its revision is `expected`. At another revision, a live row holding the same value makes it a no-op, and the value is kept as a copy otherwise, beside an unreadable row too; a missing or deleted row is refused `removed`. |
| `delete` | `id`, `expected` | Leaves a tombstone when the row's revision is `expected`, or when the row is missing; a tombstone already there is a no-op. At another revision it is refused `stale`, so a late delete never removes an edit its sender had not seen. |
| `repair` | `id`, `expected`, `value` | Replaces an unreadable row at exactly `expected`. It is refused `stale` when the row is missing, live, deleted or at another revision. |

A copy goes under an id every side derives alike, the first 32 hexadecimal characters of SHA-256 over `copy:v1:<group>:<client>:<mutation id>` (`copyIdOf`), with the value `policy.copyValue(value)`; when a row already holds that id, the mutation is a no-op. An edit or a delete whose `expected` names an earlier mutation with a recorded result acts where that result landed: on the copy it made, or at the revision its no-op found on the row. An edit that follows its earlier mutation to a copy keeps the copy's naming.

The application sets the limits in a `RowPolicy`:

- `maxRows`: the most rows that are not tombstones, copies and unreadable rows included. A create or a copy past it is refused `full`.
- `maxUnits`: the longest value, in UTF-16 code units. A longer value, or a longer copy value, is refused `too_long`.
- `copyValue(value)`: the value a copy is kept under, so a person can tell the two apart.

A refusal is final: the mutation's id is consumed, its result recorded, and the client keeps the refused value in the browser ([kept rows](#kept-rows)). Give the server and its clients the same policy: a client's replay then decides as the server does.

`planRowChanges(before, after)` makes the mutations that take one set of rows to another, which is how a save plans them: a create for a new id, an edit at the revision a changed row was shown at, and a delete at that revision for a row `after` no longer holds. It throws `DuplicateRowId` when `after` names an id twice.

## The server

```typescript
const server = new MutationServer({ adapter, store, codec, policy, maxMutations });
```

| Option | What it is |
| --- | --- |
| `adapter` | The `StorageAdapter` the store's tables live in. Every push, pull and replay is one `transaction()` of it. |
| `store` | A `MutationServerStore`: the reference SQL store (`createSqlMutationStore`) or the application's own. |
| `codec` | A `ValueCodec`: `seal(value, { scope, id })` before a value is stored, and `open(stored, { scope, id })` when it is read. `open` throws `UnreadableValue` for a value it cannot open, and the row is then unreadable, never absent. A codec that encrypts can bind each value to its scope and id as authenticated data, so a value moved to another row opens nowhere. |
| `policy` | The `RowPolicy`. |
| `maxMutations` | The most mutations one push may carry. |
| `pullBatchRows` | The most rows one read of a pull takes (200). |
| `maxPullMs` | How long a pull may run, counted from its call (120,000; `Infinity` sets no limit). |
| `protocols` | The protocols a request may speak (`[1, 2]`); a request in another is answered `protocol_changed` ([protocol 2](#protocol-2-and-protocols)). |
| `clock` | The time a push or a replay records (`new Date()`). |

`server.parsePush(body)` reads a push's parsed JSON: one to `maxMutations` mutations, their ids at least 1 and strictly rising, each a known mutation with its arguments' shape. `parsePullRequest(body)` reads a pull's. Both refuse a stray key, an id that is not 32 lower-case hexadecimal characters and a counter that is not decimal text, with a `WireError` whose `field` names where the body failed and never what it held. A push in a protocol the server does not take is read without its mutations' arguments, so `push` answers it `protocol_changed`.

A route gives each call a `ScopeContext`: the `scope` of the request's session and the deployment's `epoch`.

### Push

`server.push(context, request, hooks?)` answers:

- `{ kind: 'epoch_changed', epoch }` when the request's epoch is not the deployment's, before any transaction;
- `{ kind: 'group_gone' }` when the scope has no group, or another one;
- `{ kind: 'gap', expected }` when a mutation's id passes `expected`, the id the server takes next; nothing of the batch is written;
- `{ kind: 'ok', processed }` otherwise.

It runs in one transaction, holding the store's lock on the group's row. It reads the client's last processed id and skips every mutation at or below it, so a push sent again after a lost answer applies nothing twice. It decides the rest in order, and writes their effects, every result, the client's last id and the group's new version together. A refusal is a result like any other and consumes its id; any other failure, a throw from the store or the codec included, rolls the whole push back. A push that only repeats processed ids writes nothing.

`hooks`:

- `beforeWrite(trx, plan)` runs inside the transaction of a push that processes a mutation, once every mutation is decided and before anything is written. `plan.acceptedDeletes` lists each delete the push accepted (the row's id, the deleting revision and its time), for an application that records each accepted delete outside the database to replay it after a restore. A throw rolls the push back.
- `afterCommit(plan)` runs after the commit.
- `signal` aborts the push between mutations, and the push rolls back.

### Pull

`server.pull(context, request, signal?)` answers a refusal or a stream, and rejects at once when `signal` is already aborted:

- `{ kind: 'epoch_changed', epoch }`, before any transaction;
- `{ kind: 'group_gone' }`, or `{ kind: 'cookie_ahead' }` when the request's cookie is past the group's version, from the group's row alone;
- `{ kind: 'stream', chunks, done }`: the answer as one JSON text in chunks, read from one transaction. It holds the group's version as the new cookie; the rows written after the request's cookie, or every row for a `null` cookie (`full: true`), in batches of `pullBatchRows` ordered by id; then this client's results written after the cookie, and every client's last processed id. A deleted row travels as `del` with its deletion time, and a row the codec cannot open as `unreadable`.

The transaction stays open until the consumer takes the last chunk. Aborting `signal`, calling the iterator's `return` (a `for await` that breaks, a response stream that is cancelled) or reaching `maxPullMs` cancels the stream: the transaction rolls back, and the consumer's next read rejects. `done` settles once the transaction has ended, however it ended, and never rejects. A route that opens a stream reads it to its end or calls `return`.

### Replaying a tombstone

`server.replayTombstone({ scope, group, id, revision, deletedAt })` writes a deletion's tombstone again after a restore: a new tombstone takes the given revision and the group's next version, so every client's next pull carries it, and the call answers `written`; a row already deleted stays as it is (`kept`); another group changes nothing (`group_gone`). No client's last id moves.

### The reference store

`createSqlMutationStore({ prefix, lockTimeoutMs? })` keeps the server's state in four tables, `<prefix>groups`, `<prefix>rows`, `<prefix>clients` and `<prefix>results`, on SQLite and PostgreSQL alike; `mutationStoreDdl(prefix)` answers the statements that make them, and `upgradeSqlMutationStore(adapter, prefix)`, run after them on every start, brings tables an earlier release made to this one ([upgrading](#upgrading)). The prefix is a lower-case SQL identifier ending in an underscore. `createSqlGroup(adapter, prefix, scope, group)` gives a scope its group at version 0, and `dropSqlGroup(adapter, prefix, scope)` removes a scope's group with its rows, clients and results in one transaction. On PostgreSQL a push or a replay locks the group's row `FOR UPDATE` and waits at most `lockTimeoutMs` (3,000) for a lock, and a pull reads in REPEATABLE READ, so every batch sees one snapshot while pushes commit.

An application with tables of its own implements `MutationServerStore` on them. The server calls each method with the transaction handle it runs in, and calls `begin(trx, purpose)` first in every transaction (`push`, `pull` or `replay`) to set its isolation and lock timeouts.

### The drain gate

`DrainGate` holds a server's sync requests while they run, so a deletion can stop them before it removes a scope's rows:

- `gate.enter(keys, cancel)` admits a request under its keys (a scope's, a group's) with a function that cancels it, and answers a lease to `release()` when the request ends. It throws `GateBlocked` while a deletion holds any of the keys.
- `gate.block(key)` turns new requests under the key away and cancels the ones inside at once; a cancel that throws is logged, and the block goes on. Its `drain(deadlineMs)` answers `drained` once no request under the key is inside, or `stuck` when one still is at the deadline, and its `release()` lifts it. A key stays blocked while any block on it holds.

The gate holds one process's requests. A deployment whose sync routes run in several processes needs a gate across them.

## Content revisions, amend and claim

Protocol 2 (0.9.0 and later) gives each row a second identity beside its revision: its **content revision**, the mutation that last changed the row's content. The application says what a value's content is with a `RowComposer` in its `RowPolicy` (`policy.composer`); the library never parses a value, and compares only what these four functions answer.

| Function | What it answers |
| --- | --- |
| `contentOf(value)` | The part of a value its content revision covers |
| `compose(current, content, delta)` | `current` with its content replaced when `content` is not null, and `delta` applied when it is not null |
| `deltaOf(before, after)` | The change from `before` to `after` outside their content, or null when there is none |
| `sameClaim(current, incoming)` | Whether the live value at a claimed id is the claim's own |

A create, an edit, a repair, a claim and a copy each set the content revision of the row they write to their own mutation; an `amend` sets it only when the content it writes differs from the row's, and keeps the row's content revision otherwise. A protocol 2 pull carries each row's content revision beside its revision, and each result that is not a refusal the content revision of its target after it.

### Amend

`amend` (`id`, `expected`, `expectedContent`, `content`, `delta`) is a change made against a row's revision and its content revision: replacement content or none, a delta or none, never both none.

1. A delta alone (`content` null) lands on the row as it is now, at any revision: the row's value composed with the delta.
2. Content lands when the row's content revision is `expectedContent`, or when it equals the row's content; a delta beside it is applied too.
3. Different content made on an older content revision becomes one copy, under the copy's id: the new content over the row's current rest, with the delta, named by `copyValue`. The copy is refused `too_long` or `full` as any copy is.
4. An `amend` whose `expected` names an earlier mutation with a recorded result acts where that result landed, on the copy it made or at the revision its no-op found, as an edit does; content that follows it to a copy keeps the copy's naming. An `expectedContent` that names an earlier mutation with a recorded result is compared as the content revision that result recorded.

A missing or deleted row refuses it `removed`, an unreadable row `stale`, and a composed value longer than `maxUnits` `too_long`; a value equal to the row's is a no-op. A policy with no composer refuses every `amend` as `stale`.

### Claim

`claim` (`id`, `value`) creates a row at an id the caller derived, such as an imported note's id made from its source. A live row at the id holding the claim's own value (by `sameClaim`, or by equality with no composer) makes it a no-op; anything else at the id, another value, a tombstone or an unreadable row, refuses it `occupied`, never a copy. A mutation that names a claim refused `occupied`, or a mutation that depends on one, is refused `occupied` too. The limits refuse it as they refuse a create (`too_long`, `full`).

### What a save plans

With a composer, `planRowChanges(before, after, composer)` plans a changed row that has a revision as an `amend` at its revision and its content revision: it carries `content` when `contentOf` changed and `delta` when `deltaOf` answers one, and a change both count as none (tags in another order) sends nothing. A row of `after` marked `claim: true` that the plan would create is a `claim` instead of a `create`. `client.save({ rows })` takes `claim: true` on a row and plans with the policy's composer, but a kept row it changes at its revision (an unreadable row, or one kept too long) is an `edit` carrying the whole new value. A row a pending claim found holding its own value carries the claim's revision as its revision and its content revision until a later pending mutation writes it, so a change made on it names the claim: the server follows the claim's no-op to the row's revision, or refuses the change `occupied` with the claim. The journal keeps each mutation's whole local value (`incomingValue`) for the client's recovery alone; it never goes on the wire.

A claim refused `occupied` is kept with the reason `occupied`, under the copy id of the claim's mutation, with the final value of every change made on it; nothing of it is sent again. It stays out of the visible rows, through saves, leaves and joins, until `client.restoreKept(id)` puts it back with a create and hands it to `materialize`, and `client.backedUp(blocks)` counts it among the unbacked rows.

### Protocol 2 and `protocols`

Every request this release's client makes carries `protocol: 2` (`PROTOCOL`); a request with none speaks protocol 1. `MutationServerOptions.protocols` lists the protocols a server takes, `[1, 2]` by default. A push or a pull in another is answered `{ kind: 'protocol_changed', protocols }` before anything is read, and `server.parsePush(body)` reads such a push without its mutations' arguments, so a mutation the server does not know gets that answer instead of a `WireError`. A protocol 1 pull is answered with exactly the keys protocol 1's parsers take, without content revisions. A client answered `protocol_changed` stops its sends (`blocked`) and keeps its pending changes; a join answered so leaves the membership `off`. Narrow a server to `[2]` once the pages of the previous release have drained.

### Upgrading

`upgradeSqlMutationStore(adapter, prefix)` brings a reference store made before content revisions to this release: it adds the content revision columns to `<prefix>rows` and `<prefix>results` where they are missing and gives each row without a content revision its revision. A second run changes nothing, and servers that start at once on one store each finish. The rows also keep, in `content_for`, the revision each row had when its content revision was written: a server of an earlier release that still writes to the upgraded store, as in a rolling deploy, writes no content column, and a row it changed reads its own revision as its content revision, so a content change made before that write becomes a copy rather than landing over it. `CREATE TABLE IF NOT EXISTS` leaves an existing table as it was, so a server runs it after `mutationStoreDdl` on every start, before it takes a request ([a server and its routes](#a-server-and-its-routes)). A store of the application's own reads and writes `StoredRow.contentRevision` and `MutationResult.contentRevision` in its tables.

`client.open()` runs `upgradeClientTables`: the content revision columns, the membership's protocol (1 for a membership an earlier release made), the journal's local value and the retired clients' table, with each row's revision as its content revision where it has none. A joined protocol 1 client with pending work is then retired: its journal stays under its old identity and is never replayed, the value of each mutation still pending (a delete has none) is kept as `recovery` under the copy id of its mutation, the pending set is cleared, `materialize` gets what that changes in the visible rows, and the client takes a new id and a whole snapshot. A value the server acknowledged stays in the journal alone. A joined protocol 1 client with nothing pending keeps its id and takes a whole snapshot at its next pull, which gives each row the account's content revision.

A composer both halves import, for values written `content|tag,tag` with a delta of tags added and removed:

```typescript
// note-composer.ts
import type { RowComposer } from '@framers/sql-storage-adapter/browser';

const tagsOf = (value: string): string[] => (value.split('|')[1] ?? '').split(',').filter((tag) => tag !== '');

export const composer: RowComposer = {
  contentOf: (value) => value.split('|')[0] ?? '',
  compose: (current, content, delta) => {
    let tags = tagsOf(current);
    if (delta !== null) {
      const { add, remove } = JSON.parse(delta) as { add: string[]; remove: string[] };
      tags = tags.filter((tag) => !remove.includes(tag));
      for (const tag of add) if (!tags.includes(tag)) tags.push(tag);
    }
    return `${content ?? composer.contentOf(current)}|${tags.join(',')}`;
  },
  deltaOf: (before, after) => {
    const add = tagsOf(after).filter((tag) => !tagsOf(before).includes(tag));
    const remove = tagsOf(before).filter((tag) => !tagsOf(after).includes(tag));
    return add.length === 0 && remove.length === 0 ? null : JSON.stringify({ add, remove });
  },
  sameClaim: (current, incoming) => current === incoming,
};

/** A copy names its content and keeps its tags, so a delta still lands on the copy's tags. */
export const copyValue = (value: string): string => `${composer.contentOf(value)} (copy)|${tagsOf(value).join(',')}`;
```

The server's policy and protocols, in `sync-server.ts`:

```typescript
import { composer, copyValue } from './note-composer';

export const server = new MutationServer({
  adapter: db,
  store: createSqlMutationStore({ prefix: 'sync_' }),
  codec: { seal: async (value) => value, open: async (stored) => stored },
  policy: { maxRows: 500, maxUnits: 30_000, copyValue, composer },
  maxMutations: 50,
  protocols: [1, 2], // [2] once no page of the previous release is left
});
```

A page's client takes the same policy, saves a tags-only change as an `amend` that carries the delta alone, claims an imported note at its derived id, and reads the claims kept aside:

```typescript
import { MutationClient } from '@framers/sql-storage-adapter/browser';
import { composer, copyValue } from './note-composer';

const client = new MutationClient({ adapter, scope: accountId, lock, transport, materialize, reload, notify, policy: { maxRows: 500, maxUnits: 30_000, copyValue, composer } });
await client.open(); // upgrades the tables, and retires a protocol 1 queue
await client.save({ rows: [{ id: noteId, value: 'meeting notes|budget,q3' }], write });
await client.save({ rows: [{ id: noteId, value: 'meeting notes|budget,q3' }, { id: importedId, value: 'imported text|', claim: true }], write });
const occupied = (await client.snapshot()).kept.filter((row) => row.reason === 'occupied');
```

## The client

`MutationClient` keeps a browser's side in the same `StorageAdapter` as the page's own data, in eight tables under its prefix, which `client.open()` makes or upgrades: its membership (state, group, client id, activation, epoch, cookie, next mutation id and protocol), the rows as last pulled, the comparison base an off leaves, the pending mutations, a journal of every mutation it issued in the group, its own results, the rows it keeps in this browser alone, and the client ids it retired at an upgrade.

```typescript
const client = new MutationClient({ adapter, scope, lock, transport, policy, materialize, reload, notify });
await client.open();
```

| Option | What it is |
| --- | --- |
| `adapter` | The page's database, any `StorageAdapter`: in a browser, a durable `IndexedDbAdapter` ([the browser's storage](#the-browsers-storage)). |
| `scope` | The scope's id, such as the signed-in account's. |
| `lock` | The client's own cross-tab lock (`createTabLock`), never the adapter's `crossTab.locks`. |
| `transport` | A `MutationTransport`: `createFetchMutationTransport(...)`, or the application's own. |
| `policy` | The server's `RowPolicy`. |
| `materialize(trx, change)` | Writes a change of the visible rows into the page's data, inside the client's transaction: `assign` gives ids to blocks that had none, `puts` writes values by id, and `deletes` removes rows. |
| `reload` | `() => adapter.reload()`: the stored image put back before every operation and after a failed one. |
| `notify` | Called once each step that can write the client's tables has committed, to tell the other tabs. |
| `pushMutations`, `pushBytes` | The most mutations and UTF-8 bytes of one push request (50 and 1,000,000). |
| `tablePrefix` | The tables' prefix (`sync_`). |

Each step that reads or writes the client's tables runs under the lock, after `reload`, in one transaction of the adapter; the network requests run outside it. A transaction another tab saved over (`IndexedDbConflictError`) runs once more on that tab's image. Any other failure runs `reload` again before the error leaves the lock, so a commit IndexedDB refused is not stored by the client's next step.

`client.snapshot()` answers the membership, the visible rows (each with its source, `canonical`, `pending` or `kept`, and a kept row's reason), the kept rows, the number of pending mutations, and how many rows the scope held at the last pull, tombstones aside. The membership's `state` is `none`, `joining`, `joined`, `declined`, `off` or `retired`. `client.context()` answers what a request made now would carry, or null while the client is not joined.

### Saving

`client.save({ rows, write, allowDeletes? })` runs `write(trx)`, the page's write of its own data, and, while joined, issues the mutations that take the visible rows to `rows`, in the same transaction: each gets the next mutation id and goes into the pending set and the journal. The save commits whole or not at all, and sends nothing; the loop's push does. `rows` holds the page's rows that have ids.

- A value longer than `policy.maxUnits` gets no mutation: it is kept in this browser under its row's id, reason `too_long`. An edit's keeps the revision it was made against, so a later save that fits edits the row.
- A save that would send more deletes than `allowDeletes` throws `DeletesChanged` and changes nothing. `client.preview(rows)` counts the creates, edits and deletes a save would send, to ask the person first.
- While a removal runs, `save` throws `RemovalInProgress`.
- While the client is not joined, `save` runs `write` alone.

It answers `{ mode, issued, tooLong, deletes }`, `mode` being `local` or `joined`.

### Pushing and pulling

`client.push()` sends the pending mutations in id order, in requests of at most `pushMutations` mutations and `pushBytes` bytes of UTF-8 JSON (`packMutations`), and acknowledges nothing: a mutation stays pending until a pull reports it processed. A request the server refuses as too large (413) goes again in halves; a single mutation still refused as too large, or a request refused as malformed (400), stops this client's sends until `client.reopenSends()`. The server's parser refuses a push longer than its `maxMutations` with a `WireError`, which a route answers as malformed (400), so give the client a `pushMutations` no larger than it.

`client.pull()` sends the cookie and applies a complete answer in one transaction, only while the membership's group, client id, activation and epoch are still the request's and its cookie has not moved; an answer to an earlier request is dropped (`stale`). It writes the changed rows, records this client's results, drops the pending mutations up to the client's last processed id (keeping each refused value), keeps the rest pending, replayed over the new state, and hands `materialize` what became visible. A full answer replaces the rows as last pulled, and a row it no longer holds is kept aside (`recovery`): an absence is no proof of a deletion.

Each answers a `SyncOutcome`: `idle` (nothing to do now), `sent`, `applied`, `blocked` (sends stopped), `recovering`, `resend`, `off` (the group is gone, and the client left it), `retired`, `stale`, or `{ kind: 'wait', ms }` for a rate refusal. A request that does not complete throws `SyncUnavailable`.

### Joining, declining and leaving

`client.join({ group, epoch, readBlocks })` joins `group` as a new client with a new activation. It pulls a full snapshot first, then in one transaction reads the page's blocks (`readBlocks(trx)`, each a `LocalBlock`: its id, or `null` for a block that never had one; its value; and a `derivedId` to give it, or `null`) and merges them:

- A block with no id takes the id of a live row holding exactly its value that no block names, each row matched once; otherwise its `derivedId` or a random id, and a create.
- A block with an id matches the row of that id when the row holds its value, or when the comparison base does (the value the row had when this browser last left): the row's value then shows. Any other block with an id is created under its id: the server writes it where the id is free, and keeps it as a copy beside a differing row.
- `materialize` gets the new ids (`assign`) and what became visible.

A join while joined to the same group answers `idle`. A join whose snapshot does not come (refused, failed or offline) sets the membership back to `off`, and the page joins again.

`client.decline(group)` records that this browser declined `group`: it drops the rows as last pulled, the pending mutations, the journal and the results, sends and pulls nothing, and keeps the group's id in `membership.declinedGroup`, so a page can ask again when another group appears.

`client.leave(context)` runs when the server answers that the group is gone (`push` and `pull` call it), only while `context` still holds: the rows as last pulled become the comparison base, the sync records and kept rows go, and the page's data stays as it is. A later join compares with that base, so a block left unchanged takes the newer value instead of becoming a copy, and a row deleted while off is not deleted on the server: it shows again.

### Kept rows

A browser keeps a row in its own table, shown over the server's rows with a reason, when the server cannot hold it as the browser has it:

| Reason | When |
| --- | --- |
| `too_long` | Its value is longer than `maxUnits`, at a save or a join, or as the server refused it |
| `full` | The server refused it: the scope holds `maxRows` rows |
| `removed` | The server refused it because its row was deleted, or the row of a kept `unreadable` or `differs` value was deleted |
| `unreadable` | The server holds the row and cannot open it: the browser keeps the value it showed, or the value of an `amend` the server refused as `stale`, which is marked `differs` while the browser's copy of the row reads another value |
| `recovery` | A row kept aside across a restore, or one a full snapshot no longer holds, until the server's row reads its value; or a retired client's unsent value |
| `differs` | A row kept for `recovery` or `unreadable` whose row on the server reads another value |
| `occupied` | A claim the server refused because another value holds its id, with every change made on it, out of the visible rows ([claim](#claim)) |

A refused value is kept under the id the browser showed it at while the refusal was pending: beside a live row, the copy's id; at a deleted or missing row, that row's id. A change made on a refused value shown beside its row is refused `removed`, since it names the refused mutation; where the server holds no row at that id, its value takes the kept row's place under the kept row's reason. A kept row is released when the server's row reads its value, and a `recovery` row when the server's row is deleted. A save that leaves a kept row out releases it, and so does one that changes its value, but for an `unreadable` row, which keeps its mark with the new value, and an `occupied` row, which only `restoreKept` releases.

`client.restoreKept(id)` puts a `too_long`, `full`, `recovery`, `differs` or `occupied` row back with a create under its id when it fits, hands what that changes to `materialize`, and answers whether it did. A `removed` row's id is a tombstone for the group's life, so its value goes back only as a new row under a new id, which the page saves.

### Unreadable rows

When a pull carries a row as `unreadable`, a browser that shows the row keeps its value, reason `unreadable`, at the row's revision. `client.repairUnreadable()` issues a `repair` for each such row the server still holds unreadable at that revision and no pending mutation touches, and answers how many it issued; the mark goes once the server's row reads the browser's value.

### Restores: the epoch and the journal

A deployment that restores its database from a backup changes its epoch. The client's next push or pull is answered `epoch_changed`, and the client recovers; a pull whose cookie is past the server's version is answered `cookie_ahead`, which the client takes the same way:

1. Every row it shows from the server is kept aside (`recovery`), and its rows as last pulled, its results and its cookie go. Pushes wait.
2. Its next pull is a full snapshot. Applying it drops the pending mutations the restored server processed, and puts each mutation the journal holds above the restored last id back in the pending set with its id and arguments, so the next push sends again exactly what the backup lacks.
3. The kept rows are settled against the snapshot: a row the server holds with the same value is released, another value marks it `differs`, and a deleted row releases a `recovery` row.

The journal holds every mutation the client issued in its group until it joins, declines, leaves or removes its rows. A journal that cannot supply every mutation from the restored last id on retires the client (`retired`): the values only its pending mutations showed are kept (`recovery`), and the page joins again as a new client. A `gap` answer, an earlier id than the pending ones start at, is repaired from the journal the same way (`resend`).

### Removing a browser's rows

A removal deletes the browser's rows and its sync records, and changes nothing on the server. While the client is joined, it runs only after a check that the server holds every row:

1. `client.beginRemoval()`: every save is refused with `RemovalInProgress` until the removal ends; `client.cancelRemoval()` ends it without removing.
2. `client.backedUp(blocks)` checks, while joined with nothing pending, no recovery open and sends open, that each block is backed: a readable row of its id, as last pulled from the server, holds exactly its value, and no kept row has its id. A block with no id is never backed. It answers `checked`, the `reason` it could not check (`not_joined`, `recovering`, `sends_blocked` or `pending`), the `unbacked` blocks and a `stamp`.
3. `client.removeAll(write, stamp)` deletes every sync record of the scope and runs `write(trx)`, the page's removal of its own data, in one transaction, and leaves the group declined with a new activation. It throws `RemovalInvalidated` with the reason `changed` when a pull, a push or a save that issued a mutation changed the client's records after the check, or the client went off or retired. While the client is joined it also throws `RemovalNotStarted` without a removal begun, and `RemovalInvalidated` with `unchecked` without a stamp, or with `pending`, `recovering` or `sends_blocked` when the check could not stand.

The stamp reads the client's own records, never the page's data: a save that issues no mutation leaves it as it was, which is why the removal begins before the check. A browser that never joined removes at once with `removeAll(write)`.

## The transport and the loop

`createFetchMutationTransport({ pushUrl, pullUrl, fetch?, headers?, deadlineMs?, refusal? })` posts each request as JSON with the page's cookies (`credentials: 'same-origin'`) and no cache, gives it up after `deadlineMs` (120,000), and reads the whole response before it parses any of it: an answer cut short or malformed applies nothing and throws `SyncUnavailable`, as a request that fails does.

| Response | To a push | To a pull |
| --- | --- | --- |
| 200 | The push's answer: `ok`, `epoch_changed`, `group_gone` or `gap` | The pull's answer, or its refusal: `epoch_changed`, `group_gone` or `cookie_ahead` |
| 413 | `too_large` | `SyncUnavailable` |
| 429 | `rate_limited`, waiting as `Retry-After` asks, in seconds or until an HTTP date; 2 seconds when it asks for nothing usable | The same |
| 400 | `malformed` | `SyncUnavailable` |
| Any other | `SyncUnavailable` | `SyncUnavailable` |

`refusal(status, text, headers)` maps a response other than 200 that the routes answer in a shape of their own, before these defaults, such as an application's "sync is off" error to `{ kind: 'group_gone' }`; a pull takes only `rate_limited` and `group_gone` from it. A `MutationTransport` is a `push` and a `pull` function, so a transport of another kind implements the two.

`SyncLoop` drives a client. A cycle pushes, then pulls, and goes round again at once after a recovery or a resend, five rounds at most.

```typescript
const loop = new SyncLoop({ client, visible: () => document.visibilityState === 'visible' });
const detach = attachSyncLoop(loop, { window, document });
loop.start();
loop.kick('save'); // after each save
```

The loop runs a cycle at `start()`, at each `kick(reason)` (`'save'`, `'sign_in'` and the rest), and every `pullEveryMs` (60,000) while `visible()` answers true. A failed cycle is tried again after `firstRetryMs` (2,000), doubling to `maxRetryMs` (300,000), and `onError` hears each failure; a rate refusal's wait holds every kick until it ends. One cycle runs at a time, and a kick during one runs one more after it. `stop()` ends the run. `attachSyncLoop` kicks the loop when the page becomes visible, regains focus or comes back online, and answers the function that detaches it.

`changeChannel(name)` tells a page's other tabs that the client committed: pass its `post` in `notify`, and `listen` to hear the other tabs. It runs over `BroadcastChannel`, which delivers a message to every other channel of the name and not to the one that posted it; where a page has none, it sends and hears nothing.

## The browser's storage

The client needs an adapter that has stored each transaction when it resolves, and that never saves a stale tab's image over a newer one. Open the `IndexedDbAdapter` with `crossTab` and `rollbackRefusedSaves`:

```typescript
const adapter = new IndexedDbAdapter({ dbName: 'app', crossTab: { rollbackRefusedSaves: true } });
```

- `crossTab` makes `durability` `'commit'`: a statement or a transaction resolves once IndexedDB has committed its write, and rejects when IndexedDB refuses it. Each runs under a Web Lock of the adapter's own, `@framers/sql-storage-adapter:indexeddb:<dbName>:<storeName>`, on the newest stored image, and a version stamp stored beside the image refuses a stale tab's save: a `transaction()` another tab saved over is refused with `IndexedDbConflictError`, and the client runs its operation once more. `crossTab: { locks: null }` coordinates by the stamp alone, as the adapter does where a page has no Web Locks.
- `rollbackRefusedSaves` reads the stored image back inside the adapter's lock when IndexedDB refuses a save, so a statement another part of the page queued behind the refused one stores nothing of it. The client's `reload` after a failure covers an adapter without `crossTab`.
- `reload()` puts the stored image in place of the one in memory.
- `memoryOnly: true` keeps the database in memory alone, for a browser whose IndexedDB `open()` rejects: nothing outlives the page.
- `sqlJsConfig` reaches sql.js: a page whose bundler serves sql.js's WebAssembly file at another URL passes `locateFile`.

The README's [IndexedDB-Specific Config](../README.md#indexeddb-specific-config) describes each option in full.

`createTabLock(name)` makes the client's lock, which runs one piece of work at a time across a page's tabs: the Web Locks API where the page has it; else a lease in the IndexedDB database `<name>-lease`, held 10 seconds without renewal and renewed every third of that while the work runs, so a crashed tab's lease lapses, with `LockBusy` for a tab that waits more than 15 seconds, which a page shows as a read-only tab; else an in-page queue. Its `mode` says which: `web-locks`, `lease` or `memory`. The lock orders the tabs' work, and the adapter's stamp is what keeps a stale tab from saving over a newer image. Give it a name of its own, and never pass it as the adapter's `crossTab.locks`: an operation holds it while it calls the adapter, which takes its own lock, and neither lock is reentrant.

The copy id is digested by WebCrypto (`crypto.subtle`), which a browser gives a page in a secure context alone, as it does Web Locks.

## Moving an old key-value store

`migrateIndexedDbKeyValue` (in `./kv` and `./browser`) moves one namespace of an old IndexedDB key-value store, the one `openIndexedDbStore` opens, into a `KeyValueStore` over the adapter, so a page's records commit in the same transactions as its sync state:

```typescript
const outcome = await migrateIndexedDbKeyValue({
  source: { dbName: 'app-kv', storeName: 'kv', prefix: 'user-42/', fromVersion: 1, lockVersion: 2 },
  adapter,
  into: async (trx) => namespaced(await createSqlKeyValueStore(trx, { table: 'app_kv' }), 'user-42/'),
});
```

It opens the old database at `lockVersion`, above the `fromVersion` the old writers open it at, so their opens fail from then on and `openIndexedDbStore` at the old version answers from memory. It then copies the records under `prefix`, without it, into the store `into(trx)` makes, with a marker under `MIGRATION_MARKER`, in one transaction of the adapter (a `namespaced` store, as here, puts its own prefix back on each key and on the marker, so each namespace moves under a marker of its own); flushes an adapter that answers `flush()`; deletes the old records; and marks the move done. It answers `migrated`, `already`, `none` (nothing under the prefix) or `blocked` (a tab holds the old version open, and nothing moved: run it again once that tab closes). A reload resumes from the committed side, two moves at once copy once, and a store that keeps nothing past the page is refused before the old database is opened.

## A server and its routes

The server, on PostgreSQL with the reference store. `createSqlGroup` and `dropSqlGroup` are what turning sync on and off for a scope comes to; the codec here stores each value as it came.

```typescript
// sync-server.ts
import { createPostgresAdapter } from '@framers/sql-storage-adapter/postgres';
import { DrainGate, MutationServer, createSqlGroup, createSqlMutationStore, dropSqlGroup, mutationStoreDdl, upgradeSqlMutationStore } from '@framers/sql-storage-adapter/sync';

const db = createPostgresAdapter(process.env.DATABASE_URL as string);
await db.open();
for (const statement of mutationStoreDdl('sync_')) await db.exec(statement);
await upgradeSqlMutationStore(db, 'sync_'); // every start: brings tables an earlier release made to this one

export const server = new MutationServer({
  adapter: db,
  store: createSqlMutationStore({ prefix: 'sync_' }),
  codec: { seal: async (value) => value, open: async (stored) => stored },
  policy: { maxRows: 500, maxUnits: 30_000, copyValue: (value) => `${value} (copy)` },
  maxMutations: 50,
});
export const gate = new DrainGate();

/** Sync turned on for a scope: a new group, its id 32 lower-case hexadecimal characters. */
export const turnOn = (scope: string, group: string) => createSqlGroup(db, 'sync_', scope, group);

/** Sync turned off: the scope's requests cancelled and drained, then its group and rows removed. */
export async function turnOff(scope: string): Promise<void> {
  const block = gate.block(scope);
  try {
    if ((await block.drain(5_000)) === 'stuck') throw new Error('a sync request is still running');
    await dropSqlGroup(db, 'sync_', scope);
  } finally {
    block.release();
  }
}
```

Its routes, over the Fetch API's `Request` and `Response`. The application gives each one its context: the scope of the signed-in session, and the deployment's epoch.

```typescript
import { GateBlocked, WireError, parsePullRequest, type ScopeContext } from '@framers/sql-storage-adapter/sync';
import { gate, server } from './sync-server';

const headers = { 'content-type': 'application/json' };
/** A body the contract refuses answers 400. A request a deletion turns away or cancels answers 503: the client tries again later. */
const answered = (route: (request: Request, context: ScopeContext) => Promise<Response>) => (request: Request, context: ScopeContext) =>
  route(request, context).catch((error: unknown) => {
    if (error instanceof SyntaxError || error instanceof WireError) return new Response(null, { status: 400 });
    if (error instanceof GateBlocked) return new Response(null, { status: 503 });
    throw error;
  });

export const push = answered(async (request, context) => {
  const body = server.parsePush(await request.json());
  const cancel = new AbortController();
  const lease = gate.enter([context.scope], (reason) => cancel.abort(reason));
  try {
    return new Response(JSON.stringify(await server.push(context, body, { signal: cancel.signal })), { headers });
  } finally {
    lease.release();
  }
});

export const pull = answered(async (request, context) => {
  const body = parsePullRequest(await request.json());
  const cancel = new AbortController();
  const lease = gate.enter([context.scope], (reason) => cancel.abort(reason));
  let streaming = false;
  try {
    const opening = await server.pull(context, body, cancel.signal);
    if (opening.kind !== 'stream') return new Response(JSON.stringify(opening), { headers });
    streaming = true;
    void opening.done.then(() => lease.release()); // once the pull's transaction has ended
    const chunks = opening.chunks[Symbol.asyncIterator]();
    return new Response(new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        const next = await chunks.next();
        return next.done ? controller.close() : controller.enqueue(new TextEncoder().encode(next.value));
      },
      cancel: async () => void (await chunks.return?.()), // the client went away: the transaction rolls back
    }), { headers });
  } finally {
    if (!streaming) lease.release();
  }
});
```

## A page

Its rows live in a table of its own beside the client's. Each has an id of 32 lower-case hexadecimal characters (`crypto.randomUUID().replace(/-/g, '')` makes one), so `join` reads them with their ids, and `materialize` writes values by id; a page whose blocks may have no id yet reads them with `id: null` and writes the ids `assign` gives.

```typescript
import { IndexedDbAdapter, MutationClient, SyncLoop, attachSyncLoop, changeChannel, createFetchMutationTransport, createTabLock } from '@framers/sql-storage-adapter/browser';

declare const accountId: string; // the signed-in account: the scope
declare function render(): void; // draws the rows from the database again

let adapter = new IndexedDbAdapter({ dbName: 'app', crossTab: { rollbackRefusedSaves: true } });
await adapter.open().catch(async () => {
  adapter = new IndexedDbAdapter({ memoryOnly: true }); // this browser refuses IndexedDB
  await adapter.open();
});
await adapter.exec('CREATE TABLE IF NOT EXISTS app_rows (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
const channel = changeChannel('app-sync');
const client = new MutationClient({
  adapter,
  scope: accountId,
  lock: createTabLock('app-sync'), // the client's own lock, never the adapter's crossTab.locks
  transport: createFetchMutationTransport({ pushUrl: '/sync/push', pullUrl: '/sync/pull' }),
  policy: { maxRows: 500, maxUnits: 30_000, copyValue: (value) => `${value} (copy)` }, // the server's
  materialize: async (trx, change) => {
    for (const { id, value } of change.puts) await trx.run('INSERT INTO app_rows (id, value) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET value = excluded.value', [id, value]);
    for (const id of change.deletes) await trx.run('DELETE FROM app_rows WHERE id = ?', [id]);
  },
  reload: () => adapter.reload(),
  notify: () => { channel.post(); render(); },
});
await client.open();
const loop = new SyncLoop({ client, visible: () => document.visibilityState === 'visible' });
attachSyncLoop(loop, { window, document });
channel.listen(render);
loop.start();

// Sync turned on: the group and the epoch come from the application's own route.
export const join = (group: string, epoch: string) =>
  client.join({ group, epoch, readBlocks: async (trx) => (await trx.all<{ id: string; value: string }>('SELECT id, value FROM app_rows')).map((row) => ({ ...row, derivedId: null })) });

export async function save(rows: Array<{ id: string; value: string }>): Promise<void> {
  await client.save({ rows, write: async (trx) => { await trx.run('DELETE FROM app_rows'); for (const row of rows) await trx.run('INSERT INTO app_rows (id, value) VALUES (?, ?)', [row.id, row.value]); } });
  loop.kick('save');
}
```
