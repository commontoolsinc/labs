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

What is *not* on by default is emission. `CF_TIMING_MEASURES=1` makes every
recorded span also emit a `performance.measure`, which is what puts it on the
timeline of the process that ran it and what step 4 aggregates. It is off
because the volume is meant for a tool rather than for a person: a topics
pattern test emits more than 800,000 spans, and a human opening a timeline wants
the phases someone deliberately named, not every span the runtime recorded. Turn
it on for the length of an investigation and read it with something that
aggregates.

`CF_TIMING_MEASURES_CAP` raises the ceiling. It matters more than it looks:
emission stops at the cap rather than sampling, so a run that hits it leaves an
early-run prefix, and attributing a whole run from its setup is the mistake that
invites.

## 1. Find the phase

```bash
deno task cf test packages/patterns/<pattern>/<name>.test.tsx --verbose --stats-threshold 0
```

No browser, no shell, no rendering — the cheapest rung that can see a read count
explode.

Each row prints `n`, `total`, `avg` and `p95`. Read the count against the
average before forming any theory: a row whose `total` grew because it ran more
often is a different defect from one whose every call got slower, and the two
have disjoint fixes. (`max` and `p50` exist in the statistics but this command
does not render them; the browser summary in step 3 does.)

Two traps in the output itself:

- `--stats-threshold` gates whether a step reports at all. A step faster than
  the threshold prints nothing; `0` means every step.
- `--stats-include <prefixes>` rescues named categories from the **top-ten
  truncation**, not from the threshold. It cannot make a fast step report.
- Rows are ranked by `total`, so a row that records set sizes rather than
  milliseconds sorts above every real timing and evicts it. Read those by name.

`--storage-stats` adds the storage rows; `--stats-action-limit` controls how
many per-step scheduler action deltas print.

The counts this rung prints are exact. Its milliseconds are not the product's:
[`test-runner.ts`](../../../packages/cli/lib/test-runner.ts) calls
`runtime.enableIdempotencyCheck()` unconditionally, so every computation runs a
second time and subscription registers differently. On a fifty-create topics run
that was 16% of the wall clock and 58% of the action time, and it changed no
count. Gate the call off before quoting a duration from here.

## 2. Bracket the phase — in the process you are going to profile

A CPU profile is samples over a window. It has no idea what a phase is, so
attributing one means knowing its exact interval.

**Which process emits the marks decides whether they are any use.** `cf test`
runs patterns in a Deno process with no browser in it; a worker CPU profile
comes out of a browser worker over CDP. Marks emitted on one side of that
boundary never appear in a profile taken on the other, so pick the bracket that
matches the capture:

- **Profiling the `cf test` process.** Wrap the phase the way
  [`packages/cli/lib/test-runner.ts`](../../../packages/cli/lib/test-runner.ts)
  does in its `withPhase` helper: multi-segment keys, `logger.timeStart()` /
  `logger.timeEnd()` around the body, `performance.mark()` at both boundaries
  with a `performance.measure()` across the pair, and a `console.timeStamp()` at
  each. The key segments are joined into one path and recorded against that path
  alone — they read as a hierarchy and sort together, but nothing rolls up, so a
  parent's total is its own span rather than the sum of its children's. Run the
  process under `--inspect` and the marks and timestamps land on the DevTools
  timeline beside the samples, so zooming to the phase is a drag rather than
  arithmetic.

  Deno has no `--cpu-prof`: V8 rejects the flag, which is Node's rather than
  V8's. To get a `.cpuprofile` out of the `cf test` process, drive V8's profiler
  from inside it with `node:inspector`, which Deno implements — connect a
  `Session`, `Profiler.enable`, `Profiler.start` around the phase, and
  `Profiler.stop` to a file. It needs `--allow-sys`, which the `cf` launcher
  does not pass, so run `packages/cli/mod.ts` directly with the launcher's own
  flag set plus that one. Rank it with the same self-time arithmetic
  `renderProfileReport` uses in
  [`cdp-profiler.ts`](../../../packages/integration/cdp-profiler.ts).
