# Incremental collection aggregates

Array-valued `Cell` and `Writable` inputs expose named aggregates. These methods
build reactive computations in a pattern body. Predicate and score callbacks
receive an element, its reactive index, and the source array; captured values
remain reactive, using the same callback lowering as `map`.

| Method | Result | Empty array |
| --- | --- | --- |
| `items.count()` | Number of present members | `0` |
| `items.count(predicate)` | Number of truthy predicate results | `0` |
| `numbers.sum()` | Exactly accumulated numeric sum, rounded once | Positive `0` |
| `numbers.min()` | Smallest number | `Infinity` |
| `numbers.max()` | Largest number | `-Infinity` |
| `items.minBy(score)` | Element with the smallest numeric score | `undefined` |
| `items.maxBy(score)` | Element with the largest numeric score | `undefined` |

The public type surface requires an explicit cell receiver. `Reactive<T>` is an
alias for `T`, so ordinary array-typed pattern inputs and the array returned by
`map` do not expose these additional methods through TypeScript. In particular,
`rows.map(score).sum()` is not supported by the public types. Broadening that
surface is separate from the aggregate runtime implementation.

Direct builder callers use `countWithPattern`, `minByWithPattern`, and
`maxByWithPattern` with a score or predicate pattern and its captured parameters.
The transformer emits those forms for authored callbacks, including explicit
cell receivers inside `computed`. Calling a callback form directly without
lowering throws, as it does for `map`.

Reactive proxies expose aggregate methods on receivers whose resolved schema
has the top-level type `array`. Direct builder construction must supply that
schema; union-only schemas do not expose these methods through a reactive
proxy. Raw Cell methods are unaffected. On object and schemaless receivers,
names such as `sum` and `count` remain ordinary data fields.

## Determinism and numeric behavior

Finite sums accumulate signed integer multiples of the smallest binary64
subnormal. Combining partial sums loses no finite precision. The final result
rounds once to binary64, with ties to even and positive zero. Collection order,
tree shape, and intermediate edits cannot change the result for the same finite
members. A sum can therefore differ from a left-to-right JavaScript reduction:
`1e16 + 1 - 1e16` yields `1` under this contract.

Any NaN input makes the sum NaN. Positive and negative infinity together also
produce NaN; either infinity alone dominates finite contributions. A finite
exact total that overflows during final rounding produces signed infinity.

`min` and `max` propagate NaN. Minimum prefers negative zero and maximum prefers
positive zero. The By forms select a NaN-scored element when one exists. Equal
scores, including two NaNs or signed zeros, select by stable source identity in
UTF-8 order. Reordering the same linked elements preserves the winner. Duplicate
occurrences use the collection identity machinery's occurrence keys. A By result
remains a link to the selected element, retaining its schema and scope.

Sparse holes contribute nothing. For argument-free `count`, `sum`, `min`, and
`max`, a confirmed source transition to `undefined` clears the result and
releases its children. Callback forms inherit `map`'s treatment of an undefined
source as an empty collection: predicate count yields `0`, and the By forms
yield `undefined`. Numeric aggregates require numbers, and score callbacks
require numeric results.

## Work and ownership

The runtime sorts element identity keys and builds a balanced tree with at most
32 elements in a leaf block. A change to an independently linked member reads
one block and recomputes its ancestors. Predicate and score evaluation use the
existing per-element `map` machinery. A callback that reads the entire array or
a captured value shared by every element can invalidate every callback.

Initialization and membership changes reconcile the collection: O(N) identity
reads and O(N log N) sorting. Appending, removing, or reordering can rebuild many
blocks. Inline primitive arrays store their values in the membership document,
so changing one of those values also takes this reconciliation path. This is
not a cheap-append implementation.

Tree nodes are ordinary child runs with transaction rollback and child-lifetime
ownership. Only the result container belongs to the coordinator for its whole
lifetime. Cold initialization confirms stored inputs and the result container
before interpreting defaults or replacing a durable result. The map scope probe
observes link structure; scalar result changes do not resubscribe its coordinator
to every element's content.

Generic `reduce` remains the full-rerun option for order-dependent folds. Lower
read counts alone do not establish a speedup: compare committed updates through
settlement with `packages/runner/test/aggregate.bench.ts`. The benchmark covers
all six names at 10, 100, and 1,000 linked rows, including predicate/score
maintenance, and excludes fixture construction and disposal from update timing.

For a paired comparison, run the standalone report:

```sh
ENV=test deno run --allow-ffi --allow-env --allow-read \
  --allow-write=/tmp,/var/folders packages/runner/test/aggregate-comparison.ts
```

It emits JSON lines with initialization counters, update counters, and twelve
timed updates after one warmup. Timing alternates the two implementations and
disables read accounting; a separate update collects counters. Extrema updates
alternate the winning element. Initialization timing includes read accounting
and source commits, but excludes pattern compilation and source construction.
