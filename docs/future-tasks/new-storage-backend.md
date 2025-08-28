# New Storage Backend Implementation Plan

This document tracks the implementation of the new storage backend described in
`docs/specs/storage/*`.

Summary and code links

- Status: Heads, PIT, Snapshots, Branching, CAS, Queries, Transactions +
  Invariants, and WS v2 are implemented. Toolshed routes are wired behind a
  flag. Remaining: per-tx UCAN signature/chain verification, WS resume test
  re-enable, logging/metrics, and HTTP deprecation cleanup.
- Flags (defaults): ENABLE_NEW_STORAGE=0, ENABLE_SERVER_MERGE=0.
- Provider entry: packages/storage/src/provider.ts
- SQLite modules (current layout under `store/` and `query/`):
  - Core store: `packages/storage/src/store/*` including `db.ts`, `schema.sql`,
    `heads.ts`, `change.ts`, `pit.ts`, `projection.ts`, `snapshots.ts`,
    `branches.ts`, `cas.ts`, `chunks.ts`, `tx.ts`, `tx_chain.ts`, `merge.ts`,
    `bytes.ts`, `crypto.ts`, `cache.ts`
  - Query: `packages/storage/src/query/*` including `sqlite_storage.ts`, IR/eval
  - WS: `packages/storage/src/ws/*`
- Toolshed routes (flagged): `packages/toolshed/routes/storage/new/*` and gating
  in `packages/toolshed/app.ts`
