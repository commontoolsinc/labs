# Persistent Scheduler State Implementation Notes

## 2026-05-20 - Plan Checkpoint

- Branch: `codex/persistent-scheduler-state-spec`.
- Plan version: transaction-centric hybrid scheduler persistence with per-space
  mirrored read indexes.
- Initial assumptions:
  - scheduler observations are internal runtime state, not user-visible memory
    data
  - no-op observations are durable but do not create semantic memory revisions
  - the memory server records dirty/stale scheduler state but never executes
    actions
  - stable action identity starts from scheduler/action metadata and can be
    tightened when process graph snapshots become durable
- Known gaps to resolve during implementation:
  - exact durable action identity before full process graph snapshots exist
  - whether dirty/stale state needs per-cause rows instead of summary sequence
    fields
  - how far v1 rehydration can go without a persisted process graph snapshot
  - how to keep mirrored cross-space read index cleanup reliable after action
    replacement
- Validation so far: spec-only work, `git diff --check` passed before this
  implementation pass.

## 2026-05-20 - Red Test Checkpoint

- Added red tests for the first implementation seams:
  - scheduler observation construction excludes `attemptedWrites`
  - memory v2 persists no-op scheduler observations without semantic commits
  - memory v2 indexes scheduler readers and can mark them dirty from writes
- Expected failures before implementation:
  - missing `scheduler/persistent-observation.ts`
  - missing memory v2 scheduler-state engine APIs
- Decision: start with engine-level internal persistence and observation
  construction before trying full runner restart semantics. This keeps the
  first green slice independent of process graph snapshot work.

## 2026-05-20 - Observation Builder

- Implemented a pure scheduler observation builder in
  `packages/runner/src/scheduler/persistent-observation.ts`.
- Decision: keep this builder runner-local for now. Memory v2 gets its own
  structurally compatible type because `packages/memory` must not depend on
  `packages/runner`.
- Validation:
  - `deno test -A packages/runner/test/scheduler-observations.test.ts`

## 2026-05-20 - Memory V2 Internal Scheduler Tables

- Added initial memory-v2 internal tables and engine APIs for scheduler
  observations, latest action snapshots, read/write indexes, and action state.
- Decision: keep the first API engine-local. Cross-space mirroring will compose
  this API from storage/server code once the transaction integration exists.
- Decision: store paths through the memory boundary codec instead of ad hoc JSON
  so future rich path components remain on the normal persistence path.
- Known limitation: shallow read overlap is conservative and implemented in the
  engine helper for now; it may need to delegate to the runner's exact
  dependency overlap helper later.
- Validation:
  - `deno test -A packages/memory/test/v2-scheduler-state-test.ts`
  - `deno test -A packages/runner/test/scheduler-observations.test.ts`

## 2026-05-20 - Transaction Integration

- Added `schedulerObservation` to memory-v2 `ClientCommit` and runner native
  storage commits.
- Observation-only commits now persist scheduler rows without inserting a
  semantic commit or revisions. Replays by session/local sequence reuse the
  existing observation row and reject mismatched payloads.
- Runner storage transactions can carry a scheduler observation through
  `setSchedulerObservation()` / `getSchedulerObservation()`. V2 transactions
  use the write space when there is a semantic write and otherwise choose the
  first observation address space as the internal commit target.
- Scheduler action runs now attach an observation after runtime commit
  preparation and before the storage commit starts. The memory engine replaces
  the placeholder `observedAtSeq` with the accepting head/commit sequence.
- Known limitation: durable `pieceId`, process generation, and implementation
  fingerprints are conservative placeholders until process graph snapshots are
  persisted. Current-known writes are captured from the pre-resubscribe
  scheduler index in this slice; later rehydration work should persist the
  post-resubscribe scheduling view.
- Validation:
  - `deno test -A packages/memory/test/v2-scheduler-state-test.ts`
  - `deno test -A packages/runner/test/scheduler-observations.test.ts`

## 2026-05-20 - Durable Dirty Marking On Commits

- Added a memory-server `space` hint to engine commit application so semantic
  revisions can be translated into scheduler write addresses.
- Semantic commits now mark overlapping persisted scheduler readers
  direct-dirty inside the same engine transaction. Observation upsert still
  happens after dirty marking, so the action that just produced the observation
  is left clean while older/inactive readers remain dirty.
- Direct server writes and normal session transactions both pass their space
  into the engine. This covers non-action transactions for same-space persisted
  readers.
