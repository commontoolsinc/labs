# Storable Values

This document specifies the immutable data representation for the Space Model:
what values can be stored, how custom types participate in serialization, and how
values are identified by content.

## Status

Draft formal spec -- extracted from the data model proposal.

---

## 1. Storable Value Types

### 1.1 Overview

The system stores **storable values** -- data that can flow through the runtime
as rich types and be serialized to wire/storage formats at boundary crossings.
All persistent data and in-flight messages use this representation.

The key design principle is **late serialization**: rich types flow through the
runtime as themselves; serialization to wire/storage formats happens only at
boundary crossings (persistence, IPC, network).

### 1.2 Type Universe

A `StorableValue` is defined as the following union:

```typescript
// file: packages/common/storable-value.ts

/**
 * The complete set of values that can flow through the runtime, be stored
 * persistently, or be transmitted across boundaries.
 */
type StorableValue =
  // (a) Primitives
  | null
  | boolean
  | number    // finite only; NaN and Infinity rejected
  | string
  | undefined // deletion at top level; absent in objects; null in arrays
  | bigint    // large integers

  // (b) Built-in JS types (require explicit serialization handling)
  | Error
  | Map<StorableValue, StorableValue>
  | Set<StorableValue>
  | Uint8Array
  | Date

  // (c) Branded storables (custom types implementing the storable protocol)
  | StorableInstance

  // (d) Recursive containers
  | StorableValue[]
  | { [key: string]: StorableValue };
```

### 1.3 Primitive Types

| Type | Constraints | Notes |
|------|-------------|-------|
| `null` | None | JSON null |
| `boolean` | None | `true` or `false` |
| `number` | Must be finite | `-0` normalized to `0`; `NaN`/`Infinity` rejected |
| `string` | None | Unicode text |
| `undefined` | Context-dependent | Top-level: deletion. Object property: absent. Array element: `null` |
| `bigint` | None | Serialized as string in JSON encoding |

### 1.4 Built-in JS Types

These types are recognized directly by the serialization system. They cannot be
patched with symbol-keyed methods, so the serialization context must handle them
explicitly.

| Type | JSON Encoding | Notes |
|------|---------------|-------|
| `Error` | `{ "/Error@1": { name, message, stack, cause, ... } }` | Captures name, message, stack, cause, and custom enumerable properties. `cause` is recursively converted. |
| `Map` | `{ "/Map@1": [[key, value], ...] }` | Entry order is preserved. Keys and values are recursively converted. |
| `Set` | `{ "/Set@1": [value, ...] }` | Iteration order is preserved. Values are recursively converted. |
| `Uint8Array` | `{ "/Bytes@1": "base64..." }` | Base64-encoded binary data. |
| `Date` | `{ "/Date@1": "ISO-8601-string" }` | ISO 8601 UTC format. |

### 1.5 Recursive Containers

**Arrays:**
- Must be dense (no holes)
- Must not contain `undefined` elements (converted to `null` during storage)
- Non-index keys (named properties on arrays) cause rejection
- Sparse arrays are densified during conversion (`undefined` -> `null`)

**Objects:**
- Plain objects only (class instances must implement the storable protocol)
- Keys must be strings; symbol keys cause rejection
- Values must be storable
- No distinction between regular and null-prototype objects; reconstruction
  produces regular plain objects

### 1.6 Circular References

Within a single document, circular references are detected and throw an error.
The system does not support storing cyclic data within a document's value.
Shared references (the same object appearing multiple times) are preserved
correctly.

Cycles *across* documents are supported via explicit links (storable instances
that reference other documents). Two cells can reference each other, forming a
cycle in the broader data graph. The no-cycles constraint applies only to the
serializable content of a single cell.

The within-document prohibition is inherited from JSON's tree structure and could
be relaxed if a future storage format supports cyclic references natively.

---

## 2. The Storable Protocol

### 2.1 Overview

Types that the system controls opt into storability by implementing methods
keyed by well-known symbols. This allows the system to serialize and
deserialize custom types without central registration at the type level.

### 2.2 Symbols

```typescript
// file: packages/common/storable-protocol.ts

/**
 * Well-known symbol for deconstructing a storable instance into its
 * essential state. The returned value may contain nested StorableValues
 * (including other StorableInstances); the serialization system handles
 * recursion.
 */
export const DECONSTRUCT = Symbol.for('common.deconstruct');

/**
 * Well-known symbol for reconstructing a storable instance from its
 * essential state. Static method on the class.
 */
export const RECONSTRUCT = Symbol.for('common.reconstruct');

// Protocol evolution: Symbol.for('common.deconstruct@2'), etc.
```

