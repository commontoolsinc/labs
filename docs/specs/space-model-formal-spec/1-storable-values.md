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

> **Package note:** The TypeScript stubs in this spec use `packages/common/` as
> a placeholder package path. A more specific name (e.g., `packages/data-model`
> or `packages/storable`) may be preferable. In the current codebase, the
> storable-value types live in `packages/memory/interface.ts` and the conversion
> functions in `packages/memory/storable-value.ts`. The final package name and
> location is an implementation decision; nothing in this spec depends on it.

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
  | number    // finite only; `NaN` and `Infinity` rejected
  | string
  | undefined // deletion at top level; absent in objects; `null` in arrays
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
| `undefined` | Context-dependent | Top-level: deletion. Object property: absent. Array element: `null` (see note below) |
| `bigint` | None | Serialized as string in JSON encoding |

> **`undefined` semantics:** The context-dependent behavior of `undefined` is
> preserved from the current implementation: at top level it signals deletion
> (removing a cell's value), as an object property value it means that property
> is absent (omitted during serialization), and as an array element it is
> converted to `null` (since JSON arrays cannot represent `undefined`).

> **`-0` normalization:** Negative zero (`-0`) is normalized to positive zero
> (`0`) during storable-value conversion (i.e., `toStorableValue()`), before the
> value reaches a serialization boundary. This matches `JSON.stringify` behavior
> and ensures that `0` and `-0` produce the same serialized form and canonical
> hash. In the current codebase, this normalization happens in
> `packages/memory/storable-value.ts` at the `toStorableValue()` call site.

> **Future: `-0` and non-finite numbers.** The current design normalizes `-0`
> and rejects `NaN`/`Infinity`/`-Infinity`. Because the serialization system
> uses typed tags (Section 5), a future version could represent these values
> with full fidelity (e.g., `{ "/NegZero@1": null }`, `{ "/NaN@1": null }`,
> `{ "/Infinity@1": "+" }`) without ambiguity. This option is preserved by the
> architecture but not currently needed.

### 1.4 Built-in JS Types

These types are recognized directly by the serialization system. They cannot be
patched with symbol-keyed methods, so the serialization context must handle them
explicitly.

| Type | JSON Encoding | Notes |
|------|---------------|-------|
| `Error` | `{ "/Error@1": { name, message, stack, cause, ... } }` | Captures `name`, `message`, `stack`, `cause`, and custom enumerable properties. Nested values (including `cause`) are recursively serialized by the serialization system -- see Section 4.4 for the recursion model. |
| `Map` | `{ "/Map@1": [[key, value], ...] }` | Entry order is preserved in serialized form. Keys and values are recursively serialized. (For canonical hashing, entries are sorted by key hash -- see Section 6.3.) |
| `Set` | `{ "/Set@1": [value, ...] }` | Iteration order is preserved in serialized form. Values are recursively serialized. (For canonical hashing, elements are sorted by hash -- see Section 6.3.) |
| `Uint8Array` | `{ "/Bytes@1": "base64..." }` | Base64-encoded binary data. |
| `Date` | `{ "/Date@1": "ISO-8601-string" }` | ISO 8601 UTC format. |

> **Built-in types vs. the storable protocol:** Built-in JS types like `Error`
> cannot have `Symbol`-keyed methods added via prototype patching in a reliable,
> cross-realm way. The serialization system therefore has hardcoded knowledge of
> how to decompose these types. This is distinct from user-defined
> `StorableInstance` types, which participate via the `[DECONSTRUCT]` /
> `[RECONSTRUCT]` protocol (Section 2).

### 1.5 Recursive Containers

**Arrays:**
- Must be dense (no holes)
- Must not contain `undefined` elements (converted to `null` during storage)
- Non-index keys (named properties on arrays) cause rejection
- Sparse arrays are densified during conversion (`undefined` -> `null`)

> **Future: explicit `undefined` in arrays.** A future version could preserve
> explicitly-set `undefined` elements in arrays (as distinct from `null`), using
> a tagged representation (e.g., `{ "/Undefined@1": null }`). Sparse arrays
> (holes) are less likely to be worth preserving, but could be supported
> similarly. Neither is currently needed.

**Objects:**
- Plain objects only (class instances must implement the storable protocol)
- Keys must be strings; symbol keys cause rejection
- Values must be storable
- No distinction between regular and null-prototype objects; reconstruction
  produces regular plain objects

### 1.6 Circular References and Shared References

Within a single document, circular references are detected and throw an error.
The system does not support storing cyclic data within a document's value.

**Shared references** (the same object instance appearing multiple times within
a value tree) are handled correctly during conversion: the converted form for a
given original object is cached and reused, so structural sharing is maintained
in the output. Note that this preserves _structural_ sharing (the same converted
subtree appears at multiple positions), not JS _identity_ sharing (the converted
objects may not be `===` to each other in all serialization paths).

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
 * essential state. The returned value may be or contain nested `StorableValue`s
 * (including other `StorableInstance`s); the serialization system handles
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
 * for serialization. The presence of `[DECONSTRUCT]` serves as the brand --
 * no separate marker is needed.
 */
export interface StorableInstance {
  /**
   * Returns the essential state of this instance as a `StorableValue`. The
   * returned value may contain any `StorableValue`, including other
   * `StorableInstance`s, built-in JS types, primitives, and plain
   * objects/arrays.
   *
   * The implementation must NOT recursively deconstruct nested values --
   * the serialization system handles that.
   */
  [DECONSTRUCT](): StorableValue;
}
```

> **Return type rationale:** The return type is `StorableValue` rather than
> `unknown` to make the contract explicit: a deconstructor must return a value
> that the serialization system can process. Returning a non-storable value
> (e.g., a `WeakMap` or a DOM node) would be a bug.

### 2.4 Class Protocol

```typescript
// file: packages/common/storable-protocol.ts

/**
 * A class that can reconstruct instances from essential state. This is a
 * static method, separate from the constructor, for two reasons:
 *
 * 1. Reconstruction-specific context: receives a `ReconstructionContext`
 *    (and potentially other context) which shouldn't be mandated in a
 *    constructor signature.
 * 2. Instance interning: can return existing instances rather than always
 *    creating new ones -- essential for types like `Cell` where identity
 *    matters.
 */
export interface StorableClass<T extends StorableInstance> {
  /**
   * Reconstruct an instance from essential state. Nested values in `state`
   * have already been reconstructed by the serialization system. May return
   * an existing instance (interning) rather than creating a new one.
   */
  [RECONSTRUCT](state: StorableValue, context: ReconstructionContext): T;
}
```

### 2.5 Reconstruction Context

```typescript
// file: packages/common/storable-protocol.ts

/**
 * The minimal interface that `[RECONSTRUCT]` implementations may depend on.
 * In practice this is provided by the `Runtime` class from
 * `packages/runner/src/runtime.ts`, but defining it as an interface here
 * avoids a circular dependency between the storable protocol and the runner.
 *
 * Implementors of `[RECONSTRUCT]` should depend on this interface, not on
 * the concrete `Runtime` class.
 */
export interface ReconstructionContext {
  /**
   * Resolve a cell reference. Used by `Cell[RECONSTRUCT]` and similar types
   * that need to intern or look up existing instances.
   */
  getCell(ref: { id: string; path: string[]; space: string }): StorableInstance;
}
```

> **Why an interface, not the concrete `Runtime`?** The storable protocol is
> intended to live in a foundational package (`packages/common/` or
> `packages/memory/`). If `[RECONSTRUCT]` depended on the full `Runtime` type
> from `packages/runner/`, it would create a circular dependency. The
> `ReconstructionContext` interface captures the minimal surface needed for
> reconstruction. The `Runtime` class satisfies this interface. Future
> storable types may extend `ReconstructionContext` if they need additional
> capabilities beyond `getCell`.

### 2.6 Brand Detection

```typescript
// file: packages/common/storable-protocol.ts

/**
 * Type guard: checks whether a value implements the storable protocol.
 * The presence of `[DECONSTRUCT]` is the brand.
 */
export function isStorable(value: unknown): value is StorableInstance {
  return value != null
    && typeof value === 'object'
    && DECONSTRUCT in value;
}
```

### 2.7 Example: Cell

```typescript
// file: packages/runner/src/cell.ts (illustrative stub -- simplified from the
// actual `Cell` class, which has additional overloads and parameters)

import {
  DECONSTRUCT,
  RECONSTRUCT,
  type StorableInstance,
  type StorableClass,
  type ReconstructionContext,
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
    context: ReconstructionContext,
  ): Cell<unknown> {
    // May return an existing `Cell` instance (interning).
    return context.getCell(state) as Cell<unknown>;
  }
}
```

### 2.8 Deconstructed State and Recursion

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

### 2.9 Reconstruction Guarantees

The system follows an **immutable-forward** design:

- **Plain objects and arrays** are frozen (`Object.freeze()`) upon
  reconstruction.
- **`StorableInstance`s** should ideally be frozen as well -- this is the north
  star, though not yet a strict requirement.
- **No distinction** is made between regular and null-prototype plain objects;
  reconstruction always produces regular plain objects.

This immutability guarantee enables safe sharing of reconstructed values and
aligns with the reactive system's assumption that values don't mutate in place.

> **Frozen built-in types.** `Object.freeze()` does not enforce immutability on
> `Map`, `Set`, `Date`, or `Uint8Array` -- their mutation methods remain
> callable on a frozen instance. To uphold the immutable-forward guarantee for
> these types, the implementation should provide frozen-wrapper types (e.g.,
> `FrozenMap`, `FrozenSet`) that expose read-only interfaces and throw on
> mutation attempts. The reconstructed value for a `Map` would be a `FrozenMap`
> instance (which extends or wraps `Map`), and similarly for other mutable
> built-in types. The exact API for these wrappers is an implementation
> decision.

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
  type ReconstructionContext,
} from './storable-protocol';

/**
 * Holds an unrecognized type's data for round-tripping. The serialization
 * system has special knowledge of this class: on deserialization of an unknown
 * tag, it wraps the tag and state here; on re-serialization, it uses the
 * preserved `typeTag` to produce the original wire format.
 */
export class UnknownStorable implements StorableInstance {
  constructor(
    /** The original type tag, e.g. `"FutureType@2"`. */
    readonly typeTag: string,
    /** The raw state, already recursively processed by the serializer. */
    readonly state: StorableValue,
  ) {}

  [DECONSTRUCT]() {
    return { type: this.typeTag, state: this.state };
  }

  static [RECONSTRUCT](
    state: { type: string; state: StorableValue },
    _context: ReconstructionContext,
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

### 4.2 SerializedForm

Each serialization context defines a `SerializedForm` -- the type of values in
its wire format. For the JSON context, this is:

```typescript
// file: packages/common/serialization-context.ts

