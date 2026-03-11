# Memory v2 Implementation Plan

## Summary
- [x] Write this plan into [implementation-plan.md](/Users/berni/src/labs.exp-memory-impl-4/docs/specs/memory-v2/implementation-plan.md).
- [x] Keep Memory v2 inside the existing packages rather than creating a new workspace package.
- [x] Treat the phase-1 cutover as: a `Runtime` configured with `memoryVersion: "v2"` uses v2 implementations for `IStorageProvider` and `IExtendedStorageTransaction`, while runner and scheduler call sites remain unchanged.
- [x] Execute the rollout with red/green TDD and commit in small slices, including red commits when they clarify the intended behavior.
- [x] Keep v1 and v2 running in parallel during migration, but keep storage physically separate. V2 uses its own SQLite layout and emulation path.
- [x] Keep the plan file at [implementation-plan.md](/Users/berni/src/labs.exp-memory-impl-4/docs/specs/memory-v2/implementation-plan.md) and update it to match the plan currently being executed on `codex/memory-v2`.

## Historical Completed Items
- [x] Add v2 code inside the existing packages rather than creating a new workspace package: shared/server code under [packages/memory](/Users/berni/src/labs.exp-memory-impl-4/packages/memory), client wiring under [packages/runner/src/storage](/Users/berni/src/labs.exp-memory-impl-4/packages/runner/src/storage), and route/transport dispatch under [packages/toolshed/routes/storage/memory](/Users/berni/src/labs.exp-memory-impl-4/packages/toolshed/routes/storage/memory).
- [x] Treat the cutover target as non-branching v1 parity first: current runtime usage is centered on `syncCell()`, schema traversal, subscriptions, reconnect, optimistic pending writes, and scheduler notification ordering.
- [x] Treat immutable blob payload storage as lower priority than provider/query parity. The v1 cutover path does not currently depend on dedicated blob upload/download routes, but the v2 engine now has the foundational `blob_store` support.
- [x] Add `memoryVersion?: "v1" | "v2"` to `RuntimeOptions` in [runtime.ts](/Users/berni/src/labs.exp-memory-impl-4/packages/runner/src/runtime.ts), default it to `"v1"`, and thread the resolved value into storage-manager construction and emulation.
- [x] Introduce `IStorageNotification` / `StorageNotificationRelay` as the canonical internal names for scheduler notifications, and export temporary aliases for `IStorageSubscription` / `StorageSubscription` until v1 is removed.
- [x] Keep compatibility-only fields such as classification and labels accepted at the cutover boundary, but treat them as ignored inputs on the v2 path and stop creating label side-writes in v2.
- [x] Define v2 shared types and codecs around `EntityDocument`, `Operation`, `ClientCommit`, `ConfirmedRead`, `PendingRead`, `PatchOp`, `SessionOpen`, `Receipt`, and `merkle-reference/json`; keep entity storage untyped and re-root selector paths to `["value", ...path]`.
- [x] Bootstrap the v2 per-space SQLite schema with `value`, `fact`, `head`, `commit`, `invocation`, `authorization`, `snapshot`, `branch`, and minimal blob tables, plus the required pragmas, prepared statements, and default-branch bootstrap.
- [x] Implement the phase-1 logical session model: the first WebSocket message negotiates `memory/v2`, `session.open` returns or resumes `sessionId`, the server keeps only lightweight session state, and the client owns replay of outstanding commits and subscriptions after reconnect.
- [x] Keep the existing `/api/storage/memory` route, but dispatch v2 WebSocket traffic through the new session protocol and keep PATCH transact/query handlers as thin compatibility adapters for tests and one-shot tooling.
- [x] Add a randomized v1/v2 comparison test that drives the same non-branching, non-classified workload through both implementations and compares only behavior visible at `IStorageProvider` and `IExtendedStorageTransaction`.

## Current Status
- [x] Establish the runtime cutover seam with `memoryVersion: "v2"` in [runtime.ts](/Users/berni/src/labs.exp-memory-impl-4/packages/runner/src/runtime.ts) and the runner storage manager.
- [x] Build the spec-native v2 engine as a clean-room implementation under [packages/memory/v2](/Users/berni/src/labs.exp-memory-impl-4/packages/memory/v2), without reusing v1 storage internals.
- [x] Hard-cut the websocket protocol to `memory/v2` for v2 runtimes instead of preserving the old query/transact/subscription wire shape.
- [x] Route v2 runtime traffic through the spec-native engine on both the real toolshed route and the emulated path.
- [x] Reach parity for the main v1-used reactive flows already exercised on this branch: schema sync, linked-document propagation, deep link chains, reconnect resubscribe, scheduler pull reactivity, alias schema round-trip, and alias retargeting.
- [ ] Finish reconnect parity when there is still outstanding local optimistic work.
- [ ] Finish the remaining engine-native pieces that are not required for v1 parity but are still part of the v2 design, especially snapshots and post-cutover optimizations.

