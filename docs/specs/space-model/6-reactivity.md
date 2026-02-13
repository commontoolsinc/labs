# Reactivity

This document specifies how changes propagate through the system.

## Status

Draft — based on codebase investigation. This document primarily describes the
current implementation.

---

## Current State

### Overview

The reactivity system connects data changes to computation through two patterns:
**dataflow** (value changes propagate to dependent computations) and **events**
(occurrences trigger handlers). These patterns compose: events often write to
value cells, which then propagate through dataflow.

### Two Data Flow Patterns

The system supports two fundamental patterns of data flow:

#### Dataflow: Value Cells → Pattern → Result Cell

```
┌─────────────┐     ┌─────────────┐
│ input cell  │────>│             │     ┌─────────────┐
└─────────────┘     │   pattern    │────>│ result cell │
┌─────────────┐     │             │     └─────────────┘
│ input cell  │────>│             │
└─────────────┘     └─────────────┘
```

This is **pull-based / demand-driven** reactivity:
- Pattern declares dependencies on input cells
- When any input changes, the pattern re-executes
- Result cell receives the new computed value
- Like a spreadsheet: change a cell, dependent formulas update

The scheduler tracks dependencies and ensures consistent propagation.

#### Events: External Occurrence → Stream Cell → Handler

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  external   │────>│ stream cell │────>│   handler   │
│   event     │     │             │     │             │
└─────────────┘     └─────────────┘     └─────────────┘
```

This is **push-based / occurrence-driven** reactivity:
- External event (user click, API response, timer) arrives
- Event is sent to a stream cell
- Registered handlers are invoked with the event payload
- Like DOM events: something happens, listeners react

Handlers may write to value cells, bridging events into dataflow.

#### Bridging the Two Patterns

Events often produce state changes:

```
click event ──> stream ──> handler ──> writes to value cell ──> dataflow propagates
```

This is how user interactions flow through the system: an event triggers a
handler, which updates state, which causes dependent computations to re-run.

### Key Insight: The Graph Is Not Persisted

The reactive dependency graph is **reconstructed at runtime**, not stored
directly. What is persisted:

- Cell values (including stream markers)
- Process cell metadata (`TYPE`, `resultRef`)
- Ownership links (`sourceCell` chain)

From this persistent data, the system can reconstruct the dataflow graph by
loading patterns and registering handlers.

The dependency graph is also **dynamic and state-dependent**. Conditional
constructs like `ifElse(cond, left, right)` cause downstream nodes to react to
changes in `left` or `right` depending on the current value of `cond`. The
edges in the graph shift as state changes. This means the set of dependencies
for a given computation can only be known by actually running it.

### Subscription Mechanisms

#### `sink()` — Subscribe to Changes

For value cells:
```typescript
const cancel = cell.sink((value) => {
  console.log("Value changed:", value);
});
```

The callback fires when the cell's value changes.

For stream cells:
```typescript
const cancel = stream.sink((event) => {
  console.log("Event received:", event);
});
```

The callback fires for each event.

#### `pull()` — Read with Dependency Tracking

```typescript
const value = await cell.pull();
```

Used for one-shot reads with dependency tracking.

### Event Dispatch

When `stream.send(event)` is called:

1. Event is queued with the stream's link
2. Handlers registered for that stream are invoked

### Lazy Piece Loading

When an event arrives but no handler is registered:

1. Traverse `sourceCell` chain to find the process cell
2. Load the pattern and start the piece
3. Re-queue the event

This enables pieces to start on-demand when events arrive.

### The Source Cell Chain

Cells are linked in an ownership hierarchy:

```
resultCell ───source───> processCell
     ^                        │
     │                        ├─ TYPE (pattern ID)
     └────── resultRef ───────┘
```

The `source` property on a result cell points to its process cell. The process
cell's `resultRef` property points back to the result cell.

This chain enables:
- Finding which pattern governs a cell
- Lazy piece loading (traverse to find owner)
- Schema resolution (inherit from source)

### Handler Registration

Handlers are registered when patterns run. They are stored in memory (not
persisted) and re-register on piece restart.

### Change Detection

For value cells, change detection compares content:
- Same value written twice → no reaction
- Different value → dependents notified

For streams, every send triggers:
- Handler invoked for each event
- No content comparison

---

## Proposed Directions

### Unified Change Detection

If cells are unified via timestamps (see [Cells](./4-cells.md)), change detection
would naturally handle both cases via content comparison on timestamped data.
This would eliminate the special-casing for streams.

---

## Open Questions (Answered)

- ~~What is the exact scheduling algorithm?~~ Two implementations exist: **push**
  (eagerly executes all dirty nodes) and **pull** (only computes what is needed,
  driven by dirty effects registered via `.sink()` or `.pull()` calls). Both
  topologically sort the dirty nodes before execution.
- ~~How are cycles in the dependency graph handled?~~ Cycles are detected and
  re-executed in a tight loop with bounds. The expectation is that they converge
  quickly.
- ~~What are the consistency guarantees during propagation?~~ Effects (sinks)
  should only run once all computations are done, so they observe a consistent
  state. Exceptions exist for deliberate debouncing or threshold-based execution.
- ~~How does batching work for multiple simultaneous changes?~~ Each
  action/handler invocation is its own transaction. The transaction mechanism is
  used for marking dependencies dirty, which then triggers propagation.
- ~~What is the relationship between reactivity and transactions?~~ See above —
  the transaction commit is the event that marks dependencies dirty and triggers
  the reactive propagation cycle.

## Remaining Open Questions

- Should the last reads made by an action be persisted? This would allow
  reconstructing current dependency edges on load and determining dirtiness
  from changes without re-running the computation.
- How should deliberate debouncing and threshold-based execution be specified?

---

**Previous:** [Transactions](./5-transactions.md) | **Next:** [Schemas](./7-schemas.md)