/** JSON-compatible wire format value. */
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/**
 * The wire format for the JSON serialization context. Other contexts (e.g.,
 * CBOR) would define their own `SerializedForm`.
 */
type SerializedForm = JsonValue;
```

### 4.3 Interface

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

  /** Encode a tag and state into the format's wire representation. */
  encode(tag: string, state: SerializedForm): SerializedForm;

  /** Decode a wire representation into tag and state, or `null` if not a tagged value. */
  decode(data: SerializedForm): { tag: string; state: SerializedForm } | null;
}
```

### 4.4 Serialization Flow

```
Serialize:   instance.[DECONSTRUCT]() -> state -> context.encode(tag, state) -> wire
Deserialize: wire -> context.decode() -> { tag, state } -> Class[RECONSTRUCT](state) -> instance
```

The recursive descent is handled by top-level `serialize()` and `deserialize()`
functions, not by the context or by individual types. See Section 4.5.

### 4.5 Top-Level Serialize/Deserialize

> **Export style:** Following the JS standard convention of capitalized namespace
> objects (cf. `Temporal`, `Atomics`), the `serialize()` and `deserialize()`
> functions should be exported as methods on a namespace object -- e.g.,
> `DataModel.serialize()` or `Serialization.serialize()`. The exact name is an
> implementation decision.