- **Profiling the browser worker.** The interval has to come from
  the capture itself: start the profiler when the phase starts and stop it when
  the phase ends, so the profile *is* the phase. That is what the phase-scoped
  capture in step 3 is for. Marks emitted inside the worker also work; marks
  emitted by the test driving it do not.

Either way, add the bracket to the phase you are narrowing rather than to
everything.

## 3. Attribute the phase to functions

Step wall-clock says how long; it does not say where the time went, and the
scheduler's own spans account for only a fraction of the span they sit inside. A
V8 sampling profile of the runtime worker attributes all of it, by function.

Start the capture when the phase starts and stop it when the phase ends. The
profile is then the phase, and its ranking answers a question about that phase
rather than about the whole run — which is the whole reason to bother scoping
it. The seams are in
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

For the logger's own view of the same run, `collectBrowserLoadSummary` in
[`packages/patterns/integration/cfc-browser-helpers.ts`](../../../packages/patterns/integration/cfc-browser-helpers.ts)
reads the worker's scheduler, runner and storage rows plus main-thread IPC, with
`count`, `p50`, `p95` and `max` per row. It keeps the top rows by total, so a
row recording set sizes rather than milliseconds will evict real timings — read
those by name instead of widening the summary.

The storage rows follow one inbound frame in arrival order, each keyed by the
module that pays for the step: `storage.v2.remote/receive/decodeFrame`
(websocket decompression), `memory.v2.client/receive/decodeBoundary` then
`/schemaExpansion` (protocol decoding, and schema expansion only for a frame
carrying a reference), and `storage.v2.remote/receive/dispatchPayload` — the
whole synchronous handling of the frame, which for a pushed effect includes
updating the watch view but not the replica. Replica application is its own
pair, and every frame the replica ingests lands in one of them:
`storage.v2/watchRefresh/applySessionSync` for the frames a refresh brought
back, `storage.v2/watchPush/applySessionSync` for the frames the server pushed.
Around a refresh, `storage.v2/watchRefresh/watchAddSync` is the request as the
replica saw it, queue wait included, while `memory.v2.client/watchAdd/request`
is the round trip alone, so their difference is time spent behind earlier watch
mutations; `watchRefresh/total` brackets both with application. The
`runner/start/*Wave` rows bracket each resume pre-sync wave around the per-cell
`runner/start/resume*` spans.

## 4. Split until an explosion has an origin

A count that is too high is visible at the top level. The caller that multiplies
it is not.

Two ways to get there. By hand, keep splitting the phase into subphases and
compare counts between adjacent levels — the counts themselves, not shares of a
total, since each key is timed independently and a child's contribution cannot
be inferred by subtracting it from its parent.

Or let the measures do it. With emission on (step 0):

```bash
deno task cf test <file> --timing-measures-out /tmp/measures.json
deno run --allow-read skills/perf-investigation/scripts/aggregate-measures.ts /tmp/measures.json
```

`aggregate-measures.ts` rolls every span up by key prefix and prints calls,
total, time per call, and the spans recorded at exactly that level. That roll-up
is what the stored statistics cannot give you — a logger records against its
full joined path and nothing shorter, so no row holds a total for a prefix.

Read it for where time concentrates, not for a call explosion. It groups keys by
how they are NAMED, so `calls` counts every span at a prefix or below it and can
only fall as you descend; a count that rises is not something this view can
show. `ms/call` says which level is expensive, and the two `self` columns
separate a level that is itself slow from one that merely contains slow
children.

Only spans a logger recorded reach the file. `withPhase` also emits a measure
of its own, under a `cf-test/` name and without the logger's prefix, and the
capture leaves it on the timeline rather than writing it — so a phase appears
once, under its logger keys, and the counts do not double.

That answers where the time went. It does not answer who asked, and for a key
that runs everywhere it cannot: a logger records against its own key no matter
which caller reached it. `attribute-measures.ts` recovers the caller from the
intervals — spans nest, so whichever span was open when another began is the one
that called it:

```bash
deno run --allow-read skills/perf-investigation/scripts/attribute-measures.ts \
  /tmp/measures.json --key=tx/read              # who calls it
deno run --allow-read skills/perf-investigation/scripts/attribute-measures.ts \
  /tmp/measures.json --key=tx/read --via=traverse   # and how many each does
deno run --allow-read skills/perf-investigation/scripts/attribute-measures.ts \
  /tmp/measures.json --key=tx/read --chains     # the full chains
```

