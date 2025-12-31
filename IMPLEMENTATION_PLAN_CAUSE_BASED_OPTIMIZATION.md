# Cell.get() Performance Optimization - Cause-Based Fast Path

## Executive Summary

History.claim() causes O(n²) performance degradation during reads:
- Called on **every read** to ensure snapshot isolation
- Iterates through all previous read invariants (O(n))
- For each intersecting address: 2× read() + 2× JSON.stringify()
- Result: O(n²) complexity that causes 5-10ms overhead for simple structures

**Profiling confirms**: Time is spent in `claim` during .get() operations.

This plan implements a **cause-based fast path** using existing causal references.

**Key Insight**: State objects have a `cause` field (causal reference to previous version). If two reads have the same `cause`, they're reading the exact same document version → guaranteed consistent → skip expensive value comparison.

**Expected Impact:**
- 2 notes: 5-10ms → <1ms (90%+ reduction)
- 10 notes: 20-30ms → <2ms (90%+ reduction)
- 100 notes: 200-300ms → <10ms (95%+ reduction)

---

## Background: Why Cause-Based vs Version-Based

**Version-based approach (original plan):**
```typescript
// Requires incrementing version on ALL changes:
replica.#version++ on:
  - Local commits ✓
  - Network updates ✗ (complex)
  - Subscriptions ✗ (complex)
  - Merges ✗ (complex)
// Global coordination needed across all modification sources
```

**Cause-based approach (this plan):**
```typescript
// Uses existing per-document causal references:
state.cause → Reference to previous document version
// If cause matches → documents identical
// Already exists in data model!
// No global coordination needed
```

**Advantages of cause-based:**
1. ✅ Already exists in the data model (State.cause field)
2. ✅ Per-document tracking (no global version counter)
3. ✅ Automatically updated by existing commit flow
4. ✅ Simpler implementation
5. ✅ No need to track network updates, subscriptions, merges

---

## Architecture Overview

### Current Flow (Slow Path Only)

```
readValueOrThrow()
  ├─ load(address) → State (has 'cause')
  ├─ attest(state) → IAttestation (drops 'cause'!)
  └─ History.claim(attestation)
      └─ for each previous invariant:
          ├─ read(candidate, address) → extract value
          ├─ read(attestation, address) → extract value
          └─ JSON.stringify(expected) === JSON.stringify(actual)  ← SLOW!
```

### Optimized Flow (Fast Path + Slow Path)

```
readValueOrThrow()
  ├─ load(address) → State (preserve 'cause'!)
  ├─ attest(state) → IAttestation
  └─ History.claim(attestation, state)  ← Pass state!
      └─ for each previous invariant:
          ├─ if (state.cause === previousState.cause)  ← FAST PATH!
          │   └─ return { ok }  // Guaranteed consistent
          └─ else:  ← SLOW PATH (needed for novelty writes)
              ├─ read() + read()
              └─ JSON.stringify() === JSON.stringify()
```

---

## Phase 1: Preserve State in History

### 1.1 Extend History to Store State

**File**: `packages/runner/src/storage/transaction/chronicle.ts`

**Location**: History class (line 305)

**Current:**
```typescript
class History {
  #model: Map<string, IAttestation> = new Map();
  #space: MemorySpace;

  constructor(space: MemorySpace) {
    this.#space = space;
    this.#model = new Map();
  }
```

**Change to:**
```typescript
class History {
  #model: Map<string, { attestation: IAttestation; state: State }> = new Map();
  #space: MemorySpace;

  constructor(space: MemorySpace) {
    this.#space = space;
    this.#model = new Map();
  }
```

### 1.2 Update History Methods

**Location**: History.put() (line 426)

**Current:**
```typescript
put(attestation: IAttestation) {
  const key = `${attestation.address.id}:${attestation.address.type}:${
    attestation.address.path.join("/")
  }`;
  this.#model.set(key, attestation);
}
```

**Change to:**
```typescript
put(attestation: IAttestation, state: State) {
  const key = `${attestation.address.id}:${attestation.address.type}:${
    attestation.address.path.join("/")
  }`;
  this.#model.set(key, { attestation, state });
}
```

**Location**: History.delete() (line 434)

