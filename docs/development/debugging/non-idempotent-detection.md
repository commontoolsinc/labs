# Detecting Non-Idempotent Computations

Patterns define reactive computations (`computed`, `lift`, `derive`) that must
be **idempotent**: given the same inputs, they must produce the same outputs.
When they don't, the scheduler re-runs them repeatedly because each run produces
new writes that trigger further runs. This manifests as the UI churning, high
CPU usage, and the system never reaching a stable state.

Common causes:

- A `computed()` that calls `.set()` on a `Writable<>` with a value derived
  from non-deterministic sources (e.g. `Date.now()`, `Math.random()`,
  `crypto.randomUUID()`)
- Converting a `Set` to an array where iteration order varies between runs
- Appending to an array on each execution instead of replacing it
- Two actions forming a cycle: A writes cell X which triggers B, B writes
  cell Y which triggers A

## Quick Start (Browser Console)

The fastest way to check for non-idempotent actions:

```javascript
// Run diagnosis for 5 seconds (default)
await commontools.detectNonIdempotent()

// Run for a custom duration
await commontools.detectNonIdempotent(10000) // 10 seconds
```

This prints a table of non-idempotent actions and any cycles found, then returns
the full result object.

## How It Works

The detection system has three layers:

### 1. Non-Settling Heuristic (Always On)

The scheduler tracks how much time it spends in `execute()` within a sliding
window. When the busy-time ratio exceeds 30% over 5+ seconds, it emits a
`scheduler.non-settling` telemetry marker. This is cheap (~zero overhead) and
runs continuously.

The debugger UI shows this state automatically. You can also query it
programmatically:

```javascript
// Check if the scheduler currently appears to be churning
// (via RuntimeClient IPC — this reads worker-side state)
await commontools.rt.request({
  type: "runtime:detectNonIdempotent",
  durationMs: 3000
})
```

### 2. Idempotency Diagnosis (On-Demand)

When triggered, the scheduler records read and write snapshots for every action
that runs during the diagnosis window. After each action run, it compares the
current snapshot to previous runs of the same action: if the reads are identical
but the writes differ, the action is **non-idempotent**.

The result includes:

- **`actionId`**: Which action is non-idempotent
- **`differingWriteKeys`**: Which cell paths produced different values
- **`runs`**: The actual read and write values for each recorded run (useful for
  understanding *why* the output changed)

### 3. Cycle Detection (On-Demand)

During the diagnosis window, the scheduler also tracks causal edges: when action
A writes to a cell that triggers action B, that's an edge `A -> B`. After the
window closes, a DFS finds all simple cycles in this directed graph.

A cycle means two or more actions form a loop where each one's writes trigger
the next. Even if each action is individually idempotent, a cycle prevents the
system from settling.

## Using the Console API

### Basic Usage

```javascript
// Default: 5-second diagnosis window
const result = await commontools.detectNonIdempotent()
```

Output looks like:

```
┌─────────┬──────────────────────┬───────────────────────────┐
│ (index) │ action               │ differingWrites           │
├─────────┼──────────────────────┼───────────────────────────┤
│ 0       │ "action:myPattern:3" │ "space/entity/items"      │
└─────────┴──────────────────────┴───────────────────────────┘
Cycles: []
```

### Inspecting the Full Result

The returned object has the complete diagnosis:

```javascript
const result = await commontools.detectNonIdempotent(3000)

// Non-idempotent actions
for (const report of result.nonIdempotent) {
  console.log("Action:", report.actionId)
  console.log("Differing writes:", report.differingWriteKeys)

  // Compare the actual values across runs
  for (const run of report.runs) {
    console.log("  Run at", run.timestamp)
    console.log("    Reads:", run.reads)
    console.log("    Writes:", run.writes)
  }
}

// Causal cycles
for (const cycle of result.cycles) {
  const chain = cycle.cycle
    .map(c => `${c.actionId} --[${c.writesCell}]-->`)
    .join(" ")
  console.log("Cycle:", chain)
}

// How long the scheduler was busy during the window
console.log(`Busy time: ${result.busyTime}ms / ${result.duration}ms`)
```

### Result Shape

