# Reactive Array Operators: filter, flatMap

## Motivation

Pattern authors need to filter and flatten reactive arrays. Today the only
array operator is `map`, which transforms each element 1:1. There is no
built-in way to reactively exclude elements (`filter`) or expand elements
into variable-length subsequences (`flatMap`).

Authors work around this with `ifElse` + null + post-processing for filter,
and nested maps with manual flattening for flatMap. Both are awkward and lose
the semantics JS developers expect.

## Scope

Three reactive array operators sharing a common architecture:

| Operator | Per-element result | Output array contains | Output length |
|---|---|---|---|
| `map` (exists) | mapped value (any) | result cells | = input length |
| `filter` (new) | boolean | original element cells | ≤ input length |
| `flatMap` (new) | array | flattened result cells | variable |

All three share: identity-based reconciliation, `WithPattern` compiler
transform, the same `{element, index, array, params}` pattern inputs, and
sparse array handling.

## Architecture

### Shared infrastructure

All three operators share:

1. **Identity tracking** — `getAsNormalizedFullLink()` + occurrence counting.
   Cell links get stable identity across position changes; inline values use
   positional identity.
2. **`lastIndex` optimization** — `runner.run()` only called when an element's
   index actually changed.
3. **Builtin signature** — Same `(inputsCell, sendResult, addCancel, cause,
   parentCell, runtime) => Action` shape.
4. **`WithPattern` Cell methods** — `filterWithPattern(pat, params)` and
   `flatMapWithPattern(pat, params)` for the compiler transform target.
5. **Compiler strategy** — Generalized from `map-strategy.ts` to handle all
   three methods.
6. **Sparse array handling** — All three skip holes in the input list. See
   "Sparse array handling" section below.

### filter

```
Input list: [cellA, cellB, cellC]
                │       │       │
                ▼       ▼       ▼
         ┌──────────┬──────────┬──────────┐
         │pred(A)→T │pred(B)→F │pred(C)→T │  predicate pattern runs
         └────┬─────┴────┬─────┴────┬─────┘
              │          │          │
              ▼          ▼          ▼
         read: true  read: false  read: true
              │                     │
              ▼                     ▼
         Output: [cellA,         cellC]       original cell references
```

- Per-element pattern returns a boolean.
- Filter action reads each predicate cell, pushes original element cell
  reference if truthy.
- Output is a shorter array of cell references to the original elements.

**Reactive chain**: Element value changes → predicate re-runs → predicate cell
updates → filter action re-runs (subscribed to predicate cells) → output
rebuilt.

**Two-pass convergence**: When a new element appears, its predicate hasn't run
yet (cell is `undefined`). The element is conservatively excluded. The
predicate then runs and sets its cell, re-triggering the filter action. On the
second pass, the predicate value is available. This is consistent with how the
runtime handles all dynamically instantiated patterns.

### flatMap

```
Input list: [cellA, cellB]
                │       │
                ▼       ▼
         ┌──────────┬──────────┐
         │fn(A)→[x,y]│fn(B)→[z]│  per-element pattern runs
         └────┬──────┴────┬────┘
              │           │
              ▼           ▼
         read: [x,y]  read: [z]
              │   │       │
              ▼   ▼       ▼
         Output: [x, y,   z]           flattened result cells
```

- Per-element pattern returns an array.
- FlatMap action reads each result cell's array value and concatenates them.
- Output is the flattened array.
- Like filter, flatMap reads result cell values (not just references), so it
  has the same two-pass convergence behavior for new elements.

### Sparse array handling

See `docs/specs/sparse-array-preservation.md` for background. Sparse arrays
are a core data structure in the reactive pipeline. The map builtin already
handles them: it uses `for` + `i in list` to skip holes, pre-allocates output
with `new Array(list.length)`, and uses indexed assignment so holes are
structurally preserved in the output.

Filter and flatMap handle sparse inputs but differ from map in output shape:

**How each operator handles sparse input `[A, <hole>, B]`:**

| Operator | Hole handling | Output |
|---|---|---|
| `map` | Skip hole, preserve in output via `new Array(len)` + indexed assignment | `[fn(A), <hole>, fn(B)]` — same length, holes preserved |
| `filter` | Skip hole, no predicate run | Dense shorter array — holes don't appear in output |
| `flatMap` | Skip hole, no pattern run | Dense flattened array — holes don't appear in output |

**Why map preserves holes but filter/flatMap don't:**

Map has 1:1 positional correspondence between input and output — element at
index `i` produces output at index `i`. Holes naturally carry through. Filter
and flatMap break this correspondence: filter produces a shorter array,
flatMap produces a variable-length array. There is no meaningful position to
place a hole in the output.