```typescript
// file: packages/common/serialization.ts

import { DECONSTRUCT, RECONSTRUCT, isStorable } from './storable-protocol';
import type { SerializationContext, SerializedForm } from './serialization-context';
import { UnknownStorable } from './unknown-storable';

/**
 * Serialize a storable value for boundary crossing. Recursively processes
 * nested values.
 */
export function serialize(
  value: StorableValue,
  context: SerializationContext,
): SerializedForm {
  // --- StorableInstance ---
  if (isStorable(value)) {
    const state = value[DECONSTRUCT]();
    const tag = context.getTagFor(value);
    const serializedState = serialize(state, context); // recursive
    return context.encode(tag, serializedState);
  }

  // --- Built-in JS types ---
  // These types cannot implement [DECONSTRUCT] via symbol, so the serializer
  // handles them explicitly. Each is decomposed into essential state, nested
  // values are recursively serialized, and the result is wrapped with the
  // appropriate tag.

  if (value instanceof Error) {
    const state: Record<string, SerializedForm> = {
      name:    serialize(value.name, context),
      message: serialize(value.message, context),
    };
    if (value.stack !== undefined) {
      state.stack = serialize(value.stack, context);
    }
    if (value.cause !== undefined) {
      state.cause = serialize(value.cause as StorableValue, context);
    }
    // Copy custom enumerable properties.
    for (const key of Object.keys(value)) {
      if (!(key in state)) {
        state[key] = serialize((value as Record<string, unknown>)[key] as StorableValue, context);
      }
    }
    return context.encode('Error@1', state);
  }

  if (value instanceof Map) {
    const entries = [...value.entries()].map(
      ([k, v]) => [serialize(k, context), serialize(v, context)] as SerializedForm,
    );
    return context.encode('Map@1', entries);
  }

  if (value instanceof Set) {
    const elements = [...value].map((v) => serialize(v, context));
    return context.encode('Set@1', elements);
  }

  if (value instanceof Uint8Array) {
    // Base64 encoding produces a string; no recursion needed.
    return context.encode('Bytes@1', base64Encode(value));
  }

  if (value instanceof Date) {
    return context.encode('Date@1', value.toISOString());
  }

  if (typeof value === 'bigint') {
    return context.encode('BigInt@1', value.toString());
  }

  // --- `undefined` ---
  // `undefined` is not a valid `SerializedForm` (`JsonValue`). Per Section 1.3,
  // it becomes `null` in arrays, is omitted for object properties (handled by
  // the caller's `val !== undefined` check), and signals deletion at top level.
  // In all cases the serialized representation is `null`.
  if (value === undefined) {
    return null;
  }

  // --- Primitives ---
  if (value === null || typeof value === 'boolean'
      || typeof value === 'number' || typeof value === 'string') {
    // Primitives pass through to the wire format directly.
    return value as SerializedForm;
  }

  // --- Arrays ---
  if (Array.isArray(value)) {
    return value.map((element) => serialize(element, context)) as SerializedForm;
  }

  // --- Plain objects ---
  const result: Record<string, SerializedForm> = {};
  for (const [key, val] of Object.entries(value as Record<string, StorableValue>)) {
    if (val !== undefined) {
      result[key] = serialize(val, context);
    }
  }

  // Apply `/object` escaping per Section 5.6: if the result has exactly one
  // key and that key starts with `/`, wrap in `{ "/object": ... }` so the
  // deserializer does not misinterpret it as a tagged type.
  const keys = Object.keys(result);
  if (keys.length === 1 && keys[0].startsWith('/')) {
    return { '/object': result } as SerializedForm;
  }

  return result;
}

/**
 * Deserialize a wire-format value back into rich runtime types. Requires
 * a `ReconstructionContext` for reconstituting types that need runtime
 * context (e.g., `Cell` interning).
 */
export function deserialize(
  data: SerializedForm,
  context: SerializationContext,
  runtime: ReconstructionContext,
): StorableValue {
  const decoded = context.decode(data);
  if (decoded !== null) {
    const { tag, state } = decoded;
    const cls = context.getClassFor(tag);
    const deserializedState = deserialize(state, context, runtime); // recursive
    if (cls) {
      return cls[RECONSTRUCT](deserializedState, runtime);
    }
    // Unknown type: preserve for round-tripping via `UnknownStorable`.
    return UnknownStorable[RECONSTRUCT](
      { type: tag, state: deserializedState },
      runtime,
    );
  }

  // Primitives pass through.
  if (data === null || typeof data === 'boolean'
      || typeof data === 'number' || typeof data === 'string') {
    return data;
  }

  // Arrays: recursively deserialize elements.
  if (Array.isArray(data)) {
    return Object.freeze(data.map((element) => deserialize(element, context, runtime)));
  }

  // Plain objects: recursively deserialize values, then freeze.
  const result: Record<string, StorableValue> = {};
  for (const [key, val] of Object.entries(data)) {
    result[key] = deserialize(val, context, runtime);
  }
  return Object.freeze(result);
}
```

