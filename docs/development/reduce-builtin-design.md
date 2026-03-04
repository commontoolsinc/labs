# Reactive Array Operator: reduce

## Motivation

Pattern authors need to aggregate reactive arrays into single values — sums,
counts, group-by maps, statistics, derived structures. Today the only array
operators are `map` (1:1 transform), and the upcoming `filter` and `flatMap`.
None of these produce a scalar result from a list.

Authors work around this by manually iterating inside `derive()` or `lift()`,
but those callbacks operate on unwrapped snapshots and lose fine-grained
reactivity tracking. A dedicated `reduce` builtin makes aggregation a
first-class reactive operation.

## Scope

One new reactive array operator:

| Operator | Per-element? | Output | Output length |
|---|---|---|---|
| `map` (exists) | Yes — per-element pattern runs | mapped values | = input |
| `filter` (planned) | Yes — per-element pattern runs | original elements | ≤ input |
| `flatMap` (planned) | Yes — per-element pattern runs | flattened results | variable |
| **`reduce`** (new) | **No** — single reduction | **single accumulated value** | 1 |

## Architecture

### Key difference from map/filter/flatMap

Map, filter, and flatMap all create **per-element pattern runs** — one
pattern instance per array element, with identity-based reconciliation to
reuse runs across position changes. This works because each element is
processed independently.

Reduce is fundamentally different: it threads an accumulator through the
entire array. The accumulator at position `i` depends on the result at
position `i-1`. This sequential dependency means per-element pattern runs
don't work — each run would need the output of the previous run as input,
creating a chain of reactive dependencies that would re-cascade on every
change.

Instead, reduce uses **whole-array re-reduction**: when any element changes,
the reducer function runs over the entire array to produce a new accumulated
value. This matches `Array.prototype.reduce` semantics exactly and is the
natural reactive model for aggregation.

### Data flow

```
Input list: [cellA, cellB, cellC]
                │       │       │
                ▼       ▼       ▼
         ┌─────────────────────────────┐
         │ reducer(init, A) → acc₁     │
         │ reducer(acc₁, B) → acc₂     │  single pattern run
         │ reducer(acc₂, C) → result   │
         └─────────────┬───────────────┘
                       │
                       ▼
              Output: result              single accumulated value
```

- One pattern run wraps the entire reducer invocation.
- The pattern reads the list and initial value, iterates, and returns the
  final accumulator.
- When any element changes, the list cell updates, the pattern re-runs,
  and the output updates.

### Reactive chain

```
list cell updates → reduce action re-runs → output cell updates
```

Unlike map/filter/flatMap, there is no per-element reactive granularity.
Any change to any element triggers a full re-reduction. This is acceptable
because:

1. **Reduction is inherently sequential.** Changing element `i` can change
   the accumulator at every subsequent position. There's no shortcut.
2. **Reducers are typically cheap.** Aggregation functions (sum, count,
   group-by) are O(n) with small constants.
3. **The pattern system already handles this.** The reducer pattern reads
   from the list cell. When the list changes, the scheduler re-runs the
   pattern. No special machinery needed.

### Implementation approach: lift-based

Because reduce doesn't need per-element pattern runs, it can be implemented
as a thin wrapper around `lift` rather than a full builtin like map. The
reducer function runs inside a `lift()` that reads the whole array and
produces the accumulated value.

```
cell.reduce(fn, init)
  └─ lift((list, init) => list.reduce(fn, init))(cell, init)
```

This is simpler than a custom builtin and reuses existing infrastructure.
The `lift` approach:

- Automatically subscribes to the list cell
- Re-runs when the list changes
- Produces a single output cell with the accumulated value
- Gets correct scheduling, cancellation, and disposal for free

### Why not a builtin?