**Implementation requirements for filter and flatMap:**

1. **Input iteration**: Use `for` + `i in list` to skip holes. Never create
   pattern runs, identity keys, or result cells for hole indices. This is the
   same pattern used by map.
2. **Output construction**: Use `push` into a plain `[]` (not pre-allocated
   `new Array`). Output is always dense.
3. **flatMap result arrays**: When reading a per-element result array to
   flatten, use `forEach` to iterate it. If a pattern returns a sparse result
   array, holes in that sub-array are skipped during concatenation —
   consistent with `Array.prototype.flatMap` behavior.

**Sparse input example — filter:**

```
Input:  [cellA, <hole>, cellB, cellC]   (length 4, hole at index 1)
         │                │       │
         ▼                ▼       ▼
    pred(A)→T        pred(B)→F  pred(C)→T
         │                        │
         ▼                        ▼
Output: [cellA,               cellC]    (length 2, dense)
```

No predicate run is created for the hole. Only 3 pattern runs total.

**Sparse input example — flatMap:**

```
Input:  [cellA, <hole>, cellB]       (length 3, hole at index 1)
         │                │
         ▼                ▼
    fn(A)→[x,<hole>,y]  fn(B)→[z]
         │         │          │
         ▼         ▼          ▼
Output: [x,        y,        z]      (length 3, dense)
```

No pattern run for the input hole. Only 2 pattern runs total. The hole in
fn(A)'s result is also skipped — `forEach` is used to iterate sub-arrays,
which skips holes automatically. This matches `Array.prototype.flatMap`
behavior and ensures the output is always dense.

### State shape

All three use the same state structure:

```typescript
const elementRuns = new Map<
  string,
  { resultCell: Cell<any>; lastIndex: number }
>();
```

For map, `resultCell` holds the mapped value. For filter, it holds the
predicate boolean. For flatMap, it holds the result array. Same lifecycle:
entries persist for reuse, not pruned on removal, stopped via `addCancel`.

## Compiler: generalized array method strategy

### Current state

`map-strategy.ts` handles `.map()` → `.mapWithPattern()`. It:

1. `canTransform`: checks `isReactiveArrayMapCall` (method name is `"map"`,
   receiver is `OpaqueRef<T[]>` or `Cell<T[]>`)
2. `transform`: extracts callback into pattern, captures closures, emits
   `.mapWithPattern(pattern, params)`

Supporting infrastructure:
- `isReactiveArrayMapCall` in `type-inference.ts` — hardcodes `"map"`
- `call-kind.ts` — recognizes `"map"` and `"mapWithPattern"` as `"array-map"`
- `shouldTransformMap` — context-aware check (derive calls, safe wrapper
  detection, cell kind)

### Generalization plan

Rename/extend `map-strategy.ts` → `array-method-strategy.ts`:

1. **`isReactiveArrayMethodCall`** — Parameterize the method name check.
   Accept `"map" | "filter" | "flatMap"` instead of hardcoding `"map"`.
   Same logic otherwise: check receiver is reactive array type.

2. **`ArrayMethodStrategy.canTransform`** — Check for any of the three
   method names on reactive arrays.

3. **`shouldTransformArrayMethod`** — Same logic as `shouldTransformMap`,
   parameterized by method name.

4. **`createPatternCallWithParams`** — Already generic. Only change: emit
   the correct `WithPattern` method name (`mapWithPattern`,
   `filterWithPattern`, `flatMapWithPattern`).

5. **`call-kind.ts`** — Extend to recognize `"filter"`,
   `"filterWithPattern"`, `"flatMap"`, `"flatMapWithPattern"` as
   `"array-filter"` and `"array-flatmap"` kinds (or a unified
   `"array-method"` kind).

6. **`reactive-context.ts`** — Extend reactive context recognition to
   include filter/flatMap callbacks.

The callback extraction, closure capture, pattern building, and schema
inference logic is identical for all three. The only difference is the
emitted method name.

### Caveat: filter inside derive/lift

Today `.filter()` inside a `derive()` or `lift()` callback operates on a
plain unwrapped array (the `derive-filter-map-chain` test fixture
demonstrates this). The generalized strategy must preserve this behavior:
inside safe callback wrappers where `OpaqueRef` is auto-unwrapped, `.filter()`
is plain JS and must NOT be transformed. The existing `shouldTransformMap`
context check handles this for map; the same logic applies to filter and
flatMap.

## Implementation

### Files to create

**`packages/runner/src/builtins/filter.ts`**

Builtin function. Core loop (pseudocode):

