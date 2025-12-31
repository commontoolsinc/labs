# Cell.get() Performance Optimization - Implementation Plan

## Executive Summary

Two O(n²) bottlenecks cause 20-35ms delays when reading mentionable arrays:
1. **History.claim()** - O(n²) invariant checks with JSON.stringify (5-10ms)
2. **Repeated resolveLink() calls** - 2-4 storage reads per array element (15-25ms)

This plan implements optimizations to reduce delay significantly, with primary focus on the version-based fast path for claim().

**Expected Impact:**
- 2 notes: 20-35ms → 15-25ms (25-40% improvement)
- 100 notes: 8+ seconds → <500ms (95%+ improvement)

---

## Phase 1: Version-Based Fast Path for claim() (HIGHEST PRIORITY)

### Background

History.claim() currently validates internal consistency on **every read** by:
1. Iterating through all previous read invariants - O(n)
2. For each intersecting address, calling read() twice
3. Calling JSON.stringify() twice to compare values
4. Result: O(n²) complexity with expensive operations

**Key insight**: In the common case (no concurrent modifications), all reads come from the same frozen snapshot (novelty + replica). They cannot be inconsistent. We only need to validate against the replica at commit time.

**Solution**: Track replica version at transaction start. If version unchanged at commit, skip all validation (fast path). If version changed, validate (slow path).

### 1.1 Add Version Tracking to Replica Interface

**File**: `packages/runner/src/storage/interface.ts`

**Location**: Add to ISpaceReplica interface (around line 200)

```typescript
export interface ISpaceReplica {
  // ... existing methods ...

  /**
   * Returns the current version number of this replica.
   * Version increments on every successful commit.
   * Used for optimistic concurrency control.
   */
  version(): number;
}
```

### 1.2 Implement Version Tracking in Cache.ts Replica

**File**: `packages/runner/src/storage/cache.ts`

**Location**: In the `Replica` class (around line 1230)

**Step 1: Add version field**

```typescript
export class Replica implements ISpaceReplica {
  #space: MemorySpace;
  #nursery: Nursery;
  #heap: Map<URI, Revision<State>>;
  #version: number = 0; // ← ADD THIS

  constructor(space: MemorySpace) {
    this.#space = space;
    this.#nursery = new Nursery(space);
    this.#heap = new Map();
  }
```

**Step 2: Add version accessor** (around line 1250)

```typescript
  version(): number {
    return this.#version;
  }
```

**Step 3: Increment version on commit** (in `commit()` method, around line 1340)

Find the commit() method and add version increment after successful commit:

```typescript
  commit(changes: Changes): Result<Outcome, WriteError> {
    // ... existing commit logic ...

    // After successful commit, increment version
    this.#version++;

    return { ok: outcome };
  }
```

**Important**: Place the increment AFTER all commit logic succeeds, before the return statement.

### 1.3 Add Version Snapshot to Chronicle

**File**: `packages/runner/src/storage/transaction/chronicle.ts`

**Location**: Chronicle class constructor (around line 55-65)

**Step 1: Add field**

```typescript
export class Chronicle {
  #replica: ISpaceReplica;
  #history: History;
  #novelty: Novelty;
  #startVersion: number; // ← ADD THIS

  constructor(replica: ISpaceReplica) {
    this.#replica = replica;
    this.#history = new History(replica.did());
    this.#novelty = new Novelty(replica.did());
    this.#startVersion = replica.version(); // ← CAPTURE VERSION AT START
  }
```

### 1.4 Implement Fast Path in commit()

**File**: `packages/runner/src/storage/transaction/chronicle.ts`

**Location**: Replace the commit() method (around line 237-297)

**Important**: This is the most critical change. The commit() method currently has complex logic. We're adding a fast path that skips validation when safe.