**Current:**
```typescript
delete(attestation: IAttestation) {
  const key = `${attestation.address.id}:${attestation.address.type}:${
    attestation.address.path.join("/")
  }`;
  return this.#model.delete(key);
}
```

**No change needed** - delete by key still works.

**Location**: History iterator (line 315)

**Current:**
```typescript
*[Symbol.iterator]() {
  yield* this.#model.values();
}
```

**Change to:**
```typescript
*[Symbol.iterator]() {
  for (const { attestation } of this.#model.values()) {
    yield attestation;  // Maintain backward compatibility
  }
}
```

**Location**: History.get() (line 343)

**Current:**
```typescript
get(address: IMemoryAddress): IAttestation | undefined {
  let candidate: undefined | IAttestation = undefined;
  for (const invariant of this) {
    if (Address.includes(invariant.address, address)) {
      if (!candidate) {
        candidate = invariant;
      } else if (
        candidate.address.path.length < invariant.address.path.length
      ) {
        candidate = invariant;
      }
    }
  }
  return candidate;
}
```

**No change needed** - iterator already yields IAttestation.

---

## Phase 2: Implement Cause-Based Fast Path in History.claim()

**File**: `packages/runner/src/storage/transaction/chronicle.ts`

**Location**: History.claim() (line 367)

**Current signature:**
```typescript
claim(
  attestation: IAttestation,
): Result<IAttestation, IStorageTransactionInconsistent>
```

**Change to:**
```typescript
claim(
  attestation: IAttestation,
  state: State,
): Result<IAttestation, IStorageTransactionInconsistent>
```

**Current implementation:**
```typescript
claim(attestation: IAttestation): Result<...> {
  const obsolete = new Set<IAttestation>();

  for (const candidate of this) {
    if (Address.intersects(attestation.address, candidate.address)) {
      const address = /* determine more specific path */;

      const expected = read(candidate, address).ok?.value;
      const actual = read(attestation, address).ok?.value;

      if (JSON.stringify(expected) !== JSON.stringify(actual)) {
        return { error: StateInconsistency({...}) };
      }

      // ... deduplication logic ...
    }
  }

  if (!obsolete.has(attestation)) {
    this.put(attestation);  // ← OLD
  }

  for (const attestation of obsolete) {
    this.delete(attestation);
  }

  return { ok: attestation };
}
```

**Change to:**
```typescript
claim(
  attestation: IAttestation,
  state: State,
): Result<IAttestation, IStorageTransactionInconsistent> {
  const obsolete = new Set<IAttestation>();

  for (const { attestation: candidate, state: candidateState } of this.#model.values()) {
    if (Address.intersects(attestation.address, candidate.address)) {
      // === FAST PATH: Compare causal references ===
      // If both states have the same 'cause', they reference the same
      // document version → guaranteed consistent → skip value comparison
      const attestationCause = "cause" in state ? state.cause : undefined;
      const candidateCause = "cause" in candidateState ? candidateState.cause : undefined;

      if (
        attestationCause !== undefined &&
        candidateCause !== undefined &&
        attestationCause === candidateCause
      ) {
        // Same document version - guaranteed consistent!
        // Still need to handle deduplication logic below
        const address =
          attestation.address.path.length > candidate.address.path.length
            ? attestation.address
            : candidate.address;

        // Skip to deduplication logic (copy from lines 397-410)
        if (attestation.address.path.length === candidate.address.path.length) {
          continue;
        } else if (candidate.address === address) {
          obsolete.add(attestation);
        } else if (attestation.address === address) {
          obsolete.add(candidate);
        }

        continue;  // Skip slow path
      }

      // === SLOW PATH: Value comparison (needed for novelty writes) ===
      const address =
        attestation.address.path.length > candidate.address.path.length
          ? attestation.address
          : candidate.address;

      const expected = read(candidate, address).ok?.value;
      const actual = read(attestation, address).ok?.value;

      if (JSON.stringify(expected) !== JSON.stringify(actual)) {
        return {
          error: StateInconsistency({
            address,
            expected,
            actual,
          }),
        };
      }

      // Deduplication logic
      if (attestation.address.path.length === candidate.address.path.length) {
        continue;
      } else if (candidate.address === address) {
        obsolete.add(attestation);
      } else if (attestation.address === address) {
        obsolete.add(candidate);
      }
    }
  }

  if (!obsolete.has(attestation)) {
    this.put(attestation, state);  // ← Pass state!
  }

  for (const attestation of obsolete) {
    this.delete(attestation);
  }

  return { ok: attestation };
}
```

