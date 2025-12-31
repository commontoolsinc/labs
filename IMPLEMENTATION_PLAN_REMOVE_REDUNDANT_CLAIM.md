# Cell.get() Performance Optimization - Remove Redundant History.claim()

## Executive Summary

**Discovery**: History.claim() during reads is **completely redundant** with commit-time validation.

**Current behavior:**
- Line 213: History.claim() called on EVERY read - O(n²) overhead
- Line 246: attestation.claim() called at commit - validates against replica

**Key insight**: Since the replica is frozen during a transaction, all reads from it are guaranteed consistent. The commit-time validation already catches any external changes.

**Solution**: Simply skip History.claim() during reads. Only validate at commit.

**Expected Impact:**
- 2 notes: 15-25ms → <1ms (>95% reduction)
- 10 notes: 50-80ms → <2ms (>97% reduction)
- 100 notes: 1-2s → <10ms (>99% reduction)
- **Zero complexity added** - just remove redundant code

---

## Analysis: Why History.claim() During Reads is Redundant

### Current Flow

**During reads** (chronicle.ts:213):
```typescript
readValueOrThrow(address: IMemoryAddress) {
  const state = this.load(address);  // Read from frozen replica
  const loaded = attest(state);
  const { ok: invariant } = read(loaded, address);

  // Validates this read against all previous reads - O(n)
  const claim = this.#history.claim(invariant);  ← EXPENSIVE!
  if (claim.error) return claim;

  return { ok: invariant };
}
```

**At commit** (chronicle.ts:246):
```typescript
commit() {
  for (const invariant of this.history()) {
    // Validates invariant against current replica state
    const { ok: state, error } = claim(invariant, replica);  ← ALREADY DOES THIS!
    if (error) return { error };
  }
}
```

### What Each Validation Catches

**History.claim() during reads:**
- Checks: Is this read consistent with previous reads?
- Example: Read `/user/1` → {name: "Alice"}, then read `/user/1/name` → must be "Alice"
- **But**: All reads come from the same frozen replica → always consistent!

**attestation.claim() at commit:**
- Checks: Is this read still valid against current replica state?
- Example: Read `/user/1` → {name: "Alice"} at start, validate still true at commit
- **Catches**: External changes to replica between transaction start and commit

### Proof of Redundancy

**Scenario: Pure reads from replica**
```typescript
tx.read('/user/1') → {name: "Alice"} from replica
tx.read('/user/1/name') → "Alice" from replica
```
- Replica is frozen → both reads see same data → always consistent
- History.claim() during reads: validates {name: "Alice"} vs "Alice" ✓ redundant
- attestation.claim() at commit: validates against replica ✓ sufficient

**Scenario: Read after write (novelty)**
```typescript
tx.read('/user/1') → {name: "Alice"} from replica (stored in history)
tx.write('/user/1/name', "Bob") → to novelty
tx.read('/user/1/name') → "Bob" from novelty (NOT stored in history!)
```
- Line 187-189: Novelty reads bypass history entirely!
- Only replica reads are stored as invariants
- History.claim() only validates replica reads against each other
- Replica is frozen → always consistent → redundant

**Scenario: Concurrent modification**
```typescript
// Transaction 1
tx1.read('/user/1') → {name: "Alice"} from replica

// Meanwhile, external commit changes replica
replica.commit({'/user/1': {name: "Bob"}})

// Transaction 1 continues
tx1.commit() → attestation.claim() detects {name: "Alice"} != {name: "Bob"} ✗
```
- History.claim() during reads: doesn't see external change
- attestation.claim() at commit: catches the conflict ✓

**Conclusion**: History.claim() during reads provides ZERO additional safety. It only provides "fail fast" semantics at the cost of O(n²) overhead.

---

## Implementation: Remove Redundant Validation

### Step 1: Remove History.claim() During Reads

**File**: `packages/runner/src/storage/transaction/chronicle.ts`

**Location**: readValueOrThrow() method (line 211-217)

**Current code:**
```typescript
} else {
  // Capture the original replica read in history (for validation)
  const claim = this.#history.claim(invariant);
  if (claim.error) {
    return claim;
  }

  // Apply any overlapping writes from novelty and return merged result
  const changes = this.#novelty.select(address);
  const workingCopy = changes?.getWorkingCopy();
  if (workingCopy) {
    return read(workingCopy, address);
  }

  return { ok: invariant };
}
```

**Change to:**
```typescript
} else {
  // Capture the original replica read in history (for validation at commit)
  this.#history.put(invariant);

  // Apply any overlapping writes from novelty and return merged result
  const changes = this.#novelty.select(address);
  const workingCopy = changes?.getWorkingCopy();
  if (workingCopy) {
    return read(workingCopy, address);
  }

  return { ok: invariant };
}
```

**Also update error path** (line 205-210):

