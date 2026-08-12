# Benchmarks

How the repository's `deno bench` files run in CI, where their results are
charted, and the constraints a bench file must satisfy for that tracking to
work.

## The pipeline

The Benchmarks workflow (`.github/workflows/benchmarks.yml`) runs every four
hours on a schedule, on the dedicated runner group. It runs `deno bench --json`
over `packages/runner/test/*.bench.ts` plus explicitly listed benchmarks in
`packages/utils`, `packages/fuse`, `packages/memory`, `packages/dashboard`, and
`packages/patterns`. It uploads JSON stdout and a copy of stderr in the
`bench-results` artifact with 90-day retention. A bench file outside those paths
does not run in CI until it is added to the workflow. The workflow's manual
trigger measures a specific commit.

The team ops dashboard charts benchmark trends on its `/bench` page, and its
trend reads one completed run per four-hour window from those artifacts. Each
benchmark is identified by its origin file, group, and name. The report's CPU
field divides that benchmark into one line per processor. The dashboard never
connects measurements from different processors. A report without a CPU
identity is unusable for trends because its measurements cannot be assigned to
a processor.

The runner group does not make two runs comparable, and the processor field
only goes part of the way. Over a forty-five day stretch the group served six
processor models, and within one model two runs have measured a fifth apart on
work that touches no repository code, because a run gets whatever share of a
shared host the other tenants leave it. So every run also measures the machine,
through the benchmarks in `packages/dashboard/machine-calibration.bench.ts`,
which call no repository code. The dashboard divides their geometric mean out of
each step of its index, and leaves them out of the index, the benchmark count
and the drill-down. See
[the investigation](../history/development/performance/2026-08-benchmark-headline-machine-noise.md)
for what an uncorrected run did to the tile.

That correction reaches as far as the machine and no further. A host that is
busy for the whole job is measured and divided out. Anything that slows one
phase of the job and not another is not, because the calibration is one
measurement taken at one point. The browser benchmarks below are the case to
hold in mind: they run against a toolshed this same job started, and contention
between the browser and that server sits inside their numbers with nothing to
subtract it against.

Which point of the job the calibration is taken at is `deno bench`'s to choose,
not the workflow's. It does not run files in the order they are listed: listing
the same files in reverse produces the identical report, and the two browser
files run first rather than last where the list puts them. The order it picks
is stable — repeated runs of one file set agree — and stability is what the
calibration actually needs, because a ruler read at the same point of every job
compares across jobs. Adding a bench file to the list does not place it, so
neither the calibration's position nor any other file's can be arranged from
here.

Benchmark numbers are not gated, and neither is CI wall time. The only per-PR
gate is the coverage-debt ratchet (`tasks/coverage-check.ts`), which never
ingests benchmark results, so a bench regression shows up as trend drift on the
dashboard rather than as a failing check.

Most packages with benches define a `bench` task for running them locally
(see `packages/runner/deno.jsonc`); otherwise invoke `deno bench` on a
single file.

## Constraints on bench files

**Stdout must stay pure JSON.** The workflow redirects all of stdout to
`results.json`. One stray line printed by any bench file corrupts the
artifact for every benchmark in the run, not just the offending file. A
validation step fails the run when the artifact is not valid JSON, lists no
benches, or carries no machine calibration, so each of those shows up as a red
run in the Actions tab. What keeps corruption off the charts is the dashboard
applying the same test to the artifact it downloads, rather than the run's
colour: a red run's measurements are charted like any other run's. This
applies to module-scope code as well as bench bodies. Write diagnostics to
stderr. Module-scope diagnostics may use `console.error`. The JSON reporter
captures console output from benchmark bodies, so body diagnostics that need
to reach the workflow must write to `Deno.stderr` directly. The workflow copies
stderr to `diagnostics.log` in the uploaded artifact and also shows it in the
workflow log. A stray diagnostic once corrupted every benchmark artifact for
five weeks before anyone noticed.

The `cf-bench/no-lost-diagnostics` lint rule (`tasks/lint-bench-console.ts`,
registered in the root `deno.jsonc`) holds both halves of that in place, so a
plain `deno lint` catches either mistake. In a `*.bench.ts` file, outside a
benchmark body, the four `console` methods that write to stderr — `error`,
`warn`, `trace`, `assert` — are the whole of what it allows, and every other one
is rejected. Naming the permitted four rather than enumerating the ones that
write to stdout is what makes that safe: a method nobody thought of, `dirxml`
say, is rejected rather than let through. Inside a benchmark body it rejects any
`console` call at all, written there or in a helper of the same file that a body
calls, however many hops away. A helper in another module is past what one
file's syntax tree shows, so write those with `Deno.stderr` too. The runner's
benchmarks do that through `benchDiagnostic()` in
`packages/runner/test/bench-diagnostics.ts`.

**Read a transaction's journal before it commits.** A benchmark that reports
what it wrote reads `tx.journal.novelty(space)`, and a transaction holds that
journal only while it is open: `commit()` releases it on the way to settling,
and the same call afterwards reports nothing. A benchmark that times the commit
cannot afford the read inside its timed window either.
`packages/runner/test/cell-set-flat-index-list.bench.ts` shows the arrangement.
Each of its write scenarios takes a callback and hands it the transaction just
before committing; the benchmark itself passes no callback, and instead runs the
same scenario once more, untimed, to fill in a report it writes once.
`packages/runner/test/bench-write-accounting.ts` turns those attestations into a
document count and a byte count — one attestation per written path is not one
document and not one value, so adding them up directly counts some bytes twice
and misses others.