- Known limitation: this is same-engine dirty marking only. Mirrored cross-space
  read indexes still need a storage/server layer that writes read rows into the
  spaces being read and cleans them up on observation replacement.
- Validation:
  - `deno test -A packages/memory/test/v2-scheduler-state-test.ts`

## 2026-05-20 - Cross-Space Read Index Mirrors

- Added a server-side mirror pass for action observations. After the owner-space
  commit succeeds, the server writes a scheduler observation into every space
  read by the action, excluding the owner space that already stored it.
- Cleanup uses the previous owner-space snapshot's read spaces plus the new read
  spaces. Mirroring the new observation into old spaces removes stale read-index
  rows for that action through the normal observation replacement path.
- Decision: mirrors currently store full observation snapshots with
  `commit_seq = NULL` rather than introducing a read-index-only table path. This
  is heavier but keeps replacement semantics centralized in the engine API.
- Known limitation: mirror writes are not atomically committed with the owner
  semantic commit across multiple SQLite databases. A mirror failure currently
  fails the transaction response after the owner commit has been applied; a
  production version should mark the action unknown or retry mirror repair.
- Validation:
  - `deno test -A packages/memory/test/v2-scheduler-state-test.ts`

## 2026-05-20 - Scheduler Snapshot Query Surface

- Added an internal `scheduler.snapshot.list` memory-v2 request and client
  method. Runners can now ask a mounted space for latest persisted scheduler
  observations plus durable dirty/stale/unknown state.
- Added `Engine.listSchedulerActionSnapshots()` so the query can filter by
  branch, piece id, process generation, and action id.
- Decision: the wire result keeps `observation` typed as `unknown` at the
  generic memory protocol boundary. The runner side can validate/cast to its
  scheduler observation version when it starts consuming rehydration data.
- Validation:
  - `deno test -A packages/memory/test/v2-scheduler-state-test.ts`
  - `deno test -A packages/memory/test/v2-client-test.ts`

## 2026-05-20 - Runner Storage Query Hook

- Added `listSchedulerActionSnapshots()` to memory-v2-backed runner storage
  providers, behind an optional storage-provider method.
- Decision: keep this at the provider boundary for now. Scheduler rehydration
  can ask the provider for persisted observations once action identity/process
  graph resolution is available.
- Validation:
  - `deno test -A packages/runner/test/scheduler-observations.test.ts`

## 2026-05-20 - In-Memory Rehydration Primitive

- Added `Scheduler.rehydrateActionFromObservation()` as the first runner-side
  consumer primitive. It rebuilds subscriptions/dependency indexes from a
  persisted observation and clears first-run dirty/pending pressure when the
  durable snapshot is clean.
- Dirty, stale, or unknown snapshots are deliberately kept dirty/pending so the
  existing execution path recomputes them on demand.
- Added address-based materializer registration so persisted materializer
  envelopes can be restored without converting them back to source annotations.
- Known limitation: this is not yet automatically called during pattern/process
  startup. The next step is resolving stable process graph action identities to
  actions and invoking this primitive during subscription.
- Validation:
  - `deno test -A packages/runner/test/scheduler-observations.test.ts`

## 2026-05-20 - Storage-Backed Rehydration Helper

- Added `Scheduler.rehydrateActionFromStorage()`, an explicit async helper that
  queries the action's mounted space for persisted scheduler snapshots, validates
  the observation payload, and applies the in-memory rehydration primitive.
- Decision: this remains explicit rather than automatic because subscription is
  currently synchronous. Automatic startup rehydration needs a process graph
  loader or an async subscription phase.
- Added a version-1 observation type guard so the runner does not trust raw
  memory-boundary `unknown` payloads.
- Validation:
  - `deno test -A packages/runner/test/scheduler-observations.test.ts`

## 2026-05-20 - Persistent State Benchmarks

- Added `packages/runner/test/scheduler-persistent-state.bench.ts` for clean
  and targeted-dirty in-memory rehydration at 100 and 1000 actions.
- Benchmark results on this machine:
  - clean rehydrate 100 actions: 4.4 ms/iter
  - targeted dirty rehydrate 100 actions: 4.3 ms/iter
  - clean rehydrate 1000 actions: 10.2 ms/iter
  - targeted dirty rehydrate 1000 actions: 8.4 ms/iter
- Interpretation: this benchmark measures the new scheduler-index rehydration
  primitive only. It does not yet include process graph loading, storage query
  latency, or full pattern startup.