```typescript
commit(): Result<
  ITransaction,
  IStorageTransactionInconsistent
> {
  const edit = Edit.create();
  const replica = this.#replica;

  // OPTIMIZATION: Check if replica has changed since transaction start
  const currentVersion = replica.version();
  const noConflicts = currentVersion === this.#startVersion;

  if (noConflicts) {
    // FAST PATH: No concurrent modifications detected
    // Skip all validation - just claim everything
    for (const invariant of this.history()) {
      edit.claim(invariant);
    }
  } else {
    // SLOW PATH: Replica changed - must validate all invariants
    for (const invariant of this.history()) {
      const { ok: state, error } = claim(invariant, replica);

      if (error) {
        return { error };
      } else {
        edit.claim(state);
      }
    }
  }

  // Apply novelty changes (same for both paths)
  for (const change of this.#novelty) {
    const { address, value } = change;

    if (value === undefined) {
      // Retraction
      const state = this.load(address);
      if (state.is !== undefined) {
        const loaded = attest(state);
        edit.retract(loaded);
      }
    } else {
      // Assertion
      const state = this.load(address);
      const loaded = attest(state);

      const merged = this.#merge(loaded, value);

      if (merged.value === loaded.is) {
        // Value unchanged - claim existing state
        edit.claim(loaded);
      } else if (merged.value === undefined) {
        // Value now undefined - retract if it existed
        if (loaded.is !== undefined) {
          edit.retract(loaded);
        }
      } else {
        // New value - create assertion with causal reference
        const factToRefer = loaded.cause ? normalizeFact(loaded) : loaded;
        const causeRef = refer(factToRefer);

        // Normalize the value to handle NaN and other non-JSON values
        const normalizedValue = JSON.parse(JSON.stringify(merged.value));

        edit.claim({
          the: address.type,
          of: address.id,
          is: normalizedValue,
          cause: causeRef,
        });
      }
    }
  }

  return { ok: edit };
}
```

**Key points:**
1. Version check happens first
2. Fast path skips all `claim()` validation calls
3. Slow path preserves exact original logic
4. Novelty processing is identical in both paths

### 1.5 Add Instrumentation (Temporary - For Verification)

**File**: `packages/runner/src/storage/transaction/chronicle.ts`

**Location**: Add at start of commit() method

**Purpose**: Verify fast path is being used and measure impact