---

## Phase 3: Update Chronicle.readValueOrThrow() to Pass State

**File**: `packages/runner/src/storage/transaction/chronicle.ts`

**Location**: Chronicle.readValueOrThrow() (line 173)

**Current (line 193-217):**
```typescript
// No matching writes - read from the replica
const state = this.load(address);

// Check if document exists when trying to read from nested path
if (state.is === undefined && address.path.length > 0) {
  return { error: NotFound(attest(state), address) };
}

const loaded = attest(state);
const { error, ok: invariant } = read(loaded, address);
if (error) {
  if (
    error.name === "NotFoundError" || error.name === "TypeMismatchError"
  ) {
    this.#history.claim(loaded);  // ← OLD
  }
  return { error };
} else {
  // Capture the original replica read in history (for validation)
  const claim = this.#history.claim(invariant);  // ← OLD
  if (claim.error) {
    return claim;
  }

  // ... rest of method ...
}
```

**Change to:**
```typescript
// No matching writes - read from the replica
const state = this.load(address);

// Check if document exists when trying to read from nested path
if (state.is === undefined && address.path.length > 0) {
  return { error: NotFound(attest(state), address) };
}

const loaded = attest(state);
const { error, ok: invariant } = read(loaded, address);
if (error) {
  if (
    error.name === "NotFoundError" || error.name === "TypeMismatchError"
  ) {
    this.#history.claim(loaded, state);  // ← Pass state!
  }
  return { error };
} else {
  // Capture the original replica read in history (for validation)
  const claim = this.#history.claim(invariant, state);  // ← Pass state!
  if (claim.error) {
    return claim;
  }

  // ... rest of method ...
}
```

---

## Phase 4: Update Chronicle.commit() Iterator

**File**: `packages/runner/src/storage/transaction/chronicle.ts`

**Location**: Chronicle.history() iterator (line 73)

**Current:**
```typescript
*history(): Iterable<IAttestation> {
  yield* this.#history;
}
```

**No change needed** - History iterator already yields IAttestation for backward compatibility.

---

## Phase 5: Create Benchmarks

**File**: `packages/runner/test/claim-optimization.bench.ts` (create new)

```typescript
import { describe } from "@std/testing/bdd";
import { Identity } from "@commontools/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import type { JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("claim optimization bench");
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
    mentionable: {
      type: "array",
      items: noteSchema,
    },
  },
};

async function benchmarkMentionableRead(noteCount: number) {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });

  // Create notebook with N notes in transaction 1
  const tx1 = runtime.edit();

  const notes = [];
  for (let i = 0; i < noteCount; i++) {
    const note = runtime.getCell(space, `note-${i}`, noteSchema, tx1);
    note.set({
      title: `Note ${i}`,
      content: `Content ${i}`,
      noteId: `note-${i}`,
    });
    notes.push(note);
  }

  const notebook = runtime.getCell(space, "notebook", notebookSchema, tx1);
  notebook.set({
    title: `Notebook with ${noteCount} notes`,
    notes,
    mentionable: notes,
  });

  await tx1.commit();

  // Read in transaction 2 - this triggers the performance issue
  const tx2 = runtime.edit();
  const notebookCell = runtime.getCell(space, "notebook", notebookSchema, tx2);

  // Benchmark the .get() call
  const value = notebookCell.get();

  await tx2.commit();
  await runtime.dispose();
  await storageManager.close();
}

// Benchmark with different array sizes
Deno.bench("mentionable read: 2 notes", async () => {
  await benchmarkMentionableRead(2);
});

Deno.bench("mentionable read: 10 notes", async () => {
  await benchmarkMentionableRead(10);
});

Deno.bench("mentionable read: 50 notes", async () => {
  await benchmarkMentionableRead(50);
});

Deno.bench("mentionable read: 100 notes", async () => {
  await benchmarkMentionableRead(100);
});
```

**Run benchmarks:**
```bash
deno bench packages/runner/test/claim-optimization.bench.ts
```

