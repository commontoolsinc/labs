---
status: historical
created: 2026-08-07
archived: 2026-08-07
reason: "Why the benchmark tile's 21% headline was mostly the host a run landed on, and what changed in the workflow and the tile to stop it."
---

# The part of the 21% benchmark headline that was not code, 7 August 2026

## Question

The team dashboard's benchmark tile read `▲21%` over 392 benchmarks and the
last 13 days. A companion investigation, recorded in
`2026-08-benchmark-headline-decomposition.md`, decomposed that figure and found
that the named step regressions do not account for it: undoing all of them,
including the one already fixed, takes 21.0% only to 13.2%. This document is
about the remainder, and the remainder turned out to be the larger part.

Two questions were put. Did the environment under the processor the headline
belongs to change? And does the tile overstate on a line that has few runs
behind it?

The answers are that the processor's environment did not change, that the
runner group nonetheless does not hand two runs the same machine, and that the
tile had no way to see the difference. Correcting for it takes the headline
from 21.0% to 4.4%, and it makes the three processors agree with each other
rather than disagree by a factor of six.

## How the figures below were produced

Every `bench-results` artifact the `Benchmarks` workflow produced on `main`
between 18 June and 7 August 2026 was downloaded: 485 successful runs, of which
481 still had a readable artifact. The four that did not are all from 19 and 20
June, before the tile's 45-day window opens.

Each artifact was parsed the way `packages/dashboard/tiles/benchmark.ts` parses
it, and the per-processor index was rebuilt from the same rule: an index starts
at one and is multiplied, run by run, by the geometric mean of the
per-benchmark ratios over the benchmarks two neighboring runs share. The window
and the headline percentage come from the same `trendPct` the dashboard calls.
The rebuild reproduces the tile exactly: the headline belongs to the
`INTEL(R) XEON(R) PLATINUM 8573C` line, whose window holds 20 runs spanning
12.7 days, and the newest run carries 392 benchmarks.

Where the text below needs to know how fast a machine was, rather than how fast
the repository was, it reads the benchmarks in `packages/utils`. Those run no
runner code: they are cache and deep-equal loops over data already in memory.
The measure used is the geometric mean of the absolute timings of the 18 such
benchmarks that every run of a given processor shares, divided by that
processor's own median. Call it the machine factor. A factor of 1.20 means the
run measured everything, including work that calls nothing, a fifth slower than
that processor usually measures it.

## What the runner group actually serves

The workflow pins the runner group, and the comment above the pin said results
stay comparable across runs because of it. They do not.

Over the 45 days the tile charts, the group served six processor models:
`AMD EPYC 7763 64-Core Processor`, `AMD EPYC 9V74 80-Core Processor`,
`INTEL(R) XEON(R) PLATINUM 8573C`, `INTEL(R) XEON(R) PLATINUM 8573B`,
`Intel(R) Xeon(R) Platinum 8370C CPU @ 2.80GHz` and `Intel(R) Xeon(R) 6973P-C`.
The tile draws one line per model, which handles that.

What it does not handle is that a model is not a machine. Here is the machine
factor's spread within each model, over the same 45 days:

| Processor | Runs | 5th percentile | 95th percentile | Spread | Runs off by more than a tenth |
| --- | ---: | ---: | ---: | ---: | ---: |
| AMD EPYC 7763 | 241 | 0.991 | 1.014 | 1.023 | 0 |
| AMD EPYC 9V74 | 135 | 0.777 | 1.015 | 1.306 | 13 |
| Intel Xeon Platinum 8573C | 39 | 0.990 | 1.195 | 1.207 | 3 |

The EPYC 7763 is steady to within a couple of percent across 241 runs. The
other two are not, and they are not noisy in a way that averages out. The EPYC
9V74's runs fall into two clusters, one at about 114 microseconds and one at
about 88, twenty-three percent apart, with 13 of its 135 runs in the faster
one and no drift between them over time. Under one processor name, the group
is serving at least two machines.

