# Scheduler Graph Investigation: Pull-Based Scheduling & Cycle Throttling

## Current Architecture Analysis

### Overview

The scheduler in `packages/runner/src/scheduler.ts` implements a **push-based reactive system**. When data changes, it immediately schedules all dependent actions for execution.

### Key Data Structures

```typescript
// scheduler.ts:84-96
class Scheduler {
  private pending = new Set<Action>();                           // Actions queued to run
  private dependencies = new WeakMap<Action, ReactivityLog>();   // reads/writes per action
  private triggers = new Map<SpaceAndURI, Map<Action, Paths>>(); // entity → actions that read it
}

type ReactivityLog = {
  reads: IMemorySpaceAddress[];   // What the action reads
  writes: IMemorySpaceAddress[];  // What the action writes
};
```

### Current Flow (Push-Based)

```
[Storage Change]
      ↓
createStorageSubscription() detects change
      ↓
determineTriggeredActions() finds all actions reading changed paths
      ↓
All affected actions added to `pending` set
      ↓
queueExecution() → execute()
      ↓
topologicalSort() orders ALL pending actions by dependency
      ↓
Run ALL pending actions in order
```

### Why It's "Greedy"

1. **Immediate scheduling**: When registering actions (scheduler.ts:1187):
   ```typescript
   this.runtime.scheduler.subscribe(wrappedAction, { reads, writes }, true);
   //                                                                ^^^^
   // scheduleImmediately = true → action runs even if nothing observes output
   ```

2. **No demand tracking**: All actions that *could* be affected run, regardless of whether their outputs are actually observed.

3. **No lazy evaluation**: Intermediate computations run even if final consumers don't need them.

### What Cell.sink/effect Does

`sink()` (cell.ts:855-871) and `effect()` (reactivity.ts:13-23) create **observable endpoints**:

```typescript
// subscribeToReferencedDocs (cell.ts:1271-1314)
const action: Action = (tx) => {
  const newValue = validateAndTransform(runtime, wrappedTx, link, true);
  cleanup = callback(newValue);  // Side effect!
};

// Run once to capture dependencies, then subscribe
const tx = runtime.edit();
action(tx);
const log = txToReactivityLog(tx);
const cancel = runtime.scheduler.subscribe(action, log);
```

These are effectively "effects" in FRP terminology - side-effectful computations at system boundaries.

---

## Proposal 1: Pull-Based Scheduling

### FRP Concepts

In classical FRP (Functional Reactive Programming):

| Term | Meaning |
|------|---------|
| **Signal/Behavior** | Time-varying value (our `Cell<T>`) |
| **Event** | Discrete occurrence (our event handlers) |
| **Effect/Sink** | Side-effectful consumer (our `sink()`) |
| **Derived/Computed** | Pure transformation (our `lift()`/`derive()`) |

**Push vs Pull:**
- **Push**: Changes propagate immediately to all dependents
- **Pull**: Consumers request values when needed; producers mark dirty

**Glitch Freedom**: Ensuring observers never see inconsistent intermediate states.

### Proposed Architecture

```
                    [Effects Layer - "Roots of Demand"]
                    sink(), effect(), event handlers
                              ↑ pull
                    [Derived Computations - "Intermediate"]
                    lift(), derive(), computed()
                              ↑ pull
                    [Source Data Layer]
                    Cell values, storage
```

### Key Changes

#### 1. Distinguish Action Types

```typescript
type ActionKind = 'effect' | 'computation';

interface ActionMetadata {
  kind: ActionKind;
  dirty: boolean;
  lastValue?: unknown;  // Memoization for computations
  dependents: Set<Action>;  // Who reads my output
  dependencies: Set<Action>;  // Whose output I read
}
```

#### 2. On Data Change: Mark Dirty, Don't Execute

```typescript
// Instead of:
for (const action of triggeredActions) {
  this.pending.add(action);  // Schedule immediately
}

// Do:
for (const action of triggeredActions) {
  this.markDirty(action);  // Just mark, don't schedule
}

// Only schedule effects
for (const action of this.dirtyActions) {
  if (this.getMetadata(action).kind === 'effect') {
    this.pending.add(action);
  }
}
```

#### 3. Pull Through Dirty Computations

```typescript
async runEffect(effect: Action, tx: IExtendedStorageTransaction) {
  // Before running effect, ensure all its dependencies are fresh
  for (const dep of this.getDependencies(effect)) {
    if (this.isDirty(dep)) {
      await this.recompute(dep, tx);  // Recursive pull
    }
  }

  // Now run the effect with fresh values
  await effect(tx);
  this.clearDirty(effect);
}
```

