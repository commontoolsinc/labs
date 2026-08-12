# Benchmarks

How the repository's `deno bench` files run in CI, where their results are
charted, and the constraints a bench file must satisfy for that tracking to
work.

## The pipeline

The Benchmarks workflow (`.github/workflows/benchmarks.yml`) runs every four
hours on a schedule, on the dedicated runner group so results stay comparable
across runs. It runs `deno bench --json` over `packages/runner/test/*.bench.ts`
plus explicitly listed benchmarks in `packages/utils`, `packages/fuse`,
`packages/memory`, and `packages/patterns`. It uploads JSON stdout and a copy of
stderr in the `bench-results` artifact with 90-day retention. A bench file
outside those paths does not run in CI until it is added to the workflow. The
workflow's manual trigger measures a specific commit.

The team ops dashboard charts benchmark trends on its `/bench` page, sampling
one successful run per four-hour window from those artifacts. Each
benchmark is identified by its origin file, group, and name. The report's CPU
field divides that benchmark into one line per processor. The dashboard never
connects measurements from different processors. A report without a CPU
identity is unusable for trends because its measurements cannot be assigned to
a processor.

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
validation step fails the run when the artifact is not valid JSON or lists
no benches; since the dashboard samples successful runs only, corruption
never reaches the charts and shows up as a red run in the Actions tab. This
applies to module-scope code as well as bench bodies. Write diagnostics to
stderr. Module-scope diagnostics may use `console.error`. The JSON reporter
captures console output from benchmark bodies, so body diagnostics that need
to reach the workflow must write to `Deno.stderr` directly. The workflow copies
stderr to `diagnostics.log` in the uploaded artifact and also shows it in the
workflow log. A stray diagnostic once corrupted every benchmark artifact for
five weeks before anyone noticed.

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
- **A failure is a red run.** `deno bench` exits non-zero when a benchmark
  throws, and this one throws when the shell raises an uncaught exception or a
  navigation never completes. The report still lists every other benchmark, and
  the dashboard drops only the series it could not measure — but the run is red
  and that window contributes nothing to any chart. Each segment waits on the
  event it is waiting for, with no deadline of its own, so it fails when
  something is genuinely broken rather than when the runner is busy.
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
