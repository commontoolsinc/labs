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

### Circular References

Circular references are detected and throw an error. The system does not support
storing cyclic data structures. Shared references (the same object appearing
multiple times) are preserved correctly.

---

## Hashing and Content Addressing

### Current State

The system uses content-derived hashes for entity identification:

1. Content is translated into a binary tree representation
2. Tree nodes are hashed using SHA-256
3. Result is formatted as a CID (Content Identifier)

Content hashes are used for:
- Entity identification
- Recipe ID generation
- Request deduplication
- Causal chain references

### Concerns: IPFS Clothing Without IPFS Functionality

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

### Late Serialization: Rich Types Within the Runtime

#### The Principle

Rich types should flow through the runtime as themselves; serialization to
wire/storage formats should happen only at boundary crossings.

```
┌─────────────────────────────────────────────────────┐
│                    Runtime Context                   │
│                                                      │
│   Cell ←→ Cell ←→ Error ←→ Cell ←→ [rich types]     │
│                                                      │
└──────────┬──────────────────┬───────────────────────┘
           │                  │
           ▼                  ▼
    ┌──────────────┐   ┌──────────────┐
    │   Storage    │   │   Network    │
    │  (serialize) │   │  (serialize) │
    └──────────────┘   └──────────────┘
```

#### Current State: Early Conversion

Today, special JSON forms are created early and travel through the system:

- `normalizeAndDiff()` converts Cells to SigilLinks (`{ "/": {...} }`) immediately
- `convertCellsToLinks()` explicitly replaces Cell references with JSON forms
- `toStorableValue()` wraps Errors as `{ "@Error": {...} }` during data updates
- Stream markers (`{ $stream: true }`) are stored and compared as JSON objects

The JSON forms then propagate through transactions, the reactive system, and
query results. Code throughout the system must detect and handle these special
shapes via `isSigilLink()`, `isStreamValue()`, `isErrorWrapper()`, etc.

#### Proposed: Defer Conversion to Boundaries

Keep rich types as themselves within the runtime:

- **Cells remain Cells** through the reactive graph and transactions
- **Errors remain Errors** until they cross a serialization boundary
- **Streams are first-class** rather than marker objects
- Serialization becomes a "last mile" concern at specific boundary points

The `StorableValue` type would evolve from a closed union to a protocol-based
definition — any type implementing the storable protocol becomes a valid
`StorableValue`.

#### The Storable Protocol

Types opt into storability by implementing methods keyed by well-known symbols:

```typescript
const DECONSTRUCT = Symbol.for('common.deconstruct');
const RECONSTRUCT = Symbol.for('common.reconstruct');

// Instance protocol: "here's my essential state"
interface StorableInstance {
  [DECONSTRUCT](): unknown;
}

// Class protocol: "here's how to bring one back"
interface StorableClass<T extends StorableInstance> {
  [RECONSTRUCT](state: unknown, runtime: Runtime): T;
}
```

The presence of `[DECONSTRUCT]` doubles as the brand — no separate marker needed:

```typescript
function isStorable(value: unknown): value is StorableInstance {
  return value != null &&
         typeof value === 'object' &&
         DECONSTRUCT in value;
}
```

Example implementation:

```typescript
class Cell<T> implements StorableInstance {
  [DECONSTRUCT]() {
    return { id: this.entityId, path: this.path, space: this.space };
  }

  static [RECONSTRUCT](state: CellState, runtime: Runtime): Cell<unknown> {
    return runtime.getCell(state);
  }
}
```

This approach:
- **Open for extension**: New storable types don't require modifying a central
  type definition
- **Co-located logic**: Each type knows how to deconstruct/reconstruct itself
- **Symbol-based brands**: Unique symbols prevent collision with user data keys
  and provide reliable runtime type discrimination

#### Serialization Contexts

Classes provide the *capability* to serialize but don't own the wire format.
A **serialization context** owns the mapping between classes and tags:

```typescript
interface SerializationContext {
  // Maps storable types to wire format tags
  getTagFor(value: StorableInstance): string;
  getClassFor(tag: string): StorableClass<StorableInstance>;

  // Format-specific wrapping
  wrap(tag: string, state: unknown): SerializedForm;
  unwrap(data: SerializedForm): { tag: string; state: unknown };
}
```

This separation enables:
- **Protocol versioning**: Same class, different tags in v1 vs v2
- **Format flexibility**: JSON context vs CBOR context vs Automerge context
- **Migration paths**: Old context reads legacy format, new context writes modern format
- **Testing**: Mock contexts for unit tests

The flow becomes:

```
Serialize:   instance.[DECONSTRUCT]() → state → context.wrap(tag, state) → wire
Deserialize: wire → context.unwrap() → { tag, state } → Class[RECONSTRUCT](state) → instance
```

#### Serialization Boundaries

The boundaries where serialization occurs in the current architecture:

| Boundary | Packages | Direction |
|----------|----------|-----------|
| **Persistence** | `memory` ↔ database | read/write |
| **Iframe sandbox** | `runner` ↔ `iframe-sandbox` | postMessage |
| **Background service** | `shell` ↔ `background-piece-service` | worker messages |
| **Network sync** | `toolshed` ↔ remote peers | WebSocket/HTTP |
| **Cross-space** | space A ↔ space B | if in separate processes |

