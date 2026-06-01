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

### Reactivity loop (reactOn: db) — WORKING (root cause was test isolation)

A focused design session ([plans/reactivity.md](./plans/reactivity.md)) proved,
empirically, that the reactivity mechanism was **never broken** — my earlier
"deterministic failure" was a **test-isolation artifact**. The emulated server
backs each cell-db with a deterministic, persistent temp file keyed by
`(space, db.id)`; since `db.id` is the handle's *stable* entity id, re-running
the suite accumulated rows in that file and the query's expected result drifted
(`[]`→`[hi]`→`[hi,hi]`…), failing the assertion — even though the re-query fired
correctly every run. The scheduler re-runs a `reactOn`-reading effect through a
link correctly (verified via probes).

Fix (test-first): reinstated the client post-commit **handle-`rev` bump**
(`sqliteDatabase` seeds `rev:0`; `sqliteExecute` bumps `inputsCell.key("db")` in
its success `editWithRetry`; `sqliteQuery` reads the handle via `reactOn` so the
bump changes the request hash and re-issues), plus an **isolated test** (unique
space per test → unique cell-db file). Green **5/5 against a dirty `/tmp`**
(`sqlite-builtins.test.ts` "re-runs a reactOn:db query after a sibling write").
This closes the user-facing reactive loop. Server-driven `markSpaceDirty`
remains a documented future-hardening alternative.

**Lesson:** the per-`(space,id)` persistent temp file is a recurring test trap
(also hit by the LRU/protocol tests) — builtin/runner tests that exercise data
must use a unique space (or unique db id) per test.

### Atomic commit-folded writes — engine + server DONE (Stages 1–3)

Following [plans/atomic-writes.md](./plans/atomic-writes.md):
- `SqliteOperation` added to the wire `Operation` union (v2.ts).
- `applyCommitTransaction` runs `sqlite` ops via `applySqliteOperation` **inside
  the commit transaction** and **skips** them in the revision loop (they are not
  entity revisions); `writeOperation` narrowed to exclude them; a defensive
  default added to the stored-revision switch; `ApplyCommitOptions.sqliteAttachments`
  carries the dbId→alias map.
- `Server.transact` attaches the commit's cell-db(s) **before** `applyCommit`
  (`#attachCommitSqliteDbs`, ≤1 db/commit for unqualified-name isolation), passes
  the alias map, detaches in `finally`; `markSpaceDirty` filters `sqlite` ops.

