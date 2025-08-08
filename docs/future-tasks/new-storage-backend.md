# New Storage Backend Implementation Plan

This document tracks the implementation of the new storage backend described in
`docs/specs/storage/*`.

## Goals

- Implement a content-addressed, append-only storage backend with spaces and
  transactions, backed by Automerge.
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

## Detailed Task List

### 0. Package skeleton (done)
- [x] Create `packages/storage` package with basic exports and placeholder
      provider factory.
- [x] Add this plan document.
- [x] Register package in root `deno.json` workspace.

### 1. Domain model types and public interfaces
- [ ] Define fundamental ids and hashes:
  - [ ] `SpaceId` (DID), `BranchId`, `CommitId`, `ChangeId`, `SnapshotId`.
  - [ ] Multihash support (prefer blake3 per specs); typed hash wrappers.
  - [ ] Monotonic `Seq` types for per-branch change sequence.
- [ ] Structural types per specs:
  - [ ] `Fact`, `Reference`, `EntityId`, `SchemaRef`.
  - [ ] `Change` (insert/update/delete/merge), `ChangeSet`.
  - [ ] `Commit` (parents, branch, author, tx metadata, baseHeads, mergeOf).
  - [ ] `SnapshotManifest` and `SnapshotChunk`.
- [ ] Error taxonomy (`15-errors.md`):
  - [ ] `ValidationError`, `InvariantError`, `NotFoundError`, `ConflictError`,
        `UnauthorizedError` with codes/messages.
- [ ] Provider interfaces:
  - [ ] `ContentAddressableStore` (put/get/has, streaming, bytes in/out).
  - [ ] `IndexStore` (by-entity, by-attribute, by-branch indices).
  - [ ] `CommitLog` (append-only, parents, ancestry, heads).
  - [ ] `SpaceCatalog` (create/list/get/delete spaces and branches).
  - [ ] `SubscriptionHub` (publish/subscribe, cursor delivery).
- [ ] Public API types (`03-api.md`, `17-client-types.md`):
  - [ ] Request/response types for tx submit, query, subscribe, snapshot.
  - [ ] Include `baseHeads`, `mergeOf`, `conflicts` structures.

Acceptance:
- Types compile, documented with JSDoc, exported via `@commontools/storage`.
- Unit tests validate basic guards and type invariants.

### 2. Minimal storage engine scaffolding (in-memory)
- [ ] Implement in-memory CAS with multihash (blake3) and byte deduplication.
- [ ] Implement simple index structures (Maps) for entity/attribute lookups.
- [ ] Implement minimal commit log (append-only array per branch) with ancestry
      and head tracking.
- [ ] Implement space and branch catalog in-memory.
- [ ] Provide a concrete `createStorageProvider()` returning in-memory impl.

Acceptance:
- Unit tests cover put/get/has for CAS and indices.
- Commit log ancestry queries return correct lineage and heads.

### 2a. Automerge core mechanics
- [ ] Add `@automerge/automerge` dependency for server-side operations.
- [ ] Define CAS record kinds:
  - [ ] `am_change` (single Automerge change bytes + metadata + hash).
  - [ ] `am_snapshot` (full Automerge save bytes + seq/base + hash).
- [ ] Branch head tracking:
  - [ ] Maintain `heads: ChangeId[]` per branch (DAG).
  - [ ] `baseHeads` validation: incoming tx must match current heads unless
        a merge tx.
- [ ] PIT reconstruction (`05-point-in-time.md`):
  - [ ] Load latest snapshot ≤ target seq, then apply subsequent changes by
        `Automerge.applyChanges()` until target seq.
  - [ ] `Accept: application/automerge` returns raw bytes; default returns JSON
        by loading via `Automerge.load()` and optional path projection.
- [ ] JSON projection:
  - [ ] Implement `project(doc, paths)` helper (`14-invariants.md`), using
        Automerge APIs to select subtrees.
- [ ] Snapshotting (`07-snapshots.md`):
  - [ ] Use `Automerge.save()` to produce full snapshot bytes.
  - [ ] Store snapshot in CAS as `am_snapshot` with manifest.

Acceptance:
- Tests verify PIT bytes equality with client-generated docs.
- Encoding/decoding round-trips for change and snapshot records.