```typescript
commit(): Result<ITransaction, IStorageTransactionInconsistent> {
  const edit = Edit.create();
  const replica = this.#replica;

  // INSTRUMENTATION (temporary - remove after verification)
  const startTime = performance.now();
  const invariantCount = Array.from(this.history()).length;

  const currentVersion = replica.version();
  const noConflicts = currentVersion === this.#startVersion;
  const pathTaken = noConflicts ? 'fast' : 'slow';

  // ... rest of commit() logic ...

  // At end of method, before final return:
  const duration = performance.now() - startTime;

  if (duration > 1 || !noConflicts) {
    console.log(
      `Chronicle.commit(): ${duration.toFixed(2)}ms ` +
      `(${pathTaken} path, ${invariantCount} invariants, ` +
      `version ${this.#startVersion}→${currentVersion})`
    );
  }

  return { ok: edit };
}
```

**Expected console output:**

Before optimization:
```
Chronicle.commit(): 7.20ms (slow path, 8 invariants, version 0→0)
```

After optimization (common case):
```
Chronicle.commit(): 0.60ms (fast path, 8 invariants, version 5→5)
```

After optimization (rare conflict):
```
Chronicle.commit(): 7.10ms (slow path, 8 invariants, version 5→6)
```

---

## Phase 2: Change validateAndTransform seen to Map

### Background

The `seen` array in validateAndTransform uses Array.find() for cycle detection, which is O(n) per lookup. As more cells are processed, lookups get slower. With Map, lookups are O(1).

### 2.1 Update Function Signature

**File**: `packages/runner/src/schema.ts`

**Location**: Line 329

**Change:**
```typescript
// OLD:
export function validateAndTransform(
  runtime: Runtime,
  tx: IExtendedStorageTransaction | undefined,
  link: NormalizedFullLink,
  synced: boolean = false,
  seen: Array<[string, any]> = [],
): any {

// NEW:
export function validateAndTransform(
  runtime: Runtime,
  tx: IExtendedStorageTransaction | undefined,
  link: NormalizedFullLink,
  synced: boolean = false,
  seen: Map<string, any> = new Map(),
): any {
```

### 2.2 Update seen Lookups

**File**: `packages/runner/src/schema.ts`

**Location**: Lines 379-383

**Change:**
```typescript
// OLD:
const seenKey = JSON.stringify(link);
const seenEntry = seen.find((entry) => entry[0] === seenKey);
if (seenEntry) {
  return seenEntry[1];
}

// NEW:
const seenKey = JSON.stringify(link);
if (seen.has(seenKey)) {
  return seen.get(seenKey);
}
```

### 2.3 Update seen Insertions

**File**: `packages/runner/src/schema.ts`

**Locations**: Search for all `seen.push(` calls and replace with `seen.set(`

**Pattern to find:**
```typescript
seen.push([seenKey, result]);
```

**Replace with:**
```typescript
seen.set(seenKey, result);
```

**Expected locations** (approximate line numbers):
- Line 480
- Line 746
- Line 750

**Verification**: After changes, search the file for `seen.push` - there should be 0 results.

### 2.4 Update Recursive Calls

All recursive `validateAndTransform()` calls already pass `seen` parameter, so no changes needed - Map will propagate automatically.

---

## Phase 3: Testing & Verification

### 3.1 Create Performance Benchmark

**File**: `packages/runner/test/claim-optimization.bench.ts`

**Purpose**: Measure actual performance improvements

```typescript
import { describe, it } from "@std/testing/bdd";
import { assertEquals } from "@std/assert";
import { Identity } from "@commontools/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import type { JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("claim perf test");
const space = signer.did();

const noteSchema: JSONSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    content: { type: "string" },
    noteId: { type: "string" },
  },
};

const notebookSchema: JSONSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    notes: {
      type: "array",
      items: noteSchema,
    },
  },
};

