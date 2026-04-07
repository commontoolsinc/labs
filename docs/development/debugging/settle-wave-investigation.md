# Debugging Settle Waves

Use this guide when the shell or a pattern feels busy after a change, reload,
or user interaction, especially when the page looks responsive but the worker
keeps running for much longer than expected.

The goal is to answer four questions quickly:

1. Is the expensive work on the main thread or in the worker?
2. Is the worker spending time on rendering, storage, traversal, or scheduler
   convergence?
3. Which interaction or write kicked off the fan-out wave?
4. What should be instrumented next if the existing logs are not enough?

The sections below walk through a reusable workflow first, then keep the
current settle-wave investigation as a worked example.

## When To Use This Guide

Start here if you see any of the following:

- reload looks visually fine but the worker stays busy
- creating or editing content triggers long waves of background work
- `scheduler` or `traverse` counts jump rapidly after a single write
- UI updates land, but the runtime keeps settling for several more passes
- Chrome traces show long tasks on a dedicated worker thread instead of
  `CrRendererMain`

This guide is worker-first because the investigation below showed that the most
important work can happen off the main thread.

## Quick Start

1. Reproduce the interaction in a local shell session served from the Toolshed
   origin.
2. Capture a Chrome performance trace for the interaction and inspect both
   `CrRendererMain` and the dedicated worker thread.
3. If the worker dominates, use `commontools.rt` in the page console to reset
   logger baselines, replay the interaction, and inspect the deltas.
4. Compare `scheduler/execute`, `scheduler/execute/settle`,
   `scheduler/execute/event`, `traverse`, `storage.cache`, and
   `worker-reconciler`.
5. If you need to know exactly which storage change re-scheduled which action,
   enable trigger tracing and inspect `commontools.rt.getTriggerTrace()`.
6. If you need to know which actions actually ran during one interaction,
   enable exact action-run tracing and compare repeated runs in the same space.
7. If the wave is still unclear, temporarily raise the
   `scheduler.trigger-flow` logger to `debug` and look for repeated
   `schedule-trigger`, `schedule-change-trigger`, and
   `schedule-resubscribe-path` patterns.
8. If nested piece setup or view-materialization looks suspicious, raise
   `runner.trigger-flow` to see which source action id is driving
   `Runner.run()`, `setupInternal()`, and `instantiatePatternNode()`.
9. If the trace and focused logs still leave ambiguity, add or expose more
   instrumentation before guessing at a fix.

## Reproduction Workflow

The most useful baseline so far was a simple shell flow:

1. Open a local space at `http://localhost:8000/<space-id>`.
2. Register a new account using the same path as
   `packages/shell/integration/login.test.ts`.
3. Reload after registration and confirm the account persisted.
4. Create a note using the flow from
   `packages/patterns/integration/default-app.test.ts`.
5. Return to the space home and confirm the note appears in the list.

For the current investigation the space was `perf-space-mmwj1lw4`.

If you are investigating how settle waves scale with existing content, keep the
same space across runs. For the integration harness, prefer `SPACE_NAME=...`
over a random space so repeated note creation lands in the same list and the
fan-out grows naturally.

## Trace Workflow

Capture two traces when possible:

1. A reload trace after account creation.
2. A trace around the content-creation interaction you care about.

The first tells you whether startup or persisted hydration is causing a wave.
The second tells you whether a specific write or navigation fans out.

For large spaces, do not trust a single reload sample. Repeat the same reload
`3-5` times at a fixed note count and compare medians. In this investigation
the graph shape was stable while individual worker timings varied a lot from
run to run.

### What To Inspect In Chrome DevTools

For each trace:

- compare total `RunTask` time on `CrRendererMain` versus the dedicated worker
- count worker tasks at or above `50 ms`
- inspect large `RunTask` slices for long microtask drains
- note whether GC is visible but secondary
- map the hottest worker bundle locations back to source files

### How To Read The Trace

Use this rough rule of thumb:

- If main-thread time dominates, start with rendering and DOM work.
- If worker `RunTask` time dominates, treat the trace as a scheduler/runtime
  problem first.
- If `worker-reconciler` is quiet but `scheduler/execute/settle` is large, the
  bottleneck is convergence before rendering.
- If `traverse` is high count but low average latency, it is often a symptom of
  broad fan-out rather than the sole root cause.

## Console Workflow

After the trace, keep the session live and inspect the worker through
`commontools.rt` in the page console.

### Establish A Baseline

Inspect the available counters first:

```js
await commontools.rt.getLoggerCounts()
```

Reset counts and timings just before replaying the interaction:

```js
await commontools.rt.resetLoggerBaselines()
```

Replay one interaction, let it settle, then inspect counts again.

### Timings To Compare First

These are the most useful worker timing groups so far:

- `scheduler/execute`
- `scheduler/execute/settle`
- `scheduler/execute/event`
- `scheduler/run`
- `scheduler/run/action`
- `scheduler/run/commit`
- `traverse`
- `storage.cache`
- `worker-reconciler`

