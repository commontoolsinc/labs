# Scheduler v2 — Migration Plan

> **Status**: Proposal, companion to [`README.md`](./README.md) and
> [`current-system-inventory.md`](./current-system-inventory.md).

Sequencing principle: each phase lands independently, keeps the full test
suite green, and shrinks the v1 surface the next phase has to reason about.
Phases 0–2 are mechanical/verifiable and worth doing even if v2 stalled
afterwards. Phase 3 is the structural cutover; it is built as the new
component set and flipped in one short-lived branch series — **no long-lived
runtime flag** for old-vs-new scheduler (we just removed one mode flag; we
should not mint another).

---

## Phase 0 — Remove push mode

Pure deletion; no behavior change in production (pull has been the default
and only production mode).

1. Delete `push-execution.ts`, `push-notifications.ts`,
   `push-subscriptions.ts`, `push-events.ts`, `push-continuation.ts`.
2. Remove `pullMode` field, `enablePullMode` / `disablePullMode` /
   `isPullModeEnabled`, and every mode branch (inventory §12 lists all
   sites). Inline the pull side.
3. `schedulerRuntimeFingerprint`: keep emitting `runner:scheduler:pull` (or
   bump to a versioned string and accept that pre-existing observations
   miss once — decide with the memory owners; misses are safe, just a
   one-time re-run).
4. Tests: rewrite the few push-baseline assertions (`scheduler-pull.test.ts`
   toggles modes to compare); delete mode-toggle tests.
5. Docs: update `pull-based-scheduler/README.md` mode-control section (or
   fold the doc into scheduler-v2 once phase 3 lands).
6. Telemetry: retire `scheduler.mode.change`.

Exit: no `push` identifier under `packages/runner/src/scheduler/`; suite
green.

## Phase 1 — Enforce single output (P4 prerequisite)

The direction is already set (#3911 gave each internal its own cell; output
bindings in practice carry a single write redirect). Make it a guarantee:

1. Corpus audit: scan `packages/patterns` + integration fixtures for any
   node whose output binding resolves to >1 write-redirect target
   (`findAllWriteRedirectCells(outputs, …).length > 1`). Expect zero; fix or
   consciously migrate any stragglers.
2. Runner: assert single resolved redirect target at node instantiation
   (dev-mode hard error, prod-mode telemetry + first-target behavior during
   bake-in).
3. Transformer: reject pattern constructs that would produce multi-target
   output bindings, so the invariant is compile-time.
4. Collapse `SchedulerWriteIndex` to: static `outputByNode` /
   `nodeByOutputEntity` (1:1) + the materializer envelope index. Delete
   current-known/historical write tracking, declared-write seeding,
   dependents backfill on write growth, structural-ancestor pruning.
5. Remove the `schedulerHistoricalMightWrite` experimental option and the
   legacy mode of `getMightWrite` (verify no external diagnostic consumer
   first; keep `getMightWrite` as a thin "return [output]" shim if anything
   still calls it).

Exit: writer lookup is a map access; observation payload no longer needs
write sets (coordinate the payload change with phase 7 or ship dual-write).

## Phase 2 — One change channel + tx-carried identity

1. Make the node id a first-class transaction attribute (today's
   `debugActionId` stamp at `action-run.ts:337`, formalized on
   `IExtendedStorageTransaction`), set for action runs *and* event
   dispatches.
2. Switch self-suppression in notification handling to compare
   `change.source.nodeId`; delete `inFlightSources` and the
   change-group-equality skip (keep changeGroup only as a diagnostic label,
   or delete if causal-edge capture moves to tx.nodeId directly).
3. Delete the in-process propagation channel: `write-propagation.ts`
   (`recordChangedComputationWrites`, `markReadersDirtyForChangedWrites`,
   `changedWritesHistory`, event `onEventCommitWrites`), and the
   conditional-effect machinery (`conditionallyScheduledEffects`,
   `markEffectConditionallyScheduled`, `conditionalEffectHasChangedInputs`,
   the run-time filter and the quiescence history clearing).
