# Sparse Array Preservation

## What is a sparse array?

A sparse array is a JavaScript array with "holes" — indices that have no value
at all, not even `undefined`. They're created by `new Array(len)`, by `delete
arr[i]`, or by literal syntax like `[1, , 3]`.

```js
const sparse = [1, , 3];
sparse.length;    // 3
0 in sparse;      // true  — index 0 has a value
1 in sparse;      // false — index 1 is a hole
sparse[1];        // undefined (but so would an explicit undefined be)
```

The only reliable way to distinguish a hole from an explicit `undefined` is the
`in` operator: `i in arr` returns `false` for holes and `true` for present
values (including `undefined`).

## Why we care

Sparse arrays are a core data structure in our reactive pipeline. They represent
collections where some positions are intentionally empty — for example, a list
that uses stable indices as identity keys, where items can be removed without
shifting other elements.

When the `map` builtin processes a list, it creates one pattern run per element.
If holes are filled in with `undefined` or `null`, map creates pattern runs for
those positions too — wasting resources and producing incorrect output. The
correct behavior: `map([A, <hole>, B])` should produce `[f(A), <hole>, f(B)]`
with only two pattern runs.

## How JavaScript destroys sparseness

Many common array operations silently convert holes to `undefined`:

| Operation | Preserves holes? |
|-----------|-----------------|
| `[...arr]` (spread) | No — holes become `undefined` |
| `arr.map(fn)` | Skips holes in callback, but output has `undefined` at those positions |
| `Array.from(arr)` | No — holes become `undefined` |
| `for...of` | Yields `undefined` for holes |
| `arr.push(...other)` | Densifies `other` via spread |
| `arr.slice()` | Yes |
| `arr.forEach(fn)` | Yes — callback is only called for present indices |
| `for (let i = 0; i < len; i++)` with `arr[i]` | Reads `undefined` (indistinguishable from explicit `undefined`) |
| `for (let i = 0; i < len; i++)` with `i in arr` | Correctly detects holes |

The last two rows are the key techniques. We use `forEach` when we only need to
visit present elements. We use `for` + `i in arr` when we also need to detect
absent indices (e.g. to emit deletions in the diff engine).

## The two sparse-safe patterns

We use two patterns depending on the situation. Both produce the same result for
sparse arrays — only the style differs.

### `forEach` (preferred for iteration)

```ts
const result = new Array(arr.length);       // pre-allocate with holes
arr.forEach((v, i) => {
  result[i] = transform(v);                // only called for present indices
});
```

`forEach` skips holes automatically — the callback is never called for absent
indices. This makes sparse-safety structural: you can't forget to check `i in
arr` because there's no check to write. Use this for copies, transforms, and any
iteration where you only care about present elements.

For a plain copy, `attestation.ts` has a `sparseArrayCopy` helper that uses
this pattern.

### `for` + `i in arr` (when you need to detect absences)

```ts
for (let i = 0; i < arr.length; i++) {
  if (!(i in arr)) continue;               // skip holes
  result[i] = transform(arr[i]);           // only touch populated indices
}
```

Use this when you need to compare two arrays and detect indices that are present
in one but absent in the other (e.g. the diff engine emitting deletions), when
you need early exit (`break`/`return`), or when you have complex loop state that
doesn't fit a callback.

## Where sparse arrays flow through the codebase

Data flows through the reactive pipeline in this order. Every layer preserves
sparseness:

```
Write path:  value → toStorableValue → recursivelyAddIDIfNeeded → storage
Read path:   storage → traverseDAG → normalizeAndDiff → builtins (map, etc.)
```

### Storage and serialization (foundation)

These layers handle sparse arrays correctly and are less likely to regress
because their sparse support was part of the original design:

- **`packages/memory/rich-storable-value.ts`** — `toRichStorableValue` and
  `toDeepRichStorableValue` use `i in arr` checks.
- **`packages/memory/serialization.ts`** — Encodes holes as run-length-encoded
  `/hole` entries; decodes them back to true holes via `new Array(len)`.
- **`packages/memory/canonical-hash.ts`** — Handles holes in hash computation.

### Value validation (`packages/memory/storable-value.ts`)

`isStorableArray` accepts sparse arrays — holes are valid storable structure. It
uses `for` + `i in` because it needs early return.  `toStorableValueLegacy` and
`toDeepStorableValueInternal` both use `forEach` to preserve holes during
conversion.

### Attestation (`packages/runner/src/storage/transaction/attestation.ts`)

The `setAtPath` function does copy-on-write: when it needs to modify an element
in an array, it copies the array first. The `sparseArrayCopy` helper (which uses
`forEach`) is used at all three copy sites (extension, element set, nested
modification). The `delete` operation at `setAtPath` creates true holes via
`delete newArray[index]`.

### Cell write path (`packages/runner/src/cell.ts`)

`recursivelyAddIDIfNeeded` adds internal ID fields to objects in arrays for
change tracking. It uses `forEach` into a pre-allocated `new Array(value.length)`
— the callback is only called for present elements, so holes are preserved. The
ID counter only increments for object elements; holes are skipped.

The cell `push` method concatenates arrays using `forEach` on the original
(sparse) array, then a `for` loop for the appended (dense) values.

### Cell read path (`packages/runner/src/traverse.ts`)

`traverseDAG` reconstructs arrays from storage. It uses `forEach` on
`doc.value`, assigning populated elements by index into `new Array(len)`. The
result array is registered with the cycle tracker before population so that
circular references can return it early.

`traverseArrayWithSchema` (the schema-driven traversal path) uses `for` + `i in`
because it has early `return undefined` exits (broken redirects, schema
mismatches). It pre-allocates with `new Array(len)` and uses indexed assignment
instead of `push`.

### Diff engine (`packages/runner/src/data-updating.ts`)

`normalizeAndDiff` compares the new array against the current array to produce a
changeset. It uses `for` + `i in` (not `forEach`) because it needs to detect
indices present in the old array but absent in the new one. It handles four cases
for each index:

| `i in new` | `i in current` | Action |
|-----------|----------------|--------|
| No | No | Skip — hole unchanged |
| No | Yes | Emit delete (attestation interprets `value: undefined` as "create hole") |
| Yes | No | Diff as new value |
| Yes | Yes | Diff normally |

The `hasPath` function uses `index in value` (not `value[index] !== undefined`)
to correctly report that a path through a hole does not exist.

### Map builtin (`packages/runner/src/builtins/map.ts`)

The main loop checks `initializedUpTo in list` before creating a pattern run.
For holes, it extends `newArrayValue.length` without pushing — preserving the
hole in the output. When the input list changes reactively:

- **Value becomes hole:** The output gets a hole at that index. The pattern run
  is kept for potential reuse if the same key reappears.
- **Hole becomes value:** A new pattern run is created (or reused by key match).

## Writing new code that handles arrays

When you write code that iterates, copies, or transforms arrays anywhere in the
reactive pipeline:

1. **Prefer `forEach`** for iteration, copies, and transforms. It skips holes
   automatically, making sparse-safety the default.
2. **Use `for` + `i in arr`** when you need to detect absent indices, need early
   exit, or have complex loop state.
3. **Never use** `for...of`, `.map()`, spread (`[...arr]`), or `Array.from()` on
   arrays that might be sparse.
4. **Pre-allocate with `new Array(len)`**, not `[]`. An empty array that you
   `push` into will never have holes.
5. **Use indexed assignment** (`result[i] = ...`), not `push`.
6. **Test with sparse arrays.** Create them with `[1, , 3]` (note the lint
   directive `// deno-lint-ignore no-sparse-arrays`) and verify holes survive
   with `i in result`.