### 4.6 Separation of Concerns

This architecture enables:

- **Protocol versioning**: Same class, different tags in v1 vs v2.
- **Format flexibility**: JSON context vs CBOR context vs Automerge context.
- **Migration paths**: Old context reads legacy format, new context writes
  modern format.
- **Testing**: Mock contexts for unit tests.

### 4.7 Serialization Boundaries

The boundaries where serialization occurs:

| Boundary | Packages | Direction |
|----------|----------|-----------|
| **Persistence** | `memory` <-> database | read/write |
| **Iframe sandbox** | `runner` <-> `iframe-sandbox` | postMessage |
| **Background service** | `shell` <-> `background-charm-service` | worker messages |
| **HTML reconciler** | `html` reconciler (runs in a web worker) | worker messages |
| **Network sync** | `toolshed` <-> remote peers | WebSocket/HTTP |
| **Cross-space** | space A <-> space B | if in separate processes |

Each boundary uses a serialization context appropriate to its format and
version requirements.

> **Note:** The `html` package reconciler (`html/src/worker/reconciler.ts`)
> calls `convertCellsToLinks` in a web worker context. Threading serialization
> options to this call site requires worker-initialization-time configuration,
> since the reconciler does not have direct access to a `Runtime` instance.

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
- `@<Version>` -- version number (natural number, starting at 1)

