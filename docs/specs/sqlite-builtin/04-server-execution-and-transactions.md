# 04 — Server-side execution & transactions

Queries and writes execute **inside toolshed**, which already hosts the space
and owns its SQLite engine. The runtime reaches them over the **existing
space-scoped websocket** — the same connection used for `transact`, `graph.query`,
and `session.watch.*`.

## Where execution happens

- Each space is a single `@db/sqlite` `Database` opened by the memory engine
  ([`packages/memory/v2/engine.ts`](../../../packages/memory/v2/engine.ts),
  `open()` → `engine.database`), cached one-per-space by the server
  ([`packages/memory/v2/server.ts`](../../../packages/memory/v2/server.ts),
  `openEngine(space)`).
- The space websocket is served at `/api/storage/memory?space=<did>`
  ([`packages/toolshed/routes/storage/memory/memory.routes.ts`](../../../packages/toolshed/routes/storage/memory/memory.routes.ts)),
  authorized via UCAN on session open.
- Cell-derived SQLite databases (Section [03](./03-database-sources.md)) are
  **one sibling file per database** in the same storage directory (Q6 → Option
  A) and are **ATTACHed** to `engine.database` so SQL statements against them
  share the engine's connection and transactions.

Because we ride the same connection, queries inherit the session's existing
authorization; no new auth surface is added in v1. (CFC will later refine *what*
within the space a query may touch — Section [06](./06-cfc.md).)

## Isolation, namespacing & the statement guard

A pattern's SQL runs on the same connection as the authoritative memory store,
so isolation is load-bearing. The design relies on three things, none of which
needs a full SQL parser:

- **File boundary = namespace.** SQLite's only namespace primitive is the
  attached-database alias, so one file per cell-derived db *is* the namespace.
  We ATTACH only the handle's own db for a given statement/commit; an unqualified
  `messages` resolves to it (SQLite resolves `main → temp → attached-in-order`),
  with **no identifier rewriting**.
- **Core-table rename flag.** To remove the risk that an unqualified pattern name
  shadows/leaks a core table (`commit`, `revision`, `head`, `snapshot`,
  `branch`, `scheduler_*`, `blob_store`), rename the engine's core tables to
  include the space DID (e.g. `commit__<did>`), behind a flag. Pre-production we
  may ship unflagged and tolerate shadowing temporarily.
- **Tokenizer-level statement guard.** `@db/sqlite` exposes **no authorizer**
  (`sqlite3_set_authorizer` is not bound — confirmed against the library), so we
  cannot get SQLite to enumerate accessed objects for us. Instead the guard
  rejects: any **schema-qualified** reference (`other.table`), `ATTACH`/`DETACH`/
  `PRAGMA`, and **multiple statements**; `sqliteQuery` additionally requires a
  single `SELECT`/read-only CTE. Because we never rewrite identifiers, this is a
  tokenizer-level check, not full resolution. (A future hardening option: bind
  `sqlite3_set_authorizer` ourselves via Deno FFI against the `unsafeHandle`
  pointer — defense-in-depth, not required for v1.)

**Attach/detach cache.** `@db/sqlite` exposes no `sqlite3_limit` binding, so
`SQLITE_LIMIT_ATTACHED` stays at the compiled default (≈10). An **LRU
attach/detach cache** attaches a db on demand and `DETACH`es the least-recently-
used near the limit. Manage it at **transaction boundaries** (ATTACH before
`BEGIN`; DETACH only when idle — a db in use / inside a transaction cannot be
detached). A single commit almost always touches one pattern db (2 schemas),
far under the limit; a transaction that would span more is rejected or split.

## Protocol extension

The v2 protocol is a discriminated union of message `type`s
([`packages/memory/v2.ts`](../../../packages/memory/v2.ts), `ClientMessage` /
server messages; parsed in `parseClientMessage`, routed in
`Connection.receiveOrdered`, correlated by `requestId` in
[`packages/memory/v2/client.ts`](../../../packages/memory/v2/client.ts)). It is
extensible by adding variants. We add **one new read verb** and **fold writes
into the existing `transact` commit**.

### Reads: `sqlite.query` (new verb)

```ts
interface SqliteQueryRequest {
  type: "sqlite.query";
  requestId: string;
  space: string;
  sessionId: SessionId;
  db: SqliteDbRef;            // resolved source descriptor (Section 03)
  sql: string;               // single read-only statement
  params?: unknown[] | Record<string, unknown>;
}

// Response rides the existing ResponseMessage envelope:
//   { type: "response", requestId, ok?: { rows: unknown[] }, error?: V2Error }
```

Server handling (mirrors `Server.transact` / `Server.queryGraph`):

1. Route the new `type` in `Connection.receiveOrdered`, guarded by
   `requireSession`.
2. `const engine = await this.openEngine(space)`.
3. ATTACH the db file via the attach/detach cache (above) if not already
   attached.
4. **Apply the statement guard** (above): single `SELECT`/read-only CTE; reject
   DML/DDL, schema-qualified references, `PRAGMA`/`ATTACH`/`DETACH`, and multiple
   statements, with a `read-only-violation` / `guard-violation` error.
