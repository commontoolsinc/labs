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
by passing an options object.

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
| `commontools.vdom.renders()` | List active renderings |
| `commontools.vdom.tree(el?)` | Raw VDOM tree object |
| `commontools.vdom.dump(el?)` | Pretty-print VDOM tree |
| `commontools.vdom.stats()` | Node/listener counts per renderer |
| `commontools.vdom.nodeForId(id, el?)` | Look up DOM node by ID |
| `commontools.vdom.registry` | Raw active renders registry |
| `commontools.readCell(opts?)` | Read piece output cell (async) |
| `commontools.readArgumentCell(opts?)` | Read piece argument cell (async) |
| `commontools.subscribeToCell(opts?)` | Subscribe to cell updates, returns cancel fn |
| `commontools.space` | Current space DID |
| `commontools.detectNonIdempotent(ms?)` | Run non-idempotent diagnosis (default 5s) |
| `commontools.rt.detectNonIdempotent(ms?)` | Same, via RuntimeClient IPC |