**Tested:** engine-layer (`v2-sqlite-atomic-test.ts`: cell+row land atomically;
a failing trailing op rolls back BOTH) and server-loopback
(`v2-sqlite-protocol-test.ts`: a folded `transact` commit applies; a failing
folded op rolls back the whole commit). Memory suite green; runner compiles
(it uses its own `NativeStorageCommitOperation` union, so the wire-`Operation`
widening doesn't touch its switches).

**Remaining (Stages 4–5): runner client-folding** — make the `sqliteExecute`
builtin record the write on the transaction (a separate `sqliteOps` channel on
`NativeStorageCommit`, merged into the wire `operations[]` at `buildCommit`,
kept out of `applyPending`) so a *handler's* cell writes + `sqliteExecute` land
in **one** commit. Today the builtin still uses the separate `sqlite.execute`
RPC, so handler-level atomicity isn't wired yet (the protocol supports it).

**Design finding for Stage 5 (not in the original plan):** folding `sqliteExecute`
into the commit means the write result (`changes` / `lastInsertRowid`) is no
longer returned synchronously — `applyCommit`'s response carries `seq`/revisions,
not SQLite write results. Options: (a) thread results back via a new
`AppliedCommit.sqliteResults[]` (preserves the `{changes,lastInsertRowid}`
contract; more plumbing), or (b) V1 reports only `{pending:false}` on commit
success (success ⇔ commit success; drop the counts). Decide before implementing;
the current `sqliteExecute` test asserts `changes===1`, so the contract choice
changes that test.

### `_cf_link` result decode — attempted, blocked by static builder schema

Attempted decoding query result `_cf_link` columns to live Cells (stamp the
result cell with an `asCell` schema; store parsed sigil objects). The isolated
mechanism works, but **through a pattern it doesn't**: the pattern reads `q` via
`p.resultSchema`, derived from `sqliteQuery`'s **static** builder return type,
which shadows the query cell's dynamic per-query `asCell` schema. Result link
columns are dynamic; builder return schemas are static — so this needs the
`sqliteQuery<Row>` transformer (Piece B) to make the call site carry `Row` as the
node output schema (Piece B is a *prerequisite* for A-through-patterns), or deep
dynamic-schema propagation. **Reverted** the wiring; kept `parseCfLinkToSigil`.
Encode + imperative round-trip (`decodeCfLinkValue`) work and are tested. See
plans/result-decode-and-row-types.md §7.

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

---

## 2026-06-01 — node-output-schema propagation: attempted, disproven, documented

Ran the endorsed design→test-first→implement loop on the highest-leverage
remaining item (`_cf_link` result decode to live Cells, the root-cause shared
with typed `sqliteQuery<Row>`). Oracle design session →
`plans/node-output-schema-propagation.md` (recommended Option A: generalize
`resultForRawBuiltinOutputBinding` to source the per-query schema from the result
cell).

**RED:** `packages/runner/test/sqlite-cf-link-decode.test.ts` — a pattern SELECTs
a `*_cf_link` column; assert `q.result[0].author_cf_link` is a live `Cell`.
Seeded with a pre-encoded sigil STRING (encode is already proven) to isolate
decode-on-read.

**GREEN attempt (Option A, fully implemented then REVERTED):** built the
per-query `asCell` result schema (link cols detected by the enforced `_cf_link`
suffix), stamped it on the result cell, generalized the runner seam (allow-set
incl. `sqliteQuery`, schema sourced from `result.schema`), decoded stored strings
to sigil objects, and tried BOTH `getAsLink` and `getAsWriteRedirectLink`.

**Result: does not work, and no runner-only change can.** The column kept reading
as the resolved target VALUE (`{name:"Ada"}`), never a `Cell`, across every
realistic consumer path (`.key().get()`, full-tree `result.get()` proxy, `.get()`
at the `q` boundary).

**Corrected root cause (supersedes the earlier "static schema shadows via
combineSchema" framing):** runtime reads derive a child's schema TOP-DOWN from
the CONSUMER's own schema. An untyped `sqliteQuery` lowers to an empty `{}`
consumer schema (verified `p.resultSchema === {}`), so descending
`q → result → [i] → author_cf_link` never carries `asCell`; a deeper link's
schema is only honored once the effective schema ALREADY `hasAsCell`
(`schema.ts:978`, top-level-only `hasAsCell` at `traverse.ts:3245`). Applying
`.asSchema({… asCell})` AT the reading cell DOES rehydrate (the "EXPLICIT" probe
passed) — proving the markers must live on the CONSUMER's schema.

**Decision / where the spec was wrong:** `_cf_link` auto-decode and typed
`sqliteQuery<Row>` are the SAME change and it belongs in the **ts-transformer**,
not the runner — the `Row` type arg must lower to an `asCell`-bearing result
schema injected at the call site (Piece B). For an untyped query the call site
cannot know which columns are links, so untyped auto-decode is impossible by
construction. Piece B is a PREREQUISITE for decode, not independent. The plan's
recommended Option A (and C/D) are superseded; full analysis + the empirical
trace are in `plans/node-output-schema-propagation.md` (VERDICT block).

**Left behind (green):** `sqlite-cf-link-decode.test.ts` now pins CURRENT
behavior — a link column reads back as the sigil-link STRING, decodes via
`decodeCfLinkValue`, and NULL → null — plus an `it.skip` documenting the blocked
auto-decode target. All speculative src edits reverted (no `src/` diff).

---

## 2026-06-01 — Piece B (transformer): sqliteQuery<Row> lowering DONE + green

Design session (Oracle) → `plans/sqlite-query-row-lowering.md`, then implemented
the transformer half red-green:

- **Pre-existing RED found & fixed:** the registry guard test
  (`ts-transformers/test/core/commonfabric-runtime-registry.test.ts`) was already
  failing on this branch — the runner factory injects
  `sqliteDatabase`/`sqliteQuery`/`sqliteExecute` but they were absent from
  `COMMONFABRIC_RUNTIME_EXPORT_REGISTRY`. Registered all three as
  `runtime-call`/`reactiveOrigin` (commit). Now green.
- **RED-T1 (fixtures):** added `sqlite-query-row-schema.{input,expected}` and
  `sqlite-query-no-type-arg.{input,expected}` under
  `ts-transformers/test/fixtures/schema-injection/`. Generated the golden WITHOUT
  the branch first (RED: `<Row>` erased, no `rowSchema`).
- **GREEN:** added a dedicated injection branch in `schema-injection.ts` keyed on
  `callKind.kind === "runtime-call" && exportName === "sqliteQuery"` (mirrors the
  generate-object branch; injects a bare `rowSchema` property; untyped calls are
  a no-op). Regenerated goldens — the injected
  `rowSchema.properties.author = { $ref:"#/$defs/User", asCell:["cell"] }`, i.e.
  the **aliased** link column `author` is detected by Row typing with no
  `_cf_link` suffix (the load-bearing result). `n` → `{type:"number"}`.
- **Regression:** full ts-transformers suite 295/0; fixture suite 354 steps/0.
  Additive: untyped sqliteQuery unchanged; the runtime ignores the extra
  `rowSchema` field (forward-compatible) until Piece A reads it.
- Authoring doc (`adding-type-arg-schema-lowering.md`) updated: sqliteQuery is now
  the canonical *nested-result* reference (transformer injects bare schema,
  runtime wraps into `result.items`).

**Decision / where the spec was incomplete:** the prior plan assumed Piece B was
purely a transformer change. It is — for the LOWERING. But auto-decode end to end
ALSO needs the runtime half (Piece A: builtin reads `rowSchema`, composes
`result.items`, stores sigil OBJECTS) AND is only observable through the full
`cf check` pipeline (runner unit tests bypass the transformer ⇒
`p.resultSchema === {}`, proven in node-output-schema-propagation.md). So Piece B
(this commit) unblocks Piece A but does not by itself flip the skipped runner
test. Piece A remains the next step.

---

## 2026-06-01 — Handler-atomicity correction + Stage 1 commit-fold seam (db.exec)

Corrected an earlier overstatement: I had said handler-atomicity (a handler's
cell write + a SQL write in one commit) was "not achievable." It IS achievable —
I had conflated the WRITE (foldable into the handler's commit, atomic) with the
RESULT REPORTING (a separate post-commit tx, which is harmless / now dropped).

Design session (Oracle) → `plans/sqlite-execute-commit-fold.md`. Decided design
(user): `sqliteExecute` becomes a commit-folded imperative `db.exec` —
**imperative-only** (no declarative pattern-body write), **abort-only** (SQL
failure aborts the whole commit; no result cell), **no reactOn re-run** after a
folded write, **throw on read-after-write** (don't make pending writes
synchronously visible). Future CFC-safe error handling will make the abort throw
correctly, so abort-only is forward-compatible.

**Found:** `recordSqliteWrite` did NOT exist — the runner never folded a sqlite
op into its commit (`getNativeCommit` emitted cell-doc ops only); the atomicity I
had tested lived only at the engine/server/protocol layer (applyCommit can carry
a sqlite op), while the builtin used a post-commit RPC.

**Stage 1 (DONE, committed d10d37952, runner 501/0):** built the runner-side
fold seam — `recordSqliteWrite(space, op)` on the tx (+ both wrappers),
`NativeStorageCommit.sqliteOps`, emission in `getNativeCommit`, relaxed
empty-commit guards, and `commitNative`/`commitOperations` appending the wire
`op:"sqlite"` LAST in `ClientCommit.operations` (out of doc-pending/touched/
notify). Test `sqlite-commit-fold.test.ts`: a cell write + folded INSERT commit
atomically; a sqlite-only commit isn't dropped; a failing INSERT aborts the whole
commit and rolls back the sibling cell write.

**Stage 2 (NOT STARTED, handed off):** rewrite `sqliteExecute` as the imperative
`db.exec` fn + drop the reactive node + API/registry/test churn. Deferred
deliberately — sprawling cross-layer rewrite with a builder↔builtins import-cycle
hazard; a half-done version breaks the compile. tx access is confirmed
(`db.tx` via the handler's tx-bound cell). Full notes in the plan's STATUS block.
Stage 1 is independent and shippable.