#### 4. Memoization for Computations

```typescript
async recompute(computation: Action, tx: IExtendedStorageTransaction) {
  // First, ensure our dependencies are fresh
  for (const dep of this.getDependencies(computation)) {
    if (this.isDirty(dep)) {
      await this.recompute(dep, tx);
    }
  }

  // Then recompute
  const result = await computation(tx);
  this.clearDirty(computation);
  return result;
}
```

### Benefits

1. **Reduced computation**: Only compute what's actually needed
2. **Memory efficiency**: Don't cache results nobody uses
3. **Better for sparse graphs**: Many computations, few observers

### Challenges

1. **Identifying effects**: Need to distinguish sinks from computations
   - Current system doesn't track this distinction
   - `sink()` could set a flag when subscribing

2. **Dependency graph needs both directions**:
   - Currently only tracks "who reads what"
   - Need to also track "who writes what others read"

3. **Glitch freedom**: Must ensure topological ordering within pull

4. **Integration with current tx mechanism**: Transactions assume immediate execution

### Minimal Change Approach

Rather than rewriting everything:

```typescript
// Add to scheduler
private effects = new Set<Action>();  // Actions registered via sink()
private dirtyComputations = new Set<Action>();

subscribe(action: Action, log: ReactivityLog, opts: {
  scheduleImmediately?: boolean;
  isEffect?: boolean;  // NEW
} = {}): Cancel {
  if (opts.isEffect) {
    this.effects.add(action);
  }
  // ... rest of existing logic
}

// Modify storage subscription handler
for (const action of triggeredActions) {
  if (this.effects.has(action)) {
    this.pending.add(action);  // Schedule effects
  } else {
    this.dirtyComputations.add(action);  // Just mark dirty
  }
}

// Modify execute() to pull dependencies before running effects
```

---

## Proposal 2: Cycle Detection & Throttling

### Current Cycle Handling

The scheduler has basic cycle handling in `topologicalSort()` (scheduler.ts:681-688):

```typescript
if (queue.length === 0) {
  // Handle cycle: choose an unvisited node with the lowest in-degree
  const unvisitedAction = Array.from(actions)
    .filter((action) => !visited.has(action))
    .reduce((a, b) => (inDegree.get(a)! < inDegree.get(b)! ? a : b));
  queue.push(unvisitedAction);
}
```

And loop detection (scheduler.ts:606-613):

```typescript
this.loopCounter.set(fn, (this.loopCounter.get(fn) || 0) + 1);
if (this.loopCounter.get(fn)! > MAX_ITERATIONS_PER_RUN) {  // 100
  this.handleError(new Error(`Too many iterations...`), fn);
}
```

### Proposed Enhancements

#### 1. Explicit Cycle Detection

```typescript
interface CycleInfo {
  actions: Action[];          // Actions in the cycle
  detected: number;           // Timestamp of detection
  iterationsThisCycle: number;
  averageComputeTime: number;
}

class Scheduler {
  private cycles = new Map<string, CycleInfo>();  // cycleId → info

  detectCycles(): CycleInfo[] {
    // Tarjan's algorithm for strongly connected components
    // Each SCC with >1 node is a cycle
  }
}
```

#### 2. Compute Cost Tracking

```typescript
interface ActionStats {
  runCount: number;
  totalTime: number;
  averageTime: number;
  lastRunTime: number;
}

private actionStats = new WeakMap<Action, ActionStats>();

async run(action: Action): Promise<any> {
  const start = performance.now();
  // ... existing run logic ...
  const elapsed = performance.now() - start;

  const stats = this.actionStats.get(action) ?? { runCount: 0, totalTime: 0 };
  stats.runCount++;
  stats.totalTime += elapsed;
  stats.averageTime = stats.totalTime / stats.runCount;
  stats.lastRunTime = elapsed;
  this.actionStats.set(action, stats);
}
```

#### 3. Adaptive Throttling for Cycles

```typescript
const THROTTLE_THRESHOLD_MS = 50;  // Throttle if avg > 50ms
const MIN_CYCLE_INTERVAL_MS = 100; // At least 100ms between cycle iterations

private cycleLastRun = new Map<string, number>();

shouldThrottleCycle(cycleId: string, cycle: CycleInfo): boolean {
  if (cycle.averageComputeTime < THROTTLE_THRESHOLD_MS) {
    return false;  // Fast cycle, no throttling
  }

  const lastRun = this.cycleLastRun.get(cycleId) ?? 0;
  const elapsed = performance.now() - lastRun;

  // Scale throttle based on compute time
  const interval = Math.max(
    MIN_CYCLE_INTERVAL_MS,
    cycle.averageComputeTime * 2
  );

  return elapsed < interval;
}
```

