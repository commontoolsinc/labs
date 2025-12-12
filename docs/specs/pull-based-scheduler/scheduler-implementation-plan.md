# Scheduler Implementation Plan: Pull-Based Scheduling

This document provides detailed implementation steps for transitioning the scheduler from push-based to pull-based scheduling with cycle-aware convergence.

---

## Phase 1: Effect Marking

**Goal**: Distinguish effects (sinks) from computations (lifts/derives) without changing runtime behavior.

### Step 1.1: Add Effect Tracking to Scheduler

**File**: `packages/runner/src/scheduler.ts`

```typescript
// Add to class properties (around line 92)
private effects = new Set<Action>();
private computations = new Set<Action>();

// Modify subscribe() signature (line 151)
subscribe(
  action: Action,
  log: ReactivityLog,
  options: {
    scheduleImmediately?: boolean;
    isEffect?: boolean;  // NEW
  } = {},
): Cancel {
  const { scheduleImmediately = false, isEffect = false } = options;

  // Track action type
  if (isEffect) {
    this.effects.add(action);
  } else {
    this.computations.add(action);
  }

  // ... rest of existing logic unchanged
}

// Update unsubscribe() to clean up (line 210)
unsubscribe(action: Action): void {
  this.cancels.get(action)?.();
  this.cancels.delete(action);
  this.dependencies.delete(action);
  this.pending.delete(action);
  this.effects.delete(action);      // NEW
  this.computations.delete(action); // NEW
}
```

### Step 1.2: Mark Sinks as Effects

**File**: `packages/runner/src/cell.ts`

```typescript
// Modify subscribeToReferencedDocs() (around line 1308)
const cancel = runtime.scheduler.subscribe(action, log, {
  isEffect: true,  // NEW: mark sink callbacks as effects
});
```

### Step 1.3: Add Diagnostic Logging

**File**: `packages/runner/src/scheduler.ts`

```typescript
// Add method for diagnostics
getStats(): { effects: number; computations: number; pending: number } {
  return {
    effects: this.effects.size,
    computations: this.computations.size,
    pending: this.pending.size,
  };
}

// Add to execute() for debugging (optional, remove later)
logger.debug("scheduler-stats", () => [
  `Effects: ${this.effects.size}`,
  `Computations: ${this.computations.size}`,
  `Pending: ${this.pending.size}`,
]);
```

### Step 1.4: Build Reverse Dependency Graph

**File**: `packages/runner/src/scheduler.ts`

```typescript
// Add to class properties
// Maps: action → Set of actions that read this action's writes
private dependents = new WeakMap<Action, Set<Action>>();

// Add method to build reverse graph
private updateDependents(action: Action, log: ReactivityLog): void {
  const { writes } = log;

  // Find all actions that read what this action writes
  for (const write of writes) {
    const spaceAndURI = `${write.space}/${write.id}` as SpaceAndURI;
    const readers = this.triggers.get(spaceAndURI);

    if (readers) {
      for (const [reader] of readers) {
        if (reader !== action) {
          let deps = this.dependents.get(action);
          if (!deps) {
            deps = new Set();
            this.dependents.set(action, deps);
          }
          deps.add(reader);
        }
      }
    }
  }
}

// Call in subscribe() after setDependencies()
const reads = this.setDependencies(action, log);
this.updateDependents(action, log);  // NEW
```

### Step 1.5: Tests

**File**: `packages/runner/src/scheduler.test.ts` (new or existing)

```typescript
describe("Effect Marking", () => {
  it("tracks effects separately from computations", async () => {
    const scheduler = runtime.scheduler;

    // Create a sink (effect)
    const cell = runtime.getCell(space, { value: 1 });
    const cancel = cell.sink((v) => console.log(v));

    const stats = scheduler.getStats();
    expect(stats.effects).toBe(1);

    cancel();
    expect(scheduler.getStats().effects).toBe(0);
  });

  it("tracks computations from lift/derive", async () => {
    // ... test that lift/derive create computations, not effects
  });
});
```

### Verification Criteria

- [ ] `sink()` calls result in `effects.size` incrementing
- [ ] `lift()`/`derive()` calls result in `computations.size` incrementing
- [ ] Unsubscribe correctly removes from both sets
- [ ] No behavioral changes to existing tests
- [ ] `dependents` map correctly tracks reverse dependencies

