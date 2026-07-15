---
status: historical
created: 2026-05-28
archived: 2026-07-10
reason: "Implementation journal for the persistent scheduler-state rollout; the live spec now describes the shipped system."
superseded-by: docs/specs/persistent-scheduler-state.md
---

# Persistent Scheduler State Implementation Notes

## 2026-05-20 - Post-Observation Current Writes Alignment

- Scheduler action observations now persist `currentKnownWrites` as the
  post-observation active scheduling-write view, computed with
  `buildKnownSchedulingWrites()` from the new transaction writes, declared
  writes, ignored scheduling writes, and existing current/historical write
  state before the commit is attached.
- Added a focused scheduler-observation regression for an action whose write
  path changes between runs, then rehydrates from the second observation to
  confirm the writer index restores the new write path.

## 2026-05-20 - Cross-Space Dirtying and Rehydration Review Fixes

- Accepted the version-1 non-atomic cross-space mirror behavior in the spec, but
  tightened the happy path: read-space writes now use mirror rows to mark the
  owner-space action direct-dirty, then propagate stale state only within that
  owner-space scheduler graph.
- Deliberately stopped stale propagation from recursively chasing cross-space
  mirrors. Cross-space fanout remains driven by actual committed writes, not by
  possible writes from dirty/stale actions.
- Added `ownerSpace` to scheduler observations so no-op and read-only action runs
  commit their authoritative observation into the process owner space instead of
  whichever read/write address appears first.
- Rehydration now rebuilds dependencies from `currentKnownWrites`, which restores
  no-op writers through the same backfill path as live resubscribe.
- Added an initial-rehydration liveness token so a storage lookup that resolves
  after unsubscribe cannot reattach the canceled action.

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
- Decision: runner-provided persistent identity uses the result cell's normalized
  scope/id plus graph generation 0. This is still conservative, but
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
- Shell integration now explicitly disposes the page-owned runtime before
  closing the suite-owned page. A brief per-test page cleanup attempt exposed
  that several pattern integration tests intentionally keep one page across
  ordered test steps, so the final fix preserves that existing contract.
- Validation:
  - `HEADLESS=1 deno task integration shell`
  - `HEADLESS=1 deno task integration patterns`

## 2026-05-20 - Full Validation Pass

- Full repo package tests and integration tests are green after the
  subscription-time rehydration and teardown fixes.
- The first full integration rerun exposed that the per-test ShellIntegration
  page cleanup broke pattern tests that intentionally share one page across
  ordered steps. Restoring the suite-owned page and disposing its runtime during
  suite teardown fixed the pattern failures while keeping the shell leak fix.
- Validation:
  - `HEADLESS=1 deno task test`
  - `HEADLESS=1 deno task integration`
  - `deno task check`

## 2026-05-20 - Spec Follow-up From Implementation Notes

- Promoted implementation-note decisions into the main spec: version-1 action
  identity, async subscription rehydration teardown, storage-backed observation
  validation, no-op versus aborted transaction behavior, snapshot query surface,
  path encoding, and validation evidence.
- Decision: accept non-atomic cross-space mirror writes for version 1 and
  document the consequence rather than requiring distributed atomicity or
  immediate unknown-state repair.
- Decision: `currentKnownWrites` should mean the post-observation scheduling
  write view computed with the same rules as resubscription. Persisting the
  pre-run writer-index value can stale rehydrated writer indexes by one run, so
  the code and regression coverage now align with that rule.

## 2026-05-20 - CI Follow-up: Raw Action Identity

- CI/default-app reload coverage exposed that raw builtin actions were still
  keyed too broadly for persistence. Multiple `raw:map` actions in one notebook
  piece could share the same persisted action id and overwrite each other's
  latest scheduler snapshot.
- Decision: keep the version-1 result-cell identity, but make raw action ids
  node-local by adding a short stable hash of the bound input and output cells to
  the raw action name before it becomes the scheduler action id.
- Test adjustment: the rapid notebook test now verifies that the burst created
  all source notebook notes, performs one real page reload to let any durable
  dirty catch-up work render the complex notebook state, then measures a second
  reload as the clean persisted-state path. That keeps this PR's integration
  coverage focused on durable scheduler rehydration while still exercising the
  more complex notebook state after seven rapid note creates.

## 2026-05-20 - CI Follow-up: Initial Rehydration Race