This convention does **not** prohibit storing plain objects that happen to have
`/`-prefixed keys. The escaping mechanism in Section 5.6 (`/object` and
`/quote`) handles this case: during serialization, plain objects whose shape
would be ambiguous with a tagged type are automatically wrapped so they
round-trip correctly.

### 5.3 Standard Type Encodings

```typescript
// file: packages/common/json-encoding.ts (illustrative -- tag-to-format map)

/**
 * Standard JSON encodings for all built-in special types.
 *
 * In each case, the tag string (e.g. `"Link@1"`) is passed to the context's
 * `encode()` method, which prepends `/` to produce the JSON key
 * (e.g. `"/Link@1"`).
 */

// Cell references (links to other documents)
// Tag: "Link@1"
// { "/Link@1": { id: string, path: string[], space: string } }

// Errors
// Tag: "Error@1"
// { "/Error@1": { name: string, message: string, stack?: string, cause?: ..., ... } }

// Stream markers (stateless -- value is null)
// Tag: "Stream@1"
// { "/Stream@1": null }

// Maps (entry pairs preserve insertion order)
// Tag: "Map@1"
// { "/Map@1": [[key, value], ...] }

// Sets (values preserve insertion order)
// Tag: "Set@1"
// { "/Set@1": [value, ...] }

// Binary data (base64-encoded)
// Tag: "Bytes@1"
// { "/Bytes@1": string }

// Dates (ISO 8601 UTC)
// Tag: "Date@1"
// { "/Date@1": string }

// BigInts (decimal string representation)
// Tag: "BigInt@1"
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

Both `null` and `{}` are acceptable for "no state needed." `null` is the
conventional choice, as it is slightly more idiomatic for signaling absence.
The distinction between "`null` state" and "no state needed" is implied by the
type being represented, not by the wire encoding.

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

**When the serializer emits `/object`:** During serialization, if a plain object
has exactly one string key that starts with `/`, the serializer wraps it in
`/object` to prevent the deserializer from misinterpreting it as a tagged type.
If the object has multiple keys, no wrapping is needed (since tagged types
always have exactly one key).

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

The JSON serialization context's `encode()` and `decode()` methods generate and
parse `/<Type>@<Version>` keys. The context is also responsible for:

- Wrapping unknown types using the `typeTag` preserved in `UnknownStorable`.

Note: `/object` escaping (Section 5.6) is applied directly by `serialize()`
in its plain-objects path, not by the context, since it is structural escaping
rather than type encoding.

### 5.8 Unknown Type Handling

When a JSON context encounters a `/<Type>@<Version>` key it doesn't recognize,
it wraps the data in `UnknownStorable` (see Section 3) to preserve it for
round-tripping.

---

## 6. Canonical Hashing

### 6.1 Overview

The system uses canonical hashing for content-based identity. The hashing
scheme operates directly on the natural data structure without intermediate
tree construction.

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
 * The digest algorithm is a parameter of the hashing context. The system
 * must support at least:
 * - **SHA-256** -- required; the default for most contexts.
 * - **BLAKE2b** -- recommended as a second supported algorithm (faster in
 *   software, same security margin).
 *
 * Specific hashing contexts (e.g., recipe ID generation vs. request
 * deduplication) specify which algorithm is used in that context.
 *
 * Output format depends on context. Base64 with the standard alphabet
 * (`A-Za-z0-9+/` with `=` padding) is recommended as the default.
 */
export function canonicalHash(
  value: StorableValue,
  algorithm?: 'sha256' | 'blake2b',
): string {
  // Type tag bytes (single-byte prefixes to prevent cross-type collisions):
  //
  // TAG_NULL       = 0x00
  // TAG_BOOL       = 0x01
  // TAG_NUMBER     = 0x02
  // TAG_STRING     = 0x03
  // TAG_BIGINT     = 0x04
  // TAG_UNDEFINED  = 0x05
  // TAG_BYTES      = 0x06
  // TAG_DATE       = 0x07
  // TAG_ERROR      = 0x08
  // TAG_MAP        = 0x09
  // TAG_SET        = 0x0A
  // TAG_ARRAY      = 0x0B
  // TAG_OBJECT     = 0x0C
  // TAG_STORABLE   = 0x0D
  //
  // Implementation feeds type-tagged data into the hasher:
  //
  // - `null`:              hash(TAG_NULL)
  // - `boolean`:           hash(TAG_BOOL, boolByte)
  // - `number`:            hash(TAG_NUMBER, ieee754Float64Bytes)
  // - `string`:            hash(TAG_STRING, utf8Bytes)
  // - `bigint`:            hash(TAG_BIGINT, signedTwosComplementBytes)
  // - `undefined`:         hash(TAG_UNDEFINED)
  // - `Uint8Array`:        hash(TAG_BYTES, rawBytes)
  // - `Date`:              hash(TAG_DATE, int64MillisSinceEpoch)
  // - `Error`:             hash(TAG_ERROR, canonicalHash(errorState))
  // - `Map`:               hash(TAG_MAP, sortedEntries)
  //                        where entries are sorted by canonicalHash(key)
  //                        (NOT by insertion order -- hashing is order-independent)
  // - `Set`:               hash(TAG_SET, sortedElements)
  //                        where elements are sorted by canonicalHash(element)
  //                        (NOT by insertion order -- hashing is order-independent)
  // - array:               hash(TAG_ARRAY, length, ...canonicalHash(element))
  //                        (order-preserving)
  // - object:              hash(TAG_OBJECT, sortedKeys, ...canonicalHash(value))
  //                        (keys sorted lexicographically by UTF-8)
  // - `StorableInstance`:  hash(TAG_STORABLE, typeTag, canonicalHash(deconstructedState))
  //
  // Each type is tagged to prevent collisions between types with
  // identical content representations.
}
```

