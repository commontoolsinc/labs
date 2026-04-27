# Space Model Formal Spec: Data Model

This directory contains the formal specification for the Space Model data model.
It is derived from the proposal sections of the original
[data model spec](../space-model/1-data-model.md), reformulated as a
self-contained, implementable specification.

## Scope

This spec covers:

- **Fabric values** (Sections 1-2) -- the type universe for all persistent and
  in-flight data, and the fabric protocol (`[DECONSTRUCT]`/`[RECONSTRUCT]`)
  for custom type participation in serialization
- **Unknown types** (Section 3) -- forward-compatibility via `UnknownValue`
- **Serialization contexts** (Section 4) -- boundary-crossing serialization
  strategy, the `serialize()`/`deserialize()` functions, and boundary inventory
- **JSON encoding** -- the `/<Type>@<Version>` wire format for special types,
  escaping, detection rules, and the `/`-key reservation rule
- **Canonical hashing** (Section 6) -- content-based identity for fabric
  values
- **Implementation guidance** (Section 7) -- migration from legacy formats

Out of scope: CRDT-based storage layer, network sync protocols, the reactive
system, schemas.

## Documents

- [1-fabric-values.md](./1-fabric-values.md) -- Fabric value types, the
  three-layer architecture, the fabric protocol, unknown types, serialization
  contexts, canonical hashing, implementation guidance, and conversion
  functions. (Sections 1-4, 6-8.)
- [2-canonical-hash-byte-format.md](./2-canonical-hash-byte-format.md) --
  Byte-level encoding for the canonical hash algorithm.
- [3-json-encoding.md](./3-json-encoding.md) -- The JSON wire format for
  fabric values: `/<Type>@<Version>` tagged objects, standard type encodings,
  detection, escaping, and the `/`-key reservation rule.
