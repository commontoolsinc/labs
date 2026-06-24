# Scheduler v1 — Mechanism Inventory and v2 Disposition

> **Status**: Companion to [`README.md`](./README.md) (the v2 spec). Snapshot
> of the implementation as of June 2026 (`packages/runner/src/scheduler.ts` +
> `packages/runner/src/scheduler/*`, ~13k lines).

This is the ground-truth map of what the current scheduler actually does,
mechanism by mechanism, with file references — and for each mechanism, what
happens to it under the v2 design (Keep / Subsume / Delete). It exists so the
redesign can be audited: every behavior either has a v2 home or an explicit
argument for why it is not needed.

Notation: **Keep** = carried over essentially unchanged. **Subsume** =
the behavior survives but as a consequence of a more general v2 rule.
**Delete** = the behavior itself is removed (not just reimplemented).

---

## 1. Structural overview

The `Scheduler` class (`scheduler.ts`, 2578 lines) holds ~60 mutable fields
and ~25 `create*State()` factories that wire subsets of those fields (plus
method closures) into helper modules under `scheduler/`. Each helper defines
its own `...State` interface; the same underlying sets (`pending`, `dirty`,
`effects`, …) appear in a dozen different bundles. Net effect: per-action
state is *implicit membership in many collections* rather than a record, and
every new fix added another collection plus another bundle.

The helper modules split into:

- mode pairs: `push-*` / `pull-*` for subscriptions, notifications, events,
  execution, continuation (the push side is dead in production);
- shared infrastructure: `trigger-index`, `scheduling-writes`,
  `dependency-graph`, `dirty-dependencies`, `staleness`, `demand`, `delays`/
  `delay-control`, `events`, `action-run`, `topology`, `write-propagation`,
  `materializers`, `persistent-observation`;
- diagnostics: `diagnosis`, `diagnostics`, `graph-snapshot`, `timing`,
  `execution` (settle stats).

v2 disposition: the facade + 9 components (§12 of the spec) replace the
field-bag/state-bundle pattern; per-node state becomes one record.

---

## 2. Action identity and classification

| Mechanism | Where | What it does | v2 |
| --- | --- | --- | --- |
| `Action = (tx) => any` + telemetry annotations stapled on the function (`pattern`, `module`, `reads`, `writes`, `materializerWriteEnvelopes`, `ignoredSchedulingWrites`, `schedulerObservationIdentity`) | `scheduler/types.ts:14`, `runner.ts:3502` | The function object *is* the key into ~20 WeakMaps/Sets | **Subsume**: `SchedulerNode` record owns all of it; the fn is one field |
| `effects` / `computations` sets + `isEffectAction` WeakMap (sticky effect identity across resubscribe) | `scheduler.ts:287-295` | Classification; stickiness papers over unsubscribe-during-run ordering | **Subsume**: `node.kind`; stickiness obsolete once unsubscribe/resubscribe around runs is gone |
| `getActionId` — `src`/name/anonymous-counter id | `scheduler/diagnostics.ts` | Diagnostic id; also feeds persistence fingerprint | **Keep** (diagnostics) + durable identity per persistence spec (`action-run.ts:668`, `impl:` hash preferred) |
| Parent/child tracking via `executingAction` + `actionParent`/`actionChildren` | `scheduler.ts:393-396`, `withExecutingAction` | Creation-context capture for ordering tie-breaks, demand inheritance, continuations, diagnostics | **Keep** (creation context) for ordering tie-break + provisional demand; continuation use deleted |

## 3. Dependency tracking

