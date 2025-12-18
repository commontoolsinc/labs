# Simplified Cycle Handling

> **Status**: Implemented - Explicit cycle detection removed
> **Date**: 2025-12-18
> **Updated**: 2025-12-18 - Successfully removed Tarjan's algorithm

## Overview

This document describes the simplified approach to cycle detection and handling in the pull-based scheduler. **Explicit cycle detection (Tarjan's algorithm) was successfully removed** in favor of:

1. **Topological sort with parent-child awareness** - Parents run before children even in cycles
2. **Settle loop for conditional dependencies** - Re-collect and run newly needed computations
3. **True pull-based semantics** - Only run computations that effects actually need

## Implementation Approach

### Key Changes

1. **Removed explicit cycle detection**:
   - `detectCycles()` (Tarjan's algorithm)
   - `getSuccessorsInWorkSet()`
   - `convergeFastCycle()`
   - `runSlowCycleIteration()`
   - `slowCycleState` WeakMap

2. **Enhanced topological sort**:
   - When breaking cycles, prefer parents over children
   - This ensures parent actions run before child actions even when they form read/write cycles

3. **Settle loop for conditional dependencies**:
   - After running computations, re-collect dirty dependencies
   - If dependencies changed (e.g., ifElse switched branches), run newly needed computations
   - Repeat until no more work is found (max 10 iterations)
   - This handles conditional patterns correctly without running ALL dirty computations

4. **True pull-based semantics**:
   - Only run computations that effects actually depend on
   - Computations stay dirty if no effect needs them
   - Lazy evaluation is preserved

### Parent-Child Ordering

The key insight was that read/write cycles between parent and child actions need special handling:

```
multiplyGenerator (parent) → multiply (child)
       ↓ writes                  ↓ writes
       ↓ reads                   ↓ reads
       ←←←←←←←←←←←←←←←←←←←←←←←←←←←←
```

When topological sort encounters a cycle, it prefers nodes without unvisited parents, ensuring:
- Parent runs first
- Parent can decide to reuse or recreate child
- Only the appropriate child runs

### Settle Loop for Conditional Dependencies

The ifElse pattern presents a challenge:
1. When `expandChat` is true, ifElse reads `optionA`
2. When `expandChat` becomes false, ifElse should read `optionB`
3. But `optionB` wasn't in the dependency chain when we collected deps

Solution: After running computations, re-collect dependencies and run any newly needed dirty computations.

```typescript
// Settle loop: after running computations, their dependencies might have changed.
for (let settleIter = 0; settleIter < maxSettleIterations; settleIter++) {
  const moreWork = new Set<Action>();
  for (const effect of this.effects) {
    this.collectDirtyDependencies(effect, moreWork);
  }

  // Filter out already-run actions
  for (const fn of order) moreWork.delete(fn);

  if (moreWork.size === 0) break;

  // Run newly needed computations
  for (const fn of topologicalSort(moreWork, ...)) {
    if (this.dirty.has(fn)) await this.run(fn);
  }
}
```

## API Changes

### `noDebounce` option (inverted semantics)

**Old API:**
```typescript
subscribe(action, deps, { autoDebounce: true })  // Opt IN to auto-debounce
```

**New API:**
```typescript
subscribe(action, deps, { noDebounce: true })  // Opt OUT of auto-debounce
```

Actions that consistently take >50ms after 3 runs get automatically debounced. Use `noDebounce: true` to opt out.

## Why This Works

### For Nested Lifts (multiplyGenerator → multiply)

1. `multiplyGenerator` and `multiply` form a read/write cycle
2. Topological sort prefers parents → `multiplyGenerator` runs first
3. `multiplyGenerator` either reuses old `multiply` or creates new one
4. Only the appropriate `multiply` action runs

### For Conditional Dependencies (ifElse)

1. Initial collect: gets computations for current active branch
2. After running computations, ifElse may have switched branches
3. Settle loop re-collects: now gets computations for new active branch
4. Run newly needed computations
5. Repeat until settled

### For True Lazy Evaluation

1. Only collect dependencies that effects currently depend on
2. Computations not in any effect's dependency chain stay dirty
3. Settle loop only runs if NEW dependencies are discovered

## Test Results

All tests pass:
- `recipes.test.ts` - All 26 tests passing
- `scheduler.test.ts` - All 86 tests passing
- Including "should handle recipes returned by lifted functions" (nested lifts)
- Including "correctly handles the ifElse values with nested derives" (conditional deps)
- Including "should track getStats with dirty count" (lazy evaluation preserved)

## Summary

### What Was Removed

- `detectCycles()` - Tarjan's algorithm (~60 lines)
- `getSuccessorsInWorkSet()` - Successor finding (~35 lines)
- `convergeFastCycle()` - Fast cycle convergence (~45 lines)
- `runSlowCycleIteration()` - Slow cycle iteration (~55 lines)
- `isFastCycle()` - Cycle speed classification
- `estimateCycleTime()` - Cycle time estimation
- `slowCycleState` - Slow cycle state tracking
- `MAX_CYCLE_ITERATIONS` and `FAST_CYCLE_THRESHOLD_MS` constants

**Total: ~200+ lines removed**

### What Was Added/Changed

1. Enhanced topological sort to prefer parents over children in cycles (~20 lines)
2. Settle loop to re-collect and run newly needed computations (~30 lines)
3. Skip computations if parent created a replacement during execution
4. `noDebounce` option with inverted semantics (opt-out instead of opt-in)

### Why This Approach Is More Robust

1. **Dynamic reads/writes**: The dependency graph changes at runtime. Static cycle detection misses dynamic dependencies.
2. **Simpler logic**: No separate fast/slow cycle paths, no convergence iteration, no cycle state tracking.
3. **Correct for conditionals**: Settle loop handles ifElse and other conditional patterns.
4. **Natural cycle breaking**: Parent-child ordering naturally handles the nested lift pattern.
5. **True pull semantics**: Only run what's actually needed, maintaining lazy evaluation.
