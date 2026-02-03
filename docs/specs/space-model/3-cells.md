# Cells

This document specifies cells — the fundamental unit of reactive state in the
system.

## Status

Draft — based on extensive codebase investigation and design discussion.

## Overview

A **cell** is a named location that holds a typed value. Cells are identified
by a link (entity ID + path) and participate in the reactive dataflow graph.

Cells can be categorized along two dimensions:

1. **Implementation mechanism**: How change detection works
   - Value cells (content-compared)
   - Stream cells (occurrence-based)

2. **Semantic role**: What purpose the cell serves
   - Process cells (execution metadata)
   - Precious data cells (irreplaceable):
     - User input (created/edited by user)
     - External input (fetched from outside, world has moved on)
   - Computed result cells (derived, reconstructible)
   - Stream cells (event endpoints)

---

## Current State

### Cell API

The Cell class exposes approximately 50 public methods. Investigation shows
that usage is stratified by layer:

#### Transaction Layer (~10 methods)

The narrow core used for data access:
- `get()`, `getRaw()` — read value (reactive)
- `sample()` — read value (non-reactive, no dependency tracking)
- `set()`, `setRaw()` — write value
- `update()`, `push()`, `remove()` — mutate
- `key()` — navigate to nested property
- `withTx()` — bind to transaction
- `asSchema()` — type cast

#### Reactivity Layer (adds ~3 methods)

Subscription and synchronization:
- `sink()` — subscribe to changes
- `pull()` — read with dependency tracking
- `sync()` — ensure synchronized with storage

#### Stream-Specific

- `send()` — dispatch event (only on streams)

#### Rarely Used Outside Foundation

Candidates for internal-only:
- `freeze()`, `isFrozen()`
- `setInitialValue()`, `setSelfRef()`
- `connect()`, `export()`
- `setSchema()` (deprecated)

### Implementation Mechanism: Value vs Stream

The implementation distinguishes cells by their change detection behavior:

| Aspect | Value Cell | Stream Cell |
|--------|------------|-------------|
| Stored value | Actual data | `{ $stream: true }` marker |
| Read | `get()` returns value | `get()` returns marker (not useful) |
| Write | `set()` stores value | `send()` dispatches event |
| Change detection | Content comparison | Every send is distinct |
| Persistence | Value persisted | Only marker persisted; events ephemeral |

The essential difference is **duplicate handling**:

- `cell.set(5); cell.set(5);` → one state, no second reaction (idempotent)
- `stream.send(5); stream.send(5);` → two events, two handler invocations

This is **state vs occurrence**:
- Value cells answer: "What is the current state?"
- Streams answer: "What just happened?"

### Semantic Categories

While the implementation sees only "value" and "stream," there are richer
semantic distinctions that matter for garbage collection, recovery, and UI:

#### Process Cells

Control plane metadata for piece execution:

```
{
  $TYPE: string,        // recipe ID
  resultRef: SigilLink, // link to result cell
  argument?: any,       // input data
  spell?: SigilLink,    // link to spell
  internal?: any        // working state
}
```

Process cells are implemented as value cells but serve a distinct purpose:
tracking which recipe governs a piece and linking to its result. See
[Storage Format](./1-storage-format.md) for details.

#### Precious Data Cells

Data that **cannot be reconstructed** from inputs. Two subtypes:

**User input**: Data created or edited directly by the user:
- Text they typed
- Selections they made
- Files they uploaded
- Manually curated content

Loss means losing the user's creative act, which cannot be replayed.

**External input**: Data fetched from outside the system:
- API responses (stock prices, weather, search results)
- Scraped web content
- Sensor readings at a point in time

Loss means the data is gone — the external world has moved on and won't
produce the same result again. Even "re-fetching" yields different data.

Both subtypes must be preserved. The system should never garbage-collect
precious data.

#### Computed Result Cells

Derived data produced by recipes from inputs:
- Pattern outputs
- Aggregations and transformations
- Cached computations

These **can be reconstructed** by re-running the recipe with the same inputs.
Persisting them is an optimization (avoid recomputation), not a requirement.
The system could potentially discard and recompute these during compaction.

#### Stream Cells

Event endpoints for occurrences:
- User interactions (clicks, input)
- External events
- Signals between pieces

Events are ephemeral — only the most recent matters for triggering handlers.
The `{ $stream: true }` marker persists to preserve the stream's identity,
but event payloads do not persist.

### Cross-Cutting Observations

- **Implementation vs semantics**: "Value cell" spans three semantic roles
  (process, precious, computed). The implementation doesn't distinguish them.
- **Reconstructibility**: The key semantic question is "can this be rebuilt?"
  Process and computed cells: yes. Precious and stream identity: no.
- **Identity mechanism**: All categories use the same `NormalizedFullLink`
  infrastructure for addressing and reactivity.

### Shared Identity Base

Regardless of cell type, all cells share:

- `entityId` — stable identifier
- `schema` — optional type information
- `getAsLink()` — serialization to `SigilLink`

The `toJSON()` method exists but is only called via generic duck-typed
serialization patterns, not cell-specific code.

---

## Proposed Directions

### Unification via Timestamps

If timestamps are an essential component of event data, the distinction
collapses:

```
stream.send(5) at t=1  →  {value: 5, timestamp: 1}
stream.send(5) at t=2  →  {value: 5, timestamp: 2}
```

These are content-distinct. Standard change detection handles it correctly.

#### The Unified Model

Instead of two cell types with different methods:
- One cell type
- Schema describes the data shape, including timestamps if event-like
- Change detection compares the whole value
- No special `asStream` flag needed

Example schema for an event location:
```json
{
  "type": "object",
  "properties": {
    "x": { "type": "number" },
    "y": { "type": "number" },
    "timestamp": { "type": "number" }
  }
}
```

The "event-ness" emerges from the data shape. Event producers include timestamps
(they know when things happened). No magic flags or bifurcated types.

#### What Unification Eliminates

- `asStream: true` flag
- Separate Stream type with duplicated methods
- `isStream()` / `isCell()` brand checking
- Special change-detection logic

#### What Unification Requires

- Clear convention for timestamp fields
- Possibly: schema-level indication of "where does the timestamp come from"
- Migration path for existing stream usages

#### Current State: No Timestamps

The current system does **not** add timestamps or unique IDs to events:
- `stream.send(event)` passes the payload directly to the scheduler
- DOM events have a `timeStamp` property, but `sanitizeEvent()` does not
  include it in the allowlist of properties passed through
- No deduplication or idempotency mechanism exists

For unification, timestamps would need to be injected somewhere — either at
the `send()` layer, in `sanitizeEvent()`, or by event producers explicitly.

#### Event Replay Consideration

Event replay (for debugging, testing, or recovery) is a related concern. For
replay to be possible, events would likely need unique markings anyway —
timestamps, sequence numbers, or IDs. This aligns with the unification
proposal: if events must be uniquely identifiable for replay, that same
identity makes them content-distinct for change detection.

---

## Open Questions

### Implementation Unification
- What is the migration path from current stream/cell split to unified model?
- How do existing `asStream: true` schemas translate?
- Should timestamps be required for events, or can the system add them?
- What are the exact semantics of "last event" queries on unified cells?
- How does the unified model affect the handler registration mechanism?

### Semantic Categories
- How should precious vs computed be distinguished in the data model?
- Should there be explicit markers, or is it inferred from the dataflow graph?
- What are the garbage collection / compaction rules for each category?
- How do semantic categories affect sync and backup strategies?

---

**Previous:** [Identity and References](./2-identity-and-references.md) | **Next:** [Transactions](./4-transactions.md)
