# Pull-Based Scheduler Implementation Plan

> **For AI Agents**: This is an executable implementation plan. Work through phases in order. Check off tasks as you complete them. Each task should result in working, tested code before moving to the next.

## Prerequisites

Before starting, ensure you understand:
- [ ] Read `docs/specs/pull-based-scheduler/scheduler-graph-investigation.md` for context
- [ ] Read `packages/runner/src/scheduler.ts` (current implementation)
- [ ] Read `packages/runner/src/cell.ts` (`sink()` and `subscribeToReferencedDocs()`)
- [ ] Understand the difference between effects (sinks) and computations (lifts/derives)

---

## Phase 1: Effect Marking

**Goal**: Distinguish effects (sinks) from computations (lifts/derives) without changing runtime behavior.

**Depends on**: Nothing (start here)

### Tasks

#### 1.1 Add effect/computation tracking to Scheduler class

**File**: `packages/runner/src/scheduler.ts`

- [ ] Add class properties:
  ```typescript
  private effects = new Set<Action>();
  private computations = new Set<Action>();
  ```

- [ ] Modify `subscribe()` signature to accept `isEffect` option:
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

- [ ] In `subscribe()`, track action type based on `isEffect` flag

- [ ] Update `unsubscribe()` to clean up from both sets

#### 1.2 Mark sink callbacks as effects

**File**: `packages/runner/src/cell.ts`

- [ ] In `subscribeToReferencedDocs()` (~line 1308), pass `isEffect: true`:
  ```typescript
  const cancel = runtime.scheduler.subscribe(action, log, { isEffect: true });
  ```

#### 1.3 Add diagnostic API

**File**: `packages/runner/src/scheduler.ts`

- [ ] Add `getStats()` method:
  ```typescript
  getStats(): { effects: number; computations: number; pending: number }
  ```

- [ ] Add debug logging in `execute()` for effect/computation counts

#### 1.4 Build reverse dependency graph

**File**: `packages/runner/src/scheduler.ts`

- [ ] Add class property:
  ```typescript
  private dependents = new WeakMap<Action, Set<Action>>();
  ```

- [ ] Add `updateDependents()` method that finds all actions reading what this action writes

- [ ] Call `updateDependents()` in `subscribe()` after `setDependencies()`

#### 1.5 Write tests

**File**: `packages/runner/test/scheduler.test.ts`

- [ ] Test: `sink()` calls increment `effects.size`
- [ ] Test: `lift()`/`derive()` calls increment `computations.size`
- [ ] Test: `unsubscribe()` removes from correct set
- [ ] Test: `dependents` map correctly tracks reverse dependencies

#### 1.6 Verify Phase 1

- [ ] All existing tests pass (no behavioral changes)
- [ ] New diagnostic tests pass
- [ ] Run `deno task test` in `packages/runner`

---

## Phase 2: Pull-Based Core

**Goal**: Only schedule effects; computations marked dirty and pulled on demand.

**Depends on**: Phase 1 complete

### Tasks

#### 2.1 Add dirty tracking

**File**: `packages/runner/src/scheduler.ts`

- [ ] Add class property:
  ```typescript
  private dirty = new Set<Action>();
  ```

- [ ] Add `markDirty(action)` method with transitive propagation to dependents

- [ ] Add `isDirty(action)` and `clearDirty(action)` methods

#### 2.2 Add feature flag

**File**: `packages/runner/src/scheduler.ts`

- [ ] Add class property:
  ```typescript
  private pullMode = false;
  ```

- [ ] Add `enablePullMode()` method

- [ ] Consider making this a constructor option or runtime config

#### 2.3 Modify storage change handler for pull mode

**File**: `packages/runner/src/scheduler.ts`

- [ ] In `createStorageSubscription()`, branch on `pullMode`:
  - Push mode: existing behavior (add to `pending`)
  - Pull mode:
    - If effect: add to `pending`
    - If computation: call `markDirty()` and `scheduleAffectedEffects()`

- [ ] Add `scheduleAffectedEffects(computation)` method that recursively finds and schedules effects

#### 2.4 Implement pull mechanism

**File**: `packages/runner/src/scheduler.ts`

- [ ] Modify `run()` to call `pullDependencies()` before running effects in pull mode

