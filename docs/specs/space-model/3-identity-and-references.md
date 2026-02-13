# Identity and References

This document specifies how entities are identified and how references between
data are represented.

## Status

Draft — based on codebase investigation and discussion.

---

## Current State

### The "/" Sigil Convention

The system uses `"/"` as a special key to denote "this is a reference, not
data." This convention comes from [DAG-JSON](https://ipld.io/specs/codecs/dag-json/spec/),
part of the IPLD ecosystem.

Any object with a `"/"` key is interpreted as a reference rather than a literal
object value.

### Link Formats

#### Sigil Links (`link@1`)

The preferred format uses a versioned tag:

```typescript
type SigilLink = {
  "/": {
    "link@1": {
      id?: URI,                    // entity identifier (defaults to containing entity)
      path?: readonly string[],    // path within the entity's value
      space?: MemorySpace,         // target space (defaults to current)
      schema?: JSONSchema,
      overwrite?: "this" | "redirect"
    }
  }
}
```

Example:
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

#### Legacy Formats

**`$alias` format** — still actively produced by pattern serialization:
```json
{ "$alias": { "cell": { "/": "abc123" }, "path": ["value"] } }
```

**`LegacyJSONCellLink`** (`{ cell: { "/": string }, path: [...] }`) — removed
from write and recognition code paths. The type definition still exists in
`sigil-types.ts`, and backwards-compatible reading of previously persisted data
is retained, but no code produces or actively recognizes this format.

**Bare string link** (`{ "/": string }` with a plain string value) — removed
from recognition entirely.

### Entity Identifiers

Entities are identified by content-derived hashes computed via the `refer()`
function. See [Data Model](./1-data-model.md#hashing-and-content-addressing) for
details on the hashing mechanism.

The `refer()` function is used for:
- Pattern ID generation: `refer({ causal: { patternId, type: "pattern" } })`
- Request deduplication: `refer(llmParams).toString()`
- Cache keys: `refer(JSON.stringify(selector)).toString()`
- Causal chain references

### Internal Representation

Internally, links are normalized to `NormalizedFullLink`:

```typescript
type NormalizedFullLink = {
  id: URI,
  space: MemorySpace,
  path: readonly string[],
  type: MediaType,            // e.g., "application/json"
  schema?: JSONSchema,
  overwrite?: "redirect"
}
```

This is the form used for:
- Event routing (matching streams to handlers)
- Equality comparison
- Cell identity

---

## Proposed Directions

### Simplified Canonical Hashing

See [Data Model](./1-data-model.md#simplified-canonical-hashing) for the
proposal to simplify content addressing.

### Legacy Format Deprecation

`LegacyJSONCellLink` and bare string links (`{ "/": string }`) have been removed
from write and recognition code paths. `LegacyJSONCellLink` retains
backwards-compatible reading for previously persisted data, but is otherwise
inactive. The `$alias` format remains in active use by pattern serialization and
should be removed once that path produces `link@1` format.

---

## Open Questions

- When can the `$alias` format be removed?
- How do cross-space references interact with permissions?
- Should `toJSON()` on cells be removed once JSON is no longer the primary format?

---

**Previous:** [Storage Format](./2-storage-format.md) | **Next:** [Cells](./4-cells.md)