> **Map/Set ordering: serialization vs. hashing.** Serialized form (Section 1.4)
> preserves insertion order for `Map` and `Set`, which matters for
> round-tripping. Canonical hashing (this section) sorts entries/elements by
> hash, which makes the hash order-independent. These are not contradictory:
> serialization preserves what the user put in; hashing normalizes for identity
> comparison.

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

## 7. Implementation Guidance

### 7.1 Adopting Late Serialization

Migration to the spec involves replacing early JSON-form conversion with
boundary-only serialization:

1. Expand `StorableValue` to include rich types (Section 1.2).
2. Remove early conversion points (e.g., `convertCellsToLinks()`,
   `toStorableValue()` wrapping `Error` as `{ "@Error": ... }`).
3. Introduce `SerializationContext` at each boundary (Section 4.7).
4. Update internal code to work with rich types rather than JSON shapes.

> **`toJSON()` migration:** Types that currently use `toJSON()` for
> serialization will need to implement the storable protocol
> (`[DECONSTRUCT]`/`[RECONSTRUCT]`) instead. The `toJSON()` approach eagerly
> converts to JSON-compatible shapes, which is incompatible with late
> serialization. Implementors should replace `toJSON()` methods with
> `[DECONSTRUCT]` (returning essential state as rich types) and add a static
> `[RECONSTRUCT]` method on the class.