| Mechanism | Where | What it does | v2 |
| --- | --- | --- | --- |
| `dependencies: WeakMap<Action, ReactivityLog>` (reads/shallowReads/writes) | `scheduler.ts:274` | Last run's log | **Subsume**: `node.reads`; writes leave the log (output static) |
| Trigger index: per-entity recursive + non-recursive path registration; value-accurate matching (deepEqual at path, reachability transitions, shallow = same/ancestor/new-key-child) | `scheduler/trigger-index.ts`, `reactive-dependencies.ts:103-229` | Maps a concrete change to affected readers, filtering no-op writes | **Keep** — this is the core and it is correct. Becomes `graph.match()` |
| Trigger replace with memoized diff (skip clear+re-add when reads unchanged) | `trigger-index.ts:345-412` | Optimization over tear-down/re-add | **Subsume**: read-*delta* application is the primitive (P6); the memo cache disappears |
| `SchedulerWriteIndex`: `currentKnownWrites`, `historicalMightWrite` (flagged), `writersByEntity`, `actionWriteEntities`, backfill of dependents on write growth, structural-ancestor pruning, declared-write seeding, dynamic collection-item parent writes | `scheduler/scheduling-writes.ts` (347), `pull-subscriptions.ts:114-127`, `action-run.ts:579-595` | Answers "what might this action write" because write sets were *discovered* from runs | **Delete the discovery** — under static-write-surface (P4) the writer map is fixed at registration. The tiering inputs are **kept**: `collectStaticRedirectWriteTargets` (`runner.ts:2102-2135`, fixed writable inputs → extra outputs; skipped when envelopes exist, `runner.ts:3495-3501`) and declared envelopes. `schedulerHistoricalMightWrite` flag dies here (confirmed deletable 2026-06-11) |
| Reverse edges: `dependents`, `reverseDependencies`, `updateDependentEdgesForLog`, `backfillDependentsForNewWrites` | `scheduler.ts:289-290`, `scheduler/dependency-graph.ts` | Incremental node graph | **Keep** (simplified): edges derive from 1:1 outputs + read deltas; backfill-on-write-growth disappears |
| `populateDependencies` callbacks + `pendingDependencyCollection` + collection passes before events / pre-iteration / post-event (`collectInitialExecuteDependencies`, `collectPostEventDependencies`, `collectPullSettlePreRunDependencies`) | `scheduler.ts:410-419`, `scheduler/execution.ts`, `pull-execution.ts:161-183` | Discover reads before first run by **fully reading inputs under schema with `traverseCells: true`** in a throwaway tx (`dependency-collection.ts:80-106`; runner builds the callback at `runner.ts:3510-3535`: declared-read schema `get()`s, else full argument-schema traversal, plus `getRaw` of outputs as attempted writes) | **Delete** for reactive nodes — the deep prefetch is the cost the redesign removes (§6.2): `declaredReads` give ordering hints without I/O; the settle loop absorbs imprecision. Survives only as the *handler preflight* populate (per-dispatch by default; caching optional, §7.5) |
| `ignoreReadForScheduling` / `allowMutableTransactionRead` / `markReadAsAttemptedWrite` read-meta + `filterIgnoredAddresses` | `storage/reactivity-log.ts`, `scheduler/reactivity.ts` | Keep framework-internal reads/writes out of dependency evidence; keep CFC attempted-writes separate | **Keep** — log hygiene is orthogonal and correct. The prefetch's `markReadAsAttemptedWrite` *use* goes away with the prefetch |

## 4. Invalidation and propagation (the doubled channel)