### Keep asking until the shape stops changing

Each answer here suggests the next question, and the investigation is not
finished when one of them returns a number — it is finished when the shape stops
changing. Drive it yourself rather than stopping at the first table:

1. **What dominates?** Aggregate. If one key is most of the spans, it is the
   subject.
2. **Who calls it?** Attribute. A key that runs everywhere names no caller in
   its own row.
3. **Frequency or width?** Read `--via` for the ratio, not the totals. Many
   callers doing a little each is a frequency problem, fixed by calling less.
   Few doing a great deal each is a width problem, fixed by making one call ask
   for less — and those live at opposite ends of the stack.
4. **Is the unit cost flat?** Compare time per child across the buckets. Flat
   means volume and nothing else; rising with size means a second defect inside
   the heavy calls, and it is worth separating before either is fixed.
5. **Who calls the heavy ones?** `--heavy=N`. This is the question most easily
   skipped, and its answer is routinely different from step 2's — a call site
   can be dominated by a handful of instances whose callers are nothing like the
   typical one.
6. **Repeat on whatever step 5 named**, until either a pattern repeats across
   the heavy instances or the chain reaches uninstrumented ground.

Reaching uninstrumented ground is a result, not a dead end. A large root share
says those spans ran outside every wrapped region, and the next move is to wrap
one level above the thing you were chasing and run again — which is step 2 of
this list with a better vantage point. Say so explicitly rather than reporting
the attributable fraction as though it were the whole.

The same capture usually says where to put that span:

```bash
deno run --allow-read skills/perf-investigation/scripts/attribute-measures.ts \
  /tmp/measures.json --key=traverse --roots --ignore=tx/read
```

Two views, from data already in hand. The first drops the transparency that
attribution applies to the harness phases — for a span nothing else encloses,
they are the only thing that locates it, and they say *when* in the run it
happened. The second names what finished most recently before each one, which
is a caller nobody wrapped: it ran, returned, and the work followed it.

A name concentrated in both is where a span would attribute the most. The two
disagreeing is worth more than either alone, because they answer different
questions. And `--ignore` matters more than it looks: a key emitted constantly
is always the nearest thing to have ended, so it crowds the second view without
handing off to anything — dropping it is what lets the real predecessor show. The level where a count stops being
proportional to the work and starts being proportional to the work squared is
the level that introduced the multiplication — that is the caller to fix, and it
is frequently not the
function the profile ranked first.

## 4b. Ask where the elapsed time went, which is a different question

Everything above sums spans. Every measure is an elapsed start-to-end duration,
so that sum is cumulative elapsed span time — useful, and not CPU: it already
contains whatever a span waited through, and a nested span counts the same
interval again inside its parent, so the total can exceed the run itself. CPU
attribution is what step 3's sampling profile is for.

Wall time asks about coverage instead — the union of the intervals beneath a
span against that span's own duration:

```bash
deno run --allow-read skills/perf-investigation/scripts/wall-time.ts /tmp/measures.json
```

What is left over is time the span was open and nothing instrumented was
running. That is the shape of waiting: for a server, a timer, a lock, or work
nobody has wrapped. It is invisible to every view that sums, because summing
attributes only what ran.

Two things the output cannot tell you, and one it can. It cannot distinguish a
blocking round trip from uninstrumented compute — both are simply absence — and
a gap is not automatically a problem. What it can say is where the absence is
and how much is at stake. A stretch that keeps following the same span is the
one to chase: that span handed off to something nobody wrapped, and wrapping
what follows is what turns the question into an answer.

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

A toolshed carries the same timing machinery as everything above, and reports it
over HTTP. Start there; a CPU profile of the server is step 3 here as much as it
is above.

### Which arm is this?

Under the `serverExecution` ON arm the server runs the derivations, so where you
point the instruments changes. Two probes settle it, and both belong in the
record beside any number:

```bash
curl -s "$API_URL/api/health/stats" | jq 'has("servingLoop")'
```

```bash
curl -s "$API_URL/api/meta" | jq .shellServerExecutionDefine
```