```typescript
interface SchedulerDiagnosisResult {
  nonIdempotent: NonIdempotentReport[];
  cycles: CycleReport[];
  duration: number;   // total wall-clock time of diagnosis window (ms)
  busyTime: number;   // time scheduler spent executing actions (ms)
}

interface NonIdempotentReport {
  actionId: string;
  actionInfo?: { patternName?: string; moduleName?: string };
  runs: {
    timestamp: number;
    reads: Record<string, unknown>;   // cell path -> value
    writes: Record<string, unknown>;  // cell path -> value
  }[];
  differingWriteKeys: string[];       // which write paths differed
}

interface CycleReport {
  cycle: { actionId: string; writesCell: string }[];
  timestamp: number;
}
```

## Using the Debugger UI

1. Open the debugger panel (click the bug icon in the shell header)
2. Go to the **Diagnosis** tab
3. Select a duration (3s, 5s, or 10s)
4. Click **Run Diagnosis**
5. Wait for results — a spinner shows while diagnosis is active

The results section shows:

- **Non-Idempotent Actions**: a table listing each action and which writes
  differed. Click an action to expand and see the actual read/write values from
  each run.
- **Causal Cycles**: a visual chain showing the cycle path
  (e.g. `A --[cell X]--> B --[cell Y]--> A`)

## Using the RuntimeClient API

For programmatic access (e.g. from tests or tooling):

```typescript
import { RuntimeClient } from "@commontools/runtime-client";

const result = await runtimeClient.detectNonIdempotent(5000);
if (result.nonIdempotent.length > 0) {
  console.warn("Non-idempotent actions detected:", result.nonIdempotent);
}
```

## Common Patterns That Cause Non-Idempotency

### Set-to-Array Ordering

```typescript
// BAD: Set iteration order can vary between identical inputs
const uniqueTags = computed(() => {
  const set = new Set(items.map(i => i.tag));
  tags.set([...set]); // order may differ each run
});

// GOOD: Sort after converting
const uniqueTags = computed(() => {
  const set = new Set(items.map(i => i.tag));
  tags.set([...set].sort());
});
```

### Timestamps or Random Values in computed()

```typescript
// BAD: Different output every run
const enriched = computed(() => {
  return items.map(i => ({ ...i, updatedAt: Date.now() }));
});

// GOOD: Use timestamps only in handlers (event-driven, not reactive)
const updateItem = handler<{}, { item: Item }>((_, { item }) => {
  item.updatedAt.set(Date.now());
});
```

### Appending Instead of Replacing

```typescript
// BAD: Grows on every re-run
const log = computed(() => {
  entries.set([...entries.get(), newEntry]);
});

// GOOD: Derive the full value, don't append
const allEntries = computed(() => {
  return [...baseEntries, derivedEntry];
});
```

### Writing to a Writable Inside computed()

```typescript
// BAD: Side-effecting computed — if the write triggers re-reads, it cycles
const derived = computed(() => {
  const value = expensiveCalculation(input);
  output.set(value); // triggers subscribers, which may re-trigger this
  return value;
});

// GOOD: Return the value; let the system propagate it
const derived = computed(() => {
  return expensiveCalculation(input);
});
```

## For AI Agents

When debugging a pattern that appears to be churning or causing high CPU:

1. Start local dev servers (`deno task dev-local` from repo root)
2. Open the browser console
3. Run `await commontools.detectNonIdempotent(5000)`
4. Check `result.nonIdempotent` — the `differingWriteKeys` tell you which cell
   paths are producing different values on re-runs
5. Check `result.cycles` — if present, two or more actions are triggering each
   other in a loop
6. Look at the `runs` array on each report to compare the actual read/write
   values and understand *why* the output differs
7. Fix the pattern: sort non-deterministic collections, avoid timestamps in
   `computed()`, don't `.set()` into a `Writable<>` from inside `computed()`
   unless the value is guaranteed stable

## See Also

- [Console Commands](./console-commands.md) — full `commontools.*` reference
- [Reactivity Issues](./reactivity-issues.md) — common reactivity problems
- [Performance](./performance.md) — handler and computed performance tips
- [@reactivity](../../common/concepts/reactivity.md) — reactivity system fundamentals