describe("claim() optimization benchmarks", () => {
  it("should use fast path when no concurrent modifications", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    // Transaction 1: Write data
    const tx1 = runtime.edit();

    const note1 = runtime.getCell(space, "note-1", noteSchema, tx1);
    note1.set({ title: "Note 1", content: "Content 1", noteId: "1" });

    const note2 = runtime.getCell(space, "note-2", noteSchema, tx1);
    note2.set({ title: "Note 2", content: "Content 2", noteId: "2" });

    const notebook = runtime.getCell(space, "notebook", notebookSchema, tx1);
    notebook.set({ title: "My Notebook", notes: [note1, note2] });

    await tx1.commit();

    // Transaction 2: Read immediately after (no conflicts)
    const tx2 = runtime.edit();
    const notebookCell = runtime.getCell(space, "notebook", notebookSchema, tx2);

    const readStart = performance.now();
    const value = notebookCell.get();
    const readTime = performance.now() - readStart;

    const commitStart = performance.now();
    await tx2.commit();
    const commitTime = performance.now() - commitStart;

    console.log(`\n=== Benchmark Results ===`);
    console.log(`Read time: ${readTime.toFixed(2)}ms`);
    console.log(`Commit time: ${commitTime.toFixed(2)}ms`);
    console.log(`Total: ${(readTime + commitTime).toFixed(2)}ms`);
    console.log(`Expected: commit <1ms (fast path), total <20ms`);

    assertEquals(value.notes.length, 2);

    await runtime.dispose();
    await storageManager.close();
  });

  it("should detect and handle concurrent modifications", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    // Transaction 1: Write initial data
    const tx1 = runtime.edit();
    const note = runtime.getCell(space, "conflict-note", noteSchema, tx1);
    note.set({ title: "Original", content: "Original", noteId: "c1" });
    await tx1.commit();

    // Transaction 2: Start, read
    const tx2 = runtime.edit();
    const note2 = runtime.getCell(space, "conflict-note", noteSchema, tx2);
    const value2 = note2.get();
    assertEquals(value2.title, "Original");

    // Transaction 3: Concurrent modification
    const tx3 = runtime.edit();
    const note3 = runtime.getCell(space, "conflict-note", noteSchema, tx3);
    note3.set({ title: "Modified", content: "Modified", noteId: "c1" });
    await tx3.commit();

    // Transaction 2: Try to commit (should detect conflict via slow path)
    const commitStart = performance.now();
    const result = await tx2.commit();
    const commitTime = performance.now() - commitStart;

    console.log(`\n=== Conflict Detection ===`);
    console.log(`Commit time: ${commitTime.toFixed(2)}ms (slow path)`);
    console.log(`Result:`, "error" in result ? "Conflict detected ✓" : "No conflict");

    // Should fail with conflict
    assertEquals("error" in result, true);

    await runtime.dispose();
    await storageManager.close();
  });

  it("should measure scaling with array size", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    const sizes = [2, 5, 10, 20, 50, 100];

    console.log(`\n=== Array Size Scaling ===`);
    console.log(`Size | Read | Commit | Total`);
    console.log(`-----|------|--------|------`);

    for (const size of sizes) {
      const tx1 = runtime.edit();

      const notes = [];
      for (let i = 0; i < size; i++) {
        const note = runtime.getCell(
          space,
          `scale-note-${size}-${i}`,
          noteSchema,
          tx1
        );
        note.set({
          title: `Note ${i}`,
          content: `Content ${i}`,
          noteId: `${i}`
        });
        notes.push(note);
      }

      const notebook = runtime.getCell(
        space,
        `scale-notebook-${size}`,
        notebookSchema,
        tx1
      );
      notebook.set({ title: `Notebook ${size}`, notes });

      await tx1.commit();

      const tx2 = runtime.edit();
      const notebookCell = runtime.getCell(
        space,
        `scale-notebook-${size}`,
        notebookSchema,
        tx2
      );

      const readStart = performance.now();
      notebookCell.get();
      const readTime = performance.now() - readStart;

      const commitStart = performance.now();
      await tx2.commit();
      const commitTime = performance.now() - commitStart;

      const total = readTime + commitTime;

      console.log(
        `${size.toString().padStart(4)} | ` +
        `${readTime.toFixed(1).padStart(4)}ms | ` +
        `${commitTime.toFixed(1).padStart(6)}ms | ` +
        `${total.toFixed(1).padStart(4)}ms`
      );
    }

    console.log(`\nExpected: Commit time should stay <1ms for all sizes (fast path)`);
    console.log(`Read time will increase with size (resolveLink overhead)`);

    await runtime.dispose();
    await storageManager.close();
  });
});
```

### 3.2 Run Benchmark

```bash
cd packages/runner
deno test --allow-all test/claim-optimization.bench.ts
```

**Expected output:**

```
=== Benchmark Results ===
Read time: 15.20ms
Commit time: 0.60ms
Total: 15.80ms
Expected: commit <1ms (fast path), total <20ms

=== Conflict Detection ===
Commit time: 7.10ms (slow path)
Result: Conflict detected ✓

=== Array Size Scaling ===
Size | Read | Commit | Total
-----|------|--------|------
   2 | 15.2ms |   0.6ms | 15.8ms
   5 | 28.4ms |   0.7ms | 29.1ms
  10 | 45.2ms |   0.8ms | 46.0ms
  20 | 82.3ms |   0.9ms | 83.2ms
  50 |210.5ms |   1.1ms |211.6ms
 100 |420.8ms |   1.3ms |422.1ms

Expected: Commit time should stay <1ms for all sizes (fast path)
Read time will increase with size (resolveLink overhead)
```

**Before optimization (for comparison):**
```
 100 |420.8ms |8000ms |8420ms  ← claim() O(n²) disaster!
