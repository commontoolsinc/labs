# Browser Console Commands

The runtime registers debugging utilities on `globalThis.commontools` for
interactive use in the browser console. These work on the **main thread** — for
worker-side data, use the debugger UI or the IPC methods on `RuntimeClient`.

## Logger Access

```javascript
// List all registered loggers (by module name)
Object.keys(commontools.logger)

// Access a specific logger
commontools.logger["runner"]
commontools.logger["runtime-client"]
```

## Enabling / Disabling Loggers

```javascript
// Disable a noisy logger
commontools.logger["runner"].disabled = true

// Re-enable it
commontools.logger["runner"].disabled = false

// Set log level (only messages at this level or above are emitted)
commontools.logger["runner"].level = "debug"   // show everything
commontools.logger["runner"].level = "warn"    // only warn + error
```

## Counts

```javascript
// Total log calls across all loggers
commontools.getTotalLoggerCounts()

// Breakdown by logger name and message key
commontools.getLoggerCountsBreakdown()
// {
//   "runner": {
//     "validate-input": { debug: 0, info: 42, warn: 3, error: 0, total: 45 },
//     total: 45
//   },
//   total: 45
// }

// Counts for a single logger
commontools.logger["runner"].counts
// { debug: 0, info: 42, warn: 3, error: 0, total: 45 }

// Counts by message key for a single logger
commontools.logger["runner"].countsByKey

// Reset all counts
commontools.resetAllLoggerCounts()

// Reset counts for a single logger
commontools.logger["runner"].resetCounts()
```

## Timing

```javascript
// Timing stats across all loggers, grouped by logger name
commontools.getTimingStatsBreakdown()
// {
//   "runtime-client": {
//     "ipc": { count: 2415, min: 0.1, max: 45.2, average: 1.9, p50: 1.5, p95: 6.8, ... },
//     "ipc/CellGet": { count: 1523, ... }
//   }
// }

// Timing stats for a single logger
commontools.logger["runtime-client"].timeStats

// Stats for a specific key path
commontools.logger["runtime-client"].getTimeStats("ipc/CellGet")
// { count, min, max, average, p50, p95, lastTime, lastTimestamp, cdf, ... }

// Reset all timing stats
commontools.resetAllTimingStats()
```

## Baselines (Measuring Deltas)

Baselines snapshot current counts and timing so you can measure what happens
during a specific interaction:

```javascript
// Set baselines for all loggers
commontools.resetAllCountBaselines()
commontools.resetAllTimingBaselines()

// ... perform the interaction you want to measure ...

// Check deltas since baseline
commontools.logger["runner"].getCountDeltas()
// { debug: 2, info: 15, warn: 0, error: 0, total: 17 }

// Timing CDF since baseline is in each stat's .cdfSinceBaseline field
commontools.logger["runtime-client"].getTimeStats("ipc").cdfSinceBaseline
```

## Flags

Flags track named boolean state per ID (e.g. which actions have invalid inputs):

```javascript
// Active flags across all loggers
commontools.getLoggerFlagsBreakdown()
// {
//   "runner": {
//     "action invalid input": {
//       "action:myModule": { schema: {...}, raw: {...}, queryResult: "..." }
//     }
//   }
// }

// Flags for a single logger
commontools.logger["runner"].flags
```

## Main Thread vs Worker

These console commands access loggers on the **main thread** only. The runner and
most runtime code runs in a web worker, so its loggers are in a separate
`globalThis`. To access worker-side data:

- **Debugger UI**: Open the debugger panel and use the Logger and Scheduler tabs
  to view worker counts, timing, and flags.
- **IPC via `commontools.rt`**: The `RuntimeClient` is exposed on
  `commontools.rt` for console access:

```javascript
// Fetch worker counts, timing, and flags
await commontools.rt.getLoggerCounts()

// Control worker loggers
await commontools.rt.setLoggerLevel("debug")         // all loggers
await commontools.rt.setLoggerLevel("debug", "runner") // specific logger
await commontools.rt.setLoggerEnabled(true)            // enable all
await commontools.rt.setLoggerEnabled(false, "runner") // disable one

// Focus on nested piece/materialization runs
await commontools.rt.setLoggerEnabled(true, "runner.trigger-flow")
await commontools.rt.setLoggerLevel("debug", "runner.trigger-flow")

// Focus on wish() branch choice and query resolution
await commontools.rt.setLoggerEnabled(true, "runner.wish-flow")
await commontools.rt.setLoggerLevel("debug", "runner.wish-flow")

// See which raw stack frame was sampled for action/module labels
await commontools.rt.setLoggerEnabled(true, "builder.source-location")
await commontools.rt.setLoggerLevel("debug", "builder.source-location")
```