```typescript
export function filter(
  inputsCell, sendResult, addCancel, cause, parentCell, runtime
): Action {
  let result: Cell<any[]> | undefined;
  const elementRuns = new Map<string, { resultCell: Cell<boolean>; lastIndex: number }>();

  return (tx) => {
    // Initialize result cell (same as map)
    // Read list and op via asSchema (same as map)

    const keyCounts = new Map<string, number>();
    const newArrayValue: any[] = [];

    for (let i = 0; i < list.length; i++) {
      if (!(i in list)) continue; // Skip sparse holes

      // Compute elementKey via getAsNormalizedFullLink() (same as map)

      if (elementRuns.has(elementKey)) {
        const existing = elementRuns.get(elementKey)!;
        if (existing.lastIndex !== i) {
          runtime.runner.run(tx, opPattern, {
            element: list[i], index: i,
            array: inputsCell.key("list"),
            params: inputsCell.key("params"),
          }, existing.resultCell, { doNotUpdateOnPatternChange: true });
          existing.lastIndex = i;
        }
      } else {
        // New element: create predicate run (same as map's new-element path)
      }

      // KEY DIFFERENCE FROM MAP: read predicate, push original element
      const included = elementRuns.get(elementKey)!.resultCell.withTx(tx).get();
      if (included) {
        newArrayValue.push(list[i]);
      }
    }

    resultWithLog.set(newArrayValue);
  };
}
```

**`packages/runner/src/builtins/flatmap.ts`**

Builtin function. Core loop (pseudocode):

```typescript
export function flatMap(
  inputsCell, sendResult, addCancel, cause, parentCell, runtime
): Action {
  let result: Cell<any[]> | undefined;
  const elementRuns = new Map<string, { resultCell: Cell<any[]>; lastIndex: number }>();

  return (tx) => {
    // Initialize result cell (same as map)
    // Read list and op via asSchema (same as map)

    const keyCounts = new Map<string, number>();
    const newArrayValue: any[] = [];

    for (let i = 0; i < list.length; i++) {
      if (!(i in list)) continue; // Skip sparse holes

      // Compute elementKey via getAsNormalizedFullLink() (same as map)

      if (elementRuns.has(elementKey)) {
        // Reuse existing pattern run (same as map/filter)
      } else {
        // New element: create pattern run (same as map's new-element path)
      }

      // KEY DIFFERENCE FROM MAP: read result array, flatten into output
      const resultArray = elementRuns.get(elementKey)!.resultCell.withTx(tx).get();
      if (Array.isArray(resultArray)) {
        // Use forEach to skip holes in sub-arrays (sparse-safe)
        resultArray.forEach((v) => {
          newArrayValue.push(v);
        });
      }
    }

    resultWithLog.set(newArrayValue);
  };
}
```

### Files to modify

**`packages/runner/src/builtins/index.ts`** — Register both builtins:

```typescript
import { filter } from "./filter.ts";
import { flatMap } from "./flatmap.ts";
// ...
moduleRegistry.addModuleByRef("filter", raw(filter));
moduleRegistry.addModuleByRef("flatMap", raw(flatMap));
```

**`packages/runner/src/cell.ts`** — Add four methods adjacent to `.map()`:

```typescript
let filterFactory: NodeFactory<any, any> | undefined;
let flatMapFactory: NodeFactory<any, any> | undefined;

// .filter(fn) — user-facing, wraps fn in pattern
filter(
  fn: (element, index, array) => Opaque<boolean>,
): OpaqueRef<(T extends Array<infer U> ? U : T)[]> { ... }

// .filterWithPattern(op, params) — compiler target
filterWithPattern(op, params): OpaqueRef<...> { ... }

// .flatMap(fn) — user-facing, wraps fn in pattern
flatMap<S>(
  fn: (element, index, array) => Opaque<S[]>,
): OpaqueRef<S[]> { ... }

// .flatMapWithPattern(op, params) — compiler target
flatMapWithPattern(op, params): OpaqueRef<...> { ... }
```

**`packages/runner/src/query-result-proxy.ts`** — `filter` and `flatMap` are
already listed as `ArrayMethodType.ReadOnly` (lines 39, 45). No changes
needed — these handle the plain-JS case inside lifts/handlers.

**`packages/ts-transformers/src/closures/strategies/map-strategy.ts`** —
Generalize to `array-method-strategy.ts` (or parameterize in place).

**`packages/ts-transformers/src/ast/type-inference.ts`** — Generalize
`isReactiveArrayMapCall` to accept method name parameter.

**`packages/ts-transformers/src/ast/call-kind.ts`** — Add `"filter"`,
`"filterWithPattern"`, `"flatMap"`, `"flatMapWithPattern"` recognition.