## Reprioritized For V1 Parity
- [x] Treat non-branching v1 parity as the actual cutover target. The current runtime depends on `syncCell()`, schema traversal, subscriptions, reconnect, optimistic writes, and notification ordering.
- [x] Treat branch lifecycle, branch-scoped reads, merges, and branch-aware subscriptions as explicitly post-cutover work. There is no current v1 branch surface to preserve.
- [x] Treat direct patch emission from `Cell.set()` as post-cutover work. Phase 1 can continue materializing full entity documents before commit.
- [x] Treat dedicated blob transport and metadata policy as lower priority than provider/query/runtime parity. Existing v1 runtime flows do not depend on blob endpoints.
- [x] Reuse shared traversal behavior from [traverse.ts](/Users/berni/src/labs.exp-memory-impl-4/packages/runner/src/traverse.ts) for v2 graph queries and subscriptions rather than rebuilding that logic in the server.
- [x] Preserve the v1-visible notification contract at the runtime boundary: optimistic `"commit"`, synchronous `"revert"` before the promise resolves, and async `"integrate"` for remote updates.

## Immediate Next Slice
- [ ] Add focused tests for reconnect with outstanding local commits, including disconnect during an in-flight commit and replay after reconnect.
- [ ] Preserve notification ordering when reconnect replay, remote integrate, and local optimistic state all interact in the same space.
- [ ] Add coverage for stacked pending commits plus remote updates to prove own-commit de-duplication and retry-after-revert behavior.
- [ ] Port the remaining high-value runner integration suites that still only exercise v1 onto `memoryVersion: "v2"`, especially reconnect-heavy flows.

## Public Interfaces And Cutover Boundary
- [x] Add `memoryVersion?: "v1" | "v2"` to `RuntimeOptions` and thread the resolved value into storage-manager construction and emulation.
- [x] Keep `IStorageManager`, `IStorageProvider`, `IExtendedStorageTransaction`, `StorageValue`, `syncCell()`, and `subscribe()` stable at the runtime boundary for phase 1.
- [x] Introduce `IStorageNotification` / `StorageNotificationRelay` as the canonical internal names for scheduler notifications, while keeping temporary aliases for `IStorageSubscription` / `StorageSubscription`.
- [x] Keep compatibility-only fields such as classification and labels accepted at the cutover boundary, but ignore them on the v2 path and stop creating label side-writes in v2.
- [ ] Add explicit v1 guard assertions at the remaining v1 provider, transaction, consumer, and server entry points so a runtime configured for v2 fails immediately if it ever reaches a v1-only path.

## Phase 1: Core V2 Stack Required Before Cutover
- [x] Define the shared v2 types and codecs around `EntityDocument`, `Operation`, `ClientCommit`, `ConfirmedRead`, `PendingRead`, `PatchOp`, `SessionOpen`, `Receipt`, and `merkle-reference/json`.
- [x] Bootstrap the v2 per-space SQLite schema with `value`, `fact`, `head`, `commit`, `invocation`, `authorization`, `snapshot`, `branch`, and minimal blob tables, including pragmas and default-branch bootstrap.
- [x] Implement the core read path for current v1-parity needs: head lookup, point-in-time reconstruction by `seq`, patch replay, `source` link traversal, and schema-driven `graph.query` using the shared traversal code path.
- [x] Make `graph.query` follow write redirects for plain alias sync as well as schema-bearing selectors, so live alias retargeting stays subscription-safe.
- [ ] Add snapshot creation and lookup to the read engine so point-in-time reads do not depend entirely on replay.
- [x] Implement the core commit path for current v1-parity needs: parent resolution, global `seq` assignment, atomic fact/head/commit writes, and pending-read resolution from `(sessionId, localSeq)`.
- [x] Reject stale confirmed reads conservatively on the v2 path.
- [ ] Tighten overlap-path conflict analysis beyond the current conservative confirmed-read checks where existing v1 behavior requires more precision.
- [x] Implement the phase-1 logical session model: websocket `hello`, `session.open`, resume by `sessionId`, and client-owned replay/resubscribe after reconnect.
- [x] Keep the existing `/api/storage/memory` route, but dispatch v2 traffic through the new protocol while keeping one-shot compatibility handlers only for tests and tooling.
- [x] Add foundational blob storage in the engine for immutable payload persistence.
- [ ] Add the phase-1 mutable blob metadata split and any transport endpoints actually needed for runtime cutover.
- [x] Build v2 emulation on top of the real v2 server code rather than maintaining a fake-only v2 test backend.