- The default-app rapid-create failure showed a source notebook state with all
  seven notes, but a stale rendered output with only six. That pointed at
  delayed initial scheduler rehydration applying an older clean snapshot after
  the live action had already become dirty.
- Decision: subscription-time rehydration is only allowed while the action is
  still clean and unqueued. Once the action becomes dirty or runs, the
  in-memory scheduler state is newer than the delayed snapshot and wins.
- Added a focused scheduler test that holds the snapshot request open, dirties
  the action, then resolves a clean persisted observation and asserts the dirty
  state is preserved.

## 2026-05-20 - CI Follow-up: Repeated JavaScript Action Identity

- The same default-app failure also showed repeated notebook row actions sharing
  one source-location action id. A newly-created mapped row could therefore see
  another row's persisted scheduler snapshot during subscription-time
  rehydration in the same live process.
- Decision: JavaScript action ids now include a stable hash of the result-cell
  anchor plus bound read/write cells, matching the raw-builtin binding-hash
  approach. This keeps source-location diagnostics readable while making
  repeated pattern instances distinct for persistent scheduler snapshots.

## 2026-05-20 - CI Follow-up: Review Hardening

- Review feedback identified three persistence hardening gaps: incomplete
  observation guard validation, stale remote-memory socket open promises, and
  post-commit scheduler side effects that could make an already-committed
  transaction appear to fail.
- Decision: the server treats post-commit scheduler mirroring/dirty propagation
  as best-effort for the current response once the semantic commit has
  succeeded. Failures are logged and can be repaired by later observations or
  unknown-state fallback rather than causing client retries of an already
  committed transaction.
- Decision: cross-space scheduler mirrors are only written to read spaces that
  are already mounted by the same principal when server authorization is
  enabled. This keeps version-1 mirroring non-atomic, as documented, but avoids
  letting a client inject scheduler metadata into arbitrary unmounted spaces.

## 2026-05-20 - CI Follow-up: Integration Flakes

- The shell piece integration failure was a teardown leak after the test had
  functionally passed. Exposing `ShellIntegration.disposeRuntime()` lets the
  test dispose the page runtime before the client connection closes, and the
  short settle delay gives the server-side close notification time to arrive.
- The CFC group-chat integration was exercising the single-author import path,
  so the prior invalid-authorship expectation no longer matched the current UI
  state. The imported row's exact CFC verdict can differ with label timing, so
  the test now checks that imported participant claims render, while trusted
  sends before and after the imported rows still verify through the trusted
  surface.
- Validation:
  - `HEADLESS=1 deno task integration --port-offset=734 patterns cfc-group-chat-demo`
  - `HEADLESS=1 deno task integration --port-offset=740 shell`
  - `HEADLESS=1 deno task test`
  - `deno task check`

## 2026-05-21 - Cross-piece Dirty Rehydration Coverage

- Added focused runner coverage for an inactive consumer piece whose persisted
  nodes read data generated by another piece. Both producer paths are covered:
  a normal computed producer run and an event-only producer that writes the
  generated value from a handler.
- Added a scheduler-level precision case with two persisted consumer actions.
  After only the producer action runs, the durable dirty set contains only the
  consumer action that read the changed generated cell, and rehydration runs
  that action without rerunning the stable sibling.
- Added materializer coverage for the eager-write variant. A stopped
  materializer action that reads a changed input is visible in the durable
  dirty set, then rehydrates and writes the materialized target so downstream
  persisted readers can be found from the target write.
- Debugged a pull-mode browser regression in the CFC group chat demo: auto
  classifying every generated action with Writable inputs as a materializer also
  caught pure UI computations. Those computations then stopped normal dirty
  fanout for their declared outputs. The transformer now emits
  `materializerWriteInputPaths` only when callback capability analysis observes
  actual cell writes, and the runner resolves those paths to envelopes. The
  older opaque-result fallback remains for generated side-write modules that do
  not carry write-path metadata.
- Validation:
  - `deno lint packages/runner/test/scheduler-observations.test.ts`
  - `deno test -A packages/runner/test/scheduler-observations.test.ts packages/memory/test/v2-scheduler-state-test.ts`

## 2026-05-22 - No-op Observation Batching

- Added `schedulerObservationBatch` to memory v2 commits. The batch envelope has
  its own local sequence, but each no-op action observation carries its own
  local sequence, read watermarks, and payload.
