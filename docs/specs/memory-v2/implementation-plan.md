# Memory v2 Implementation Plan

## Summary
- [ ] Write this plan into [implementation-plan.md](/Users/berni/src/labs.exp-memory-impl-4/docs/specs/memory-v2/implementation-plan.md).
- [ ] Treat the phase-1 cutover as: a `Runtime` configured with `memoryVersion: "v2"` uses v2 implementations for `IStorageProvider` and `IExtendedStorageTransaction`, while runner and scheduler call sites remain unchanged.
- [ ] Execute the rollout with red/green TDD: every new server, provider, transaction, and integration behavior starts with a failing test and is only then implemented.
- [ ] Keep v1 and v2 running in parallel during migration, but keep storage physically separate: v2 must not read or write v1 SQLite files. Use a dedicated v2 DB layout such as `<MEMORY_DIR>/v2/<space>.sqlite` and a separate emulation backend.
- [ ] Add v2 code inside the existing packages rather than creating a new workspace package: shared/server code under [packages/memory](/Users/berni/src/labs.exp-memory-impl-4/packages/memory), client wiring under [packages/runner/src/storage](/Users/berni/src/labs.exp-memory-impl-4/packages/runner/src/storage), and route/transport dispatch under [packages/toolshed/routes/storage/memory](/Users/berni/src/labs.exp-memory-impl-4/packages/toolshed/routes/storage/memory).

## Public Interfaces and Cutover Boundary
- [ ] Add `memoryVersion?: "v1" | "v2"` to `RuntimeOptions` in [runtime.ts](/Users/berni/src/labs.exp-memory-impl-4/packages/runner/src/runtime.ts), default it to `"v1"`, and thread the resolved value into storage-manager construction and emulation.
- [ ] Keep `IStorageManager`, `IStorageProvider`, `IExtendedStorageTransaction`, `StorageValue`, `syncCell()`, and `subscribe()` stable at the runtime boundary for phase 1.
- [ ] Introduce `IStorageNotification` / `StorageNotificationRelay` as the canonical internal names for scheduler notifications, and export temporary aliases for `IStorageSubscription` / `StorageSubscription` until v1 is removed.
- [ ] Keep compatibility-only fields such as classification and labels accepted at the cutover boundary, but treat them as ignored inputs on the v2 path and stop creating label side-writes in v2.
- [ ] Add explicit v1 guard assertions at the v1 provider, transaction, consumer, and server dispatch entry points so a runtime configured for v2 fails immediately if any v1 code path is reached.

## Phase 1: Core v2 Stack Required Before Cutover
- [ ] Define v2 shared types and codecs around `EntityDocument`, `Operation`, `ClientCommit`, `ConfirmedRead`, `PendingRead`, `PatchOp`, `SessionOpen`, `Receipt`, and `merkle-reference/json`; keep entity storage untyped and re-root selector paths to `["value", ...path]`.
- [ ] Bootstrap the v2 per-space SQLite schema with `value`, `fact`, `head`, `commit`, `invocation`, `authorization`, `snapshot`, `branch`, and minimal blob tables, plus the required pragmas, prepared statements, and default-branch bootstrap.
- [ ] Implement the v2 read engine: head lookup, point-in-time reconstruction by `seq`, patch replay, snapshot creation/lookup, `source` link traversal, and schema-driven graph queries using the shared `traverse.ts` code path.
- [ ] Implement the v2 commit engine: server-side parent resolution, global `seq` assignment, overlapping-path validation from confirmed reads, pending-read resolution from `(sessionId, localSeq)`, and atomic fact/head/commit writes with separate persistence of the UCAN invocation and authorization records.
- [ ] Implement the phase-1 logical session model: the first WebSocket message negotiates `memory/v2`, `session.open` returns or resumes `sessionId`, the server keeps only lightweight session state, and the client owns replay of outstanding commits and subscriptions after reconnect.
- [ ] Keep the existing `/api/storage/memory` route, but dispatch v2 WebSocket traffic through the new session protocol and keep PATCH transact/query handlers as thin compatibility adapters for tests and one-shot tooling.
- [ ] Add minimal phase-1 blob support: immutable payload storage plus mutable metadata split; defer advanced blob metadata policy and classification behavior until after cutover.
- [ ] Build v2 emulation on top of the real v2 server code and an in-memory DB; do not maintain a fake-only code path for tests.

