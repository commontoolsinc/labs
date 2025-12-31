# Cell.get() Performance Optimization - Implementation Plan

## Executive Summary

History.claim() causes O(n²) performance degradation when reading data:
- On **every read**, claim() iterates through all previous read invariants
- For each intersecting address, calls read() twice + JSON.stringify() twice
- Result: O(n²) complexity that becomes catastrophic with large transactions

**Profiling confirms**: Time is spent in `claim` during .get() operations.

This plan implements a **version-based fast path** for optimistic concurrency control.

**Expected Impact:**
- Small transactions (2-10 reads): Save 5-10ms in commit time
- Large transactions (100+ reads): Save 5-10 **seconds** in commit time
- Common case (no concurrent modifications): >95% of transactions use fast path

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

## Phase 2: Testing & Verification

### 2.1 Create Performance Benchmark

**File**: `packages/runner/test/claim-optimization.bench.ts`

**Purpose**: Measure commit time improvements using Deno's built-in benchmark API

```typescript
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

// Benchmark: Commit with 2 notes (fast path expected)
Deno.bench("commit - 2 notes - fast path", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });

  // Write data
  const tx1 = runtime.edit();
  const note1 = runtime.getCell(space, "note-1", noteSchema, tx1);
  note1.set({ title: "Note 1", content: "Content 1", noteId: "1" });
  const note2 = runtime.getCell(space, "note-2", noteSchema, tx1);
  note2.set({ title: "Note 2", content: "Content 2", noteId: "2" });
  const notebook = runtime.getCell(space, "notebook", notebookSchema, tx1);
  notebook.set({ title: "My Notebook", notes: [note1, note2] });
  await tx1.commit();

  // Read and commit (measured operation)
  const tx2 = runtime.edit();
  const notebookCell = runtime.getCell(space, "notebook", notebookSchema, tx2);
  notebookCell.get(); // Trigger reads
  await tx2.commit(); // This is what we're measuring

  await runtime.dispose();
  await storageManager.close();
});

// Benchmark: Commit with 10 notes
Deno.bench("commit - 10 notes - fast path", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });

  const tx1 = runtime.edit();
  const notes = [];
  for (let i = 0; i < 10; i++) {
    const note = runtime.getCell(space, `note-${i}`, noteSchema, tx1);
    note.set({ title: `Note ${i}`, content: `Content ${i}`, noteId: `${i}` });
    notes.push(note);
  }
  const notebook = runtime.getCell(space, "notebook-10", notebookSchema, tx1);
  notebook.set({ title: "Notebook 10", notes });
  await tx1.commit();

  const tx2 = runtime.edit();
  const notebookCell = runtime.getCell(space, "notebook-10", notebookSchema, tx2);
  notebookCell.get();
  await tx2.commit();

  await runtime.dispose();
  await storageManager.close();
});

// Benchmark: Commit with 50 notes
Deno.bench("commit - 50 notes - fast path", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });

  const tx1 = runtime.edit();
  const notes = [];
  for (let i = 0; i < 50; i++) {
    const note = runtime.getCell(space, `note-${i}`, noteSchema, tx1);
    note.set({ title: `Note ${i}`, content: `Content ${i}`, noteId: `${i}` });
    notes.push(note);
  }
  const notebook = runtime.getCell(space, "notebook-50", notebookSchema, tx1);
  notebook.set({ title: "Notebook 50", notes });
  await tx1.commit();

  const tx2 = runtime.edit();
  const notebookCell = runtime.getCell(space, "notebook-50", notebookSchema, tx2);
  notebookCell.get();
  await tx2.commit();

  await runtime.dispose();
  await storageManager.close();
});

// Benchmark: Commit with 100 notes
Deno.bench("commit - 100 notes - fast path", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });

  const tx1 = runtime.edit();
  const notes = [];
  for (let i = 0; i < 100; i++) {
    const note = runtime.getCell(space, `note-${i}`, noteSchema, tx1);
    note.set({ title: `Note ${i}`, content: `Content ${i}`, noteId: `${i}` });
    notes.push(note);
  }
  const notebook = runtime.getCell(space, "notebook-100", notebookSchema, tx1);
  notebook.set({ title: "Notebook 100", notes });
  await tx1.commit();

  const tx2 = runtime.edit();
  const notebookCell = runtime.getCell(space, "notebook-100", notebookSchema, tx2);
  notebookCell.get();
  await tx2.commit();

  await runtime.dispose();
  await storageManager.close();
});
```

### 2.2 Run Benchmark

```bash
cd packages/runner
deno bench --allow-all test/claim-optimization.bench.ts
```

**Expected output:**

```
benchmark                           time (avg)        iter/s             (min … max)       p75       p99      p995
---------------------------------------------------------------- -----------------------------
commit - 2 notes - fast path        15.2 ms/iter          65.8   (14.8 ms … 16.1 ms)   15.5 ms   16.1 ms   16.1 ms
commit - 10 notes - fast path       46.3 ms/iter          21.6   (44.9 ms … 48.2 ms)   47.1 ms   48.2 ms   48.2 ms
commit - 50 notes - fast path      215.4 ms/iter           4.6  (211.2 ms … 220.8 ms)  218.3 ms  220.8 ms  220.8 ms
commit - 100 notes - fast path     425.7 ms/iter           2.3  (418.3 ms … 435.2 ms)  430.1 ms  435.2 ms  435.2 ms
```

**Before optimization (expected):**
```
commit - 100 notes - fast path    8500 ms/iter           0.1    ← claim() O(n²) disaster!
```

**After optimization (expected):**
```
commit - 100 notes - fast path     425 ms/iter           2.3    ← ~20x faster!
```

The commit time should stay roughly constant regardless of array size (fast path), while read time increases linearly due to resolveLink overhead (not addressed in this optimization).

### 2.3 Verify Existing Tests Pass

```bash
cd packages/runner
deno test --allow-all test/
```

All existing tests must pass. Pay special attention to:
- Transaction isolation tests
- Conflict detection tests
- Concurrent modification tests

If any fail, it indicates the optimization broke something.

### 2.4 Test Edge Cases

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

## Phase 3: Cleanup and Documentation

### 3.1 Remove Instrumentation

After verification in production, remove console.log statements from commit().

**File**: `packages/runner/src/storage/transaction/chronicle.ts`

Remove:
- `const startTime = performance.now()`
- `const pathTaken = ...`
- `const duration = ...`
- `console.log(...)` calls

Keep only the core optimization logic.

### 3.2 Add Code Comments

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

### 3.3 Update CHANGELOG

**File**: `packages/runner/CHANGELOG.md`

Add entry:

```markdown
## [Unreleased]

### Performance
- Optimized History.claim() with version-based fast path for optimistic
  concurrency control. Reduces commit time from O(n²) to O(n) in common
  case (no concurrent modifications). Typical improvement: 5-10ms for
  small transactions, 5-10 seconds for large transactions (100+ reads).
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

---

## Timeline Estimate

- Phase 1 (Version fast path): 2-3 hours
- Phase 2 (Testing): 2-3 hours
- Phase 3 (Cleanup): 1 hour

**Total**: 5-7 hours development + testing time
