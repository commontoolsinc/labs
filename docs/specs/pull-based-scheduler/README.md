# Pull-Based Scheduler

> **Status**: Implemented and enabled by default
> **Location**: `packages/runner/src/scheduler.ts`

This document describes how the pull-based scheduler works in the CommonTools runtime.

## Background: Why Pull-Based?

The original scheduler was **push-based**: when data changed, all dependent actions ran immediately. This was wasteful because:

1. **Greedy execution**: All actions that *could* be affected ran, regardless of whether their outputs were observed
2. **No lazy evaluation**: Intermediate computations ran even if final consumers didn't need them
3. **Wasted work**: In sparse graphs with many computations but few observers, most work was unnecessary

The **pull-based** approach inverts this:
- When data changes, computations are marked *dirty* but don't run
- Only *effects* (side-effectful actions like `sink()`) are scheduled
- Effects *pull* their dependencies on demand
- Computations only run if an effect actually needs them

## Core Concepts

### Actions

An **action** is a function `(tx: Transaction) => any` that the scheduler manages. Actions are created by the runtime when patterns use reactive primitives:

| Pattern Primitive | Creates Action Type | Description |
|-------------------|---------------------|-------------|
| `sink(cell, callback)` | Effect | Runs callback when cell changes |
| `lift(fn, ...inputs)` | Computation | Transforms inputs, writes to output cell |
| `derive(input, fn)` | Computation | Derives new value from input |
| Event handlers | Effect (one-time) | Responds to user events |

The scheduler doesn't know about patterns - it only sees actions with read/write dependencies.

### Effects vs Computations

| Type | Description | Behavior |
|------|-------------|----------|
| **Effect** | Side-effectful action | Always runs when scheduled. These are "roots of demand" |
| **Computation** | Pure transformation | Only runs when an effect needs its output |

When you call `sink()`, the runtime registers the action with `isEffect: true`. Everything else is a computation.

### Dirty vs Pending

- **Pending**: Actions scheduled to run this cycle
- **Dirty**: Computations whose inputs changed but haven't re-run yet

When a cell changes:
- Effects → added to `pending`
- Computations → marked `dirty`, and downstream effects are scheduled

A computation stays dirty until an effect pulls it. If no effect ever needs it, it never runs.

### The mightWrite Set

Each action tracks what it has *ever* written (cumulative across all runs). This is necessary because write behavior can vary:

```typescript
// Sometimes writes A, sometimes B
if (condition) cellA.set(x);
else cellB.set(x);
```

The dependency graph uses `mightWrite` (cumulative) rather than `dependencies.writes` (last run only) to conservatively track what might need to run.

## Execution Flow

### 1. Storage Change Notification

```
Cell X changes (value: before → after)
    ↓
Storage manager notifies scheduler
    ↓
Find actions that read X (via triggers map)
    ↓
For each triggered action:
    Effect → add to pending, queue execution
    Computation → mark dirty, propagate to dependents, schedule affected effects
```

The `triggers` map indexes actions by the cells they read, so finding affected actions is O(1) per cell.

### 2. Dependency Collection

Before an action runs for the first time, the scheduler discovers its dependencies:

```typescript
// Scheduler calls the action's populateDependencies callback
const tx = runtime.edit();
populateDependencies(tx);  // Action reads cells it will access
const deps = txToReactivityLog(tx);  // Extract reads from transaction
tx.abort();  // Don't commit - we only wanted to capture reads
```

This happens in `execute()` before building the work set.

### 3. Building the Work Set

In pull mode, the work set is built by starting from effects and pulling their dirty dependencies:

```typescript
workSet = new Set<Action>();

// Start with pending effects
for (const effect of pending) {
  if (isEffect(effect)) workSet.add(effect);
}

// Recursively collect dirty computations each effect depends on
for (const effect of workSet) {
  collectDirtyDependencies(effect, workSet);
}
```

The `collectDirtyDependencies` function finds dirty computations that write to cells the action reads.

### 4. Topological Sort

Actions are sorted so dependencies run before dependents:

```typescript
function topologicalSort(actions, dependencies, mightWrite, actionParent) {
  // Build graph: action A → action B if A writes something B reads
  // Add edges: parent → child (for nested patterns)
  // Kahn's algorithm with cycle handling
}
```

When cycles exist, the sort prefers:
1. Nodes whose parents are already visited
2. Nodes with lowest in-degree

This ensures parents run before children in nested patterns.

### 5. Run Actions

```typescript
for (const action of sortedOrder) {
  // Skip if unsubscribed during this tick
  if (!isStillScheduled(action)) continue;

  // Skip if throttled
  if (isThrottled(action)) continue;

  // Clear from pending/dirty
  pending.delete(action);
  dirty.delete(action);

  // Run and record time for auto-debounce
  const start = performance.now();
  await action(tx);
  recordActionTime(action, performance.now() - start);

  // Resubscribe with new dependencies
  resubscribe(action, txToReactivityLog(tx));
}
```

