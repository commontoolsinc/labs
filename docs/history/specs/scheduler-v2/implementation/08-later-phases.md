---
status: historical
created: 2026-06-11
archived: 2026-07-09
reason: "Scheduler-v2 work order for the post-cutover phases (4, 5, 7); point-in-time record of the #4288 implementation effort."
---

# Work order 08 — Phases 4, 5, 7 (post-cutover)

> Three independent follow-ups to the phase-3 cutover, in this order:
> 4 (prefetch removal) → 5 (gates) → 7 (persistence). Phase 6 (preflight
> closure cache) is bench-gated and likely skipped — see the end. These
> orders are precise about contracts and deletion sets but leave more
> line-level discretion than 01–07; the reviewer compensates with the
> exit checklists. Re-read the matching migration-plan section before
> each.

## Phase 4 — Remove the first-run prefetch

Spec §6.2; inventory §3 `populateDependencies` row. PR title:
`refactor(runner): registration without dependency prefetch (scheduler-v2 phase 4)`.

### Step 4.0 — Baselines

- Record piece-start cost: run the existing default-app/reload metric
  used for CT-1623 work (`test/reload-rehydration.test.ts` plus the
  rehydrate-miss logger counts) and `scheduler-pull-seeds.bench.ts`.
- Cold-replica fixture (fixture-first, the phase's main risk — migration
  risk register row 2): a FRESH piece whose computation reads a doc that
  is not yet locally present and arrives only after the first pass.
  Build it by constructing the runtime against the in-process server,
  writing the input doc through a second client connection AFTER
  `runner.start` returns, then asserting convergence at `idle()` without
  any manual nudges. Must pass BEFORE the change (v1 converges via the
  prefetch's sync side effects) and AFTER (v2 converges via
  arrival-as-change). If it cannot be made to pass before the change,
  STOP — the fixture design is wrong, not the system.

### Step 4.1 — Declared reads as ordering hints

`src/runner.ts` `instantiateJavaScriptActionNode`: stop building
`populateDependencies` (delete the closure at ~3510-3535 and the
`subscribe` argument). The action annotation already carries `reads`
(binding links); the scheduler uses them for never-ran ordering only:

- registration: `record.declaredReads = reads.map(toMemorySpaceAddress)`;
- toposort edge derivation for `status === "never-ran"` nodes uses
  `declaredReads` in place of `record.reads` (settle module);
- they are NEVER registered in the trigger index and never count as
  demand evidence (spec §6.2) — assert this with a fixture: a never-ran
  node whose declaredReads overlap a changing cell does not become
  invalid from that change alone.

Raw builtin nodes (`instantiateRawNode`, ~2025) get the same treatment —
locate its populate construction by grep and delete identically.

### Step 4.2 — Delete the collection machinery

Scheduler side, all in one commit once 4.1 compiles:
`dependency-collection.ts`; `pendingDependencyCollection` set +
`populateDependenciesCallbacks` WeakMap + their bundle members;
`collectInitialExecuteDependencies`, `collectPostEventDependencies`,
`collectPendingDependencyActions`, `collectPullSettlePreRunDependencies`
and their call sites in `execute()`/settle; the `PopulateDependencies`
public type from `subscribe`/`register` (the parameter slot narrows to an
optional immediate `ReactivityLog`, kept for tests that pass logs
directly — grep test usage before narrowing further). The HANDLER
preflight populate (`handler.populateDependencies`,
`addEventHandler`'s third parameter, `populateHandlerEventSchedulerReads`,
`populateDeclaredSchedulerReads`) **stays** — events still need the
read closure (spec §7.5).

Exit greps: `populateDependenciesCallbacks\|pendingDependencyCollection\|dependency-collection` → zero;
`populateDependencies` matches only the handler/event path.

### Step 4.3 — Gates

Cold-replica fixture green; under-approximated-declared-reads fixture
(from the 07 pack) still green; full suite; `scheduler-pull-seeds.bench`
and piece-start metrics recorded — registration of a dormant piece must
show no cell-data reads (add a one-off assertion using the storage read
counters if available; otherwise inspect the trigger of `validateAndTransform`
via a spy in one fixture). Record the default-app reload comparison.

## Phase 5 — One time-gate

Spec §8; inventory §9. PR title:
`refactor(runner): unified time gates (scheduler-v2 phase 5)`.

Contract (binding): `test/scheduler-throttle.test.ts` and
`test/scheduler-timing.test.ts` pass unchanged. They define
debounce/throttle/auto-debounce observable behavior.