Enable settle stats when logger timing is not enough:

```js
await commontools.rt.setSettleStatsEnabled(true)
await commontools.rt.getSettleStats()
await commontools.rt.getSettleStatsHistory()
```

`getSettleStats()` still returns only the **last** `execute()` call, but the
history buffer now keeps recent settle results so note-creation and navigation
waves survive trailing empty settles.

For most investigations, the history buffer is enough:

```js
await commontools.rt.setSettleStatsEnabled(true)
await commontools.rt.getSettleStatsHistory()
```

If you need live sampling while the interaction is still in progress, poll
`getSettleStats()` and keep changed samples:

```js
globalThis.__settleSamples = []
globalThis.__lastSettleSig = null
globalThis.__settlePoll = setInterval(() => {
  void commontools.rt.getSettleStats().then((stats) => {
    const sig = JSON.stringify(stats)
    if (sig !== globalThis.__lastSettleSig) {
      globalThis.__lastSettleSig = sig
      globalThis.__settleSamples.push({ at: performance.now(), stats })
    }
  })
}, 25)

// ... perform the interaction ...

clearInterval(globalThis.__settlePoll)
globalThis.__settleSamples
```

### Capture Trigger Trace

Use trigger trace when the question is no longer "is there churn?" and becomes
"which exact write scheduled this action again?"

Trigger tracing is off by default and keeps a bounded ring buffer of compact
entries. Each entry records:

- the changed `space`, `entityId`, and `path`
- compact `before` and `after` value summaries
- the scheduling mode (`push` or `pull`)
- the source writer action id when a change group can be resolved
- each directly triggered action, its scheduling decision, and any downstream
  effects scheduled from it

Enable it just before the interaction:

```js
await commontools.rt.setTriggerTraceEnabled(false)
await commontools.rt.setTriggerTraceEnabled(true)
```

Replay the interaction, let it settle, then inspect the raw entries:

```js
const trace = await commontools.rt.getTriggerTrace()
trace.slice(-5)
```

If you want the shell to resolve the hottest changes for you, use the console
helper instead of hand-writing grouping code:

```js
await commontools.explainTriggerTrace({ rootOnly: true, limit: 8 })
```

That helper groups exact `space/entity/path` changes, counts direct schedules,
counts downstream scheduled effects, reads the changed cells back through
`CellHandle`, and adds shape hints such as `ui-result`,
`runtime-process-cell`, `default-app-or-home-state`, and `index-state`.

To group repeated actions quickly:

```js
const trace = await commontools.rt.getTriggerTrace()
const counts = new Map()

for (const entry of trace) {
  for (const action of entry.triggered) {
    counts.set(action.actionId, (counts.get(action.actionId) ?? 0) + 1)
    for (const effect of action.scheduledEffects) {
      counts.set(effect.actionId, (counts.get(effect.actionId) ?? 0) + 1)
    }
  }
}

[...counts.entries()]
  .filter(([, count]) => count > 1)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 10)
```

### Capture Exact Action Runs

Use exact action-run tracing when the question becomes "which actions really ran
during this interaction?" rather than "which actions were merely scheduled?"

This is especially useful when:

- settle stats show repeated waves but you need the exact action ids inside them
- trigger trace is noisy because one root write schedules many sinks
- you want to compare note 1 versus note 2 versus note 3 in the same space

Reset the ring buffer just before the interaction:

```js
await commontools.rt.setActionRunTraceEnabled(false)
await commontools.rt.setActionRunTraceEnabled(true)
```

Replay the interaction, wait for the worker to go idle, then inspect the trace:

```js
await commontools.rt.idle()
const trace = await commontools.rt.getActionRunTrace()
trace.slice(-10)
```

To group the exact runs by action id:

```js
const trace = await commontools.rt.getActionRunTrace()
const counts = new Map()

for (const entry of trace) {
  const row = counts.get(entry.actionId) ?? {
    actionType: entry.actionType,
    count: 0,
    totalDurationMs: 0,
  }
  row.count += 1
  row.totalDurationMs += entry.durationMs
  counts.set(entry.actionId, row)
}

[...counts.entries()]
  .map(([actionId, row]) => ({
    actionId,
    actionType: row.actionType,
    count: row.count,
    totalDurationMs: Number(row.totalDurationMs.toFixed(1)),
  }))
  .sort((a, b) => b.count - a.count || b.totalDurationMs - a.totalDurationMs)
  .slice(0, 20)
```

For scaling work, keep the same space across runs and compare later notes
against each other, not only against note 1. The first run often includes
navigation, mount, and reader-materialization noise that is absent once the
space is already warm.

If you need a scripted browser reproduction instead of manual console work, the
default-app integration flow now supports this:

```sh
HEADLESS=true \
API_URL=http://localhost:8000 \
FRONTEND_URL=http://localhost:5173 \
CT_CAPTURE_TRIGGER_TRACE=1 \
deno test -A packages/patterns/integration/default-app.test.ts
```

Use `:5173` here when you need the shell to serve the worktree's current code.
Keep `API_URL` pointed at Toolshed on `:8000`.

## Transaction-Level Write Stack Tracing

Use transaction-level write tracing when trigger trace has already told you
which cell is noisy and you need the exact write callsite inside the worker.

This probe is opt-in and bounded. It matches writes by logical cell path, not
the internal `["value", ...]` storage wrapper path, so root cell writes are
still watched with `path: []`.

Arm it just before the interaction:

```js
await commontools.watchWrites({
  space: commontools.space,
  path: [],
  match: "exact",
  label: "root writes in current space",
})
```

Replay the interaction, let it settle, then inspect the captured stacks:

```js
const trace = await commontools.getWriteStackTrace()
trace.slice(-5)
```

For a known hot cell from trigger trace, narrow it to that exact entity:

```js
await commontools.watchWrites({
  space: "did:key:z6Mkm...",
  id: "of:baedrei...",
  path: [],
  match: "exact",
  label: "watched hot cell",
})
```

What to look for:

- repeated `_CellImpl.setSourceCell` writes point to source-cell materialization
  rather than reactive recompute logic
- `Runner.setupInternal -> _CellImpl.setRawUntyped` usually means initial
  process-cell or result-cell setup, not a later settle-wave recompute
- `raw:async -> _CellImpl.setRawUntyped` means a raw builtin or raw helper is
  directly rewriting a result cell; this is the more interesting repeated write
  to chase after setup noise is removed
- `Runner.setupInternal` and `Runner.instantiatePatternNode` mean the write is
  coming from piece instantiation/setup
- `diffAndUpdate`, `applyChangeSet`, or pattern handler frames point to runtime
  state updates after setup, which are usually more interesting optimization
  targets
- `raw:async ...worker-runtime.js` is still noisy, so keep the next 1-3 frames
  after it to find the actual pattern or runtime helper behind it

If you want each match printed immediately, turn on the focused logger first:

```js
await commontools.rt.setLoggerEnabled(true, "storage.write-trace")
await commontools.rt.setLoggerLevel("warn", "storage.write-trace")
```

Disable the watcher and clear the buffer with:

```js
await commontools.watchWrites([])
```

### How To Interpret Logger Deltas

Use the deltas to narrow the problem:

- Large `scheduler/execute/settle` with multiple `execute()` passes usually
  means repeated convergence work after the initial event.
- Large `schedule-resubscribe-path` plus `schedule-trigger` usually means a
  write is matching many existing subscriptions and rebuilding too many paths.
- Large `schedule-run-start` relative to one user interaction means one write
  is fanning out into many action runs.
- High `storage.cache` volume can be important, but it is not automatically the
  root cause unless its timing dominates too.
- Small `worker-reconciler` deltas mean the UI flush is downstream, not the
  primary bottleneck.

## Selective Debug Logging

Use `scheduler.trigger-flow` first when you only need change-trigger causality.
Use `runner.trigger-flow` when the problem looks like repeated nested piece
setup or view-materialization. Keep full `scheduler` debug logging for deeper
settle-loop work.

Enable the focused trigger logger briefly:

```js
await commontools.rt.setLoggerEnabled(true, "scheduler.trigger-flow")
await commontools.rt.setLoggerLevel("debug", "scheduler.trigger-flow")
```

After you capture enough detail, return it to a quieter level:

```js
await commontools.rt.setLoggerLevel("warn", "scheduler.trigger-flow")
```

Enable the focused runner logger when you need to know which source action is
calling back into `Runner.run()`:

```js
await commontools.rt.setLoggerEnabled(true, "runner.trigger-flow")
await commontools.rt.setLoggerLevel("debug", "runner.trigger-flow")
```

This logger keys counts by source action id, so even without reading every log
line you can tell whether nested runs are coming from `raw:wish`,
`raw:navigateTo`, or a handler/computation path.

Enable the focused wish logger when you need to know whether `wish()` itself is
causing nested pattern launches or is only acting as a broad reader over hot
indexes:

```js
await commontools.rt.setLoggerEnabled(true, "runner.wish-flow")
await commontools.rt.setLoggerLevel("debug", "runner.wish-flow")
```

Use it to answer these questions quickly:

- Is the hot path direct tag/path resolution, or is `wish()` launching a
  suggestion pattern?
- Which queries are rerunning most often during one interaction?
- Are failures coming from hashtag search (`#notebook`, `#allNotes`, etc.) or
  from the well-known `#default` / `#mentionable` / `#recent` paths?

If you still need settle-loop internals, then raise the broader scheduler logger:

```js
await commontools.rt.setLoggerEnabled(true, "scheduler")
await commontools.rt.setLoggerLevel("debug", "scheduler")
```

