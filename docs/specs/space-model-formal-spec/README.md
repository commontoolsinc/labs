# Space Model Formal Spec: Data Model

This directory contains the formal specification for the Space Model data model.
It is derived from the proposal sections of the original
[data model spec](../space-model/1-data-model.md), reformulated as a
self-contained, implementable specification.

## Scope

This spec covers:

- **Storable values** (Sections 1-2) -- the type universe for all persistent and
  in-flight data, and the storable protocol (`[DECONSTRUCT]`/`[RECONSTRUCT]`)
  for custom type participation in serialization
- **Unknown types** (Section 3) -- forward-compatibility via `UnknownStorable`
- **Serialization contexts** (Section 4) -- boundary-crossing serialization
  strategy, the `serialize()`/`deserialize()` functions, and boundary inventory
- **JSON encoding** (Section 5) -- the `/<Type>@<Version>` wire format for
  special types, escaping, and detection rules
- **Canonical hashing** (Section 6) -- content-based identity for storable
  values
- **Implementation guidance** (Section 7) -- migration from legacy formats

Out of scope: CRDT-based storage layer, network sync protocols, the reactive
system, schemas.

## Documents

- [1-storable-values.md](./1-storable-values.md) -- The complete data model
  specification. All topics above are covered in this single document.
