# New Storage Backend Implementation Plan

This document tracks the implementation of the new storage backend described in
`docs/specs/storage/*`.

## Goals

- Implement Automerge-backed `doc:` storage first (documents, branches, heads),
  then layer content-addressed primitives where needed.
- Provide query, subscription, and snapshot capabilities.
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
- Toolshed routes behind an `ENABLE_NEW_STORAGE=1` flag initially.
- API surface documented and aligned to `docs/specs/storage/03-api.md`.

## Implementation map (spec → modules)

- SQLite provider: `packages/storage/src/sqlite/*` implements `SpaceStorage`
  over per-space DB files with PRAGMAs (§02).
- Change decoding and heads: `change.ts`, `heads.ts` use `@automerge/automerge`
  to parse headers and update heads (§01, §02, §04).
- PIT & projection: `pit.ts`, `projection.ts` implement snapshot+chunk fast-path
  and fallback (§05, §07).
- Transactions & crypto chain: `tx.ts`, `tx_chain.ts` implement pipeline,
  digests, and signatures (§04).
- CAS primitives: `cas.ts` over `am_change_blobs` and friends (§02, §06).
- Branching/merge: `branches.ts` for creation/closure/merge semantics (§06).
- Snapshots: `snapshots.ts` with cadence policies and pruning (§07).
- Queries/subscriptions: `query_ir.ts`, `query_eval.ts`, `query_ws.ts` and SQL
  tables in §11 (§08–§12).
- UCAN: `ucan.ts` to validate cap and nb digests (§13).
- Toolshed routes: `packages/toolshed/routes/storage/new/*` for HTTP and WS
  (§03, §08).

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

- `packages/storage/src/sqlite/pit.ts` implements PIT reconstruction with both fast path and fallback
- `packages/storage/src/sqlite/projection.ts` implements JSON projection for selective subtrees  
- Updated `packages/storage/interface.ts` to include `at?: string` for timestamp-based PIT
- Updated `packages/storage/src/provider.ts` to integrate PIT and projection functionality
- Comprehensive test coverage in `packages/storage/test/pit-and-projection-test.ts`

### 3. Branching and merge semantics

- [x] Create/close branches; lineage metadata.
- [x] Client-driven merge: accept merge change with deps = heads to collapse
      branches; validate sources.
- [x] Optional server merge (flagged) using `Automerge.merge` to synthesize
- [x] Close branch post-merge; set `merged_into_branch_id`.
- [ ] Close branch post-merge; set `merged_into_branch_id`.

Acceptance:

- Tests: fork → concurrent edits → client-merge collapses heads; optional
  server-merge path works under flag.

Implementation:

- Added `packages/storage/src/sqlite/branches.ts` with `createBranch()` and `closeBranch()` built on existing heads/doc helpers; records `parent_branch_id` and `merged_into_branch_id`.
- Added `packages/storage/test/branches-basic-test.ts` covering creating a new branch and ensuring reads work after closing.

### 4. Snapshots (SQLite-backed)

- [x] Implement snapshot cadence and storage in `am_snapshots` / `am_chunks`.
  - [x] Full snapshots via `Automerge.save()`.
  - [x] Optional incremental chunks to accelerate PIT.
- [x] Integrity: maintain `root_ref = referJSON({ heads: sorted(heads) })` in
      `am_heads` for verification.

Acceptance:

- Snapshot/restore tests; integrity check matches stored `root_ref`.

Implementation:

- Added `packages/storage/src/sqlite/snapshots.ts` with `maybeCreateSnapshot()` using a basic cadence (default 5 changes) and storing full snapshots with upto_seq_no.
- Wired snapshot creation into submitTx() after heads update.
- Added `packages/storage/test/snapshots-basic-test.ts` ensuring cadence triggers and PIT returns the latest state.

### 5. Transactions (multi-doc) and invariants

- [ ] Tx request format and types wired through provider.
- [ ] Server pipeline:
  - [ ] Validate read-set heads.
  - [ ] Validate baseHeads vs current heads (unless merge path).
  - [ ] Validate each change: deps, actor/seq, duplicate hash.
  - [ ] Update heads and append sequence rows atomically.
  - [ ] Compute digests (`merkle-reference`) for UCAN `nb`.
  - [ ] Run invariants with `loadDocAt` and `project`, fail-closed.
- [ ] Receipts: new heads, counts, conflicts, crypto envelope fields stubbed
      until §4 completes.

Acceptance:

- Tests: valid tx, concurrent write conflict, idempotent replays.

### 6. Content-addressed primitives (SQLite CAS)

- [ ] CAS interface over SQLite tables:
  - [ ] `put(bytes) -> ref`, `get(ref) -> bytes`, `has(ref)` using
        `merkle-reference` and `am_change_blobs`.
  - [ ] Record kinds: `am_change`, `am_snapshot`, optional `blob`.
- [ ] Indexes: by `(docId, branchId, seqNo)` and `(docId, branchId, txId)`.

Acceptance:

- Unit tests for CAS and indexes.

### 7. Queries and subscriptions