### 6. Settle Loop

Dependencies can change at runtime. The classic example is `ifElse`:

```typescript
const result = ifElse(condition, branchA, branchB);
```

When `condition` changes from `true` to `false`:
1. Initial collect finds: `ifElse` depends on `branchA`
2. After `ifElse` runs, it now depends on `branchB`
3. If `branchB` is dirty, we need to run it and re-run `ifElse`

The settle loop handles this:

```typescript
for (let iter = 0; iter < 10; iter++) {
  // Re-collect dependencies from all effects
  const moreWork = new Set<Action>();
  for (const effect of effects) {
    collectDirtyDependencies(effect, moreWork);
  }

  // Remove already-run actions
  for (const action of alreadyRan) moreWork.delete(action);

  if (moreWork.size === 0) break;  // Settled

  // Run newly discovered work
  for (const action of topologicalSort(moreWork)) {
    if (dirty.has(action)) await run(action);
  }
}
```

Max 10 iterations prevents infinite loops from non-converging cycles.

## Cycle Handling

### Why Not Explicit Cycle Detection?

The original plan included Tarjan's algorithm to find strongly connected components (cycles) and handle them specially. This was abandoned because:

1. **Dynamic dependencies**: The dependency graph changes at runtime. Static cycle detection would miss cycles that appear only under certain conditions.

2. **Complexity**: Separate fast/slow cycle paths, convergence tracking, and cycle state management added ~200 lines of complex code.

3. **The real problem is simpler**: Most cycles are nested patterns (parent creates child, both read/write shared state). Parent-child ordering handles these naturally.

### What We Do Instead

1. **Parent-child ordering in topological sort**: When breaking ties in cycles, prefer nodes without unvisited parents. This ensures parents run before children.

2. **Settle loop**: Re-collect dependencies after running. Handles conditional patterns (ifElse) correctly.

3. **Iteration limits**: Max 10 settle iterations, max 100 runs per action. Prevents infinite loops.

4. **Cycle-aware debounce**: Actions running 3+ times in cycles taking >100ms get adaptive debounce (2× cycle time).

### Example: Nested Lift Pattern

```
multiplyGenerator (parent)
    ↓ creates
multiply (child)
    ↓ writes result
    ↓ parent reads result
    ←←←←←←←←←←←←←←←
```

Both are triggered when input changes. Topological sort sees a cycle. By preferring the parent:
1. `multiplyGenerator` runs first
2. It may unsubscribe old child and create new one
3. Only the appropriate child runs

## Event Handlers

Event handlers (button clicks, form submissions) are synchronous but may depend on computed values. The challenge: handlers can't `await` their dependencies.

### The traverseCells Flag

When registering a handler, the runtime provides a `populateDependencies` callback:

```typescript
handler.populateDependencies = (tx, event) => {
  // Read with traverseCells to capture nested Cell dependencies
  inputsCell.asSchema(schema).get({ traverseCells: true });
};
```

The `traverseCells: true` flag tells `validateAndTransform` to recursively read into nested `Cell` objects (from `asCell: true` in schemas), capturing all dependencies.

### Handler Execution Flow

```
Event arrives
    ↓
Scheduler calls populateDependencies(tx, event)
    ↓
Extract reads from transaction
    ↓
Check if any dependencies are dirty
    ↓
If dirty:
    Schedule dirty computations
    Re-queue event (will run after deps compute)
Else:
    Run handler synchronously
```

### Global FIFO Ordering

Events run in global arrival order. If event A arrives before event B, A runs first regardless of which component they target. This preserves causality from the user's perspective.

Events are serialized globally, but their *dependencies* can compute in parallel.

## Debounce and Throttle

### Debounce: "Wait then run"

Delays execution until triggers stop arriving:

```typescript
scheduler.setDebounce(action, 100);  // Wait 100ms after last trigger
```

Each trigger resets the timer. Good for search-as-you-type.

### Auto-Debounce

Actions averaging >50ms (after 3 runs) automatically get 100ms debounce. Opt out with `{ noDebounce: true }` in subscription options.

### Throttle: "Stale by T ms"

Limits execution frequency:

```typescript
scheduler.setThrottle(action, 1000);  // Max once per second
```

Unlike debounce, throttled actions stay dirty and will run when:
1. The throttle period expires, AND
2. An effect pulls them

Good for rate-limiting expensive operations.

### Cycle-Aware Debounce

Actions running 3+ times in execute cycles taking >100ms get adaptive debounce:

```
debounce = 2 × cycle_time
```

This naturally slows down problematic cycles without manual intervention.

## Key Data Structures

