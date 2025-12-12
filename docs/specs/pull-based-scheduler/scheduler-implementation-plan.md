# Pull-Based Scheduler Implementation Plan

> **For AI Agents**: This is an executable implementation plan. Work through phases in order. Check off tasks as you complete them. Each task should result in working, tested code before moving to the next.

## Prerequisites

Before starting, ensure you understand:
- Read `docs/specs/pull-based-scheduler/scheduler-graph-investigation.md` for context
- Read `packages/runner/src/scheduler.ts` (current implementation)
- Read `packages/runner/src/cell.ts` (`sink()` and `subscribeToReferencedDocs()`)
- Understand the difference between effects (sinks) and computations (lifts/derives)

---

## Phase 1: Effect Marking

**Goal**: Distinguish effects (sinks) from computations (lifts/derives) without changing runtime behavior.

**Depends on**: Nothing (start here)

### Tasks

#### 1.1 Add effect/computation tracking to Scheduler class

**File**: `packages/runner/src/scheduler.ts`

- [x] Add class properties:
  ```typescript
  private effects = new Set<Action>();
  private computations = new Set<Action>();
  ```

- [x] Modify `subscribe()` signature to accept `isEffect` option:
  ```typescript
  subscribe(
    action: Action,
    log: ReactivityLog,
    options: {
      scheduleImmediately?: boolean;
      isEffect?: boolean;
    } = {},
  ): Cancel
  ```

- [x] In `subscribe()`, track action type based on `isEffect` flag

- [x] Update `unsubscribe()` to clean up from both sets

#### 1.2 Mark sink callbacks as effects

**File**: `packages/runner/src/cell.ts`

- [x] In `subscribeToReferencedDocs()` (~line 1308), pass `isEffect: true`:
  ```typescript
  const cancel = runtime.scheduler.subscribe(action, log, { isEffect: true });
  ```

#### 1.3 Add diagnostic API

**File**: `packages/runner/src/scheduler.ts`

- [x] Add `getStats()` method:
  ```typescript
  getStats(): { effects: number; computations: number; pending: number }
  ```

- [x] Add debug logging in `execute()` for effect/computation counts

#### 1.4 Build reverse dependency graph

**File**: `packages/runner/src/scheduler.ts`

- [x] Add class property:
  ```typescript
  private dependents = new WeakMap<Action, Set<Action>>();
  ```

- [x] Add `updateDependents()` method that finds all actions reading what this action writes

- [x] Call `updateDependents()` in `subscribe()` after `setDependencies()`

#### 1.5 Write tests

**File**: `packages/runner/test/scheduler.test.ts`

- [x] Test: `sink()` calls increment `effects.size`
- [x] Test: `lift()`/`derive()` calls increment `computations.size`
- [x] Test: `unsubscribe()` removes from correct set
- [x] Test: `dependents` map correctly tracks reverse dependencies

#### 1.6 Verify Phase 1

- [x] All existing tests pass (no behavioral changes)
- [x] New diagnostic tests pass
- [x] Run `deno task test` in `packages/runner`

---

## Phase 2: Pull-Based Core

**Goal**: Only schedule effects; computations marked dirty and pulled on demand.

**Depends on**: Phase 1 complete

### Tasks

#### 2.1 Add dirty tracking

**File**: `packages/runner/src/scheduler.ts`

- [x] Add class property:
  ```typescript
  private dirty = new Set<Action>();
  ```

- [x] Add `markDirty(action)` method with transitive propagation to dependents

- [x] Add `isDirty(action)` and `clearDirty(action)` methods

#### 2.2 Add feature flag

**File**: `packages/runner/src/scheduler.ts`

- [x] Add class property:
  ```typescript
  private pullMode = false;
  ```

- [x] Add `enablePullMode()` method

- [x] Consider making this a constructor option or runtime config

#### 2.3 Modify storage change handler for pull mode

**File**: `packages/runner/src/scheduler.ts`

