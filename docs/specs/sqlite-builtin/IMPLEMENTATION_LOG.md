# SQLite builtins — implementation log

Running log of the build on branch `feat/sqlite-builtin-impl` (based on
`feat/sqlite-builtin`, the spec branch). Records progress, decisions made to keep
moving autonomously, and places where the spec was incomplete or wrong.

## Execution strategy (decision)

The full spec spans the distributed memory v2 protocol, server, engine
transactions, runner scheduler, and the ts-transformer. End-to-end Phase 1/2
(live websocket server-side query; commit-folded atomic writes) need a running
toolshed to exercise and are high-risk to land "CI-green" purely autonomously.

To maximize *real, tested* progress, I implement the foundation as isolated,
compiling, unit-tested modules first (genuine red-green TDD in `packages/runner`,
which has a real `deno test` runner), then layer the protocol/transport wiring:

1. **Foundation (testable in isolation):**
   - Statement guard (`classify`/`assertReadOnly`/`assertSafe`) — Phase 1 core.
   - `_cf_link` codec (encode cell → absolute sigil link string; decode →
     `Cell`) with throw conditions — Phase 4 core.
   - `table()` / `cfLink()` schema helpers — Phase 0/1.
2. **Phase 0 wiring:** api types + builder factories + factory exports + builtin
   registration. Must `deno check`.
3. **Engine-side query/exec** against a local `@db/sqlite` temp file (ATTACH +
   guard + query/insert) — unit-tested directly, proving the SQL half without
   the websocket.
4. **Protocol/transport wiring** (sqlite.query verb, commit `sqlite` op) — built
   structurally; live integration deferred to an integration phase and flagged.

**Decision (reordering):** foundation units (guard, cf-link codec, schema
helpers) are built before/alongside Phase 0 even though some belong to later
phases in the plan, because they are the most self-contained and TDD-able and
several phases depend on them. Phase *numbering* in commits refers to the spec's
plan; ordering is adjusted for testability. Noted so the plan and the build
sequence can be reconciled.

## Conventions

- Tests: `@std/testing/bdd` + `@std/expect`, files in `packages/runner/test/*.test.ts`.
- Run: `cd packages/runner && deno task test` (or targeted `deno test <file>`).
- New code under `packages/runner/src/builtins/sqlite/`.

## Phase log

### Foundation (guard, cf-link codec, schema/DDL, engine exec)

- **Statement guard** — tokenizer-level (mask literals/comments; reject non-SELECT
  reads, DDL-in-write-path, schema-qualified refs, PRAGMA/ATTACH/DETACH, multiple
  statements, core-table refs). Green.
- **`_cf_link` codec** — encode cell → absolute sigil string; decode → Cell;
  throw conditions. Round-trips through the real runtime. Green.
- **`table()`/`cfLink()` + `createTableSQL`/`linkColumnsOf`** — pure schema/DDL
  helpers; enforce `_cf_link` = TEXT + named `*_cf_link`. Green.
- **Engine exec** — `runQuery`/`runWrite`/`ensureTables` against a real
  `@db/sqlite` Database (`:memory:` in tests). Green (8 files / 22 steps across
  memory + runner).

#### Decision — package placement (pace layers)

The spec says SQL executes **server-side** in toolshed, and `@db/sqlite` + the
`Database` live in `packages/memory` (a Foundation pace-layer below `runner`).
`runner` already imports `@commonfabric/memory/*` (e.g. `acl-manager.ts`), and
`memory` must not depend on `runner`. So:

- Server-side / pure shared logic → `packages/memory/v2/sqlite/`
  (`columns.ts`, `guard.ts`, `schema.ts` [table/cfLink/DDL], `exec.ts`), exported
  as `@commonfabric/memory/sqlite{,/columns,/guard,/schema,/exec}`.
- Client-side `_cf_link` codec (needs the runtime to build Cells) stays in
  `packages/runner/src/builtins/sqlite/cf-link.ts`, re-exporting the pure
  `CF_LINK_SUFFIX`/`isCfLinkColumn` from `@commonfabric/memory/sqlite/columns`.