---

## Phase 2: Pull-Based Core

**Goal**: Only schedule effects; computations marked dirty and pulled on demand.

### Step 2.1: Add Dirty Tracking

**File**: `packages/runner/src/scheduler.ts`

```typescript
// Add to class properties
private dirty = new Set<Action>();

// Add methods
markDirty(action: Action): void {
  this.dirty.add(action);

  // Propagate dirty to dependents (transitively)
  const dependents = this.dependents.get(action);
  if (dependents) {
    for (const dep of dependents) {
      if (!this.dirty.has(dep)) {
        this.markDirty(dep);
      }
    }
  }
}

isDirty(action: Action): boolean {
  return this.dirty.has(action);
}

clearDirty(action: Action): void {
  this.dirty.delete(action);
}
```

### Step 2.2: Feature Flag for Pull Mode

**File**: `packages/runner/src/scheduler.ts`

```typescript
// Add to class properties
private pullMode = false;

enablePullMode(): void {
  this.pullMode = true;
}

// Could also be a constructor option or runtime config
```

### Step 2.3: Modify Storage Change Handler

**File**: `packages/runner/src/scheduler.ts`

```typescript
// In createStorageSubscription(), modify the triggered actions handling (around line 452)
for (const action of triggeredActions) {
  if (this.pullMode) {
    // Pull mode: only schedule effects, mark computations dirty
    if (this.effects.has(action)) {
      this.queueExecution();
      this.pending.add(action);
    } else {
      this.markDirty(action);
      // Also schedule effects that depend on this computation
      this.scheduleAffectedEffects(action);
    }
  } else {
    // Push mode (existing behavior)
    this.queueExecution();
    this.pending.add(action);
  }
}

// New method
private scheduleAffectedEffects(computation: Action): void {
  const dependents = this.dependents.get(computation);
  if (!dependents) return;

  for (const dep of dependents) {
    if (this.effects.has(dep)) {
      this.queueExecution();
      this.pending.add(dep);
    } else {
      // Recursively find effects
      this.scheduleAffectedEffects(dep);
    }
  }
}
```

### Step 2.4: Pull Dependencies Before Running Effect

**File**: `packages/runner/src/scheduler.ts`

```typescript
// Modify run() method (around line 217)
async run(action: Action): Promise<any> {
  // NEW: If pull mode and this is an effect, ensure dependencies are fresh
  if (this.pullMode && this.effects.has(action)) {
    await this.pullDependencies(action);
  }

  // ... rest of existing run() logic
}

// New method
private async pullDependencies(action: Action): Promise<void> {
  const deps = this.dependencies.get(action);
  if (!deps) return;

  // Find computations that write to paths we read
  const depsToRun: Action[] = [];

  for (const read of deps.reads) {
    const spaceAndURI = `${read.space}/${read.id}` as SpaceAndURI;

    // Find dirty computations that write to this path
    for (const computation of this.dirty) {
      if (this.computations.has(computation)) {
        const compDeps = this.dependencies.get(computation);
        if (compDeps?.writes.some(w =>
          w.space === read.space &&
          w.id === read.id &&
          arraysOverlap(w.path, read.path)
        )) {
          depsToRun.push(computation);
        }
      }
    }
  }

  // Topologically sort and run dirty computations
  if (depsToRun.length > 0) {
    const sorted = topologicalSort(new Set(depsToRun), this.dependencies);
    for (const comp of sorted) {
      if (this.dirty.has(comp)) {
        await this.runComputation(comp);
      }
    }
  }
}

private async runComputation(computation: Action): Promise<void> {
  // Recursively ensure our dependencies are fresh first
  await this.pullDependencies(computation);

  // Run the computation
  const tx = this.runtime.edit();
  try {
    await computation(tx);
    await tx.commit();
    this.clearDirty(computation);

    // Update dependencies for next time
    const log = txToReactivityLog(tx);
    this.setDependencies(computation, log);
    this.updateDependents(computation, log);
  } catch (error) {
    this.handleError(error as Error, computation);
  }
}
```

### Step 2.5: Modify Execute Loop for Pull Mode

**File**: `packages/runner/src/scheduler.ts`

