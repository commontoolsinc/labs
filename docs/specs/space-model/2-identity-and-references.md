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
      id?: URI,           // entity identifier (defaults to containing entity)
      path?: string[],    // path within the entity's value
      space?: SpaceDID,   // target space (defaults to current)
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

#### Legacy Formats (Still in Use)

**`$alias` format** — still actively produced by recipe serialization:
```json
{ "$alias": { "cell": { "/": "abc123" }, "path": ["value"] } }
```

**`LegacyJSONCellLink`**:
```json
{ "cell": { "/": "abc123" }, "path": ["items", 0] }
```

These are marked `@deprecated` but remain in active use. The `toJSONWithLegacyAliases()`
function still produces `$alias` structures during recipe serialization.

### Entity Identifiers

Entities are identified by content-derived hashes. The current implementation
uses `merkle-reference` to compute deterministic identifiers from content.

The `refer()` function is used for:
- Recipe ID generation: `refer({ causal: { recipeId, type: "recipe" } })`
- Request deduplication: `refer(llmParams).toString()`
- Cache keys: `refer(JSON.stringify(selector)).toString()`
- Causal chain references

#### Concerns with Current Approach

The `merkle-reference` library:
- Translates content into binary trees before hashing
- Encodes a specific representation (tree structure) into the hash
- Adds translation overhead
- Provides IPLD/CID formatting that isn't used for interop

**Note**: No actual IPFS interoperability exists — the system doesn't retrieve
content by CID, pin to IPFS, or verify against external sources.

### Internal Representation

Internally, links are normalized to `NormalizedFullLink`:

```typescript
type NormalizedFullLink = {
  id: URI,
  space: MemorySpace,
  path: readonly PropertyKey[],
  schema?: JSONSchema
}
```

This is the form used for:
- Event routing (matching streams to handlers)
- Equality comparison (`areNormalizedLinksSame`)
- Cell identity

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

**Open Question**: What is the exact specification for canonical hashing? Need
to define handling of all types (null, bool, int, float, string, bytes, array,
object, references).

### Legacy Format Deprecation

The `$alias` and `LegacyJSONCellLink` formats should eventually be removed once
all serialization paths produce `link@1` format.

---

## Open Questions

- When can legacy formats be removed?
- What is the canonical hashing specification?
- How do cross-space references interact with permissions?
- Should `toJSON()` on cells be removed once JSON is no longer the primary format?
