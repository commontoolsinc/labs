# Reactivity

This document specifies how changes propagate through the system.

## Status

Draft — based on codebase investigation. This document primarily describes the
current implementation.

---

## Current State

### Overview

The reactivity system connects data changes to computation. When cell values
change, dependent handlers and computed values re-execute.

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

The callback fires when the cell's value changes. Internally, this creates an
action that the scheduler manages.

For stream cells:
```typescript
const cancel = stream.sink((event) => {
  console.log("Event received:", event);
});
```

The callback fires for each event. Implementation differs: stream sinks add to
a local listener set rather than using scheduler-managed actions.

#### `pull()` — Read with Dependency Tracking

```typescript
const value = await cell.pull();
```

Creates a temporary effect action, registers dependencies, waits for idle, then
resolves. Used for one-shot reads that should trigger if dependencies change.

### Event Dispatch

When `stream.send(event)` is called:

1. Event converted to links via `convertCellsToLinks()`
2. `scheduler.queueEvent(streamLink, event)` called
3. Scheduler iterates `eventHandlers` array
4. Handlers matching the stream link are invoked

```typescript
// In scheduler
for (const [link, handler] of this.eventHandlers) {
  if (areNormalizedLinksSame(link, eventLink)) {
    this.eventQueue.push({ action: (tx) => handler(tx, event), ... });
  }
}
```

### Lazy Piece Loading

When an event arrives but no handler is registered:

1. `ensurePieceRunning(runtime, eventLink)` is called
2. Traverse `sourceCell` chain to find the process cell
3. Read `TYPE` (recipe ID) and `resultRef` from process cell
4. Load the recipe via `recipeManager.loadRecipe()`
5. Start the piece via `runtime.runSynced()`
6. Re-queue the event

This enables pieces to start on-demand when events arrive.

### The Source Cell Chain

Cells are linked in an ownership hierarchy:

```
resultCell ←─sourceCell─→ processCell
                              │
                              ├─ TYPE (recipe ID)
                              └─ resultRef → resultCell
```

This chain enables:
- Finding which recipe governs a cell
- Lazy piece loading (traverse to find owner)
- Schema resolution (inherit from source)

### Handler Registration

Handlers are registered when recipes run:

```typescript
scheduler.addEventHandler(handler, streamLink, populateDependencies);
```

Returns a cancel function. The handler is stored in an in-memory array, not
persisted. On piece restart, handlers re-register.

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

If cells are unified via timestamps (see [Cells](./3-cells.md)), change detection
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

**Previous:** [Transactions](./4-transactions.md) | **Next:** [Schemas](./6-schemas.md)
