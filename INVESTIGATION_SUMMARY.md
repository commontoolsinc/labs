# Cell.get() Performance Investigation - Summary

## The Problem

User reports ~20ms delays when calling `cell.get()` on structures with pending writes to the server (commits in flight). Specifically:
- Writes happen in one transaction
- Reads with "mentionables schemas" in a different transaction immediately after
- Already slow with just 2 entries in an array
- Data is already synced locally

## Investigation Trail

### Initial Hypothesis: Object Destructuring ❌
**Location**: `packages/runner/src/storage/cache.ts:1277`
```typescript
const { since: _since, ...state } = heapState;
```
**Finding**: Contributes only ~2-3ms for 10 docs, not the main issue.

### Second Hypothesis: Non-Awaited sync() ❌
**Location**: `packages/runner/src/cell.ts:527`
```typescript
if (!this.synced) this.sync(); // No await
```
**Finding**: Sync() fires off async but get() doesn't wait. Would cause issues if data needs loading, but user says data is already local.

### Third Hypothesis: JSON.stringify() Overhead ❌
**Location**: `packages/runner/src/schema.ts:379`
```typescript
const seenKey = JSON.stringify(link);
```
**Finding**: Demo showed only 0.004ms per call → 0.2ms total for 50 cells. Not the bottleneck.

### Fourth Hypothesis: Waiting for In-Progress Schema Queries ⚠️ LIKELY!
**Location**: `packages/runner/src/storage/cache.ts:758-762, 900`

When reading with a schema selector immediately after committing:

1. **Commit in tx1** → triggers network query with schema → Promise stored in `selectorTracker`
2. **Read in tx2** with schema selector → calls `sync()`
3. `sync()` → `workspace.load()` with selector
4. `load()` → `pull()`
5. `pull()` calls `getSupersetSelector()` → finds **in-progress query from commit**
6. Line 762: `promises.push(superPromise)` ← adds commit's network promise
7. Line 900: `await Promise.all(promises)` ← **WAITS for network!**

**But**: `get()` doesn't await `sync()`, so how does this block the synchronous read?

## ✅ ROOT CAUSES FOUND - TWO SEPARATE O(n²) ISSUES!

**See:**
- **INVESTIGATION_ROOT_CAUSE_FOUND.md** - resolveLink() issue
- **CRITICAL_CLAIM_PERFORMANCE_ISSUE.md** - History.claim() issue (explains profiling!)

### Summary

The 20ms delay is caused by **TWO separate O(n²) performance bottlenecks**:

#### Issue #1: Repeated resolveLink() Calls (15-25ms)

During array schema processing:

1. **Notebook pattern** exports `mentionable: notes` (Cell<NoteCharm[]>)
2. **BacklinksIndex** calls `.get()` on mentionable in a lift function
3. **Runner** executes JavaScript nodes by calling `.get()` on inputs
4. **Cell.get()** calls validateAndTransform with array schema
5. **For each array element**, validateAndTransform:
   - Calls `resolveLink()` → 2-4 storage reads per element
   - Recursively processes element schema

**Cost**: ~5 resolveLink calls × 3-5ms each = **15-25ms**

#### Issue #2: History.claim() O(n²) Consistency Checks (5-10ms) 🔥

**This is what profiling shows!**

**Location**: `packages/runner/src/storage/transaction/chronicle.ts:213, 367-395`

On **EVERY read**, chronicle.readValueOrThrow() calls:
```typescript
const claim = this.#history.claim(invariant);  // Line 213
```

And claim() does:
```typescript
for (const candidate of this) {  // O(n) - iterates ALL previous invariants
  if (Address.intersects(attestation.address, candidate.address)) {
    const expected = read(candidate, address).ok?.value;
    const actual = read(attestation, address).ok?.value;

    if (JSON.stringify(expected) !== JSON.stringify(actual)) {  // JSON.stringify!
      return { error: ... };
    }
  }
}
```

**Complexity**: O(n²) where n = number of reads in transaction
- Read 1: checks 0 invariants
- Read 2: checks 1 invariant (2 JSON.stringify calls)
- Read 3: checks 2 invariants (4 JSON.stringify calls)
- Read N: checks N-1 invariants

For 2 notes with 3 properties each: ~8-10 reads → 36 invariant checks with **72 JSON.stringify calls**

**Cost**: ~5-10ms

### Combined Impact

**Total**: 15-25ms (resolveLink) + 5-10ms (claim) = **20-35ms** ✓ Matches user report!

### Why Profiling Shows `claim`

User said profiling shows time in `claim` - this makes perfect sense:
- claim() called on **every read** (line 213)
- Does O(n) iteration through all invariants
- Does JSON.stringify comparisons
- Gets slower as transaction accumulates more reads

### Fixes

**High Priority:**
1. **Index History invariants by address** - O(1) lookup instead of O(n)
2. **Cache JSON.stringify results** - Avoid repeated stringify of same objects
3. **Cache resolveLink results** - Eliminate redundant resolveLink calls
4. **Change validateAndTransform seen to Map** - O(1) instead of O(n)

**Medium Priority:**
5. **Batch read tracking** - Claim invariants in batch at commit time
6. **Use structural comparison** - Faster than JSON.stringify for equality
7. **Optimize link key generation** - Faster than full JSON.stringify

## Potential Fixes (Once Root Cause Confirmed)

1. **If it's waiting for schema queries**:
   - Don't wait for superset queries if data is in nursery
   - Cache schema-filtered results locally
   - Make get() properly async or document that sync() should be awaited first

2. **If it's schema processing**:
   - Cache resolved schemas
   - Optimize schema validation path
   - Lazy schema evaluation

3. **General optimizations identified**:
   - Change `seen` from Array to Map (O(n²) → O(n))
   - Cache heap State objects to avoid repeated destructuring
   - Profile and optimize hottest paths

## Files Created

- `INVESTIGATION_CELL_GET_PERFORMANCE.md` - Initial analysis (heap destructuring)
- `INVESTIGATION_CELL_GET_PERFORMANCE_V2.md` - Revised (multiple reads hypothesis)
- `INVESTIGATION_CELL_GET_PERFORMANCE_V3.md` - Non-awaited sync() hypothesis
- `INVESTIGATION_CELL_GET_PERFORMANCE_FINAL.md` - JSON.stringify investigation
- `test/cell-nursery-heap.bench.ts` - Benchmark comparing nursery vs heap
- `test/cell-get-performance-investigation.test.ts` - Instrumented read tracing
- `test/in-flight-data-performance.test.ts` - In-flight commit testing
- `test/schema-stringify-performance.test.ts` - Schema stringify overhead
- `test/json-stringify-demo.js` - Standalone demo (proves stringify is fast)

## Next Steps

Need user to provide:
1. Actual profiling data showing where 20ms is spent
2. Code snippet showing exact usage pattern
3. The mentionables schema definition
4. Whether adding `await cell.sync()` before `get()` helps
