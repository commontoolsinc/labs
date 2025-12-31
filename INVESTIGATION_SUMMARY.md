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

## Current Status: NEEDS MORE INFO

The investigation has identified several potential issues but none fully explain:
- Why 20ms with just 2 entries
- How async network waits block synchronous `get()` calls
- What specifically about "mentionables schemas" is slow

## Questions for User

1. **How are you calling get()?**
   - Just `cell.get()`?
   - Or `await cell.sync()` then `cell.get()`?
   - Or something else?

2. **Have you profiled with timestamps?**
   - Can you add `console.time()` around the specific `get()` call?
   - Can you confirm it's the get() itself, not something before/after?

3. **What is "mentionables schema"?**
   - Is it a complex schema with many properties?
   - Does it use `asCell` or other special annotations?
   - Can you share the schema?

4. **When exactly is it slow?**
   - Only when commit is still in flight to server?
   - Or even after server responds?
   - What if you add a 100ms delay between commit and read?

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