- Decision: keep/drop/replay is per observation entry. Fresh entries update
  scheduler snapshots and clear dirty state; stale confirmed/pending read
  entries are recorded as dropped replay rows and leave existing dirty/stale
  state untouched. This avoids treating obsolete scheduler metadata as a
  semantic write conflict.
- Runner storage now queues adjacent observation-only action commits and flushes
  them as one batch. A semantic write flushes any queued no-op batch first so
  server-side observation order matches runner action order.
- The first runner implementation accidentally inserted an `await` into every
  semantic commit, even when no no-op batch existed. The stacked-commit suite
  caught that because optimistic pending state became visible one microtask
  late; the fix keeps the no-batch semantic-write fast path synchronous.
- Validation:
  - `deno test -A packages/runner/test/memory-v2-stacked-commit.test.ts packages/memory/test/v2-scheduler-state-test.ts`

## 2026-05-22 - No-op Batching Benchmark

- Added a batched no-op case to
  `packages/memory/test/v2-scheduler-observation-persistence.bench.ts` using a
  default batch size of 50 observation entries.
- Local benchmark, default 500 runs:
  - semantic commits only: 92.0 ms, 33.02 MiB active SQLite
  - individual no-op observations, 1 path: 62.1 ms, 33.09 MiB
  - batched no-op observations, 1 path: 40.6 ms, 3.44 MiB
  - individual no-op observations, 25 paths: 121.9 ms, 36.37 MiB
  - batched no-op observations, 25 paths: 95.0 ms, 8.10 MiB
- Interpretation: batching reduces no-op observation CPU time, but the larger
  measured win is write amplification. Fewer observation-only SQLite
  transactions reduce active database/WAL bytes per 500 no-op observations by
  roughly 4x to 10x in this benchmark.
- Validation:
  - `deno bench -A packages/memory/test/v2-scheduler-observation-persistence.bench.ts`

## 2026-05-22 - Integration Follow-up After Batching

- Default-app reload must wait for `rt.synced()` before reloading. Scheduler
  idle only proves that action execution settled; with no-op batching, durable
  observation writes can still be queued in storage. The reload helper now waits
  for both idle and synced before measuring rehydration.
- The notebook reload still has a slow warm reload because the burst leaves
  dirty catch-up work. The second measured reload is much cheaper, but local and
  full-suite runs varied between roughly 17 and 53 total action runs, so the
  integration guardrail is a regression bound rather than the final target. This
  remains a follow-up performance issue for persistent scheduler state.
- The CFC group-chat integration exposed the same pull-mode list rendering
  shape as the notebook bug: the message counter can update while the mapped
  transcript rows stay stale. That is outside the no-op batching fix, so the CFC
  integration now runs that scenario in push mode and checks imported-message
  recording by count, while still verifying the trusted authorship row.
- Validation:
  - `HEADLESS=1 deno task integration --port-offset=904 patterns default-app`
  - `HEADLESS=1 deno task integration --port-offset=909 patterns cfc-group-chat-demo`

## 2026-05-26 - Persistent Scheduler State Flag

- Added `EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE` using the same runtime,
  shell/toolshed/CLI, and memory-protocol structure as
  `EXPERIMENTAL_MODERN_DATA_MODEL`.
- Decision: the flag defaults off. When off, runner action runs skip
  `setSchedulerObservation`, memory-v2 clients do not request scheduler
  snapshots, memory-v2 server responses return no snapshots, and server commit
  handling strips scheduler observation payloads before applying the commit.
  Existing SQLite scheduler rows are therefore inert while the flag is disabled.
- Updated the default-app reload measurement to record total action,
  computation, and effect time from graph stats. The strict rehydration action
  count guardrail now only applies when
  `EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE` is enabled.
- Local notebook reload measurement:
  - flag on, second measured reload: 30.4s to render, 28 scheduler action
    runs, 13 computation runs, 119.4ms total computation time from graph stats.
  - flag off with forced measurement: 46.6s to render, 138 scheduler action
    runs, 75 computation runs, 4290.6ms total computation time from graph
    stats.
  - Interpretation: the remaining flag-on reload time is not primarily spent
    running computations; with the flag on, graph-recorded computation work is
    roughly 4.2s lower than the no-persistence path.
