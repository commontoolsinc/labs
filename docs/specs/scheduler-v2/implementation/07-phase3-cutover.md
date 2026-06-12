# Work order 07 — Phase 3: Node records, liveness, the new pass

> The structural cutover. Each sub-order is its own stacked branch/PR
> (`scheduler-v2/07-3a`, `07-3b`, …) per the 00-README stacked-PR
> protocol; the full runner suite must be green after EVERY commit (no
> long red stretches, no parallel old/new flag — see migration plan).
> Sub-orders: 3a records → 3b liveness → 3c pass+channel → 3d read-delta
> → 3f facade. PR titles:
> `refactor(runner): scheduler-v2 cutover <3x>: <title>`.

Spec sections that are binding here: §4 (node record), §5 (liveness),
§7.1–7.4+7.7 (pass), §8.3 partially (backoff slot), I1–I9. Inventory §§4–6
list every mechanism deleted here — consult the row before touching it.

## 3pre — Fixture pack (fixture-first, all BEFORE 3a)

New file `test/scheduler-v2-cutover.test.ts`. Every fixture below must
pass against CURRENT code (they pin behavior the cutover must preserve),
except where marked `[flip]` (they encode a v2-intended change and are
expected red until the noted sub-order):

1. **ifElse rewire**: condition flip switches the dependency to the other
   branch; changing the now-inactive branch's input does not run the
   consumer; changing the active one does. (Mirror the narrative in the
   old pull spec §"Settle Loop".)
2. **Parent continuation**: a `map`-style parent samples a list, creates a
   child during its run, the child writes an element the parent sampled;
   at `idle()` the parent has re-run and observes the child's value within
   the same external tick.
3. **Conditional-effect parity (run counting)**: computation C feeds
   effect E; an input change makes C re-run but produce an UNCHANGED
   output → E must NOT run. Count E's invocations across three such
   no-op-upstream changes (expected: 0 additional E runs).
4. **Value-changed propagation**: same shape, C's output changes → E runs
   exactly once per change.
5. **Cycle backoff `[flip — green after 3c.iv]`**: two computations
   writing each other's inputs plus a live effect observing one; assert:
   the pass terminates, `idle()` resolves, an unrelated
   computation+effect pair in the same scheduler still converges promptly,
   and total runs of the cycling pair within one settle window are
   ≤ PASS_RUN_BUDGET each. (Against v1 this may pass differently via the
   cycle breaker — write assertions loose enough to hold for v1's breaker
   OR v2's budget+backoff: terminate + isolation + idle. Note which path
   asserted.)
6. **Provisional-demand expiry (spec decision 4)**: parent (live) creates
   child A; later in the SAME pass creates node B that reads A's output;
   nothing else reads A. Expected: A runs (provisional demand through end
   of creating pass), B runs, and after the pass A's continued liveness
   comes only through B.
7. **Dormant stays dormant**: re-assert work order 05 fixture A here
   (cheap duplication that guards the cutover independently).

Commit: `test(runner): scheduler-v2 cutover fixture pack`

## 3a — `SchedulerNode` records (kind + creation context)

New file `src/scheduler/node-record.ts`:

```typescript
export type NodeKind = "computation" | "effect";
export type NodeStatus = "never-ran" | "clean" | "invalid";

export interface SchedulerNode {
  readonly action: Action;             // the fn; identity key
  readonly kind: NodeKind;
  parent?: SchedulerNode;              // creation context (§5.3, §7.4)
  children?: Set<SchedulerNode>;
  status: NodeStatus;                  // migrated in 3c
  invalidCauses: IMemorySpaceAddress[]; // CFC trigger reads; migrated in 3c
  liveRefs: number;                    // §5.2; maintained from 3b
  provisionalDemand: boolean;          // §5.3; maintained from 3b
  passRuns: number;                    // §7.7; used from 3c
  retries: number;                     // migrated in 3c
}

export class NodeRegistry {
  private records = new WeakMap<Action, SchedulerNode>();
  private all = new Set<SchedulerNode>(); // registered (strong, like v1 sets)
  register(action: Action, kind: NodeKind, parent?: SchedulerNode): SchedulerNode;
  remove(action: Action): SchedulerNode | undefined;
  get(action: Action): SchedulerNode | undefined;
  isEffect(action: Action): boolean;
  isComputation(action: Action): boolean;
  *nodes(kind?: NodeKind): IterableIterator<SchedulerNode>;
  size(kind: NodeKind): number;
}
```

Migration rule for this sub-order (one commit per family, suite green
each):

