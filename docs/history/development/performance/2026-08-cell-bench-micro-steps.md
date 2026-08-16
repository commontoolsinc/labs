---
status: historical
created: 2026-08-07
archived: 2026-08-07
reason: "Why the two cell.bench.ts micro-benchmark steps in the 21% benchmark headline are not regressions, and what was changed so the trend stops reporting them."
---

# The two `cell.bench.ts` micro-benchmark steps are stalled runners

## Question

A decomposition of the dashboard's 21% benchmark headline, run over every
`bench-results` artifact the Benchmarks workflow produced on `main` between 24
June and 7 August 2026, listed nineteen corroborated step regressions. Two of
them are in `packages/runner/test/cell.bench.ts`:

| Benchmark | Step | Processors | Confined to |
| --- | ---: | ---: | --- |
| Cell concurrent — multiple cells | 1.33× | 2 of 3 | after `dd63b3d25`, by `c97de0181` |
| Cell equals — comparison operations | 1.32× | 2 of 3 | intervals disagree |

These are the two smallest of the corroborated moves, and both are
per-operation micro-benchmarks where a hundred operations are timed together.
Are they real?

## Result

Neither is real. Both are a single stalled sample inside one run, folded into
the arithmetic mean that the dashboard reads.

Every elevated reading in the artifact history arrives with two companions: a
maximum sample of 150 to 270 milliseconds against a typical sample of 6 to 25
milliseconds, and a reduced sample count, because a stalled sample eats the
measurement budget that would otherwise have bought more samples. Removing the
single largest sample from each run collapses the run-to-run spread to the
level of the ordinary noise, on every processor. Checking out both ends of the
named commit range and measuring locally reproduces no step at all.

The bench file is unchanged across the range, and so, as far as these two
benchmarks can see, is everything they measure.

## The artifact history

Each run below is one `bench-results` artifact from the Benchmarks workflow.
`avg` is the number the dashboard reads. `trimmed` is the mean recomputed with
the single largest sample removed, which is the whole of the correction.

`Cell concurrent - multiple cells (100x)`, on the two processors the step was
reported from. Times are microseconds.

| Processor | Run | Commit | avg | max | samples | trimmed |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| EPYC 9V74 | 1 Aug 12:24 | `ee84effe3` | 21,304 | 25,145 | 34 | 21,187 |
| EPYC 9V74 | 3 Aug 09:10 | `c97de0181` | 31,393 | 208,873 | 30 | 25,273 |
| Xeon 8573C | 2 Aug 20:22 | `dd63b3d25` | 17,180 | 20,139 | 40 | 17,105 |
| Xeon 8573C | 3 Aug 13:06 | `c97de0181` | 26,347 | 195,693 | 26 | 19,573 |

The step is the pair of rows whose maximum sample is around 200,000
microseconds. Both runs that read low have a maximum of about 20,000, which is
the ordinary top of the distribution. The run that reads high on each processor
collected fewer samples than the run that reads low, which is what a stall does
to a fixed measurement budget.

On the processor with by far the most runs, the EPYC 7763, the step is absent
altogether. Its four runs of `dd63b3d25` read 24,599, 24,645, 24,628 and
26,321. Its next two runs are inside the candidate range — `a4112009b` and
`6efb92fb9` — and read 24,180 and 25,052. Nothing moved.

`Cell equals - comparison operations (100x)` is the same mechanism, and its
per-processor boundaries disagree because the stalls fall on different runs.
On the EPYC 9V74 and the Xeon 8573C the run at `c97de0181` is one of the clean
ones, with a maximum of 9,744 and 11,637 microseconds, and it is the *earlier*
run that carries the stall. So on those two processors the benchmark reads
faster after the boundary than before it. On the EPYC 7763 the readings
alternate run by run between about 6,400 when the maximum is 10,000 and about
8,400 when the maximum is 150,000.

Removing one sample per run accounts for all of it. Over the same window:

| Benchmark | Processor | Spread of `avg` | Spread of trimmed mean | Spread of `p75` | Spread of `min` |
| --- | --- | ---: | ---: | ---: | ---: |
| Cell concurrent | EPYC 7763 | 1.79× | 1.23× | 1.26× | 1.13× |
| Cell concurrent | EPYC 9V74 | 1.60× | 1.21× | 1.20× | 1.22× |
| Cell concurrent | Xeon 8573C | 1.62× | 1.25× | 1.24× | 1.36× |
| Cell equals | EPYC 7763 | 1.93× | 1.23× | 1.32× | 1.14× |
| Cell equals | EPYC 9V74 | 1.49× | 1.17× | 1.30× | 1.32× |
| Cell equals | Xeon 8573C | 1.43× | 1.34× | 1.45× | 1.43× |

A claimed step of 1.25 to 1.41 times sits inside a spread of 1.43 to 1.93
times. It is not distinguishable from the sampling, and once one sample per run
is removed there is nothing left of it.

## Measuring both ends of the range locally

Both ends of the range named for `Cell concurrent` were checked out into
separate worktrees, `dd63b3d25` and `c97de0181`, and the two benchmarks were
extracted into a file of their own so one measurement takes seconds. Each end
was measured eight times, alternating between them so that any drift in the
machine falls on both sides equally. Apple M5 Max, Deno 2.9.4, the same
`--v8-flags=--expose-gc` the workflow passes.

| Benchmark | Before the range | After the range | Ratio | Claimed |
| --- | ---: | ---: | ---: | ---: |
| Cell concurrent — multiple cells | 9,815 | 9,731 | 0.99× | 1.25× and 1.41× |
| Cell equals — comparison operations | 3,853 | 4,022 | 1.04× | 1.25× and 1.38× |

The eight readings on each side overlap: `Cell equals` ranged from 3,737 to
4,324 before and from 3,737 to 4,115 after. There was nothing to bisect, so no
bisect was run.

## Why a stall lands on the average this hard

`deno bench` measures each benchmark for a roughly fixed amount of wall-clock
time and reports the mean over however many samples fit. From the artifacts
that budget is about half a second for `Cell equals`, which collects around 90
samples of about 5.9 milliseconds, and about three quarters of a second for
`Cell concurrent`, which collects around 31 samples of about 24.6 milliseconds.

A single stall of a fifth of a second added to a measurement window of half a
second raises the mean by about 40%, and the sample count has nothing to do
with it. The stall is a fixed quantity of time added to a fixed budget. That
arithmetic is the whole of the reported steps: the stalls in the artifacts run
from 150 to 270 milliseconds, and the steps run from 1.25 to 1.45 times.

The same reasoning says the shape of the benchmark body cannot fix this. If a
body times only part of itself, a stall reaches the reported number only when
it lands inside the timed part, but when it does land there it is divided by a
proportionally smaller measured total. The expected inflation is the stall
divided by the whole budget either way. Bracketing a body makes the event
rarer and correspondingly larger, which raises the variance rather than
lowering it. Measurements of the bracketed benchmarks confirmed that: their
averages moved about over a wider range than the unbracketed ones did.

What escapes the stall is any statistic a handful of samples cannot reach. A
stall can only push a sample up, so with 30 or more samples in a run it lands
above the 75th percentile and leaves it alone.

The first attempt at this read the fastest sample instead, on the reasoning that
a stall never reaches the minimum while a change in the code moves the minimum
along with everything else. The second half of that is wrong. The minimum is the
floor of the distribution, and a change that leaves the best case alone while
making some fraction of runs slower moves nothing the floor can see: a path that
starts missing a cache, a branch that fires only on certain shapes. Such a
change widens the distribution upward, and only a statistic above the floor
registers it. Reading `min` would have traded one blind spot for another.

Two candidates survive that. Below is every statistic `deno bench` reports,
against the regressions in this window that have since been root-caused and
fixed, and against the three moves that have been shown to be artifacts. Each
figure is the median across processors of the ratio between the median of the
six days before the boundary and the six days after.