### 2.3 Instance Protocol

```typescript
// file: packages/common/storable-protocol.ts

/**
 * A value that knows how to deconstruct itself into essential state
 * for serialization. The presence of [DECONSTRUCT] serves as the brand --
 * no separate marker is needed.
 */
export interface StorableInstance {
  /**
   * Returns the essential state of this instance. The returned value may
   * contain any StorableValue, including other StorableInstances. The
   * implementation must NOT recursively deconstruct nested values -- the
   * serialization system handles that.
   */
  [DECONSTRUCT](): unknown;
}
```

### 2.4 Class Protocol

```typescript
// file: packages/common/storable-protocol.ts

/**
 * A class that can reconstruct instances from essential state. This is a
 * static method, separate from the constructor, for two reasons:
 *
 * 1. Reconstruction-specific context: receives the Runtime (and potentially
 *    other context) which shouldn't be mandated in a constructor signature.
 * 2. Instance interning: can return existing instances rather than always
 *    creating new ones -- essential for types like Cell where identity matters.
 */
export interface StorableClass<T extends StorableInstance> {
  /**
   * Reconstruct an instance from essential state. Nested values in `state`
   * have already been reconstructed by the serialization system. May return
   * an existing instance (interning) rather than creating a new one.
   */
  [RECONSTRUCT](state: unknown, runtime: Runtime): T;
}
```

### 2.5 Brand Detection

```typescript
// file: packages/common/storable-protocol.ts

/**
 * Type guard: checks whether a value implements the storable protocol.
 * The presence of [DECONSTRUCT] is the brand.
 */
export function isStorable(value: unknown): value is StorableInstance {
  return value != null
    && typeof value === 'object'
    && DECONSTRUCT in value;
}
```

### 2.6 Example: Cell

```typescript
// file: packages/runtime/cell.ts (illustrative stub)

import {
  DECONSTRUCT,
  RECONSTRUCT,
  type StorableInstance,
  type StorableClass,
} from '@common/storable-protocol';

class Cell<T> implements StorableInstance {
  readonly entityId: string;
  readonly path: string[];
  readonly space: string;

  [DECONSTRUCT]() {
    return { id: this.entityId, path: this.path, space: this.space };
  }

  static [RECONSTRUCT](
    state: { id: string; path: string[]; space: string },
    runtime: Runtime,
  ): Cell<unknown> {
    // May return an existing Cell instance (interning).
    return runtime.getCell(state);
  }
}
```

### 2.7 Deconstructed State and Recursion

The value returned by `[DECONSTRUCT]()` can contain any value that is itself
storable -- including other `StorableInstance`s, built-in types like `Error` or
`Map`, primitives, and plain objects/arrays.

**The serialization system handles recursion, not the individual deconstructor
methods.** A `[DECONSTRUCT]` implementation returns its essential state without
recursively deconstructing nested values. The deconstructor does not have access
to the serialization machinery -- by design, as it would be a layering
violation.

Similarly, `[RECONSTRUCT]` receives state where nested values have already been
reconstructed by the serialization system.

### 2.8 Reconstruction Guarantees

The system follows an **immutable-forward** design:

- **Plain objects and arrays** are frozen (`Object.freeze()`) upon
  reconstruction.
- **StorableInstances** should ideally be frozen as well -- this is the north
  star, though not yet a strict requirement.
- **No distinction** is made between regular and null-prototype plain objects;
  reconstruction always produces regular plain objects.

This immutability guarantee enables safe sharing of reconstructed values and
aligns with the reactive system's assumption that values don't mutate in place.

---

## 3. Unknown Types

### 3.1 Overview

When deserializing, a context may encounter a type tag it doesn't recognize --
for example, data written by a newer version of the system. Unknown types are
**passed through** rather than rejected, preserving forward compatibility.

### 3.2 UnknownStorable

```typescript
// file: packages/common/unknown-storable.ts

import {
  DECONSTRUCT,
  RECONSTRUCT,
  type StorableInstance,
} from './storable-protocol';

/**
 * Holds an unrecognized type's data for round-tripping. The serialization
 * system has special knowledge of this class: on deserialization of an unknown
 * tag, it wraps the tag and state here; on re-serialization, it uses the
 * preserved typeTag to produce the original wire format.
 */
export class UnknownStorable implements StorableInstance {
  constructor(
    /** The original type tag, e.g. "FutureType@2". */
    readonly typeTag: string,
    /** The raw state, already recursively processed by the serializer. */
    readonly state: unknown,
  ) {}

  [DECONSTRUCT]() {
    return { type: this.typeTag, state: this.state };
  }

  static [RECONSTRUCT](
    state: { type: string; state: unknown },
    _runtime: Runtime,
  ): UnknownStorable {
    return new UnknownStorable(state.type, state.state);
  }
}
```