## Phase 1: Client Provider and Transaction Adapter
- [ ] Implement a `V2Provider` / `V2Replica` pair that preserves the current provider API shape while replacing the internals with confirmed-state plus pending-commit tiers, `localSeq`, and session-aware replay and resubscribe behavior.
- [ ] Preserve notification timing exactly: `"commit"` fires synchronously on local apply before `commit()` returns, `"revert"` fires synchronously before the returned promise resolves, `"integrate"` stays async and microtask-friendly, and `load` / `pull` / `reset` semantics remain usable by the scheduler.
- [ ] Keep pending-first reads in the replica so pipelined local transactions see optimistic state before confirmed state, and add explicit own-commit de-duplication so in-process and emulated transports do not double-notify.
- [ ] Keep `syncCell()` and schema sync on `graph.query`; keep one-shot `query` only as a compatibility and testing path, not as the primary runtime sync path.
- [ ] Reuse the existing `Journal`, `Chronicle`, `StorageTransaction`, and `ExtendedStorageTransaction` shapes; add a v2 adapter that converts journal history and activity into v2 read sets and converts each entity working copy into a root-level `set` or `delete` operation for phase 1.
- [ ] Do not gate cutover on direct patch emission from `Cell.set()`: in phase 1, path-level writes still materialize full entity documents before commit; true patch generation moves to the post-cutover phase.
- [ ] Update `StorageManager.open()`, `edit()`, and `emulate()` to dispatch to v1 or v2 provider and replica implementations based only on `memoryVersion`, while keeping the rest of the runtime oblivious to the storage version.

## Cutover Exit Criteria
- [ ] A runtime instantiated with `memoryVersion: "v2"` can run existing runner, pattern, and CLI flows without reaching any v1 code path.
- [ ] All existing integration tests that exercise `syncCell()`, schema traversal, persistence, reconnect, and scheduler-driven writes pass against a real toolshed server with v2 enabled.
- [ ] Add a randomized v1/v2 comparison test that drives the same non-branching, non-classified workload through both implementations and compares only behavior visible at `IStorageProvider` and `IExtendedStorageTransaction`.
- [ ] Add server integration tests for version negotiation, `session.open`, transact success, transact rejection and revert ordering, graph-query subscriptions, reconnect replay, and minimal blob persistence.
- [ ] Add focused client and provider tests for stacked pending commits, notification ordering, own-commit de-duplication, and retry-after-revert behavior.

## Phase 2: Post-Cutover Optimizations
- [ ] Change the transaction adapter so `Cell.set()` and path writes emit v2 patch operations directly when safe, starting with replace/add/remove/splice cases that preserve current conflict behavior.
- [ ] Add position-independent patch and remove helpers, and only relax claim tracking for patch classes that remain safe under optimistic pipelining.
- [ ] Add a short-lived server-side subscription and session resume cache to reduce replay traffic without changing the client contract.
- [ ] Tune snapshot cadence, prepared-statement caching, and blob I/O only after the cutover suite is green.

## Phase 3: Advanced Features After the Cutover
- [ ] Wire up branches end to end using the already-created `branch` table: create/delete/list, branch-scoped head resolution, merge proposals, branch-aware queries/subscriptions, and point-in-time reads on branches.
- [ ] Add garbage-collection scheduling for facts, snapshots, blobs, and deleted branches once retention rules are defined.
- [ ] Reintroduce classification and redaction only through the redesigned metadata model; do not revive v1 label entities on the v2 path.
- [ ] Add richer patch classes such as CRDT/OT text operations only after the branch and conflict model is stable.

## Assumptions and Defaults
- [ ] The plan file lives at [implementation-plan.md](/Users/berni/src/labs.exp-memory-impl-4/docs/specs/memory-v2/implementation-plan.md).
- [ ] The cutover switch is a `RuntimeOptions` setting, not an environment variable or repo-global constant.
- [ ] Phase 1 includes the schema/query/commit/session foundations needed for real runtime cutover, but not branching, classification/redaction redesign, or direct patch generation.
- [ ] Phase 1 preserves current runner-facing APIs and uses adapters underneath them instead of rewriting scheduler and cell call sites first.
