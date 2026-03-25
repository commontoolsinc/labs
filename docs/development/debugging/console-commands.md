# Browser Console Commands

The runtime registers debugging utilities on `globalThis.commonfabric` for
interactive use in the browser console. These work on the **main thread** — for
worker-side data, use the debugger UI or the IPC methods on `RuntimeClient`.

## Logger Access

```javascript
// List all registered loggers (by module name)
Object.keys(commonfabric.logger)

// Access a specific logger
commonfabric.logger["runner"]
commonfabric.logger["runtime-client"]
```

## Enabling / Disabling Loggers

```javascript
// Disable a noisy logger
commonfabric.logger["runner"].disabled = true

// Re-enable it
commonfabric.logger["runner"].disabled = false

// Set log level (only messages at this level or above are emitted)
commonfabric.logger["runner"].level = "debug"   // show everything
commonfabric.logger["runner"].level = "warn"    // only warn + error
```

## Counts

```javascript
// Total log calls across all loggers
commonfabric.getTotalLoggerCounts()

// Breakdown by logger name and message key
commonfabric.getLoggerCountsBreakdown()
// {
//   "runner": {
//     "validate-input": { debug: 0, info: 42, warn: 3, error: 0, total: 45 },
//     total: 45
//   },
//   total: 45
// }

// Counts for a single logger
commonfabric.logger["runner"].counts
// { debug: 0, info: 42, warn: 3, error: 0, total: 45 }

// Counts by message key for a single logger
commonfabric.logger["runner"].countsByKey

// Reset all counts
commonfabric.resetAllLoggerCounts()

// Reset counts for a single logger
commonfabric.logger["runner"].resetCounts()
```

## Timing

```javascript
// Timing stats across all loggers, grouped by logger name
commonfabric.getTimingStatsBreakdown()
// {
//   "runtime-client": {
//     "ipc": { count: 2415, min: 0.1, max: 45.2, average: 1.9, p50: 1.5, p95: 6.8, ... },
//     "ipc/CellGet": { count: 1523, ... }
//   }
// }

// Timing stats for a single logger
commonfabric.logger["runtime-client"].timeStats

// Stats for a specific key path
commonfabric.logger["runtime-client"].getTimeStats("ipc/CellGet")
// { count, min, max, average, p50, p95, lastTime, lastTimestamp, cdf, ... }

// Reset all timing stats
commonfabric.resetAllTimingStats()
```

## Baselines (Measuring Deltas)

Baselines snapshot current counts and timing so you can measure what happens
during a specific interaction:

```javascript
// Set baselines for all loggers
commonfabric.resetAllCountBaselines()
commonfabric.resetAllTimingBaselines()

// ... perform the interaction you want to measure ...

// Check deltas since baseline
commonfabric.logger["runner"].getCountDeltas()
// { debug: 2, info: 15, warn: 0, error: 0, total: 17 }

// Timing CDF since baseline is in each stat's .cdfSinceBaseline field
commonfabric.logger["runtime-client"].getTimeStats("ipc").cdfSinceBaseline
```

## Flags

Flags track named boolean state per ID (e.g. which actions have invalid inputs):

```javascript
// Active flags across all loggers
commonfabric.getLoggerFlagsBreakdown()
// {
//   "runner": {
//     "action invalid input": {
//       "action:myModule": { schema: {...}, raw: {...}, queryResult: "..." }
//     }
//   }
// }

// Flags for a single logger
commonfabric.logger["runner"].flags
```

## Main Thread vs Worker

These console commands access loggers on the **main thread** only. The runner and
most runtime code runs in a web worker, so its loggers are in a separate
`globalThis`. To access worker-side data:

- **Debugger UI**: Open the debugger panel and use the Logger and Scheduler tabs
  to view worker counts, timing, and flags.
- **IPC via `commonfabric.rt`**: The `RuntimeClient` is exposed on
  `commonfabric.rt` for console access:

```javascript
// Fetch worker counts, timing, and flags
await commonfabric.rt.getLoggerCounts()

// Control worker loggers
await commonfabric.rt.setLoggerLevel("debug")         // all loggers
await commonfabric.rt.setLoggerLevel("debug", "runner") // specific logger
await commonfabric.rt.setLoggerEnabled(true)            // enable all
await commonfabric.rt.setLoggerEnabled(false, "runner") // disable one

// Focus on nested piece/materialization runs
await commonfabric.rt.setLoggerEnabled(true, "runner.trigger-flow")
await commonfabric.rt.setLoggerLevel("debug", "runner.trigger-flow")

// Focus on wish() branch choice and query resolution
await commonfabric.rt.setLoggerEnabled(true, "runner.wish-flow")
await commonfabric.rt.setLoggerLevel("debug", "runner.wish-flow")

// See which raw stack frame was sampled for action/module labels
await commonfabric.rt.setLoggerEnabled(true, "builder.source-location")
await commonfabric.rt.setLoggerLevel("debug", "builder.source-location")
```