| Mechanism | Where | What it does | v2 |
| --- | --- | --- | --- |
| Storage subscription; per-change processing in pull mode: skip own-commit-source, skip same-change-group, schedule effects, mark computations dirty, schedule affected effects, queue materializers | `scheduler.ts:1896-1914`, `pull-notifications.ts`, `notifications.ts:156-239` | Channel #1 (commit notifications are emitted synchronously at local apply with before/after diffs — `storage/v2.ts:1662-1683`) | **Keep as the only channel** (P1). Per-change handling shrinks to: match → self-suppress → `markInvalid` → tick |
| In-process post-run propagation: `recordChangedComputationWrites` (re-diff tx write details via `deepEqual`), `changedWritesHistory`, `markReadersDirtyForChangedWrites`, event-commit variant `onEventCommitWrites` | `scheduler/write-propagation.ts`, `action-run.ts:500-548`, `events.ts:516-519` | Channel #2: after a run/event commits, compute value-changed writes and directly schedule/dirty readers | **Delete** — duplicates channel #1, which is synchronous and value-bearing. (The duplicate also forces the self-suppression and watermark complexity below) |
| Self-suppression layer 1: `inFlightSources` WeakMap (action → its open txs), populated in `runSchedulerAction`, consulted per notification | `action-run.ts:48-76,338`, `pull-notifications.ts:100-102` | Ignore your own commit | **Subsume**: `tx.nodeId` (P5) — already exists as `debugActionId` (`action-run.ts:337`); promote to first-class, compare ids |
| Self-suppression layer 2: `changeGroup` identity between action and commit source + `changeGroupToActionId` | `notifications.ts:138-147`, `scheduler.ts:283,353`; external consumer: `cf-code-editor.ts:1644-1666` (sink subscribes with a changeGroup so its own edits are filtered) | Group-level suppression; also feeds diagnosis causal edges | **Keep** — it is a user-facing suppression feature, not scheduler plumbing. Scheduler-internal self-suppression moves to the tx-carried node reference (object identity, P5) |
| Conditional effects: `scheduleAffectedEffects` (reachability fanout from a dirty computation, value-blind), `conditionallyScheduledEffects` (effect → watermark index into `changedWritesHistory`), run-time filter `conditionalEffectHasChangedInputs` (only changed writes *after* scheduling vs effect reads), history cleared at quiescence | `pull-scheduling.ts:52-78,213-248`, `pull-execution.ts:425-442`, `continuation.ts` | Prevents effects from running when a transitively-dirty computation turned out not to change their inputs | **Delete** — same observable behavior falls out of value-gated run checks: effects are placed in the pass order via the downstream closure but run only if *their own* invalid bit is set at their turn (§7.2-7.3) |
| Staleness: `SchedulerStaleness` — `dirty` set, `stale` set, `upstreamStaleWriters`/`upstreamStaleCount` per-dependent refcounts, propagation on every dirty/clean transition | `scheduler/staleness.ts` | Incremental transitive-dirtiness so demand checks and seeds can ask "is anything upstream dirty" | **Delete** — with no speculative fanout there is no consumer for transitive staleness; the pass computes its downstream closure per iteration (cheap: bounded by work-set size, not graph size) |

## 5. Demand (pull) machinery

| Mechanism | Where | What it does | v2 |
| --- | --- | --- | --- |
| `isDemandedPullComputation` → `hasTransitiveEffectDependent` (graph walk per query) + `isLiveEffect` (effects ∪ sticky-effect-with-deps) + `hasDemandedParentContext` (parent chain walk) | `scheduler/demand.ts` | "Would running this serve a live effect?" — recomputed by traversal at every ask (seed collection, dirty-runnable checks, idle checks, graph snapshot) | **Subsume**: `liveRefs` refcount maintained on edge deltas (§5.2); O(1) query |
| `isPullDemandRootEffect` (effect with no writes) + `activePullDemandActions` (set during run) | `demand.ts:74-83`, `pull-execution.ts:330-341` | Demand-context marking so children created during the run inherit demand | **Subsume**: provisional demand (§5.3) — registration during any *live* node's run |
| `pullDemandedFirstRunComputations` | `pull-subscriptions.ts:86-96` | First-run demand for computations created under demand | **Subsume**: provisional demand |
| `pullDemandedContinuationComputations` + ancestor-chain check in write propagation | `write-propagation.ts:94-102`, `demand.ts:100` | Re-run an already-run parent when a child it created writes data the parent sampled | **Delete** — ordinary invalidation under P1 (child's commit invalidates the parent's overlapping read; parent is live; same pass re-runs it) |
| New-computation seeding: subscribe marks `directDirty` + `pending` + `scheduledFirstTime`; seeds declared writes so effects can find the new writer; `newActionsWithoutDependencies` seeds in `buildPullInitialSeeds` | `pull-subscriptions.ts:110-171`, `execution.ts` | Solves "nobody can demand a node whose writes aren't known yet" | **Delete** — static outputs make the reader edge exist at registration (§4.4 step 2); a fresh node is `never-ran` and runs iff live. `scheduledFirstTime` (filter bypass) has no filter left to bypass |

## 6. The execute/settle pipeline

