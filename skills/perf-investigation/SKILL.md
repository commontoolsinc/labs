---
name: perf-investigation
description: Investigate Common Fabric slowness end to end — measure it, attribute it to a phase and then to a cause, and land the fix wherever it turns out to belong. Use when something is slow, when it gets slower as the data grows, when asked to profile, benchmark, or measure a scaling curve, or when a performance fix needs proving rather than asserting. A slow pattern is the usual entry point; the cause is as often in the runtime.
---

# Performance Investigation

Two neighbours carry the halves this does not.
`docs/development/PERFORMANCE_PROGRAM.md` is why we spend this time at all and
what we consider worth speeding up. `docs/development/debugging/profiling.md` is
the walkthrough — the steps in order, with the commands. This skill is the map
they are read against: what each instrument reaches, what it is blind to, and
what the answers here have historically turned out to be.

## A slow pattern is an instrument, not the defect

The pattern in front of you is where the investigation starts, not where it
ends. On the board work this skill is drawn from, the wins split roughly evenly
between pattern changes and runtime changes — and which one a given symptom
would turn out to be was not knowable before measuring. Several runtime fixes
closed a footgun the pattern had merely been first to step in.

So expect any of three outcomes, often more than one from a single
investigation:

- the pattern changes;
- the runtime changes — usually spun off as its own task, so a pattern PR does
  not quietly grow a runtime refactor;
- `skills/pattern-dev/SKILL.md` or `skills/pattern-critic/SKILL.md` gains a
  rule, when the pattern was written the way anyone would have written it and
  the cost was invisible at authoring time.

That third outcome is the highest-value one and the easiest to skip, because by
then you understand the problem and it no longer looks like a trap. If an
investigation ends with only a pattern fix, ask what made the cost invisible —
the answer is usually a rule worth writing down, and sometimes a runtime change
that makes the cheap spelling the natural one.

## Instruments, cheapest first

Each rung sees something the rung below cannot. Climb only as far as the
question needs, and stop as soon as an instrument answers it.

**Pattern test.** `deno task cf test <file> --verbose --stats-threshold 0`
prints the logger's timing and count rows per step with no browser, no shell,
and no rendering. `--stats-include` rescues named categories from the top-ten
truncation rather than from the threshold — a step faster than the threshold
still prints nothing at all, so keep `--stats-threshold 0` when every step has
to report — `--stats-action-limit` controls how many per-step scheduler action
deltas print, and `--storage-stats` adds the storage rows. This is the fastest
way to see a read count explode, and it needs no conversion work.

**Browser integration test.** What the pattern test cannot see: rendering, the
main-thread/worker split, IPC, cold load, and anything about how cost scales
with what is on screen. Promote the test using
`skills/pattern-test-to-integration/SKILL.md`, which owns that conversion and
the scale knob the measurement below depends on. Then instrument it from
`packages/patterns/integration/cfc-browser-helpers.ts`: `StepTimer` and
`logStepTimings` for phase wall-clock, and `collectBrowserLoadSummary` for the
worker's scheduler/runner/storage rows plus main-thread IPC.

**Benchmarks.** For anything that must stay fast, a bench file is how it is
defended; `docs/development/BENCHMARKS.md` owns that lane, including
`packages/patterns/integration/topic-board-scale.bench.ts`, which measures a
board's cold load across sizes and documents why its larger sizes are declared
but skipped. Read it before adding a bench rather than inventing a shape.

**The transformer's emitted schema.** A derivation's cost often starts with how
much it declared it would read. `deno task cf check <file> --show-transformed`
shows what the pattern actually compiles to, and the emitted schema's size is a
usable proxy for read width — a board derivation that reads the whole space and
one that reads a length differ by orders of magnitude in emitted characters.
This catches a class the timers only see downstream of.

## The logger names it; the profiler weighs it

Use both, because neither is sufficient and the failure is asymmetric.

The logger's spans attribute only a fraction of the time inside the span they
sit in — on the board work, the scheduler's own spans accounted for roughly a
tenth of `scheduler/run/action`. Elapsed wall-clock on a loaded machine varies
by more than the differences under test. So logger rows tell you **which key,
and how many times**; they do not reliably tell you where the time went.

