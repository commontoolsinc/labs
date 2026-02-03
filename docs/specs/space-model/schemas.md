# Schemas

This document specifies how data types are described and used.

## Status

Draft — based on codebase investigation and design discussion.

## Overview

Schemas describe the shape and type of data in cells. The system uses JSON
Schema as the description language, with extensions for cell-specific behavior.

## JSON Schema as Type Language

Standard JSON Schema properties are used:
- `type`: "string", "number", "boolean", "object", "array", "null"
- `properties`: object property schemas
- `items`: array element schema
- `default`: default value
- `required`: required properties

## Special Schema Properties

### `asCell`

Marks a property as a cell reference rather than inline data:

```json
{
  "type": "object",
  "properties": {
    "linkedItem": { "asCell": true, "type": "object" }
  }
}
```

### `asStream` (Current)

Marks a property as a stream endpoint:

```json
{
  "type": "object",
  "properties": {
    "onClick": { "asStream": true }
  }
}
```

This causes:
- Storage of `{ $stream: true }` marker
- Different runtime behavior (send vs set)
- Different change detection (every send triggers)

**Note**: This flag may be unnecessary if cells are unified via timestamps.
See discussion below.

### `default`

Provides default values:

```json
{
  "type": "object",
  "properties": {
    "count": { "type": "number", "default": 0 }
  }
}
```

## Schema-Driven Behavior

Schemas influence runtime behavior:
- **Validation**: Values are checked against schema on read/write
- **Transformation**: Schema-aware traversal resolves references
- **Cell creation**: `asCell` properties become cell references
- **Stream detection**: `asStream` properties get event semantics

## The Case Against `asStream`

The `asStream` flag encodes type information in a schema property rather than
in the data itself. This creates:
- Two parallel type systems (schema types + stream/cell bifurcation)
- Method duplication (get/set vs send)
- Runtime brand checking (isStream)

### Alternative: Timestamps in Schema

Instead of `asStream`, events could be data that includes timestamps:

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

The "event-ness" emerges from the data shape:
- Values with different timestamps are different values
- Change detection works normally
- No special flags or bifurcated runtime behavior

### What This Eliminates

- `asStream` flag
- `isStream()` / `isCell()` checks
- Separate Stream type
- Duplicated methods (send vs set)

### What This Requires

- Convention for timestamp fields
- Event producers include timestamps
- Or: system adds timestamps if schema indicates it

## Schema Resolution

Schemas can be:
- Explicitly provided when creating cells
- Inherited from source cells via `sourceCell.key("resultRef").get()?.schema`
- Inferred from values (limited)

The `asSchemaFromLinks()` method resolves schemas by following links.

## Open Questions

- Should `asStream` be removed in favor of timestamp-based events?
- How are schema migrations handled?
- What is the validation behavior on schema mismatch?
- How do schemas interact with the type system in pattern code?
- Should schemas be versioned?
