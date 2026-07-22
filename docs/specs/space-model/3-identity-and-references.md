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
// Shown at module scope.
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

**`$alias` format** — no longer a link. Generic link recognition and parsing
(`isWriteRedirectLink`, `parseLink`, `isCellLink`) are sigil-only, so an
`$alias` record found in data is a plain value. The form survives solely as
Pattern *binding* vocabulary (produced by `toJSONWithAliasBindings`, consumed
via `isAliasBinding`/`parseAliasBinding`), where it marks intermediate
bindings — e.g.
```json
{ "$alias": { "cell": "argument", "path": ["items"] } }
```
— not cross-document references.

**`LegacyJSONCellLink`** (`{ cell: { "/": string }, path: [...] }`) — removed
from write and recognition code paths. The type definition still exists in
`sigil-types.ts`, and backwards-compatible reading of previously persisted data
is retained, but no code produces or actively recognizes this format.

**Bare string link** (`{ "/": string }` with a plain string value, used as a
*generic* link) — removed from recognition entirely. This is distinct from the
serialized entity-id reference form below, which uses the same `{ "/": string }`
shape to carry a tagged entity-id hash and is still actively produced (see
[Serialized Entity-Id Reference Form](#serialized-entity-id-reference-form)).

### Entity Identifiers

An entity is identified by an `EntityId`: a content-derived hash that names a
cell/document within a space. An `EntityId` is a **branded `FabricHash`** — at
runtime it is just a `FabricHash` (see [Data Model](./1-data-model.md)), and the
brand is a type-only marker that distinguishes "this hash is an entity id" from
an arbitrary content/value/schema hash:

```typescript
// Shown at module scope.
// At runtime an `EntityId` is a `FabricHash`; the brand is type-only.
type EntityId = FabricHash & { readonly [ENTITY_ID_BRAND]: true };
```

`EntityId`s are produced by `createRef()`, which derives a stable id from a
source value (and an optional `cause`) via `hashOf()`, and by `entityIdFrom()`,
which brands an existing content-hash string or `FabricHash`. A `FabricHash` has
a tagged string form, `<tag>:<hash>` (e.g. `fid1:…`); construct one from that
string via `FabricHash.fromString()`.

The underlying `hashOf()` function — see
[Data Model](./1-data-model.md#hashing-and-content-addressing) for the hashing
mechanism — is also used directly for:
- Pattern ID generation: `hashOf({ causal: { patternId, type: "pattern" } })`
- Request deduplication: `hashOf(llmParams).toString()`
- Cache keys: `hashOf(JSON.stringify(selector)).toString()`
- Causal chain references

### Serialized Entity-Id Reference Form

When an entity id is serialized as a reference to another cell — for example as
the value of `Cell.entityId`, or as extracted by `getEntityId()` — its concrete
shape is **flag-dispatched** by the nascent "modern cell representation"
(`modernCellRep`), a single gate that selects between two regimes:

- **Modern cell representation _off_ (the current default):** the reference is
  a plain `{ "/": "<tag>:<hash>" }` object — the legacy DAG-JSON-flavored form.
- **Modern cell representation _on_:** the reference is a straight `FabricHash`.

This is the one place that describes the flag bifurcation; the `EntityRef` type
captures both regimes:

```typescript
// Shown at module scope.
type EntityRef = FabricHash | { "/": string };
```

Production and recognition route through a small chokepoint —
`entityRefFromString()` / `entityRefFrom()` produce a reference, and
`isEntityRef()` / `entityRefToString()` recognize and extract one. Recognition
is **strict**: it accepts only the form for the currently active regime, never
both. This is deliberate — a stored hash carries no record of which input form
produced it, so the legacy and modern hash regimes are a clean break and never
intermix within one regime.

> The flag is not currently flipped: it is the plumbing wedge ahead of a future
> hash-changing storage migration. Until it is flipped, every serialized
> entity-id reference is the `{ "/": "<tag>:<hash>" }` form, byte-identical to
> the prior behavior.

### Internal Representation

Internally, links are normalized to `NormalizedFullLink`:

```typescript
// Shown at module scope.
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

### Simplified Hashing

See [Data Model](./1-data-model.md#simplified-hashing) for the proposal to
simplify content addressing.

### Legacy Format Deprecation

`LegacyJSONCellLink` and bare string links (`{ "/": string }`) have been removed
from write and recognition code paths. `LegacyJSONCellLink` retains
backwards-compatible reading for previously persisted data, but is otherwise
inactive. `$alias` has been removed from link recognition entirely — in data it
is a plain value. It remains in use as Pattern-binding vocabulary only, and can
be retired once pattern serialization emits sigil bindings.

---

## Open Questions

- How do cross-space references interact with permissions?
- Should `toJSON()` on cells be removed once JSON is no longer the primary format?

---

**Previous:** [Storage Format](./2-storage-format.md) | **Next:** [Cells](./4-cells.md)