The first is true exactly when that process is serving. The second says what the
browser shell was *built* with — the define is baked at build time, so a
source-run toolshed serves the OFF-arm shell whatever its own environment says.
Clients declare their own posture from their own environment too: `cf` and the
integration harnesses announce `serverExecution=false` unless
`EXPERIMENTAL_SERVER_EXECUTION=true` is set for them as well.

A client on the other arm from its server is worth naming precisely, because it
is more dangerous than a broken instrument. Every probe keeps reporting
faithfully — the server's timing statistics and its serving-loop counters are
true readings of what that server did. What they are readings *of* is a
configuration that ships in neither arm: an OFF-declared client still commits
its own derivations while the serving loop derives them too, so wave counts, the
settle series and the amplification ratio all describe a system nobody runs. The
numbers look fine. Check both ends before the run rather than trying to discount
them afterwards.

### Read `/api/health/stats`

One request, no harness, and it answers most of step 0 and step 1 for the server
process:

- `timingStats` — the process's logger timing statistics, keyed exactly as the
  `cf test` rows are and carrying `count`, `totalTime`, `min`/`max`, `p50` and
  `p95`. A serving toolshed runs the runtime, so `scheduler/run/action`,
  `traverse` and `runner/start/*` appear here meaning the *server's* work.
- `logCounts` — the same per-logger counts, which is how a warning storm shows
  up as a number rather than as a log to grep.
- `slowQueries` — the last hundred query, watch, or commit operations over
  100 ms, with the space and the root and watch counts. Query and watch
  entries attribute the traversal (`rootsVisited`, `rootsElapsedMs`,
  `slowestRoot`) and carry `managerReads`, the engine document reads across
  the whole request — the width a root count cannot show, since one root's
  declaration can fan out over many documents. `session.watch.add` and
  `session.watch.refresh` entries also carry `upserts`, the snapshots the
  frame delivered: a wide traversal that yields few is repeated server work,
  and a wide frame is transport and client-ingest work as well. A `transact`
  entry also carries the commit's operation and read counts, its outcome (`ok`,
  the error name, or `threw` — a slow rejected commit records like a slow
  applied one), and `lockWaitMs`: how long the commit waited for the space
  publication lock before evaluating. Flush passes hold that same lock, so
  a `transact` whose `lockWaitMs` dominates its elapsed time was queued
  behind fan-out, not expensive itself.
  Read the traversal fields with the query evaluation cache's coverage in
  mind. The cache serves only whole, current-state evaluations: an eligible
  `graph.query` (without `atSeq` or keyed snapshots), each branch group
  established by `session.watch.set`, and a `session.watch.add` group when that
  session has no tracked graph for the branch yet. A subsequent
  `session.watch.add` for an already tracked branch extends the session's graph
  through `extendTrackedGraph()` and bypasses the cache because its result
  depends on what the session already covers. A page load that grows its watch
  set in batches therefore re-walks those later batches. Nonzero `rootsVisited`
  there is expected extension work, not evidence of a cache miss.
- `documentCaches` — the memory server's decoded-document cache, one entry
  per open space (`Engine.documentCache` in `packages/memory/v2/engine.ts`)
  under the server's `totalBudgetBytes` (beside it the total `bytes`, and
  `totalBudgetEvictions`: entries given up to hold that total rather than a
  space's own bounds):
  per space, `entries` and `bytes` against `budgetBytes` and `maxEntries`,
  and the lifetime `hits`, `misses` and `evictions`. The occupancy figures
  (`entries`, `bytes`, and which spaces appear at all) are a snapshot of the
  moment — the one exception to the paragraph below; the three counters
  accumulate. A corpus is read again by every
  load and every refresh, so a space in good shape shows `hits` climbing
  across loads and `misses` rising only with commits. `evictions` climbing
  while a corpus is being walked means its working set does not fit the
  budget, and every walk is paying decode and deep-freeze for it again — on
  the Topics board that was most of a second of server time per walk.
- `servingLoop` — the serving loop's counters
  ([`serving-loop.md` §7](../../specs/server-side-execution/serving-loop.md)),
  present only when this process serves. `settle.series` is a ready-made
  per-authored-input latency series: admission to watermark coverage, with the
  wave and cycle counts behind each entry.