### 3. Transaction processing and invariants
- [ ] Validate and apply tx per `04-tx-processing.md`:
  - [ ] Decode schema refs and entity ids; validate against schema.
  - [ ] `baseHeads` check; reject non-merge concurrent writes.
  - [ ] If merge tx: verify all `mergeOf.heads` exist; allow multiple sources.
  - [ ] Compute content addresses (blake3 multihash) for each change/snapshot.
  - [ ] Deterministic ordering of changes; produce commit and update heads.
- [ ] Idempotency: re-applying same change sets is a no-op.
- [ ] Receipts include commit id, new heads, conflicts summary, errors if any.

Acceptance:
- Tests: valid tx, invalid schema, concurrent write conflict, idempotent replay.

### 4. Merging semantics
- [ ] Preferred path: client supplies merge changes (`mergeOf`) inside a normal
      tx (`06-branching.md`).
- [ ] Server fallback (flagged): optional server-side 3-way merge using
      `Automerge.merge` to synthesize change(s) if client did not supply; only
      behind `ENABLE_SERVER_MERGE`.
- [ ] After merge:
  - [ ] Update target branch heads.
  - [ ] Optionally mark source branches as merged (`merged_into_branch_id`).
  - [ ] Support branch close endpoint (`/branches/:branchId/close`).
- [ ] Conflict representation:
  - [ ] Surface conflicts array per `03-api.md` when merging divergent values.

Acceptance:
- Tests: concurrent edits on same key resolve; conflicting values reported.
- Branch close sets metadata and heads correctly.

### 5. Point-in-time reads and branching
- [ ] Read views by commit id or branch head (`05-point-in-time.md`).
- [ ] Create/delete branches; track lineage (`06-branching.md`).
- [ ] Simple policy for merges (no auto-resolve beyond Automerge behavior).

Acceptance:
- Tests: historical reads stable; branch lineage traversal correct.

### 6. Snapshots
- [ ] Snapshot creation, retention, and restore mechanics (`07-snapshots.md`).
- [ ] Manifest CAS encoding and integrity verification.
- [ ] Hooks for future compaction (no-op in MVP).

Acceptance:
- Tests: create snapshot, mutate, restore, verify state equality.

### 7. Query IR and evaluation
- [ ] Define Query IR types (`09-10-11-12` specs) with validators.
- [ ] Evaluate queries over projected JSON at PIT.
- [ ] Optimization stubs (predicate pushdown, index selection).

Acceptance:
- Query tests: filters, sorts, limits, joins/reference traversals.

### 8. Subscriptions
- [ ] Durable subscriptions (`08-subscriptions.md`).
- [ ] Cursor encoding and backfill from last seen commit.
- [ ] Delivery formats:
  - [ ] SSE JSON events (projected changes and metadata).
  - [ ] Optional binary stream of Automerge change bytes if requested.

Acceptance:
- Tests: multiple consumers with cursors; no duplication; ordered delivery.

### 9. UCAN / Access control (MVP)
- [ ] Minimal UCAN validation (`13-ucan.md`).
- [ ] Space-level capability checks for tx and read.
- [ ] Pluggable auth provider interface.

Acceptance:
- Tests: authorized vs unauthorized tx/read attempts.

### 10. Toolshed integration (flagged)
- [ ] Add new `packages/toolshed/routes/storage/new/` with routes:
  - [ ] POST /v1/:space/spaces
  - [ ] GET /v1/:space/spaces/:id
  - [ ] POST /v1/:space/branches/:branchId/tx
  - [ ] GET /v1/:space/branches/:branchId/head
  - [ ] GET /v1/:space/branches/:branchId/read?accept=application/automerge
  - [ ] GET /v1/:space/query
  - [ ] GET /v1/:space/subscribe (SSE)
  - [ ] POST /v1/:space/snapshots
  - [ ] GET /v1/:space/snapshots/:snapshotId
  - [ ] POST /v1/:space/branches/:branchId/close
- [ ] Wire provider instance gated by `ENABLE_NEW_STORAGE` env.
- [ ] OpenAPI descriptions and response schemas.

Acceptance:
- Route tests pass and feature can be toggled off/on.

### 11. Migration & Tooling
- [ ] CLI for snapshot export/import and space/branch listing.
- [ ] Import existing Automerge files as `am_snapshot` (seq 0) or chunked.
- [ ] Migration helpers per `18-migration.md`.
- [ ] Docs and examples.

Acceptance:
- Docs updated; happy-path flows verified in tests.

## Open Questions

- Confirm hash algorithm (blake3) and multihash details across all tables.
- Snapshot frequency and retention policy defaults.
- Query index design trade-offs for early versions.
- Scope and format of binary subscription stream for changes.