## Worker Settle Stats

Capture per-`execute()` settle-loop stats from the worker scheduler:

```javascript
// Enable settle stats collection
await commonfabric.rt.setSettleStatsEnabled(true)

// Inspect the most recent execute() settle data
await commonfabric.rt.getSettleStats()
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
await commonfabric.rt.setSettleStatsEnabled(false)
```

If you need the recent wave sequence rather than just the last settle result,
read the bounded history buffer:

```javascript
await commonfabric.rt.setSettleStatsEnabled(true)
await commonfabric.rt.getSettleStatsHistory()
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
await commonfabric.rt.setSettleStatsEnabled(true)

globalThis.__settleSamples = []
globalThis.__lastSettleSig = null
globalThis.__settlePoll = setInterval(() => {
  void commonfabric.rt.getSettleStats().then((stats) => {
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
await commonfabric.rt.setActionRunTraceEnabled(false)
await commonfabric.rt.setActionRunTraceEnabled(true)

// ... perform the interaction ...

await commonfabric.rt.idle()
const trace = await commonfabric.rt.getActionRunTrace()
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
const trace = await commonfabric.rt.getActionRunTrace()
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
await commonfabric.rt.setActionRunTraceEnabled(false)
```

## Worker Trigger Trace

Capture structured change-to-action scheduling data from the worker scheduler:

```javascript
// Reset and enable trigger tracing
await commonfabric.rt.setTriggerTraceEnabled(false)
await commonfabric.rt.setTriggerTraceEnabled(true)

// ... perform the interaction ...

// Read the bounded ring buffer
const trace = await commonfabric.rt.getTriggerTrace()
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
const trace = await commonfabric.rt.getTriggerTrace()
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
await commonfabric.rt.setTriggerTraceEnabled(false)
```

## Non-Idempotent Detection

Diagnose non-settling scheduler behavior and find non-idempotent actions. See
[Non-Idempotent Detection](non-idempotent-detection.md) for a full guide.

```javascript
// Run diagnosis for 5 seconds (default), prints table + returns result
await commonfabric.detectNonIdempotent()

// Custom duration
await commonfabric.detectNonIdempotent(10000)

// Inspect the result
const result = await commonfabric.detectNonIdempotent(3000)
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
await commonfabric.rt.detectNonIdempotent(5000)
```

## VDOM Debug Helpers

Inspect the VDOM tree structure and applicator state. See
[VDOM Debug Helpers](vdom-debug.md) for full documentation.

```javascript
// List all active renderings
commonfabric.vdom.renders()

// Pretty-print the VDOM tree
await commonfabric.vdom.dump()

// Get the raw VDOM tree object (children expanded, props as CellHandles)
await commonfabric.vdom.tree()

// Node/listener counts per renderer
commonfabric.vdom.stats()

// Look up a DOM node by applicator node ID
commonfabric.vdom.nodeForId(1)

// Target a specific render by index or container element
await commonfabric.vdom.dump(0)
await commonfabric.vdom.dump(document.querySelector('#my-container'))

// Raw access to the active renders registry
commonfabric.vdom.registry
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
await commonfabric.readCell()

// Read a nested path
await commonfabric.readCell({ path: ["children", "1", "props", "variant"] })

// Read a specific piece in a specific space
await commonfabric.readCell({
  space: "did:key:z6Mkm...",
  did: "baedrei...",
  path: ["$UI"]
})

// Read a trigger-trace entity directly using its full id
await commonfabric.readCell({
  space: "did:key:z6Mkm...",
  id: "of:baedrei..."
})
```

### readArgumentCell

Same as `readCell` but automatically prepends `"argument"` to the path,
reading from the piece's input/argument cell.

```javascript
// Read the piece's argument data
await commonfabric.readArgumentCell()

// Read a nested argument field
await commonfabric.readArgumentCell({ path: ["name"] })
```

### subscribeToCell

Subscribe to live updates on a cell. Logs timestamped values to the console
on every change. Returns a cancel function.

```javascript
// Subscribe to the full output
const cancel = commonfabric.subscribeToCell()
// Console: [debug] cell update [2025-08-10T...]: { $NAME: "My Piece", ... }

// Subscribe to a specific path (e.g. a variant prop deep in the vdom)
const cancelVariant = commonfabric.subscribeToCell({
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
await commonfabric.explainTriggerTrace()

// Focus on broad root writes only
await commonfabric.explainTriggerTrace({ rootOnly: true })

// Limit how many hot changes are resolved
await commonfabric.explainTriggerTrace({ limit: 5 })

// Include the full current values in the returned result
await commonfabric.explainTriggerTrace({ includeCurrentValue: true })
```

This helper:

- groups `commonfabric.rt.getTriggerTrace()` by exact `space/entity/path`
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
await commonfabric.watchWrites({
  space: commonfabric.space,
  path: [],
  match: "exact",
  label: "root writes in current space"
})