```typescript
// In execute() method (around line 598)
for (const fn of order) {
  if (!this.pending.has(fn)) continue;

  this.pending.delete(fn);
  this.unsubscribe(fn);

  this.loopCounter.set(fn, (this.loopCounter.get(fn) || 0) + 1);
  if (this.loopCounter.get(fn)! > MAX_ITERATIONS_PER_RUN) {
    this.handleError(
      new Error(`Too many iterations: ${this.loopCounter.get(fn)} ${fn.name ?? ""}`),
      fn,
    );
  } else {
    // In pull mode, only effects should be in pending at this point
    if (this.pullMode) {
      assert(this.effects.has(fn), "Pull mode: only effects should be pending");
    }
    await this.run(fn);
  }
}
```

### Verification Criteria

- [ ] With `pullMode = false`, behavior unchanged
- [ ] With `pullMode = true`:
  - [ ] Only effects are added to `pending`
  - [ ] Computations are marked dirty
  - [ ] `pullDependencies()` runs dirty computations before effects
  - [ ] Topological order preserved within pull
- [ ] Glitch-free: effects see consistent state

---

## Phase 3: Cycle-Aware Convergence

**Goal**: Handle cycles within pull chains; fast cycles converge completely, slow cycles yield.

### Step 3.1: Add Compute Time Tracking

**File**: `packages/runner/src/scheduler.ts`

```typescript
// Add to class properties
private actionStats = new WeakMap<Action, {
  runCount: number;
  totalTime: number;
  averageTime: number;
  lastRunTime: number;
}>();

// Modify run() to track timing
async run(action: Action): Promise<any> {
  const startTime = performance.now();

  // ... existing logic ...

  // After action completes (in finally or after await)
  const elapsed = performance.now() - startTime;
  this.recordActionTime(action, elapsed);
}

private recordActionTime(action: Action, elapsed: number): void {
  const stats = this.actionStats.get(action) ?? {
    runCount: 0,
    totalTime: 0,
    averageTime: 0,
    lastRunTime: 0,
  };

  stats.runCount++;
  stats.totalTime += elapsed;
  stats.averageTime = stats.totalTime / stats.runCount;
  stats.lastRunTime = elapsed;

  this.actionStats.set(action, stats);
}

getActionStats(action: Action) {
  return this.actionStats.get(action);
}
```

### Step 3.2: Detect Cycles During Pull

**File**: `packages/runner/src/scheduler.ts`

```typescript
// Add to class properties
private pullStack = new Set<Action>();  // Actions currently being pulled

// Modify pullDependencies() and runComputation()
private async pullDependencies(action: Action): Promise<void> {
  // Cycle detection
  if (this.pullStack.has(action)) {
    // We're in a cycle - action depends on itself transitively
    return this.handleCycleInPull(action);
  }

  this.pullStack.add(action);
  try {
    // ... existing pullDependencies logic ...
  } finally {
    this.pullStack.delete(action);
  }
}

private async handleCycleInPull(action: Action): Promise<void> {
  // Get cycle members (all actions in pullStack plus this one)
  const cycle = [...this.pullStack, action];

  // Calculate total expected time for cycle
  let totalTime = 0;
  for (const a of cycle) {
    const stats = this.actionStats.get(a);
    totalTime += stats?.averageTime ?? 0;
  }

  // Decide strategy based on cost
  const FAST_CYCLE_THRESHOLD_MS = 16;  // ~one frame

  if (totalTime < FAST_CYCLE_THRESHOLD_MS) {
    // Fast cycle: iterate to convergence
    await this.convergeCycleFast(cycle);
  } else {
    // Slow cycle: run one iteration and yield
    await this.convergeCycleSlow(cycle);
  }
}
```

### Step 3.3: Fast Cycle Convergence

**File**: `packages/runner/src/scheduler.ts`

```typescript
private async convergeCycleFast(cycle: Action[]): Promise<void> {
  const MAX_CYCLE_ITERATIONS = 20;  // Tighter limit for fast cycles

  for (let i = 0; i < MAX_CYCLE_ITERATIONS; i++) {
    let anyDirty = false;

    // Run all cycle members in topological order
    const sorted = topologicalSort(new Set(cycle), this.dependencies);
    for (const action of sorted) {
      if (this.dirty.has(action)) {
        anyDirty = true;
        await this.runComputation(action);
      }
    }

    // Check for convergence
    if (!anyDirty) {
      return;  // Converged!
    }
  }

  // Didn't converge - log warning but continue
  logger.warn("cycle-convergence", `Cycle did not converge in ${MAX_CYCLE_ITERATIONS} iterations`);
}
```

