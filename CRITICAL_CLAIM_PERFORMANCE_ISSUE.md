# CRITICAL FINDINGS: Two O(n²) Performance Issues in Cell.get()

## Executive Summary

Found **TWO separate O(n²) performance issues** that both contribute to the 20ms delay:

1. **validateAndTransform seen array** - O(n) linear search that grows quadratically
2. **History.claim() consistency checks** - O(n²) with JSON.stringify on EVERY read

Both are in the critical path of Cell.get()!

## Issue #1: validateAndTransform seen Array (Already Identified)

**Location**: `packages/runner/src/schema.ts:379-380`

```typescript
const seenKey = JSON.stringify(link);
const seenEntry = seen.find((entry) => entry[0] === seenKey);
```

- Array.find() is O(n)
- Called for each cell processed
- Total: O(n²) where n = number of cells

**Impact**: Moderate (JSON.stringify is only 0.004ms, but linear search adds up)

## Issue #2: History.claim() - THIS IS THE BIG ONE! 🔥

**Location**: `packages/runner/src/storage/transaction/chronicle.ts:213, 367-395`

### The Call Site (Line 213)
```typescript
readValueOrThrow(address: IMemoryAddress): Result<IAttestation, ...> {
  // ... read logic ...

  // Capture the original replica read in history (for validation)
  const claim = this.#history.claim(invariant);  // ← Called on EVERY read!
  if (claim.error) {
    return claim;
  }

  return { ok: invariant };
}
```

### The claim() Implementation (Line 367-395)
```typescript
claim(attestation: IAttestation): Result<IAttestation, IStorageTransactionInconsistent> {
  const obsolete = new Set<IAttestation>();

  for (const candidate of this) {  // ← O(n) - iterates ALL previous invariants!
    if (Address.intersects(attestation.address, candidate.address)) {
      // ... determine which address to check ...

      const expected = read(candidate, address).ok?.value;
      const actual = read(attestation, address).ok?.value;

      if (JSON.stringify(expected) !== JSON.stringify(actual)) {  // ← JSON.stringify!
        return { error: StateInconsistency(...) };
      }

      // ... determine which invariant to keep ...
    }
  }

  if (!obsolete.has(attestation)) {
    this.put(attestation);
  }

  for (const attestation of obsolete) {
    this.delete(attestation);
  }

  return { ok: attestation };
}
```

### Why This Is Expensive

**Every read triggers claim():**
1. Chronicle.readValueOrThrow (line 213) calls `this.#history.claim(invariant)`
2. claim() iterates through ALL previous read invariants (line 373)
3. For each intersecting address, it calls JSON.stringify TWICE (line 387)
4. As more reads happen, the invariant set grows
5. **Result: O(n²) complexity with JSON.stringify on each comparison!**

### Performance Impact for Array Reads

Reading an array with 10 elements (each triggering nested reads):

```
Read 1:  claim() checks 0 invariants
Read 2:  claim() checks 1 invariant  → 2 JSON.stringify calls
Read 3:  claim() checks 2 invariants → 4 JSON.stringify calls
Read 4:  claim() checks 3 invariants → 6 JSON.stringify calls
...
Read 10: claim() checks 9 invariants → 18 JSON.stringify calls

Total: (0+1+2+3+...+9) × 2 = 90 JSON.stringify calls
```

For a notebook with 2 notes, each with title, content, noteId:
- Notebook read: 0 invariants
- Note 1 parent: 1 invariant to check
- Note 1.title: 2 invariants to check
- Note 1.content: 3 invariants to check
- Note 1.noteId: 4 invariants to check
- Note 2 parent: 5 invariants to check
- Note 2.title: 6 invariants to check
- Note 2.content: 7 invariants to check
- Note 2.noteId: 8 invariants to check

**Total: 36 invariant checks with 72 JSON.stringify calls!**

And that's for a SINGLE .get() call!

## Combined Impact

For reading `notebook.mentionable` (Cell<NoteCharm[]> with 2 notes):

### resolveLink() calls (Issue from previous investigation):
- ~5 resolveLink calls × 3-5ms each = **15-25ms**

### Plus claim() overhead (NEW finding):
- ~8-10 reads × growing invariant set = **36 checks × 2 JSON.stringify**
- Estimated: **5-10ms additional**