A builtin (like map) would be warranted if reduce needed:
- Per-element pattern runs (it doesn't — accumulator threading prevents it)
- Identity-based reconciliation (not applicable — single output, not array)
- Special lifecycle management (lift handles this)

The only advantage of a builtin would be potential incremental reduction
(maintaining partial accumulator state). But incremental reduction requires
an associative, commutative reducer (or at minimum, a known inverse
operation), which is too restrictive for a general-purpose `reduce`. If we
later want an incremental `sum` or `count`, those should be separate
specialized builtins.

## Sparse array handling

See `docs/specs/sparse-array-preservation.md` for background.

Reduce handles sparse arrays the same way as `Array.prototype.reduce`: holes
are skipped. The reducer callback is never called for absent indices.

Since the implementation delegates to `lift`, and inside the lift the code
calls the standard `Array.prototype.reduce` (or a sparse-safe equivalent),
holes are handled automatically:

```typescript
// Array.prototype.reduce already skips holes
[1, , 3].reduce((acc, x) => acc + x, 0)  // → 4, not NaN
```

However, our arrays pass through the reactive pipeline where they arrive as
cell references via `asCell: true`. The lift receives the unwrapped array.
If the unwrapped array is sparse, `Array.prototype.reduce` handles it
correctly. No special sparse handling is needed beyond what already exists.

**Implementation note:** Unlike map (which preserves holes in output) or
filter/flatMap (which produce dense output), reduce produces a single scalar
value. Sparseness of the input is irrelevant to the output shape.

## API

### User-facing

```typescript
// With initial value (recommended)
cell.reduce<S>(
  fn: (accumulator: S, element: ElementType, index: number, array: T) => S,
  initialValue: S,
): OpaqueRef<S>

// Without initial value (first element is initial accumulator)
cell.reduce(
  fn: (accumulator: ElementType, element: ElementType, index: number, array: T) => ElementType,
): OpaqueRef<ElementType>
```

Matches `Array.prototype.reduce` signature exactly. Both overloads supported.

### Examples

```typescript
// Sum
const total = prices.reduce((sum, price) => sum + price, 0);

// Count
const count = items.reduce((n) => n + 1, 0);

// Group by key
const grouped = items.reduce((groups, item) => {
  const key = item.category;
  return { ...groups, [key]: [...(groups[key] || []), item] };
}, {} as Record<string, Item[]>);

// Build index
const byId = items.reduce((index, item) => {
  return { ...index, [item.id]: item };
}, {} as Record<string, Item>);

// Max
const highest = scores.reduce((max, score) => score > max ? score : max, 0);
```

### Compiler transform

Unlike map/filter/flatMap, reduce does **not** need a `WithPattern` variant
or compiler strategy. The reducer function operates on unwrapped values
(accumulator + element), not on `OpaqueRef`s that need pattern extraction.
The `lift` wrapper handles the reactive boundary.

If `.reduce()` appears on a reactive array inside pattern code, the compiler
should treat it as a plain method call (same as it does today for `.reduce()`
inside `derive()` or `lift()`). No `reduceWithPattern` transform is needed.

**Rationale:** Map/filter/flatMap need compiler transforms because their
callbacks receive `OpaqueRef` arguments that must be compiled into separate
patterns. Reduce's callback receives plain unwrapped values (the accumulator
and element are both concrete), so no pattern extraction is needed. The
entire reduce runs inside a single `lift`.

## Implementation

### Cell method (packages/runner/src/cell.ts)

```typescript
reduce<S>(
  fn: (
    accumulator: S,
    element: T extends Array<infer U> ? U : T,
    index: number,
    array: T,
  ) => S,
  initialValue: S,
): OpaqueRef<S> {
  return lift((list: any[], init: S) => {
    if (!Array.isArray(list)) return init;
    return list.reduce(fn, init);
  })(this as unknown as OpaqueRef<any[]>, initialValue);
}
```

The no-initial-value overload:

```typescript
reduce(
  fn: (
    accumulator: T extends Array<infer U> ? U : T,
    element: T extends Array<infer U> ? U : T,
    index: number,
    array: T,
  ) => T extends Array<infer U> ? U : T,
): OpaqueRef<T extends Array<infer U> ? U : T> {
  return lift((list: any[]) => {
    if (!Array.isArray(list) || list.length === 0) return undefined;
    return list.reduce(fn);
  })(this as unknown as OpaqueRef<any[]>);
}
```

### Type interface (packages/api/index.ts)