A V8 sampling profile of the runtime worker does. `CdpWorkerProfiler` and
`renderProfileReport` (`packages/integration/cdp-profiler.ts`, exported from
`@commonfabric/integration`) attach to the worker and produce both a
`.cpuprofile` that Chrome DevTools and speedscope load, and a ranked self-time
report. Two things about using it here: the profiler picks the worker out of the
page's targets by its script URL, and its default sampling period is tuned for a
single interaction — over a window of minutes, a coarser period keeps the
profile inside the CDP message limit while still resolving a millisecond-scale
action. Treat profiling as instrumentation: a capture that fails should report
and let the phase run unprofiled, never fail the scenario.

Share the parts of that wiring nobody varies; copy the rest.
`attachWorkerProfiler`, `startWorkerProfile` and `writeWorkerProfile` (same
module) are the invariant half — finding the worker, degrading to unprofiled
rather than failing, and writing both artifacts — and no measurement has a
reason to spell any of them differently. Everything that encodes the question
stays in the scenario, written out: which iterations or phases to capture, the
sampling interval, the output prefix and label that carry the board size or the
phase, and the environment knob that turns capture on.

`packages/patterns/integration/default-app.test.ts` is the maintained example to
lift from, and that is the reason for the split rather than a full helper: the
half a measurer edits every time has to stay visible where they are already
reading. A perf harness is otherwise throwaway — built for one investigation,
driven by knobs nobody else needs, and not committed — so duplicating the parts
that differ costs less than a seam every future scenario has to be bent through.

## Narrowing, until a phase becomes a source

A phase is a place to look, never an answer. "The seed phase costs four minutes"
is where an investigation starts being useful, and stopping there produces a fix
aimed at a symptom. Keep going until you can name the thing doing the work — a
function, a read, a derivation that re-runs — and can say whether it is
expensive or merely frequent.

The instruments hand off to each other at each step down, and the handoff is the
part worth knowing:

- **Logger phases say which phase.** Hierarchical keys are what make this a
  descent rather than a single reading: a phase that costs four minutes splits
  into named subphases, and one of those is usually most of it.
- **`performance.mark` and `performance.measure` say where that phase sits in
  the profile.** A CPU profile is samples over a window; it has no idea what a
  phase is. Bracketing a phase with marks gives you its exact interval, so the
  profile can be read for that window instead of averaged over the whole run —
  which is the difference between "resolveLink is 30% of the run" and
  "resolveLink is 90% of the phase that regressed". `console.timeStamp` at the
  same boundaries puts the marker on a DevTools timeline, where the zoom is a
  drag rather than an arithmetic exercise.
- **Subphases say where a call explosion begins.** A count that is too high is
  visible at the top, but the caller that multiplies it is not. Splitting the
  phase until the count changes shape between two adjacent levels locates the
  multiplication — the level where a count goes from proportional to the work to
  proportional to the work squared is the one that introduced it.

`withPhase` in `packages/cli/lib/test-runner.ts` is the worked example of the
whole shape: hierarchical keys, a logger timer around the body, a mark at each
boundary, a measure across the pair, and a `console.timeStamp` at each. Copy it
into whatever you are narrowing.

A logger constructed with `enabled: false` is quiet, not inert, and the
difference decides where an investigation starts. `timeStart`, `timeEnd` and
`time` record into per-key statistics without consulting that flag, and the
counts behind the logging methods increment before it is checked — only the log
lines are suppressed. So the timings for anything already wrapped are
accumulating right now, and the first move is reading them rather than turning
anything on.

**You are done narrowing when you can write a benchmark.** That is the honest
test, and it is worth holding to: a source you understand can be provoked
directly, and one you cannot provoke is still a hypothesis. Build the benchmark
before the fix, confirm it moves with the real measurement rather than merely
being fast, and keep it — a benchmark that correlates with the thing users feel
is what defends the fix afterwards, and it often lands as part of it. Where a
source genuinely cannot be isolated that way, say so rather than skipping the
step quietly.

## Count against average

Every logger row carries `count`, `average`, `p95`, `max`, and `total`, and the
first two are the whole diagnosis: a row whose `total` grew because `count` grew
is a different bug from one whose `average` grew, and they have disjoint fixes.
Read them before forming a theory. Rows are ranked by `total` and truncated, so
a row that measures set sizes rather than milliseconds will sort above real
timings and evict them — read those by name instead of widening the summary.

## Two ways to be slow, at every level

A call costs what it costs and happens as often as it happens, so every finding
has two fixes available: make the work cheaper, or ask for it less. They are not
alternatives to choose between up front — which one is available is a fact about
the code you have not read yet, and investigations that assume one skip the
larger win about half the time.