**Current:**
```typescript
if (error) {
  // If the read failed because of path errors, this is still effectively a
  // read, so let's log it for validation
  if (
    error.name === "NotFoundError" || error.name === "TypeMismatchError"
  ) {
    this.#history.claim(loaded);
  }
  return { error };
}
```

**Change to:**
```typescript
if (error) {
  // If the read failed because of path errors, this is still effectively a
  // read, so let's log it for validation at commit
  if (
    error.name === "NotFoundError" || error.name === "TypeMismatchError"
  ) {
    this.#history.put(loaded);
  }
  return { error };
}
```

### Step 2: Simplify History.claim() (Optional Cleanup)

Since History.claim() is now only called at commit time (not during reads), we can simplify it.

**File**: `packages/runner/src/storage/transaction/chronicle.ts`

**Location**: History.claim() method (line 367-424)

**Option A: Keep as-is**
- The method still works, just not called during reads
- Deduplication logic still useful at commit time

**Option B: Simplify to just deduplication**
- Remove the validation logic (redundant with attestation.claim())
- Keep only the parent/child deduplication
- Smaller code surface

**Recommendation**: Keep as-is for now. Can simplify in follow-up if needed.

---

## Benchmarks

**File**: `packages/runner/test/claim-optimization.bench.ts` (create new)

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

  // Write data in tx1
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

  // Read in tx2 - this is what we're benchmarking
  const tx2 = runtime.edit();
  const notebookCell = runtime.getCell(space, "notebook", notebookSchema, tx2);

  // The .get() call triggers the performance issue
  const value = notebookCell.get();

  await tx2.commit();
  await runtime.dispose();
  await storageManager.close();
}

Deno.bench("mentionable .get() - 2 notes", async () => {
  await benchmarkMentionableRead(2);
});

Deno.bench("mentionable .get() - 10 notes", async () => {
  await benchmarkMentionableRead(10);
});

Deno.bench("mentionable .get() - 50 notes", async () => {
  await benchmarkMentionableRead(50);
});

Deno.bench("mentionable .get() - 100 notes", async () => {
  await benchmarkMentionableRead(100);
});
```

**Run:**
```bash
deno bench packages/runner/test/claim-optimization.bench.ts
```

**Expected results:**

Before (with History.claim() during reads):
```
mentionable .get() - 2 notes      15-25ms   ← O(n²) overhead
mentionable .get() - 10 notes     50-80ms
mentionable .get() - 50 notes     300-500ms
mentionable .get() - 100 notes    1-2s
```

After (without History.claim() during reads):
```
mentionable .get() - 2 notes      <1ms      ← Only resolveLink overhead remains
mentionable .get() - 10 notes     <2ms
mentionable .get() - 50 notes     <5ms
mentionable .get() - 100 notes    <10ms
```

---

## Testing

### Run Existing Tests

```bash
deno task test packages/runner/test/
```

**All tests must pass.** The change is purely an optimization - semantics are identical.

**Critical tests to watch:**
- Transaction isolation tests
- Conflict detection tests
- Concurrent modification tests
- Snapshot consistency tests

If any fail, it means History.claim() during reads WAS catching something we didn't anticipate.

### Verify Commit-Time Validation Still Works

**Test case 1: Concurrent modification**
```typescript
const tx1 = runtime.edit();
const cell1 = runtime.getCell(space, "test", schema, tx1);
cell1.get(); // Read value

// External commit changes the replica
const tx2 = runtime.edit();
runtime.getCell(space, "test", schema, tx2).set({changed: true});
await tx2.commit();

// tx1 commit should fail with StateInconsistency
await tx1.commit(); // Should error ✓
```

**Test case 2: No concurrent modification**
```typescript
const tx1 = runtime.edit();
const cell1 = runtime.getCell(space, "test", schema, tx1);
cell1.get(); // Read value

// No external changes

await tx1.commit(); // Should succeed ✓
```

---

## Implementation Checklist

- [ ] Remove History.claim() call from readValueOrThrow() success path (line 213)
- [ ] Replace with History.put() (just store invariant, no validation)
- [ ] Remove History.claim() call from readValueOrThrow() error path (line 208)
- [ ] Replace with History.put()
- [ ] Create benchmark file
- [ ] Run benchmarks - verify >95% improvement
- [ ] Run all existing tests - verify they pass
- [ ] Test concurrent modification detection still works

---

## Summary

**What we're changing:**
- Remove O(n²) validation during reads
- Keep commit-time validation (already exists)

**Why it's safe:**
- Replica is frozen during transaction
- All replica reads are consistent by definition
- Commit-time validation catches external changes
- Novelty reads bypass history entirely

**Performance gain:**
- Eliminates 5-10ms for 2 notes
- Eliminates seconds for large transactions
- Zero complexity added

**Implementation time:** ~30 minutes

---

## Files Modified

| File | Lines | Change |
|------|-------|--------|
| `chronicle.ts` | 208, 213 | Replace `claim()` with `put()` |

That's it. Two lines changed.