**Expected results:**

Before optimization:
```
mentionable read: 2 notes    ~15-25ms
mentionable read: 10 notes   ~50-80ms
mentionable read: 50 notes   ~300-500ms
mentionable read: 100 notes  ~1000-2000ms
```

After optimization:
```
mentionable read: 2 notes    <1ms     (95% reduction)
mentionable read: 10 notes   <2ms     (97% reduction)
mentionable read: 50 notes   <5ms     (98% reduction)
mentionable read: 100 notes  <10ms    (99% reduction)
```

---

## Phase 6: Testing & Validation

### 6.1 Run Existing Tests

```bash
deno task test packages/runner/test/
```

Ensure all existing tests pass. The changes are backward compatible.

### 6.2 Run Benchmarks

```bash
deno bench packages/runner/test/claim-optimization.bench.ts
```

Verify performance improvements match expectations.

### 6.3 Manual Testing

Test the notebook pattern with mentionable arrays:
1. Create notebook with 10 notes
2. Read mentionable array
3. Verify <2ms response time

---

## Implementation Checklist

- [ ] Phase 1: Extend History to store State alongside IAttestation
  - [ ] Update #model Map type (line 306)
  - [ ] Update put() method (line 426)
  - [ ] Update iterator (line 315)

- [ ] Phase 2: Implement cause-based fast path in History.claim()
  - [ ] Add state parameter to signature (line 367)
  - [ ] Add fast path: compare cause fields
  - [ ] Keep slow path for novelty writes
  - [ ] Update put() call to pass state

- [ ] Phase 3: Update Chronicle.readValueOrThrow()
  - [ ] Pass state to History.claim() on success path (line 213)
  - [ ] Pass state to History.claim() on error path (line 208)

- [ ] Phase 4: Create benchmarks
  - [ ] Create claim-optimization.bench.ts
  - [ ] Add benchmarks for 2, 10, 50, 100 notes

- [ ] Phase 5: Testing
  - [ ] Run existing tests
  - [ ] Run benchmarks
  - [ ] Verify 90%+ performance improvement

---

## Expected Impact

### Performance Improvements

| Scenario | Before | After | Improvement |
|----------|--------|-------|-------------|
| 2 notes  | 15-25ms | <1ms | 95%+ |
| 10 notes | 50-80ms | <2ms | 97%+ |
| 50 notes | 300-500ms | <5ms | 98%+ |
| 100 notes | 1000-2000ms | <10ms | 99%+ |

### Fast Path Hit Rate

- **Replica reads**: 100% (cause always matches for same document version)
- **Novelty reads**: 0% (writes change cause, fall back to slow path)
- **Overall**: >95% in typical workflows (mostly reads)

### Why This Works

1. **Replica reads** (common case):
   - load() returns same State for same document
   - state.cause references same previous version
   - Fast path: O(1) reference comparison instead of O(n) JSON.stringify

2. **Novelty writes** (less common):
   - Writing changes the State
   - cause references new version
   - Slow path: still validates with JSON.stringify (necessary!)

---

## Comparison to Version-Based Approach

| Aspect | Version-Based | Cause-Based |
|--------|--------------|-------------|
| Data model changes | Add global version counter | Use existing cause field |
| Update triggers | Commits, network, subs, merges | Automatic (part of State) |
| Scope | Global (whole replica) | Per-document (granular) |
| Complexity | High (track all sources) | Low (already exists) |
| False negatives | Possible (version may not increment) | Impossible (cause always updated) |
| Implementation | 3-4 hours | 2-3 hours |

**Recommendation**: Cause-based approach is simpler, more correct, and easier to maintain.

---

## Timeline

- **Phase 1**: 30 minutes (extend History storage)
- **Phase 2**: 60 minutes (implement fast path)
- **Phase 3**: 15 minutes (update call sites)
- **Phase 4**: 30 minutes (create benchmarks)
- **Phase 5**: 15 minutes (testing)

**Total**: ~2.5 hours

---

## Notes

- The fast path only helps for **replica reads** (not novelty writes)
- This is fine because most reads are from replica
- Novelty reads still need value comparison (correctness!)
- The cause field is a string Reference, so comparison is O(1)
- Backward compatible: all existing tests should pass
