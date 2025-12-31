# Cell.get() Performance Investigation

## Summary

Investigated performance characteristics of `Cell.get()` operations, particularly when accessing data in pending commits (nursery). Found a significant performance issue in the heap read path that affects all reads from committed data.

## Key Findings

### 1. **Critical Performance Issue: Heap Read Path** ⚠️

**Location**: `packages/runner/src/storage/cache.ts:1271-1283`

```typescript
get(entry: BaseMemoryAddress): State | undefined {
  const nurseryState = this.nursery.get(entry);
  if (nurseryState) return nurseryState;

  const heapState = this.heap.get(entry);
  if (heapState) {
    // ⚠️ PERFORMANCE ISSUE: Object destructuring on EVERY read
    const { since: _since, ...state } = heapState;
    return state;
  }

  return undefined;
}
```

**Problem**:
- Every read from the heap (committed, synced data) performs object destructuring: `const { since: _since, ...state } = heapState`
- This creates a **new object** on every read by copying all properties except `since`
- Operation is **O(n)** where n = number of properties in the state
- Happens on **every single read**, even repeated reads of the same data
- No caching of the destructured result

**Impact**:
- High CPU usage from repeated object copies
- Increased GC pressure from creating throwaway objects
- Performance degrades with larger state objects
- Particularly bad for repeated reads of the same cell

### 2. **Multiple Reads Per Cell.get()**

**Location**: `packages/runner/src/link-resolution.ts:63-200`

The `resolveLink()` function performs multiple transaction reads:
- Line 97: Sigil probe at full path
- Line 110: Read full value for reactivity
- Line 137: Parent sigil probe
- Line 143: Read parent value

Each of these calls `tx.read()` which eventually calls `replica.get()`, triggering the destructuring issue.

**Code Flow**:
```
Cell.get()
  → validateAndTransform()
    → resolveLink()  [multiple tx.read() calls]
      → chronicle.read()
        → chronicle.load()
          → replica.get()  [DESTRUCTURING HERE]
    → tx.readValueOrThrow()  [another read]
```

### 3. **Nursery vs Heap Performance**

**Nursery Path (Fast)** ✅
- Direct return: `return nurseryState`
- No object copies
- O(1) operation

**Heap Path (Slow)** ⚠️
- Object destructuring creates new object
- Copies all properties
- O(n) per property count
- Extra GC pressure

**Paradox**: Reads from nursery (pending commits) are actually **FASTER** than reads from heap (committed data) because they avoid the destructuring!

## Data Structures

### Nursery
```typescript
class Nursery {
  store: Map<string, State> = new Map()

  get(entry: BaseMemoryAddress) {
    return this.store.get(toKey(entry));  // Direct return, no copy
  }
}
```

### Heap
```typescript
class Heap {
  store: Map<string, Revision<State>> = new Map()

  get(entry: BaseMemoryAddress) {
    return this.store.get(toKey(entry));
  }
}
```

**Note**: `Revision<State>` includes a `since` field that `State` doesn't have. The destructuring is meant to convert `Revision<State>` to `State` by removing the `since` field.

## Why the Destructuring Exists

The `since` field needs to be removed because:
1. `Heap` stores `Revision<State>` (includes `since` timestamp)
2. Consumers expect `State` (without `since`)
3. Current implementation removes `since` on every read

## Recommendations

### High Priority Fixes

#### 1. **Lazy Conversion with Caching**
Add a cache to store the converted State objects:

```typescript
class Heap {
  store: Map<string, Revision<State>> = new Map()
  stateCache: Map<string, State> = new Map()  // Cache converted states

  get(entry: BaseMemoryAddress): Revision<State> | undefined {
    const key = toKey(entry);
    return this.store.get(key);
  }
}

// In Replica.get():
get(entry: BaseMemoryAddress): State | undefined {
  const nurseryState = this.nursery.get(entry);
  if (nurseryState) return nurseryState;

  const key = toKey(entry);

  // Check cache first
  const cached = this.heap.stateCache?.get(key);
  if (cached) return cached;

  const heapState = this.heap.get(entry);
  if (heapState) {
    const { since: _since, ...state } = heapState;
    this.heap.stateCache?.set(key, state);  // Cache for future reads
    return state;
  }

  return undefined;
}
```

**Cache Invalidation**: Clear cached entry when heap is updated.

#### 2. **Structural Sharing**
If the `since` field is rarely accessed separately, consider:
- Keep `since` in the returned object
- Update consumers to ignore it
- Or use a Proxy to hide it without copying

#### 3. **Benchmark the Impact**
Create a benchmark to measure:
```typescript
Deno.bench("Cell get - from nursery (pending commit)", async () => {
  // Set value
  // Commit transaction
  // Read 1000x before sync completes
});

Deno.bench("Cell get - from heap (after sync)", async () => {
  // Set value
  // Commit transaction
  // Wait for sync
  // Read 1000x
});
```

### Medium Priority

#### 4. **Reduce Link Resolution Reads**
Consider caching resolved links to avoid repeated reads during link resolution.

#### 5. **Profile Real Workloads**
Use Chrome DevTools to profile actual patterns to see:
- How many reads happen per Cell.get()
- What % come from nursery vs heap
- Object allocation rates

## Questions for Further Investigation

1. **Why is `since` removed?**
   - Is it just to match the type signature?
   - Are there consumers that break if `since` is present?
   - Could we just leave it and update the types?

2. **Read frequency**:
   - How often is the same cell read multiple times?
   - Would a simple LRU cache be effective?

3. **Object size**:
   - What's the typical size of State objects?
   - Are we copying large nested objects?

## Test Coverage

Existing test: `packages/runner/test/pending-nursery.test.ts`
- Tests that nursery changes don't trigger subscriptions
- Could be extended to test performance characteristics

## Related Files

- `packages/runner/src/storage/cache.ts` - Nursery/Heap implementation
- `packages/runner/src/cell.ts` - Cell.get() implementation
- `packages/runner/src/link-resolution.ts` - Link resolution (multiple reads)
- `packages/runner/src/schema.ts` - validateAndTransform
- `packages/runner/src/storage/transaction/chronicle.ts` - Chronicle read path

## Conclusion

The performance issue is **NOT** specifically about reading from the nursery. In fact, nursery reads are fast. The issue is with **heap reads** which perform unnecessary object destructuring on every access. This affects all reads from committed, synced data.

**Primary Recommendation**: Implement a cache for converted State objects in the Heap class to avoid repeated destructuring operations.
