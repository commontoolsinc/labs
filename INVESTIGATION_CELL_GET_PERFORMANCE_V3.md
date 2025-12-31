# Cell.get() Performance Investigation V3 - SMOKING GUN

## Discovery

Found the likely root cause! In `packages/runner/src/cell.ts:527`:

```typescript
get(): Readonly<T> {
  if (!this.synced) this.sync(); // No await, just kicking this off
  return validateAndTransform(this.runtime, this.tx, this.link, this.synced);
}
```

**The problem**: `sync()` is called but **NOT awaited**. The comment even acknowledges this: "No await, just kicking this off".

## What sync() Does

```typescript
sync(): Promise<Cell<T>> | Cell<T> {
  this.synced = true;
  if (this.link.id.startsWith("data:")) {
    return this as unknown as Cell<T>;
  }
  return this.runtime.storageManager.syncCell<T>(this as unknown as Cell<T>);
}

async syncCell<T>(cell: Cell<T>): Promise<Cell<T>> {
  const { space, id, schema, rootSchema } = cell.getAsNormalizedFullLink();
  if (!space) throw new Error("No space set");
  const storageProvider = this.open(space);

  const selector = /* ... build selector ... */;

  await storageProvider.sync(id, selector);  // ← ASYNC NETWORK/IDB OPERATION!
  return cell;
}
```

This can trigger:
- **Network fetches** from the server
- **IndexedDB reads** from local cache
- **Async operations** that take milliseconds

## The In-Flight Data Scenario

When you read a structure with 10 docs while commits are in flight:

1. **Root cell**: `root.get()` called
2. **Root triggers sync()**: fires off but doesn't wait
3. **validateAndTransform** runs immediately
4. **Resolves child references**: finds 10 child cells
5. **Each child Cell created**: not synced yet
6. **Each child.get()**: triggers another sync()
7. **10 sync() calls fire**: all async, all in parallel
8. **Each sync()** may trigger:
   - Check if in nursery (fast if there)
   - Check if in heap (needs to wait if not)
   - Trigger `workspace.load()` (async IDB/network)
9. **Data access blocks**: when validateAndTransform tries to read the data, it must wait for pending I/O

**Result**: 10 docs × 2-5ms per async operation = 20-50ms total

## Why Benchmarks Are Fast

In `cell.bench.ts`:

```typescript
const tx = runtime.edit();
const cell = runtime.getCell<number>(space, "bench-get", undefined, tx);
cell.set(42);

// Reads happen BEFORE commit
for (let i = 0; i < 1000; i++) {
  cell.get();
}

await cleanup(runtime, storageManager, tx);  // Commit happens AFTER reads
```

- All reads happen **inside the transaction**
- Data is in the transaction's **working copy** (Chronicle)
- No sync() needed → `this.synced` is false but data is already there
- No network, no IDB, everything is in memory
- **Fast!**

## The Difference

**Benchmark scenario**:
```
set() → data in tx working copy
get() → reads from tx (no sync needed)
get() → reads from tx (no sync needed)
commit() → moves to nursery/network
```

**User's scenario**:
```
set() → data in tx working copy
commit() → moves to nursery, network request starts
get() → sync() fires (async), tries to read
  ├─ root doc in nursery (fast)
  ├─ child1 referenced → sync() → may need load → IDB/network
  ├─ child2 referenced → sync() → may need load → IDB/network
  ├─ child3 referenced → sync() → may need load → IDB/network
  └─ ... 7 more children, each triggering async operations
→ Total time = sum of all async waits
```

## Why "In Flight" Data Is Slow

"In flight" means:
- Data was committed → in nursery
- Network request to server in progress
- Other referenced docs might be:
  - ✅ In nursery (if part of same commit)
  - ❌ Not in heap yet (if not yet synced from server)
  - → Need to be loaded → triggers async I/O

When you have **partial data availability**:
- Some docs in nursery (fast path)
- Some docs need loading (slow path via async)
- Each missing doc triggers its own async load
- All those async operations add up

## Evidence

1. **Non-awaited sync()**: Lines 527, 540, 595, 643, 696, 880, 945, 971, 1014, 1031, 1066, 1096 in cell.ts all call sync() without awaiting

2. **workspace.load() is async**: Can trigger network or IDB operations

3. **User observation**: "cell.bench.ts tests similar complexity and is pretty fast" → Because benchmarks read before commit!

4. **User observation**: "20ms for fairly simple structure spanning maybe 10 docs" → If each doc's sync takes 2ms and some aren't cached, 10 docs × 2ms = 20ms

## The Fix

Several possible approaches:

### Option 1: Await sync() in get()
```typescript
async get(): Promise<Readonly<T>> {
  if (!this.synced) await this.sync();
  return validateAndTransform(this.runtime, this.tx, this.link, this.synced);
}
```
**Problem**: Makes get() async, breaks existing API

### Option 2: Batch sync calls
Before resolving child cells, sync them all in parallel:
```typescript
const childCells = extractChildCells(value);
await Promise.all(childCells.map(c => c.sync()));
```

### Option 3: Read-ahead/prefetch
When committing, mark all referenced docs as needing sync, and batch-load them

### Option 4: Synchronous reads fallback
Make sync() populate a cache, then reads can proceed synchronously:
```typescript
sync() {
  // Trigger async load, but don't wait
  this.loadPromise = this.actuallySync();
  this.synced = true;
}

get() {
  if (!this.synced) this.sync();

  // Try to read synchronously
  const value = tryReadSync(this.link);
  if (value !== undefined) return value;

  // If not available, we have to wait
  await this.loadPromise;
  return readSync(this.link);
}
```
**Problem**: Still makes get() potentially async

### Option 5: Eager nursery population
When committing a transaction, automatically add all referenced docs to nursery if they're in the same transaction

## Recommended Fix

**Two-phase approach**:

1. **Short term**: Add caching to avoid redundant loads
   - Cache resolved links
   - Cache loaded data from workspace.load()
   - Prevents same doc from triggering multiple sync() calls

2. **Medium term**: Batch sync operations
   - When reading nested structure, collect all cell refs first
   - Sync them all in parallel with `Promise.all()`
   - Then proceed with synchronous reads

3. **Long term**: Consider read-ahead hints
   - Allow marking cells that will be needed soon
   - Pre-load them in background
   - By the time get() is called, data is ready

## Test Plan

Created `in-flight-data-performance.test.ts` to verify:
1. Read performance before vs after commit
2. Count of sync() calls during nested read
3. Verify sync() is not awaited

This test should show the performance difference and confirm the hypothesis.
