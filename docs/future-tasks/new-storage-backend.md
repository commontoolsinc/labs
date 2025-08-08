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

- [ ] Dependencies: add `npm:@automerge/automerge`
- [ ] DB lifecycle: per-space DB file management, PRAGMAs, and connection pool
      (single writer).
- [ ] Migrations: implement `02-schema.md` tables and indexes; idempotent
      startup.
- [ ] Heads path:
  - [ ] Decode Automerge change bytes → `change_hash`, `deps`, `actor_id`,
        `seq`.
  - [ ] Verify deps subset of current heads; update heads
        `(heads − deps) ∪ {hash}`.
  - [ ] Reject if any `dep` missing for `(doc, branch)`.
  - [ ] Enforce `actor_id`/`seq` monotonicity per actor in branch history.
  - [ ] CAS: store change bytes (dedup) in `am_change_blobs`; index rows in
        `am_change_index`.
  - [ ] Maintain `am_heads(seq_no, tx_id, heads_json, root_hash)`.

Acceptance:

- Unit tests cover head updates (linear change, fork, merge), dep missing, and
  actor/seq monotonicity.

### 2. Point-in-time (PIT) and projection

- [ ] Compute `upto_seq_no` for epoch/tx via `am_change_index`.
- [ ] PIT reconstruction:
  - [ ] Fast path from `am_snapshots` + `am_chunks` → concatenated AM binary.
  - [ ] Fallback from snapshot + apply changes via `Automerge.applyChanges()`.
- [ ] Projection helper `project(docBytes, paths[])` for selective subtrees.

Acceptance:

- PIT byte equality with a client-generated doc at the same point.
- Projection tests for path subsets and root.

### 3. Branching and merge semantics

- [ ] Create/delete branches; lineage metadata.
- [ ] Client-driven merge: accept merge change with deps = heads to collapse
      branches; validate sources.
- [ ] Optional server merge (flagged) using `Automerge.merge` to synthesize
      changes.
- [ ] Close branch post-merge; set `merged_into_branch_id`.

Acceptance:

- Tests: fork → concurrent edits → client-merge collapses heads; optional
  server-merge path works under flag.

### 4. Snapshots (SQLite-backed)

- [ ] Implement snapshot cadence and storage in `am_snapshots` / `am_chunks`.
  - [ ] Full snapshots via `Automerge.save()`.
  - [ ] Optional incremental chunks to accelerate PIT.
- [ ] Integrity: maintain `root_ref = referJSON({ heads: sorted(heads) })` in
      `am_heads` for verification.

Acceptance:

- Snapshot/restore tests; integrity check matches stored `root_ref`.

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
- use `node:sqlite` for sqlite
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