### Plus validateAndTransform seen array:
- Negligible with Map fix

**Total: 20-35ms** ✓ Matches user's profiling!

## Why Profiling Shows `claim`

The user mentioned profiling shows a lot of time in `claim`. This makes perfect sense now:

1. **claim() is called on every read** (line 213)
2. **claim() does O(n) iteration** through invariants (line 373)
3. **claim() does JSON.stringify comparisons** (line 387)
4. As the transaction progresses, invariant set grows
5. **Later reads are slower than earlier reads!**

## Recommended Fixes

### High Priority: Optimize History.claim()

**Option 1: Index invariants by address prefix**
```typescript
class History {
  #byId: Map<string, IAttestation[]> = new Map();
  #byIdAndPath: Map<string, IAttestation> = new Map();

  claim(attestation: IAttestation): Result<...> {
    // Only check invariants that could intersect
    const candidates = this.#byId.get(attestation.address.id) ?? [];
    for (const candidate of candidates) {
      // ... consistency check ...
    }
  }
}
```
**Benefit**: O(1) lookup instead of O(n) iteration

**Option 2: Cache JSON.stringify results**
```typescript
const stringified = new WeakMap<object, string>();

function getStringified(value: any): string {
  if (typeof value !== 'object') return JSON.stringify(value);
  let cached = stringified.get(value);
  if (!cached) {
    cached = JSON.stringify(value);
    stringified.set(value, cached);
  }
  return cached;
}

// In claim():
if (getStringified(expected) !== getStringified(actual)) {
  return { error: ... };
}
```
**Benefit**: Avoid repeated JSON.stringify of same objects

**Option 3: Use structural comparison instead of JSON.stringify**
```typescript
import { deepEqual } from "../path-utils.ts";

if (!deepEqual(expected, actual)) {
  return { error: ... };
}
```
**Benefit**: Faster than JSON.stringify for deep equality

### Medium Priority: Batch read tracking

Instead of calling claim() on every individual read, collect all reads and claim them in batch at the end:

```typescript
class Chronicle {
  #pendingClaims: IAttestation[] = [];

  readValueOrThrow(address: IMemoryAddress): Result<...> {
    // ... read logic ...
    this.#pendingClaims.push(invariant);  // Don't claim yet
    return { ok: invariant };
  }

  commit(): Result<...> {
    // Claim all reads at once with optimized algorithm
    for (const invariant of this.#pendingClaims) {
      const claim = this.#history.claim(invariant);
      if (claim.error) return claim;
    }
    // ... rest of commit ...
  }
}
```

## Verification

To verify this is the issue, add instrumentation:

```typescript
// In History.claim()
claim(attestation: IAttestation): Result<...> {
  const startTime = performance.now();
  let checksPerformed = 0;

  for (const candidate of this) {
    checksPerformed++;
    // ... existing logic ...
  }

  const duration = performance.now() - startTime;
  if (duration > 1) {  // Log if claim takes >1ms
    console.log(`claim() took ${duration.toFixed(2)}ms, checked ${checksPerformed} invariants`);
  }

  // ... rest of method ...
}
```

Expected output for notebook.mentionable.get():
```
claim() took 0.1ms, checked 0 invariants
claim() took 0.2ms, checked 1 invariants
claim() took 0.3ms, checked 2 invariants
claim() took 0.5ms, checked 3 invariants
claim() took 0.8ms, checked 4 invariants
claim() took 1.2ms, checked 5 invariants
claim() took 1.5ms, checked 6 invariants
claim() took 2.0ms, checked 7 invariants
Total claim() time: ~7-8ms
```

## Conclusion

**TWO separate O(n²) issues** both contribute to the 20ms delay:

1. **resolveLink() calls**: 15-25ms (multiple storage reads)
2. **History.claim() overhead**: 5-10ms (O(n²) invariant checks with JSON.stringify)
3. **validateAndTransform seen array**: <1ms (becomes significant with Map fix)

The claim() issue is particularly insidious because:
- It's in EVERY read path
- It gets exponentially worse as reads accumulate
- JSON.stringify makes it even slower
- It explains why profiling shows time in `claim`

**Priority**: Fix History.claim() indexing FIRST, as it affects all reads, not just arrays.