- [ ] Query IR compiler and evaluator with provenance/touch set tracking.
- [ ] Link traversal semantics and depth budgeting.
- [ ] Subscription tables from §11 and WS server handling; at-least-once with
      acks.

Acceptance:

- Query tests: filters, sorts, limits, joins/reference traversals.
- Subscription tests: multiple consumers, ordering, no duplication.

### 8. UCAN / Access control (MVP)

- [ ] Minimal UCAN validation and capability checks.
- [ ] Enforce space-level caps on tx and read endpoints.

Acceptance:

- Authorized vs unauthorized attempts covered by tests.

### 9. Toolshed integration (flagged)

- [ ] Add routes under `packages/toolshed/routes/storage/new/` for docs/branches
      heads, tx, PIT read, query, subscribe, snapshots; use `doc:<ref>` and
      `root_ref` in responses.
- [ ] Gate on `ENABLE_NEW_STORAGE`.

Acceptance:

- Route tests passing; feature flag works.

### 10. Tooling (no migration needed)

- [ ] CLI for exporting/importing snapshots and listing spaces/branches.

Acceptance:

- Docs updated; happy-path flows verified in tests.

## Module layout (proposed)

```text
packages/storage/src/
  sqlite/
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
    query_ir.ts     // IR node types + compiler
    query_eval.ts   // evaluator + provenance
    query_ws.ts     // WS protocol handlers
    ucan.ts         // UCAN validation and nb checks
  provider.ts       // factory that returns SpaceStorage backed by SQLite
  // no in-memory engine
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
  - packages/storage/src/sqlite/db.ts — SQLite open/PRAGMAs/migrations
  - packages/storage/src/sqlite/heads.ts — heads state, root_ref, branch/doc init
  - packages/storage/src/sqlite/change.ts — decode Automerge change headers
  - packages/storage/src/sqlite/pit.ts — PIT reconstruction (epochForTimestamp, uptoSeqNo, getAutomergeBytesAtSeq)
  - packages/storage/src/sqlite/snapshots.ts — snapshot cadence (DEFAULT_CADENCE=5), writes am_snapshots
  - packages/storage/src/sqlite/branches.ts — create/close branches with lineage
  - packages/storage/src/sqlite/projection.ts — JSON projection for selective paths
  - packages/storage/src/provider.ts — SpaceStorage implementation and submitTx
- CAS tables/primitives already referenced:
  - am_change_blobs (bytes dedup) and am_change_index (per-branch index) used in submitTx and PIT fallback.
  - Follow-up: factor a sqlite/cas.ts wrapper if we expand beyond change blobs (snapshots, generic blobs).
- Provider submitTx implementation:
  - packages/storage/src/provider.ts: submitTx performs dep checks, per-actor seq monotonicity, CAS insert into am_change_blobs, index in am_change_index, updates am_heads (including root_ref via merkle-reference/json), and triggers maybeCreateSnapshot().
- PIT, snapshots, and projection (spec alignment):
  - Spec refs: docs/specs/storage/05-point-in-time.md (§05) and 07-snapshots.md (§07).
  - Implementation: sqlite/pit.ts and sqlite/snapshots.ts match the described fast-path and fallback; projection helper exists.
- Merge semantics / branching:
  - Spec ref: docs/specs/storage/06-branching.md (§06).
  - Implementation: sqlite/branches.ts; client-driven merges validated by submitTx logic (deps ⊆ heads); optional server-merge remains TODO/flagged.
- Query spec references for later phases:
  - docs/specs/storage/09-query-ir.md, 10-query-evaluation.md, 11-query-schema.md, 12-query-types.md (IR, evaluation algorithm, schema, types).
  - No runtime modules checked in yet; to be implemented under sqlite/query_*.ts per plan.
- Invariants:
  - Spec ref: docs/specs/storage/14-invariants.md (§04 numbering in plan); provider submitTx currently lacks invariant hooks; to add during Tx pipeline work.
- Toolshed route scaffolding and feature flags:
  - packages/toolshed/routes/storage/new/* present (new.index.ts, new.routes.ts, new.handlers.ts) — currently wired to a Map-backed SpaceStorage placeholder and throws until SQLite provider is injected.
  - Feature flag not yet plumbed; propose ENABLE_NEW_STORAGE in packages/toolshed/env.ts and conditional router mounting in packages/toolshed/index.ts/create-app.
- Baseline execution (on this branch):
  - deno task check: PASSED.
  - deno test --allow-env --allow-ffi --allow-read --allow-write: FAILED early due to an import map issue in a mirrored .conductor/kolkata path (Relative import not in import map). Storage package tests themselves compile; full workspace run requires fixing or excluding those mirrored paths.

Action items for phase 2:
- Add ENABLE_NEW_STORAGE env flag and gate Toolshed new storage routes.
- Provide a SpaceStorage factory that opens per-space SQLite (openSpaceStorage) and inject into Toolshed handlers.
- Add invariant hook points within submitTx pipeline and basic invariant examples.
- Consider sqlite/cas.ts wrapper for CAS beyond change blobs.
- Resolve deno test import-map issue or restrict default test set to avoid mirrored .conductor paths.