| Benchmark | `min` | `p75` | `avg` | `p99` | `p999` |
| --- | ---: | ---: | ---: | ---: | ---: |
| READ-MODIFY-WRITE, 1000 items | 7.55× | 6.88× | 7.04× | 6.17× | 6.17× |
| READ-MODIFY-WRITE, 3000 items | 7.57× | 6.86× | 7.01× | 6.74× | 6.74× |
| READ-MODIFY-WRITE, 100 items | 6.75× | 6.73× | 6.45× | 5.68× | 5.68× |
| Immutable cell — storage manager setup and cleanup | 9.55× | 9.07× | 8.60× | 5.91× | 2.72× |
| flat list read — schemaless, 1000 items | 2.41× | 2.26× | 2.43× | 3.42× | 3.42× |
| flat list read — schemaless, 3000 items | 2.44× | 4.42× | 3.03× | 4.63× | 4.63× |
| schema read depth — schemaless, 1000 items | 2.09× | 1.89× | 2.32× | 4.41× | 4.41× |
| Cell.set() — multiple transactions | 1.45× | 1.50× | 1.50× | 1.53× | 1.53× |
| *v2-entity-id-list — current live-1k-small* | *1.08×* | *1.09×* | *1.98×* | *11.65×* | *62.13×* |
| *Cell concurrent — multiple cells* | *1.01×* | *1.02×* | *1.08×* | *1.04×* | *1.04×* |
| *Cell equals — comparison operations* | *1.01×* | *0.99×* | *0.99×* | *1.02×* | *1.02×* |

The last three rows are the artifacts, in italics. `current live-1k-small` is
one:
[`2026-08-schemaless-read-membership-walk.md`](2026-08-schemaless-read-membership-walk.md)
measured it twice at each commit across the range and found no step, and its
series carries the stall signature — the same commit reads 326,036 and 569,757
microseconds on different runs, with the sample count halving on the slower one.
Its tail statistics move by 12 and 62 times on nothing at all.

Every statistic detects every confirmed regression, the weakest detection being
1.45 times. They differ entirely on the false ones. `avg`, `p99` and `p999` all
fire on `current live-1k-small`; `min` and `p75` do not. The same separation
shows in the rate at which two neighbouring runs disagree by more than a quarter
with no change behind them, over every benchmark in the artifacts:

| Processor | Runs | `min` | `p75` | `avg` | `p99` | `p999` |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| AMD EPYC 7763 | 221 | 1.2% | 2.1% | 2.5% | 11.2% | 13.8% |
| AMD EPYC 9V74 | 125 | 11.2% | 10.8% | 10.9% | 18.0% | 19.7% |
| Intel Xeon 8573C | 39 | 5.0% | 6.7% | 6.8% | 17.1% | 20.6% |

So `p75` matches `min` on both detection and rejection while not being blind to
a widening distribution, and it is what the trend now reads.

This is a limit of the sampling rather than a claim that the tail does not
matter. On a user-facing timing the tail is exactly what a person notices, and
`p99` would be the right lens. It is unusable here because at these sample
counts, on shared runners, `p99` is mostly a measure of how badly the runner
stalled — 11 to 21% of neighbouring run pairs disagree by more than a quarter
with nothing behind it. Separating the runner's stalls from the tail the code
produces is what would make the tail readable, and nothing here does that.

## Reproducing the signature deliberately

To confirm the reading, the stall was injected rather than waited for: one
iteration in sixty burns a fifth of a second in a busy loop, in the phase of
the body that builds the fixture. `Cell equals` went from 5,188 to 8,830
microseconds, a factor of 1.70; its sample count fell from 106 to 69; and its
maximum sample became 203,805 microseconds. That is the artifact signature
exactly — the elevated average, the reduced sample count and the maximum near
200,000 all appear together, as they do in every elevated run in the history.

This experiment places the stall outside the timed region on purpose, so it
demonstrates that the signature is reproducible. It does not demonstrate that
bracketing removes the noise, and the measurements above say it does not.

## Not the same thing as a slow host

[`2026-08-benchmark-headline-machine-noise.md`](2026-08-benchmark-headline-machine-noise.md)
found the larger part of the same 21% headline in the machine: the runner group
serves several hosts under one processor name, and a run that lands on a busy
one reads slow in everything it measures. Every run now also measures the
machine, through benchmarks that call no repository code, and the tile divides
their movement out of each step of its index.

That correction does not cover what is described here, and the two are worth
keeping apart. A busy host is slow for the whole job, so it shows up in the
calibration benchmarks and divides out. A stall of a fifth of a second lands in
one sample of one benchmark. The calibration benchmarks run at some other point
in the job and are not touched by it, so there is nothing in their movement to
divide it out with. What removes it is not measuring the machine but reading a
statistic that a single sample cannot reach, which is why both changes are
needed.