### 3.3 Behavior

- When the serialization system encounters an unknown type tag during
  deserialization, it wraps the original tag and state into `{ type, state }`
  and passes that to `UnknownStorable[RECONSTRUCT]`.
- When re-serializing an `UnknownStorable`, the system uses the preserved
  `typeTag` to produce the original wire format.
- This allows data to round-trip through systems that don't understand it.

---

## 4. Serialization Contexts

### 4.1 Overview

Classes provide the *capability* to serialize via the storable protocol, but
they don't own the wire format. A **serialization context** owns the mapping
between classes and wire format tags, and handles format-specific
encoding/decoding.

### 4.2 Interface

```typescript
// file: packages/common/serialization-context.ts

/**
 * Maps between runtime types and wire format representations. Each boundary
 * in the system uses a serialization context appropriate to its format.
 */
export interface SerializationContext {
  /** Get the wire format tag for a storable instance's type. */
  getTagFor(value: StorableInstance): string;

  /** Get the class that can reconstruct instances for a given tag. */
  getClassFor(tag: string): StorableClass<StorableInstance> | undefined;

  /** Wrap a tag and state into the format's wire representation. */
  wrap(tag: string, state: unknown): SerializedForm;

  /** Unwrap a wire representation into tag and state. */
  unwrap(data: SerializedForm): { tag: string; state: unknown } | null;
}
```

### 4.3 Serialization Flow

```
Serialize:   instance.[DECONSTRUCT]() -> state -> context.wrap(tag, state) -> wire
Deserialize: wire -> context.unwrap() -> { tag, state } -> Class[RECONSTRUCT](state) -> instance
```

### 4.4 Top-Level Serialize/Deserialize

```typescript
// file: packages/common/serialization.ts

import { DECONSTRUCT, RECONSTRUCT, isStorable } from './storable-protocol';
import type { SerializationContext } from './serialization-context';
import { UnknownStorable } from './unknown-storable';

/**
 * Serialize a storable value for boundary crossing. Recursively processes
 * nested values.
 */
export function serialize(
  value: StorableValue,
  context: SerializationContext,
): SerializedForm {
  if (isStorable(value)) {
    const state = value[DECONSTRUCT]();
    const tag = context.getTagFor(value);
    const serializedState = serialize(state, context); // recursive
    return context.wrap(tag, serializedState);
  }

  // Handle built-in JS types (Error, Map, Set, Uint8Array, Date)
  // Each is converted via the context using a well-known tag.
  // ...

  // Handle primitives: pass through.
  // Handle arrays: recursively serialize elements.
  // Handle plain objects: recursively serialize values.
  // ...
}

/**
 * Deserialize a wire-format value back into rich runtime types. Requires
 * a Runtime for reconstituting types that need runtime context (e.g., Cell
 * interning).
 */
export function deserialize(
  data: SerializedForm,
  context: SerializationContext,
  runtime: Runtime,
): StorableValue {
  const unwrapped = context.unwrap(data);
  if (unwrapped !== null) {
    const { tag, state } = unwrapped;
    const cls = context.getClassFor(tag);
    const deserializedState = deserialize(state, context, runtime); // recursive
    if (cls) {
      return cls[RECONSTRUCT](deserializedState, runtime);
    }
    // Unknown type: preserve for round-tripping.
    return UnknownStorable[RECONSTRUCT](
      { type: tag, state: deserializedState },
      runtime,
    );
  }

  // Handle primitives: pass through.
  // Handle arrays: recursively deserialize elements.
  // Handle plain objects: recursively deserialize values.
  // ...
}
```

### 4.5 Separation of Concerns

This architecture enables:

- **Protocol versioning**: Same class, different tags in v1 vs v2.
- **Format flexibility**: JSON context vs CBOR context vs Automerge context.
- **Migration paths**: Old context reads legacy format, new context writes
  modern format.
- **Testing**: Mock contexts for unit tests.

### 4.6 Serialization Boundaries

The boundaries where serialization occurs:

| Boundary | Packages | Direction |
|----------|----------|-----------|
| **Persistence** | `memory` <-> database | read/write |
| **Iframe sandbox** | `runner` <-> `iframe-sandbox` | postMessage |
| **Background service** | `shell` <-> `background-piece-service` | worker messages |
| **Network sync** | `toolshed` <-> remote peers | WebSocket/HTTP |
| **Cross-space** | space A <-> space B | if in separate processes |

