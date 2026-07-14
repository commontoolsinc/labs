---
status: historical
created: 2026-07-01
archived: 2026-07-09
reason: "Scheduler-v2 investigation record: the serialized scheduler state is reload-only, not a version skip."
---

# Addendum A5 — The serialized scheduler state is reload-only, not a version skip

> **Status**: Refuted hypothesis
> **Context**: multi-user cfc-group-chat scheduler-v2 vs main slowness investigation (2026-06/07), informing PR #4288.
> **Companion**: [scheduler-v2 README](../../../../specs/scheduler-v2/README.md); sibling addenda in this folder.

## Finding
The serialized/persistent scheduler state (the "scheduler observation") is a **reload-only rehydration record** on both main and v2 — not a mechanism that lets one runtime skip a re-derivation by adopting a peer's already-computed result. It stores read-set **addresses** (no per-read version), is consumed **only at preload**, and decides re-run on the **presence** of an address-overlap dirty marker rather than a version compare. Its cross-space wiring propagates **dirtiness** to force peers to recompute — the opposite of result adoption. It is default-OFF and not enabled in the benchmark, so it cannot be the source of the steady-state +16%. Verified via a 4-reader plus adversarial-synthesis pass against main @8b8471a48 and v2 @893037972; the synthesis verdict was "refuted".

## Evidence
- **Address-only reads.** `SchedulerActionObservation.reads` / `.shallowReads` are `IMemorySpaceAddress[]` (`{space,id,scope,path}`) with no per-read seq — `packages/runner/src/scheduler/persistent-observation.ts` (`SchedulerActionObservation`, ~L34-35). A single whole-observation `observedAtSeq` field exists (~L62) but is **zeroed** in the stored payload: `encodeSchedulerDependencySnapshot` writes `observedAtSeq: 0` — `packages/memory/v2/engine.ts` (~L2310-2321).
- **Reload-only consumer.** v2: `rehydrateActionFromObservation` is reached only from `queueInitialActionRehydration` / `applyPreloadedInitialActionRehydration` under `subscribe({ rehydrateFromStorage })` — `packages/runner/src/scheduler/facade.ts` (~L556, ~L593, ~L617-644). main: the same shape in `packages/runner/src/scheduler.ts` (`rehydrateActionFromObservation` ~L640-663, `rehydrateActionFromStorage` ~L666). Steady-state settle never consults it: v2 `isRunnableSchedulingSeed` gates purely on `record.status` (`isInvalidOrNeverRan`) plus throttle/debounce/time gates — `packages/runner/src/scheduler/settle.ts` (~L224-241).
- **Presence-not-version decision.** Rehydrate re-runs iff `directDirtySeq` / `staleSeq` / `unknownReason` is *present*; otherwise it marks the node clean and adopts — v2 `facade.ts` (~L598-614), main `scheduler.ts` (~L646-663). Those markers are set at commit by **address overlap**: `markSchedulerReadersDirtyForWrites` dirties every reader whose read-set intersects the write addresses — `packages/memory/v2/engine.ts` (~L1900-1930). They are never compared against `observedAtSeq`, and `upsertSchedulerActionState` clears them to `NULL` on every run — `engine.ts` (~L3001-3051). It is a dirty **watermark**, not proof-of-input-version.
- **Cross-space forces recompute.** `mirrorSchedulerObservation` and `propagateSchedulerDirtyToOwnerSpaces` push dirtiness so peers **re-run** — `packages/memory/v2/server.ts` (~L2400, ~L2489).
- **Flag.** `getPersistentSchedulerStateConfig()` defaults **false** (`persistentSchedulerStateEnabled`) — `packages/memory/v2.ts` (main ~L627, v2 ~L594); enabled only by env `EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE`, which the multi-user test does not set.

## What it means
There is no dormant flag to flip that would let the group-chat's cross-runtime re-derivations be skipped. Even with the feature on, it is reload-only and dirtiness-propagating, so it does not touch the steady-state settle path where the +16% lives. Genuine cross-runtime version-skip — adopting a peer's committed result in place of recomputing — is **new** work, scoped in A6. This addendum is the evidentiary basis for A6's claim that the existing mechanism cannot do it.

## Status & open questions
Refuted, thoroughly. Two honest nuances, neither of which rescues the hypothesis:
- A reload-time "adopt the committed result instead of running" **shape** does exist (v2 `facade.ts` ~L608-614; main `scheduler.ts` ~L658-663). But its adopt condition is "was I dirtied since my last run?" — in the group-chat the reader **is** dirtied by the new message, so it re-runs anyway.
- Per-read seqs **do** exist, but on the commit **envelope** (`commit.reads.confirmed[].seq`), and the server does version-compare them — `schedulerObservationReadDropReason` — `packages/memory/v2/engine.ts` (~L3633-3690). Their sole use is to **drop a stale observation-only write** (an integrity guard on the persisted state), never to skip a computation.

## Related
- `06-cross-runtime-adoption-what-would-be-needed.md` — what genuine version-skip would actually require (this addendum is its "why the existing mechanism can't").
- `04-refuted-free-fixes.md` — sibling refutation of other candidate no-cost levers.