Add `reduce` to the Cell interface alongside `map`, `filter`, `flatMap`:

```typescript
reduce<S>(
  fn: (accumulator: S, element: ElementType, index: number, array: T) => S,
  initialValue: S,
): OpaqueRef<S>;
reduce(
  fn: (accumulator: ElementType, element: ElementType, index: number, array: T) => ElementType,
): OpaqueRef<ElementType>;
```

### Files to modify

| File | Change |
|---|---|
| `packages/runner/src/cell.ts` | Add `reduce()` method to Cell class |
| `packages/api/index.ts` | Add `reduce` to Cell interface type |

### Files NOT modified

| File | Why not |
|---|---|
| `packages/runner/src/builtins/` | No new builtin — uses `lift` |
| `packages/runner/src/builtins/index.ts` | No registration needed |
| `packages/ts-transformers/` | No compiler strategy needed |
| `packages/runner/src/query-result-proxy.ts` | `reduce` is already listed as `ArrayMethodType.ReadOnly` |

### Tests

**`packages/runner/test/patterns-core.test.ts`** (or a new
`patterns-reduce.test.ts`):

1. **Basic sum** — `[1, 2, 3].reduce((a, x) => a + x, 0)` → `6`
2. **Reactive update** — Change an element, verify sum updates
3. **Object accumulator** — Group-by producing `Record<string, Item[]>`
4. **No initial value** — `[1, 2, 3].reduce((a, x) => a + x)` → `6`
5. **Empty array with initial value** — Returns initial value
6. **Empty array without initial value** — Returns `undefined`
7. **Single element without initial value** — Returns that element
8. **Sparse input** — `[1, <hole>, 3].reduce((a, x) => a + x, 0)` → `4`
9. **Chaining** — `cell.filter(pred).reduce(sum, 0)` works

## Implementation sequence

### Single phase

Reduce is simple enough to ship in one PR:

1. Add `reduce()` method to Cell class in `cell.ts`
2. Add `reduce` type signatures to `packages/api/index.ts`
3. Write tests
4. Ship

No builtin registration, no compiler changes, no multi-phase rollout needed.

## Design decisions

- **Whole-array re-reduction, not incremental.** Incremental reduction
  (maintaining partial state, applying deltas) requires algebraic properties
  of the reducer (associativity, inverse operations) that we can't assume
  for a general-purpose `reduce`. Full re-reduction is correct for all
  reducers.
- **`lift`-based, not a custom builtin.** Reduce doesn't need per-element
  pattern runs or identity reconciliation. Using `lift` reuses existing
  infrastructure and keeps the implementation small (~10 lines).
- **No compiler transform.** The reducer callback operates on unwrapped
  values, not `OpaqueRef`s. No pattern extraction needed. The entire reduce
  runs in a single `lift`.
- **Matches `Array.prototype.reduce` exactly.** Same signature, same
  behavior with/without initial value, same hole-skipping semantics. No
  surprises for JS developers.
- **No `reduceRight`.** Can be added later if needed. Same architecture,
  just reversed iteration.

## Comparison with map/filter/flatMap

| Aspect | map/filter/flatMap | reduce |
|---|---|---|
| Per-element pattern runs | Yes | No |
| Identity-based reconciliation | Yes | No |
| elementRuns state | Yes | No |
| Builtin module | Yes | No (uses lift) |
| Compiler strategy | Yes (WithPattern) | No |
| Sparse input handling | Skip holes | Skip holes (via Array.prototype.reduce) |
| Output shape | Array | Scalar |
| Reactive granularity | Per-element | Whole-array |
| Implementation complexity | ~170 lines | ~10 lines |

## Non-goals

- **Incremental/streaming reduce** — Would need algebraic reducer
  constraints. Specialized builtins (`sum`, `count`) are better for this.
- **reduceRight** — Same architecture, add later if needed.
- **scan** (running accumulator array) — Different operator: produces an
  array of intermediate results. Could be built as a builtin with
  per-element runs if the accumulator is threaded, but that's a separate
  design.
- **Parallel/tree reduction** — Over-engineering for reactive UI arrays.
