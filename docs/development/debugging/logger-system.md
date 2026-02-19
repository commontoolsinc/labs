# Logger System

The runtime uses a structured logging system (`@commontools/utils/logger`) across
all packages. Loggers are tagged by module name, support severity levels, and
track call counts, timing stats, and flags — all accessible at runtime.

## Creating a Logger

```typescript
import { getLogger } from "@commontools/utils/logger";

// Create a logger for your module (disabled by default, debug level)
const logger = getLogger("my-module", { enabled: false, level: "debug" });

// Log with a message key (first arg) for metrics tracking
logger.info("processing-started", "Processing started");
logger.debug("cache-hit", () => ["Cache hit for", userId]); // lazy eval
logger.warn("rate-limit", "API rate limit approaching");
logger.error("save-failed", "Failed to save user", error);
```

`getLogger` returns the same instance if called twice with the same module name.
All registered loggers are stored on `globalThis.commontools.logger`.

## Log Levels

Four levels in ascending severity: `debug`, `info`, `warn`, `error`.

A logger only emits messages at or above its configured level. The default level
is `info`.

```typescript
const logger = getLogger("verbose", { level: "debug" }); // show everything
logger.level = "warn"; // change at runtime — now only warn + error
```

In Deno, the `LOG_LEVEL` environment variable sets the default level for all
loggers that don't specify one explicitly.

## Enabling / Disabling Loggers

Each logger has a `disabled` property:

```typescript
const logger = getLogger("noisy-module", { enabled: false });
// ...later, turn it on:
logger.disabled = false;
// ...turn it off again:
logger.disabled = true;
```

When disabled, messages are suppressed but **counts still increment**. This lets
you track call volume even for silent loggers.

### Controlling Loggers from the Shell (IPC)

The shell's `RuntimeClient` exposes methods that reach into the worker. The
client is available on `globalThis.commontools.rt` for browser console access:

```javascript
// Set log level for a specific logger in the worker
await commontools.rt.setLoggerLevel("debug", "runner");

// Set log level for ALL loggers in the worker
await commontools.rt.setLoggerLevel("debug");

// Disable a specific logger in the worker
await commontools.rt.setLoggerEnabled(false, "runner");

// Enable all loggers in the worker
await commontools.rt.setLoggerEnabled(true);
```

These are used by the debugger UI but can also be called from the browser console
or application code when you have a `RuntimeClient` reference.

## Call Counts

Every log call increments a counter, even when the logger is disabled or the
message is filtered by level.

```typescript
logger.counts;       // { debug: 0, info: 5, warn: 1, error: 0, total: 6 }
logger.countsByKey;  // { "event-a": { debug: 0, info: 3, ... }, ... }
logger.resetCounts();
```

### Automatic Count Summaries

By default, a debug-level summary is emitted every 100 calls:

```
[DEBUG][my-module::12:34:56.789] my-module: 100 log calls made (debug: 20, info: 50, warn: 25, error: 5)
```

Configure or disable with `logCountEvery`:

```typescript
getLogger("chatty", { logCountEvery: 50 });  // every 50 calls
getLogger("quiet", { logCountEvery: 0 });    // disable summaries
```

## Timing

Loggers can track operation timing with reservoir-sampled percentiles:

```typescript
// Start/end pattern
logger.timeStart("cell", "get");
// ... operation ...
logger.timeEnd("cell", "get");

// Direct measurement
logger.time(startTimestamp, "ipc", "CellGet");

// Read stats
logger.getTimeStats("cell/get");
// { count, min, max, average, p50, p95, lastTime, cdf, ... }

logger.timeStats; // all timing stats for this logger
```

## Baselines

Baselines let you measure deltas — useful for profiling a specific interaction:

```typescript
// Snapshot current state as baseline
logger.resetCountBaseline();
logger.resetTimingBaseline();

// ... do some work ...

// Get deltas since baseline
logger.getCountDeltas(); // { debug: 2, info: 5, ... }
// Timing CDF since baseline is in: stats.cdfSinceBaseline
```

## Flags

Flags track named boolean state per ID, with optional metadata. They're used to
surface runtime conditions like "this action has invalid input":

```typescript
// Set a flag with metadata
logger.flag("action invalid input", "action:myModule", true, {
  schema: { type: "object" },
  raw: currentRawValue,
  queryResult: serializedResult,
});

// Clear the flag
logger.flag("action invalid input", "action:myModule", false);

// Read flags
logger.flags;
// { "action invalid input": { "action:myModule": { schema: ..., raw: ... } } }
```

The runner uses flags to track which actions currently have schema mismatches
(invalid arguments). These are surfaced in the debugger UI's "Data pending" tab.

## Global Functions

These operate across all registered loggers:

| Function | Description |
|----------|-------------|
| `getTotalLoggerCounts()` | Sum of all log calls across all loggers |
| `getLoggerCountsBreakdown()` | Counts by logger name and message key |
| `getTimingStatsBreakdown()` | Timing stats by logger name and key |
| `getLoggerFlagsBreakdown()` | Active flags by logger name |
| `resetAllLoggerCounts()` | Reset all logger counts to zero |
| `resetAllTimingStats()` | Reset all timing statistics |
| `resetAllCountBaselines()` | Set count baselines for all loggers |
| `resetAllTimingBaselines()` | Set timing baselines for all loggers |

All are importable from `@commontools/utils/logger` and also registered on
`globalThis.commontools` for browser console access. See
[console-commands](./console-commands.md) for interactive usage.