### Step 3.4: Slow Cycle with Yielding

**File**: `packages/runner/src/scheduler.ts`

```typescript
// Add to class properties
private slowCycleState = new WeakMap<Action, {
  iteration: number;
  lastYield: number;
}>();

private async convergeCycleSlow(cycle: Action[]): Promise<void> {
  // Get or create state for this cycle
  const cycleKey = cycle[0];  // Use first action as key
  let state = this.slowCycleState.get(cycleKey);

  if (!state) {
    state = { iteration: 0, lastYield: 0 };
    this.slowCycleState.set(cycleKey, state);
  }

  // Run one iteration
  const sorted = topologicalSort(new Set(cycle), this.dependencies);
  for (const action of sorted) {
    if (this.dirty.has(action)) {
      await this.runComputation(action);
    }
  }

  state.iteration++;

  // Check if still dirty (not converged)
  const stillDirty = cycle.some(a => this.dirty.has(a));

  if (stillDirty && state.iteration < MAX_ITERATIONS_PER_RUN) {
    // Schedule continuation for next frame
    state.lastYield = performance.now();

    // Re-queue the effect that triggered this cycle
    // It will pull again and continue the cycle
    queueTask(() => {
      for (const action of cycle) {
        if (this.effects.has(action)) {
          this.pending.add(action);
          this.queueExecution();
          break;
        }
      }
    });
  } else if (state.iteration >= MAX_ITERATIONS_PER_RUN) {
    // Hit limit - clean up
    this.slowCycleState.delete(cycleKey);
    this.handleError(
      new Error(`Slow cycle did not converge in ${MAX_ITERATIONS_PER_RUN} iterations`),
      cycleKey,
    );
  } else {
    // Converged - clean up
    this.slowCycleState.delete(cycleKey);
  }
}
```

### Verification Criteria

- [ ] Fast cycles (< 16ms total) converge before effect sees value
- [ ] Slow cycles yield between iterations
- [ ] Iteration limit still enforced
- [ ] Cycle detection via pull stack works correctly
- [ ] No infinite loops

---

## Phase 4: Throttling & Debounce

**Goal**: Add debouncing for slow actions, auto-detect slow actions.

### Step 4.1: Debounce Infrastructure

**File**: `packages/runner/src/scheduler.ts`

```typescript
// Add to class properties
private debounceTimers = new WeakMap<Action, ReturnType<typeof setTimeout>>();
private actionDebounce = new WeakMap<Action, number>();  // Configured debounce time

// New methods
setDebounce(action: Action, ms: number): void {
  this.actionDebounce.set(action, ms);
}

private scheduleWithDebounce(action: Action): void {
  const debounceMs = this.actionDebounce.get(action);

  if (!debounceMs) {
    // No debounce, schedule immediately
    this.pending.add(action);
    return;
  }

  // Clear existing timer
  const existingTimer = this.debounceTimers.get(action);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  // Set new timer
  const timer = setTimeout(() => {
    this.debounceTimers.delete(action);
    this.pending.add(action);
    this.queueExecution();
  }, debounceMs);

  this.debounceTimers.set(action, timer);
}
```

### Step 4.2: Auto-Debounce Detection

**File**: `packages/runner/src/scheduler.ts`

```typescript
// Configuration
const AUTO_DEBOUNCE_THRESHOLD_MS = 50;  // Actions slower than this get debounced
const AUTO_DEBOUNCE_MIN_RUNS = 3;       // Need at least this many samples

// Add to recordActionTime()
private recordActionTime(action: Action, elapsed: number): void {
  // ... existing stats tracking ...

  // Auto-debounce detection
  if (stats.runCount >= AUTO_DEBOUNCE_MIN_RUNS) {
    if (stats.averageTime > AUTO_DEBOUNCE_THRESHOLD_MS) {
      // Auto-set debounce if not already set
      if (!this.actionDebounce.has(action)) {
        const debounceMs = Math.min(stats.averageTime, 200);  // Cap at 200ms
        this.setDebounce(action, debounceMs);
        logger.info("auto-debounce", () => [
          `Auto-debouncing action (avg ${stats.averageTime.toFixed(1)}ms) with ${debounceMs}ms delay`,
        ]);
      }
    }
  }
}
```