## Worker Settle Stats

Capture per-`execute()` settle-loop stats from the worker scheduler:

```javascript
// Enable settle stats collection
await commontools.rt.setSettleStatsEnabled(true)

// Inspect the most recent execute() settle data
await commontools.rt.getSettleStats()
// {
//   iterations: [
//     {
//       workSetSize: 27,
//       orderSize: 27,
//       actionsRun: 27,
//       actions: [{ id, type }, ...],
//       durationMs: 348.4
//     },
//     ...
//   ],
//   totalDurationMs: 702.9,
//   settledEarly: true,
//   initialSeedCount: 0
// }

// Disable collection and clear the last captured value
await commontools.rt.setSettleStatsEnabled(false)
```

If you need the recent wave sequence rather than just the last settle result,
read the bounded history buffer:

```javascript
await commontools.rt.setSettleStatsEnabled(true)
await commontools.rt.getSettleStatsHistory()
// [
//   { recordedAt, stats: { ... } },
//   { recordedAt, stats: { ... } },
//   ...
// ]
```

`getSettleStats()` still returns only the **last** `execute()` call, so a
trailing empty settle pass can overwrite the interesting interaction. Prefer
`getSettleStatsHistory()` for note creation, reload, or navigation flows.

If you need live sampling while the interaction is still in progress, polling is
still useful:

```javascript
await commontools.rt.setSettleStatsEnabled(true)

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

## Worker Action Run Trace

Capture the exact action ids that actually ran during one interaction:

```javascript
// Reset and enable exact action-run tracing
await commontools.rt.setActionRunTraceEnabled(false)
await commontools.rt.setActionRunTraceEnabled(true)

// ... perform the interaction ...

await commontools.rt.idle()
const trace = await commontools.rt.getActionRunTrace()
trace.slice(-10)
```

Each trace entry contains:

- `recordedAt`
- `actionId`
- `actionType` (`"computation"` or `"effect"`)
- `parentActionId` when the scheduler knows the caller
- `durationMs`

To group by exact action id:

```javascript
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

To disable tracing and clear the ring buffer:

```javascript
await commontools.rt.setActionRunTraceEnabled(false)
```

## Worker Trigger Trace

Capture structured change-to-action scheduling data from the worker scheduler:

```javascript
// Reset and enable trigger tracing
await commontools.rt.setTriggerTraceEnabled(false)
await commontools.rt.setTriggerTraceEnabled(true)

// ... perform the interaction ...

// Read the bounded ring buffer
const trace = await commontools.rt.getTriggerTrace()
trace.slice(-5)
```

Each trace entry contains:

- the changed `space`, `entityId`, and `path`
- compact `before` / `after` value summaries
- the scheduling mode (`push` or `pull`)
- the source writer action id when available
- each directly triggered action, its scheduling decision, and any downstream
  scheduled effects

To find repeated actions quickly:

```javascript
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

To disable tracing and clear the buffer:

```javascript
await commontools.rt.setTriggerTraceEnabled(false)
```

## Non-Idempotent Detection

Diagnose non-settling scheduler behavior and find non-idempotent actions. See
[Non-Idempotent Detection](non-idempotent-detection.md) for a full guide.

```javascript
// Run diagnosis for 5 seconds (default), prints table + returns result
await commontools.detectNonIdempotent()

// Custom duration
await commontools.detectNonIdempotent(10000)

// Inspect the result
const result = await commontools.detectNonIdempotent(3000)
result.nonIdempotent   // actions with differing outputs for same inputs
result.cycles          // causal cycles (A -> B -> A)
result.busyTime        // ms the scheduler was busy during the window
result.duration        // total wall-clock duration of the diagnosis
```

This now runs a real timed diagnosis window in the worker. In the settle-wave
investigation, a 3-second note-creation window reported `busyTime` around
`1062 ms` with no non-idempotent actions or cycles.

The same functionality is available via `RuntimeClient`:

```javascript
await commontools.rt.detectNonIdempotent(5000)
```

## VDOM Debug Helpers

Inspect the VDOM tree structure and applicator state. See
[VDOM Debug Helpers](vdom-debug.md) for full documentation.

```javascript
// List all active renderings
commontools.vdom.renders()

// Pretty-print the VDOM tree
await commontools.vdom.dump()