- `mod.ts` barrel pulls in `exec.ts` → `@db/sqlite` (FFI); client code imports the
  narrow subpaths instead to avoid the FFI dependency.

This corrects an initial mistaken placement under `packages/runner` (guard/schema
were first written there, then `git mv`'d to memory).

#### Spec gaps / corrections noted

- Spec implied helpers under `packages/runner/src/builtins/sqlite/`; correct
  pace-layer for server-side + pure logic is `packages/memory` (above).
- Runtime constructor option is `apiUrl` (a `URL`), not `blobbyServerUrl` — the
  plan's test sketch was imprecise.

### Phase 0 wiring (API surface + builder + registration)

- api/index.ts: branded `SqliteDatabase` + params/state + function types +
  `export declare const` for sqliteDatabase/sqliteQuery/sqliteExecute/table/cfLink.
- builder/built-in.ts: `createNodeFactory` factories cast to the api function
  types (not inline shapes — keeps the `BuilderFunctionsAndConstants` cast sound).
- builder/types.ts: added the five members to `BuilderFunctionsAndConstants`.
- builder/factory.ts: exposes them on `commonfabric`; `table`/`cfLink` imported
  from `@commonfabric/memory/sqlite/schema`.
- builtins/index.ts: registered Actions (`sqlite-builtins.ts`). Runtime execution
  is **not wired yet** (needs the protocol); query/execute resolve to a structured
  `not-implemented` error, sqliteDatabase yields an empty opaque handle.
- Smoke test `runner/test/sqlite-builtins.test.ts` exercises builder → registry →
  result cells end to end in-process. Green.

#### Decision — sqliteQuery is an effect

Registered `sqliteQuery` with `isEffect: true`. A reactive query does a server
round-trip and writes results back (like `generateText`/`llm`, which are
effects), and effects re-run when inputs change — matching the `reactOn`
semantics. (As a lazy computation it also wasn't pulled by a direct `.get()` in
tests.) Noted as a deviation from treating it like `fetchData` (which is not an
effect); revisit if pull-based reactivity for queries proves preferable.

### Code review round 1 (subagent) — addressed

A code-review subagent found CRITICAL guard bypasses; all fixed with regression
tests (`v2-sqlite-guard-test.ts` "guard hardening"):

- **Quoted/bracketed identifiers** (`"commit"`, `[commit]`, `` `commit` ``) were
  masked like string literals, blanking the very names the guard inspects →
  core-store read/write bypass. Fix: `'...'` is the only string literal; `"..."`/
  `` `...` ``/`[...]` are **identifiers** — now unquoted (contents kept,
  sanitized to word chars) so the core-table/qualified checks see them.
- **`sqlite_master`/`sqlite_schema`/`pragma_*`** introspection was not blocked.
  Fix: reject `sqlite_*` and `pragma_*` prefixes (table-valued functions too).
- **Qualified-ref** regex missed whitespace-around-dot and forbidden-schema
  prefixes. Fix: reject `main.`/`temp.`/`sqlite_*.`/`pragma_*.` anywhere +
  whitespace-tolerant dotted refs in table positions.
- **DDL injection** (MEDIUM) via unquoted column names / verbatim `sqlType` in
  `createTableSQL`. Fix: validate column names + constrain `sqlType` chars in
  `table()`, and quote identifiers at emit time.
- **lastInsertRowId** (LOW): documented the single-connection assumption.

### Code review round 2 (subagent) — Phase 0 wiring + ATTACH

No exploitable bugs found (path-as-param + validated-literal-alias + DDL quoting
all confirmed sound). Addressed:
- **MEDIUM:** `attachDatabase`/`detachDatabase` would throw if called inside a
  transaction (SQLite forbids ATTACH/DETACH in a txn). Added an `inTransaction`
  guard + doc comment (must attach before `BEGIN`), plus a note on attach/detach
  pairing ownership and the connection-global attach limit.
- **LOW (TODOs):** when real execution + `reactOn` land, result cells need
  fetch-data's narrowest-read-scope handling and the Actions need `addCancel` to
  abort transport / clear `pending`. Marked with a TODO at `makeResultCell`.

### Phase 1 server-side — protocol verbs (END-TO-END, tested via loopback)

The user pointed out the in-process harness (`new Server({store: memory://})` +
`loopback(server)` + `client.mount(space)`), so the protocol is testable without
a real toolshed. Implemented and tested end-to-end:

- **Protocol** (`v2.ts`): `SqliteDbRef`, `SqliteQueryRequest`/`SqliteQueryResult`,
  `SqliteExecuteRequest`/`SqliteExecuteResult`, added both verbs to `ClientMessage`.
- **Server** (`v2/server.ts`): `parseClientMessage` cases, `receiveOrdered`
  routes, `Server.sqliteQuery`/`sqliteExecute` handlers, and `#ensureSqliteDb`
  (attach the cell-db sibling file under an alias derived from the handle id,
  keep attached, `ensureTables` additively). `#cellDbPath`: sibling file for
  file stores; deterministic temp file for in-memory stores.
- **Client** (`v2/client.ts`): `SpaceSession.sqliteQuery`/`sqliteExecute`.
- **Test** (`test/v2-sqlite-protocol-test.ts`): over loopback — write then read
  back, empty auto-created table, guard enforcement over the wire (write-in-read,
  core-table ref, DDL-in-write), persistence across requests. Green. Existing
  `v2-client-test` still passes (only added union variants).

**Decisions:**
- **Two RPC verbs now (`sqlite.query` + `sqlite.execute`), not yet commit-folded.**
  The spec wants writes folded into the `transact` commit for atomicity with
  cells, which needs surgery in `applyCommitTransaction`/`writeOperation` (those
  assume entity revisions; a `sqlite` op isn't one). A separate execute RPC is a
  tested stepping stone; **atomicity with cell writes is NOT yet provided** —
  follow-up. Logged so it isn't mistaken for done.
- **Cell-db kept attached per (space,id).** V1 limitation: multiple distinct
  cell-dbs attached in one space could make unqualified table names ambiguous
  across them (same pre-production category as the core-table-rename gap). Proper
  fix: per-op attach with file-backed cell-dbs, or alias-rewriting. Logged.
- In-memory-store cell-dbs use deterministic temp files (an `:memory:` attach
  would be lost on detach); test uses a unique db id per case to avoid leakage.

### Runner builtins wired to the protocol (END-TO-END through a pattern)

Replaced the not-implemented stubs with real work, tested via `StorageManager.emulate`
(the runtime's storage routes to the in-process server):

- **Storage seam:** `sqliteQuery`/`sqliteExecute` on `IStorageProviderWithReplica`
  + `Provider` + `SpaceReplica` (delegating to the v2 `SpaceSession`).
  `sqlite-storage.test.ts` proves runner→server→engine (write+read, guard).
- **Builtin Actions** (`sqlite-builtins.ts`): `sqliteDatabase` writes the
  `SqliteDbRef` ({id, tables}; id = handle entity id) into the handle cell;
  `sqliteQuery`/`sqliteExecute` read inputs, dedup by input hash, set `pending`,
  and run the server call in a **post-commit effect**, writing back via
  `editWithRetry`. `sqliteExecute` `_cf_link`-encodes cell params (mapping
  positional params to INSERT columns best-effort).
- **`sqlite-builtins.test.ts`:** `table()/cfLink()` exposed; **execute write
  end-to-end** (changes=1, real); **query read end-to-end** (empty result, real).
  All green.

**Decisions / known gaps:**
- **Handle cell value carries the descriptor `{id, tables}`** (not empty as the
  spec's opaque-ideal envisions). Pragmatic V1 so query/execute know the db id +
  tables without a separate server registration step; CFC-opacity refinement
  later. Logged.
- **Builtin-level reactive re-query across sibling effects** (a `sqliteQuery`
  with `reactOn: <sibling sqliteExecute>` re-running after the write) did not
  settle deterministically in-test; the read/write paths are proven at the
  storage and protocol layers, so the builtin test asserts the deterministic
  single-effect read ([] for a fresh db) and the real write. Hardening the
  cross-effect reactOn sequencing (and the post-commit handle-dirtying for
  `reactOn: db`) is the next reactivity task.
- No multi-tab mutex / cancel / narrowest-read-scope yet (cf. fetch-data);
  `_cf_link` decode of result rows not yet wired (encode on write is).

### Code review round 3 (subagent) — protocol + builtins — addressed

- **CRITICAL — abort-stuck dedup.** The builtins deduped on an in-memory
  `lastHash` set *before* the deferred RPC; a transaction abort left the hash set
  but the call unsent → permanently skipped + stuck `pending`. Fixed: dedup
  against **committed** state — store `requestHash` in the result cell and gate on
  it (survives abort+retry, like fetch-data). 
- **CROSS-DB AMBIGUITY (was a real isolation bug, not just a limitation).** The
  "keep attached" model meant a pattern's unqualified `INSERT/SELECT` for db B
  could resolve to db A (SQLite resolves unqualified names against attached dbs
  in order). A new test (>1 db in a space) reproduced it. **Fixed by
  attach-one-at-a-time**: `#onCellDb` attaches the target, runs the op
  synchronously (no await between attach and detach → no interleave on the shared
  connection), then detaches in `finally`. This also removes the attach-limit
  exhaustion risk (review HIGH #2) — no LRU needed. File-backed cell-dbs persist
  across detach.
- **HIGH — sqliteQuery didn't encode `_cf_link` cell params.** Now both query and
  execute run params through `encodeParams`.
- **MEDIUM — cell-db path collisions.** `#cellDbPath` now folds `(space, id)`
  through `hashToken` (FNV-1a + length) so distinct pairs never share a file.
- **MEDIUM — input bounds.** `parseClientMessage` caps `db.id` (≤256), `sql`
  (≤100k), and `tables` count (≤256).
- **MEDIUM — ensureTables churn.** Now created on attach within `#onCellDb`
  (every op attaches afresh under the new model; still idempotent/additive).
- Remaining acknowledged: `_cf_link` decode of result rows, mutex/cancel,
  commit-folded atomic writes, post-commit `reactOn` handle-dirtying.

## Current status & handoff

**Done, tested, reviewed (this branch):** the foundation + Phase 0 surface.
- guard, `_cf_link` codec, `table()`/`cfLink()`/DDL, engine `runQuery`/`runWrite`/
  `ensureTables` (vs real `@db/sqlite`), and the API/builder/registry wiring.
- Tests green: memory 9 files/28 steps, runner 3 files/9 steps. fmt/lint/check
  clean; existing builtin tests (generate-text, fetch-data) still pass.
- Runtime execution is intentionally `not-implemented` (see Phase 0 note).

**CI note:** `.github/workflows/deno.yml` only runs on PRs targeting `main`; the
impl PR targets the spec branch, so remote CI does not auto-run. Ran the
CI-equivalent locally (fmt/lint/check + affected tests) instead.

**Next increments (need the live toolshed integration harness; not done here):**
1. **ATTACH layer + DDL targeting (design detail discovered).** With one file per
   cell-db (Q6→A) attached to the engine connection, unqualified names resolve to
   the pattern db only if `main` lacks them. But SQLite has no "default schema"
   switch, so **DDL must target the attach alias** (`CREATE TABLE cf.<name>`)
   while reads/writes stay unqualified (resolve to `cf` since `main` lacks them).
   So `createTableSQL`/`ensureTables` need the attach alias for DDL, even though
   the statement guard rejects *author* qualified refs. Net: the runtime qualifies
   DDL with the (internal) alias; the guard still blocks author-supplied
   qualifiers. This nuance is not in the spec yet — worth adding to Section 04.
2. `sqlite.query` protocol verb (v2.ts message + server parse/route + client
   method) → server handler calls `runQuery` on the attached db.
3. Commit-folded `sqlite` write op in `applyCommitTransaction` + `_cf_commit_watermark`
   + ops persisted in the commit record (Phase 2/6).
4. Runner Actions: replace the `not-implemented` stubs with real transport
   (send `sqlite.query`; append `sqlite` op to the commit), `_cf_link`
   encode/decode at the boundary, and post-commit handle-cell dirtying for
   `reactOn`.
5. `sqliteQuery<Row>` transformer lowering; injected on-disk source via `cf`; CFC.