Everything here accumulates for the process's whole life, across every space it
has served, so a phase is a difference between two captures rather than any
single one — and **only `count` and `totalTime` subtract**. `min`, `max`, `p50`,
`p95` and the CDF describe the whole lifetime; differencing them yields a number
that looks like a phase percentile and is not one. What a diff of the two
additive fields does give you honestly is the phase's call count and its mean.

For a phase *distribution*, the process has to have seen only the phase, so
start a fresh toolshed and capture once at the end. The logger does carry a
delta reservoir (`resetAllTimingBaselines()`, surfaced on `globalThis` and read
back as the `*SinceBaseline` fields and `cdfSinceBaseline`), but nothing on the
health route sets it, so it is reachable in a browser console and not in a
server you are talking to over HTTP.

Whichever way you capture, capture sparingly: each timing row carries its whole
CDF, which puts the response into the hundreds of kilobytes after even a single
deploy. Read it at phase boundaries — polling it is its own load.

The serving loop's own phases are wrapped as `executor/wave/cycle`, `/drain` and
`/settle`. Read them against `wavesBudgetExhausted`, which is a censored
measurement: a wave that overruns the flush deadline reports that deadline
however far past it the wave ran, so the counter says how often and the span
says by how much.

`memory/frame/queue` against `memory/frame/handle` splits an inbound frame's
time into waiting behind the frames already in flight on its connection and
doing its own work. Only the second is that frame's cost, so a queue time far
above every handle time is head-of-line blocking, and the fix is at the frame in
front rather than at the one that reported it.

`memory/flush/queue` against `memory/flush/refresh` is the same split one level
coarser, on the push side: a flush **pass**, never a frame. `refresh` covers
every dirty space the pass selected and every frame those sessions were owed, so
a large batched fan-out and one expensive send are the same number here and
dividing it to recover a per-frame cost is unsound. Read it as a bound instead —
a client's push waits at least the refresh delay plus these two — and reach for
`servingLoop.push` when the question is which sessions a batch served.

`memory/watchAdd/total` is one `session.watch.add` end to end — evaluation
through response assembly — for every request, where `slowQueries` keeps only
those over its threshold. `memory/response/prepareSchemas` against
`memory/response/sendRaw` splits each outbound message, response or effect, into
schema-table compression and the hand-off to the transport;
`memory.compression/send/encode` is the websocket compression that follows, on
whichever side is sending.

### Profile the process

A toolshed is a Deno process, so the recipes in step 2 apply to it: run it under
`--inspect` and attach DevTools, or drive V8's profiler from inside it with
`node:inspector`. Take the profile over a bracketed phase — the marks have to be
in this process, which for a server means the health-stats capture either side
rather than a mark in the test that provoked it.

For a local investigation the dev scripts own the wiring:

```bash
./scripts/start-local-dev.sh --port-offset 2 --inspect
```

starts the toolshed under `--inspect=127.0.0.1:<9229 + offset>`, and
`http://127.0.0.1:<that port>/json` names the WebSocket debugger endpoint.

Attaching DevTools suits a phase you can provoke by hand. A phase another
process provokes — a browser load driven by a harness, a CLI run — wants the
capture scripted so the bracket is exact: connect a WebSocket to the debugger
endpoint, send `Profiler.enable`, `Profiler.setSamplingInterval` and
`Profiler.start`, hold the connection open while the provoking process runs,
then `Profiler.stop` and write the result's `profile` to a `.cpuprofile` file,
which Chrome DevTools and speedscope both load. When the provoker cannot signal
the driver directly, a sentinel file the driver polls for is the honest
bracket: the provoker touches it when its observable effect lands, and the
poll's looseness costs trailing idle samples, never attribution.

To say what ran inside the window, difference `slowQueries` around it the same
way as the timing rows: it is a bounded list, so capture it either side and
read the new tail — each entry names the operation, the space, and the watch
counts behind one server span the profile just weighed.

OTEL spans exist behind `OTEL_ENABLED` with a collector to receive them, and are
the right instrument for a deployed server rather than a local investigation.
