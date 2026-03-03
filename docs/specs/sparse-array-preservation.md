# Design: Sparse Array Preservation Through the Reactive Pipeline

**Status:** Draft
**Author:** Mike
**Date:** 2026-03-03
**Stacked on:** PR #2942 (identity-based reconciliation in map builtin)

## Problem

When a sparse JavaScript array (an array with true holes, e.g. `[A, , , B]`
where `1 in arr === false`) flows through the reactive pipeline, sparseness is
destroyed at multiple intermediate layers. By the time the `map` builtin sees
it, every index is populated, and the map runs a pattern instance for every
position — including what were originally holes.

The desired behavior: if the input to `map` is `[A, <hole>, <hole>, B]`, the
output should be `[f(A), <hole>, <hole>, f(B)]`. No pattern should run for
holes. This should be reactive — filling a hole should spin up a new pattern
run, and creating a hole (removing a value) should stop producing output at
that index.

## Background: What Already Works

The low-level storage and serialization layers already handle sparse arrays
correctly when `richStorableValues` is enabled (which it is):

| Layer | File | Status |
|-------|------|--------|
| Rich storable value (shallow) | `packages/memory/rich-storable-value.ts:98-112` | Preserves holes via `i in arr` |
| Rich storable value (deep) | `packages/memory/rich-storable-value.ts:415-432` | Preserves holes via `i in value` |
| Serialization | `packages/memory/serialization.ts:160-181` | Run-length-encoded `/hole` entries |
| Deserialization | `packages/memory/serialization.ts:325-354` | Reconstructs true holes via `new Array(len)` |
| Canonical hashing | `packages/memory/canonical-hash.ts:241-250` | Handles holes in hash computation |
| Attestation (delete) | `packages/runner/src/storage/transaction/attestation.ts:130-131` | `delete newArray[index]` creates true holes |
| Attestation (extend) | `packages/runner/src/storage/transaction/attestation.ts:112-114` | Array extension preserves sparseness |

The problem is in the layers between storage and consumers.

## Layers That Destroy Sparseness

Six sites in four files actively destroy array sparseness. Listed bottom-up
from storage to consumer.

### 1. Attestation array copies

**File:** `packages/runner/src/storage/transaction/attestation.ts`
**Lines:** 113, 129, 151

When `setAtPath` needs to mutate an array element, it copies the array with
`[...root]` (spread). The spread operator converts holes to `undefined`,
destroying true sparseness. This happens in three places:

- Line 113: Array extension path
- Line 129: Terminal case (setting an element)
- Line 151: Recursive case (updating a nested value inside an element)

Ironically, line 131 then creates a hole with `delete newArray[index]` — but
all *other* holes in the array were already destroyed by the spread on line 129.

### 2. Cell write path (`recursivelyAddIDIfNeeded`)

**File:** `packages/runner/src/cell.ts:1791-1808`

When values are written to cells, `recursivelyAddIDIfNeeded` adds internal `_id`
fields to objects in arrays for change tracking. For arrays, it uses:

```ts
result.push(...value.map((v) => { ... }));
```

`.map()` on a sparse array preserves holes in its output, but `...spread` into
`push()` converts holes to `undefined`, then `push` adds them as real elements.
The result is always dense.

### 3. Cell `push` method

**File:** `packages/runner/src/cell.ts:850`

The cell's array `push` implementation uses `[...array, ...value]` to
concatenate. If the existing array is sparse, the spread densifies it.

### 4. Cell read/traverse path

**File:** `packages/runner/src/traverse.ts:645-698`

When reading an array from a cell, `traverseDAG` processes elements with:

```ts
const entries = doc.value.map((item, index) => { ... });
for (const v of entries) {
    newValue.push(v === undefined ? null : v);
}
```

This has three layers of densification:
1. `.map()` skips holes (but preserves them in output)
2. `for...of` yields `undefined` for holes
3. `v === undefined ? null : v` converts to `null`

The final array is always dense, with `null` where holes were. This is
particularly harmful because it makes holes indistinguishable from explicitly
`null` values.

### 5. Diff engine

**File:** `packages/runner/src/data-updating.ts:472-491, 625-634`

The `normalizeAndDiff` array loop iterates every index:

```ts
for (let i = 0; i < newValue.length; i++) {
    normalizeAndDiff(..., newValue[i], ..., currentArray?.[i]);
}
```

For holes, `newValue[i]` evaluates to `undefined`, which gets diffed as a value
change. The diff engine doesn't distinguish "this index has no value (hole)"
from "this index has the value `undefined`."

Additionally, `hasPath` at line 631 uses `element !== undefined` to check array
element existence, which conflates holes with `undefined` values:

```ts
const element = (value as Record<string, unknown>)[first];
return element !== undefined && hasPath(element, rest);
```

### 6. Map builtin

**File:** `packages/runner/src/builtins/map.ts`

In the PR #2942 version, the identity computation uses:

```ts
const identityInfo = list.map((_, i) => getElementKey(listCell, i, tx, keyCounts));
```

`.map()` skips holes in sparse arrays, so `identityInfo` itself becomes sparse.
The subsequent `for (let i = 0; i < list.length; i++)` loop then destructures
`identityInfo[i]` at a hole index, which is `undefined`, causing a crash.

Even without the crash, the reconciliation loop processes every index and
creates a pattern run for each, producing a dense output.

## Data Flow (Current vs. Desired)

