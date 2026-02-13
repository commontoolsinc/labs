# Storage Format

This document specifies how space data is represented on disk and in databases.

## Status

Draft — based on codebase investigation and discussion.

---

## Current State

### Fact Structure

The fundamental unit of persistent data is a **fact**, structured as:

```
{
  the: MediaType,      // e.g., "application/json"
  of:  URI,            // entity identifier
  is:  Value,          // the actual data
  cause: Reference     // causal predecessor
}
```

The `is` field contains the value, which may include:
- Primitive data (strings, numbers, booleans, null)
- Nested objects and arrays
- References to other facts (via sigil links)
- Special markers (e.g., `{ $stream: true }` for stream endpoints)

### Process Cells

A special category of fact stores execution metadata:

```
{
  $TYPE: string,           // pattern/function content ID (serialized key is "$TYPE")
  resultRef: SigilLink,    // link to the result cell
  argument?: any,          // input data (optional)
  spell?: SigilLink,       // link to spell cell (optional)
  internal?: any           // working state storage (optional)
}
```

Process cells enable:
- Identifying which pattern governs a piece
- Lazy loading of pieces when events arrive
- Traversing the ownership graph via `sourceCell` chains

### Encoding Formats

The system currently uses JSON for interchange and storage representation.

### The Stream Marker

Stream cells store a sentinel value rather than actual data:

```json
{ "$stream": true }
```

This marker:
- Persists in storage (streams have durable identity)
- Signals that the location is an event endpoint
- Is never used as actual input data — events flow through but aren't stored

---

## Proposed Directions

### CBOR Encoding

CBOR is under consideration for storage and transmission, offering:
- Binary efficiency
- Well-specified encoding
- Native bytes support

**Note**: Encoding details should not affect identity. The identity hash should
be computed over the abstract data structure, not the encoded bytes. This allows
format migration without breaking identities.

### Stream Marker Elimination

The `$stream` marker may be unnecessary if streams are unified with value cells
via timestamp-inclusive schemas. See [Cells](./4-cells.md) for discussion of
potential unification.

## Open Questions

- What is the database schema and indexing strategy?
- How is binary data handled (blobs, files)?
- What are the exact persistence semantics for the `cause` chain?
- How does compaction/garbage collection work?

---

**Previous:** [Data Model](./1-data-model.md) | **Next:** [Identity and References](./3-identity-and-references.md)