## Disambiguate Async Raw Actions

If a write stack shows:

- `Runner.setupInternal`
- `Runner.run`
- `raw:<name>` or an async raw frame

do not jump straight to a product-level conclusion. First split the path into
one of these categories:

- async builtin doing direct read/sync work against existing cells
- async builtin launching or materializing more runtime work
- navigation or shell callback follow-on work outside `Runner.run()`

Use these tools to disambiguate:

- `runner.trigger-flow` to see which source action id is re-entering
  `Runner.run()`
- exact action-run tracing to tell whether the same raw action actually ran or
  was merely scheduled
- write stack tracing to see whether the repeated writes are setup pairs or
  later state updates

Do not treat the generic `raw:async` frame by itself as evidence of one
specific builtin. The useful signal is the resolved raw action id plus the next
few frames underneath it.

## Investigating Broad Async Readers

Sometimes the hottest action is not the true root cause, especially when it is
an async reader over a broad index or collection.

Signs that this is happening:

- run count stays low, but total time is large or highly variable
- one action spends much of its time in awaited `sync()` or lookup work
- downstream index, grid, or summary actions also appear hot in the same wave

When that happens:

1. Measure both run count and total time. Do not optimize only by count.
2. Check whether the hot action is loading or syncing a large result set.
3. Inspect the producer side as well as the reader side.
4. Compare the same measurement on small and large spaces before assuming the
   action body itself is the only problem.

Typical producer-side surfaces to inspect include:

- index builders that scan all pieces
- home/list/grid views that materialize many previews
- broad root-state cells that are rewritten wholesale instead of updated
  narrowly

### What To Look For In Debug Logs

The useful patterns are:

- one commit matching dozens of registered actions
- the same action ids or source locations appearing repeatedly in
  `schedule-trigger`
- repeated `schedule-resubscribe-path` bursts after each run
- alternating change, trigger, run, commit, and resubscribe waves that keep
  repeating

If you see that shape, the problem is usually not one slow action body. It is
the number of affected actions and the number of times they are revisited.

## Source Paths Worth Checking First

Start with these locations when traces or logs point to worker churn:

- `packages/runner/src/scheduler.ts`
  - settle loop: `3112-3343`
  - queue path: `1314-1319`
  - requeue path: `3476-3480`
  - task scheduling helper: `3718-3719`
  - settle stats helpers: `2477-2485`
  - timed diagnosis: `2573-2582`
  - idempotency check: `2590-2605`
- `packages/runtime-client/backends/web-worker/index.ts`
  - worker message entrypoint: `20-50`
- `packages/runtime-client/backends/runtime-processor.ts`
  - console-facing diagnosis IPC: `752-756`
- `packages/runner/src/storage/cache.ts`
  - socket event dispatch: `1564-1572`
- `packages/html/src/worker/reconciler.ts`
  - worker flush scheduling: `248-262`

## Current Tooling Gap

The timed diagnosis mismatch is now resolved:

- `commontools.detectNonIdempotent(ms)` and
  `commontools.rt.detectNonIdempotent(ms)` now run a real diagnosis window
- debugger UI diagnosis duration selection now maps to the same path
- results now include real `duration` and `busyTime`

The main remaining gap is no longer raw capture. It is collapsing noisy trigger
surfaces into the few semantic writes that should matter:

- settle history now preserves recent execute waves
- trigger trace now records the raw change-to-action schedule chain
- repeated action ids can be grouped, but sink-heavy output still needs manual
  interpretation
- the next useful tooling layer would summarize trigger traces by semantic
  write class, not just by action id

## Recommended Next Instrumentation

The highest-value next change is now to summarize trigger traces directly by
write source and semantic surface, so repeated hot paths are visible without
manual post-processing.

That summary should make it easy to answer:

- which exact entity/path writes cause most of the re-schedules
- whether one semantic write is expressed as many low-level storage changes
- which sink and UI-path actions are downstream noise rather than root cause
- which subscriptions should be narrowed first

## Example Findings From March 18, 2026

The rest of this section is an example run that motivated the guide above.

### Environment

- local Toolshed origin: `http://localhost:8000`
- space: `perf-space-mmwj1lw4`
- trace artifacts:
  - `/tmp/cf-perf-traces/reload-after-register.json`
  - `/tmp/cf-perf-traces/create-note.json`

### Trace Headlines

| Interaction | LCP | INP | CLS | Notes |
| --- | ---: | ---: | ---: | --- |
| Reload after registration | 211 ms | n/a | 0.02 | Persisted account state survived reload |
| Create note | 221 ms | 51 ms | 0.02 | Trace ended on the new note page |

### Main Thread Vs Worker

| Trace | Main total `RunTask` | Main tasks >= 50 ms | Worker total `RunTask` | Worker tasks >= 50 ms |
| --- | ---: | ---: | ---: | ---: |
| Reload after registration | 160 ms | 0 | 4254 ms | 10 |
| Create note | 556 ms | 0 | 2160 ms | 10 |