- [x] In `createStorageSubscription()`, branch on `pullMode`:
  - Push mode: existing behavior (add to `pending`)
  - Pull mode:
    - If effect: add to `pending`
    - If computation: call `markDirty()` and `scheduleAffectedEffects()`

- [x] Add `scheduleAffectedEffects(computation)` method that recursively finds and schedules effects

#### 2.4 Implement pull mechanism in execute()

**File**: `packages/runner/src/scheduler.ts`

- [x] Add `collectDirtyDependencies(action, workSet)` method:
  - Recursively finds all dirty computations an action depends on
  - Adds them to the work set for execution

- [x] Modify `execute()` to build work queue differently in pull mode:
  - Push mode: same as before (just `pending` set)
  - Pull mode: collect pending effects + all their dirty computation dependencies
  - Topologically sort the combined work set
  - Run all actions via existing `run()` method
  - Clear dirty flags as computations run

#### 2.5 Clean up legacy code

**File**: `packages/runner/src/scheduler.ts`

- [x] Remove legacy boolean signature from `subscribe()` - now only accepts options object
- [x] Update all call sites across codebase to use `{ scheduleImmediately: true }`

#### 2.6 Write tests

**File**: `packages/runner/test/scheduler.test.ts`

- [x] Test: `pullMode = false` has unchanged behavior
- [x] Test: `pullMode = true` only adds effects to `pending`
- [x] Test: computations are marked dirty, not scheduled
- [x] Test: `pullDependencies()` runs dirty deps before effects
- [x] Test: topological order preserved within pull
- [x] Test: effects see consistent (glitch-free) state

#### 2.7 Verify Phase 2

- [x] All existing tests pass with `pullMode = false`
- [x] All existing tests pass with `pullMode = true`
- [x] New pull-mode tests pass
- [x] Run `deno task test` in `packages/runner`

---

## Phase 3: Cycle-Aware Convergence

**Goal**: Handle cycles within the work queue; fast cycles converge completely, slow cycles yield.

**Depends on**: Phase 2 complete

**Note**: With the simplified Phase 2 architecture, cycle detection happens during `collectDirtyDependencies()` or topological sort in `execute()`, not during a separate pull phase.

### Tasks

#### 3.1 Add compute time tracking

**File**: `packages/runner/src/scheduler.ts`

- [x] Add class property:
  ```typescript
  private actionStats = new WeakMap<Action, {
    runCount: number;
    totalTime: number;
    averageTime: number;
    lastRunTime: number;
  }>();
  ```

- [x] Add `recordActionTime(action, elapsed)` method

- [x] Modify `run()` to measure and record execution time

- [x] Add `getActionStats(action)` method for diagnostics

#### 3.2 Add cycle detection during dependency collection

**File**: `packages/runner/src/scheduler.ts`

- [x] Add class property:
  ```typescript
  private collectStack = new Set<Action>();
  ```

- [x] Modify `collectDirtyDependencies()`:
  - Check if action is already in `collectStack` (cycle detected)
  - If cycle: record cycle members, continue without infinite recursion
  - Otherwise: add to stack, process, remove from stack