// Get the raw VDOM tree object (children expanded, props as CellHandles)
await commontools.vdom.tree()

// Node/listener counts per renderer
commontools.vdom.stats()

// Look up a DOM node by applicator node ID
commontools.vdom.nodeForId(1)

// Target a specific render by index or container element
await commontools.vdom.dump(0)
await commontools.vdom.dump(document.querySelector('#my-container'))

// Raw access to the active renders registry
commontools.vdom.registry
```

## Cell Inspection

Read and subscribe to cell values directly from the console. These utilities
use `CellHandle` under the hood, so they go through the same IPC path as the
shell's own rendering. Useful for verifying what value is actually stored for
a piece, debugging reactivity issues, or watching values change in real time.

All three functions default `space` to the current shell space and `did` to
the piece ID from the URL bar (`/<spaceName>/<pieceId>`). Override any default
by passing an options object. If you already have a full trigger-trace entity
id such as `of:baedrei...`, pass it as `id`.

### readCell

Read the current value of a piece's output cell.

```javascript
// Read the full output of the current piece
await commontools.readCell()

// Read a nested path
await commontools.readCell({ path: ["children", "1", "props", "variant"] })

// Read a specific piece in a specific space
await commontools.readCell({
  space: "did:key:z6Mkm...",
  did: "baedrei...",
  path: ["$UI"]
})

// Read a trigger-trace entity directly using its full id
await commontools.readCell({
  space: "did:key:z6Mkm...",
  id: "of:baedrei..."
})
```

### readArgumentCell

Same as `readCell` but automatically prepends `"argument"` to the path,
reading from the piece's input/argument cell.

```javascript
// Read the piece's argument data
await commontools.readArgumentCell()

// Read a nested argument field
await commontools.readArgumentCell({ path: ["name"] })
```

### subscribeToCell

Subscribe to live updates on a cell. Logs timestamped values to the console
on every change. Returns a cancel function.

```javascript
// Subscribe to the full output
const cancel = commontools.subscribeToCell()
// Console: [debug] cell update [2025-08-10T...]: { $NAME: "My Piece", ... }

// Subscribe to a specific path (e.g. a variant prop deep in the vdom)
const cancelVariant = commontools.subscribeToCell({
  path: ["children", "1", "children", "0", "props", "variant"]
})

// Click buttons, observe updates...

// Clean up
cancelVariant()
```

### explainTriggerTrace

Group recent trigger-trace entries, resolve the hottest changed cells, and add
semantic summaries for the current values.

```javascript
await commontools.explainTriggerTrace()

// Focus on broad root writes only
await commontools.explainTriggerTrace({ rootOnly: true })

// Limit how many hot changes are resolved
await commontools.explainTriggerTrace({ limit: 5 })

// Include the full current values in the returned result
await commontools.explainTriggerTrace({ includeCurrentValue: true })
```

This helper:

- groups `commontools.rt.getTriggerTrace()` by exact `space/entity/path`
- counts direct action schedules and downstream scheduled effects
- reads the hottest changed cells through `CellHandle`
- annotates them with shape hints like `ui-result`, `runtime-process-cell`,
  `default-app-or-home-state`, and `index-state`

### watchWrites / getWriteStackTrace

Arm a transaction-level write watcher for exact or prefix-matched logical cell
paths, then inspect the captured stacks after the interaction.

For accumulation tests, keep the same space across runs instead of creating a
fresh one each time. In the integration harness, set `SPACE_NAME=...` so note
creation keeps adding to one existing space.

```javascript
// Watch all root writes in the current shell space
await commontools.watchWrites({
  space: commontools.space,
  path: [],
  match: "exact",
  label: "root writes in current space"
})

// ... perform the interaction ...

const trace = await commontools.getWriteStackTrace()
trace.slice(-5)
```

To watch one specific changed cell from trigger trace:

```javascript
await commontools.watchWrites({
  space: "did:key:z6Mkm...",
  id: "of:baedrei...",
  path: [],
  match: "exact",
  label: "default-app state"
})
```

Each recorded entry includes:

- the matched `space`, `entityId`, and logical `path`
- the match mode and optional label
- the written value kind
- the captured JavaScript stack at the transaction write callsite

Interpret repeated root writes in this order:

- `setup:setSourceCell`: initial result-cell to process-cell linkage
- `setup:setRawUntyped`: initial process-cell or result-cell materialization
- `raw:setRawUntyped`: raw builtin/helper rewriting a result cell directly

If you want immediate log output instead of post-hoc inspection, enable the
focused worker logger before replaying the interaction:

```javascript
await commontools.rt.setLoggerEnabled(true, "storage.write-trace")
await commontools.rt.setLoggerLevel("warn", "storage.write-trace")
```

Disable the watcher and clear the buffer by passing an empty matcher list:

```javascript
await commontools.watchWrites([])
```

### Agent-Browser Usage

These utilities work well with `agent-browser eval` for automated debugging:

```bash
# Check if utils are available
agent-browser eval "typeof commontools.readCell"

