# Scheduler v2 — Migration Plan

> **Status**: Proposal, companion to [`README.md`](./README.md) and
> [`current-system-inventory.md`](./current-system-inventory.md).

Sequencing principle: each phase lands independently, keeps the full test
suite green, and shrinks the v1 surface the next phase has to reason about.
Phases 0–2 and phase E are mechanical/verifiable correctness or deletion
work, worth doing even if v2 stalled afterwards (phase E in particular fixes
live bugs against the current scheduler). Phase 3 is the structural cutover;
it is built as the new component set and flipped in one short-lived branch
series — **no long-lived runtime flag** for old-vs-new scheduler (we just
removed one mode flag; we should not mint another).

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

## Phase 1 — Static write surface (P4 prerequisite)

Confirmed (2026-06-11): the pattern builder already produces exactly one
output redirect per node — the transformer cannot bind to multiple outputs.
**No corpus audit and no new builder/transformer enforcement is needed.**
What this phase does is stop *discovering* write sets from runs and freeze
the surface at registration:

1. Compute the write surface at node instantiation, as today's inputs
   already allow: primary result cell + `collectStaticRedirectWriteTargets`
   (fixed writable inputs; skipped when envelopes exist, per the existing
   tiering at `runner.ts:3495-3501`) + declared materializer envelopes.
   Pass it in the registration; nothing about it updates from run logs.
2. Collapse `SchedulerWriteIndex` to: static `outputsByNode` /
   `nodesByOutputEntity` + the materializer envelope index. Delete
   current-known/historical write tracking, declared-write seeding,
   dependents backfill on write growth, structural-ancestor pruning.
3. Remove the `schedulerHistoricalMightWrite` experimental option, the
   legacy `getMightWrite` mode, and historical write storage (deletion
   confirmed; keep `getMightWrite` as a thin "return outputs" shim only if
   a caller remains).
4. Belt-and-braces: a dev-mode assertion that a run's actual writes fall
   inside the registered surface (primary + static targets + envelopes),
   surfacing any side-writer the transformer's capability analysis missed —
   this is diagnostics for declaration gaps, not enforcement of a new rule.

Exit: writer lookup is a static map access; observation payload no longer
needs write sets (coordinate the payload change with phase 7 or ship
dual-write).

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

## Phase E (independent) — commit-gate event-launched work

Correctness fixes for spec §7.6 / invariant I10. Independent of the v2
cutover: both land against the current scheduler and should not wait for it.

1. **Sent events → post-commit outbox.** Stream `Cell.set` stages the event
   send in the transaction's idempotency-keyed post-commit outbox
   (`extended-storage-transaction.ts`) instead of calling
   `scheduler.queueEvent` at send time (`cell.ts:1167`); the flush on
   commit success enqueues it. Internal callers that need send-time
   semantics (if any — audit UI bridge / framework senders) keep an
   explicit immediate path.
2. **Handler-result pieces: compensating stop.** In
   `handleJavaScriptHandlerResult`'s pull path, register a commit callback
   that on final rejection cancels the child registrations and stops the
   result piece — restoring for pull mode the cleanup the push branch had
   (`runner.ts:2724-2729` vs `2735`). `navigateTo` results keep the
   commit-gated `startAfterSuccessfulCommit` path.
3. Fixtures (red first, per repo practice):
   - handler whose commit conflicts then succeeds on retry: follow-up event
     dispatches exactly once, with payload from the committed run;
   - handler whose commit exhausts retries: follow-up event never
     dispatches; result piece is stopped and unregistered;
   - interleaving snapshot tests for the send-time → commit-time enqueue
     shift (spec open question 2) before flipping.

Exit: I10 holds for handler-sent events and handler-started pieces.

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
   work-set construction), and the cycle breaker (replaced by §7.7 budgets +
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
2. Re-express auto-debounce and the §7.7 backoff as policies writing gate
   fields; delete computation trailing-flush seeds (`scheduler-throttle` /
   `scheduler-timing` tests define the observable contract and must pass).
3. Event parking uses the same wake (head event `notBefore` = min
   `eligibleAt` of blocking deps).

## Phase 6 — Event preflight closure cache (optional, measured)

Decision (2026-06-11): default stays populate-per-dispatch; caching is an
off-by-default optimization adopted only if measurement justifies it.

1. Bench first: quantify steady-state preflight cost on realistic handlers
   (`scheduler-event-preflight.bench.ts` + a UI-flow trace). If it is not a
   material share of event latency, skip this phase entirely.
2. If adopted: cache the handler read closure from the last dispatch log,
   invalidate on handler re-registration, keep populate-per-dispatch as the
   correctness fallback and as the default until the cache has soak time.

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
| A side-writer the transformer's capability analysis missed (write outside the registered surface) | 1 | Dev-mode actual-writes-within-surface assertion (phase 1.4) surfaces declaration gaps; idempotency validator covers the contract side |
| Send-time → commit-time enqueue shift reorders handler-sent events relative to independent arrivals | E | Interleaving snapshot fixtures before the flip; commit-time order is the causally honest one (spec §15 open question 2) |
| Audit gap: internal senders relying on send-time queueing (UI bridge, framework code) | E | Call-site audit of `queueEvent`; explicit immediate path for non-handler senders |
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
