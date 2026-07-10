---
status: historical
created: 2026-06-11
archived: 2026-07-09
reason: "Executed scheduler-v2 work order (Phase 1: static write surface); shipped in the #4288 cutover."
---

# Work order 05 — Phase 1: Static write surface

> Freezes each action's write surface at registration (spec P4) and deletes
> write-set discovery. Independent of work orders 02–04. PR title:
> `refactor(runner): static write surface; remove write-set discovery (scheduler-v2 phase 1)`.

Spec: P4, §4.3, resolved decisions 1 and 6. Inventory §3 rows
`SchedulerWriteIndex` and `populateDependencies` (the latter is phase 4,
NOT this phase — the prefetch stays for now).

The surface, per action, is what the runner ALREADY annotates today
(`runner.ts:3498-3501`): declared `writes` ∪ `staticRedirectWriteTargets`
(skipped when materializer envelopes exist). This phase makes the
scheduler trust it instead of re-learning writes from every run.

## Step 0 — Baseline

Run and record in PROGRESS.md (before/after comparison at phase end):

```bash
cd packages/runner
deno bench --allow-read --allow-write --allow-net --allow-ffi --allow-env \
  --no-check test/scheduler.bench.ts test/scheduler-demand-roots.bench.ts \
  test/scheduler-stale-propagation.bench.ts
```

Commit: none (record only).

## Step 1 — Pin the demand semantics with a fixture (fixture-first)

New file: `test/scheduler-static-writes.test.ts`.

Fixture A — dormant computation: subscribe (via the public scheduler API,
mirroring how `scheduler-pull.test.ts` builds computations) a computation
with declared `writes` to cell X, where NOTHING reads X. Drive an input
change. Assert after `idle()`: the computation never ran.

Fixture B — demand arrival: same setup, then `sink()` on X. Assert the
computation runs and X holds the computed value.

Run them against CURRENT code first. Record the outcome in PROGRESS.md:

- If both already pass: they pin existing behavior; proceed.
- If A fails today (the computation runs once because v1 seeds
  unknown-write actions): this phase makes A pass — that is the intended,
  spec'd change (I2: registration does not imply a run). Keep A asserting
  dormancy; mark it `// behavior change vs v1: spec scheduler-v2 I2` and
  continue; the red→green flip happens in step 3.

Commit: `test(runner): pin static-surface demand semantics (scheduler-v2 phase 1)`

## Step 2 — Surface registration at subscribe

File: `src/scheduler/pull-subscriptions.ts`.

The conditional declared-write seeding block (~lines 110-127,
`if (!actionIsEffect && !immediateLog) { const declaredWrites = ... }`)
becomes the unconditional surface registration:

```typescript
// Shown inside a pattern body.
// Static write surface (spec scheduler-v2 P4): the action's writes are
// fixed at registration — declared outputs plus statically resolved
// redirect targets, already computed by the runner, or a registration-time
// ReactivityLog supplied by direct scheduler callers. Nothing about the
// surface is learned from runs.
const annotatedSurface = (action as Partial<TelemetryAnnotations>).writes ?? [];
const surface = annotatedSurface.length > 0
  ? annotatedSurface.map(toMemorySpaceAddress)
  : (immediateLog?.writes ?? []);
if (!actionIsEffect && surface.length > 0) {
  state.writeIndex.setSurface(action, surface);
  state.registerWriterDependents(action, surface);
}
```

(Identical to today's block minus the `!immediateLog` condition and with
the comment replaced; with an `immediateLog` the subsequent
`setSchedulerDependencies(state..., immediateLog)` call now must NOT
clobber the surface — that is handled by step 3's rewrite, which keeps
surface registration out of dependency updates. Order the calls so the
surface registration runs first.)

Surface resolution is a registration-time declaration, in priority order:
non-empty annotated `action.writes`, then `immediateLog.writes`, then empty.
`resubscribe(action, runLog)` never changes the surface.

Commit with step 3 (single commit; this step alone is incoherent).

## Step 3 — Stop deriving writes from run logs

File: `src/scheduler/dependency-updates.ts`. Replace the body of
`setSchedulerDependencies` with:

```typescript
// Shown at module scope.
export function setSchedulerDependencies(
  state: DependencyUpdateState,
  action: Action,
  log: ReactivityLog,
): {
  reads: IMemorySpaceAddress[];
  shallowReads: IMemorySpaceAddress[];
  log: ReactivityLog;
} {
  const reads = sortAndCompactPaths(log.reads);
  const shallowReads = sortAndCompactPaths(log.shallowReads, false);
  const schedulingLog: ReactivityLog = {
    reads,
    shallowReads,
    writes: state.writeIndex.getSchedulingWrites(action) ?? [],
  };
  state.dependencies.set(action, schedulingLog);
  return { reads, shallowReads, log: schedulingLog };
}
```

`setSchedulerDependencies` must not register, update, derive, or rederive the
write surface. Registration sites own `state.writeIndex.setSurface(...)`;
dependency updates only refresh reads and return the already-registered
scheduling writes for compatibility with existing graph/telemetry payloads.

Deletions in the same commit:

1. `scheduling-writes.ts`: delete `buildKnownSchedulingWrites`,
   `diffSchedulingWrites`, `schedulingWriteSubsumes`,
   `deriveDynamicCollectionParentWrites`, `deriveDeclaredAncestorWrites`,
   `deriveDeclaredAncestorWritesMatching`,
   `declaredWriteIsAncestorOfWrite`, `isDynamicCollectionSegment`, and
   `pruneStructuralAncestorWrites`. KEEP `readsOverlapWrites` (used by the
   conditional-effect filter until phase 3).
2. `SchedulerWriteIndex` (same file): delete `historicalMightWrite`,
   `useHistoricalMightWrite` (field, ctor param, method),
   `getSchedulingWritesMap`'s historical branch (method now returns
   `currentKnownWrites` directly — keep the method name for now); rename
   nothing else. Add:

   ```typescript
   // Shown for illustration only.
   /** Registers the action's static write surface (idempotent). */
   setSurface(action: Action, surface: IMemorySpaceAddress[]): void {
     this.currentKnownWrites.set(action, surface);
     this.updateWriterIndex(action, surface);
   }
   ```

3. `dependency-graph.ts`: `backfillDependentsForNewWrites` and
   `pruneDependentsForCurrentWrites` lose their write-diff callers; check
   remaining callers:
   ```bash
   grep -rn "backfillDependentsForNewWrites\|pruneDependentsForCurrentWrites" src/
   ```
   Delete the functions if call counts hit zero; otherwise STOP and list
   the survivors (expected: zero after this step — the scheduler.ts state
   bundle `createDependencyUpdateState` member `backfillDependentsForNewWrites`
   and its `DependencyUpdateState` field are deleted too).
4. `src/scheduler/action-run.ts` `attachSchedulerActionObservation`
   (~575-595): replace the `declaredWrites`/`buildKnownSchedulingWrites`
   computation: `declaredWrites` := the surface (annotated writes filtered
   by ignored, as today), `currentKnownWrites` := the same surface (keep
   BOTH observation fields populated — wire compatibility; payload
   slimming is phase 7). Remove the
   `getCurrentKnownSchedulingWrites`/`getHistoricalMightWrite` state
   members and their `scheduler.ts` wiring.
5. `src/scheduler.ts`: `createWriteIndex()` loses the
   `useHistoricalMightWrite` arg; `getMightWrite` doc comment now reads
   "Returns the action's static write surface."; the
   `rehydrateActionFromObservation` resubscribe (~614-620) keeps passing
   `observation.currentKnownWrites` as `writes` — under the new
   `setSchedulerDependencies` it is ignored in favor of the live
   annotation, which is the intent; add that as a one-line comment there.
6. Flag removal: `experimental.schedulerHistoricalMightWrite` — sites:
   ```bash
   grep -rn "schedulerHistoricalMightWrite\|historicalMightWrite" ../../packages --include="*.ts"
   ```
   Delete the option from the runtime experimental type
   (`src/runtime.ts`), the scheduler wiring, and adjust
   `test/experimental-options.test.ts` (remove its cases for this flag).
   Spec decision 6 authorizes this; anything matching outside
   runner/src+test: STOP.

Step-1 fixtures must now both pass. Behavior-change sweep: run the full
runner suite. Expected failures to REWRITE (each with a PROGRESS.md
justification: "asserted v1 write-set learning; v2 surface is static"):

- `test/scheduler-ordering.test.ts:74` — asserted `getMightWrite`
  undefined before first run; now the surface is known at subscribe.
- `test/scheduler-observations.test.ts` (~247, 342, 539, 623, 1442, 1524,
  1591) — write-set evolution assertions; rewrite against the static
  surface.
- `test/scheduler-effects.test.ts:451-459` — membership-style check;
  likely passes unchanged; verify.