Conclusion: the worker dominated execution time. The main thread was not the
expensive execution site.

### Worker Long Tasks

Reload after registration:

- top worker `RunTask` durations: `1547`, `912`, `376`, `373`, `235` ms
- top worker microtask drains:
  - `1546.5 ms / 727 microtasks`
  - `912.0 ms / 309`
  - `375.7 ms / 61`
  - `372.7 ms / 67`
  - `235.3 ms / 46`
- GC was visible but secondary:
  - minor GC about `87 ms`
  - major GC about `20 ms`

Create note:

- top worker `RunTask` durations: `398.6`, `344.5`, `171.4`, `163.5`, `94.2`
  ms
- top worker microtask drains:
  - `318.9 ms / 1011 microtasks`
  - `170.8 ms / 680`
  - `161.8 ms / 709`
  - `147.5 ms / 480`
  - `84.1 ms / 10`
- GC was visible but secondary:
  - minor GC about `52 ms`
  - major GC about `37 ms`

### Worker Hot Paths

The hottest worker bundle locations mapped back to:

- `packages/runner/src/scheduler.ts:1314-1319`
- `packages/runner/src/scheduler.ts:3476-3480`
- `packages/runtime-client/backends/web-worker/index.ts:20-50`
- `packages/runner/src/storage/cache.ts:1564-1572`
- `packages/html/src/worker/reconciler.ts:248-262`

Important detail: the reconciler flush path was not where the time went. The
expensive part was upstream in scheduler execution and message-driven worker
processing.

### Logger Baseline Example

One sampled `Notes -> New Note` wave produced:

| Logger / Metric | Delta |
| --- | ---: |
| `scheduler.total` | 2589 calls |
| `scheduler.schedule-resubscribe-path` | 744 |
| `scheduler.schedule-notification` | 459 |
| `scheduler.schedule-unsubscribe` | 296 |
| `scheduler.schedule-trigger` | 225 |
| `scheduler.schedule-run-start` | 125 |
| `storage.cache.total` | 1242 calls |
| `traverse.total` | 1542 calls |
| `worker-reconciler.total` | 33 calls |
| `runner.total` | 10 calls |

Timing since baseline:

| Timing Key | Count Since Baseline | Total Since Baseline | Average Since Baseline |
| --- | ---: | ---: | ---: |
| `scheduler/execute` | 5 | 888.5 ms | 177.7 ms |
| `scheduler/execute/settle` | 5 | 627.8 ms | 125.6 ms |
| `scheduler/execute/event` | 5 | 214.5 ms | 42.9 ms |
| `scheduler/run` | 125 | 702.9 ms | 5.62 ms |
| `scheduler/run/action` | 125 | 246.5 ms | 1.97 ms |
| `scheduler/run/commit` | 125 | 372.0 ms | 2.98 ms |
| `traverse` | 345 | 214.2 ms | 0.62 ms |
| `runner/action/readInputs` | 104 | 160.3 ms | 1.54 ms |
| `runner/action/populateDependencies` | 13 | 42.8 ms | 3.29 ms |

Interpretation:

- the wave required `5` scheduler `execute()` passes
- about `71%` of `execute()` time was in `scheduler/execute/settle`
- `traverse` contributed, but was not the only cause
- `worker-reconciler` barely moved

### Direct Settle-Stats Example

After exposing settle stats over IPC, a second live measurement on note
creation first used `commontools.rt.setSettleStatsEnabled(true)` plus a 25 ms
poller around the interaction. That showed that a single `getSettleStats()`
read was not enough because trailing settles could overwrite the interesting
wave.

That led to `commontools.rt.getSettleStatsHistory()`, which now captures the
same interaction without polling.

Captured non-empty settle waves for one `📝 New` interaction from an existing
note page:

- primary wave: `702.9 ms` total across `5` iterations
- secondary wave: `99.0 ms` total across `3` iterations

Primary wave iteration sizes:

- iteration 1: `workSetSize 27`, `orderSize 27`, `actionsRun 27`,
  `duration 348.4 ms`
- iteration 2: `18`, `18`, `18`, `265.4 ms`
- iteration 3: `6`, `6`, `6`, `34.6 ms`
- iteration 4: `5`, `5`, `5`, `53.0 ms`
- iteration 5: `2`, `2`, `2`, `1.5 ms`

Secondary wave iteration sizes:

- iteration 1: `3`, `3`, `3`, `51.8 ms`
- iteration 2: `1`, `1`, `1`, `6.2 ms`
- iteration 3: `1`, `1`, `1`, `41.0 ms`

Repeated hot actions in those settle samples included:

- `api/patterns/notes/note.tsx:1:23`
- `api/patterns/system/default-app.tsx:1:23`
- `api/patterns/system/backlinks-index.tsx:1:23`
- `api/patterns/system/backlinks-index.tsx:86:31`
- `api/patterns/system/piece-grid.tsx:1:23`
- `api/patterns/system/summary-index.tsx:1:23`
- repeated generic worker entry actions from `worker-runtime.js`