If you're writing a plain array copy, use or follow `sparseArrayCopy` from
`attestation.ts`.

## How we ensure this stays correct

Test coverage verifies sparse preservation at each layer:

- **`packages/memory/test/storable-value-test.ts`** — `isStorableValue` accepts
  sparse arrays; `toStorableValue` and `toDeepStorableValue` preserve holes.
- **`packages/runner/test/attestation.test.ts`** — `setAtPath` preserves holes
  through array copies (extension, element set, nested modification).
- **`packages/runner/test/cell.test.ts`** — Writing a sparse array to a cell and
  reading it back preserves holes; `push` onto a sparse array preserves existing
  holes.
- **`packages/runner/test/traverse.test.ts`** — Sparse array roundtrip through
  `traverse` preserves holes (both `traverseDAG` and schema-driven
  `traverseArrayWithSchema` paths).
- **`packages/runner/test/data-updating.test.ts`** — All four hole transition
  cases (hole-to-hole, value-to-hole, hole-to-value, value-to-value); `hasPath`
  returns false through holes.
- **`packages/runner/test/experimental-options.test.ts`** — `isStorableValue`
  accepts sparse arrays regardless of the `richStorableValues` flag.

These tests use the `in` operator to assert true sparseness (`1 in result`
should be `false`), not just value equality. A regression that densifies arrays
will fail these assertions.

## Known limitations

- **Merkle hashing:** The merkle-reference library does not handle sparse arrays
  in its type system. End-to-end tests that hash sparse array output from `map`
  are not yet possible.
- **`rich-storable-value.ts` `HasToJSON` path:** `Object.freeze([...converted])`
  in the `HasToJSON` case would densify a sparse array returned from `toJSON()`.
  This is an edge case — `toJSON()` rarely returns sparse arrays.