#### 4. Declarative Debounce for Actions

```typescript
// New annotation on actions
interface ActionOptions {
  debounce?: number;  // ms to debounce
  throttle?: number;  // min ms between runs
  maxFrequency?: number;  // max runs per second
}

// Could be set when creating lift/derive:
lift(fn, { debounce: 100 })

// Or detected automatically:
const AUTO_DEBOUNCE_THRESHOLD_MS = 50;

subscribe(action: Action, log: ReactivityLog, opts: SubscribeOptions) {
  // Check if action has run before and was slow
  const stats = this.actionStats.get(action);
  if (stats && stats.averageTime > AUTO_DEBOUNCE_THRESHOLD_MS) {
    opts.debounce = opts.debounce ?? stats.averageTime;
  }
}
```

#### 5. Debounce Implementation

```typescript
private debounceTimers = new WeakMap<Action, number>();
private debouncedActions = new WeakMap<Action, number>();  // debounce time

scheduleWithDebounce(action: Action): void {
  const debounceMs = this.debouncedActions.get(action);

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
    this.pending.add(action);
    this.queueExecution();
    this.debounceTimers.delete(action);
  }, debounceMs);

  this.debounceTimers.set(action, timer);
}
```

### FRP Concepts for Cycles

In FRP, cycles are handled via:

1. **Fixpoint semantics**: Iterate until stable
2. **Delay operators**: Break cycles with explicit delays
3. **Initial values**: Provide starting point for recursion

The current system uses approach (1) with iteration limits. Throttling adds temporal damping.

### Recommended Throttling Strategy

```typescript
interface ThrottleConfig {
  // Automatic debouncing kicks in above this threshold
  autoDebounceThreshold: 50,  // ms

  // Cycles detected above this cost get throttled
  cycleThrottleThreshold: 100,  // ms total cycle time

  // Maximum frequency for throttled cycles
  maxCycleFrequency: 10,  // Hz (10 times per second max)

  // Hard limit on iterations (existing)
  maxIterationsPerRun: 100,
}
```

---

## Implementation Recommendations

### Phase 1: Instrumentation (Low Risk)

1. Add compute time tracking to `run()`
2. Add cycle detection (Tarjan's algorithm) as diagnostic
3. Log statistics without changing behavior

### Phase 2: Effect Marking (Medium Risk)

1. Add `isEffect` flag to `subscribe()` options
2. Update `subscribeToReferencedDocs()` to mark effects
3. Track effects separately from computations
4. Initially: still schedule both, but track separately

### Phase 3: Pull-Based for New Code (Medium Risk)

1. Add dirty tracking alongside existing scheduling
2. For effects: verify dependencies are fresh before running
3. Add memoization for computations
4. Feature flag to enable pull-based mode

### Phase 4: Throttling (Lower Risk)

1. Implement debounce infrastructure
2. Add `debounce` option to action creation APIs
3. Enable auto-debounce for slow actions
4. Throttle detected cycles based on cost

### Phase 5: Full Pull-Based (Higher Risk)

1. Stop scheduling computations eagerly
2. Only schedule effects
3. Pull through dependency graph
4. Remove push-based code path

---

## Summary

| Current | Proposed |
|---------|----------|
| Push-based: all affected actions run | Pull-based: only effects trigger, pull deps |
| No effect/computation distinction | Effects are roots, computations are intermediate |
| Greedy: run everything | Lazy: only compute what's needed |
| Basic cycle detection (iteration limit) | Explicit cycle detection + throttling |
| No debouncing | Automatic + declarative debounce |
| No cost tracking | Compute time instrumentation |

### Key Files to Modify

- `packages/runner/src/scheduler.ts` - Main scheduler logic
- `packages/runner/src/cell.ts` - `subscribeToReferencedDocs()` to mark effects
- `packages/runner/src/reactivity.ts` - `effect()` wrapper
- `packages/runner/src/runner.ts` - Handler/lift registration

### Risk Assessment

- **Phase 1-2**: Low risk, backward compatible
- **Phase 3-4**: Medium risk, can be feature-flagged
- **Phase 5**: Higher risk, requires thorough testing

The incremental approach allows validating each change before proceeding.