4. Interim semantics shim (until phase 3): notification-driven dirtying
   already exists; the only behavior previously delivered *only* by the
   in-process channel is same-pass continuation of scheduler-parent
   ancestors — verified covered because local commit notifications fire
   synchronously inside `tx.commit()` (`storage/v2.ts` `notifyOptimistic`),
   i.e. before the next action in the settle order runs. Add an explicit
   regression fixture for the `ifElse`-style and parent-continuation cases
   before deleting.
5. Verification gates for this phase:
   - assert (test-only) that every commit with semantic operations produces
     a synchronous notification before `commit()` returns its promise, for
     every storage provider configuration used in tests (in-process server,
     worker client, emulator);
   - convergence suite (`scheduler-convergence.test.ts`,
     `scheduler-pull*.test.ts`, `scheduler-ordering.test.ts`) green;
   - filter-stat parity check: effects skipped-as-unchanged under the old
     conditional filter must still not run (same fixtures, count runs).

Exit: exactly one path marks nodes dirty; self-suppression is one id
comparison.

## Phase 3 — Node records + liveness refcounts + new pass (the cutover)

Build the v2 components (`registry`, `graph`, `invalidation`, `settle`,
`gates` minimal) in `scheduler/` alongside v1, then flip module-by-module
where separable, or as one reviewed series where not:

1. Introduce `SchedulerNode` records; migrate classification, status, causes,
   parent, budgets into them. The ~25 `create*State()` bundles shrink as each
   consumer reads the record instead.
2. Replace `SchedulerStaleness` + demand walks with `liveRefs` maintenance on
   edge deltas + provisional demand. Delete
   `pullDemandedFirstRunComputations`, `pullDemandedContinuationComputations`,
   `activePullDemandActions`, `scheduledFirstTime`, `isEffectAction`.
3. Replace the settle loop with `pass()` (§7): seeds = invalid∧live∧eligible,
   downstream closure for ordering, run-gate re-check at turn. Delete
   `dirty-dependencies.ts` upstream collector, traversal-root asymmetry,
   `collectStack`, the late-materializer per-effect recheck (folded into
   work-set construction), and the cycle breaker (replaced by §7.6 budgets +
   backoff).
4. Read-delta application replaces resubscribe/unsubscribe-around-runs
   (`pull-subscriptions.ts` resubscribe path, trigger replace memo).
5. Port the run path (`action-run.ts`) minus the deleted steps; keep CFC
   trigger-read consume/restore, retries, observation attach.
6. Test strategy:
   - the existing behavioral suite is the contract — it must pass unchanged
     except where it asserts v1 *internals* (set memberships, filter stats
     wording); rewrite those against the introspection surface;
   - new fixtures: provisional-demand expiry (spec open question 4),
     parent-continuation-as-invalidation, first-run with under-approximated
     declared reads (assert ≤1 extra run and convergence), cycle backoff
     (non-converging pair stays rate-limited, `idle()` still resolves, other
     subgraphs unaffected);
   - benches before/after: `scheduler.bench.ts`,
     `scheduler-demand-roots.bench.ts`, `scheduler-stale-propagation.bench.ts`
     (this one should improve dramatically or become trivial),
     `scheduler-event-preflight.bench.ts`,
     `scheduler-materializer-fanout.bench.ts`, plus the CT-1623 reload
     re-run counts (the historical regression metric for this subsystem).

Exit: `scheduler.ts` is a facade over the component set; the inventory's
"Delete/Subsume" column is fully realized for §§4–6.

## Phase 4 — Remove the first-run prefetch

Depends on phases 1–3.

1. Stop generating reactive-node `populateDependencies` in the runner
   (`runner.ts:3510-3535`); pass `declaredReads` (the already-computed
   `reads` binding links) in the `NodeSpec` instead.
2. Delete the scheduler-side collection passes
   (`collectInitialExecuteDependencies`, `collectPostEventDependencies`,
   `collectPullSettlePreRunDependencies`, `pendingDependencyCollection`,
   `dependency-collection.ts`).
