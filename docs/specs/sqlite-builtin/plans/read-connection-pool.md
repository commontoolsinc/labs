# Plan — Unified read path via a pooled connection (attach only for writes)

> Follow-up to the shipped SQLite feature (PR #3776). Supersedes the
> "attach/detach LRU cache" idea and most of the urgency of
> [08-open-questions.md](../08-open-questions.md) Q23 (alias-qualification) and
> Q21 (on-disk read-only attach). Status: **implemented** (phases 1–3;
> `sqlite/read-pool.ts` + `Server`).

## Motivation

The as-built server attaches the target cell-db to the per-space engine
connection, runs the op, and detaches — on **every read and every write**
(`Server.#onCellDb`), and runs `ensureTables` (a `CREATE TABLE IF NOT EXISTS`
per declared table) on **every** such attach, reads included. Three costs/risks
fall out:

1. **Per-op overhead.** Each query/write pays a file-open + schema-load (ATTACH)
   + a schema-cookie bump (invalidates prepared statements) + N×
   `CREATE TABLE IF NOT EXISTS` (ensureTables) + DETACH. A `reactOn: db` query
   re-runs this on every `rev` bump, all serialized on the one per-space engine
   connection.
2. **Overlap fragility.** Correctness of an *unqualified* statement relies on
   "exactly one cell-db attached" (≤1/commit + synchronous read attach + the
   B1 detach-before-await) plus the core-table guard/denylist. The folded write
   is not alias-qualified (Q23) — it's invariant-dependent, not structural.
3. **Read-only fragility for injected on-disk sources.** Read-only is enforced
   by connection-global `PRAGMA query_only` toggled around a synchronous
   attach→op→detach window, not by a per-attachment read-only mode (the engine
   connection isn't opened `SQLITE_OPEN_URI`). External-schema on-disk sources
   are also the *most* likely to collide with core/cell table names.

## Design: reads on a pooled connection; writes attach

**All reads — cell-derived and on-disk — run on a dedicated connection opened
directly on the db file, NOT attached to the space engine.** Only **writes**
attach to the space engine (required: the folded `sqlite` op must ride the same
commit transaction as the cell ops, and SQLite has no cross-connection
atomicity).

A single read primitive:

```ts
// Resolve a db ref to its on-disk file path, then run a guarded read on a
// pooled, read-only connection for that path. No ATTACH; the file's own schema
// is `main` on that connection, so unqualified names resolve to it and there is
// no core store to shadow.
#queryDb(space: string, db: SqliteDbRef, sql: string, params?): Row[]
```

The **only per-source difference is path resolution**, not execution:
- **cell-derived**: `#cellDbPath(engine, space, db.id)` (unchanged).
- **on-disk (injected)**: the `DiskSourceRegistry` descriptor path for
  `(space, db.id)`.

Execution is identical: open/reuse a `mode=ro` connection for that path, run the
guarded `SELECT`, return rows. The statement guard still applies (SELECT-only,
no `ATTACH`/`PRAGMA`/multi-statement) so a read can't use its connection to reach
other files.

### Connection pool

- Keyed by **canonical file path**; opened read-only (`new Database(path, {
  readonly: true })` / `file:<path>?mode=ro`). This gives **real per-connection
  read-only** — replacing the `query_only` window (closes Q21's read-only
  fragility for on-disk and is correct for cell-db reads too).
- LRU with a cap well under the OS file-descriptor budget; evict → `close()`.
- Cell-dbs must be **WAL** so a pooled reader sees writes committed via the
  attach path (see wrinkle 2).

### Writes (unchanged in spirit)

Cell-db writes still attach to the space engine in `#attachCommitSqliteDbs` and
run inside `applyCommit` (atomic with cell ops, ≤1 cell-db/commit). On-disk
sources remain **read-only** (db.exec rejected). With reads off the engine
connection, **the only thing ever attached is the single cell-db being
written** — so two cell-dbs are never attached at once.

## Wrinkles and resolutions

1. **Create-on-read.** Today `ensureTables` lazily creates a cell-db's tables on
   first *access* (so a query against a never-written cell-db returns `[]`). A
   read-only connection can't `CREATE TABLE`. **Resolution:** treat
   "no such table" from a read as an **empty result**. Cell-db schema is then
   created on the first *write* (attach path); a fresh cell-db still reads empty.
   On-disk sources never hit this (external schema already exists; we never
   migrate them).
2. **Read-after-write visibility (cell-dbs).** A cell-db now has a pooled read
   connection *and* the write-via-attach. **WAL turned out NOT to be required**
   for our access pattern: reads are post-commit effects, writes serialize on
   the engine connection, and each query is a *fresh* read transaction
   (`.all()`), so SQLite's change-counter makes a reused pooled connection
   observe writes committed after it opened (pinned by a test in
   `v2-sqlite-protocol-test.ts`). The spec also declares read-after-write
   *within a transaction* unsupported ([04](../04-server-execution-and-transactions.md)),
   so reads only ever need *committed* state. WAL remains a future hardening for
   concurrent read-*during*-write, not a correctness prerequisite. On-disk
   sources are read-only → no coordination.
3. **Schema migration vs the pooled reader.** An additive migration on the write
   connection bumps the schema cookie; the pooled reader reloads schema on next
   access automatically. (Verify with a test; otherwise drop the reader on a
   known schema-version bump.)

## `ensureTables` only on first attach (write path)

Independently of the pool, stop running `ensureTables` on every write attach:
keep a per-engine **"ensured" set keyed by `(id, schemaHash)`** (hash of
`db.tables`); skip when already ensured; a changed declaration → new hash →
re-ensure (additive migration). In-memory per engine; a restart re-ensures once
(idempotent). This removes the N-DDL-per-write cost. (With reads on the pool,
reads no longer run `ensureTables` at all.)

## What this supersedes / defuses

- **Attach/detach LRU cache** (old plans idea) — replaced by the read pool; the
  engine connection no longer churns attachments for reads.
- **Q23 (alias-qualification)** — only a single write db is ever attached, so
  unqualified resolution can't be ambiguous between cell-dbs. Qualification drops
  to defense-in-depth, not a correctness prerequisite.
- **Q21 (on-disk read-only)** — on-disk reads use a real `mode=ro` connection,
  and never share a namespace with core/cell tables. The jail still applies to
  *which path* may be registered (the operator-allowlist follow-up is unchanged).

## Phasing (each shippable) — all done

1. **[done]** RO connection pool (`ReadConnectionPool`) + injected on-disk reads
   routed through it unattached; the ATTACH-read-only + `query_only` path
   removed.
2. **[done]** Cell-derived reads routed through the pool too (`#readCellDb`);
   `#onCellDb` removed; missing-file / "no such table" → `[]`; the statement
   guard runs before the short-circuit. (WAL not needed — see wrinkle 2.)
3. **[done]** `ensureTables` runs only on the first write per
   `(space, id, schema-JSON)` (bounded LRU; re-ensures on a schema change).

## Open questions / risks

- **fd budget & pool sizing.** Cap + LRU-evict-and-close; pick a default and a
  per-space ceiling.
- **WAL everywhere.** Confirm cell-dbs are (or are switched to) WAL; assess the
  `-wal`/`-shm` overhead and checkpointing for many small cell-dbs.
- **Pooled-reader staleness on migration** (wrinkle 3) — verify auto schema
  reload, else invalidate on schema-version change.
- **Disk-source path disappearing / becoming unreadable** between registration
  and read — surface a clear error (today an ATTACH error; with the pool, an
  open error).