- [x] Add `detectCycles(workSet)` method:
  - Identify strongly connected components in the work set (using Tarjan's algorithm)
  - Return list of cycle groups

#### 3.3 Implement cycle convergence in execute()

**File**: `packages/runner/src/scheduler.ts`

- [x] Modify `execute()` to handle cycles:
  - After building work set, detect cycles via `detectCycles()`
  - For each cycle group, calculate total expected time from `actionStats`
  - If < 16ms: run cycle members repeatedly until converged (max 20 iterations)
  - If >= 16ms: run one iteration, re-queue if still dirty

- [x] Add `convergeFastCycle(cycleMembers)` method:
  - Loop: run all dirty cycle members in topological order
  - Break when no members are dirty (converged)
  - Warn if max iterations reached

#### 3.4 Implement slow cycle with yielding

**File**: `packages/runner/src/scheduler.ts`

- [x] Add class property:
  ```typescript
  private slowCycleState = new WeakMap<Action, {
    iteration: number;
    lastYield: number;
  }>();
  ```

- [x] For slow cycles (>= 16ms estimated time):
  - Run one iteration of cycle members via `runSlowCycleIteration()`
  - If still dirty and under limit: re-add to pending, let next `execute()` continue
  - If limit reached: error and clean up
  - If converged: clean up

#### 3.5 Write tests

**File**: `packages/runner/test/scheduler.test.ts`

- [x] Test: action execution time tracking
- [x] Test: action stats accumulate across runs
- [x] Test: cycle detection works (detectCycles method)
- [x] Test: iteration limit enforced for non-converging cycles
- [x] Test: no infinite loops in collectDirtyDependencies
- [x] Test: cycles during dependency collection don't cause infinite recursion

#### 3.6 Verify Phase 3

- [x] All Phase 1 and 2 tests still pass
- [x] New cycle tests pass
- [x] Run `deno task test` in `packages/runner` - all 109 tests pass

---

## Phase 4: Debounce & Throttle

**Goal**: Add debouncing for slow actions and throttling (staleness tolerance) for computations.

**Depends on**: Phase 3 complete

### Tasks

#### 4.1 Add debounce infrastructure

**File**: `packages/runner/src/scheduler.ts`

- [x] Add class properties:
  ```typescript
  private debounceTimers = new WeakMap<Action, ReturnType<typeof setTimeout>>();
  private actionDebounce = new WeakMap<Action, number>();
  private autoDebounceEnabled = new WeakMap<Action, boolean>();
  ```

- [x] Add `setDebounce(action, ms)` method

- [x] Add `getDebounce(action)` and `clearDebounce(action)` methods

- [x] Add `scheduleWithDebounce(action)` method:
  - If no debounce configured: add to `pending` immediately
  - Otherwise: clear existing timer, set new timer

#### 4.2 Add auto-debounce detection

**File**: `packages/runner/src/scheduler.ts`

- [x] Define constants:
  ```typescript
  const AUTO_DEBOUNCE_THRESHOLD_MS = 50;
  const AUTO_DEBOUNCE_MIN_RUNS = 3;
  const AUTO_DEBOUNCE_DELAY_MS = 100;
  ```

- [x] Modify `recordActionTime()` to auto-set debounce for slow actions via `maybeAutoDebounce()`

- [x] Add `setAutoDebounce(action, enabled)` method to control auto-debounce per action

#### 4.3 Add declarative debounce to subscribe

**File**: `packages/runner/src/scheduler.ts`

- [x] Extend `subscribe()` options to include `debounce?: number` and `autoDebounce?: boolean`

- [x] Apply debounce setting when provided

#### 4.4 Use debounce in scheduling

**File**: `packages/runner/src/scheduler.ts`

- [x] Replace direct `pending.add()` with `scheduleWithDebounce()` in:
  - `subscribe()` when `scheduleImmediately` is true
  - `createStorageSubscription()` for storage change handling
  - `scheduleAffectedEffects()` for pull-mode effect scheduling

#### 4.5 Add throttle infrastructure (staleness tolerance)

**File**: `packages/runner/src/scheduler.ts`

- [x] Add class property:
  ```typescript
  private actionThrottle = new WeakMap<Action, number>();
  ```

- [x] Add `lastRunTimestamp` to `ActionStats` interface for throttle timing

- [x] Update `recordActionTime()` to track `lastRunTimestamp`

- [x] Add `setThrottle(action, ms)`, `getThrottle(action)`, `clearThrottle(action)` methods

- [x] Add `isThrottled(action)` private method to check if action ran too recently

- [x] Modify `execute()` to skip throttled actions but keep them dirty:
  - Throttled actions stay dirty for future pulls
  - If no effect needs the value later, computation is skipped entirely (pull semantics)

- [x] Extend `subscribe()` options to include `throttle?: number`

**Key difference from debounce:**
- **Debounce**: "Wait until triggers stop, then run once after T ms of quiet"
- **Throttle**: "Value can be stale by up to T ms" - skip if ran recently, keep dirty for later

#### 4.6 Expose debounce/throttle in public API

**File**: `packages/runner/src/builder/module.ts`

- [ ] Add `debounce` option to `lift()` function signature (deferred to Phase 6)

- [ ] Add `throttle` option to `lift()` function signature (deferred to Phase 5)

- [ ] Pass through to runner/scheduler (deferred to Phase 5)

#### 4.7 Write tests

**File**: `packages/runner/test/scheduler.test.ts`

**Debounce tests (10):**
- [x] Test: `setDebounce()` delays action scheduling
- [x] Test: rapid triggers run action once after debounce period
- [x] Test: auto-debounce kicks in for slow actions (> 50ms avg after 3 runs)
- [x] Test: declarative debounce in `subscribe()` works
- [x] Test: cleanup on unsubscribe cancels pending timers
- [x] Test: `getDebounce()` returns configured debounce value
- [x] Test: `clearDebounce()` removes debounce configuration
- [x] Test: debounce timer cancellation on rapid re-triggers
- [x] Test: auto-debounce can be disabled per action
- [x] Test: debounce integrates with pull mode

**Throttle tests (9):**
- [x] Test: `setThrottle()` and `getThrottle()` API
- [x] Test: `setThrottle(0)` clears throttle
- [x] Test: throttle from `subscribe()` options
- [x] Test: skip throttled action if ran recently
- [x] Test: run throttled action after throttle period expires
- [x] Test: keep action dirty when throttled in pull mode
- [x] Test: run throttled effect after throttle expires (pull mode)
- [x] Test: `lastRunTimestamp` in action stats
- [x] Test: first run allowed even with throttle set (no previous timestamp)

#### 4.8 Verify Phase 4

- [x] All previous phase tests pass
- [x] New debounce tests pass (10 tests)
- [x] New throttle tests pass (9 tests)
- [x] Run `deno task test` in `packages/runner` - all 111 tests pass

---

## Phase 5: Push-Triggered Filtering

**Goal**: Use push mode's precision to filter pull mode's conservative work set. Only run actions whose inputs actually changed.

**Depends on**: Phase 4 complete

**Key Insight**: Pull mode builds a superset of what *might* need to run (conservative). Push mode knows what *actually* changed (precise). Running their intersection gives us the best of both worlds.

### Background

Currently in pull mode:
1. Storage change arrives → `determineTriggeredActions` finds affected actions
2. Effects → scheduled; Computations → marked dirty + schedule affected effects
3. `execute()` builds work set from pending effects + dirty dependencies
4. All actions in work set run

The problem: Dirty propagation is transitive and conservative. If A might write to X, and B reads X, B gets marked dirty even if A didn't actually change X.

### Solution

Track what push mode would have triggered (based on actual changes), then filter the pull work set to only include those actions.

```
Pull work set: {effects} ∪ {dirty computations they depend on}  (conservative)
Push triggered: actions whose reads overlap with actual changes  (precise)
Actual execution: Pull work set ∩ Push triggered
```

### Tasks

#### 5.1 Track "might write" set per action

**File**: `packages/runner/src/scheduler.ts`

- [x] Add class property:
  ```typescript
  private mightWrite = new WeakMap<Action, IMemorySpaceAddress[]>();
  ```

- [x] After each action runs, accumulate its writes into `mightWrite`:
  ```typescript
  private updateMightWrite(action: Action, writes: IMemorySpaceAddress[]): void
  ```

- [x] Track `scheduledImmediately` set for actions that bypass filtering

#### 5.2 Track push-triggered actions per cycle

**File**: `packages/runner/src/scheduler.ts`

- [x] Add class property:
  ```typescript
  private pushTriggered = new Set<Action>();
  ```

- [x] In `createStorageSubscription()`, when `determineTriggeredActions` returns actions:
  ```typescript
  this.pushTriggered.add(action);  // Track what push would run
  ```

- [x] Clear `pushTriggered` and `scheduledImmediately` at the end of each `execute()` cycle

#### 5.3 Filter work set using push-triggered info

**File**: `packages/runner/src/scheduler.ts`

- [x] Add `shouldFilterAction(action)` method that checks:
  - Actions with `scheduleImmediately` bypass filter
  - Actions without prior `mightWrite` bypass filter (first run)
  - In pull mode: filter if not in `pushTriggered`

- [x] Modify `execute()` to call `shouldFilterAction()` before running each action

- [x] Track filter stats (`filtered` and `executed` counts)

#### 5.4 Handle edge cases

**File**: `packages/runner/src/scheduler.ts`

- [x] Actions scheduled with `scheduleImmediately: true` always run (bypass filter)

- [x] First run of an action (no prior `mightWrite`) always runs

- [x] Skipped actions keep their dirty flag for next cycle

#### 5.5 Add diagnostic API

**File**: `packages/runner/src/scheduler.ts`

- [x] `getMightWrite(action)`: Returns accumulated write paths for an action

- [x] `getFilterStats()`: Returns `{ filtered: number; executed: number }`

- [x] `resetFilterStats()`: Resets filter statistics

#### 5.6 Write tests

**File**: `packages/runner/test/scheduler.test.ts`

- [x] Test: `mightWrite` grows from actual writes over time
- [x] Test: `mightWrite` accumulates over multiple runs
- [x] Test: filter stats tracking
- [x] Test: `scheduleImmediately` bypasses filter (first run)
- [x] Test: storage-triggered actions are tracked in `pushTriggered`
- [x] Test: `scheduleImmediately` bypasses filter (subsequent runs)
- [x] Test: `resetFilterStats()` works

#### 5.7 Verify Phase 5

- [x] All previous phase tests pass
- [x] New filter tests pass (7 tests added)
- [x] Run `deno task test` in `packages/runner` - all 112 tests pass

---

## Phase 6: Full Migration

**Goal**: Remove push-based code path after validation.

**Depends on**: Phase 5 complete + production validation

### Tasks

#### 6.1 Enable pull mode by default

- [ ] Change `pullMode` default to `true`

- [ ] Add escape hatch config to disable if needed

#### 6.2 Production validation

- [ ] Deploy with feature flag
- [ ] Monitor for regressions
- [ ] Collect metrics on effect/computation ratios
- [ ] Validate cycle convergence behavior
- [ ] Validate push-triggered filtering reduces unnecessary runs

#### 6.3 Remove push-based code

- [ ] Remove `pullMode` flag and conditionals
- [ ] Remove dead code paths
- [ ] Simplify storage change handler

#### 6.4 Final cleanup

- [ ] Update documentation
- [ ] Remove any temporary logging
- [ ] Clean up unused properties

#### 6.5 Verify Phase 6

- [ ] All tests pass
- [ ] Performance benchmarks show improvement
- [ ] No production regressions

---

## Rollback Plan

If issues are discovered at any phase:

| Phase | Rollback Action |
|-------|-----------------|
| 1 | Remove effect tracking code (no behavioral impact) |
| 2 | Set `pullMode = false` (instant rollback) |
| 3 | Cycle handling falls back to existing iteration limits |
| 4 | Clear debounce/throttle settings |
| 5 | Disable push-triggered filtering (run all dirty actions) |
| 6 | Re-enable push-based code path via config |

**Critical**: Keep push-based code path until Phase 6 is fully validated in production.

---

## Testing Commands

```bash
# Run all runner tests
cd packages/runner && deno task test

# Run specific test file
deno test test/scheduler.test.ts

# Run with verbose output
deno test --reporter=verbose src/scheduler.test.ts
```

---

## Progress Summary

Update this section as phases complete:

| Phase | Status | Completed By | Date |
|-------|--------|--------------|------|
| Phase 1: Effect Marking | Complete | Claude | 2025-12-12 |
| Phase 2: Pull-Based Core | Complete | Claude | 2025-12-12 |
| Phase 3: Cycle Convergence | Complete | Claude | 2025-12-12 |
| Phase 4: Debounce & Throttle | Complete | Claude | 2025-12-12 |
| Phase 5: Push-Triggered Filtering | Complete | Claude | 2025-12-12 |
| Phase 6: Migration | Not Started | | |