| Mechanism | Where | What it does | v2 |
| --- | --- | --- | --- |
| `queueExecution` (queueTask coalescing) + `rerunAfterCurrentExecute` + continuation modules deciding whether to re-tick, arm the wake timer, resolve idle, clear histories | `scheduler.ts:955-968`, `scheduler/continuation.ts`, `pull-continuation.ts` | Tick management + quiescence bookkeeping | **Subsume**: tick + §8.4 single wake/idle rule (most continuation cases existed to service mechanisms that are deleted) |
| `execute()` phases: begin-cycle, pre-event dependency collection, event phase, post-event collection, initial seeds, settle loop, cycle break, adaptive cycle debounce, telemetry, continuation | `scheduler.ts:1418-1602` | The pipeline | **Subsume**: `pass()` (§7.1) — collection phases vanish with the prefetch; cycle modules vanish per §7.7 |
| Pull settle loop: 10 iterations; per-iteration: collect pending deps, build seeds (pending effects, runnable dirty, debounce flush seeds, event-blocking deps, new-action seeds; initial seeds runnable only on iter 0, traversal-roots afterwards), `collectDirtyDependencies` upstream walk with memo + cycle stack + writer-index fallback, toposort, run | `pull-execution.ts`, `dirty-dependencies.ts`, `execution.ts` | Work-set construction is *upstream* from demand roots over stale/dirty markers | **Subsume**: §7.2 — seeds are simply `invalid ∧ live ∧ eligible`; closure goes *downstream* for ordering; no traversal-root/iteration-0 asymmetry, no memoized recursive walk, no writer-index fallback |
| Effect pre-clear + "re-dirtied ⇒ cycle ⇒ skip" check | `pull-execution.ts:278-290,345-370` | Implicit cycle detection for effects | **Subsume**: per-node pass run budget (§7.7) |
| Late-materializer recheck before each effect (`deferEffectForLateMaterializerDependency` — full upstream collect per effect per iteration) | `pull-execution.ts:372-390` | Materializer dirtied after work set was built must run before the effect | **Subsume**: materializer promotion is part of work-set construction each iteration (§4.3 rule 2); the per-effect re-walk disappears |
| Skips: debounced computation waiting, throttled (stays dirty; effects re-marked dirty), unchanged conditional effect | `pull-execution.ts:392-442` | Run-time gating | **Subsume**: single `runnable()` re-check at turn (§7.3) |
| `topologicalSort`: dependents-graph edges (or O(n²) read/write scan fallback), materializer envelope edges, parent edges only when no opposing data edge, Kahn + cycle preference (parent-visited, then in-degree) | `scheduler/topology.ts` | Ordering | **Keep** semantics (§7.4); the non-dependents fallback scan goes away (edges always maintained) |
| `loopCounter` (≤100 selections per action per execute) + `runsThisExecute` | `scheduler.ts:426,322`, `execution.ts` | Runaway backstop + cycle-debounce input | **Subsume**: `PASS_RUN_BUDGET` (§7.7) |
| Pull cycle breaker: at iteration limit, clear early-iteration repeat-dirty computations, force-run remaining dirty effects | `scheduler/pull-cycle-break.ts` | Avoid permanently stale UI on non-convergence | **Delete** — replaced by escalating backoff gates (§7.7): same liveness goal, no forced runs/cleans |
| Cycle-aware debounce (post-settle: effects with ≥3 runs in a ≥100ms cycle get 2×cycle debounce) | `scheduler.ts:1558-1584`, `execution.ts` | Slow down hot effect loops | **Subsume**: backoff gate policy (§8.2) |

## 7. Action runs