- CLI tasks: packages/storage/deno.json and packages/storage/cli/*
- Specs: docs/specs/storage/*.md (API, PIT, branching, snapshots, tx processing,
  invariants, queries)

## Goals

- Implement Automerge-backed `doc:` storage first (documents, branches, heads),
  then layer content-addressed primitives where needed.
- Provide query, subscription, and snapshot capabilities.
- WebSocket-only API (WS v2): deprecate HTTP routes; all commands over a single
  WS per space.
- Integrate with Toolshed to expose HTTP endpoints for the storage API.

## Status snapshot (current repo)

- `packages/storage` exists with public types in `interface.ts` and a provider
  factory.
- In-memory prototype and tests were removed; we will build directly on SQLite.
- Specs cover schema, PIT, transactions, branching, snapshots,
  queries/subscriptions, UCAN, and operations.

## Non-goals (for initial cut)

- Multi-region replication.
- Advanced query optimizations.
- Full UCAN integration beyond basic token validation.

## Milestones & Acceptance Criteria

- Each task group lands with unit tests and `deno task check` passing.
- Toolshed routes behind an `ENABLE_NEW_STORAGE=1` flag initially. HTTP routes
  will be deprecated in favor of the WS v2 endpoint.
- API surface documented and aligned to `docs/specs/storage/03-api.md`.

## Remaining Work (prioritized, consolidated)

- Reliability (WS v2)
  - [x] Fix ordering and re-enable the integration test for resume with acks
        after reconnect (re-implemented as epoch-based resume in
        `packages/storage/integration/ws_v2_resume_epoch.test.ts`)

- Types / DX
  - [ ] Optional: introduce branded types for `DocId`, `BranchId`, `BranchName`

- Testing
  - [ ] How to test over a socket without booting a server

- Observability
  - [ ] Adopt shared logger (using @commontools/utils/logger) across PIT,
        snapshots, heads, and WS modules; gate by `LOG_LEVEL`
  - [ ] Metrics: tx applied/conflicts; snapshot creations and chunk emits; PIT
        fast-path vs fallback; WS deliveries (sent/dropped/acked)

- API surface / Cleanup
  - [ ] Deprecate HTTP routes in favor of the WS v2 endpoint; retain
        PIT/snapshots helpers only if needed

- Security / UCAN
  - [ ] Verify per-tx signature + delegation chain (WS v2) and bind receipts to
        the crypto chain
  - [ ] Client helpers for UCAN-wrapped calls and ack batching
  - [ ] Consider modelling ACK as a UCAN invocation or mirrored response type

- HIGH PRIORITY: Client baseline commit behavior
  - [ ] Ensure first client tx builds changes on the exact delivered Automerge
        baseline and uses those heads for `baseHeads`, so that a fresh space/doc
        commit returns `ok` reliably. Investigate/resolve any remaining cases
        where the client constructs changes that do not depend on server heads
        despite awaiting initial delivery. Add focused tests to cover this path
        (fresh tmp SPACES_DIR, seed + client tx).

## Implementation map (spec → modules)

- SQLite provider: `packages/storage/src/sqlite/*` implements `SpaceStorage`
  over per-space DB files with PRAGMAs (§02).
- Change decoding and heads: `change.ts`, `heads.ts` use `@automerge/automerge`
  to parse headers and update heads (§01, §02, §04).
- PIT & projection: `store/pit.ts`, `store/projection.ts` implement
  snapshot+chunk fast-path and fallback (§05, §07). PIT signature simplified to
  `(db, docId, branchId, targetSeq)`.
- Transactions & crypto chain: `store/tx.ts`, `store/tx_chain.ts` implement
  pipeline, digests, and signatures (§04). JSON cache writes are factored into
  `store/cache.ts` and invoked post-commit.
- CAS primitives: `store/cas.ts` over `am_change_blobs` and friends (§02, §06).
- Branching/merge: `store/branches.ts` for creation/closure; merge synthesis is
  centralized in `store/merge.ts` and used by both provider and tx pipeline.
- Snapshots: `store/snapshots.ts` with cadence policies and pruning (§07).
- Queries/subscriptions: `query_ir.ts`, `query_eval.ts`, `query_ws.ts` and SQL
  tables in §11 (§08–§12).
- UCAN: `ucan.ts` to validate cap and nb digests (§13).
- Toolshed routes: `packages/toolshed/routes/storage/new/*` for HTTP and WS
  (§03, §08).

### Runtime performance notes (query read path)

- Added a per-version JSON cache (writes via `store/cache.ts`) used by
  `query/sqlite_storage.ts` for the `read()` and `readDocAtVersion()` methods.
  The cache is keyed by `${docId}\u0001${branchId}\u0001${seq}` and avoids
  repeatedly calling `Automerge.load()`/`Automerge.toJS()` for the same document
  version during query evaluation. This significantly reduces the cost of
  traversals with higher link budgets and prevents superlinear slowdowns in
  recursive VDOM validations observed in benchmarks.
- Follow-up: consider an LRU cap and/or invalidation hooks on write paths to
  bound memory in long-lived server processes.

### Query traversal/budgeting semantics (updated)

- Replaced per-hop depth budgeting with a global visit cap enforced via the
  evaluator's `VisitContext.seenIRDocPath` set. The cap prevents traversal
  explosion across all dimensions (fanout, depth, cycles) without tying cache
  keys to a numeric budget.
  - Default: `DEFAULT_VISIT_LIMIT = 16,384` unique `(IR, doc, path)` visits per
    evaluation.
  - Behavior: When the limit is reached, the evaluator returns
    `MaybeExceededDepth` (conservative) rather than recursing further.
- `EvalKey` no longer includes a `budget` field, and provenance keys have been
  simplified accordingly (now keyed by `(ir, doc, path)`).
- Removed the previous budget-based fast-memoization path; the global visit cap
  and standard memoization are sufficient and avoid key proliferation.

### Benchmarks (updated)

- Benchmarks in `packages/storage/bench/query_bench.ts` no longer vary a
  traversal budget. Two recursive cases were added to better represent real
  workloads under the global visit cap:
  - "vdom: recursive validation over many nodes (full pass)": validates many
    VDOM nodes against a recursive schema.
  - "schema: recursive traversal across task edges": exercises recursive graph
    traversal along `value.edges`.

## Detailed Task List (SQLite-first)

### 0. Package skeleton (done)

- [x] Create `packages/storage` package with basic exports and placeholder
      provider factory.
- [x] Add this plan document.
- [x] Register package in root `deno.json` workspace.

### 1. SQLite core (schema + heads-first)

- [x] Dependencies: add `npm:@automerge/automerge`
- [x] DB lifecycle: per-space DB file management, PRAGMAs, and connection pool
      (single writer).
- [x] Migrations: implement `02-schema.md` tables and indexes; idempotent
      startup.
- [ ] Heads path:
  - [x] Decode Automerge change bytes → `change_hash`, `deps`, `actor_id`,
        `seq`.
  - [x] Verify deps subset of current heads; update heads
        `(heads − deps) ∪ {hash}`.
  - [x] Reject if any `dep` missing for `(doc, branch)`.
  - [x] Enforce `actor_id`/`seq` monotonicity per actor in branch history.
  - [x] CAS: store change bytes (dedup) in `am_change_blobs`; index rows in
        `am_change_index`.
  - [x] Maintain `am_heads(seq_no, tx_id, heads_json, root_hash)` (root_hash
        placeholder for now).

Acceptance:

- Unit tests cover head updates (linear change, fork, merge), dep missing, and
  actor/seq monotonicity.

Current: linear, fork, and client-merge tests implemented; missing-dep covered;
actor/seq monotonicity enforced; CAS write and indexing implemented.

### 2. Point-in-time (PIT) and projection (DONE)

- [x] 2a) Full snapshot cadence and storage
- [x] 2b) Emit incremental chunks on submit; PIT uses chunks after last snapshot

- [x] Compute `upto_seq_no` for epoch/tx via `am_change_index`.
- [x] PIT reconstruction:
  - [x] Fast path from `am_snapshots` + `am_chunks` → concatenated AM binary.
  - [x] Fallback from snapshot + apply changes via `Automerge.applyChanges()`.
- [x] Projection helper `project(docBytes, paths[])` for selective subtrees.

Acceptance:

- [x] PIT byte equality with a client-generated doc at the same point.
- [x] Projection tests for path subsets and root.

Implementation:

- `packages/storage/src/store/pit.ts` implements PIT reconstruction with both
  fast path and fallback
- `packages/storage/src/store/projection.ts` implements JSON projection for
  selective subtrees
- Updated `packages/storage/interface.ts` to include `at?: string` for
  timestamp-based PIT
- Updated `packages/storage/src/provider.ts` to integrate PIT and projection
  functionality
- Comprehensive test coverage in
  `packages/storage/test/pit-and-projection-test.ts`

### 3. Branching and merge semantics (DONE)

- [x] Create/close branches; lineage metadata.
- [x] Client-driven merge: accept merge change with deps = heads to collapse
      branches; validate sources.
- [x] Optional server merge (flagged) using `Automerge.merge` to synthesize
- [x] Close branch post-merge; set `merged_into_branch_id`.

Acceptance:

- Tests: fork → concurrent edits → client-merge collapses heads; optional
  server-merge path works under flag.

Implementation:

- Added `packages/storage/src/sqlite/branches.ts` with `createBranch()` and
  `closeBranch()` built on existing heads/doc helpers; records
  `parent_branch_id` and `merged_into_branch_id`.
- Added `packages/storage/test/branches-basic-test.ts` covering creating a new
  branch and ensuring reads work after closing.

### 4. Snapshots (SQLite-backed) — DONE

- [x] Implement snapshot cadence and storage in `am_snapshots` / `am_chunks`.
  - [x] Full snapshots via `Automerge.save()`.
  - [x] Optional incremental chunks to accelerate PIT.
- [x] Integrity: maintain `root_ref = referJSON({ heads: sorted(heads) })` in
      `am_heads` for verification.

Acceptance:

- Snapshot/restore tests; integrity check matches stored `root_ref`.

Implementation:

- Added `packages/storage/src/sqlite/snapshots.ts` with `maybeCreateSnapshot()`
  using a basic cadence (default 5 changes) and storing full snapshots with
  upto_seq_no.
- Wired snapshot creation into submitTx() after heads update.
- Added `packages/storage/test/snapshots-basic-test.ts` ensuring cadence
  triggers and PIT returns the latest state.

### 5. Transactions (multi-doc) and invariants — DONE

Implementation notes:

- Provider request/receipt types are wired (`packages/storage/src/provider.ts` →
  `store/tx.ts`).
- Server pipeline in `packages/storage/src/store/tx.ts`:
  - Validates read-set heads; rejects on conflict (all-or-nothing rollback).
  - Validates `baseHeads` vs current heads; optionally synthesizes server merge
    when enabled.
  - Per-change validation: deps present, actor/seq monotonicity, duplicate hash
    idempotency.
  - CAS write + `am_change_index` append; heads update and atomic commit.
  - Computes digests via `merkle-reference/json` for `baseHeads`/`changes` and
    records stub crypto chain (`tx_chain.ts`).
  - Runs invariant hooks (`store/invariants.ts`) on materialized JSON; fail
    closed. Updates per-branch JSON cache on success (`store/cache.ts`).
- Receipts include per-doc status/newHeads/applied and aggregate conflicts; see
  tests under `packages/storage/test/sqlite/*tx*.ts` and
  `sqlite/invariants_test.ts`.

Acceptance: covered by `tx_pipeline_test.ts`, `tx_conflict_test.ts`,
`tx_idempotent_test.ts`, and `tx_rollback_test.ts`.

### 6. Content-addressed primitives (SQLite CAS) — DONE

- [x] CAS interface over SQLite tables:
  - [x] `put(kind, bytes, meta?) -> digest`, `get(digest) -> {kind,bytes,meta}`,
        `has(digest)` using `am_change_blobs` for changes and `cas_blobs` for
        snapshots/generic blobs.
  - [x] Record kinds: `am_change`, `am_snapshot`, `blob`.
- [x] Indexes: `am_change_index` lookups by `(docId, branchId, seqNo)` and
      `(docId, branchId, txId)`; JSON meta indexes on `cas_blobs`.

Acceptance:

- Unit tests for CAS and indexes added at
  `packages/storage/test/sqlite/cas_test.ts`.

### 7. Queries and subscriptions — DONE (resume test tracked below)

- [x] Query IR compiler and evaluator with provenance/touch set tracking.
- [x] Link traversal semantics and depth budgeting.
- [x] Subscription tables from §11 and WS server handling; at-least-once with
      epoch acks. WS v2 endpoint at `/api/storage/new/v2/:space/ws` multiplexes
      `get`, `subscribe`, and `tx`. Deliver frames are untied from task/return;
      initial completion is signaled via `complete`.

Acceptance:

- Query tests: filters, sorts, limits, joins/reference traversals.
- Subscription tests: multiple consumers, ordering, no duplication, reconnect
  resume.

### 8. UCAN / Access control (MVP)

- [x] Minimal UCAN validation and capability checks.
- [x] Enforce space-level caps on tx and read endpoints; optional WS upgrade
      auth via env flag.
- [x] Per-tx signature + delegation chain verification and binding receipts to
      crypto chain: tracked in Remaining Work.

Acceptance:

- Authorized vs unauthorized attempts covered by tests.

### 9. Toolshed integration (flagged)

- [x] Add routes under `packages/toolshed/routes/storage/new/` for docs/branches
      heads, tx, PIT read, query, subscribe, snapshots; use `doc:<ref>` and
      `root_ref` in responses.
- [ ] Deprecate HTTP routes in favor of the WS v2 endpoint
- [x] Gate on `ENABLE_NEW_STORAGE`.

Acceptance:

- Route tests passing; feature flag works.

### 10. Tooling (no migration needed)

- [x] CLI for exporting/importing snapshots and listing spaces/branches.

Acceptance:

- Docs updated; happy-path flows verified in tests.

Usage examples:

- List spaces (under $SPACES_DIR or ./.spaces): deno task
  new-storage:list-spaces

- List branches in a space: deno task new-storage:list-branches -- --space
  my-space

- Export a snapshot (Automerge binary) at a given seq to a file: deno task
  new-storage:export-snapshot -- --space my-space --doc my-doc --branch main
  --seq 12 --out ./my-doc-main-12.am

- Import a snapshot file for fast PIT (records in am_snapshots and CAS): deno
  task new-storage:import-snapshot -- --space my-space --doc my-doc --branch
  main --file ./my-doc-main-12.am

## Module layout (proposed)

```text
packages/storage/src/
  store/
    db.ts           // open/close, PRAGMAs, migrations
    schema.sql      // DDL source for migrations
    cas.ts          // CAS over am_change_blobs and friends
    heads.ts        // am_heads logic, actor/seq validation
    change.ts       // decode Automerge change header
    branches.ts     // create/close/merge
    tx.ts           // tx pipeline up to DB commit
    tx_chain.ts     // tx hashing/signatures
    pit.ts          // point-in-time reconstruction
    projection.ts   // JSON projection helper
    snapshots.ts    // cadence & pruning
  query/
    ir.ts           // IR node types + compiler
    eval.ts         // evaluator + provenance
    sqlite_storage.ts // storage reader with json_cache fast-path
  ws/
    server.ts       // WS v2 handlers (get/subscribe/tx)
    protocol.ts     // WS protocol types
    ucan.ts         // UCAN validation and nb checks
  provider.ts       // SpaceStorage backed by SQLite
```

## Dependency additions

- `npm:@automerge/automerge` — change parsing, apply/save.
- use `@db/sqlite` for SQLite in Deno (replaces earlier `node:sqlite` note)
- Reuse `identity` package for Ed25519 where possible.

## Testing & CI

- Unit tests per module; integration tests for tx, PIT, branches, snapshots,
  queries.
- Web WS tests via `packages/deno-web-test` harness where applicable.
- Bench basic write/read throughput; snapshot cadence behavior.

## Rollout & flags

- `ENABLE_NEW_STORAGE=1` gates Toolshed routes.
- `ENABLE_SERVER_MERGE=0` default; can be enabled per-space for testing.
- Ship SQLite provider alongside in-memory for fallback/testing.

## Open Questions

- Snapshot cadence/retention defaults.
- Server-side merge scope; when to synthesize merge changes.
- Binary subscription stream format and ergonomics.

## Implementation notes (phase 2 kickoff)

- Existing SQLite backend modules to reuse/extend:
  - packages/storage/src/store/db.ts — SQLite open/PRAGMAs/migrations
  - packages/storage/src/store/heads.ts — heads state, root_ref, branch/doc init
  - packages/storage/src/store/change.ts — decode Automerge change headers
  - packages/storage/src/store/pit.ts — PIT reconstruction (epochForTimestamp,
    uptoSeqNo, getAutomergeBytesAtSeq)
  - packages/storage/src/store/snapshots.ts — snapshot cadence
    (DEFAULT_CADENCE=5), writes am_snapshots
  - packages/storage/src/store/branches.ts — create/close branches with lineage
  - packages/storage/src/store/projection.ts — JSON projection for selective
    paths
  - packages/storage/src/provider.ts — SpaceStorage implementation and submitTx
- CAS tables/primitives already referenced:
  - am_change_blobs (bytes dedup) and am_change_index (per-branch index) used in
    submitTx and PIT fallback.
  - Follow-up: factor a sqlite/cas.ts wrapper if we expand beyond change blobs
    (snapshots, generic blobs).
- Provider submitTx implementation:
  - packages/storage/src/provider.ts delegates to store/tx.ts for the pipeline;
    it maps public/internal types and serializes writes per space handle.
- PIT, snapshots, and projection (spec alignment):
  - Spec refs: docs/specs/storage/05-point-in-time.md (§05) and 07-snapshots.md
    (§07).
  - Implementation: sqlite/pit.ts and sqlite/snapshots.ts match the described
    fast-path and fallback; projection helper exists.
- Merge semantics / branching:
  - Spec ref: docs/specs/storage/06-branching.md (§06).
  - Implementation: `store/branches.ts`; client-driven merges validated by
    submitTx logic (deps ⊆ heads). Server merge synthesis is available behind a
    flag and implemented in `store/merge.ts`.
- Query engine:
  - Implemented under packages/storage/src/query/* per specs (09, 10, 11, 12).
- Invariants:
  - Spec ref: docs/specs/storage/14-invariants.md (§04 numbering in plan);
    provider submitTx currently lacks invariant hooks; to add during Tx pipeline
    work.
- Toolshed/WS and feature flags:
  - WS v2 implemented in `packages/storage/src/ws/*`; Toolshed mounts new routes
    behind `ENABLE_NEW_STORAGE=1`.
- Baseline execution:
  - packages/storage: deno task check/test PASS.
  - Workspace-wide runs may include mirrored .conductor paths; prefer
    per-package runs.

Action items for phase 2 (expanded):

- [x] Transactions
  - [x] All-or-nothing semantics for multi-doc transactions (`store/tx.ts`).
  - [x] Focused tests for rollback and receipts.
  - [x] Invariant hooks (pre-commit) with clear interface; fail-closed.

- [x] Merge identity and semantics
  - [x] Unify merge identity via `decodeChangeHeader` in all codepaths.
  - [x] Server merge actor policy guard via env flag; tests added.

- [x] PIT determinism and behavior
  - [x] Deterministic PIT by `seq_no`; identical bytes across reconstructions.

- [x] Prepared statements rollout (performance)
  - [x] Introduce prepared statement caching for hot-path queries beyond
        `store/tx.ts`:
    - [x] `store/heads.ts` (reads and updates).
    - [x] `store/pit.ts` (snapshot/chunk/changes scans).
    - [x] `store/cache.ts` upsert and `query/sqlite_storage.ts` reads.

- [x] API layering and consistency
  - [x] Centralize SQL timestamp snippet as a constant and use everywhere
        (`store/sql.ts`).
  - [x] Move per-space toggles (e.g., chunking, cadence) behind `config.ts`
        accessors; make `store/flags.ts` delegate.
  - [x] Create a `store/index.ts` facade exporting a curated API to reduce
        import complexity and cycles.

- [ ] Logging and observability
  - [ ] Adopt the shared logger across PIT, snapshots, heads, and WS modules;
        gate verbose logs by `LOG_LEVEL`.
  - [ ] Add counters/histograms for:
    - [ ] Applied changes per tx; conflicts/rejections.
    - [ ] Snapshot creations and chunk emissions.
    - [ ] PIT fast-path vs fallback use.
    - [ ] WS deliveries (sent/dropped/acked) — when subscription refactor lands.

- [x] SQL/schema
  - [x] Verify and document required indexes (added in `004_perf_indexes.sql`):
    - [x] `am_change_index` on `(branch_id, actor_id, seq_no)`,
          `(branch_id, change_hash)`, `(doc_id, branch_id, seq_no)`.
    - [x] `am_chunks` on `(doc_id, branch_id, seq_no)` for PIT fast-path.
    - [x] `subscription_deliveries` on `(subscription_id, delivery_no)` and
          `(subscription_id, acked, delivery_no)`.
    - [x] `json_cache` PK/unique on `(doc_id, branch_id)`.

- [ ] Testing
  - [x] JSON cache tests: verify tip reads utilize cache, historical reads
        bypass, and cache updates on write.
  - [x] WS resume/acks test: re-implemented with epoch-based resume semantics;
        ensures deliveries resume from the last acknowledged epoch.
  - [ ] Merge actor/seq tests for synthesized merges.
  - [x] PIT determinism tests.
  - [x] Client integration tests added: optimistic commit promotion, conflict
        rollback, and synced() waiting for in-flight commits (see
        `packages/storage/integration/client_*.test.ts`).

- [x] Developer experience and documentation
  - [x] Update specs (`03-api.md`, `04-transactions.md`, `05-point-in-time.md`,
        `06-branching.md`) to reflect:
    - [x] All-or-nothing tx semantics and invariant hooks.
    - [x] Merge actor policy and deterministic PIT behavior.
  - [x] Refresh this plan to mark completed items and track remaining work.

### Type strictness hardening (new)

- Goals: tighten type safety across the storage package, remove
  implicit/explicit `any`, add explicit return types for exported APIs, refine
  WS protocol types, and introduce typed prepared statements. No runtime
  behavior changes; compile-time only. No flags, no compatibility constraints.

- Phases:

  - [x] Phase 0: Compiler guardrails
    - [x] Enable strict TypeScript compiler options in
          `packages/storage/deno.json`:
      - `strict`, `noImplicitReturns`, `noUncheckedIndexedAccess`,
        `exactOptionalPropertyTypes`, `useUnknownInCatchVariables`.

  - [x] Phase 1: Public/exported API annotations
    - [x] Ensure all exported functions/classes in `packages/storage/src/**`
          have explicit return types.
    - [x] Add a precise return type for `createTxProcessor()`.

  - [x] Phase 2: WS protocol typing + guards
    - [x] Refine `Deliver` docs payload to a discriminated union:
      - `snapshot` → `body: string` (base64 bytes), `delta` → `body: string[]`
        (base64 changes).
    - [x] Add minimal narrowing for ACK vs invocation and Blob decoding in
          `src/ws/server.ts` (no new deps).
    - [x] Remove most `as any` casts in `src/ws/server.ts` by using precise
          types.

  - [x] Phase 3: Prepared statements row/param typing (scaffold)
    - [x] Replace `any` fields in `src/store/prepared.ts` with lightweight
          wrapper interfaces that type params and rows for the statements used
          in hot paths: heads, PIT, cache, and tx index operations.
    - [x] Update call sites to rely on typed return/params instead of ad-hoc
          casts.

  - [x] Phase 4: Transactions internals
    - [x] Remove internal `any` receipts in `src/store/tx.ts`; return a typed
          internal receipt without extra fields, and map to public receipt in
          `provider.ts` (as is).
    - [x] Eliminate `(r as any)` fallbacks on reads; rely on the provider
          mapping to pass the internal read shape.
    - [x] Fix the read-conflict path to return the internal result shape (was
          using `ref` previously).

  - [x] Phase 5: Query engine cleanups (unknown + guards)
    - [x] Replace `any` with `unknown` in `src/query/eval.ts`,
          `src/query/ir.ts`, and add local guards where needed.
    - [x] In `src/query/sqlite_storage.ts`, have `read()`/`readDocAtVersion()`
          return `unknown` instead of `any`; keep cache/PIT paths typed via
          prepared statements.

  - [x] Phase 6: JSON path/projection typing
    - [x] Update `src/json/path.ts` and `src/store/projection.ts` to use
          `unknown` and narrow when reading/writing.

  - [ ] Phase 7 (optional): ID branding
    - [ ] Introduce branded types for `DocId`, `BranchId`, `BranchName` to
          prevent accidental mixups at boundaries.

- Acceptance criteria:
  - [x] `packages/storage` compiles with strict options enabled.
  - [x] No `as any` usages remain in runtime code for WS server, tx pipeline,
        and query reader; residual casts are localized and justified.
  - [x] All exported functions have explicit return types.
  - [x] Tests and `deno task check` pass.

### WS v2 Tasks (summary)

- [x] Define WS v2 protocol types (Invocation, Authorization, UCAN, TaskReturn,
      Deliver, Ack, Complete)
- [x] Implement WS v2 handler in `packages/storage` with `get`/`subscribe` and
      `complete` as task/return
- [x] Untie Deliver frames from RPC jobs; persist acks and resume
- [x] Wire `/storage/tx` over WS and return task/return receipt
- [x] Base64 encode/decode change bytes for WS tx
- [x] Stream initial snapshot rows via Deliver before `complete`
- [x] Enforce UCAN at upgrade/first invocation (read capability on space)
- [ ] Verify per-tx signature + delegation chain
- [ ] Client helpers for UCAN-wrapped calls and ack batching
- [x] Integration tests: get-only complete; basic subscribe+deliver+ack; tx over
      WS
- [x] Integration test (resume with acks): implemented as epoch-based resume and
      enabled (`packages/storage/integration/ws_v2_resume_epoch.test.ts`).
- [x] Remove/deprecate HTTP routes from docs and codepaths: tracked in Remaining
      Work cleanup
- Add invariant hook points within submitTx pipeline and basic invariant
  examples.
- Consider sqlite/cas.ts wrapper for CAS beyond change blobs.
- Resolve deno test import-map issue or restrict default test set to avoid
  mirrored .conductor paths.

### Subscriptions Refactor (query-driven, client-known epochs)

- [x] Protocol and behavior
  - [x] Spec updates for epoch-grouped Deliver, `/storage/hello`, and epoch
        acks.
  - [x] Subscription shape `(docId, path, schema)` documented; single-doc is
        `(docId, [], false)` with root always delivered.
  - [x] Conservative resend semantics documented.
- [x] Schema
  - [x] `client_known_docs(client_id, doc_id, epoch)` with index (in schema.sql)
- [x] Server implementation
  - [x] WS hello stores `{clientId, sinceEpoch}` in session state.
  - [x] Active subscriptions kept per socket; dropped on close.
  - [x] In-memory pending-by-epoch until ack; ack updates `client_known_docs`.
  - [x] get/subscribe evaluates query, computes doc set, delivers missing docs,
        then sends `complete`.
  - [x] After each tx, provenance + change processing drives per-client doc
        updates; epoch-batched deliver.
- [x] Deltas and snapshots
  - [x] Snapshot = Automerge bytes when no baseline; Delta = base64 change bytes
        when baseline epoch known.
- [ ] Tests
  - [x] Integration: multi-consumer subscribe; epoch-batched deliver + ack.
  - [x] Integration: get-only backfill then complete.
  - [x] Integration: resume with acks (reconnect) — re-implemented with
        epoch-based resume and enabled.

#### WS v2 resume (epoch ACK) — implementation plan

We will replace the outdated deliveryNo-based resume test with an epoch-based
reconnect suite that verifies both "exact resume" and "earlier-than-last-ack"
scenarios. This validates that the server correctly interprets client-known
epochs and chooses an appropriate payload (snapshot vs delta) on reconnect.

Test file: `packages/storage/integration/ws_v2_resume_epoch.test.ts`

Connections used:

- **conn0 (seeder)**: sends tx to create and update the doc
- **conn1 (resumer-exact)**: subscribes, ACKs latest epoch, drops, reconnects
  with `/storage/hello { sinceEpoch = lastAck }`
- **conn2 (resumer-stale)**: subscribes, ACKs latest epoch, drops, reconnects
  with `/storage/hello { sinceEpoch = firstAck }` (earlier than latest)

Protocol recap (already implemented):

- Hello: `/storage/hello` with `{ clientId, sinceEpoch }`
- Subscribe: `/storage/subscribe` with `{ consumerId, query }`
- Deliver:
  `{ type: "deliver", streamId, epoch, docs: [{ kind: "snapshot"|"delta", body: ... }] }`
- Ack: `{ type: "ack", streamId, epoch }`
- Complete: task/return with `is.type === "complete"`

Plan and expected behavior:

1. Boot a WS v2 server on an ephemeral port with a temp `SPACES_DIR`.
2. Open three sockets (conn0, conn1, conn2) for the same `spaceDid`.
3. conn1 and conn2: send `/storage/subscribe` for the test doc (e.g. `doc:s1`,
   path [], schema:false).
   - Expect one initial `deliver` each (snapshot or delta) then `complete`.
   - Send an ACK for the `deliver.epoch` on each.
   - Record the first ACK epoch as `ack1` and the latest as `ack2`.
4. conn0: seed the doc using `createGenesisDoc` + `/storage/tx`.
   - Wait until both conn1 and conn2 receive the initial deliver and ACK it;
     capture that epoch as `ack1`.
5. conn0: apply one more change via `/storage/tx`.
   - Both conn1 and conn2 receive another deliver; ACK and record this as
     `ack2`.
6. Close conn1 and conn2.
7. Reconnect conn1 and conn2, send `/storage/hello`:
   - conn1: `sinceEpoch = ack2` (exact resume)
   - conn2: `sinceEpoch = ack1` (stale resume)
8. Re-subscribe on both conn1 and conn2 for the same doc.
   - conn1: server already knows client is current (sinceEpoch == lastAck), so
     there should be no backfill deliver upon subscribe (only `complete`).
   - conn2: server sees a stale baseline; it must send a backfill deliver for
     the doc before `complete`. Payload may be a `snapshot` or a `delta` chain
     based on server policy. Test accepts either kind.
9. conn0: apply another change via `/storage/tx`.
   - Both conn1 and conn2 should receive a deliver for this new epoch and ACK
     it.

Assertions:

- Exact resume (conn1): after re-subscribe, no initial deliver is required;
  after the next tx, a single deliver is received whose `epoch` > `ack2`. Kind
  may be `delta` depending on server policy; the critical check is that no
  redundant snapshot is sent at re-subscribe time.
- Stale resume (conn2): after re-subscribe, a backfill deliver is received prior
  to `complete`. The deliver kind is either `snapshot` or `delta[]`; the test
  only asserts that a content deliver occurs to bring the client up-to-date.
- After the subsequent tx from conn0, both conn1 and conn2 receive one new
  deliver and successfully ACK by epoch.

Notes:

- Use the same `clientId` across reconnects per socket to exercise
  `client_known_docs` resume behavior.
- Reconnection timing is guarded with watchdog timeouts to avoid hangs.
- The test should be resilient to snapshot vs delta selection and only assert
  the presence of an expected content deliver and correct epoch monotonicity.

Acceptance criteria:

- New test file added; passes reliably on CI and locally.
- conn1 (exact resume) observed with no backfill on subscribe and a single
  deliver after the next tx.
- conn2 (stale resume) observed with a backfill deliver on subscribe and a
  deliver after the next tx.

## Cleanup tasks

- [x] in server.ts and maybe other places it says "standed in for
      merkle-reference", just actually use it!
- [x] remove all try { console.log() } catch {}
- [ ] server: ack should also be a UCAN invocation, or better mirrored as a
      response type.
- [ ] How to test over a socket without booting a server.

### Deduplication and consistency pass (phase 2)

- Goals: eliminate small but widespread duplication (base64 helpers, path
  keying, type drift, migrations/flags sprawl) and align runtime behavior with
  specs.

- Tasks:

- [x] Create shared bytes codec
  - [x] Add `packages/storage/src/codec/bytes.ts` exporting:
    - [x] `encodeBase64(bytes: Uint8Array): string`
    - [x] `decodeBase64(s: string): Uint8Array`
    - [x] `encodeBase64Url(bytes: Uint8Array): string`
    - [x] `decodeBase64Url(s: string): Uint8Array`
    - [x] `bytesToHex(bytes: Uint8Array): string` (re-export/impl)
    - [x] `hexToBytes(hex: string): Uint8Array` (re-export/impl)
  - [x] Replace ad-hoc helpers in `src/ws/server.ts` and `src/ws/ucan.ts`.
  - [x] Migrate shared test utilities to import the module (keep local helpers
        for now).

- [x] Standardize path keying
  - [x] Add `packages/storage/src/path.ts` with `keyPath(tokens: string[])`
        wrapper.
  - [x] Replace direct `JSON.stringify(path)` usages in hot paths with
        `keyPath()`.

- [x] Types consolidation (follow-up)
  - [x] Use `src/types.ts` as the canonical source for public `TxRequest`,
        `TxReceipt`, `TxDocResult`, `BranchRef`, etc. (re-exported via
        `src/interface.ts`).
  - [x] Refactor `src/store/tx.ts` to eliminate duplicate public types; use a
        small internal `ReadEntry`/`WriteEntry` for the SQLite pipeline and map
        to/from public types in `src/provider.ts`.
  - [x] Ensure WS protocol references the public transaction types.

- [x] Migrations/schema unification (follow-up)
  - [x] Remove/replace empty or duplicated migration files under
        `src/store/migrations/`.
  - [x] Keep a single authoritative DDL in `src/store/schema.sql` (already used
        by `db.ts`).

- [x] Flags/config centralization (follow-up)
  - [x] Ensure feature flags are read exclusively via `src/config.ts` and make
        `src/store/flags.ts` delegate there.
  - [x] Consider unifying per-space overrides under a documented settings row.

- Acceptance criteria:

- [x] No remaining ad-hoc base64 helpers in runtime code; WS server and UCAN
      import from `codec/bytes.ts`.
- [x] New `keyPath()` used where paths are stringified in runtime code.
- [x] Tests and `deno task check` pass.
- [x] Follow-up items tracked for types/migrations/flags.

### Client Library (WS v2)

Goals: Provide a TypeScript client for the storage backend that manages WS v2
connections per space with epoch-based resume, maintains a client-side Automerge
store (server-confirmed head + pending local txs), exposes `get`, `subscribe`,
and a transactional API (`read`, `write`, `commit`, `abort`, `log`), and emits
scheduler callbacks on effective composed-view changes.

Spec: `docs/specs/storage/20-client-library.md`.

Implementation plan (phased):

- [x] Client core scaffolding
  - [x] Create `packages/storage/src/client/` with modules:
    - `connection.ts`: per-space socket manager (hello/resume, acks, queue)
    - `store.ts`: per-space/doc server head + pending chain + composed view
    - `scheduler.ts`: change notifications
      `{ space, docId, path, before, after }`
    - `tx.ts`: transaction object (read/write/log/commit/abort, single-space
      writes)
    - `index.ts`: public API (StorageClient, Transaction)
  - [x] Types: reuse `src/ws/protocol.ts`; add narrow client types

- [x] Wire protocol integration
  - [x] Connect to `/api/storage/new/v2/:space/ws` (optional Authorization)
  - [x] Send `/storage/hello { clientId, sinceEpoch }` on connect/reconnect
  - [x] Implement `/storage/get` and `/storage/subscribe` with completion
        pairing
  - [x] Handle `Deliver { snapshot|delta }` and `Ack { epoch }`
  - [x] `subscribe(...)` returns a Promise that resolves after initial
        `complete`

- [ ] Client-side document store
  - [x] Track per-doc `server` state: `{ epoch, heads, baseBytes/baseDoc }`
  - [x] Maintain `pending` local changes per doc and recompute `composed`
  - [ ] Incremental recomposition (apply staged changes; avoid full rebuilds)
  - [x] Map tx receipts (`newHeads`) to pending entries and prune on success
  - [x] Associate a local pending-head marker with each tx's writes for reads

- [ ] Transaction engine
  - [x] `read(space, docId, path, nolog=false, validPathOut?)` returns composed
        view; fills `validPathOut` with longest valid prefix; `undefined` for
        invalid subpath
  - [x] `write(space, docId, path, mutate, validPathOut?)` returns boolean; on
        first write bind tx to a single space; stage Automerge change at `path`
  - [x] `commit()`:
    - [x] If no writes: resolve ok; do not contact server (no tx id)
    - [x] If only writes: set `allowServerMerge = true`
    - [x] Build WSTxRequest with `baseHeads` from server head; send
          `/storage/tx`
    - [x] On `ok`: advance server head/epoch, prune pending for this tx
    - [x] On `conflict|rejected`: rollback pending for this tx and cascade
  - [x] `abort()` removes staged writes and invalidates the tx
  - [x] Read-set tracking and invalidation (conservative doc-level policy)
  - [x] Dependency tracking and cascade rejection when depended-upon tx rejects
  - [x] New doc genesis: use `createGenesisDoc`/`computeGenesisHead` for first
        write baseHeads

- [ ] Scheduler notifications
  - [x] Register callbacks and emit `{ space, docId, path, before, after }`
  - [x] Start coarse (root-only) then refine to changed subpaths
  - [x] Expose `synced()` that resolves when all in-flight commits and initial
        subscriptions (at call time) have settled

- [ ] Testing
  - [ ] Unit tests (in `packages/storage/test/client/*`):
    - [ ] Store composition: server head + pending chain → composed view;
          incremental recomposition
    - [x] Path navigation: `read()`/`readView()` with `validPathOut`;
          `undefined` on invalid subpaths
    - [ ] Transaction read/write logging: entries include
          `{ space, docId, path, op }`
    - [ ] Single-space write enforcement: cross-space writes in one tx throw
    - [ ] Read-set invalidation: external doc change rejects tx conservatively
          (doc-level)
    - [ ] Cascade rejection: tx depending on pending writes rejects when
          dependency rejects
    - [ ] Write-only tx: sets `allowServerMerge = true`
    - [ ] New doc genesis: first write uses
          `createGenesisDoc`/`computeGenesisHead` heads
    - [ ] Scheduler events: before/after JSON for changed paths (coarse root
          acceptable)
    - [ ] `synced()` resolution: resolves when all pending commits and initial
          subs (at call time) settle
    - [x] Unsubscribe: after unsubscribe, no further scheduler events for that
          subscription
  - [x] Integration tests (spin up `packages/storage/deno.ts`):
    - [x] Subscribe promise resolves after initial `complete`; subsequent
          `readView` reflects delivered state
    - [x] Get-only completes with no follow-up delivers; later txs must not
          deliver to that consumer
    - [x] Resume exact vs stale (hello sinceEpoch): exact → no backfill; stale →
          backfill (snapshot or delta)
    - [x] Deliver/ack per epoch; ack recorded and used for resume
    - [x] Tx happy path: commit ok; receipts mapped; pending pruned; composed
          view stable
    - [x] Tx conflict/rejected: rollback pending; cascade to dependents;
          composed view reverts
    - [x] New doc creation path: first write based on genesis heads; server
          accepts and subsequent reads match
    - [x] `synced()` end-to-end: with multiple concurrent txs and subs, resolves
          only after all have settled

- [ ] Developer experience
  - [ ] README usage examples; strict TS; no `any`

Acceptance:

- [x] Client passes unit and integration tests under `deno task test`
- [x] `deno task integration` (in `packages/storage`) passes
- [x] Works against dev server; scheduler callbacks match spec

### Runner integration (flagged)

- [ ] Goal: enable runner to use new storage when `ENABLE_NEW_STORAGE` is set;
      otherwise keep current memory-backed behavior.

- [ ] Address mapping (runner ↔ new storage)
  - [ ] Map `MemorySpace` → space DID (pass-through if already a DID)
  - [ ] Map runner `URI` → `docId` deterministically (e.g., `doc:<b64url(uri)>`)
  - [ ] Keep JSON path tokens as-is
  - [ ] Use branch `"main"` by default

- [ ] Create adapter scaffolding (runner)
  - [ ] `packages/runner/src/storage-new/address.ts`
  - [x] `packages/runner/src/storage-new/manager.ts`
  - [x] `packages/runner/src/storage-new/transaction.ts`
  - [x] `packages/runner/src/storage-new/provider.ts`
  - [x] `packages/runner/src/storage-new/cache.ts`

- [x] Implement `IStorageManager` (adapter over `StorageClient`)
  - [x] Lazily manage per-space connections (scaffolded cache)
  - [x] `edit()` returns adapter transaction (delegated temporarily)
  - [x] `synced()` awaits in-flight work (delegated temporarily)
  - [ ] Bridge subscription events to runner notifications

- [ ] Implement `IStorageTransaction` (adapter)
  - [ ] Maintain runner journal (reads/writes)
  - [ ] `read()` from composed view; record invariants
  - [ ] `write()` stages per-path changes; no network
  - [ ] `commit()` batches by `(space, docId)` into one client tx; submit
  - [ ] Map receipts to commit/revert notifications; handle conflicts/rollback
  - [ ] `abort()` drops staged writes and finalizes status

- [ ] Implement minimal `IStorageProviderWithReplica` (per-space)
  - [ ] `replica.did()` returns space DID
  - [ ] `replica.get(entry)` returns current `{ the, of, is }` via adapter cache
  - [ ] `sync(uri, selector)`, `synced()`, `destroy()` lifecycle
  - [x] Do not implement `IStorageProvider.send`, `.sink`, or `.get` (unused)

- [x] Feature flag and factory
  - [x] `packages/runner/src/storage/factory.ts` selects manager by
        `ENABLE_NEW_STORAGE ∈ {"1","true","on"}`
  - [ ] Configure client `baseUrl` from `API_URL`; respect `LOG_LEVEL`

- [x] Shell wiring
  - [x] Use storage-factory when constructing the runtime

- [x] CLI wiring
  - [x] Use storage-factory in CLI commands; prefer `--url`/`API_URL` for
        `baseUrl`

- [ ] Eventing and telemetry
  - [ ] Bridge client events to runner subscription capability
  - [ ] Mirror connection/push/pull/subscription state to `RuntimeTelemetry`

- [ ] Testing
  - [ ] Unit: address mapping and transaction batching
  - [ ] Integration: run existing runner tests with `ENABLE_NEW_STORAGE=1`
  - [ ] Reconnection parity (subscribe/get/ack) with storage client