Each boundary uses a serialization context appropriate to its format and
version requirements.

---

## 5. JSON Encoding for Special Types

### 5.1 Overview

This section specifies the JSON-compatible wire format for special types. While
the system will maintain a JSON encoding indefinitely (for debugging and
interoperability), other wire and storage formats (e.g., CBOR) may represent
types more directly without layering on JSON.

### 5.2 Key Convention: `/<Type>@<Version>`

All special types in JSON use a single convention: single-key objects where the
key follows the pattern `/<Type>@<Version>`.

- `/` -- sigil prefix (nodding to IPLD heritage)
- `<Type>` -- `UpperCamelCase` type name
- `@<Version>` -- version number (natural number)

### 5.3 Standard Type Encodings

```typescript
// file: packages/common/json-encoding.ts (illustrative -- tag-to-format map)

/**
 * Standard JSON encodings for all built-in special types.
 */

// Cell references (links to other documents)
// { "/Link@1": { id: string, path: string[], space: string } }

// Errors
// { "/Error@1": { name: string, message: string, stack?: string, cause?: ..., ... } }

// Stream markers (stateless -- value is null)
// { "/Stream@1": null }

// Maps (entry pairs preserve order)
// { "/Map@1": [StorableValue, StorableValue][] }

// Sets (values preserve iteration order)
// { "/Set@1": StorableValue[] }

// Binary data (base64-encoded)
// { "/Bytes@1": string }

// Dates (ISO 8601 UTC)
// { "/Date@1": string }

// BigInts (decimal string representation)
// { "/BigInt@1": string }
```

### 5.4 Detection

A value is a special type if:

1. It is a plain object.
2. It has exactly one key.
3. That key starts with `/`.

This rule is quick to check and provides maximum flexibility to evolve the key
format.

### 5.5 Stateless Types

Types that require no reconstruction state use `null` as the value:

```json
{ "/Stream@1": null }
```

This clearly distinguishes "no state needed" from "empty state" (`{}`).

### 5.6 Escaping

Two escape mechanisms handle cases where user data might be mistaken for
special types.

#### `/object` -- Single-Layer Escape

Wraps a plain object whose key(s) might look like special types. The values
are still processed normally during deserialization:

```json
{ "/object": { "/myKey": { "/Link@1": { "id": "..." } } } }
```

Deserializes to: `{ "/myKey": <reconstructed Link> }`. The `/object` wrapper
is stripped; inner keys are taken literally; inner values go through normal
deserialization.

#### `/quote` -- Fully Literal

Wraps a value that should be returned exactly as-is, with no deserialization
of any nested special forms:

```json
{ "/quote": { "/Link@1": { "id": "..." } } }
```

Deserializes to: `{ "/Link@1": { "id": "..." } }` -- the inner structure is
*not* reconstructed. It remains a plain object.

Use cases:
- Storing schemas or examples that describe special types without instantiating
  them
- Metaprogramming and introspection
- Optimization: skip deserialization when the subtree is known to be plain data
- Round-tripping JSON structures that happen to look like special types

#### When to Use Which

- `/object`: You have a plain object with a slash-prefixed key, but values
  should still be interpreted normally.
- `/quote`: You want the entire subtree treated as literal JSON data.

### 5.7 Serialization Context Responsibilities

The JSON serialization context's `wrap()` and `unwrap()` methods generate and
parse `/<Type>@<Version>` keys. The context is also responsible for:

- Applying `/object` or `/quote` escaping when serializing plain objects that
  happen to have slash-prefixed keys.
- Wrapping unknown types using the `typeTag` preserved in `UnknownStorable`.

### 5.8 Unknown Type Handling

When a JSON context encounters a `/<Type>@<Version>` key it doesn't recognize,
it wraps the data in `UnknownStorable` (see Section 3) to preserve it for
round-tripping.

---

## 6. Canonical Hashing

### 6.1 Overview

The system uses canonical hashing for content-based identity. This replaces the
previous `merkle-reference` approach with a simpler scheme that operates
directly on the natural data structure.

### 6.2 Design Principles

- Traverse the natural data structure directly (no intermediate tree
  construction).
- Sort object keys lexicographically; preserve array order.
- Hash type tags + content in a single pass.
- No intermediate allocations beyond the hash state.
- The hash reflects the logical content, not any particular encoding or
  intermediate representation.

### 6.3 Hashing Algorithm

