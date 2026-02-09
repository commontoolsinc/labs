# Space Model Formal Spec: Data Model

This directory contains the formal specification for the Space Model data model.
It is derived from the proposal sections of the original
[data model spec](../space-model/1-data-model.md), reformulated as a
self-contained, implementable specification.

## Scope

This spec covers:

- **Storable values** -- the type system for all persistent and in-flight data
- **The storable protocol** -- how custom types participate in
  serialization/deserialization
- **Serialization contexts** -- boundary-crossing serialization strategy
- **JSON encoding** -- the wire format for special types over JSON
- **Canonical hashing** -- content-based identity for storable values

Out of scope: CRDT-based storage layer, network sync protocols, the reactive
system, schemas.

## Documents

- [1-storable-values.md](./1-storable-values.md) -- The complete data model
  specification covering storable value types, the storable protocol,
  serialization contexts, JSON encoding, and canonical hashing.

> **Note:** All topics listed in the scope above are covered in the single
> document `1-storable-values.md`.
