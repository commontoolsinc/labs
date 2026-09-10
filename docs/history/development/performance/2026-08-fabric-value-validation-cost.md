---
status: historical
created: 2026-08-04
archived: 2026-08-04
reason: "Investigation record for the write-path validation slowdown visible on the benchmarks dashboard from 2026-07-29."
---

# Where the write path's validation time went, August 2026

## What was measured

Apple M5 Max, Deno 2.9.4 (the `mise.toml` pin), medians of repeated runs of
two benchmarks:

- `Cell.set() - depth: very deep (20 levels)` in
  `packages/runner/test/cell-set.bench.ts`
- `Cell push - array append schemaless (100x)` in
  `packages/runner/test/cell.bench.ts`

Runs alternated between two worktrees so that machine drift could not favour
either side. Numbers below are the reported per-iteration average, in
microseconds.

| | Cell.set very deep | Cell push |
|---|---|---|
| `main` at `54bfa33fb` | 23959 | 47107 |
| with the two changes described here | 16064 | 27212 |
| `main` with the inertness checks deleted outright | 22375 | 41013 |

The third row is the diagnostic upper bound: `isInertPlainObject()` cut back to
the bare prototype comparison it replaced, and the per-index descriptor loop
removed from `isInertArray()`. Both benchmarks land well below it, because the
larger of the two changes removes work that predates those checks.

## What the time was actually going to

Counting predicate calls for one iteration of each benchmark:

- `Cell.set` very deep: 49780 calls to `isInertPlainObject()`, walking 97498
  keys, for a value of 41 objects and 82 keys. About 500 calls per `set()`.
- `Cell push`: 5354 calls to `isInertArray()`, walking 358754 index keys.

Attributing those calls by stack, 461 of every 502 in the first case and 5250
of 5354 in the second arrive by the same route: `cloneHelper()` asks
`canReturnAsIs()` whether a value can be passed through as-is,
`canReturnAsIs()` asks `isDeepFrozenFabricValue()`, and that function
evaluated `isFabricValue(value) && isDeepFrozen(value)`. `isFabricValue()` is
an uncached recursive membership walk of the whole subtree, and `cloneHelper()`
recurses, so the walk ran once per node per level: quadratic in the depth of
the value. Every one of those walks was thrown away, because the value handed
to the write path is mutable and so was never going to be deep-frozen.

Swapping the two conjuncts fixes it. `isDeepFrozen()` answers in constant time
for anything not frozen at its root and memoizes every subtree it does walk, so
with it first the membership walk only runs for a value that could still answer
`true`.

## What each primitive costs

Measured on the two- and three-key objects the `Cell.set` benchmark builds
(three objects per iteration, twenty keys in total):

| Operation | Cost for three objects |
|---|---|
| prototype comparison | 24 ns |
| `Object.keys()` | 17 ns |
| `Object.getOwnPropertyNames()` | 17 ns |
| `Object.getOwnPropertySymbols()` | 39 ns |
| `Object.entries()` | 59 ns |
| `Object.assign()` into a fresh object | 59 ns |
| `Reflect.ownKeys()` | 279 ns |
| `Object.getOwnPropertyDescriptor()` per key | 228 ns |
| `Object.getOwnPropertyDescriptors()` | 1100 ns |

`Reflect.ownKeys()` is the outlier: it costs roughly what all three of the
single-purpose key reads cost together, several times over, and its cost is
per call rather than per key. Asking the three narrower questions separately —
enumerable string keys, all string keys, symbol keys — is what
`isInertPlainObject()` now does.

The bulk `Object.getOwnPropertyDescriptors()` is five times the price of
fetching the same descriptors one at a time, so the per-key call stays.
Descriptors are the only way JavaScript answers "is this an accessor", and
inertness turns on that question, so one descriptor per own key is the floor
for the check as specified.

## What did not work

Fusing validation into the copy loop — taking each own key once, reading its
descriptor, and building the clone from the value already in that descriptor —
measured *slower* than validating and then copying with `Object.assign()`: 664
ns against 602 ns for the same three objects. The copy is not where the time
goes. `Object.assign()` runs inside the engine at 59 ns for three objects,
while the descriptor walk it would fold into costs 228 ns and happens either
way. The same held for arrays: a fused copy-and-check loop measured 2.4 µs
against 2.5 µs for the separate loops, an improvement of well under the
per-element descriptor cost it cannot avoid.

The `Cell push` benchmark spends only about 7 ms of its roughly 43 ms in the
push loop; the rest is runtime construction, the initial `set()`, and disposal.
The array validation cost is spread across all of it rather than concentrated
in the loop, which is why loop-only profiling of that benchmark understates it
by an order of magnitude.
