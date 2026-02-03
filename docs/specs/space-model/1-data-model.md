# Data Model

This document specifies the immutable data representation — what values can be
stored and how they are identified.

## Status

Draft — based on codebase investigation.

---

## Current State

### Overview

The system stores **storable values** — data that can be serialized to JSON with
some extensions. All persistent data and in-flight messages use this
representation.

### Base Types

Storable values are JSON-compatible with specific constraints:

| Type | Notes |
|------|-------|
| `null` | JSON null |
| `boolean` | `true` or `false` |
| `number` | Finite only; `NaN` and `Infinity` rejected |
| `string` | Unicode text |
| `array` | Ordered sequence of storable values |
| `object` | String-keyed map of storable values |

#### Numbers

- Only finite numbers are storable
- `-0` is normalized to `0` during conversion
- `NaN` and `Infinity` throw errors

#### Arrays

- Must be dense (no holes)
- Must not contain `undefined` elements
- Sparse arrays are densified during conversion (`undefined` → `null`)
- Named properties on arrays are rejected

#### Objects

- Plain objects only (no class instances)
- Keys are strings; values are storable

### Special Values

#### `undefined`

`undefined` has special semantics depending on context:

- **Top-level**: Indicates deletion (remove the stored value)
- **Object property**: Treated as absent (property is omitted)
- **Array element**: Converted to `null` during storage

#### Non-Storable Types

These types cannot be stored directly:

- `bigint` — throws error
- `symbol` — throws error
- `function` — throws error unless it has a `toJSON()` method
- Class instances — throws error unless they have `toJSON()` or special handling

### Special Object Shapes

Certain object shapes have system-defined semantics. These use reserved keys
that begin with special characters.

#### Reference Sigil: `{ "/": ... }`

Objects with a `"/"` key are references, not literal data. This convention
comes from [DAG-JSON](https://ipld.io/specs/codecs/dag-json/spec/).

```json
{
  "/": {
    "link@1": {
      "id": "of:abc123...",
      "path": ["items", "0", "name"]
    }
  }
}
```

See [Identity and References](./3-identity-and-references.md) for details.

#### Stream Marker: `{ $stream: true }`

Objects with exactly `{ $stream: true }` mark stream cell locations. The marker
persists to preserve stream identity; event payloads are ephemeral.

See [Cells](./4-cells.md) for stream semantics.

#### Error Wrapper: `{ "@Error": {...} }`

Error instances are converted to a storable form using the `@` prefix convention:

```json
{
  "@Error": {
    "name": "TypeError",
    "message": "Cannot read property 'x' of undefined",
    "stack": "TypeError: Cannot read...",
    "cause": null
  }
}
```

Properties captured:
- `name` — error type name
- `message` — error message
- `stack` — stack trace (if available)
- `cause` — nested cause (recursively converted)
- Any custom enumerable properties

This allows errors to round-trip through storage while preserving diagnostic
information.

### Conversion Functions

The system provides conversion utilities:

| Function | Purpose |
|----------|---------|
| `isStorableValue()` | Check if value is already storable |
| `toStorableValue()` | Convert a single value (shallow) |
| `toDeepStorableValue()` | Convert recursively, handling cycles |

`toJSON()` methods are invoked automatically for objects and functions that
have them, allowing custom serialization.

### Circular References

Circular references are detected and throw an error. The system does not support
storing cyclic data structures. Shared references (the same object appearing
multiple times) are preserved correctly.

---

## Hashing and Content Addressing

### Current State

The system uses content-derived hashes for entity identification. The
`merkle-reference` library computes deterministic identifiers from content.

#### How It Works

1. Content is translated into a binary tree representation
2. Tree nodes are hashed using SHA-256
3. Result is formatted as a CID (Content Identifier)

#### Hash Implementations

The system selects SHA-256 implementation by environment:

| Environment | Implementation | Notes |
|-------------|----------------|-------|
| Server (Deno) | `node:crypto` | Hardware-accelerated via OpenSSL |
| Browser | `hash-wasm` | WebAssembly, ~3x faster than pure JS |
| Fallback | `@noble/hashes` | Pure JavaScript |

#### Usage

The `refer()` function computes references:

```typescript
const id = refer({ the: "application/json", of: "some-entity" });
// Returns a Reference (CID-formatted string)
```

Common uses:
- Recipe ID generation
- Request deduplication
- Cache keys
- Causal chain references

#### Caching

Two caches optimize reference computation:
- **Primitive cache**: LRU cache for primitives (97%+ hit rate)
- **Unclaimed cache**: LRU cache for `{the, of}` patterns (frequent in facts)

### Concerns with Current Approach

The `merkle-reference` library:
- Translates content into binary trees before hashing
- Encodes a specific representation (tree structure) into the hash
- Adds translation overhead
- Provides IPLD/CID formatting that isn't used for actual interop

#### IPFS Clothing Without IPFS Functionality

The system wears the "clothing" of IPFS — using CID formatting, the `"/"` sigil
convention from DAG-JSON, and merkle tree hashing — but gains none of the
benefits:

- **No content retrieval by CID**: The system doesn't fetch data from IPFS
- **No pinning**: Content isn't published to or retrieved from the IPFS network
- **No external verification**: CIDs aren't verified against external sources
- **No deduplication across peers**: The distributed storage benefits don't apply

The IPLD formatting adds complexity (tree translation, specific encoding rules)
without providing interoperability. The CID is used purely as a local identifier,
which a simpler hash would serve equally well.

---

## Proposed Directions

### Simplified Canonical Hashing

Replace `merkle-reference` with a simpler canonical hashing approach:
- Traverse the natural data structure directly (no intermediate tree)
- Sort object keys, preserve array order
- Hash type tags + content in a single pass
- No intermediate allocations

The hash should reflect the logical content, not any particular encoding or
intermediate representation.

#### Benefits

- Simpler implementation
- Lower overhead (no tree construction)
- Hash reflects actual data shape
- Easier to reason about what changes affect identity

#### Open Questions

- What is the exact specification for canonical hashing?
- How should each type be tagged? (null, bool, int, float, string, bytes, array, object, references)
- How do special object shapes (references, streams, errors) participate?
- What is the migration path from current CID-based identifiers?

---

## Open Questions

- Should there be additional special object shapes beyond `"/"`, `$stream`, and `@Error`?
- How should versioning of special shapes work?
- What happens when unknown special shapes are encountered?
- Should the `@Error` format capture more or less information?

---

**Next:** [Storage Format](./2-storage-format.md)