1. New `src/scheduler/gates.ts` owning per-node
   `{ debounceMs?, noAutoDebounce?, throttleMs?, debounceReadyAt?, throttleReadyAt?, backoffUntil?, backoffStreak }`
   (absorb the 3c.iv backoff slot), with:
   `eligibleAt(node): number`, `isEligible(node, now)`,
   `onInvalidated(node, now)` (debounce arm/reset),
   `onRunCompleted(node, now)` (throttle arm; auto-debounce policy using
   the existing `actionStats` thresholds),
   `nextWake(candidates): number | undefined`.
2. ONE wake timer: merge the event-queue wake (`events.ts:38-87`), the
   debounce timers (`delays.ts`), and the computation trailing-flush
   timers into a single `scheduleWake(at)` owned by gates; pass-end
   (continuation) computes `min(eligibleAt of runnable-but-ineligible work,
   parked head notBefore)` and arms it. `idle()`'s wake-related clauses
   reference the single timer.
3. Delete `delays.ts` + `delay-control.ts` after porting:
   `computationDebounceFlushSeeds` disappears (a debounce expiry makes the
   node eligible; the wake triggers a pass; the normal seed rule picks it
   up); `hasActionRun` moves to `record.status !== "never-ran"`;
   auto-debounce eligibility rules port verbatim (effects only, not
   demand-root effects, `noDebounce` opt-out, thresholds from
   `constants.ts`).
4. Persistence note: gate config (debounce/noDebounce/throttle) keeps
   flowing into observations (`schedulerActionOptions` in run.ts) — adjust
   the accessor source only.
5. Gates: the two contract test files; `scheduler-events.test.ts` parking
   behavior; fixture 5 (backoff) re-run; timer-leak check — `dispose()`
   cancels the single wake (extend the existing dispose test if one
   exists; else add one).

## Phase 7 — Persistence alignment

Spec §9; persistent-scheduler-state.md. Coordinate with memory owners
(observation schema change). PR title:
`refactor(runner,memory): piece-level resume + slim observations (scheduler-v2 phase 7)`.

1. **Piece-level resume.** `runner.ts`: in the resume path
   (`syncCellsForRunningPattern` → `startCore({awaitSyncBeforeInitialRun})`),
   replace per-action rehydration with: (a) await the space's `synced()`
   once (the existing call site already does this), (b) ONE batched
   snapshot query per piece — extend
   `listSchedulerActionSnapshots` to accept a pieceId-without-actionId
   query returning all rows for the piece (check the current query type in
   `@commonfabric/memory/v2`; add the variant if absent), (c) register
   each node in `resume` mode applying its observation synchronously from
   the fetched batch (fingerprint check as today → install reads + gate
   config, `status = clean` or `invalid` per durable markers; miss →
   `fresh`).
2. **Delete the race apparatus**: `queueInitialActionRehydration`,
   `initialRehydrationTokens`, `canApplyInitialActionRehydration`,
   `awaitSpaceSyncedWithTimeout`, `runInitialActionRehydrationWithTimeout`,
   `DEFAULT_INITIAL_REHYDRATION_TIMEOUT_MS` shared-deadline logic,
   `deferInitialExecution` plumbing, and `awaitSync` from
   `SchedulerStorageRehydrationOptions` (the piece phase subsumes it).
   `scheduleInitialActionRun` reduces to "register fresh".
3. **Slim observation payload**: version the observation shape
   (`version: 2`), drop `currentKnownWrites`/`declaredWrites` (readers
   accept v1 rows and ignore those fields; the surface comes from the
   live annotation). Runtime fingerprint: bump to a versioned string
   (`runner:scheduler:v2`) — v1 rows become misses, costing one re-run per
   node, accepted and noted (migration risk register).
4. Gates: `scheduler-observations.test.ts` +
   `reload-rehydration.test.ts` rewritten where they encoded per-action
   timeout/token behavior (enumerate in PROGRESS.md);
   `scheduler-persistent-state.bench.ts` before/after; the I2/I7 witness
   test from the migration plan: a resume-clean piece performs zero runs
   and zero cell-data reads.
5. The `EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE` default flip is NOT part
   of this order (separate rollout decision).

## Phase 6 — Preflight closure cache (probably skip)

Bench first: `scheduler-event-preflight.bench.ts` plus a UI-flow trace.
Only if steady-state preflight is a material share of event latency,
implement the cache per spec §7.5 (off-by-default, last-dispatch log,
invalidate on handler re-registration). Otherwise record the numbers and
close the phase as skipped (spec decision 3 anticipates this).

## Final cleanup checklist (after phase 7)

- [ ] `docs/specs/pull-based-scheduler/README.md` replaced by a pointer to
      `scheduler-v2` (the v2 spec becomes the behavior reference).
- [ ] Inventory document updated: every row's disposition marked DONE with
      the commit that realized it.
- [ ] Flag end-state table in the migration plan verified against code.
- [ ] `docs/specs/persistent-scheduler-state.md` status section updated
      (piece-level resume, payload v2).