**Names identify chart series.** The dashboard tracks each benchmark by its
origin file, group, and verbatim name. Renaming a bench or its group breaks
the series: history stays under the old name and the renamed bench starts
over. So:

- Keep names stable. Never interpolate values that change as unrelated commits
  land: content hashes, byte counts, module counts, dates. If a name must
  identify a module, derive a label from its source filename, not from its
  content. Log volatile sizes to stderr instead.
- Keep names short. The dashboard has little horizontal room for series
  labels, and the origin file and group already carry context, so the name
  should not repeat them.
- Keep names unique within a group. `Deno.bench` accepts duplicate names in the
  same group without an error and reports them as a single benchmark whose
  results array holds one entry per duplicate. A consumer reading one result
  per group and name silently drops the rest.

`packages/runner/test/esm-verifier.bench.ts` shows the pattern: short stable
names, per-module labels derived from source paths, sizes logged to stderr.

**The calibration bodies stay as they are.** The bodies in
`packages/dashboard/machine-calibration.bench.ts` are the ruler every other
benchmark is measured against, so editing one moves its timings and the
dashboard reads that move as the machine changing under a processor that did
not change. Adding a benchmark to that file is safe, and so is removing one:
each pair of runs is compared over the calibration benchmarks they share, so
one present on only one side takes no part. Rewriting one is not. Two things
keep those bodies honest, and both are easy to undo by accident. Each runs long
enough — a few hundred microseconds — that the just-in-time compiler has
settled before the measurement, because a body of a few tens of microseconds is
measured partly interpreted and partly compiled, and which it is varies between
runs by more than the machine does. And each takes an explicit warmup, so that
settling happens before the timings start.

## The end-to-end navigation benchmark

`packages/patterns/integration/topic-board-navigation.bench.ts` measures what a
person waits for rather than what a component costs: a browser loading a topic
board carrying dozens of topics, signing in, the cards appearing, opening a
topic, and following a crossref to a sibling. Its `topic board` group charts
each of those as its own series plus a `journey` series for the whole sequence,
so a regression lands on the segment that caused it.

Each segment reaches its starting point with the timer stopped — `Deno.bench`'s
`b.start()` and `b.end()` bracket only the segment itself — so every iteration
measures one segment of a fresh navigation, and no benchmark depends on another
or on the order Deno runs them in.

Three things follow from it being an end-to-end measurement:

- **It needs more than Deno.** The workflow builds the toolshed binary, starts
  it, and relaxes the AppArmor restriction Astral needs, all before the
  benchmark step. Locally, start the dev servers and pass `API_URL` and
  `FRONTEND_URL`.
- **A failure is a red run, but not a lost window.** `deno bench` exits
  non-zero when a benchmark throws, and this one throws when the shell raises an
  uncaught exception or a navigation never completes. The report still lists
  every other benchmark, the workflow still uploads it, and the dashboard reads
  it: the run is red in the Actions tab and drops only the series it could not
  measure. Each segment waits on the event it is waiting for, with no deadline
  of its own, so it fails when something is genuinely broken rather than when
  the runner is busy.
- **The `sign in` segment reads coarser than the others.** It calls the shared
  `login` helper from `@commonfabric/integration/shell-utils`, which polls the
  page on a 50ms interval, and a wall-clock measurement taken around a poll is
  quantized to its interval. Against a segment that runs in a couple of hundred
  milliseconds that is visible resolution, not rounding. The other segments
  wait on notifications and are unaffected.
- **The board's size is part of the measurement.** Changing it starts every
  series in the group over at a new scale, exactly as renaming a benchmark
  would. `CF_TOPIC_BOARD_TOPICS` overrides it for a local run that asks how a
  segment scales; CI leaves it unset, and the size in force is written to
  stderr and so into `diagnostics.log`.

`packages/patterns/integration/topic-board-seed.ts` builds a board on its own,
which is how to get one for a profiling session without running the benchmark.

## The board scaling benchmark

One board of one size catches a regression but says nothing about shape: a
change that is flat at thirty topics and quadratic at three hundred looks the
same on the navigation benchmark's `board` series.
`packages/patterns/integration/topic-board-scale.bench.ts` measures that same
thing — a signed-in cold load, timed until every card has rendered — across
board sizes of 100, 1000, and 10000, in a `topic board scale` group whose
series are named for the sizes. The boards carry no crossrefs, so the numbers
describe the cost of the list rather than of the join over it.

Only the 100-topic board runs today. The other two are declared and skipped,
because a board of that size cannot be built:

- Seeding cost grows as roughly the square of the topic count, because the
  board recomputes its whole crossref join and index on every write and every
  topic holds the board's own list. Thirty topics take half a minute; a hundred
  take about seven and a half minutes and six and a half gigabytes. A thousand
  extrapolates to the better part of a day and to more memory than a runner
  has.
- Crossrefs are not the cause, and neither is the benchmark. Creating the same
  topic pieces standalone is linear and flat in memory — a hundred in
  twenty-five seconds, holding at about a gigabyte — but attaching them to a
  board in a single write is refused by the board's element schema, so there is
  no route that avoids the per-write cost.

Declaring the skipped sizes rather than leaving them out keeps the curve they
belong to written down, and turning them on is one edit:
`CF_TOPIC_BOARD_SCALE_LIMIT` raises the ceiling. A skipped benchmark is absent
from the report entirely, so the dashboard simply has no series for it and the
run stays green.

Because that ceiling is the board's cost and not a property of the benchmark,
the two skipped sizes should be enabled as part of whatever lowers it.