```typescript
// file: packages/common/canonical-hash.ts (stub)

/**
 * Compute a canonical hash for a storable value. The hash is
 * encoding-independent: the same identity whether later serialized
 * to JSON, CBOR, or any other format.
 *
 * Uses SHA-256 internally. Output format TBD (likely hex or base64).
 */
export function canonicalHash(value: StorableValue): string {
  // Implementation feeds type-tagged data into a SHA-256 hasher:
  //
  // - null:        hash(TAG_NULL)
  // - boolean:     hash(TAG_BOOL, boolByte)
  // - number:      hash(TAG_NUMBER, float64Bytes)
  // - string:      hash(TAG_STRING, utf8Bytes)
  // - bigint:      hash(TAG_BIGINT, signedBytes)
  // - undefined:   hash(TAG_UNDEFINED)
  // - Uint8Array:  hash(TAG_BYTES, rawBytes)
  // - Date:        hash(TAG_DATE, millisSinceEpoch)
  // - Error:       hash(TAG_ERROR, canonicalHash(errorState))
  // - Map:         hash(TAG_MAP, sorted entries by canonicalHash(key))
  // - Set:         hash(TAG_SET, sorted by canonicalHash(element))
  // - array:       hash(TAG_ARRAY, length, ...canonicalHash(element))
  // - object:      hash(TAG_OBJECT, sorted keys, ...canonicalHash(value))
  // - StorableInstance: hash(TAG_STORABLE, typeTag, canonicalHash(deconstructedState))
  //
  // Each type is tagged to prevent collisions between types with
  // identical content representations.
}
```

### 6.4 Relationship to Late Serialization

Canonical hashing operates on rich types directly, using deconstructed state
for `StorableInstance`s and type-specific handling for built-in JS types. This
makes identity hashing independent of any particular wire encoding -- the same
hash whether later serialized to JSON, CBOR, or Automerge.

### 6.5 Use Cases

Canonical hashing is used for:
- Recipe ID generation (derived from recipe definition)
- Request deduplication
- Causal chain references (hashing the causal tree of what led to the data's
  existence)

Entity IDs remain stable addresses (analogous to IPNS names) pointing to the
most current version of the data. Hashes are not used as entity addresses.

---

## 7. Migration Notes

### 7.1 From Early to Late Conversion

The current system converts to JSON forms early (`isSigilLink()`,
`isStreamValue()`, `isErrorWrapper()` checks are scattered throughout). The
migration to late serialization involves:

1. Expanding `StorableValue` to include rich types.
2. Removing early conversion points (`convertCellsToLinks()`,
   `toStorableValue()` wrapping Errors as `{ "@Error": ... }`, etc.).
3. Introducing serialization contexts at each boundary.
4. Updating internal code to work with rich types instead of JSON shapes.

### 7.2 From Current JSON Formats

The current system uses three inconsistent conventions:

| Current Convention | Example | Replacement |
|-------------------|---------|-------------|
| IPLD sigil | `{ "/": { "link@1": {...} } }` | `{ "/Link@1": {...} }` |
| `@` prefix | `{ "@Error": {...} }` | `{ "/Error@1": {...} }` |
| `$` prefix | `{ "$stream": true }` | `{ "/Stream@1": null }` |

All three are unified under the `/<Type>@<Version>` convention.

### 7.3 From CID-Based Hashing

The current merkle-tree/CID-based hashing is replaced with the simpler
canonical hashing approach (Section 6). The system does not participate in the
IPFS network, so CID formatting is unnecessary overhead. The new approach hashes
the logical content directly.

---

## Appendix A: Open Design Decisions

These questions may need resolution during implementation but do not block the
spec from being implementable.

- **Comparison semantics for rich types**: Should equality be by identity, by
  deconstructed state, or configurable?
- **Partial failure in DECONSTRUCT/RECONSTRUCT**: Should a `ProblematicStorable`
  (analogous to `UnknownStorable`) be introduced for cases where
  deconstruction or reconstruction fails partway through?
- **Type registry management**: How are serialization contexts configured? Static
  registration? Dynamic discovery? Who owns the registry?
- **Schema integration**: Each `StorableInstance` type implies a schema for its
  deconstructed state. How does this integrate with the schema language?
- **Cycle detection in deconstructed state**: Should cycles in deconstructed
  state be detected and rejected, or is this left to the serialization system?
- **Exact canonical hash specification**: Precise byte-level specification of
  the hash algorithm (type tags, encoding of each type, handling of special
  cases).
- **Hash output format**: Hex, base64, or other encoding for hash output.
- **Migration path**: Detailed plan for transitioning from current formats to
  the new encoding while maintaining backward compatibility.