Each boundary would use a serialization context:

```typescript
// At boundary exit
function serialize(value: StorableValue, context: SerializationContext): SerializedForm {
  if (isStorable(value)) {
    const state = value[DECONSTRUCT]();
    const tag = context.getTagFor(value);
    return context.wrap(tag, state);
  }
  // Handle primitives, arrays, plain objects recursively...
}

// At boundary entry
function deserialize(data: SerializedForm, context: SerializationContext, runtime: Runtime): StorableValue {
  const { tag, state } = context.unwrap(data);
  if (tag) {
    const cls = context.getClassFor(tag);
    return cls[RECONSTRUCT](state, runtime);
  }
  // Handle primitives, arrays, plain objects recursively...
}
```

The `deserialize` function needs runtime context to reconstitute rich types
(e.g., looking up existing Cell instances rather than creating duplicates).

#### Benefits

- **Type safety**: Rich types carry more information than JSON shapes
- **Simpler internal code**: No `isSigilLink()` checks scattered throughout
- **Single conversion point**: Easier to maintain, audit, and change
- **Format flexibility**: Different boundaries can use different contexts
- **Better tooling**: Debuggers show actual Cells, not JSON blobs
- **Extensible**: New storable types only need to implement the protocol

#### Trade-offs

- **Migration complexity**: Existing code assumes JSON forms internally
- **Runtime context required**: Deserialization needs access to the runtime
- **Comparison semantics**: Must define equality for rich types (by identity?
  by deconstructed state?)

#### Open Questions

- What is the migration path from early to late conversion?
- How do rich types participate in change detection and diffing?
- What is the exact contract for deconstructed state? (Nested `StorableInstance`s
  should be allowed; cycles likely banned.)
- How are serialization contexts configured and selected at each boundary?
- How does this interact with the proposed CRDT layer (below)?

---

### CRDT-Based Storage Layer

For collaborative features (multiple users editing shared data), the storage
layer could be implemented using CRDTs (Conflict-free Replicated Data Types).
Automerge is a candidate implementation.

#### Automerge's Data Model

Automerge is described as "JSON-like" but supports a richer type system:

| Category | Types |
|----------|-------|
| Containers | Map (string keys), List, Text (collaborative UTF-8) |
| Primitives | null, boolean, string, f64, i64, u64, bytes, timestamp, counter |

Notable differences from the current system:
- **Distinct integer types**: i64 and u64 vs JavaScript's single number type
- **Native binary data**: `bytes` as a first-class type
- **Timestamps**: Built-in, not a convention
- **Counter**: Special type with additive merge semantics

#### Type System Constraints

Automerge has a **fixed type system by design** — merge semantics, binary format
optimization, and cross-language interoperability require known types. Custom
types must be handled at an application layer above Automerge.

This means the current special object shapes (`"/"`, `$stream`, `@Error`) would
need a mapping layer:
- Store as Automerge primitives/containers
- Interpret special shapes at a layer above Automerge
- The `bytes` type could store arbitrary data but loses fine-grained merge
  (entire blob becomes last-write-wins)

#### Internal Structure

Automerge documents store:
- Full causal history with actor IDs (128-bit)
- Operation sequences forming a change DAG (similar to git)
- Columnar encoding with RLE compression

This enables offline editing with automatic merge on reconnection.

#### Layered CRDT Architecture

CRDTs could operate at multiple levels simultaneously:

- **Space level**: The entire space modeled as a single CRDT document, tracking
  the evolution of the overall JSON-ish structure
- **Component level**: Individual parts (e.g., a text field) modeled as their
  own independent CRDT documents with type-specific merge semantics

These layers work in harmony:
- The space treats component CRDTs opaquely — just another value that changes
- Recipes that understand specific CRDT types can work with the component's
  native semantics (e.g., collaborative text editing with cursor positions)
- The space-level CRDT handles structural changes (adding/removing fields)
- Component-level CRDTs handle content changes within their boundaries

This separation allows general-purpose space sync to coexist with specialized
collaborative editing where needed.

#### Trade-offs

| Benefit | Cost |
|---------|------|
| Automatic conflict resolution | Fixed type system requires mapping layer |
| Offline-first with sync | Causal history grows over time |
| Proven merge semantics | Additional complexity vs simple last-write-wins |
| Cross-language support | Must map custom types to Automerge types |

#### Open Questions

- Which data benefits from CRDT semantics vs simple last-write-wins?
- How do Cells map to Automerge documents?
- Should collaborative text (Text type) be exposed directly?
- What is the compaction/garbage collection strategy for causal history?

---

## Open Questions

- Should there be additional special object shapes beyond `"/"`, `$stream`, and `@Error`?
- How should versioning of special shapes work?
- What happens when unknown special shapes are encountered?
- Should the `@Error` format capture more or less information?

---

**Next:** [Storage Format](./2-storage-format.md)
