# Profiling a Slowness

Use this when something takes longer than it should, or grows worse as the data
grows, and you need to know why rather than guess. The goal is to turn "this is
slow" into "this function, called this many times, from here" — and then into a
benchmark that moves when the real thing moves.

[`skills/perf-investigation/SKILL.md`](../../../skills/perf-investigation/SKILL.md)
is the map: which instrument reaches what, what each is blind to, the causes
this runtime has actually produced, and how to keep a measurement honest. This
document is the walkthrough — the order the steps go in, and the commands.

The steps below descend. Each one narrows the window the next one looks at, and
stopping early produces a fix aimed at a symptom.

## 0. Read what is already being measured

Timing is always on. `logger.timeStart()`, `logger.timeEnd()` and
`logger.time()` record into per-key statistics whether or not the logger they
belong to is enabled — `enabled: false` silences log lines, not measurement, and
the counts behind `logger.debug()` and friends increment before that check too.
A logger constructed disabled is quiet, not inert.

So the first move is reading, not instrumenting. The phase timings and call
counts for anything already wrapped exist before you touch the code.

## 1. Find the phase

```bash
deno task cf test packages/patterns/<pattern>/<name>.test.tsx --verbose --stats-threshold 0
```

No browser, no shell, no rendering — the cheapest rung that can see a read count
explode. Each row carries `count`, `average`, `p95`, `max` and `total`.

Read `count` against `average` before forming any theory. A row whose `total`
grew because it ran more often is a different defect from one whose every call
got slower, and the two have disjoint fixes.

Two traps in the output itself:

- `--stats-threshold` gates whether a step reports at all. A step faster than
  the threshold prints nothing; `0` means every step.
- `--stats-include <prefixes>` rescues named categories from the **top-ten
  truncation**, not from the threshold. It cannot make a fast step report.
- Rows are ranked by `total`, so a row that records set sizes rather than
  milliseconds sorts above every real timing and evicts it. Read those by name.

`--storage-stats` adds the storage rows; `--stats-action-limit` controls how
many per-step scheduler action deltas print.

## 2. Bracket the phase so a profile can be read for it

A CPU profile is samples over a window. It has no idea what a phase is, so
attributing one means knowing its exact interval.

Wrap the phase the way
[`packages/cli/lib/test-runner.ts`](../../../packages/cli/lib/test-runner.ts)
does in its `withPhase` helper, which is the shape to copy:

- hierarchical keys, so subphases nest under their parent;
- `logger.timeStart()` / `logger.timeEnd()` around the body;
- `performance.mark()` at both boundaries and `performance.measure()` across the
  pair, which gives the interval;
- `console.timeStamp()` at each boundary, which puts the marker on a DevTools
  timeline so zooming to the phase is a drag rather than arithmetic.

This is cheap to add and it is what makes the next descent possible. Add it to
the phase you are narrowing, not to everything.

## 3. Attribute the phase to functions

Step wall-clock says how long; it does not say where the time went, and the
scheduler's own spans account for only a fraction of the span they sit inside. A
V8 sampling profile of the runtime worker attributes all of it, by function.

Capture one around exactly the phase from step 2, using the seams in
[`packages/integration/cdp-profiler.ts`](../../../packages/integration/cdp-profiler.ts):

- `attachWorkerProfiler(wsEndpoint)` — connects and waits for the runtime
  worker, returning `undefined` rather than throwing;
- `startWorkerProfile(profiler, context, { samplingIntervalUs })` — the
  default period suits a single interaction; a window of minutes needs a
  coarser one to stay inside the CDP message limit;
- `writeWorkerProfile(profiler, { pathPrefix, label })` — writes the
  `.cpuprofile` and the ranked self-time report.

[`packages/patterns/integration/default-app.test.ts`](../../../packages/patterns/integration/default-app.test.ts)
is the maintained example to lift the gating and naming from. Read the ranked
report first; open the `.cpuprofile` in Chrome DevTools or speedscope when the
ranking is not enough.

## 4. Split until an explosion has an origin

A count that is too high is visible at the top level. The caller that multiplies
it is not.

Keep splitting the phase into subphases and comparing counts between adjacent
levels. The level where a count stops being proportional to the work and starts
being proportional to the work squared is the level that introduced the
multiplication — that is the caller to fix, and it is frequently not the
function the profile ranked first.

## 5. Isolate, then pin it with a benchmark

You are done narrowing when you can write a benchmark. That is the honest test:
a source you understand can be provoked directly, and one you cannot provoke is
still a hypothesis.

Write it before the fix, and confirm it **correlates** — that it moves with the
real measurement rather than merely being fast. A benchmark that does not track
the thing users feel defends nothing. [`BENCHMARKS.md`](../BENCHMARKS.md) owns
that lane: where bench files live, which ones CI runs, and how the trend reads
them.

Keep it. A benchmark that pins a fix usually lands as part of it.

## 6. Decide where the fix belongs

Every finding has two fixes available — make the work cheaper, or ask for it
less — and both exist at every level of the stack. A leaf at the edge can often
be made cheaper for every caller at once; a caller can often stop asking. A
pattern investigation usually surfaces the second, while the first is usually a
runtime change.

Look for both before choosing. The perf skill carries the causes this runtime
has actually produced, and the reasons an investigation that ends at the pattern
has often stopped early.

## The server side

Not covered here yet. A toolshed is a Deno process, so `--inspect` and the
DevTools profiler reach it, and OTEL spans exist behind `OTEL_ENABLED` with a
collector to receive them. Whoever profiles the server first should write the
concrete steps into this document, the way the steps above are written.