```typescript
class Scheduler {
  // Action classification
  private effects = new Set<Action>();
  private computations = new Set<Action>();

  // Scheduling state
  private pending = new Set<Action>();
  private dirty = new Set<Action>();

  // Dependency tracking
  private dependencies = new WeakMap<Action, ReactivityLog>();
  private dependents = new WeakMap<Action, Set<Action>>();  // Reverse graph
  private mightWrite = new WeakMap<Action, Address[]>();    // Cumulative writes

  // Triggers: cell → actions that read it
  private triggers = new Map<SpaceAndURI, Map<Action, Paths>>();

  // Parent-child relationships (for nested patterns)
  private actionParent = new WeakMap<Action, Action>();
  private actionChildren = new WeakMap<Action, Set<Action>>();

  // Performance tracking
  private actionStats = new WeakMap<Action, ActionStats>();

  // Debounce/throttle
  private actionDebounce = new WeakMap<Action, number>();
  private actionThrottle = new WeakMap<Action, number>();
}

interface ReactivityLog {
  reads: Address[];
  writes: Address[];
  potentialWrites?: Address[];  // For diffAndUpdate pattern
}

interface ActionStats {
  runCount: number;
  totalTime: number;
  averageTime: number;
  lastRunTime: number;
  lastRunTimestamp: number;
}
```

## Constants

```typescript
MAX_ITERATIONS_PER_RUN = 100       // Max runs per action per execute cycle
AUTO_DEBOUNCE_THRESHOLD_MS = 50    // Avg time to trigger auto-debounce
AUTO_DEBOUNCE_MIN_RUNS = 3         // Runs before auto-debounce kicks in
AUTO_DEBOUNCE_DELAY_MS = 100       // Debounce delay for slow actions
CYCLE_DEBOUNCE_THRESHOLD_MS = 100  // Cycle time to trigger adaptive debounce
CYCLE_DEBOUNCE_MIN_RUNS = 3        // Runs in cycle to be considered cycling
CYCLE_DEBOUNCE_MULTIPLIER = 2      // Debounce = multiplier × cycle time
DEFAULT_RETRIES_FOR_EVENTS = 5     // Retry count for commit conflicts
MAX_RETRIES_FOR_REACTIVE = 10      // Retry count for reactive actions
```

## Debugging

### Enable Logging

```typescript
// scheduler.ts line 38
const logger = getLogger("scheduler", {
  enabled: true,
  level: "debug",
});
```

Logs show:
- Storage notifications and triggered actions
- Work set construction and topological sort order
- Settle loop iterations
- Cycle detection and debounce decisions

### Diagnostic API

```typescript
// Overall state
scheduler.getStats()              // { effects, computations, pending }
scheduler.isPullModeEnabled()

// Action queries
scheduler.isEffect(action)
scheduler.isComputation(action)
scheduler.isDirty(action)
scheduler.getDependents(action)
scheduler.getActionStats(action)  // { runCount, avgTime, lastRunTime, ... }

// Debounce/throttle
scheduler.getDebounce(action)
scheduler.getThrottle(action)
scheduler.setDebounce(action, ms)
scheduler.setThrottle(action, ms)

// Filter stats (pull vs push efficiency)
scheduler.getFilterStats()        // { filtered, executed }
```

### Common Issues

**Computation not running:**
- Verify an effect depends on it (check `getDependents`)
- Check if it's dirty: `isDirty(action)`
- If throttled, wait for period to expire

**Action running too many times:**
- Check for commit conflicts causing retries
- Look for rapidly-changing dependencies creating cycles
- Add debounce: `setDebounce(action, 100)`

**Seeing stale values:**
- Check throttle settings
- Ensure the reading action is marked as an effect
- Verify dependencies are correctly declared

**Max iterations hit:**
- Action has self-referential dependency (writes to what it reads)
- Add debounce to slow down the cycle
- Consider restructuring the pattern to break the cycle

## API Reference

### Subscribe

```typescript
scheduler.subscribe(
  action: Action,
  populateDependencies: (tx: Transaction) => void,
  options?: {
    isEffect?: boolean,     // Mark as effect (always runs)
    debounce?: number,      // Delay in ms before running
    noDebounce?: boolean,   // Opt out of auto-debounce
    throttle?: number,      // Min ms between runs
  }
): Cancel
```

### Mode Control

```typescript
scheduler.enablePullMode()
scheduler.disablePullMode()
scheduler.isPullModeEnabled()
```

### Waiting

```typescript
scheduler.idle(): Promise<void>  // Resolves when no pending work
```

## Tests

The scheduler has comprehensive test coverage in `packages/runner/test/scheduler.test.ts` covering:
- Effect vs computation classification
- Dirty propagation and pull mechanics
- Topological ordering
- Debounce and throttle behavior
- Cycle handling and iteration limits
- Event handler dependencies