1. **kind**: replace `effects` / `computations` Sets and `isEffectAction`
   WeakMap everywhere. Every state bundle member typed
   `effects: ReadonlySet<Action>` becomes accessors on a shared
   `nodes: NodeRegistry` member (or narrow function members
   `isEffect/isComputation/forEachEffect` where a full registry handle is
   excessive — choose per bundle, list choices in PROGRESS.md). The
   sticky `isEffectAction` semantics ("once an effect, always an effect")
   become: `register` is called once per action; a re-register of a known
   action with a different kind is a hard error (this is stricter than v1
   on purpose — if any test trips it, STOP and report which flow
   re-registers with changed kind).
   Exit grep: `grep -rn "isEffectAction\|this.effects\b\|this.computations\b" src/` → only `node-record.ts` internals.
2. **creation context**: `actionParent` / `actionChildren` WeakMaps →
   `record.parent/children`, set inside `registerParentChildAction`
   (subscriptions.ts) which now talks to the registry. Toposort's parent
   tie-break reads `record.parent`. Graph snapshot likewise.
   Exit grep: `actionParent\|actionChildren` → gone outside node-record.

## 3b — Liveness refcounts + provisional demand

1. Extend the graph layer (`dependency-graph.ts`) with liveness
   maintenance:

   ```typescript
   // live(N) ⇔ N.kind === "effect" (registered)
   //         ∨ N.liveRefs > 0
   //         ∨ N.provisionalDemand
   //         ∨ materializers.isMaterializer(N)   // standing demand §4.3
   export function isLive(node: SchedulerNode, materializers): boolean;
   ```

   Refcount deltas, with cycle-guarded cascade:
   - edge added writer W → reader R: if `isLive(R)` then `addLiveRef(W)`;
   - edge removed: symmetric `dropLiveRef(W)`;
   - node's own liveness transition (register/unregister of an effect,
     provisional set/clear, refs 0↔1): for every writer edge into it,
     add/drop a ref on the writer (recursively via the transition rule).
   Implement `addLiveRef`/`dropLiveRef` so the cascade fires only on the
   0↔1 transition of `isLive(...)` as a whole, not of `liveRefs` alone
   (an effect's writers must not double-count when it also gains refs).
   Edge enumeration uses the existing `reverseDependencies`/`dependents`
   maps (writers of N = `reverseDependencies.get(N)`? — VERIFY the
   direction conventions by reading `dependency-graph.ts` first and
   record them at the top of the new code as a comment; v1's naming is
   easy to invert).
2. Provisional demand: in `subscribePullSchedulerAction`, the current
   block `parent && state.activePullDemandActions.has(parent)` becomes
   `parentRecord && isLive(parentRecord)` → `record.provisionalDemand = true`.
   Expiry encodes decision 4 — the LATER of first completed run and
   creating-pass end — as two clear points: (a) the pass-end sweep over a
   `provisionalThisPass: Set<SchedulerNode>` clears provisional demand
   only for nodes that have completed at least one run
   (`record.status !== "never-ran"`); (b) run-finalize clears it for a
   node whose creating pass has already ended (track the creating pass id
   on the record; a node still gated past its creating pass keeps
   provisional demand until that first run completes). Fixture 6 pins (a);
   add a small fixture for (b): a provisionally-created node behind a
   debounce gate longer than its creating pass still runs once when the
   gate opens.
3. Replace `demand.ts` consumers:
   - `isDemandedPullComputation(a)` → `record.kind === "computation" && isLive(record)`;
   - `isLiveEffect` → `record?.kind === "effect"`;
   - `isPullDemandRootEffect` → effect with empty surface
     (`writeIndex.getSchedulingWrites(a)?.length ?? 0 === 0`) — unchanged
     logic, new lookups;
   - `shouldRunFirstPullComputationInDemandContext` →
     `record.status === "never-ran" && record.provisionalDemand` (the
     continuation alias below keeps the second condition);
   - DELETE `pullDemandedFirstRunComputations`,
     `activePullDemandActions` (the pass marks the currently-running
     node's record instead — a `runningNode` slot on the settle state);
   - `pullDemandedContinuationComputations`: until 3c, alias
     `markPullDemandContinuation(a)` (write-propagation.ts) to
     `record.provisionalDemand = true`; the set itself is deleted now,
     the call site dies in 3c.
   Then delete `demand.ts` once `grep -rn "demand.ts" src/` shows no
   importers (graph-snapshot and pull-scheduling consume the replacements).
4. Gates: `scheduler-pull*.test.ts` suite, fixture pack 1/2/6/7,
   `deno bench ... test/scheduler-demand-roots.bench.ts` (record delta —
   expected to improve markedly; regression >10%: STOP).

## 3c — The pass + single channel

Read spec §7.1–7.3 and §7.7 again before starting. Four commits:

**i. Closure ordering (parity commit).** In
`buildPullIterationWorkSet`: after the existing seed+upstream collection,
add the live downstream effect closure of every dirty node (walk
`dependents`, include only live effect nodes) into the work set; toposort
as today. Run-time gates unchanged. Expected: zero behavioral change
(closure members that aren't pending/dirty are skipped at their turn by
the existing checks); full suite green; fixture 3/4 counters unchanged.
Computations intentionally stay out of this closure until 3c.ii because
v1's computation gate (`pending || dirty`) can otherwise admit them one
iteration early when an upstream member dirties them mid-iteration.

**ii. Value-gated effects; channel deletion.** The flip and the deletion
must be ONE commit:

- Seeds become: `{ node : node.status invalid-or-never-ran ∧ live ∧ eligible }`
  ∪ event-blocking dependencies ∪ debounce-flush set. `pending` as a
  concept narrows to "explicitly scheduled" (events machinery, retries)
  — fold or rename per what remains; document the final meaning in
  types.
- Migrate `staleness.dirty` + `cfcTriggerReads` into
  `record.status` / `record.invalidCauses` (status `never-ran` set at
  register; `markInvalid(record, cause)` is the single entry point, in
  the notifications module).
- Run gate at turn (replaces `isPullSettleActionStillRunnable` +
  `skipUnchangedConditionalEffect` + effect pre-clear):
  `runnable = status ∈ {invalid, never-ran} ∧ live ∧ eligible ∧ passRuns < PASS_RUN_BUDGET`.
  Status→`clean` BEFORE invoking the fn (spec §7.3.1; self-changes are
  suppressed by `sourceAction`, external ones legitimately re-invalidate).
- Expand the 3c.i downstream closure from live effects to all live nodes in
  this same commit. The invalid-at-turn run gate makes computation placement
  sound: clean computations included for ordering are skipped at turn.
- DELETE in this commit: `write-propagation.ts` and all its state/wiring
  (`recordChangedComputationWrites`, `markReadersDirtyForChangedWrites`,
  `changedWritesHistory`, `onEventCommitWrites`),
  `conditionallyScheduledEffects` + `markEffectConditionallyScheduled` +
  `conditionalEffectHasChangedInputs` + the quiescence history clearing in
  continuation, `scheduleAffectedEffects` + its trigger-trace
  `scheduledEffects` records, and the notification plan's
  `mark-dirty → scheduleAffectedEffects` arm (`applyPullTriggeredActionPlan`
  reduces to: suppress-or-markInvalid(+tick if any reader live)).
- Gates: fixture 3 is THE parity witness (effect run counts identical);
  fixtures 1/2/4 green (continuation now rides plain invalidation —
  remove the 3b provisional alias for `markPullDemandContinuation`, whose
  caller just died); convergence + ordering + events suites green;
  `test/scheduler-retries.test.ts` green (computation-closure count
  assertion stays at v1 parity);
  `test/scheduler-cfc-trigger-reads.test.ts` green (causes now live on
  the record — the consume/restore path in action-run reads
  `record.invalidCauses`).
- Verification gate from the migration plan: add a test-only assertion
  helper that every commit with semantic operations produced a
  synchronous notification before `commit()` returned, and run it within
  one representative scheduler test per storage configuration present in
  the runner tests (enumerate configurations by reading the test runtime
  helpers; list them in PROGRESS.md).

**iii. Upstream machinery deletion.** Delete `dirty-dependencies.ts`
(both collectors + trace plumbing), `SchedulerStaleness`'s `stale` set and
upstream counts (the class shrinks to nothing — fold the `dirty` remnant
away since status owns it now), `collectStack`,
`dirtyDependencyTraceContext`, the initial-seed/traversal-root asymmetry
in `pull-execution.ts`, and `deferEffectForLateMaterializerDependency`.
Replacements, in the settle module:

- Materializer promotion (spec §4.3 rule 2): during work-set
  construction, for each seed, if any dirty materializer's envelope
  overlaps the seed's reads (`materializers` index lookup — same calls
  the deleted per-effect recheck used), add it to the work set; envelope
  edges already feed the toposort.
- Event preflight upstream collection: new
  `collectInvalidUpstreamForLog(log): Set<SchedulerNode>` — walk writers
  of the log's reads (writer map + envelope index), recurse only into
  nodes whose status is invalid/never-ran, cycle-guarded; this replaces
  `collectDirtyDependenciesForLog` for `preflightQueuedEventDependencies`
  and the preflight stats hooks (keep the stats shape; repoint counters).
- Gates: events suites + `scheduler-event-preflight.bench.ts` recorded;
  `scheduler-stale-propagation.bench.ts` recorded (expected to collapse
  to ~0 — it measured machinery that no longer exists; if the bench no
  longer compiles meaningfully, rewrite it to measure `markInvalid` fanout
  and note that).

**iv. Budgets + backoff.** `PASS_RUN_BUDGET = 5` and
`MAX_ITERS = 10` in `constants.ts` (delete `MAX_ITERATIONS_PER_RUN`=100 +
`loopCounter`); on iteration-cap or budget exhaustion with runnable work
remaining: set `backoffUntil = now + min(250 * 2^k, 2000)` per affected
node (k = consecutive exhaustions, stored on the record), one wake timer
via the existing event-wake mechanism, `scheduler.non-settling` telemetry
once per episode (reuse the settling tracker). DELETE
`pull-cycle-break.ts`, `applyAdaptiveCycleDebounce` +
`planPullAdaptiveCycleDebounce` + the cycle-debounce constants, and the
effect re-dirty cycle-skip remnants. Gates: fixture 5 flips green;
convergence suite; `scheduler-timing.test.ts` /
`scheduler-throttle.test.ts` green (auto-debounce and manual gates are
untouched until phase 5).

## 3d — Read-delta application

1. `trigger-index.ts`: add
   `applyActionReadDelta(state, action, prevLog, nextLog)` computing
   per-entity added/removed paths and touching only changed entities;
   delete `replaceActionTriggerPaths`'s clear+re-add and the
   `lastTriggerReadsByState` memo (the delta makes the unchanged case a
   structural no-op). `resubscribePullSchedulerAction` becomes
   `applyRunLog(record, log)`: read delta → trigger index, dependents
   edges (with 3b liveness deltas), record.reads update. The
   subscribe-time path uses the same primitive with an empty prev.
2. Cancels: `setCancelForTriggerEntities` churn collapses — the registry
   owns one cancel per action (unsubscribe walks its entities).
3. Gates: full suite; `scheduler.bench.ts` steady-state delta recorded
   (resubscribe cost should drop or hold).

## 3f — Facade and file consolidation

1. Collapse the `create*State()` bundles: each module gets a constructor
   taking the components it needs (`registry`, `graph`, `gates`,
   `events`, …) instead of ad-hoc closures over Scheduler fields. Work
   module by module; the Scheduler class ends as: component construction,
   public API delegation, storage subscription, error/console hooks.
2. File renames (now, not earlier): `pull-execution.ts` → `settle.ts`,
   `pull-notifications.ts` + `notifications.ts` → `invalidation.ts`,
   `pull-subscriptions.ts` + `subscriptions.ts` → `registration.ts`,
   `pull-events.ts` + `events.ts` stay `events.ts`,
   `pull-scheduling.ts` folds into `settle.ts`, `action-run.ts` →
   `run.ts`, diagnostics modules under unchanged names. Update the
   imports; `git mv` so history follows.
3. Public API per spec §13: keep `subscribe` as a deprecated alias for
   `register` if external packages call it (grep
   `scheduler.subscribe(` outside packages/runner — expected: none after
   checking; if found, keep the alias and list callers).
4. Exit: `wc -l src/scheduler.ts` recorded (target < ~600);
   `grep -c "createsState\|create.*State()" src/scheduler.ts` → 0.

## Phase-end gates (reviewer)

- [ ] Fixture pack: all green, including flips, with PROGRESS.md showing
      which commit flipped each.
- [ ] Full runner suite green at EVERY commit in the series (CI history).
- [ ] Inventory §§4–6: every row marked Delete/Subsume now greps to zero
      (`staleness\|stale\b`, `changedWritesHistory`,
      `conditionallyScheduledEffects`, `pullDemanded`, `collectStack`,
      `scheduleAffectedEffects`, `cycle-break`, `MAX_ITERATIONS_PER_RUN`).
- [ ] Bench table in PROGRESS.md: scheduler, demand-roots,
      stale-propagation, event-preflight, materializer-fanout,
      persistent-state — before phase 3 vs after; no unexplained >10%
      regression; demand-roots and stale-propagation improved.
- [ ] `reload-rehydration.test.ts` green; rehydrate-miss logger counts not
      worse than baseline (run it once before 3a and record).
- [ ] `idle()` contract tests untouched and green (G8).
- [ ] CFC: trigger-read consume/restore paths verified against
      `scheduler-cfc-trigger-reads.test.ts` and the retry-restore fixture.