Interpretation:

- the note interaction is not one giant settle loop; it is at least two waves
- the first wave is the clear cost center
- the work is spread across note, default-app, backlinks, summary, and grid
  computations rather than one isolated pattern
- any optimization should target fan-out and repeated recomputation across that
  set, not just one note computation in isolation

### Settle-History Example

Using `commontools.rt.getSettleStatsHistory()` around the original home-page
`Notes -> New Note` flow produced `6` history entries, `15` total settle
iterations, `84` total action runs, and `875.3 ms` total recorded settle time.

The largest history entry was:

- `463.5 ms` total
- first iteration: `workSetSize 26`, `orderSize 26`, `actionsRun 26`
- second iteration: `17`, `17`, `17`, `43.8 ms`

The next follow-on waves were:

- `272.1 ms` across `5` iterations
- `109.6 ms` across `3` iterations

Grouping the recorded action ids across that history gave:

- generic worker entry `raw:async ...worker-runtime.js:287905:16`: `22`
  appearances
- `api/patterns/notes/note.tsx:1:23`: `15`
- `api/patterns/system/default-app.tsx:1:23`: `8`
- `api/patterns/system/piece-grid.tsx:1:23`: `5`
- `api/patterns/system/backlinks-index.tsx:1:23`: `4`

Interpretation:

- the home-page note flow still fans out across multiple waves after the
  initial navigation
- `note.tsx` is prominent, but it is not alone
- `default-app`, `piece-grid`, and `backlinks-index` all recur enough to matter
- the generic worker entry action is noisy and should be separated from the
  underlying pattern computations when deciding what to optimize

### Automated Trigger-Trace Example

The env-gated default-app integration flow now captures grouped trigger-trace
output with:

```sh
HEADLESS=true \
API_URL=http://localhost:8000 \
FRONTEND_URL=http://localhost:5173 \
CT_CAPTURE_TRIGGER_TRACE=1 \
deno test -A packages/patterns/integration/default-app.test.ts
```

One March 18, 2026 run of that flow produced:

- `78` trigger-trace entries for one `Notes -> New Note -> back to list`
  interaction
- repeated `notes/note.tsx:1:23` scheduling `176` times
- repeated generic worker entry scheduling `36` times
- repeated `default-app.tsx:1:23` scheduling `32` times
- repeated `piece-grid.tsx:1:23` scheduling `22` times
- repeated `summary-index.tsx:1:23` scheduling `20` times
- multiple sink actions under the same home-page VDOM subtree also re-scheduled
  about `20` times each

The top samples were all `schedule-push` decisions, which means that in this
flow the same actions are being scheduled repeatedly on the push path, not just
fanned out once and then pulled lazily later.

The raw change keys in that run were mostly whole-entity writes with empty
paths, for example:

- `did:key:.../of:baedreidlikx465pmmokxpprydvadzqdd33gckybga7zs32guabfc77ezja/`
- `did:key:.../of:baedreig6cn2svbbritymq7duqfhy4nmorhtqohpqjnnmyv2npllc7d3u5a/`
- `did:key:.../of:baedreia4qcblku2jy5rldrsnpais234j57opyvepfiu7zv72wiurrxx2lu/`

Interpretation:

- the repeated work persists in the automated flow, not just in manual DevTools
  sampling
- broad fan-out alone is not the whole story because the same action ids are
  being scheduled many times
- sink-path actions add a lot of noise, so the next instrumentation pass should
  group low-level writes into fewer semantic classes before we decide what to
  optimize

### Fixed-Space Action-Run Example

One March 19, 2026 run used the new exact action-run trace in the default-app
integration flow while creating three notes in the same `SPACE_NAME`:

```sh
HEADLESS=true \
API_URL=http://localhost:8000 \
FRONTEND_URL=http://localhost:5173 \
SPACE_NAME=settle-wave-order-space \
CT_CAPTURE_ACTION_RUN_SERIES=3 \
deno test -A packages/patterns/integration/default-app.test.ts
```

Per-note totals were:

- note 1: `240` action runs, `104` unique actions, `179` computations, `61`
  effects
- note 2: `118` action runs, `53` unique actions, `86` computations, `32`
  effects
- note 3: `76` action runs, `40` unique actions, `62` computations, `14`
  effects

The first run was still dominated by startup/navigation work. The steadier
signal was the monotonic growth in one note computation source:

- `api/patterns/notes/note.tsx:284:32`: `3 -> 4 -> 5`
- `api/patterns/system/default-app.tsx:224:25`: `3 -> 2 -> 1`
- `api/patterns/system/default-app.tsx:235:25`: `3 -> 2 -> 1`
- `api/patterns/system/piece-grid.tsx:21:19`: `7 -> 5 -> 3`
- `raw:wish`: `10 -> 9 -> 11`