- [ ] Add `pullDependencies(action)` method:
  - Find dirty computations that write to paths this action reads
  - Topologically sort them
  - Run each via `runComputation()`

- [ ] Add `runComputation(computation)` method:
  - Recursively call `pullDependencies()` first
  - Run the computation
  - Call `clearDirty()`
  - Update dependencies

#### 2.5 Update execute loop

**File**: `packages/runner/src/scheduler.ts`

- [ ] In `execute()`, add assertion that only effects are pending when in pull mode

#### 2.6 Write tests

**File**: `packages/runner/test/scheduler.test.ts`

- [ ] Test: `pullMode = false` has unchanged behavior
- [ ] Test: `pullMode = true` only adds effects to `pending`
- [ ] Test: computations are marked dirty, not scheduled
- [ ] Test: `pullDependencies()` runs dirty deps before effects
- [ ] Test: topological order preserved within pull
- [ ] Test: effects see consistent (glitch-free) state

#### 2.7 Verify Phase 2

- [ ] All existing tests pass with `pullMode = false`
- [ ] All existing tests pass with `pullMode = true`
- [ ] New pull-mode tests pass
- [ ] Run `deno task test` in `packages/runner`

---

## Phase 3: Cycle-Aware Convergence

**Goal**: Handle cycles within pull chains; fast cycles converge completely, slow cycles yield.

**Depends on**: Phase 2 complete

### Tasks

#### 3.1 Add compute time tracking

**File**: `packages/runner/src/scheduler.ts`

- [ ] Add class property:
  ```typescript
  private actionStats = new WeakMap<Action, {
    runCount: number;
    totalTime: number;
    averageTime: number;
    lastRunTime: number;
  }>();
  ```

- [ ] Add `recordActionTime(action, elapsed)` method

- [ ] Modify `run()` to measure and record execution time

- [ ] Add `getActionStats(action)` method for diagnostics

#### 3.2 Add cycle detection during pull

**File**: `packages/runner/src/scheduler.ts`

- [ ] Add class property:
  ```typescript
  private pullStack = new Set<Action>();
  ```

- [ ] Modify `pullDependencies()`:
  - Check if action is already in `pullStack` (cycle detected)
  - If cycle: call `handleCycleInPull()`
  - Otherwise: add to stack, process, remove from stack

- [ ] Add `handleCycleInPull(action)` method:
  - Get cycle members from `pullStack`
  - Calculate total expected time from `actionStats`
  - If < 16ms: call `convergeCycleFast()`
  - Otherwise: call `convergeCycleSlow()`

#### 3.3 Implement fast cycle convergence

**File**: `packages/runner/src/scheduler.ts`

- [ ] Add `convergeCycleFast(cycle)` method:
  - Set `MAX_CYCLE_ITERATIONS = 20`
  - Loop: run all dirty cycle members in topological order
  - Break when no members are dirty (converged)
  - Warn if max iterations reached

#### 3.4 Implement slow cycle with yielding

**File**: `packages/runner/src/scheduler.ts`

- [ ] Add class property:
  ```typescript
  private slowCycleState = new WeakMap<Action, {
    iteration: number;
    lastYield: number;
  }>();
  ```

- [ ] Add `convergeCycleSlow(cycle)` method:
  - Get/create state for cycle
  - Run one iteration
  - If still dirty and under limit: schedule continuation via `queueTask()`
  - If limit reached: error and clean up
  - If converged: clean up

#### 3.5 Write tests

**File**: `packages/runner/test/scheduler.test.ts`

- [ ] Test: fast cycles (< 16ms) converge before effect sees value
- [ ] Test: slow cycles yield between iterations
- [ ] Test: iteration limit enforced for non-converging cycles
- [ ] Test: cycle detection via pull stack works
- [ ] Test: no infinite loops

#### 3.6 Verify Phase 3

- [ ] All Phase 1 and 2 tests still pass
- [ ] New cycle tests pass
- [ ] Manual testing with intentional cycles
- [ ] Run `deno task test` in `packages/runner`

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
| Phase 1: Effect Marking | Not Started | | |
| Phase 2: Pull-Based Core | Not Started | | |
| Phase 3: Cycle Convergence | Not Started | | |
| Phase 4: Throttling | Not Started | | |
| Phase 5: Migration | Not Started | | |