# Read a cell (wrap in async IIFE since eval doesn't support top-level await)
agent-browser eval "(async () => {
  const v = await commontools.readCell();
  return JSON.stringify(v).slice(0, 500);
})()"

# Subscribe, interact, check console
agent-browser eval "window._cancel = commontools.subscribeToCell()"
agent-browser click @e5
agent-browser console  # Check for "[debug] cell update" entries
agent-browser eval "window._cancel()"
```

## Quick Reference

| Command | Description |
|---------|-------------|
| `commontools.logger["name"]` | Access a specific logger |
| `.disabled = true/false` | Enable/disable a logger |
| `.level = "debug"` | Set minimum log level |
| `.counts` | Get call counts |
| `.countsByKey` | Counts broken down by message key |
| `.timeStats` | All timing statistics |
| `.flags` | Active flags with metadata |
| `.resetCounts()` | Reset this logger's counts |
| `commontools.getTotalLoggerCounts()` | Total calls across all loggers |
| `commontools.getLoggerCountsBreakdown()` | Counts by logger and key |
| `commontools.getTimingStatsBreakdown()` | Timing by logger and key |
| `commontools.getLoggerFlagsBreakdown()` | Flags by logger |
| `commontools.resetAllLoggerCounts()` | Reset all counts |
| `commontools.resetAllTimingStats()` | Reset all timing |
| `commontools.resetAllCountBaselines()` | Set count baselines |
| `commontools.resetAllTimingBaselines()` | Set timing baselines |
| `commontools.rt` | RuntimeClient for worker IPC |
| `commontools.rt.setLoggerLevel(lvl, name?)` | Set worker logger level |
| `commontools.rt.setLoggerEnabled(on, name?)` | Enable/disable worker logger |
| `commontools.rt.getLoggerCounts()` | Get worker logger counts/timing/flags |
| `commontools.rt.setSettleStatsEnabled(on)` | Enable/disable worker settle stats |
| `commontools.rt.getSettleStats()` | Get the last worker settle stats payload |
| `commontools.rt.getSettleStatsHistory()` | Get recent worker settle stats history |
| `commontools.rt.setActionRunTraceEnabled(on)` | Enable/disable exact action-run tracing |
| `commontools.rt.getActionRunTrace()` | Get recent exact action-run entries |
| `commontools.rt.setTriggerTraceEnabled(on)` | Enable/disable worker trigger tracing |
| `commontools.rt.getTriggerTrace()` | Get recent worker trigger-trace entries |
| `commontools.rt.setWriteStackTraceMatchers(matchers)` | Watch matched transaction writes and clear old entries |
| `commontools.rt.getWriteStackTrace()` | Get recent transaction write stack traces |
| `commontools.vdom.renders()` | List active renderings |
| `commontools.vdom.tree(el?)` | Raw VDOM tree object |
| `commontools.vdom.dump(el?)` | Pretty-print VDOM tree |
| `commontools.vdom.stats()` | Node/listener counts per renderer |
| `commontools.vdom.nodeForId(id, el?)` | Look up DOM node by ID |
| `commontools.vdom.registry` | Raw active renders registry |
| `commontools.readCell(opts?)` | Read piece output cell (async) |
| `commontools.readArgumentCell(opts?)` | Read piece argument cell (async) |
| `commontools.subscribeToCell(opts?)` | Subscribe to cell updates, returns cancel fn |
| `commontools.watchWrites(opts?)` | Arm transaction write-stack tracing for matched writes |
| `commontools.getWriteStackTrace()` | Read captured transaction write stacks |
| `commontools.explainTriggerTrace(opts?)` | Group and annotate hot trigger-trace changes |
| `commontools.space` | Current space DID |
| `commontools.detectNonIdempotent(ms?)` | Run non-idempotent diagnosis (default 5s) |
| `commontools.rt.detectNonIdempotent(ms?)` | Same, via RuntimeClient IPC |