Line `284` in `note.tsx` is the `containingNotebooks` computed:

```tsx
const containingNotebooks = computed(() => {
  if (!menuOpen.get()) return [];
  // ...
});
```

With instance-level action-run metadata enabled, the pattern became clearer:

- on note 1, only the newly created note instance ran this computed, `3` times
- on note 2, the new note instance ran it `3` times and the previous note
  instance reran it once, for `4` total
- on note 3, the new note instance ran it `3` times and the two existing note
  instances reran it once each, for `5` total

The hottest concrete instances in that run were:

- note 2 instance:
  `.../of:baedreiefd3q4pzla2cg2pyv2toduazdy7gkcxgrwk2oexctrctlgcfc52y/internal/__#15`
  with counts `0 -> 3 -> 1`
- note 3 instance:
  `.../of:baedreifk35ul5pe6s3v7b4xswiqtpuq2hdcw2wkj7ag2k6pwfwsygpgl2i/internal/__#15`
  with counts `0 -> 0 -> 3`

Interpretation:

- creating a note does not just run work for the newly created note
- one existing note instance is revisited for each previously existing note in
  the warm space
- the scaling signal now points at note-instance revisits, not just abstract
  source-level fan-out
- the most likely driver is rematerialization or re-evaluation of existing note
  views as the home-page piece list grows

If you want the same view locally, make sure exact action-run tracing includes
instance targets. The useful bucket is the `noteActionInstancesIncreasedOnLaterRuns`
section printed by the integration harness, not only the top-level
`increasedOnLaterRuns` action ids.

### Fresh-Tab Home-Load Example

One March 20, 2026 run sampled initial load in a real Chrome browser by opening
the same space in a fresh tab after `0`, `1`, `2`, and `3` notes. This was
more reliable than the Astral integration harness for cross-tab persistence.

The measurement snippet was:

```js
await commontools.rt.idle()
const { timing } = await commontools.rt.getLoggerCounts()
const graph = await commontools.rt.getGraphSnapshot()

return {
  loadDurationMs: performance.now(),
  execute: timing.scheduler?.["scheduler/execute"]?.totalTime ?? 0,
  settle: timing.scheduler?.["scheduler/execute/settle"]?.totalTime ?? 0,
  graph,
}
```

The measured series for one warm space was:

- `0` notes: `14914.6 ms` to idle, `149` graph nodes, `50` action runs,
  `scheduler/execute = 160.3 ms`, `settle = 143.8 ms`
- `1` note: `13149.6 ms` to idle, `260` graph nodes, `70` action runs,
  `scheduler/execute = 532.3 ms`, `settle = 499.5 ms`
- `2` notes: `15484.6 ms` to idle, `314` graph nodes, `80` action runs,
  `scheduler/execute = 638.6 ms`, `settle = 598.3 ms`
- `3` notes: `12904.1 ms` to idle, `368` graph nodes, `90` action runs,
  `scheduler/execute = 1068.7 ms`, `settle = 1019.3 ms`

The wall-clock tab load time was noisy, but the worker-side scheduler totals
were not: `execute()` and `settle` both grew sharply with note count, and the
graph size grew almost linearly after the first note.

The hottest load actions in that series were:

- `raw:map`: run count `10 -> 21 -> 25 -> 29`
- `api/patterns/system/default-app.tsx:308:39`: `0 -> 2 -> 4 -> 6`
- `api/patterns/system/piece-grid.tsx:21:19`: constant `2` runs, but total
  time `0.9 -> 5.5 -> 9.4 -> 17.0 ms`
- `raw:wish`: stayed at `3` runs, but total time was high and noisy:
  `78.7 -> 204.4 -> 140.0 -> 393.5 ms`

The line at `default-app.tsx:308` is the per-piece `isNotebook` computed inside
the home-page `visiblePieces.map(...)` table render, and `piece-grid.tsx:21` is
the `filtered = computed(() => pieces.filter(...))` list pass for the grid
preview. Those are not startup-only actions. They are real home-load work that
scales with the number of rendered pieces.

Interpretation:

- yes, there is a real initial-load storm even at `0` notes
- the very large first create-note run was partly this existing home-load cost,
  not only note-creation work
- after notes exist, fresh home loads get more expensive in the worker even
  when the user is only opening the space, not creating anything
- the main growth signals are home-page list/grid computations and their
  downstream effects, not just the per-note `containingNotebooks` revisit

Later sampling on the same space showed that the one-step delta can also be
surprisingly lumpy once the space is already large. A fresh-tab load comparison
from `22` to `23` notes produced:

- graph nodes: `689 -> 705`
- action runs: `319 -> 361`
- `scheduler/execute`: `4855.5 -> 8270.8 ms`
- `scheduler/execute/settle`: `4602.2 -> 8004.4 ms`

The biggest per-action deltas in that `+1 note` comparison were:

- `raw:map`: `133 -> 148` runs
- `default-app.tsx:308:39`: `46 -> 47` runs
- `piece-grid.tsx:21:19`: `2 -> 10` runs and `111.6 -> 556.3 ms`
- `backlinks-index.tsx:176:19`: `0 -> 5` runs and `580.1 ms`
- `raw:wish`: still `3` runs, but `1066.7 -> 1135.0 ms`

That is not the shape of a tiny constant per-note increase. It suggests that
once the space is large enough, some home-load work crosses into broader
re-evaluation waves, especially around grid preview work and backlink/index
rebuilds.

### Transaction Write-Trace Example

One March 18, 2026 manual run used the new transaction write watcher against
all root writes in the current space while creating a note from an already-open
note page:

```js
await commontools.watchWrites({
  space: commontools.space,
  path: [],
  match: "exact",
  label: "root writes in current space",
})
```

That interaction recorded `30` matched root writes. The dominant stack
signatures were:

- `Runner.setupInternal -> _CellImpl.setSourceCell` (`5` writes)
- `Runner.setupInternal -> _CellImpl.setRawUntyped` (`5` writes through one
  setup branch and `5` through another)
- `diffAndUpdate -> applyChangeSet -> _CellImpl.set/_CellImpl.send` (`3`
  writes)

Representative stacks also showed:

- `handler:.../api/patterns/notes/note.tsx:1:23` on one note-page source-cell
  write
- `Runner.instantiatePatternNode` on note output and vnode setup writes
- `raw:async ...worker-runtime.js` above several setup-time root writes

Going one level higher in source terms, those stacks mapped to:

- `handler:...notes/note.tsx -> postRun() -> Runner.run() -> Runner.setupInternal()`
- `Runner.instantiatePatternNode() -> Runner.run() -> Runner.setupInternal()`
- `raw:async -> postRun()/sendValueToBinding() -> Runner.run() -> Runner.setupInternal()`

For the smaller diff/write cluster, the deeper paths mapped to:

- `Cell.set()/Cell.send()/Cell.push() -> diffAndUpdate() -> applyChangeSet()`
- `sendValueToBinding() -> diffAndUpdate() -> applyChangeSet()`

Interpretation:

- many broad root writes are still piece setup/materialization writes, not just
  repeated reactive recomputes
- each new cell commonly produces a pair of writes: one source-cell marker and
  one value write
- the smaller `diffAndUpdate` cluster is a better candidate for true
  post-setup churn than the raw setup pairs

### Source Inspection Notes

The grouped action ids line up with a few broad reactive surfaces:

- `packages/patterns/notes/note.tsx`
  - `createNewNote` pushes a fresh note into `allPieces` when not inside a
    notebook
  - each note also pulls in global wish-based dependencies such as `#default`
    `allPieces` and `#mentionable`
- `packages/patterns/system/default-app.tsx`
  - owns `allPieces`
  - derives `visiblePieces`
  - instantiates `BacklinksIndex`, `SummaryIndex`, and two `PieceGrid`
    instances from that shared state
- `packages/patterns/system/piece-grid.tsx`
  - maps the full piece list to a grid of `cf-render` previews, so one added
    piece can revisit the whole grid surface
- `packages/patterns/system/backlinks-index.tsx`
  - `computeIndex` resets backlinks on every piece and repopulates them by
    scanning all pieces
  - `computeMentionable` recursively walks all pieces and exported
    `mentionable` lists

Working hypothesis:

- adding one note to `allPieces` is broad enough to invalidate multiple
  home-page system patterns
- note creation is therefore paying for both the new note itself and a full
  round of home-page index/grid recomputation

### Timed Diagnosis Example

Running `commontools.rt.detectNonIdempotent(3000)` during the same interaction
returned:

```json
{
  "nonIdempotent": [],
  "cycles": [],
  "duration": 3001.6,
  "busyTime": 1062.4
}
```

Interpretation:

- the scheduler was busy for about 35% of the 3-second window
- the interaction was expensive enough to register as real churn
- the churn was not explained by non-idempotent actions or causal cycles
- this points back to broad scheduler fan-out and repeated settle work

### Debug Log Example

The most useful observations from temporary `scheduler` debug logging were:

- a note-piece change matched `36` registered actions and triggered `13` to
  `15` actions
- a space-home change matched `61` registered actions
- the note computation from `api/patterns/notes/note.tsx:1:23` appeared
  repeatedly in `schedule-trigger`
- the generic worker entry action
  `raw:async http://localhost:8000/scripts/worker-runtime.js:287823:16`
  repeatedly re-ran and re-subscribed

That pattern matched a fan-out wave:

1. write arrives
2. many subscriptions match
3. computations rerun
4. subscriptions are rebuilt
5. new writes trigger the next pass

## Status

This document is meant to stay live as the debugging guide for settle-wave
investigations. The example section should evolve as new instrumentation lands.