### Step 4.3: Declarative Debounce in Subscribe

**File**: `packages/runner/src/scheduler.ts`

```typescript
// Extend subscribe() options
subscribe(
  action: Action,
  log: ReactivityLog,
  options: {
    scheduleImmediately?: boolean;
    isEffect?: boolean;
    debounce?: number;  // NEW
  } = {},
): Cancel {
  const { debounce } = options;

  if (debounce !== undefined) {
    this.setDebounce(action, debounce);
  }

  // ... rest of existing logic
}
```

### Step 4.4: Use Debounce in Scheduling

**File**: `packages/runner/src/scheduler.ts`

```typescript
// In createStorageSubscription(), use debounce
for (const action of triggeredActions) {
  if (this.pullMode) {
    if (this.effects.has(action)) {
      this.scheduleWithDebounce(action);  // Changed from direct add
      this.queueExecution();
    } else {
      this.markDirty(action);
      this.scheduleAffectedEffects(action);
    }
  } else {
    this.scheduleWithDebounce(action);  // Changed from direct add
    this.queueExecution();
  }
}
```

### Step 4.5: Expose Debounce in Public API

**File**: `packages/runner/src/builder/module.ts`

```typescript
// Add debounce option to lift
export function lift<T, R>(
  argumentSchema?: JSONSchema | ((input: any) => any),
  resultSchema?: JSONSchema,
  implementation?: (input: T) => R,
  options?: { debounce?: number },  // NEW
): ModuleFactory<T, R> {
  // ... pass options through to runner
}
```

### Verification Criteria

- [ ] `setDebounce()` correctly delays action scheduling
- [ ] Rapid triggers only run action once after debounce period
- [ ] Auto-debounce kicks in for slow actions
- [ ] Declarative debounce in `subscribe()` works
- [ ] Cleanup happens on unsubscribe

---

## Testing Strategy

### Unit Tests

1. **Effect marking**: Verify effects and computations tracked correctly
2. **Dirty tracking**: Verify transitive dirty propagation
3. **Pull ordering**: Verify topological order within pull
4. **Cycle detection**: Verify cycles detected via pull stack
5. **Convergence**: Verify fast cycles complete, slow cycles yield
6. **Debounce**: Verify timing behavior

### Integration Tests

1. **End-to-end reactivity**: Changes propagate correctly
2. **UI responsiveness**: Slow cycles don't block UI
3. **Memory**: No leaks from tracking structures
4. **Existing patterns**: All existing patterns still work

### Performance Tests

1. **Sparse graph**: Pull mode faster than push for many computations, few effects
2. **Dense graph**: No regression for heavily connected graphs
3. **Large cycles**: Verify iteration limits work

---

## Rollout Plan

### Week 1-2: Phase 1 (Effect Marking)
- Implement effect tracking
- Add diagnostics
- Build reverse dependency graph
- Run existing test suite

### Week 3-4: Phase 2 (Pull-Based Core)
- Implement dirty tracking
- Add feature flag
- Implement pull logic
- Test with flag off, then on

### Week 5-6: Phase 3 (Cycle Convergence)
- Add timing instrumentation
- Implement cycle detection
- Implement fast/slow convergence
- Extensive cycle testing

### Week 7-8: Phase 4 (Throttling)
- Implement debounce infrastructure
- Add auto-detection
- Add declarative API
- Performance testing

### Week 9+: Phase 5 (Migration)
- Gradual rollout with feature flag
- Monitor for issues
- Remove push-based path
- Final cleanup

---

## Rollback Plan

Each phase has a feature flag or is additive:

1. **Phase 1**: Remove effect tracking (no behavioral change)
2. **Phase 2**: Set `pullMode = false` (instant rollback)
3. **Phase 3**: Cycle handling falls back to existing limits
4. **Phase 4**: Disable auto-debounce, clear debounce settings

Critical: Keep push-based code path until Phase 5 is fully validated.
