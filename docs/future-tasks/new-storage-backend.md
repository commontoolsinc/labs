# New Storage Backend Implementation Plan

This document tracks the implementation of the new storage backend described in
`docs/specs/storage/*`.

## Goals

- Implement Automerge-backed `doc:` storage first (documents, branches, heads),
  then layer content-addressed primitives where needed.
- Provide query, subscription, and snapshot capabilities.
- Integrate with Toolshed to expose HTTP endpoints for the storage API.

## Non-goals (for initial cut)

- Multi-region replication.
- Advanced query optimizations.
- Full UCAN integration beyond basic token validation.

## Milestones & Acceptance Criteria

- Each task group lands with unit tests and `deno task check` passing.
- Toolshed routes behind an `ENABLE_NEW_STORAGE=1` flag initially.
- API surface documented and aligned to `docs/specs/storage/03-api.md`.

## Detailed Task List (Automerge-first)

### 0. Package skeleton (done)
- [x] Create `packages/storage` package with basic exports and placeholder
      provider factory.
- [x] Add this plan document.
- [x] Register package in root `deno.json` workspace.

### 1. Automerge document core (heads-first)
- [ ] Add `@automerge/automerge` dependency.
- [ ] Define core Automerge types:
  - [ ] `DocId = string` (string form `doc:<ref>`), `BranchId`, `ChangeId`.
  - [ ] `Head = ChangeId` (Automerge change hash string).
  - [ ] `Heads = Head[]` (set semantics; store sorted canonical for digests).
  - [ ] `ActorId`, `Seq` (per-actor sequence), `Deps: ChangeId[]`.
- [ ] Heads management per branch:
  - [ ] Ingest submitted change bytes; decode header to get `hash`, `deps`.
  - [ ] Verify each change `deps ⊆ currentHeads` for non-merge; for merges, allow
        `deps` to reference multiple heads.
  - [ ] Update heads = `(currentHeads − deps) ∪ {hash}`.
  - [ ] Reject if any `dep` not found for the `(doc, branch)`.
- [ ] Validation of actor/seq monotonicity per actor across branch history.
- [ ] Store change bytes once; maintain per-branch sequence index for PIT.

Acceptance:
- Unit tests cover head updates (linear change, fork, merge), dep missing, and
  actor/seq monotonicity.

### 2. Point-in-time (PIT) and projection
- [ ] Compute `upto_seq_no` for a given epoch/tx.
- [ ] PIT reconstruction:
  - [ ] Fast path: snapshot + incremental change chunk bytes → concatenate;
        serve `application/automerge` bytes directly.
  - [ ] Fallback: `Automerge.load()` latest snapshot then `applyChanges()`
        through target seq.
- [ ] JSON projection helper: `project(docBytes, paths[])` loads once and returns
      selected subtrees; used for JSON responses.

Acceptance:
- PIT byte equality with a client-generated doc at the same point.
- Projection tests for path subsets and root.

### 3. Branching and merge semantics
- [ ] Create/delete branches; lineage metadata.
- [ ] Preferred merge: client supplies a merge change with deps = heads to
      collapse branches; server verifies deps exist.
- [ ] Optional server-side merge (flagged): `Automerge.merge` to synthesize a
      merge change when client did not; behind `ENABLE_SERVER_MERGE`.
- [ ] After merge, heads collapse to the new change hash; branch close endpoint
      updates metadata.

Acceptance:
- Tests: fork → concurrent edits → client-merge collapses heads; optional
  server-merge path works under flag.

### 4. Snapshots
- [ ] Implement snapshot cadence and storage:
  - [ ] Full snapshots via `Automerge.save()` into CAS as `am_snapshot`.
  - [ ] Optional incremental chunks to accelerate PIT.
- [ ] Integrity: maintain `root_ref = referJSON({ heads: sorted(heads) })` in
      heads table for verification.

Acceptance:
- Snapshot/restore tests; integrity check matches stored `root_ref`.

### 5. Transactions (multi-doc) and invariants
- [ ] Tx request format: reads (doc/branch/heads), writes (doc/branch/baseHeads,
      change bytes, optional mergeOf), invariants, options.
- [ ] Server pipeline:
  - [ ] Validate read-set heads.
  - [ ] Validate baseHeads match current (unless merge path).
  - [ ] Validate each change: deps, actor/seq, no duplicate change hash.
  - [ ] Update per-branch heads and append per-branch sequence rows.
  - [ ] Compute digests with `merkle-reference` for UCAN nb fields where used.
  - [ ] Run invariants (materialize/projection as needed), fail-closed.
- [ ] Receipts: new heads, counts, optional conflicts summary.

Acceptance:
- Tests: valid tx, concurrent write conflict, idempotent replays.

### 6. Content-addressed primitives (secondary)
- [ ] CAS interface and in-memory impl:
  - [ ] `put(bytes) -> ref`, `get(ref) -> bytes`, `has(ref)` using
        `merkle-reference`.
  - [ ] Record kinds: `am_change`, `am_snapshot`, optional `blob`.
- [ ] Indexes: by `(docId, branchId, seqNo)`, by `(docId, branchId, txId)`.

Acceptance:
- Unit tests for CAS and indexes.

### 7. Queries and subscriptions
- [ ] Query IR types and evaluation over PIT-projected JSON.
- [ ] Provenance/touch set tracking; link traversal rules per spec.
- [ ] Subscriptions with cursors and SSE (JSON by default; optional binary
      change stream later).

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

### 10. Migration & Tooling
- [ ] Import existing Automerge files as `am_snapshot` (seq 0) or chunked.
- [ ] CLI for exporting/importing snapshots and listing spaces/branches.

Acceptance:
- Docs updated; happy-path flows verified in tests.

## Open Questions

- Snapshot cadence/retention defaults.
- Server-side merge scope; when to synthesize merge changes.
- Binary subscription stream format and ergonomics.