```
External sparse array: [A, <hole>, <hole>, B]

CURRENT FLOW:
  toRichStorableValue    → [A, <hole>, <hole>, B]     (preserved)
  recursivelyAddIDIfNeeded → [A, undefined, undefined, B]  (DENSIFIED)
  storage write          → [A, undefined, undefined, B]
  traverse.ts read       → [A, null, null, B]          (DENSIFIED AGAIN)
  data-updating diff     → diffs all 4 indices
  map builtin            → runs 4 pattern instances

DESIRED FLOW:
  toRichStorableValue    → [A, <hole>, <hole>, B]     (preserved)
  recursivelyAddIDIfNeeded → [A, <hole>, <hole>, B]   (preserved)
  storage write          → [A, <hole>, <hole>, B]
  traverse.ts read       → [A, <hole>, <hole>, B]     (preserved)
  data-updating diff     → diffs only indices 0 and 3
  map builtin            → runs 2 pattern instances, output is [f(A), <hole>, <hole>, f(B)]
```

## Proposed Fix

The fix is straightforward and mechanical: at each site, replace array iteration
that skips or densifies holes with a `for` loop that checks `i in array` and
preserves holes via indexed assignment into a pre-allocated `new Array(len)`.

### Pattern

Every fix follows the same pattern. Replace:
```ts
const result = [...array];           // or array.map(...) + spread
```
With:
```ts
const result = new Array(array.length);
for (let i = 0; i < array.length; i++) {
  if (!(i in array)) continue;      // preserve hole
  result[i] = transform(array[i]);  // only process populated indices
}
```

A shared `sparseArrayCopy(arr)` utility could reduce repetition.

### Site-specific notes

**Attestation (sites 1):** Extract a `sparseArrayCopy` helper since the pattern
repeats 3 times in `setAtPath`.

**Cell write path (site 2):** The `generatedIdCounter` for `_id` fields only
applies to object elements — holes have no object, so the counter is unaffected.

**Traverse (site 4):** The `for...of` + `push` secondary loop (lines 692-698)
is eliminated. Elements are assigned directly by index during the main loop.

**Diff engine (site 5):** Requires four-case handling:

| Old index | New index | Action |
|-----------|-----------|--------|
| hole | hole | Skip (no change) |
| value | hole | Emit deletion (`value: undefined` — attestation interprets this as "create hole") |
| hole | value | Diff as new value (current value is `undefined`) |
| value | value | Diff normally (existing behavior) |

The `hasPath` function should use `index in value` instead of `element !== undefined`.

**Map builtin (site 6):** Replace `.map()` for identity computation with a
`for` loop. In the reconciliation loop, skip hole indices — don't create pattern
runs, don't assign to the output array. Use `new Array(list.length)` for the
output so holes are preserved structurally.

Reactive behavior when the list changes:
- **Value becomes hole:** The pattern run stays in `elementRuns` for potential
  reuse (consistent with how PR #2942 handles removed elements). The output has
  a hole at that index.
- **Hole becomes value:** Creates a new pattern run (or reuses from
  `elementRuns` if the identity key matches a previous run).

## Existing Tests That Need Updating

Three existing tests explicitly assert densification behavior:

1. `packages/runner/test/cell.test.ts:135` — "should densify sparse arrays
   during set" — update to expect holes are preserved
2. `packages/runner/test/cell.test.ts:152` — "should densify shared sparse
   arrays and preserve sharing" — update to expect holes are preserved (sharing
   should still work)
3. `packages/runner/test/attestation.test.ts:566` — "should convert sparse
   array holes to undefined (spread behavior)" — update to expect holes are
   preserved (`1 in items` should be `false`)

## New Tests Needed

1. **Cell roundtrip:** Write a sparse array to a cell, read it back, verify
   holes are preserved (`i in arr` is `false` for hole indices).
2. **Diff transitions:** Verify correct changesets for sparse-to-dense,
   dense-to-sparse, and sparse-to-sparse array transitions.
3. **Map with sparse input:** Verify the output array is sparse at the same
   indices as the input, and that only populated indices have pattern runs.
4. **Map reactive sparseness:** Verify that filling a hole in the input spins up
   a new pattern run, and that the output reflects the new value.

## Files Changed

| File | Nature of change |
|------|-----------------|
| `packages/runner/src/storage/transaction/attestation.ts` | Sparse-safe array copy (3 sites) |
| `packages/runner/src/cell.ts` | `recursivelyAddIDIfNeeded` + `push` method |
| `packages/runner/src/traverse.ts` | `traverseDAG` array branch |
| `packages/runner/src/data-updating.ts` | `normalizeAndDiff` array loop + `hasPath` |
| `packages/runner/src/builtins/map.ts` | Identity computation + reconciliation loop |
| `packages/runner/test/attestation.test.ts` | Update sparse test expectations |
| `packages/runner/test/cell.test.ts` | Update 2 densification tests |
| `packages/runner/test/patterns.test.ts` | New sparse map tests |

## Risks and Considerations

- **Backwards compatibility:** Dense arrays are unaffected — `i in denseArray`
  is `true` for all valid indices, so the `continue` branches are never taken.
- **`undefined` vs hole ambiguity:** The diff engine currently can't distinguish
  "value is `undefined`" from "index is a hole." The fix uses `i in array` which
  makes the distinction. Code that previously stored `undefined` at an index
  will continue to work (it's a present value, not a hole).
- **ID generation:** The `generatedIdCounter` in `recursivelyAddIDIfNeeded`
  only applies to object elements. Holes don't increment the counter, which
  could change ID assignment for subsequent objects if holes appear before them.
  This should be fine since IDs are only used for entity derivation within a
  single write, not persisted directly.
- **Performance:** The `for` loop with `i in` check has identical performance
  characteristics to the current code for dense arrays. For sparse arrays, it
  does less work (skips holes instead of processing them).
