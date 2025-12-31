# Cell.get() Performance Investigation V2

## User Feedback

Initial investigation focused on object destructuring in heap reads, but user reports 20ms for reading a "fairly simple structure spanning maybe 10 docs" - destructuring alone can't explain that delay.

## Hypothesis: Multiple Reads Per Document

When reading a structure with 10 documents, each document may trigger:
1. Multiple reads during link resolution (2-4 per doc)
2. Schema validation/transformation
3. Proxy/Cell object creation

**Calculation**: 10 docs × 3 reads/doc = 30 read operations
- Even at 0.5-1ms per read operation = 15-30ms total

## Key Questions

1. **How many read operations happen per Cell.get()?**
   - Need to trace actual read count
   - Is link resolution doing redundant work?

2. **What's the per-read overhead?**
   - Transaction layer
   - Chronicle read
   - Replica.get() from nursery/heap Maps
   - Schema processing

3. **Mixed nursery/heap scenario**
   - User said "some recently changed"
   - Does reading from mixed sources add overhead?
   - Any synchronization/locking issues?

4. **Caching effectiveness**
   - Are resolved links cached?
   - Are schemas cached?
   - What about repeated reads?

## Investigation Plan

### 1. Measure Read Count
Created test: `cell-get-performance-investigation.test.ts`
- Instruments transaction reads to count operations
- Measures time per read
- Tests nursery vs heap vs mixed scenarios

### 2. Profile the Read Path
Need to identify bottlenecks in:
- `resolveLink()` - does multiple probes
- `validateAndTransform()` - schema processing
- Transaction/Chronicle/Replica stack

### 3. Look for Blocking Operations
- Any synchronous network calls?
- IDB operations should be async - are they?
- Any mutex/lock contention?

## Potential Issues

### A. Link Resolution Overhead
`resolveLink()` in link-resolution.ts:63-200:
- Line 97: Sigil probe at full path
- Line 110: Read full value for reactivity
- Line 137: Parent sigil probe  
- Line 143: Read parent value

**For nested structure with 10 docs**, this could mean:
- 10 docs × 2-4 reads = 20-40 read operations
- Each read goes through full stack

### B. No Link Cache
Every Cell.get() resolves links from scratch
- No caching of resolved links
- Same paths resolved multiple times
- Could explain linear slowdown with depth

### C. Schema Processing
`validateAndTransform()` processes schema for each value:
- Resolves schema refs
- Validates types
- Creates Cell objects for nested data
- May recursively process children

### D. Object Allocation
Creating many intermediate objects:
- Cell instances
- Proxies for OpaqueRef
- Schema copies
- Link objects

## Next Steps

1. Run the instrumented test to get actual read counts
2. Profile with real data matching user's 10-doc scenario
3. Look for hot paths in Chrome DevTools
4. Consider adding:
   - Link resolution cache
   - Schema cache
   - Read coalescing for batch operations

## Still Possible: Heap Destructuring Impact

While 20ms can't be explained by destructuring alone, it could contribute:
- 10 docs × 3 reads × 0.1ms destructuring = 3ms
- Not the main issue, but worth fixing

## User's Scenario

"fairly simple structure spanning maybe 10 docs, some of them recently changed"

This suggests:
- Root object with refs to other objects
- Some objects in nursery (recent changes)
- Some objects in heap (older, synced data)
- No obvious reason for 20ms unless:
  - Many redundant reads
  - Expensive per-read operations
  - Or something we haven't discovered yet