The 8573C is the mirror image: a tight baseline at about 98 microseconds with
three runs sitting a fifth above it. A run gets whatever share of a shared
host the other tenants leave it, and about one run in ten does not get all of
it.

## The 8573C's environment did not change

Its machine factor is flat across all 39 of its runs, from 1 July to 6 August.
There is no step, no drift, and no relationship to the Deno version. Whatever
made the headline move, it was not the 8573C becoming a different machine.

For completeness, one environment change does sit inside the window and is
real: `mise.toml`'s Deno pin rolled from 2.8.1 to 2.9.4 on 29 July, in commit
`fbdd14d3f`. That is a repository change rather than a runner change, it
reaches every processor, and it moved the runner benchmarks by about three
percent on the EPYC 7763 and about two and a half on the EPYC 9V74. On the
8573C it moved them by nothing measurable. It is a legitimate part of the
measured history and is not the subject of this document.

## The headline rests on two runs that landed on a slow host

The 8573C's 20-run window ends with two runs, at 20:59 and 21:47 UTC on 6
August, 48 minutes apart. One is the only manual dispatch in the whole 50-day
run list; the other is the scheduled run that followed it. They are on
different commits, so they are two honest measurements — of two different
commits, on a machine that was not itself.

Both have a machine factor of 1.196 and 1.195. Every benchmark in both runs is
up by about the same amount, including the pure arithmetic loops that touch no
repository code at all. Reading the whole distribution of per-benchmark ratios
rather than its centre says the same thing: on a typical 8573C run the ratios
against its neighbours sit with a median of 0.985 and a 75th percentile of
1.000, so the bulk of the benchmarks agree; on these two the 25th percentile is
already at 1.085 and 1.037. A commit does not make 392 unrelated benchmarks
uniformly slower. A busy host does.

Those two runs are window points 18 and 19, and the fit reads its final level
off points 17, 18 and 19.

## What the fit does with them, and why the reported figure exceeds the move

The window's index ends 13.3% above where it starts. The tile reports 21.0%.
The gap is worth stating precisely, because it is not where one might guess.

`trendPct` fits flat levels separated by change points and reports the last
level against the first. On this window it places change points after sample 3
and after sample 17, giving three levels which, expressed against the first,
are 1.0000, 1.0506 and 1.2098. The last level is the median of samples 17, 18
and 19, which is 1.1329 — the same value as the window's last sample. So the
fit does not overstate at that end at all.

The whole of the gap is at the other end. The first level is the median of
samples 0, 1 and 2, which is 0.9364, while sample 0 is 1.0000. The series drops
about seven percent between the first and second samples and stays down, and
that drop is real: the machine factor is normal at both runs, so the runner
benchmarks genuinely got faster while the pure loops did not. `MIN_SEGMENT` is
3, so the change-point search is not allowed to put a boundary one sample in,
and the first level therefore averages across a change it could not see. The
fit's inference — that a single low-lying sample is more likely to be one odd
run than a level of its own — is a reasonable policy when about one run in ten
lands off-norm. On this particular window it is wrong, and it inflates the
answer by about seven points.

So the fit is doing what it was built to do, including the deliberate and
tested behaviour of reporting a step in the newest three samples at full size.
What it was fed was contaminated. The correction belongs upstream of the fit,
in what the index is made of.

## The tile also counted one moment twice

There is a second, smaller defect, and it is the reason a single slow episode
could supply two of the three samples the final level rests on.

The workflow's comment says the dashboard samples one successful run per
four-hour window. The dashboard does not. `sampleBenchmarkRuns` buckets at
`ciHistoryBucketMs(CI_HISTORY_MIN_DAYS)`, which is one day divided by 200
points, or 7.2 minutes. That is the right resolution for the drill-down's
one-day view, which is what the bucket was chosen for, and it is far finer
resolution than a 13-day trend over twenty points wants. Two runs 48 minutes
apart entered the fit as two independent samples of the level.

## What changed

Two changes, one for each question.