- Validation:
  - `deno bench -A packages/runner/test/scheduler-persistent-state.bench.ts`

## 2026-05-20 - Spec Sync

- Updated `docs/specs/persistent-scheduler-state.md` from research-only
  language to initial-implementation language.
- Corrected the action-commit ordering to match the implementation: dirty
  existing readers first, then upsert the current action observation so the
  successful action can become clean.
- Documented the current cross-space mirror strategy and the explicit runner
  rehydration primitives.

## 2026-05-20 - Runner Package Validation Follow-up

- `HEADLESS=1 deno task test` in `packages/runner` exposed an uncaught
  `StorageTransactionAborted` rejection in `scheduler-retries.test.ts`.
- Decision: attaching a scheduler observation must not change the behavior of a
  transaction that the action already intentionally aborted. Observation
  attachment now skips inactive/aborted transaction targets and lets the
  existing retry path consume the commit result.
- Spec adjustment: softened the "not user-visible" language. Memory and runner
  are part of one runtime stack, so explicit scheduler-facing memory APIs are
  acceptable; the boundary is ordinary user data snapshots and semantic
  revisions, not hiding scheduler concepts from runner-owned memory calls.
- Validation:
  - `HEADLESS=1 deno test -A packages/runner/test/scheduler-retries.test.ts`

## 2026-05-20 - Final Local Validation

- Runner package test is green after the aborted-transaction observation fix.
- Repo type/check task is green.
- Validation:
  - `HEADLESS=1 deno task test` in `packages/runner`
  - `deno task check`

## 2026-05-20 - Automatic Subscription Rehydration

- Added a scheduler subscription path that can defer first-run scheduling while
  it queries storage for a persisted action snapshot. Clean snapshots now
  restore dependency/write/materializer indexes without executing the action;
  missing or failed snapshots fall back to the existing first-run behavior.
- Decision: runner-provided persistent identity uses the process cell's
  normalized scope/id plus process generation 0. This is still conservative, but
  it distinguishes colocated pieces of the same pattern better than the earlier
  pattern/module-name fallback.
- Added runner-level restart coverage that creates a piece, persists a clean
  computation observation, stops the runner, starts the same result cell again,
  and verifies the computation is not rerun.
- Spec sync: updated the status and full-piece rehydration sections to describe
  subscription-time rehydration as implemented, with process generation and
  stronger fingerprints still called out as version-1 limitations.
- Validation:
  - `HEADLESS=1 deno test -A packages/runner/test/scheduler-observations.test.ts`

## 2026-05-20 - Rehydration Fingerprint Guard

- Tightened storage-backed rehydration so a persisted snapshot must match the
  recreated action's implementation fingerprint and the active scheduler runtime
  mode before it can restore indexes or skip execution.
- Decision: `rehydrateActionFromObservation()` remains the low-level primitive
  for already-validated snapshots. The storage-backed entrypoint performs the
  trust boundary check because it consumes unknown memory-boundary payloads.
- Added coverage that a matching action id with a stale implementation
  fingerprint falls back to the normal first run.
- Validation:
  - `HEADLESS=1 deno test -A packages/runner/test/scheduler-observations.test.ts`

## 2026-05-20 - Memory Package Validation

- Full repo `HEADLESS=1 deno task test` initially failed only in
  `packages/memory`: the revision-schema bootstrap test still expected the
  pre-scheduler table list.
- Updated the test fixture to include the internal scheduler observation,
  snapshot, read index, write index, and action state tables created by the
  memory-v2 engine bootstrap.
- Validation:
  - `HEADLESS=1 deno task test` in `packages/memory`

## 2026-05-20 - Integration Teardown Follow-up

- Full repo `HEADLESS=1 deno task integration` initially failed only in
  `packages/shell/integration/piece.test.ts` with a leaked memory WebSocket.
- Root cause: the new subscription-time rehydration path added async scheduler
  storage lookups, which made teardown ordering more visible. Runtime disposal
  now waits for scheduler background work before closing storage sessions.
- Also hardened the remote memory WebSocket transport so `close()` owns and can
  close a socket while it is still connecting. Previously, closing during the
  connection-opening window could leave a server-side WebSocket resource alive.
- Shell integration now creates and closes a fresh page per test so page-owned
  runtime resources do not survive Deno's per-test leak boundary.
- Validation:
  - `HEADLESS=1 deno task integration shell`
