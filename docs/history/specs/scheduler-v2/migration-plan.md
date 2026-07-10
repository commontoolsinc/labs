---
status: historical
created: 2026-06-11
archived: 2026-07-09
reason: "Executed migration plan for the scheduler-v2 cutover (#4288); the shipped spec is docs/specs/scheduler-v2/README.md."
---

# Scheduler v2 — Migration Plan

> **Status**: Proposal, companion to [`README.md`](../../../specs/scheduler-v2/README.md) and
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

## Phase 2 — Tx-carried identity (self-suppression)

Deliberately narrow. The in-process channel CANNOT be deleted here: the
conditional-effect filter depends on `changedWritesHistory`, which that
channel records; removing the filter before phase 3's invalid-at-turn
run-gate exists would regress effect-run counts. Channel deletion happens
inside the phase 3 cutover, where its replacement lands atomically.

1. Make the originating action a first-class transaction attribute:
   `sourceAction?: Action` stamped on the inner `IStorageTransaction`
   (alongside today's informal `debugActionId`, `action-run.ts:337`), set
   for action runs *and* event dispatches. Comparison is **object
   identity** — never the diagnostic action id, which can collide across
   instances (e.g. `pull:${uri}`).
2. Switch self-suppression in notification handling to
   `notification.source?.sourceAction === action`; delete `inFlightSources`
   (the WeakMap, add/remove lifecycle, and its notification check).
3. **Keep the changeGroup skip unchanged.** It is a user-facing suppression
   feature (`cf-code-editor` sinks subscribe with a changeGroup to filter
   their own edits), not scheduler plumbing.
4. Verification: scheduler suite green; a focused fixture that an action
   writing its own read does not retrigger itself, and that a sibling
   action with the same diagnostic id IS still triggered.

Exit: self-suppression is one object-identity comparison; no per-action
in-flight bookkeeping.

## Phase E (independent) — lineage + receipts for event-launched work

Implements spec §7.6 (invariants I10, I11). Independent of the v2 cutover:
lands against the current scheduler and should not wait for it. Has a
memory-engine component — coordinate with the memory owners from the start.

**E0 — shared infrastructure.**

1. Durable event identity minted at send: origin tx id (or ingress id) +
   stream link + per-origin sequence; carried on `QueuedEvent` and into the
   handling transaction.
2. Rejection taxonomy: split commit rejections into *retryable* (optimistic
   conflict — retry as today) and *permanent* (precondition failed — drop,
   never retry), surfaced distinctly to the scheduler's retry paths
   (`events.ts` unshift-retry must not fire on permanent rejections).

**E1 — speculation lineage (I10).**

1. Stream `Cell.set` keeps queueing at send time (`cell.ts:1167` —
   unchanged latency); the queued event records its origin tx id.
2. Same-space origins: handling transactions carry an *origin-committed*
   precondition verified by the memory engine (same-session commits are
   processed in order, so the origin's fate is known — the check is free).
   Cross-space origins: the event **parks until the origin commit is
   confirmed** (spec resolved decision 11; same head-parking mechanism as
   time-gated dependencies, latency mirrors the accepted cross-space write
   protocol), then dispatches normally; dropped on origin failure. No
   cross-space server verification.
3. Client lineage registry: origin tx → {queued events, started pieces}.
   On locally-known origin failure: cancel undispatched descendant events,
   cancel+stop descendant pieces (`handleJavaScriptHandlerResult` pull
   path — restoring the cleanup the push branch had, `runner.ts:2724-2729`
   vs `2735`). `navigateTo` keeps `startAfterSuccessfulCommit`.
4. Leave a watch-this comment at the retry-exhaustion sites
   (`watchReactiveActionCommit`, `rescheduleActionForImmediateRetry`) for
   the accepted zombie-piece case (spec resolved decision 9).

**E2 — receipts = result cells (I11).**

1. Make the handler-result cause event-causal: replace the random
   per-invocation `$event: crypto.randomUUID()` (`runner.ts:2995-2998`)
   with the E0 event id, threaded from `QueuedEvent` into the handler
   frame. All handler-frame-minted ids become deterministic per event:
   retries reuse ids (aborted attempts never committed), per-gesture
   uniqueness is preserved (event ids are unique per send). Verify no
   fixture relies on per-attempt-unique ids.
2. Memory engine: create-only precondition on the handling's result cell
   (default-on for all events, decision 14; gated only by the
   transitional `commitPreconditions` protocol flag), with a distinct
   permanent rejection (receipt-exists).
3. Runner: every handling materializes the result cell unconditionally
   (default-on for all events — it is the `{ resultFor: cause }` cell a
   pattern-launching handler already creates; no new document kind and no
   class machinery); on receipt-exists rejection the client drops the
   event (lost race — no retry) and emits telemetry.
4. Single-handler enforcement: replace `queueSchedulerEvent`'s silent
   one-event-per-matching-handler fanout with one handler per stream link
   at registration (dev-mode error on concurrent duplicates; audit
   existing registrations first). Multi-handler dispatch = future opt-in
   feature (handler id would join the result-cell derivation).
5. Future layering deferred (spec open question 2): per-class refinements,
   receipt retention/GC, and CFC exactly-once scope alignment land later;
   E2 ships with no class surface at all.

**Fixtures (red first, per repo practice):**

- payload-only follow-up from a failed parent commit (escapes today's
  read-dependency rejection): never handled durably;
- handler conflicts then succeeds on retry: follow-up handled exactly once,
  payload from the committed attempt;
- handler exhausts retries: follow-up never handled; result piece stopped
  and unregistered;
- receipt race (multi-runtime, same event id — use the multi-user `cf test`
  harness): exactly one runtime's handler commits; the loser does not
  retry;
- receipt + retryable conflict on another doc: handler retries and commits;
  its own receipt never blocks it;
- cross-space follow-up: parks until origin confirmation, dispatches after;
  dropped (never dispatched) when the origin fails;
- pattern-launching event redelivered to a second runtime: the result-cell
  create collides; exactly one piece exists; the loser does not retry.

Exit: I10 holds for handler-sent events and handler-started pieces; I11
holds for receipt-enabled classes.

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
   backoff). **The in-process propagation channel and the conditional-effect
   machinery are deleted here** (moved from phase 2): `write-propagation.ts`,
   `changedWritesHistory`, `conditionallyScheduledEffects` and its run-time
   filter — in the same change-series that lands the invalid-at-turn
   run-gate, with filter parity fixtures (effects skipped-as-unchanged under
   the old filter must still not run) and the synchronous-notification
   assertion across storage providers as gates.
4. Read-delta application replaces resubscribe/unsubscribe-around-runs
   (`pull-subscriptions.ts` resubscribe path, trigger replace memo).
5. Port the run path (`action-run.ts`) minus the deleted steps; keep CFC
   trigger-read consume/restore, retries, observation attach.
6. Test strategy:
   - the existing behavioral suite is the contract — it must pass unchanged
     except where it asserts v1 *internals* (set memberships, filter stats
     wording); rewrite those against the introspection surface;
   - new fixtures: provisional-demand expiry (spec resolved decision 4),
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
| Parked cross-space follow-up head-blocks the single global lane for a confirmation round trip | E | Accepted (same slowness class as the cross-space write protocol); the agreed per-space lane split confines it when it bites (spec open question 1) |
| Permanent-vs-retryable rejection taxonomy leaks wrong behavior (a permanent rejection retried, or a conflict dropped) | E | Taxonomy lands first (E0) with focused tests on both retry paths (`events.ts` unshift, `action-run.ts` watch) before lineage/receipts build on it |
| Default-on receipts add one create per handling; high-frequency programmatic event streams could bite | E | Measure commit volume after E2; per-class layering and retention/GC (spec open question 2) are the escape hatch |
| Single-handler enforcement breaks a stream silently relying on multi-match fanout | E | Registration audit before enforcement; dev-mode error first, prod telemetry; multi-handler returns later as an explicit opt-in feature |
| Event-causal handler-frame ids change id derivation for documents created in handlers | E | Uniqueness per gesture is preserved (event ids unique per send); fixture sweep over handler-heavy patterns before the cause swap |
| Conditional-effect parity (effects running more often than v1's watermark filter allowed) | 2–3 | Run-count parity fixtures on the v1 conditional-effect tests; the §7.2 closure-ordering must land with the watermark deletion, not after |
| Persisted observation misses after fingerprint change | 0, 7 | Versioned fingerprints; a miss only costs one re-run per node |
| changeGroup external consumers (runtime client, toolshed diagnostics) | 2 | Grep + keep as inert diagnostic label until consumers migrate |
| Non-converging patterns that v1's cycle breaker kept visibly fresh now lag behind backoff gates | 3 | Backoff caps (e.g. ≤2s) keep worst-case staleness bounded; non-settling telemetry unchanged; pattern-side fix remains the real remedy |
| Behavioral drift in `idle()` (tests and `cf` CLI lean on it heavily) | 3, 5 | Treat `idle()` semantics (§8.4) as frozen contract; port its tests first |

## Flag end-state

Verified against code on 2026-06-12 after phase 7:

- `rg -n "setPullMode|enablePullMode|disablePullMode|isPullModeEnabled|schedulerHistoricalMightWrite|historicalMightWrite" --glob '!docs/**' .`
  returns no matches.
- `pullMode` remains only as the frozen scheduler graph-snapshot diagnostic
  field (`pullMode: true`) and one ignored bench-helper compatibility
  parameter.
- `EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE` /
  `experimental.persistentSchedulerState` remains present in shell/toolshed
  env plumbing, runner runtime options, memory-v2 handshake/config, and tests.
- No old-vs-new scheduler selector flag was introduced; the cutover was the
  branch series plus test gates.

| Flag / API | Disposition |
| --- | --- |
| `pullMode` + `enablePullMode`/`disablePullMode`/`isPullModeEnabled` | Mode-control API removed (phase 0); frozen graph-snapshot `pullMode: true` diagnostic retained for compatibility |
| `experimental.schedulerHistoricalMightWrite` | Removed (phase 1) |
| `EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE` / `experimental.persistentSchedulerState` | Kept through v2; default-on is a separate rollout (phase 7.4) |
| New old-vs-new scheduler flag | **Not introduced** — cutover happened on a branch series with the test suite as the gate |