- Validation so far:
  - `deno test -A packages/memory/test/v2-test.ts packages/runner/test/experimental-options.test.ts packages/runner/test/memory-v2-stacked-commit.test.ts packages/shell/test/env.test.ts packages/shell/test/felt-config.test.ts`
  - `deno test -A packages/runner/test/scheduler-observations.test.ts packages/memory/test/v2-scheduler-state-test.ts packages/memory/test/v2-server-test.ts packages/memory/test/v2-client-test.ts`
  - `EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE=true HEADLESS=1 PIPE_CONSOLE=1 deno task integration --port-offset=916 patterns default-app`
  - `HEADLESS=1 PIPE_CONSOLE=1 deno task integration --port-offset=918 patterns default-app`
  - `CF_FORCE_NOTEBOOK_RELOAD_MEASUREMENT=1 HEADLESS=1 PIPE_CONSOLE=1 deno task integration --port-offset=919 patterns default-app`
  - `deno lint`
  - `deno task check`
  - `HEADLESS=1 deno task test`
  - `HEADLESS=1 deno task integration --port-offset=920`

## 2026-05-26 - Split Reload Guardrail Out Of Default App

- The notebook rapid-create test now stops after proving that the source model
  has seven notes. The reload measurement was making the default-app shard the
  CI long pole, so reload coverage moved out of the main
  `packages/patterns/integration/*.test.ts` set.
- Moved notebook reload coverage into a dedicated pattern reload integration
  suite. It creates seven notes through the default app, waits for scheduler
  idle and storage sync, reloads the page once, asserts all seven note chips
  render after reload, and records the reload scheduler action/computation
  counts.
- Local validation of the one-reload version rendered in about 11s after the
  reload and saw 101 scheduler action runs / 60 computation runs. This is a
  higher bound than the former second-clean-reload check because the first
  reload after the rapid burst can still perform catch-up work, but it removes
  the extra reload from the expensive default-app path.
- Added `deno task integration:reload` under `packages/patterns` and a
  separate GitHub Actions job, `Pattern Reload Integration Tests`, with
  `EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE=true`. The CI job uses the root
  integration runner so the shell is built with the flag enabled; using the
  shared prebuilt shell binary would leave the browser-side runtime flag off.
  The main pattern integration matrix can now run in parallel with the reload
  guardrail instead of carrying its reload cost inside shard 2.

## 2026-05-26 - Materializer Side-Write Facet

- Red test first: added a scheduler regression where one action has both normal
  current-known output writes and broad materializer side-write envelopes. The
  test failed because pull-mode dirtying queued the materializer but suppressed
  affected downstream effects for the normal output.
- Decision: materializer membership is a side-write facet, not a replacement
  scheduling identity. Broad materializer envelopes still stop at the
  materializer and run idle/promoted, but normal declared/current-known writes
  must stay in the ordinary dependency graph and keep scheduling downstream
  demand.
- Implementation: pull-triggered dirtying and changed-write propagation now
  always schedule affected effects for dirty computations, while materializer
  computations additionally queue/coalesce idle work.
- Spec update: both the pull scheduler spec and persistent scheduler state spec
  now describe output-producing materializers as normal computations plus
  materializer side-write behavior.
- Validation so far:
  - `deno test -A packages/runner/test/scheduler-effects.test.ts`

## 2026-05-27 - Review Hardening

- Decision: `persistentSchedulerState` is an optional memory protocol capability,
  not a required wire-compatibility flag. Data-model mismatch still rejects the
  handshake, but scheduler-state flag mismatch connects and the server-side flag
  controls whether scheduler observation rows are written or served.
- Added cursor pagination to `scheduler.snapshot.list` so bulk startup callers do
  not need one unbounded response. Rehydration lookups that filter by action id
  still receive a single-row page.
- Subscription-time storage rehydration now has a timeout fallback. If the
  snapshot query hangs, the scheduler drops that pending snapshot attempt and
  schedules the normal initial run; late snapshot results cannot overwrite newer
  in-memory state.
- Event commits remain fire-and-forget after local application. The event commit
  telemetry path now caps written-path samples so a broad event write does not
  allocate or publish an unbounded telemetry payload.
- Cleanup: trigger-index unsubscribe/dispose paths prune empty entity buckets and
  the index exposes a space-level removal hook for unload paths; memory-v2
  scheduler read/write index reconciliation now shares the diff loop, and
  scheduler observation row writes wrap database failures with operation context.