**The workflow now measures the machine.** A new file,
`packages/dashboard/machine-calibration.bench.ts`, holds twelve benchmarks that
import nothing and call no repository code: integer and floating-point
arithmetic, short-lived and retained allocation, array and typed-array traffic,
string building, hash-table churn, prototype dispatch, closure allocation and a
JSON round trip. The `Benchmarks` workflow runs them alongside the product
benchmarks, in the same report and the same artifact, and its validation step
now fails a run whose report carries none of them. Their bodies are the ruler,
so they do not change; adding or removing one is safe, because each pair of
runs is compared over the calibration benchmarks they share.

The first draft of that file was written with bodies of a few tens of
microseconds each, and measuring it showed it was a worse ruler than the thing
it was measuring. Over six runs on one machine its geometric mean varied by a
factor of 1.85 while the `packages/utils` benchmarks in the same runs varied by
1.37, and the two did not move together: their ratio varied by a factor of
2.01, which is the signature of noise the calibration was making rather than
noise it was finding. The cause was measurement length. A body of a few tens of
microseconds is partly interpreted and partly compiled while it is being timed,
and which it is varies between runs by more than the machine does. Growing each
body to a few hundred microseconds and giving every one an explicit warmup
brought the calibration's own variation to 1.28 against the utils benchmarks'
1.31, and their ratio to 1.21. Every calibration benchmark now varies against
the utils geometric mean by less than the widest of the utils benchmarks does.
The whole file adds about seven seconds to a job that runs for nine minutes.

**The tile divides that measurement out, and reads one run per four hours.**
Each index step is now the geometric mean of the product benchmarks' ratios
divided by the geometric mean of the calibration benchmarks' ratios. The
calibration benchmarks take no other part: they are absent from the index, from
the benchmark count on the tile, and from the drill-down. A run from before the
calibration landed carries none, and the step into or out of it is left
uncorrected rather than guessed at. Separately, the index reads one run per
`BENCH_TREND_BUCKET_MS`, four hours, matching the workflow's cron; the
drill-down still keeps every run.

The trend fit in `packages/dashboard/trend.ts` was left alone, on the reasoning
above: its behaviour on this window is defensible, and the changes that would
have blunted it — a longer minimum segment, or a stricter change-point
threshold — would trade a spurious red for a spurious green on a tile whose job
is catching regressions.

## What the changes do to the numbers

Replaying the whole 45-day history through the tile's own helpers, with the
`packages/utils` benchmarks standing in for the calibration file that the
historical artifacts predate:

| | Intel Xeon Platinum 8573C | AMD EPYC 7763 | AMD EPYC 9V74 | Headline |
| --- | ---: | ---: | ---: | ---: |
| As the tile reported it | 21.0% | 3.2% | 5.0% | 21.0% |
| Reading one run per four hours | 8.7% | 3.2% | 5.0% | 8.7% |
| Dividing out the machine | 0.0% | 3.9% | 4.4% | 4.4% |
| Both | 0.0% | 3.9% | 4.4% | 4.4% |

The headline goes from 21.0% to 4.4%, which is below the 5% threshold that
turns the tile orange. The check that matters more than the number is the last
row's agreement: three machines measuring the same commits over the same days
now say 0.0%, 3.9% and 4.4% instead of 21.0%, 3.2% and 5.0%. A repository does
not get six times slower on one machine and not on another.

For the original question, that means the remainder the decomposition left —
13.2% on the headline processor after every named step regression was undone —
was very largely not code. It was the host two runs landed on, read by a fit
that had no way to know.

## What this does not cover

The calibration removes anything that changes the machine's raw throughput
between two runs. A toolchain roll that made pure arithmetic slower would be
divided out along with the busy hosts, and the tile would then report only what
the repository's code did relative to it. That is the right reading for a tile
that asks whether our code got slower, and the per-benchmark drill-down still
carries the absolute timings for anyone asking the other question.

The calibration also cannot help a run from before it landed. The historical
artifacts have none, so the tile's older steps stay uncorrected until 14 days
of calibrated runs have accumulated.