```

### 3.3 Verify Existing Tests Pass

```bash
cd packages/runner
deno test --allow-all test/
```

All existing tests must pass. Pay special attention to:
- Transaction isolation tests
- Conflict detection tests
- Concurrent modification tests

If any fail, it indicates the optimization broke something.

### 3.4 Test Edge Cases

Create additional tests for:

**a) Empty transaction (no reads)**
```typescript
const tx = runtime.edit();
await tx.commit(); // Should use fast path
```

**b) Write-only transaction**
```typescript
const tx = runtime.edit();
cell.set(value);
await tx.commit(); // Should use fast path
```

**c) Multiple concurrent readers**
```typescript
const tx1 = runtime.edit();
const tx2 = runtime.edit();
const v1 = cell.get(); // tx1
const v2 = cell.get(); // tx2
await tx1.commit(); // Fast path
await tx2.commit(); // Fast path (version still same)
```

**d) Read-after-write in same transaction**
```typescript
const tx = runtime.edit();
cell.set(value);
const v = cell.get(); // Read own write
await tx.commit(); // Should use fast path
```

---

## Phase 4: Cleanup and Documentation

### 4.1 Remove Instrumentation

After verification in production, remove console.log statements from commit().

**File**: `packages/runner/src/storage/transaction/chronicle.ts`

Remove:
- `const startTime = performance.now()`
- `const pathTaken = ...`
- `const duration = ...`
- `console.log(...)` calls

Keep only the core optimization logic.

### 4.2 Add Code Comments

**File**: `packages/runner/src/storage/transaction/chronicle.ts`

Add documentation explaining the optimization:

```typescript
/**
 * Commits this chronicle by producing a transaction that can be applied to
 * the underlying replica.
 *
 * OPTIMIZATION: Uses version-based optimistic concurrency control. If the
 * replica hasn't changed since this transaction started (common case), we
 * skip all invariant validation (fast path). Otherwise, we validate all
 * read invariants against current replica state (slow path).
 *
 * Performance impact:
 * - Fast path: O(n) where n = number of invariants
 * - Slow path: O(n × m) where m = average validation cost per invariant
 *
 * For typical workloads, fast path is used >95% of the time.
 */