### 7.2 Unifying JSON Encoding

Three legacy conventions in the current codebase must be migrated to the unified
`/<Type>@<Version>` format:

| Legacy Convention | Where Used | Example | New Form |
|-------------------|------------|---------|----------|
| IPLD sigil | Links (`sigil-types.ts`) | `{ "/": { "link@1": { id, path, space } } }` | `{ "/Link@1": { id, path, space } }` |
| `@` prefix | Errors (`storable-value.ts`) | `{ "@Error": { name, message, ... } }` | `{ "/Error@1": { name, message, ... } }` |
| `$` prefix | Streams (`builder/types.ts`) | `{ "$stream": true }` | `{ "/Stream@1": null }` |

### 7.3 Replacing CID-Based Hashing

The canonical hashing approach (Section 6) replaces `merkle-reference` /
CID-based hashing. Since the system does not participate in the IPFS network,
CID formatting adds overhead without interoperability benefit. The canonical
hash operates on the logical data structure directly.

---

## Appendix A: Open Design Decisions

These questions may need resolution during implementation but do not block the
spec from being implementable.

- **Comparison semantics for rich types**: Should equality be by identity, by
  deconstructed state (or as if by deconstructed state -- an implementation need
  not actually run a deconstructor), or configurable? This affects both runtime
  comparisons (e.g., in reactive system change detection) and `Map`/`Set` key
  behavior. Recommendation: start with identity semantics (the JS default) and
  revisit if structural equality is needed for specific use cases.

- **`ProblematicStorable` for partial failures**: A `ProblematicStorable` type
  (analogous to `UnknownStorable`) should be introduced for cases where
  deconstruction or reconstruction fails partway through. This allows graceful
  degradation rather than hard failures -- e.g., a type whose `[RECONSTRUCT]`
  throws can be preserved as a `ProblematicStorable` with the original tag,
  state, and error information, enabling round-tripping and debugging. The
  exact API is an implementation decision, but the type should preserve the
  original tag, the raw state, and a description of the failure.

- **Type registry management**: How are serialization contexts configured? Static
  registration? Dynamic discovery? Who owns the registry? The isolation
  strategy (see `coordination/docs/isolation-strategy.md`) proposes
  per-`Runtime` configuration via `ExperimentalOptions`, which provides a
  natural place for registry configuration per runtime instance.

- **Schema integration**: Each `StorableInstance` type implies a schema for its
  deconstructed state. How does this integrate with the schema language?
  Currently out of scope (schemas are listed as out-of-scope for this spec).

- **Cycle detection in deconstructed state**: Cycle detection is the
  responsibility of the serialization system, not individual `[DECONSTRUCT]`
  implementations. The `serialize()` function tracks visited objects during
  recursion and throws on cycles, analogous to how `toDeepStorableValue()` does
  today. Many serializers won't even admit circularity as a possibility in the
  first place. (Resolved -- retained here for context.)

- **Exact canonical hash specification**: Precise byte-level specification of
  the hash algorithm (type tags, encoding of each type, handling of special
  cases like `-0` normalization). This should be specified as a separate
  document or appendix before the hashing implementation begins.

- **Hash output format**: ~~Resolved.~~ Base64 with the standard alphabet is
  recommended as the default output format. The specific format may vary by
  context (see Section 6.3).

- **Migration path**: Out of scope for this spec. The detailed migration plan
  (sequencing of flag introductions, criteria for graduating each flag to
  default-on) will be addressed in a separate document.

- **`ReconstructionContext` extensibility**: The minimal interface defined in
  Section 2.5 covers `Cell` reconstruction. Other future storable types may
  need additional context methods. Should the interface be extended, or should
  types cast to a broader interface? Recommendation: extend the interface as
  needed; the indirection through an interface (rather than depending on
  `Runtime` directly) makes this straightforward.