| Mechanism | Where | What it does | v2 |
| --- | --- | --- | --- |
| `runSchedulerAction`: telemetry, await prior run, open tx (+changeGroup), stamp `debugActionId`, consume CFC trigger reads into tx, in-flight source add, harness invoke with executing-action tracking, timing/auto-debounce/has-run marking, commit-with-log-capture, observation attach, changed-write recording, resubscribe, reader dirtying, diagnostics, idempotency recheck | `scheduler/action-run.ts:305-550` | The run path | **Subsume**: §7.3 — keeps tx-per-run, optimistic commit, CFC consumption, observation attach; drops resubscribe/changed-write/reader-dirtying (channel #2) and the demand-set deletions |
| Commit-failure handling: always resubscribe + restore trigger reads. Ordinary **Conflict** (`ConflictError`) → wait for reader-dirty re-trigger; no re-queue, no budget, no exhaustion-zombie. Structured conflict exceptions for prepare-added reads and own-write conflicts → bounded re-dirty + pending + tick. Non-conflict non-permanent → ≤`MAX_RETRIES_FOR_REACTIVE` (10) re-dirty + pending + tick | `action-run.ts:104-175` | Conflict recovery via subscription (channel #2); bounded retry only for transient / path-blind `StorageTransactionInconsistent` and structured conflicts that reader-dirty cannot recover | **Keep** (§7.3 step 6), conflicts normally recovered by channel #2; budget applies to non-conflict errors and narrow structured conflict exceptions |
| `RetryImmediately` (inSpace name resolution): abort, restore trigger reads, re-dirty, budgeted | `action-run.ts:410-460`; events: `events.ts:462-490` | Sync name-resolution retry loop | **Keep** unchanged |
| Global serialization via `runningPromise` (single in-flight run) | `scheduler.ts:475-490` | One tx at a time | **Keep** (open question 5 notes possible future relaxation) |
| Error handling: normalize, report via handlers, still finalize commit/resubscribe | `action-run.ts:386-426` | Errors don't wedge the loop | **Keep** (§7.3 step 6) |
| Inline idempotency recheck mode (second synchronous run post-commit, diff writes) + diagnosis capture | `action-run.ts:716-783`, `scheduler/diagnosis.ts`; `cf test` wiring in `cli/lib/test-runner.ts` + multi-user runners, incl. the `expect-non-idempotent` assertion | The **idempotency validator** — the checked enforcement of the contract that lets computations (incl. side-writers) run any number of times; also non-settling diagnosis | **Keep** in `introspection` (P10) — explicitly load-bearing for P4/§4.2, unchanged contract |

## 8. Events

| Mechanism | Where | What it does | v2 |
| --- | --- | --- | --- |
| Global FIFO queue; per-handler match by link (silently queues one event per matching handler); auto-start piece when no handler (`ensurePieceRunning` background task, requeue once) | `events.ts:119-165` | Delivery + cold-start | **Keep**, except the multi-match fanout: registration enforces one handler per stream link (spec decision 12; multi-handler dispatch = future opt-in) |
| Preflight: populate handler deps in read-only tx (declared writable-input links when present at `runner.ts:3215-3224`, else `$event`-schema deep get `runner.ts:3226-3241`), commit-as-noop (CFC-inert), collect dirty upstream, block head event behind runnable deps (`eventBlockingDeps` join the work set), park with `notBefore` + wake when deps are time-gated | `events.ts:226-401`, `pull-events.ts` | D7 consistency gate | **Keep** contract (I4), per-dispatch populate stays the default (closure caching is an optional, measured optimization — §7.5); blocked deps become transient demand roots rather than a separate seed set |
| Dispatch: presync inputs, immediate tx, trusted-event policy inputs (CFC UI contract), optimistic commit (explicitly not awaited), retry by unshift, `onCommit` after final result | `events.ts:403-615` | Transactional dispatch | **Keep**; the dispatch-side changed-write propagation (`onEventCommitWrites`) is deleted with channel #2 |
| Event wake timer (`notBefore`, earliest-wake scheduling) | `events.ts:38-87` | Parking | **Subsume** into the single gate/wake (§8.4) |
| Handler-sent events queue at **send time**: stream `Cell.set` → `scheduler.queueEvent` immediately, ungated on the sending handler's commit. The storage layer's dependent-speculation rejection does not cover payload-only follow-ups (no read edge to the parent's writes) | `cell.ts:1161-1178` | Follow-up events from a failed-then-retried handler are queued once per attempt (duplication); a follow-up from a permanently failed attempt still dispatches | **Fix via speculation lineage** (spec §7.6 / I10): same-space — keep send-time dispatch (no latency change), follow-up commits carry a server-verified *origin committed* precondition (permanent rejection, no retry); cross-space — park the event until the origin commit is confirmed (mirrors the child-space-first write protocol), drop on failure; client lineage registry cancels undispatched descendants. Outbox staging was rejected: the flush awaits server ack (`extended-storage-transaction.ts:857-871`), which would slow trivial resend chains. Independent of the v2 cutover |
| Handler-result piece instantiation (`postRun` → `handleJavaScriptHandlerResult`): inline `run()` in the handler's tx; on-commit-error cancel+stop exists **only in the push branch**; pull branch ties stop to handler lifetime; `navigateTo` results use commit-gated `startAfterSuccessfulCommit`; cross-space children use the child-space-commit-first protocol (`enableCrossSpaceChildCommit`, first failure aborts, second failure's durable orphan accepted) | `runner.ts:2604-2739`, cleanup at `2724-2729` (push) vs `2735` (pull), gated start at `1449-1470`, cross-space at `2677-2681` | Data rolls back atomically; scheduler registrations don't; convergence relies on retry + cause-derived ids; exhausted retries leak a running piece | **Fix** (spec §7.6): compensating cancel+stop on final rejection in the pull path, keyed off the same lineage registry as sent events; keep inline start; keep gated start for `navigateTo`. Independent of the v2 cutover |
| Exactly-once event handling: **absent**. A re-delivered event (cross-runtime, ingress retry, restart) is handled again wherever it lands; nothing dedups. Handler-result cells already exist per invocation but their cause is *random* (`{ ...inputs, $event: crypto.randomUUID() }`, `runner.ts:2995-2998`) | `runner.ts:2995-2998` | CFC requires certain event classes to be handled at most once system-wide | **Add receipts = the result cell** (spec §7.6 / I11): swap the random UUID in the handler cause for the durable event id, making the result cell (and all handler-frame-minted ids) event-causal; all events create it unconditionally under a create-only precondition (default-on; class layering deferred); receipt-exists = permanent rejection = lost race, no retry. Single handler per event; shares identity/precondition/rejection machinery with lineage |

## 9. Delays and adaptive policies

| Mechanism | Where | What it does | v2 |
| --- | --- | --- | --- |
| Manual debounce (timers per action; schedule-with-debounce path), computation trailing-flush (`computationDebounceFlushSeeds`, ready-time, flush seeds into pending), throttle (`lastRunTimestamp + ms`, stays dirty, effects re-dirtied), auto-debounce (effects >50ms avg after 3 runs, opt-outs, never demand roots/computations), `getNextEligibleRunTime` | `scheduler/delays.ts` (314), `delay-control.ts` (99) | Three timer/queue systems + policy | **Subsume**: one gate (§8); auto-debounce stays as policy; the trailing-flush seed set becomes "debounce gate expired ⇒ eligible again" with the normal wake |
| `dispose()` cancelling debounce timers, queue task, event wake, diagnosis timeout | `scheduler.ts:1385-1401` | Teardown | **Keep** (fewer timers to cancel) |

## 10. Persistence and rehydration

| Mechanism | Where | What it does | v2 |
| --- | --- | --- | --- |
| Flag: `EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE` env → `Runtime.experimental.persistentSchedulerState` → module-global in memory/v2 (`getPersistentSchedulerStateConfig`) | `memory/v2.ts:541-574`, `runtime.ts:24-26`, `shell/src/lib/env.ts:20` | Gates observation attach + rehydration + wire-protocol handshake | **Keep** during rollout; v2 is designed persistence-first so the long-term default is on |
| Observation build/attach on every run commit (reads, shallowReads, writes, currentKnownWrites, declaredWrites, envelopes, options, status, fingerprints), skip on aborted/complete tx | `action-run.ts:552-656`, `persistent-observation.ts` | Durable per-action snapshot | **Keep**, payload slimmed (§9.3: write-set fields dropped) |
| Identity + fingerprints: observation identity (ownerSpace/branch/pieceId/processGeneration) annotated at subscribe; `impl:` hash > `src:` > derived; runtime fingerprint includes pull/push mode | `scheduler.ts:728-740`, `action-run.ts:668-692`, `runner.ts:1737-1753` | Match observations to recreated actions | **Keep**; mode component removed, fingerprint versioned |
| Subscribe-time rehydration: defer initial execution, background task with shared sync+lookup deadline (10s), `awaitSpaceSyncedWithTimeout`, per-action tokens + `canApply` guards (superseded/already-dirty checks), fallback `scheduleInitialActionRun` (which re-enters the prefetch/dirty/pending/first-time/affected-effects path) | `scheduler.ts:521-904` | Resume without re-running | **Subsume**: piece-level resume phase (§9.2) — sync once per piece *before* registering; per-node race guards become unnecessary; fallback = fresh registration |
| Restore: resubscribe from observation (reads/shallowReads/currentKnownWrites), register envelopes, gate options; durable dirty markers (`directDirtySeq`/`staleSeq`/`unknownReason`/failed) ⇒ dirty+pending+tick; else force-clean | `scheduler.ts:604-657` | Apply observation | **Keep** logic, smaller payload, `status` instead of set memberships |
| Runner start modes: `rehydrateSchedulerFromStorage: !wasStoppedLocally`, `awaitSyncBeforeInitialRun: true` for resumed-from-storage (`syncCellsForRunningPattern` first) | `runner.ts:1384-1430` | Fresh vs resume decision | **Keep** as the explicit `fresh`/`resume` start mode (§9.2) |

## 11. Diagnostics and introspection

All **Keep**, relocated behind the `introspection` component (P10): graph
snapshot (`graph-snapshot.ts` — node statuses, edges, timing, gate state),
settle stats (`execution.ts`, bounded history), action-run trace, trigger
trace (`notifications.ts` decision records — decision vocabulary shrinks with
the deleted mechanisms), filter stats, breakpoints, non-settling tracker +
auto-diagnosis (`execution.ts`, `diagnosis.ts`), idempotency check mode,
causal-edge capture (loses the changeGroup dependency; uses `tx.nodeId`),
telemetry markers (`scheduler.run`, `.invocation`, `.subscribe`,
`.dependencies.update`, `.event.commit`, `.event.preflight`,
`.non-settling`; `.mode.change` dies with push mode).

## 12. Mode plumbing (push removal — phase 0)

Dead once push mode is removed, independent of the rest of v2:

- `push-execution.ts` (179), `push-notifications.ts` (142),
  `push-subscriptions.ts` (190), `push-events.ts` (36),
  `push-continuation.ts` (28).
- `pullMode` field (`scheduler.ts:301`), `enablePullMode` (1031) including
  its dependents-rebuild loop, `disablePullMode` (1059),
  `isPullModeEnabled` (1073).
- Mode branches: subscribe/resubscribe (546/587), settle dispatch (1534),
  continuation (1551), notification dispatch (1906), initial seeds (1518),
  idle (939), `modeLabel()` in action-run, `applyAdaptiveCycleDebounce`
  guard, `getNextDebounceRunTime`/`isDebouncedComputationWaiting`/
  `scheduleComputationDebounce` pull-guards, `markReadersDirtyForChangedWrites`
  / `recordChangedComputationWrites` pull-guards, `backfillDependentsForNewWrites`
  pull-guard.
- `schedulerRuntimeFingerprint(mode)` (`action-run.ts:690`) — persisted
  observations embed `runner:scheduler:pull`; keep emitting the same string
  (or version it) so existing rows don't all miss.
- Tests toggling modes: `scheduler-pull.test.ts` (uses
  enable/disablePullMode), any `disablePullMode()` baselines.
- Docs: `pull-based-scheduler/README.md` push-mode sections.

## 13. Known spec-vs-code drift in v1 docs (for the record)

`docs/specs/pull-based-scheduler/README.md` is largely accurate but:

- presents push mode as a supported "compatibility path" with public mode
  APIs — in practice nothing in production toggles it; only tests do;
- describes dependency collection as happening "in `execute()` before
  building the work set" — collection also happens at event preflight and
  inside settle iterations (`collectPullSettlePreRunDependencies`), and
  rehydration bypasses it entirely;
- the Key Data Structures sketch omits roughly half of the real state
  (conditional effects, changed-writes history, demand sets, flush seeds,
  rehydration tokens, cfc trigger reads, …) — symptomatic of the drift the
  v2 single-record design is meant to end;
- `persistent-scheduler-state.md` "Status" section predates several landed
  pieces (subscription-time rehydration with awaitSync, no-op observation
  commits) that are in fact implemented.