- `test/scheduler-core.test.ts` / action-run trace expectation — effects now
  have no scheduler-visible output, so trace `declaredWrites` is empty for
  effects.
- `test/scheduler-pull-handlers.test.ts` / dynamic lift seeding — seed the
  computation's static surface through subscribe-with-log (the registration
  declaration channel) or an annotation, not post-run `resubscribe`.
- `test/scheduler-pull.test.ts` / unrelated pending dependency collection —
  v2 §5.3 arrives early here: computations created during a live effect's run
  get provisional first-run demand; the v1 exception keyed on run-learned
  effect writes no longer exists.

Auto-debounce cleanup in the same commit:

1. `src/cell.ts` `pull()`: subscribe the ephemeral pull-root effect with
   `noDebounce: true`. Pull-root debounce protection is explicit rather than
   inferred from a write-surface proxy.
2. The auto-debounce eligibility gate (`canAutomaticallyDebounce` in
   delay-control): remove the `isPullDemandRootEffect` exemption. Keep the
   effect-only requirement, explicit `noDebounce` opt-out, and existing timing
   thresholds. Keep `isPullDemandRootEffect` itself and its other call sites
   unchanged in this phase.

Failures in ANY other file: apply the decision tree in step 4 if they are
ordering-related. If timing/throttle tests fail after the auto-debounce cleanup,
STOP and list the failing names. Otherwise STOP.

Commit: `refactor(runner): scheduling writes are the static declared surface (scheduler-v2 phase 1)`

## Step 4 — Effect-write ordering decision tree

Context: effects (sinks) have an empty surface, so writer→reader edges
from an effect's actual writes disappear. Downstream correctness is
preserved by the change channel (the reader re-runs next pass), but
same-pass toposort placement can shift, which `scheduler-ordering.test.ts`
or `scheduler-convergence.test.ts` may detect as extra iterations.

1. First, run those two files. If green: done; record "clean removal held"
   and skip to step 5.
2. If a failure is exactly "reader ran before the effect in the same pass
   and re-ran after" (read the failing assertion to confirm): implement
   the sanctioned fallback —
   in `action-run.ts` `finalizeReactiveActionCommit`, for effects only
   (`state.isEffectAction.get(args.action)`), store
   `committedLog.writes` into a new
   `effectObservedWrites: WeakMap<Action, IMemorySpaceAddress[]>` owned by
   the scheduler; have `updateDependentEdgesForLog` consult it for effect
   writers. Mark both sites:
   `// WATCH(scheduler-v2 phase 3): ordering-only effect write edges; not demand evidence.`
3. Any other failure shape: STOP and report.

Commit (only if 2 happened):
`refactor(runner): ordering-only effect write edges (scheduler-v2 phase 1)`

## Step 5 — Surface-conformance dev assertion (migration phase 1.4)

File: `src/scheduler/action-run.ts`, in `finalizeReactiveActionCommit`
after `txToReactivityLog`: for computations (not effects, not when the
action has `materializerWriteEnvelopes`), check every `log.writes` address
is covered by the surface (`readsOverlapWrites`-style containment: same
entity and the surface path is a prefix of, or equal to, the write path).
On violation: `logger.warn("write-surface-violation", ...)` with action id
and the offending address — never throw. This is declaration-gap
diagnostics, not enforcement.

Add one test: a computation whose fn writes an undeclared cell produces
the warning (assert via logger counts if available; else mark the test
`// inspect manually` and assert no throw).

Commit: `feat(runner): warn when a run writes outside its declared surface (scheduler-v2 phase 1)`

## Step 6 — Phase end

Full suite; rerun the step-0 benches and record deltas
(`scheduler-stale-propagation` and `demand-roots` should be flat or
better; regressions >10%: STOP).

## Exit checklist (reviewer)

- [ ] `grep -rn "buildKnownSchedulingWrites\|historicalMightWrite\|diffSchedulingWrites\|pruneStructuralAncestorWrites" packages/runner/src` → no matches.
- [ ] `setSchedulerDependencies` never reads `log.writes`.
- [ ] Observation payload still carries both write fields (compat), equal
      to the surface.
- [ ] Fixtures A/B green; behavior change (if any) documented.
- [ ] Test rewrites confined to the named files: ordering, observations,
      effects, core trace expectation, pull single §5.3 test, and
      pull-handlers seeding form (or decision-tree fallback applied and
      marked).
- [ ] Bench deltas recorded; none worse than 10%.
