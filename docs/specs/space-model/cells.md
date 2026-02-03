# Cells

This document specifies cells — the fundamental unit of reactive state in the
system.

## Status

Draft — based on extensive codebase investigation and design discussion.

## Overview

A **cell** is a named location that holds a typed value. Cells are identified
by a link (entity ID + path) and participate in the reactive dataflow graph.

Currently, the system distinguishes two kinds of cells:
- **Value cells**: Store data, support get/set, trigger on value change
- **Stream cells**: Event endpoints, support send, trigger on every event

This document describes both the current state and a potential unification.

## Current Cell API

The Cell class exposes approximately 50 public methods. Investigation shows
that usage is stratified by layer:

### Transaction Layer (~8 methods)

The narrow core used for data access:
- `get()`, `getRaw()` — read value
- `set()`, `setRaw()` — write value
- `update()`, `push()`, `remove()` — mutate
- `key()` — navigate to nested property
- `withTx()` — bind to transaction
- `asSchema()` — type cast

### Reactivity Layer (adds ~3 methods)

Subscription and synchronization:
- `sink()` — subscribe to changes
- `pull()` — read with dependency tracking
- `sync()` — ensure synchronized with storage

### Stream-Specific

- `send()` — dispatch event (only on streams)

### Rarely Used Outside Foundation

Candidates for internal-only:
- `freeze()`, `isFrozen()`
- `setInitialValue()`, `setSelfRef()`
- `connect()`, `export()`
- `setSchema()` (deprecated)

## Value Cells vs Stream Cells

### Current Distinction

| Aspect | Value Cell | Stream Cell |
|--------|------------|-------------|
| Stored value | Actual data | `{ $stream: true }` marker |
| Read | `get()` returns value | `get()` returns marker (not useful) |
| Write | `set()` stores value | `send()` dispatches event |
| Change detection | Content comparison | Every send is distinct |
| Persistence | Value persisted | Only marker persisted; events ephemeral |

### The Essential Difference

The truly essential semantic difference is **duplicate handling**:

- `cell.set(5); cell.set(5);` → one state, no second reaction (idempotent)
- `stream.send(5); stream.send(5);` → two events, two handler invocations

This is **state vs occurrence**:
- Value cells answer: "What is the current state?"
- Streams answer: "What just happened?"

### Everything Else Is Implementation Choice

- **Persistence**: Computed cells cache for efficiency, not semantics
- **At-rest value**: Streams could cache last event without changing meaning
- **Identity mechanism**: Both use the same `NormalizedFullLink` infrastructure

## Potential Unification via Timestamps

If timestamps are an essential component of event data, the distinction
collapses:

```
stream.send(5) at t=1  →  {value: 5, timestamp: 1}
stream.send(5) at t=2  →  {value: 5, timestamp: 2}
```

These are content-distinct. Standard change detection handles it correctly.

### The Unified Model

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

### What Unification Eliminates

- `asStream: true` flag
- Separate Stream type with duplicated methods
- `isStream()` / `isCell()` brand checking
- Special change-detection logic

### What Unification Requires

- Clear convention for timestamp fields
- Possibly: schema-level indication of "where does the timestamp come from"
- Migration path for existing stream usages

## Shared Identity Base

Regardless of unification, all cells share:

- `entityId` — stable identifier
- `schema` — optional type information
- `getAsLink()` — serialization to `SigilLink`

The `toJSON()` method exists but is only called via generic duck-typed
serialization patterns, not cell-specific code.

## Open Questions

- What is the migration path from current stream/cell split to unified model?
- How do existing `asStream: true` schemas translate?
- Should timestamps be required for events, or can the system add them?
- What are the exact semantics of "last event" queries on unified cells?
- How does the unified model affect the handler registration mechanism?
