---
status: historical
created: 2026-08-07
archived: 2026-08-07
reason: "Investigation of two storage benchmark steps: one traced to the sync replay registry and fixed, one that turned out not to be a step."
---

# The subscription-setup step, and the write step that was not one, August 2026

## Result

Two storage benchmarks were handed to this investigation as regressions
stepping in the first days of August 2026. They do not share a cause. One is a
real step with a single cause, now fixed. The other does not reproduce, and
the artifact history does not support it once the numbers are read raw.

`Storage - subscription setup plain doc (256 selectors)` in
`packages/runner/test/storage-subscription-refresh.bench.ts` stepped by about
a quarter again on all three processors. The cause is
[#5173](https://github.com/commontoolsinc/labs/pull/5173) — `fix(storage):
keep the first accepted space host route`. That change made every
`Provider.sync()` call compute two content hashes to build a key for the
registry of reads to replay if a provisional route is replaced. The bench
registers 256 selectors on one document, so it paid the key 256 times, and
every one of those keys came out the same. The fix replaces the hashed key
with the identity of the normalized selector, which the registry already
holds.

`Write vs Commit - 100 writes to 1 entity, measure writes only` in
`packages/runner/test/storage.bench.ts` did not step. Its raw timings drift
gently across the whole 45 days the artifacts cover, and the August movement
that was read as a step comes from two runs on the thinnest processor that
were slow across every benchmark in them, plus one high final sample.

## The subscription-setup step

### Where the artifacts put it

Each processor's series was rebuilt from every `bench-results` artifact the
Benchmarks workflow produced on `main` between 24 June and 7 August 2026,
which is 394 successful runs. Raw per-benchmark timings, block medians of
twelve consecutive runs, in microseconds:

| Window | EPYC 7763 | EPYC 9V74 | Xeon 8573C |
| --- | ---: | ---: | ---: |
| late June | 8,676 | 8,330 | — |
| mid July | 9,405 | 9,033 | 7,800 |
| late July into August | 10,556 | 9,682 | 8,532 |
| first week of August | 12,561 | 12,722 | 11,365 |

The blocks do not cover identical dates on each processor, because each
processor draws whichever runs the scheduler happens to give it.

The step sits inside the last two rows. Read run by run, the last low sample
and the first high one bracket it on each processor:

| Processor | After | By | Step |
| --- | --- | --- | ---: |
| EPYC 7763 | `6efb92fb9` | `de7465bb3` | 10,563 to 13,494 |
| EPYC 9V74 | `ae805e236` | `e7ea3bc9c` | 10,306 to 12,722 |

The two intervals overlap, and their intersection is the commits after
`ae805e236` up to and including `de7465bb3`, which is twenty commits. The
8573C agrees with that interval but has too few runs in it to narrow it.

The same twenty commits hold the interval the earlier headline decomposition
assigned to `Immutable cell - storage manager setup and cleanup only`, which
stepped by about eight to ten times. That benchmark has since returned to its
old level, which is the second corroboration of the interval: the return lands
on `09970c125`, a later fix to the same change, discussed below. A separate
investigation of that step, recorded in
[`2026-08-storage-manager-construction-cost.md`](2026-08-storage-manager-construction-cost.md),
arrived at the same interval and the same commit inside it by its own route.

### Bisecting it

The bench body was cut down to a harness that runs the same work — create a
storage manager, open a provider, send one document, register 256 selectors
on it, wait for the sync barrier, close the manager — and times each of those
phases separately rather than only their sum. One measurement takes about a
second at eighty iterations.

Splitting the phases is what made the step visible. The aggregate that
`deno bench` reports for this benchmark does not reproduce on a development
machine over the twenty-commit interval; run as a single file it moves the
other way, because the other phases move more than the one that regressed and
they move downward. The phase that carries the step is the loop that
registers the 256 selectors, and it carries it plainly. Medians of five
interleaved runs, a hundred iterations each, on an Apple Silicon machine with
the repository's pinned Deno:

| Commit | Selector-registration phase |
| --- | ---: |
| `a3dcbb28b`, the parent | 1.23 ms |
| `87beb5f78` | 2.50 ms |

The same runs show manager construction going from about 0.025 milliseconds to
about 0.043, which is the eager route resolution described below, in the same
commit.

That is the whole of the step, and it is one commit:
`87beb5f78 fix(storage): keep the first accepted space host route (#5173)`.

### Cause

That change taught a provider to survive having its route replaced. An
unseeded space can be opened against the default memory host before its
durable host hint arrives; when the hint arrives, the provider builds a
replacement replica and replays onto it every read that was registered
against the provisional one. To replay them it has to remember them, so
`sync()` gained a registry of the reads it has been asked for.

The registry was keyed by a string, and the string was built by
`watchIdForEntry()`, which content-hashes the address and the selector
together. Building that key costs two content hashes: one over the selector's
path and schema hash, and one over the address and the first hash's result.
Neither result is cached, because each is taken over a freshly built wrapper
object rather than over the interned selector, and content hashes are only
memoized against values that are already deeply frozen.

So the key cost two hashes on every call, and `sync()` is called once per
selector. The benchmark registers 256 selectors on one document. Worse, every
one of those 256 keys is the same string. The selectors differ only in their
path, and they all carry `schema: false`; a schemaless read accepts nothing,
so `normalizeSyncSelector()` collapses it to one shared rejecting selector and
discards the path. The document is the same for all 256. The benchmark
therefore hashed 512 times to discover, 256 times over, that it was looking at
a read it had already registered.

The wire-level watch identifier that `watchIdForEntry()` also produces is a
different matter and is left alone. That one is sent to the server and has to
be a stable content hash. The registry's key never leaves the provider.

### Fix

The registry becomes two levels: a map from document to a map from normalized
selector to the request. The outer key reuses the `docKey()` helper the file
already has for addressing a document by scope and identifier. The inner key
is the normalized selector itself, by object identity.

Identity is exact here, and the reason is worth stating because it is what
makes the cheap key safe. `normalizeSyncSelector()` returns either the shared
rejecting selector, which is a module constant, or a canonical interned
instance. The interning table holds its canonical instances through weak
references, so an instance could in principle be collected and a later
structurally equal selector could get a fresh one. It cannot happen here: the
registry entry holds the selector, so while an entry exists its selector is
strongly reachable and interning keeps handing back that same object. Two
registrations are the same registration exactly when their normalized
selectors are the same object.

Measured the same way, medians of five interleaved runs. This is a separate
measurement session from the table above, so the absolute levels differ a
little; `a3dcbb28b` appears in both and reads 1.23 there against 1.11 here.
The tip measured is `65d34e146`, which is where this change was written.

| Variant | Selector-registration phase |
| --- | ---: |
| before the regression, `a3dcbb28b` | 1.11 ms |
| `65d34e146` | 2.22 ms |
| `65d34e146` with the fix | 1.15 ms |

The fix returns that phase to the level it had before the change, which is
what the reasoning above predicts: the work removed is the whole of what was
added, and nothing else in the phase moved.

The whole-benchmark figure that `deno bench` reports cannot separate the two
variants on this machine. The saving is about a millisecond against a total of
about six, and the other phases vary by more than that between runs. That is a
property of the measurement here, not of the change: the benchmark on the
continuous-integration runners is about twice as long, runs in a stable
environment, and has hundreds of runs behind each level.

### What the fix does not cover

Two other things moved in the same interval and are not this fix.

`87beb5f78` also resolved the default storage route eagerly on every
`StorageManager` construction. That is what took `Immutable cell - storage
manager setup and cleanup only` up by roughly eight to ten times, depending on
the processor. It was already fixed by `09970c125 perf(runner): resolve the
default storage route when it is read (#5428)`, which made the resolution
happen on first read, and the benchmark returned to its old level when that
landed. That step has its own record, in
[`2026-08-storage-manager-construction-cost.md`](2026-08-storage-manager-construction-cost.md),
which reached the same commit and the same twenty-commit interval
independently. The two costs are separate: one is paid once per manager
construction, the other once per `sync()` call.

Separately, `subscription setup plain doc` has a gradual rise underneath the
step, from about 8,700 microseconds in late June to about 10,500 by the end
of July on the EPYC 7763, before the step took it to about 12,500. That drift
is not addressed here. It is part of the long tail of small rises that the
headline decomposition recorded and left unexplained.

## The write benchmark, which did not step

`Write vs Commit - 100 writes to 1 entity, measure writes only` writes 100
times to a single entity and times only the writes. Its sibling
`100 new entities` writes once to each of 100 entities and did not move, which
suggested a cost that grows with the number of writes already made to the same
entity. Writing to one entity 100 times does cost about five times what
writing to 100 entities once costs, so that shape is real. It is not new.

Raw block medians of twelve consecutive runs, in microseconds:

| Processor | Range across 24 June to 7 August |
| --- | --- |
| EPYC 7763 | 1,048 to 1,246, drifting upward |
| EPYC 9V74 | 1,031 to 1,179, drifting upward |
| Xeon 8573C | 836, 866, 868, then 1,152 |

There is no step in the two processors with most of the runs behind them: 221
runs on the EPYC 7763 and 125 on the EPYC 9V74 show a gentle upward drift of
about a tenth over 45 days and nothing else. The 8573C's final block is the
only figure that looks like a step, and it is two runs, both of which are
about a seventh slower than the previous run across all 389 benchmarks they
share with it. That is the machine, not the benchmark. The EPYC 7763's final
run is a single sample at 1,796 microseconds against a level of about 1,240;
that run is not slow across the suite, so the sample is a genuine outlier, but
one sample is one sample.

The benchmark was also measured directly at twelve commits spanning the whole
candidate range, from `ae805e236` to `65d34e146`. It is flat: every
measurement falls between 0.64 and 0.81 milliseconds, with no ordering by
date. There is nothing to bisect.

## A caution about normalizing by the run median

Part of this investigation ran on series normalized by dividing each
benchmark's timing by the median timing across all benchmarks in the same run.
That cancels whole-run machine drift, and it is what showed that the 8573C's
last two runs were uniformly slow rather than carrying a regression. It also
merges the three processors into one series, which roughly triples the
resolution available for locating a boundary.

It manufactures steps when the suite as a whole changes speed. On 6 July 2026
the run median dropped by about a fifth, at `4e302bce9`. Every benchmark that
did not share in that improvement rose by about a quarter in normalized terms
on that date, including the write benchmark, whose raw timings are flat right
across the boundary. A normalized step is only a benchmark's step if the raw
series agrees, and the raw series is the one to check first.