Both live at every level of the stack, and neither level is the natural home of
this work. A leaf at the edge — resolving a link, walking a schema, hashing a
value — can often be made cheaper for every caller at once, which is the widest
possible fix and the one that closes a footgun rather than an instance. The
caller can often stop asking: hoist the read, declare a narrower one, split a
derivation so the half that cannot have changed does not re-run. A pattern
usually surfaces the second; the first is usually a runtime change, and is the
reason this work does not end at the pattern.

Look for both before choosing. The cheapest real fix is frequently the one at
the other end of the stack from where the symptom appeared.

## Where cost comes from in this runtime

Seed list, not a boundary — these are the causes this codebase has actually
produced, and the point is the shape of each, so you recognize a sixth.
`packages/patterns/topics/main.tsx` carries several of them as comments on the
code that resolves them.

- **The read is too wide.** The transformer shrinks a derivation's input schema
  to the paths it can see the body reach, and gives up when it cannot see — a
  helper call or a dynamic index makes it declare everything, so one derived
  value reads the whole space. The fix is making the read declarable: a
  module-scope `lift` whose parameter type is the bound, iteration that the
  analysis can follow.
- **The read is too often.** A read placed inside a scan materializes its value
  once per iteration. Hoisting it out changes nothing semantically and removes a
  factor of N.
- **Each access costs more than it looks.** Reading an element through a
  reactive array resolves a link every time, so a quadratic scan over one pays a
  link resolution per element per pass. Taking a plain array first is the same
  scan at a fraction of the cost.
- **The invalidation shape is wrong.** A derivation declared over a whole list
  re-runs for every element on any change to any of them. Splitting it so each
  half depends only on what can actually change it — and sampling, where a read
  should register no dependency at all — turns N re-runs per write into one.
- **The work is fine but keeps being thrown away.** Mapped sub-patterns track
  their elements by normalized link address, which is stable across position
  changes for a cell and includes the positional index for an inline value — so
  an inline element makes identity equal position, and any reorder or prepend
  re-addresses every downstream cell and rebuilds its subtree.
  `packages/runner/src/builtins/map.ts` states the rule at its source. The
  symptom is churn rather than slowness in any one place, and no timer shows it
  — the work is fast every time, there is just N times more of it than there
  should be. What shows it is snapshotting the rendered tree across successive
  appends and counting how many addresses survive: a carried element should keep
  all of them and mint none. Nothing shared captures that today, so expect to
  build it: it has to walk the persisted VDOM as cells, so every node carries
  the entity id and path it lives at, and run on each append so consecutive
  snapshots diff as the same tree plus one element, modulo ids.

## Off screen and on screen

Measure the same operation twice — once with nothing rendering the result, once
with it on screen. The pair is what makes the numbers mean something:

- the **difference between them** is the rendering cost;
- the **difference between an early operation and a late one** is how the cost
  scales;
- an operation measured only on screen conflates the two, and one measured only
  off screen can look flat while the product feels unusable.

Time individual operations against a board that already exists, rather than
inferring per-operation cost by dividing the time to build one — building is a
different curve, and the number you want for a regression is what one more costs
at a given size.

## Measuring honestly

The gap between a real change and machine noise is narrower than it looks, and
this repo has been burned by it.

- **A mean hides a stall.** One stalled sample inside a run is enough to invent
  a regression the dashboard then reports. Compare trimmed against untrimmed,
  and check whether an elevated reading arrives with a `max` an order of
  magnitude above its typical sample and a reduced sample count. The worked case
  is
  `docs/history/development/performance/2026-08-benchmark-headline-machine-noise.md`.
- **Alternate, don't batch.** Interleave the two sides and take a min-of-five
  rather than running all of one then all of the other; background load drifts
  over minutes. Where the harness allows it, normalize against an untouched
  control measured in the same run.
- **Never sleep to stabilize a measurement.** A sleep sets a floor on the number
  you are trying to reduce and makes it depend on scheduling luck.
  `docs/development/waiting-in-tests.md` is binding here, and the waits in
  `packages/patterns/integration/cfc-browser-helpers.ts` are the event-driven
  primitives to reach for.
- **State the board size, the machine, and which side is which** in any number
  you report. A ratio without a size is not reproducible.

## Landing it

A performance change needs its evidence attached: the measurement, the size it
was taken at, and what moved. Point at the mechanism rather than the number
alone — a number without a cause is indistinguishable from noise that happened
to persist.

Where the investigation produced a finding worth keeping but no longer describes
the current system — a decomposition, a ruled-out hypothesis, a noise analysis —
it is a point-in-time record: `docs/history/development/performance/` is its
home, under the rules in `docs/README.md`.