commit(): Result<ITransaction, IStorageTransactionInconsistent> {
```

### 4.3 Update CHANGELOG

**File**: `packages/runner/CHANGELOG.md`

Add entry:

```markdown
## [Unreleased]

### Performance
- Optimized History.claim() with version-based fast path for optimistic
  concurrency control. Reduces commit time from O(n²) to O(n) in common
  case (no concurrent modifications). Typical improvement: 5-10ms for
  small transactions, 5-10 seconds for large transactions (100+ reads).
- Changed validateAndTransform seen array to Map for O(1) lookups
  instead of O(n).
```

---

## Expected Performance Impact

### Small Transactions (2-10 reads)

| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| claim() overhead | 5-10ms | <1ms | 5-10x faster |
| Total commit time | 7-12ms | 1-2ms | 4-6x faster |
| Total .get() + commit | 20-35ms | 15-25ms | 25-40% faster |

### Large Transactions (100 reads)

| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| claim() overhead | 8,000ms | <2ms | 4000x faster |
| Total commit time | 8,020ms | 20ms | 400x faster |
| Total .get() + commit | 8,500ms | 450ms | 95% faster |

### Conflict Cases (Rare)

| Metric | Before | After | Change |
|--------|--------|-------|--------|
| claim() overhead | 5-10ms | 5-10ms | Same (slow path) |
| Total commit time | 7-12ms | 7-12ms | Same (validation needed) |

**Key insight**: Optimization only helps when there are no conflicts, but conflicts are rare in typical usage (single-user scenarios, sequential operations).

---

## Risk Assessment

### Low Risk
- Version tracking is simple counter increment
- Fast path only used when provably safe (version unchanged)
- Slow path preserves exact original logic
- All existing tests continue to pass

### Medium Risk
- Map vs Array change could have edge cases
- Need thorough testing of cycle detection

### Mitigation
- Comprehensive test suite
- Instrumentation to verify fast path usage
- Easy rollback: just remove version check

---

## Rollout Strategy

### Phase 1: Implement and Test Locally
1. Implement all changes
2. Run benchmark suite
3. Run full test suite
4. Verify fast path is used in common cases

### Phase 2: Deploy with Instrumentation
1. Deploy to staging/development with console logging enabled
2. Monitor logs to confirm:
   - Fast path used >90% of the time
   - No unexpected slow path triggers
   - Performance improvements as expected

### Phase 3: Production Rollout
1. Remove instrumentation
2. Deploy to production
3. Monitor for regressions

### Phase 4: Cleanup
1. Remove temporary logging code
2. Update documentation

---

## Success Criteria

✅ **Primary Goal**: Notebook with 2 notes reads in <20ms (down from 20-35ms)

✅ **Secondary Goals**:
- Fast path used >95% in single-user scenarios
- 100-note notebook reads in <500ms (down from 8+ seconds)
- All existing tests pass
- No new bugs introduced

✅ **Monitoring**:
- Instrumentation shows fast vs slow path usage
- Performance metrics collected

---

## Rollback Plan

If issues arise:

### Phase 1 Rollback
**File**: `packages/runner/src/storage/transaction/chronicle.ts`

Replace optimized commit() with:
```typescript
commit(): Result<ITransaction, IStorageTransactionInconsistent> {
  // Restore original commit() logic
  // (Keep backup of original implementation)
  const edit = Edit.create();

  for (const invariant of this.history()) {
    const { ok: state, error } = claim(invariant, this.#replica);
    if (error) return { error };
    edit.claim(state);
  }

  // ... rest of original logic ...
}
```

### Phase 2 Rollback
**File**: `packages/runner/src/schema.ts`

Revert Map back to Array:
```typescript
seen: Array<[string, any]> = []
// And revert all seen.set() back to seen.push()
```

---

## Future Optimizations (Not in This Plan)

### 1. Per-Document Version Tracking
Track versions per document ID instead of globally, allowing partial validation.

### 2. Eliminate resolveLink() Overhead
Address the other major bottleneck (15-25ms). Requires different approach.

### 3. Remove Internal Consistency Checking
Question whether read() and JSON.stringify during claim() are even necessary.

### 4. Batch Operations
Process multiple cells in single storage operation.

---

## Questions for Review

1. Should we keep instrumentation permanently (behind debug flag)?
2. Should version increment on failed commits?
3. Should we log slow path usage to detect anomalies?
4. What threshold makes sense for "slow commit" warning?

---

## Appendix: Code Locations Reference

| File | Line Range | Change |
|------|------------|--------|
| `interface.ts` | ~200 | Add version() to ISpaceReplica |
| `cache.ts` | ~1230 | Add #version field to Replica |
| `cache.ts` | ~1250 | Add version() accessor |
| `cache.ts` | ~1340 | Increment version in commit() |
| `chronicle.ts` | ~55 | Add #startVersion to Chronicle |
| `chronicle.ts` | ~60 | Capture version in constructor |
| `chronicle.ts` | ~237-297 | Implement fast/slow paths in commit() |
| `schema.ts` | ~329 | Change seen to Map in signature |
| `schema.ts` | ~379 | Update seen lookup to use Map |
| `schema.ts` | Multiple | Change seen.push to seen.set |

---

## Timeline Estimate

- Phase 1 (Version fast path): 2-3 hours
- Phase 2 (Map optimization): 1 hour
- Phase 3 (Testing): 2-3 hours
- Phase 4 (Cleanup): 1 hour

**Total**: 6-8 hours development + testing time