// ... perform the interaction ...

const trace = await commonfabric.getWriteStackTrace()
trace.slice(-5)
```

To watch one specific changed cell from trigger trace:

```javascript
await commonfabric.watchWrites({
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
await commonfabric.rt.setLoggerEnabled(true, "storage.write-trace")
await commonfabric.rt.setLoggerLevel("warn", "storage.write-trace")
```

Disable the watcher and clear the buffer by passing an empty matcher list:

```javascript
await commonfabric.watchWrites([])
```

### Agent-Browser Usage

These utilities work well with `agent-browser eval` for automated debugging:

```bash
# Check if utils are available
agent-browser eval "typeof commonfabric.readCell"

# Read a cell (wrap in async IIFE since eval doesn't support top-level await)
agent-browser eval "(async () => {
  const v = await commonfabric.readCell();
  return JSON.stringify(v).slice(0, 500);
})()"

# Subscribe, interact, check console
agent-browser eval "window._cancel = commonfabric.subscribeToCell()"
agent-browser click @e5
agent-browser console  # Check for "[debug] cell update" entries
agent-browser eval "window._cancel()"
```

## Quick Reference

| Command | Description |
|---------|-------------|
| `commonfabric.logger["name"]` | Access a specific logger |
| `.disabled = true/false` | Enable/disable a logger |
| `.level = "debug"` | Set minimum log level |
| `.counts` | Get call counts |
| `.countsByKey` | Counts broken down by message key |
| `.timeStats` | All timing statistics |
| `.flags` | Active flags with metadata |
| `.resetCounts()` | Reset this logger's counts |
| `commonfabric.getTotalLoggerCounts()` | Total calls across all loggers |
| `commonfabric.getLoggerCountsBreakdown()` | Counts by logger and key |
| `commonfabric.getTimingStatsBreakdown()` | Timing by logger and key |
| `commonfabric.getLoggerFlagsBreakdown()` | Flags by logger |
| `commonfabric.resetAllLoggerCounts()` | Reset all counts |
| `commonfabric.resetAllTimingStats()` | Reset all timing |
| `commonfabric.resetAllCountBaselines()` | Set count baselines |
| `commonfabric.resetAllTimingBaselines()` | Set timing baselines |
| `commonfabric.rt` | RuntimeClient for worker IPC |
| `commonfabric.rt.setLoggerLevel(lvl, name?)` | Set worker logger level |
| `commonfabric.rt.setLoggerEnabled(on, name?)` | Enable/disable worker logger |
| `commonfabric.rt.getLoggerCounts()` | Get worker logger counts/timing/flags |
| `commonfabric.rt.setSettleStatsEnabled(on)` | Enable/disable worker settle stats |
| `commonfabric.rt.getSettleStats()` | Get the last worker settle stats payload |
| `commonfabric.rt.getSettleStatsHistory()` | Get recent worker settle stats history |
| `commonfabric.rt.setActionRunTraceEnabled(on)` | Enable/disable exact action-run tracing |
| `commonfabric.rt.getActionRunTrace()` | Get recent exact action-run entries |
| `commonfabric.rt.setTriggerTraceEnabled(on)` | Enable/disable worker trigger tracing |
| `commonfabric.rt.getTriggerTrace()` | Get recent worker trigger-trace entries |
| `commonfabric.rt.setWriteStackTraceMatchers(matchers)` | Watch matched transaction writes and clear old entries |
| `commonfabric.rt.getWriteStackTrace()` | Get recent transaction write stack traces |
| `commonfabric.vdom.renders()` | List active renderings |
| `commonfabric.vdom.tree(el?)` | Raw VDOM tree object |
| `commonfabric.vdom.dump(el?)` | Pretty-print VDOM tree |
| `commonfabric.vdom.stats()` | Node/listener counts per renderer |
| `commonfabric.vdom.nodeForId(id, el?)` | Look up DOM node by ID |
| `commonfabric.vdom.registry` | Raw active renders registry |
| `commonfabric.readCell(opts?)` | Read piece output cell (async) |
| `commonfabric.readArgumentCell(opts?)` | Read piece argument cell (async) |
| `commonfabric.subscribeToCell(opts?)` | Subscribe to cell updates, returns cancel fn |
| `commonfabric.watchWrites(opts?)` | Arm transaction write-stack tracing for matched writes |
| `commonfabric.getWriteStackTrace()` | Read captured transaction write stacks |
| `commonfabric.explainTriggerTrace(opts?)` | Group and annotate hot trigger-trace changes |
| `commonfabric.space` | Current space DID |
| `commonfabric.detectNonIdempotent(ms?)` | Run non-idempotent diagnosis (default 5s) |
| `commonfabric.rt.detectNonIdempotent(ms?)` | Same, via RuntimeClient IPC |