**`packages/api/index.ts`** — Add `filter`, `filterWithPattern`, `flatMap`,
`flatMapWithPattern` to the Cell interface type (alongside existing `map`,
`mapWithPattern`).

### Tests

**`packages/runner/test/patterns-dynamic.test.ts`** — Runtime tests:

Filter:
1. Basic filter — shorter output with correct values
2. Reactive predicate — element value changes flip inclusion
3. Identity reconciliation — mid-list insert, only new element evaluated
4. Duplicate cell references — `[A, B, A]` with all passing predicate
5. Empty and undefined inputs
6. Sparse input — `[A, <hole>, B]`, verify only 2 predicate runs, dense
   output

FlatMap:
1. Basic flatMap — each element expands to multiple, output is flattened
2. Reactive expansion — element value changes alter its result array length
3. Identity reconciliation — mid-list insert, existing expansions reused
4. Empty sub-arrays — some elements return `[]`, correctly omitted
5. Empty and undefined inputs
6. Sparse input — `[A, <hole>, B]`, verify only 2 pattern runs, dense output
7. Sparse sub-array — pattern returns sparse result, holes in sub-array are
   skipped in flattened output

**`packages/ts-transformers/test/`** — Compiler tests:

1. `.filter()` on reactive array → `.filterWithPattern()`
2. `.flatMap()` on reactive array → `.flatMapWithPattern()`
3. `.filter()` inside derive → NOT transformed (plain JS)
4. `.flatMap()` inside derive → NOT transformed (plain JS)
5. Chained: `.filter().map()` — filter transforms, map on result transforms
6. Chained: `.map().filter()` — both transform

## Implementation sequence

### Phase 1: filter runtime (no compiler)

Smallest useful increment. Authors use `cell.filter(fn)` explicitly.

1. Create `packages/runner/src/builtins/filter.ts`
2. Register in `packages/runner/src/builtins/index.ts`
3. Add `.filter()` and `.filterWithPattern()` to Cell class
4. Add to `packages/api/index.ts` Cell interface
5. Write runtime tests (including sparse input test)
6. Ship as a PR

### Phase 2: flatMap runtime (no compiler)

Same structure, independent of filter. Can be developed in parallel.

1. Create `packages/runner/src/builtins/flatmap.ts`
2. Register in `packages/runner/src/builtins/index.ts`
3. Add `.flatMap()` and `.flatMapWithPattern()` to Cell class
4. Add to `packages/api/index.ts` Cell interface
5. Write runtime tests (including sparse input and sparse sub-array tests)
6. Ship as a PR

### Phase 3: generalized compiler strategy

Depends on phases 1 and 2 (the `WithPattern` methods must exist for the
compiler to target them).

1. Generalize `map-strategy.ts` → handle `map`, `filter`, `flatMap`
2. Generalize `isReactiveArrayMapCall` → `isReactiveArrayMethodCall`
3. Extend `call-kind.ts` with new method names
4. Add compiler test fixtures
5. Ship as a PR

### Why this order

- **Phases 1 and 2 are independently useful.** Authors can use
  `cell.filter(fn)` and `cell.flatMap(fn)` immediately in hand-written
  pattern code. The `WithPattern` methods exist for manual use and as the
  future compiler target.
- **Phase 3 requires phases 1+2.** The compiler emits `filterWithPattern` /
  `flatMapWithPattern` calls, which must exist at runtime.
- **Phases 1 and 2 can run in parallel.** They touch the same files
  (`index.ts`, `cell.ts`, `api/index.ts`) but in additive, non-conflicting
  ways.
- **Phase 3 is lower priority.** Most patterns are hand-written (not
  compiled). The compiler transform is ergonomic polish, not a blocker.

## Design decisions

- **Predicate result coercion** — Truthy/falsy, not strict boolean.
  `if (included)` matches JS developer expectations.
- **flatMap depth** — One level, consistent with `Array.prototype.flatMap`.
- **Shared helper extraction** — Defer until all three operators exist.
  Extract a shared `reconcileElements` helper then if the duplication
  warrants it.
- **Sparse input handling** — All three operators skip holes via
  `i in list`. Map preserves holes in output (1:1 correspondence). Filter
  and flatMap produce dense output (no positional correspondence).
- **Sparse sub-arrays in flatMap** — Use `forEach` to iterate per-element
  result arrays, skipping holes. Consistent with `Array.prototype.flatMap`.

## Non-goals

- **filterMap** (combined filter + transform) — Authors chain
  `.filter(pred).map(transform)`.
- **Sorting** — Different operator, different design.
- **Pagination / windowing** — Different operator.
- **reduce** — Fundamentally different (accumulator, not per-element).