## A second defect these two benchmarks have

Both benchmarks time their fixture along with the operation they name. The body
of `Cell equals - comparison operations (100x)` builds a storage manager, a
runtime and a transaction, creates three cells, writes two of them, commits,
performs 200 comparisons, commits again and disposes of the runtime — and
`Deno.bench` times all of it.

Measured on the Apple M5 Max with the comparisons timed separately, the 200
comparisons are 282 microseconds of a 3,837-microsecond body. The benchmark
named for `Cell.equals()` is 93% runtime construction and teardown. Doubling
the cost of `Cell.equals()` would move it by 7%, which is far inside its own
noise. `Cell concurrent` is less extreme: its thousand `get()` calls are 3,647
microseconds of a 9,672-microsecond body, so 38% of what it reports.

This is a second way to manufacture the signal the investigation was chasing.
A change to runtime construction or to commit moves every benchmark shaped like
this, and each one reads on the chart as a regression in whatever it is named
for.

## What was changed

Three changes. Two address the defects above; the third is a mislabelled column
found while checking what the drill-down actually plots.

`packages/runner/test/cell.bench.ts` now brackets both measurements with
`b.start()` and `b.end()`, which is the form the two `Cell getAsLink`
benchmarks a few hundred lines above already use, and which the two bodies were
already written for — each had a `// Measure ...` comment marking the point the
bracket belongs at. This does not reduce the noise, and is not meant to; it
makes each benchmark report the operation it is named for. Both will read
substantially lower from the next run onward, which the dashboard shows as a
one-off step in those two lines.

`packages/dashboard/tiles/benchmark.ts` compares 75th percentiles rather than
averages when it builds the per-processor index. The parser already carried
`p75` through into the cached statistics, so no cache format changed and no
history needed refetching.

`packages/dashboard/tiles/benchmark.test.ts` gained two tests, one for each way
the statistic can be wrong. The first feeds the tile twenty-four runs whose 75th
percentile never moves and whose average steps up 40% halfway through, and
asserts the trend reads flat; reading the average reports a warning instead. The
second feeds it twenty-four runs whose fastest sample never moves and whose 75th
percentile steps up 45%, and asserts the trend reports the whole of that rise;
reading the fastest sample reports it as flat.

The drill-down's measurement ladder offered `p0`, `p50`, `p75`, `p99`, `p99.5`,
`p99.9` and `p100`. The `p50` column was plotting `avg`, which is the arithmetic
mean. The label inverts what it describes. A percentile is a rank, so a reader
takes `p50` for the typical case and expects a few slow samples not to move it,
when the mean is the one figure in that ladder a single slow sample can carry.
Measured directly, with a benchmark whose samples are nine at 100 microseconds
and one at 10 milliseconds, `deno bench` reports an `avg` of 1,090 microseconds
against a `p75` of 100. The column is now called `mean`, and a link saved under
the old name still opens it instead of falling back to the default column.

## Left alone

Many bench bodies in the repository time their fixture along with their
operation. Of the 366 `Deno.bench` bodies written at the top level of a bench
file, 138 build a runtime or a storage manager without bracketing, once the two
changed here are taken out. `packages/runner/test/cell.bench.ts` still has 37,
`cell-set.bench.ts` 28, `storage.bench.ts` 21, and `scheduler.bench.ts` 19.
Each one reports its fixture as though it were the operation it names.
Converting them is a larger piece of work than this investigation, and each
conversion moves the number that benchmark reports.

The sweep in the decomposition flagged three `flat list read` benchmarks and
two `cell-schema-read-depth` benchmarks as steps whose per-processor intervals
disagree. Those turned out to be a real regression on the storage read path,
recorded in
[`2026-08-schemaless-read-membership-walk.md`](2026-08-schemaless-read-membership-walk.md).
A stalled sample is one way for a step to be reported that nothing caused; it
is not the only explanation for a disagreeing interval, and it was not the
explanation there.

Those same benchmarks collect 11 to 21 samples per run, which is few enough
that a single stalled sample moves their reported mean by a median of 8 to 23%,
so their measurements carry the noise described here on top of the real step.
Nothing here re-examines their size.