5. `engine.database.prepare(sql).all(params)` → rows.
6. Reply with `{ type: "response", requestId, ok: { rows } }`.

`_cf_link` decoding (Section [02](./02-cf-link-encoding.md)) happens **on the
client** after the rows return, because reconstructing a `Cell` needs the
runtime. The server returns raw strings.

### Writes: folded into `transact`

Writes are **not** a separate RPC. They are appended to the commit that the
write built-in's transaction already produces, so they apply in the **same
SQLite transaction** as the cell writes.

The client commit (`ClientCommit` in
[`packages/memory/v2.ts`](../../../packages/memory/v2.ts)) carries an
`operations: Operation[]` list applied inside
`engine.database.transaction(applyCommitTransaction).immediate(...)`
([`packages/memory/v2/engine.ts`](../../../packages/memory/v2/engine.ts)
`applyCommit` → `applyCommitTransaction`, which iterates operations through
`writeOperation`). We add a new operation kind:

```ts
interface SqliteOperation {
  op: "sqlite";
  db: SqliteDbRef;       // which attached database
  sql: string;           // write statement(s)
  params?: unknown[] | Record<string, unknown>; // _cf_link params pre-encoded by client
}
```

`writeOperation` gains a `case "sqlite"` that, for a cell-derived db:

1. Ensures the db is ATTACHed to `engine.database` (the connection already
   inside the open transaction).
2. Executes the statement via the same connection — so it is part of the very
   `.immediate()` transaction that writes cell revisions. Either everything
   commits or everything rolls back.

`_cf_link` parameters are **encoded on the client** (Section
[02](./02-cf-link-encoding.md)) before the operation is placed in the commit, so
the server stores ready-made link strings and never needs runtime cell access.

This keeps the atomicity property the runtime already relies on: a commit is one
SQLite transaction with a single global `seq`. Cell writes and SQLite writes
land together.

## Ordering within a commit

Per the goals, **writes are executed after** the rest of the commit's cell
operations, and **read-after-write within the same transaction fails**:

- `sqlite` operations are ordered last among the commit's operations.
- A `sqlite.query` issued from inside the same transaction that has pending
  (uncommitted) `sqlite` writes is rejected with a `read-after-write-unsupported`
  error. v1 does not simulate the pending write. (The write built-in records
  that its db has pending writes in the current transaction; a query against
  that db in the same transaction throws rather than reading stale state.)

## Atomicity across cells and SQLite (and WAL caveat)

Goal: transactions are **atomic across cells and the attached SQLite database**.

- **Normal operation.** Because the attached db shares the engine connection,
  `BEGIN … COMMIT` spans the main space db and the attached db. SQLite commits
  attached databases atomically when they share a connection and journal
  coordination — so in the no-crash path, cells and rows commit together.
- **WAL caveat.** The engine runs `PRAGMA journal_mode = WAL`
  ([`packages/memory/v2/engine.ts`](../../../packages/memory/v2/engine.ts)
  `PRAGMAS`). With WAL, cross-file atomic commit is **not guaranteed across a
  crash** mid-commit: one file's WAL frame may be durable while the other's is
  not. In normal (no-crash) operation the commit is atomic.
- **Post-crash reconciliation.** To preserve the invariant despite the WAL
  caveat, each cross-store commit records an **in-doubt marker** keyed by the
  space `seq` before the SQLite write, cleared on successful commit. On startup,
  the engine scans for in-doubt markers and **rolls back** any SQLite-side
  changes for a `seq` that did not also land on the space side (and vice
  versa), bringing the two stores back into agreement. This is the
  "rollback things that are in doubt, just in case" flow.

  Concretely: the commit table already records each `seq`
  ([`packages/memory/v2/engine.ts`](../../../packages/memory/v2/engine.ts)
  `insertCommit`). The attached db gets a small `_cf_commit_watermark` table
  recording the last `seq` whose SQLite writes are known-durable. On open, if the
  space's committed `seq` and the attached watermark disagree, the in-doubt
  range is reverted on whichever side raced ahead.

> Implementation reality check: `@db/sqlite` exposes a single synchronous
> connection per `Database`; ATTACH + shared-connection transactions are the
> mechanism that buys normal-operation atomicity here. The watermark/in-doubt
> scan is the safety net for the crash window WAL leaves open. The exact
> revert-on-open algorithm is sketched, not finalized — see
> [08-open-questions.md](./08-open-questions.md).

## Concurrency

- The engine connection is single-threaded/synchronous; `sqlite.query` reads and
  `transact`-folded writes serialize on it like all other engine work. Long
  queries therefore block the space; v1 should guard with a statement timeout
  and (later) consider a read replica or a separate read connection in WAL mode.
- Multi-tab / multi-client coordination for the *write* side is inherited from
  the existing commit model (seq-based validation, optimistic local commit,
  server confirmation), so no new mutex is needed for writes. (Contrast
  `fetchData`, which needs `tryClaimMutex` because it has no transactional
  backstop.)
