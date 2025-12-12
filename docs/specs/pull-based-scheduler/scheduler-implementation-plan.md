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

## Phase 4: Throttling & Debounce

**Goal**: Add debouncing for slow actions, auto-detect slow actions.

**Depends on**: Phase 3 complete

### Tasks

#### 4.1 Add debounce infrastructure

**File**: `packages/runner/src/scheduler.ts`

- [ ] Add class properties:
  ```typescript
  private debounceTimers = new WeakMap<Action, ReturnType<typeof setTimeout>>();
  private actionDebounce = new WeakMap<Action, number>();
  ```

- [ ] Add `setDebounce(action, ms)` method

- [ ] Add `scheduleWithDebounce(action)` method:
  - If no debounce configured: add to `pending` immediately
  - Otherwise: clear existing timer, set new timer

#### 4.2 Add auto-debounce detection

**File**: `packages/runner/src/scheduler.ts`

- [ ] Define constants:
  ```typescript
  const AUTO_DEBOUNCE_THRESHOLD_MS = 50;
  const AUTO_DEBOUNCE_MIN_RUNS = 3;
  ```

- [ ] Modify `recordActionTime()` to auto-set debounce for slow actions

#### 4.3 Add declarative debounce to subscribe

**File**: `packages/runner/src/scheduler.ts`

- [ ] Extend `subscribe()` options to include `debounce?: number`

- [ ] Apply debounce setting when provided

#### 4.4 Use debounce in scheduling

**File**: `packages/runner/src/scheduler.ts`

- [ ] Replace direct `pending.add()` with `scheduleWithDebounce()` where appropriate

#### 4.5 Expose debounce in public API

**File**: `packages/runner/src/builder/module.ts`

- [ ] Add `debounce` option to `lift()` function signature

- [ ] Pass through to runner/scheduler

#### 4.6 Write tests

**File**: `packages/runner/test/scheduler.test.ts`

- [ ] Test: `setDebounce()` delays action scheduling
- [ ] Test: rapid triggers run action once after debounce period
- [ ] Test: auto-debounce kicks in for slow actions (> 50ms avg after 3 runs)
- [ ] Test: declarative debounce in `subscribe()` works
- [ ] Test: cleanup on unsubscribe cancels pending timers

#### 4.7 Verify Phase 4

- [ ] All previous phase tests pass
- [ ] New debounce tests pass
- [ ] Run `deno task test` in `packages/runner`

---

## Phase 5: Full Migration

**Goal**: Remove push-based code path after validation.

**Depends on**: Phase 4 complete + production validation

### Tasks

#### 5.1 Enable pull mode by default

- [ ] Change `pullMode` default to `true`

- [ ] Add escape hatch config to disable if needed

#### 5.2 Production validation

- [ ] Deploy with feature flag
- [ ] Monitor for regressions
- [ ] Collect metrics on effect/computation ratios
- [ ] Validate cycle convergence behavior

#### 5.3 Remove push-based code

- [ ] Remove `pullMode` flag and conditionals
- [ ] Remove dead code paths
- [ ] Simplify storage change handler

#### 5.4 Final cleanup

- [ ] Update documentation
- [ ] Remove any temporary logging
- [ ] Clean up unused properties

#### 5.5 Verify Phase 5

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
| 4 | Clear debounce settings, disable auto-debounce |
| 5 | Re-enable push-based code path via config |

**Critical**: Keep push-based code path until Phase 5 is fully validated in production.

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
| Phase 3: Cycle Convergence | Not Started | | |
| Phase 4: Throttling | Not Started | | |
| Phase 5: Migration | Not Started | | |
