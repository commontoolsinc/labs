---
status: historical
created: 2026-07-29
archived: 2026-07-29
reason: "Audit of the runtime caches with no bound a long session can reach, and the measurement of bounding them."
---

# Unbounded runtime caches, July 2026

## What this found

Four caches in the runtime grew with the number of distinct things a session
had ever handled, rather than with the number it was working on. A view that
pages forward through a long list reaches every one of them: each page brings
a fresh set of element results, action instances, and rendered values, and
none of those keys is ever revisited.

Two of the four had no bound at all. The other two had a bound that could not
be reached before the memory was gone.

| Cache                                         | Bound before          | Cost of one entry             |
| --------------------------------------------- | --------------------- | ----------------------------- |
| `dataURISyncCache` (`runner/src/storage/v2.ts`) | 10,000 entries       | a whole data URI as the key, plus a `Cell` |
| `stringRepCache` (`data-model/src/value-hash.ts`) | 50,000 entries      | the hashed string as the key  |
| `Scheduler.actionStats` (`runner/src/scheduler/timing.ts`) | none        | an action id and five numbers  |
| `Runner.locallyPrepared/StoppedResults` (`runner/src/runner.ts`) | none  | a result key and a pattern key |

The two counted bounds were the dangerous ones, because in both cases the
entry count says nothing about the cost. A data URI carries its whole value in
its id, so a rendered UI tree gives a key tens of kilobytes long, and 10,000 of
those is hundreds of megabytes before the cache notices it is full. The same
holds for the string hasher: whole documents and inlined data URIs reach it,
and the cache holds each one alive by its key.

`dataURISyncCache` had a second problem. Its value was the `Cell` the first
caller happened to pass, which kept that cell's transaction, that
transaction's runtime, and every value the transaction had read alive for as
long as the entry survived. It was also process-wide, so a second storage
manager could take a hit populated by the first and skip a pull its own
replica needed.

## Measurement

`packages/runner/test/window-retention-probe.ts` walks a projection window
forward over a long list, showing a position it has never shown on each move,
and reports the heap after a forced collection.

```
deno run -A --v8-flags=--expose-gc \
  packages/runner/test/window-retention-probe.ts index 24 2000 walk
```

|                            | before   | after    |
| -------------------------- | -------- | -------- |
| at rest, before the walk   | 93.9 MB  | 87.6 MB  |
| after 24 forward moves     | 171.9 MB | 163.0 MB |

The same walk with 20,000-byte rows and 12 moves goes from 99.5 MB to 142.1 MB
before, and 93.4 MB to 134.6 MB after.

So on this workload the fixes are worth about 5% of the retained heap, most of
it a lower floor rather than a lower slope. That is the honest figure for a
projection whose elements are plain documents. It understates what the same
fixes are worth to a view that renders its rows, because the probe's patterns
return fields rather than markup and so produce almost no inlined data URIs —
and the data-URI memo was both the largest entry and the one holding a live
cell.

The value of bounding these is not mainly the megabytes on any one run. It is
that none of the four had a ceiling a long session could not walk past.

## What is still unbounded

Two things remain, both visible by reading the code rather than by measuring.

`SpaceReplica` keeps a `DocumentRecord` for every document it has ever loaded
and drops them only when the session resets. Nothing tells it a document is no
longer wanted: the replica tracks sinks, but reactivity reaches the runtime
through the space-wide storage subscription instead, so the sink map stays
empty and carries no interest signal.

The memory v2 protocol cannot shrink a watch set from the client. `client.ts`
only ever calls `watchAddSync`, and accumulates `#watchSpecs` for the session's
lifetime. `session.watch.set` exists in the protocol and could replace a set,
but nothing drives it.

Together those mean a long-lived tab keeps every document it has read and stays
subscribed to all of them. The freeze, sorted-key, and value-hash caches in
`data-model` and `utils` are keyed on those documents, so they grow in step —
and the `WeakMap` and `WeakSet` tables behind them do not shrink once grown, so
a transient peak costs the tab for the rest of its life.

Releasing documents needs per-document interest tracking threaded from the
cells down to the replica, a watch-set shrink built on `session.watch.set`, and
a decision about what a read of a released document does. That is a design
change across the runner and memory packages, not a cache bound.
