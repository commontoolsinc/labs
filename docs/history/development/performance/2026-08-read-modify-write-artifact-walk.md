---
status: historical
created: 2026-08-06
archived: 2026-08-06
reason: "Investigation of the read-modify-write benchmark regression traced to the artifact walk."
---

# Read-modify-write regression from the artifact walk, August 2026

## Result

Between the benchmark runs for `e7ea3bc9c2` and `9d927b8af7`, every
`flat list update - READ-MODIFY-WRITE` benchmark in
`packages/runner/test/cell-set-flat-index-list.bench.ts` slowed by roughly
seven times. The measurements below are from the Intel Xeon Platinum 8573C
runner; the same step appeared on both AMD runners, one run later on each,
which is when each next drew that processor.

| Benchmark | Before | After |
| --- | ---: | ---: |
| READ-MODIFY-WRITE, 100 items | 261 ms | 1,850 ms |
| READ-MODIFY-WRITE, 1000 items | 2,323 ms | 16,206 ms |
| READ-MODIFY-WRITE, 3000 items | 7,103 ms | 49,562 ms |

Each figure covers 20 update transactions, which is what the bench times.

The step inverted the relationship the benchmark exists to show. Reading the
list, replacing one element, and writing it back is meant to be far cheaper
than regenerating the whole list from scratch, because the elements a read
hands back carry their identity and only the changed one has to be written.
After the step, the read-modify-write case was slower than the regenerate
case: 16.2 seconds against 13.8 at 1000 items.

`Cell.set() - multiple transactions, one set each` in
`packages/runner/test/cell-set.bench.ts` moved on the same run boundary, from
about 98 ms to about 144 ms, and has the same cause.

## Cause

Bisecting the 28 commits between the two runs, with the bench cut down to
1000 items and 5 update transactions, identified
[#5342](https://github.com/commontoolsinc/labs/pull/5342) — `refactor(runner):
the runtime serializes its own cells and artifacts`. That change added a call
to `flattenBuilderArtifacts()` in `diffAndUpdate()`, so the raw write path
behind `Cell.set()` walks every value on its way in, looking for builder
artifacts to replace.

What a read hands back is a query-result proxy: a view whose members resolve
through the transaction it is bound to, one at a time, as they are asked for.
The walk descends into anything that reports itself as a plain object or an
array, and a view reports itself as both. So walking a list of 1000 views read
back a member of each, and each of their nested records in turn, and every one
of those reads was recorded on the transaction as a dependency the commit then
had to check.

Two costs, measured at 1000 items, one update transaction:

| Phase | Before | After |
| --- | ---: | ---: |
| `cell.set()` | 3 ms | 50 ms |
| `tx.commit()` | 38 ms | 250 ms |

The walk found nothing either time. Every element came back from it by
identity, exactly as it went in. A view fronts stored data, and a builder
artifact has no stored form, so on this path there was nothing under one for
the walk to replace.

The write path below the walk already treated a view as a leaf.
`normalizeAndDiff()` recognizes one and replaces it with the sigil link it
names, without reading a single member. That is why the read-modify-write case
was cheap to begin with: 1000 unchanged elements each became a link naming the
slot they already occupied, and only the one replaced element was written. The
walk running ahead of it defeated that by forcing the view before the diff
could decline to look at it.

## Fix

`replaceArtifacts()` in `packages/runner/src/encodable-form.ts` gained an
`isLeaf` hook, by which a caller names a value the walk must not read into,
and `diffAndUpdate()` answers it with the predicate `normalizeAndDiff()`
already uses to recognize a query result. `Runner.updateArgument()` answers it
too: the value it flattens goes only to writes, never to a serializer.

The hook belongs to the caller rather than to the walk, and the first attempt
at this fix, which made the walk skip a view unconditionally, is what shows
why. Reading a member of a view that holds a stream marker yields a real
`Cell`, because `createQueryResultProxy()` answers a `{ $stream: true }` value
with one. A `Cell` has no fabric representation either, and
`Runtime.getImmutableCell()` supplies the `replaceOther` hook that turns one
into the link naming it. Skipping the view there left the `Cell` in place, and
the conversion rejected it: "Not representable as a `FabricValue`: CellImpl".
Nothing in the tree covered that, so the whole runner suite passed.

The two boundaries want opposite answers, and what separates them is what each
does with the result. `getImmutableCell()` derives an entity id from the bytes
of the whole value, so it has to read every member either way, and descending
costs nothing it was not already going to spend. `diffAndUpdate()` hands the
value to a diff that replaces a query result with a link, so reading into one
is effect with no reader.

Measured on an Apple M5 Max, at 1000 items and 5 update transactions, three
runs of each variant of one tree back to back:

| Variant | Runs | Median |
| --- | --- | ---: |
| the walk absent from the raw write path | 216, 215, 213 ms | 215 ms |
| the walk as it stands | 1397, 1407, 1418 ms | 1,407 ms |
| the walk with the hook | 217, 210, 216 ms | 216 ms |

The per-transaction split above accounts for the same totals: five
transactions of 3 ms plus 38 ms is the first row, and of 50 ms plus 250 ms is
the second.

## Two things found along the way, not fixed here

The write accounting in `cell-set-flat-index-list.bench.ts` reports zeros for
every benchmark — `docs=0 storedBytes=0`, `avgBytes/tx=0 avgDocs/tx=0.0`. It
reads `tx.journal.novelty(space)` after the transaction has committed, and a
settled transaction no longer holds its journal. Stored bytes per item and
documents written per transaction are the questions the bench file's header
says it exists to answer, and it currently answers neither.

Those same reports never reach continuous integration in any case. They are
written with `console.error` from inside a benchmark body, which the JSON
reporter captures rather than passing through to stderr.
[`../../../development/BENCHMARKS.md`](../../../development/BENCHMARKS.md)
states the rule and names the fix: a body diagnostic writes to `Deno.stderr`
directly.
