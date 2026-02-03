# Storage Format

This document specifies how space data is represented on disk and in databases.

## Status

Draft — based on codebase investigation and discussion.

## Fact Structure

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

## Process Cells

A special category of fact stores execution metadata:

```
{
  TYPE: string,           // recipe/function content ID
  resultRef: SigilLink,   // link to the result cell
  argument: any           // input data
}
```

Process cells enable:
- Identifying which recipe governs a piece
- Lazy loading of pieces when events arrive
- Traversing the ownership graph via `sourceCell` chains

## Encoding Formats

### Current State

The system currently uses JSON for interchange and storage representation.

### Future Direction

CBOR is under consideration for storage and transmission, offering:
- Binary efficiency
- Well-specified encoding
- Native bytes support

**Open Question**: Should encoding details affect identity? Current thinking: no.
The identity hash should be computed over the abstract data structure, not the
encoded bytes. This allows format migration without breaking identities.

## The Stream Marker

Stream cells store a sentinel value rather than actual data:

```json
{ "$stream": true }
```

This marker:
- Persists in storage (streams have durable identity)
- Signals that the location is an event endpoint
- Is never used as actual input data — events flow through but aren't stored

**Open Question**: Is the `$stream` marker necessary, or could streams be
unified with value cells via timestamp-inclusive schemas? See [Cells](./cells.md)
for discussion of potential unification.

## Open Questions

- What is the database schema and indexing strategy?
- How is binary data handled (blobs, files)?
- What are the exact persistence semantics for the `cause` chain?
- How does compaction/garbage collection work?
