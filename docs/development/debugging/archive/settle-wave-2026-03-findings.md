# Settle-Wave Investigation — March 2026 Findings (Archive)

Dated findings from the March 2026 settle-wave investigation, split out of
[settle-wave-investigation.md](../settle-wave-investigation.md). The workflow
guide stays timeless; this file preserves the concrete measurements,
environments, and roadmap notes from that investigation. Environment names,
line numbers, and counts reflect the tree as of March 2026.

## Current Tooling Gap

The timed diagnosis mismatch is now resolved:

- `commonfabric.detectNonIdempotent(ms)` and
  `commonfabric.rt.detectNonIdempotent(ms)` now run a real diagnosis window
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

The hottest worker bundle locations mapped back to the then-current scheduler
and worker paths. In the current tree, start from these equivalent surfaces:

- `packages/runner/src/scheduler.ts`
- `packages/runner/src/scheduler/pull-execution.ts`
- `packages/runner/src/scheduler/push-execution.ts`
- `packages/runner/src/scheduler/events.ts`
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
| `scheduler.schedule-resubscribe` | 744 |
| `scheduler.schedule-unsubscribe` | 296 |
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
creation first used `commonfabric.rt.setSettleStatsEnabled(true)` plus a 25 ms
poller around the interaction. That showed that a single `getSettleStats()`
read was not enough because trailing settles could overwrite the interesting
wave.

That led to `commonfabric.rt.getSettleStatsHistory()`, which now captures the
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

Using `commonfabric.rt.getSettleStatsHistory()` around the original home-page
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
CF_CAPTURE_TRIGGER_TRACE=1 \
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
CF_CAPTURE_ACTION_RUN_SERIES=3 \
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
// Shown inside a pattern body.
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
// Shown inside a pattern body.
await commonfabric.rt.idle()
const { timing } = await commonfabric.rt.getLoggerCounts()
const graph = await commonfabric.rt.getGraphSnapshot()

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
// Shown inside a pattern body.
await commonfabric.watchWrites({
  space: commonfabric.space,
  path: [],
  match: "exact",
  label: "root writes in current space",
})
```

That interaction recorded `30` matched root writes. The dominant stack
signatures were:

- `Runner.setupInternal -> _CellImpl.setMetaRaw` result metadata (`5` writes)
- `Runner.setupInternal -> _CellImpl.setRawUntyped` (`5` writes through one
  setup branch and `5` through another)
- `diffAndUpdate -> applyChangeSet -> _CellImpl.set/_CellImpl.send` (`3`
  writes)

Representative stacks also showed:

- `handler:.../api/patterns/notes/note.tsx:1:23` on one note-page result
  metadata write
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
- each new cell commonly produces a pair of writes: one metadata marker and
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

Running `commonfabric.rt.detectNonIdempotent(3000)` during the same interaction
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
  repeatedly in trigger trace entries
- the generic worker entry action
  `raw:async http://localhost:8000/scripts/worker-runtime.js:287823:16`
  repeatedly re-ran and re-subscribed

That pattern matched a fan-out wave:

1. write arrives
2. many subscriptions match
3. computations rerun
4. subscriptions are rebuilt
5. new writes trigger the next pass