## Phase 1: Client Provider And Transaction Adapter
- [x] Cut runtime `memoryVersion: "v2"` over to a real v2 storage path in the runner rather than the old compatibility-backed route.
- [x] Preserve the current provider/transaction surface so runner and scheduler call sites remain unchanged.
- [x] Keep `syncCell()` and schema sync on `graph.query`; one-shot query remains only a compatibility and testing path.
- [x] Reuse the existing `Journal`, `Chronicle`, `StorageTransaction`, and `ExtendedStorageTransaction` shapes for the phase-1 adapter.
- [x] Preserve basic notification timing for optimistic commit, revert, integrate, `load`, `pull`, and `reset`, with explicit coverage for conflict-before-revert ordering.
- [x] Reconnect the shared v2 client and resubscribe active `graph.query` views after websocket loss.
- [x] Preserve alias/schema/link-heavy reactive behavior through the v2 path, including deep links and alias retargeting.
- [ ] Finish pending-first replica behavior for reconnect with outstanding local commits, including replay of in-flight and queued local writes.
- [ ] Add stronger proof for own-commit de-duplication when local replay and remote integrate race after reconnect.
- [ ] Do not gate cutover on direct patch emission from `Cell.set()`. Leave true patch generation for the post-cutover phase.

## Cutover Exit Criteria
- [ ] A runtime instantiated with `memoryVersion: "v2"` can run existing runner, pattern, and CLI flows without reaching any v1 code path.
- [ ] The remaining runner integration suites that matter for v1 behavior pass against a real toolshed server with v2 enabled.
- [x] Add a randomized v1/v2 comparison test that drives the same non-branching, non-classified workload through both implementations and compares only behavior visible at `IStorageProvider` and `IExtendedStorageTransaction`.
- [x] Add server integration tests for version negotiation, `session.open`, transact success, transact rejection and revert ordering, graph-query subscriptions, reconnect replay, and live alias retargeting.
- [ ] Extend server integration coverage to any runtime-critical blob behavior once the blob transport shape is finalized.
- [ ] Add focused client and provider tests for stacked pending commits, reconnect replay of local commits, own-commit de-duplication, and retry-after-revert behavior.

## Phase 2: Post-Cutover Optimizations
- [ ] Add snapshot cadence and lookup so long histories do not depend on pure replay.
- [ ] Change the transaction adapter so `Cell.set()` and path writes emit v2 patch operations directly when safe.
- [ ] Add position-independent patch and remove helpers, and only relax claim tracking for patch classes that remain safe under optimistic pipelining.
- [ ] Add a short-lived server-side subscription and session resume cache to reduce replay traffic without changing the client contract.
- [ ] Tune prepared-statement caching and blob I/O only after the cutover suite is green.

## Phase 3: Advanced Features After The Cutover
- [ ] Wire up branches end to end using the already-created `branch` table: create/delete/list, branch-scoped head resolution, merge proposals, branch-aware queries/subscriptions, and point-in-time reads on branches.
- [ ] Add garbage-collection scheduling for facts, snapshots, blobs, and deleted branches once retention rules are defined.
- [ ] Reintroduce classification and redaction only through the redesigned metadata model. Do not revive v1 label entities on the v2 path.
- [ ] Add richer patch classes such as CRDT/OT text operations only after the branch and conflict model is stable.

## Assumptions And Defaults
- [x] The cutover switch is a `RuntimeOptions` setting, not an environment variable or repo-global constant.
- [x] Phase 1 includes the schema/query/commit/session foundations needed for real runtime cutover, but not branching, classification/redaction redesign, or direct patch generation.
- [x] Phase 1 preserves current runner-facing APIs and uses adapters underneath them instead of rewriting scheduler and cell call sites first.
- [x] The current branch plan prioritizes v1-used runtime behavior over completeness of the full long-term v2 design.
