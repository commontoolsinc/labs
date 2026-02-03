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

#### Dataflow: Value Cells → Recipe → Result Cell

```
┌─────────────┐     ┌─────────────┐
│ input cell  │────>│             │     ┌─────────────┐
└─────────────┘     │   recipe    │────>│ result cell │
┌─────────────┐     │             │     └─────────────┘
│ input cell  │────>│             │
└─────────────┘     └─────────────┘
```

This is **pull-based / demand-driven** reactivity:
- Recipe declares dependencies on input cells
- When any input changes, the recipe re-executes
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
loading recipes and registering handlers.

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
2. Load the recipe and start the piece
3. Re-queue the event

This enables pieces to start on-demand when events arrive.

### The Source Cell Chain

Cells are linked in an ownership hierarchy:

```
resultCell ───source───> processCell
     ^                        │
     │                        ├─ TYPE (recipe ID)
     └────── resultRef ───────┘
```

The `source` property on a result cell points to its process cell. The process
cell's `resultRef` property points back to the result cell.

This chain enables:
- Finding which recipe governs a cell
- Lazy piece loading (traverse to find owner)
- Schema resolution (inherit from source)

### Handler Registration

Handlers are registered when recipes run. They are stored in memory (not
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

## Open Questions

- What is the exact scheduling algorithm (priority, ordering)?
- How are cycles in the dependency graph handled?
- What are the consistency guarantees during propagation?
- How does batching work for multiple simultaneous changes?
- What is the relationship between reactivity and transactions?

---

**Previous:** [Transactions](./5-transactions.md) | **Next:** [Schemas](./7-schemas.md)