3. Keep the handler-preflight populate (it moves to `events`).
4. Risk to manage: the prefetch's deep `get()` doubled as a replica warmer —
   it kicked loads of link-target docs before first run. v2 relies on
   (a) piece-level `resume` sync (§9.2) for resumed pieces, (b) fresh pieces
   having their data locally by construction, and (c) the invariant that a
   doc arriving later surfaces as a change and re-runs the reader (the
   #3886 awaitSync lesson). Add an integration fixture: cold-replica fresh
   start where a computation's input doc arrives only after its first run;
   assert convergence without manual nudges.
5. Measure piece-start cost on a large space (the original complaint):
   expect registration to be index-inserts only; compare against v1 numbers
   for the default app.

## Phase 5 — Unify time gates

1. Fold `delays.ts` + `delay-control.ts` + the event wake timer into
   `gates`: per-node `debounceReadyAt` / `throttleReadyAt` / `backoffUntil`,
   one wake timer, `eligibleAt()`.
2. Re-express auto-debounce and the §7.6 backoff as policies writing gate
   fields; delete computation trailing-flush seeds (`scheduler-throttle` /
   `scheduler-timing` tests define the observable contract and must pass).
3. Event parking uses the same wake (head event `notBefore` = min
   `eligibleAt` of blocking deps).

## Phase 6 — Event preflight closure cache

1. Cache the handler read closure from the last dispatch log; invalidate on
   handler re-registration; opt-in strict mode (populate-every-time) flag in
   the handler registration for spec open question 3.
2. Bench `scheduler-event-preflight.bench.ts` before/after; the deep walk
   should disappear from steady-state event latency.

## Phase 7 — Persistence alignment

Coordinate with memory-layer owners (observation rows live in memory v2):

1. Slim the observation payload (§9.3): drop `currentKnownWrites` /
   `declaredWrites`; version the observation shape; readers accept both
   during transition.
2. Move resume to the piece-level phase: runner awaits space sync once, then
   registers nodes in `resume` mode synchronously against the fetched
   snapshot batch (one `listSchedulerActionSnapshots` query per piece rather
   than per action, if the API allows batching — extend if not). Delete the
   per-action token/timeout/canApply apparatus.
3. Re-run `scheduler-observations.test.ts`, `reload-rehydration.test.ts`,
   `scheduler-persistent-state.bench.ts`; extend with: resume-clean piece
   performs zero runs and zero cell-data reads (I2/I7 witness).
4. Separately decide the default-on flip of
   `EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE` (own rollout, not gated on v2).

---

## Risk register

| Risk | Phase | Mitigation |
| --- | --- | --- |
| A storage configuration delivers commit notifications asynchronously, so same-pass convergence regresses (still correct, more ticks) | 2 | Test-only synchronicity assertion across providers; accept extra ticks as degraded-but-correct; document the provider requirement in storage interface docs |
| Hidden dependence on prefetch as replica warmer (cold-start empty reads) | 4 | Fixture in 4.4; awaitSync piece gate; arrival-as-change invariant test |
| Multi-target output bindings exist in the wild | 1 | Corpus audit before enforcement; staged assert (telemetry → error) |
| Conditional-effect parity (effects running more often than v1's watermark filter allowed) | 2–3 | Run-count parity fixtures on the v1 conditional-effect tests; the §7.2 closure-ordering must land with the watermark deletion, not after |
| Persisted observation misses after fingerprint change | 0, 7 | Versioned fingerprints; a miss only costs one re-run per node |
| changeGroup external consumers (runtime client, toolshed diagnostics) | 2 | Grep + keep as inert diagnostic label until consumers migrate |
| Non-converging patterns that v1's cycle breaker kept visibly fresh now lag behind backoff gates | 3 | Backoff caps (e.g. ≤2s) keep worst-case staleness bounded; non-settling telemetry unchanged; pattern-side fix remains the real remedy |
| Behavioral drift in `idle()` (tests and `cf` CLI lean on it heavily) | 3, 5 | Treat `idle()` semantics (§8.4) as frozen contract; port its tests first |

## Flag end-state

| Flag / API | Disposition |
| --- | --- |
| `pullMode` + `enablePullMode`/`disablePullMode`/`isPullModeEnabled` | Removed (phase 0) |
| `experimental.schedulerHistoricalMightWrite` | Removed (phase 1) |
| `EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE` / `experimental.persistentSchedulerState` | Kept through v2; default-on is a separate rollout (phase 7.4) |
| New old-vs-new scheduler flag | **Not introduced** — cutover happens on a branch series with the test suite as the gate |
