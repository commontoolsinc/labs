# Storable Values

This document specifies the immutable data representation for the Space Model:
what values can be stored, how custom types participate in serialization, and how
values are identified by content.

## Status

Draft formal spec — extracted from the data model proposal.

---

## 1. Storable Value Types

### 1.1 Overview

The system stores **storable values** — data that can flow through the runtime
as rich types and be serialized to wire/storage formats at boundary crossings.
All persistent data and in-flight messages use this representation.

The key design principle is **late serialization**: rich types flow through the
runtime as themselves; serialization to wire/storage formats happens only at
boundary crossings (persistence, IPC, network).

#### Three-Layer Architecture

The data model is organized into three explicit layers:

```
JavaScript "wild west" (unknown/any) <-> Strongly typed (StorableValue) <-> Serialized (Uint8Array)
```

- **Left layer — JS wild west.** Arbitrary JavaScript values (`unknown`/`any`),
  including native objects like `Error`, `Map`, `Set`, `Date`, and `Uint8Array`.
  Code in this layer has no type guarantees about what it is handling.

- **Middle layer — `StorableValue`.** The strongly typed core of the data model.
  Contains only primitives, `StorableInstance` implementations (including wrapper
  classes for native JS types), and recursive containers. No raw native JS
  objects appear at this layer — they are wrapped into `StorableInstance`
  implementations by the conversion functions (Section 8).

- **Right layer — Serialized form.** The wire/storage representation
  (`Uint8Array` for binary formats, JSON-compatible trees for the JSON context).
  Serialization operates exclusively on `StorableValue` input; it never sees raw
  native JS objects.

Conversion functions bridge the left and middle layers:
`toStorableValue()` / `toDeepStorableValue()` convert from JS values to
`StorableValue`, wrapping native objects into `StorableInstance` wrappers and
freezing the result. `nativeValueFromStorableValue()` converts back, unwrapping
`StorableInstance` wrappers to their native JS equivalents. See Section 8 for
the full specification of these functions.

### 1.2 Type Universe

A `StorableValue` is defined as the following union. This is the **middle
layer** — the strongly typed core. Raw native JS objects (`Error`, `Map`, `Set`,
`Date`, `Uint8Array`) do not appear here; they are handled by the conversion
layer (Section 8) and represented in `StorableValue` trees as `StorableInstance`
wrapper classes (Section 1.4).

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
 * persistently, or be transmitted across boundaries. This is the "middle
 * layer" of the three-layer architecture — no raw native JS objects appear
 * here.
 */
type StorableValue =
  // (a) Primitives
  | null
  | boolean
  | number    // finite only; `NaN` and `Infinity` rejected
  | string
  | undefined // first-class storable; requires tagged representation in formats lacking native `undefined`
  | bigint    // large integers; rides through without wrapping (like `undefined`)

  // (b) Branded storables (custom types implementing the storable protocol)
  //     This arm covers:
  //       - Native object wrappers: `StorableError`, `StorableMap`,
  //         `StorableSet`, `StorableDate`, `StorableUint8Array` (Section 1.4)
  //       - User-defined types: `Cell`, `Stream`, etc.
  //       - System types: `UnknownStorable`, `ProblematicStorable`
  | StorableInstance

  // (c) Recursive containers
  | StorableValue[]
  | { [key: string]: StorableValue };
```

#### `StorableNativeObject`

A separate type — **outside** the `StorableValue` hierarchy — defines the raw
native JS object types that the conversion layer can handle:

```typescript
// file: packages/common/storable-value.ts

/**
 * Union of raw native JS object types that the conversion layer can translate
 * to and from `StorableValue`. These types sit outside the `StorableValue`
 * hierarchy and only appear at conversion function boundaries (Section 8).
 *
 * Primitives like `bigint` and `undefined` are NOT included — they are
 * directly part of `StorableValue`. The wrapper classes (`StorableError`,
 * `StorableMap`, etc.) are also NOT this type — they are `StorableInstance`
 * implementations that live inside `StorableValue`.
 */
type StorableNativeObject =
  | Error
  | Map<StorableValue | StorableNativeObject, StorableValue | StorableNativeObject>
  | Set<StorableValue | StorableNativeObject>
  | Date
  | Uint8Array;
```

The `StorableNativeObject` type exists solely at function parameter/return
boundaries — for example, `toStorableValue()` accepts
`StorableValue | StorableNativeObject` as input (Section 8). It is never a
member of `StorableValue` or `StorableDatum`.

### 1.3 Primitive Types

| Type | Constraints | Notes |
|------|-------------|-------|
| `null` | None | The null value |
| `boolean` | None | `true` or `false` |
| `number` | Must be finite | `-0` normalized to `0`; `NaN`/`Infinity` rejected |
| `string` | None | Unicode text |
| `undefined` | None | First-class storable; see note below |
| `bigint` | None | Large integers; see Section 5.3 for JSON encoding |

> **`undefined` as a first-class storable.** `undefined` is a first-class
> storable value that round-trips faithfully through serialization. Because most
> wire formats (including JSON) have no native `undefined` representation, the
> serialization system uses a dedicated tagged form for `undefined` — the same
> tagged form regardless of context (array element, object property value, or
> top-level value). See Section 5.3 for the specific JSON encoding. Deletion
> semantics (e.g., removing a cell's value when `undefined` is written at top
> level) are an application-level concern, not a serialization concern: the
> serializer faithfully records `undefined` and the application layer interprets
> the result.

> **`-0` normalization:** Negative zero (`-0`) is normalized to positive zero
> (`0`) during storable-value conversion (i.e., `toStorableValue()`), before the
> value reaches a serialization boundary. This matches `JSON.stringify` behavior
> and ensures that `0` and `-0` produce the same serialized form and canonical
> hash. In the current codebase, this normalization happens in
> `packages/memory/storable-value.ts` at the `toStorableValue()` call site.

> **Future: `-0` and non-finite numbers.** The current design normalizes `-0`
> and rejects `NaN`/`Infinity`/`-Infinity`. Because the serialization system
> uses typed tags (Section 5), a future version could represent these values
> with full fidelity via dedicated type tags, without ambiguity. This option is
> preserved by the architecture but not currently needed.

### 1.4 Native Object Wrapper Classes

Certain built-in JS types (`Error`, `Map`, `Set`, `Date`, `Uint8Array`) cannot
have `Symbol`-keyed methods added via prototype patching in a reliable,
cross-realm way. Rather than handling them with special-case logic in the
serializer, the system defines **wrapper classes** — one per native type — that
implement `StorableInstance`. The conversion layer (Section 8) wraps raw native
objects into these classes when bridging from the JS wild west to `StorableValue`,
and unwraps them when bridging back.

Because each wrapper genuinely implements `StorableInstance` (with real
`[DECONSTRUCT]` and `[RECONSTRUCT]` methods), the serialization system
processes them through the same uniform `StorableInstance` path — no special
cases needed in the serializer. The hashing system also uses the standard
`TAG_STORABLE` path for most wrappers, but optimizes `StorableDate` and
`StorableUint8Array` with dedicated `TAG_DATE` and `TAG_BYTES` tags for
content-level identity (see Section 6.3).

#### 1.4.1 Wrapper Class Summary

| Wrapper Class | Wraps | Type Tag | Deconstructed State | Notes |
|---------------|-------|----------|---------------------|-------|
| `StorableError` | `Error` | `Error@1` | `{ name, message, stack?, cause?, ...custom }` | Captures `name`, `message`, `stack` (if present), `cause` (if present), and custom enumerable properties. The conversion layer (Section 8.2) recursively converts nested values (including `cause` and custom properties) before wrapping, ensuring all values are `StorableValue` when `[DECONSTRUCT]` runs. |
| `StorableMap` | `Map` | `Map@1` | `[[key, value], ...]` | Entry pairs as an array of two-element arrays. Insertion order is preserved. Keys and values are recursively processed. |
| `StorableSet` | `Set` | `Set@1` | `[value, ...]` | Elements as an array. Iteration order is preserved. Values are recursively processed. |
| `StorableDate` | `Date` | `Date@1` | `string` (ISO 8601 UTC) | Deconstructed state is a string — the serializer recurses into it and finds a primitive. |
| `StorableUint8Array` | `Uint8Array` | `Bytes@1` | `string` (base64-encoded) | Deconstructed state is a string. |

Each wrapper class:

- **Implements `StorableInstance`** with a `[DECONSTRUCT]` method that extracts
  essential state from the wrapped native object.
- **Has a static `[RECONSTRUCT]` method** (following the `StorableClass<T>`
  pattern) that returns an instance of the wrapper class — **not** the raw
  native type. Callers who need the underlying native object use
  `nativeValueFromStorableValue()` (Section 8) to unwrap it.
- **Carries a `typeTag` property** (e.g., `"Error@1"`) used by the
  serialization context for tag resolution, following the pattern established
  by `UnknownStorable` and `ProblematicStorable`.

#### Extra Enumerable Properties

**`StorableError`** MAY carry extra enumerable properties beyond the standard
fields (`name`, `message`, `stack`, `cause`). Custom properties on `Error`
objects are common JavaScript practice (e.g., `error.code`, `error.statusCode`),
so `StorableError` preserves them: `[DECONSTRUCT]` includes them in its output,
and `[RECONSTRUCT]` restores them on the reconstructed `Error`.

**`StorableMap`, `StorableSet`, `StorableDate`, `StorableUint8Array`** must NOT
carry extra enumerable properties. Their `[DECONSTRUCT]` output contains only the
essential native data (entries, items, timestamp, bytes respectively). Any extra
enumerable properties on the source native object are **silently dropped** during
conversion (Section 8.2) — the conversion layer does not copy them onto the
wrapper. This matches the treatment of arrays, where extra non-index properties
cause rejection (Section 1.5). The rationale is that unlike `Error`, the other
native types have no established convention for custom properties, and preserving
them would add complexity without clear use cases.

#### 1.4.2 `StorableError`

```typescript
// file: packages/common/storable-native-wrappers.ts

import {
  DECONSTRUCT, RECONSTRUCT,
  type StorableInstance, type ReconstructionContext,
} from './storable-protocol';

/**
 * Wrapper for native `Error` values. Implements `StorableInstance` so that
 * errors participate in the standard serialization and hashing paths.
 */
export class StorableError implements StorableInstance {
  readonly typeTag = 'Error@1';

  constructor(readonly error: Error) {}

  [DECONSTRUCT](): StorableValue {
    // IMPORTANT: By the time [DECONSTRUCT] is called, all nested values
    // must already be StorableValue. The conversion layer (Section 8.2)
    // is responsible for recursively converting Error internals (cause,
    // custom properties) BEFORE wrapping into StorableError. This method
    // simply extracts the already-converted state.
    const state: Record<string, StorableValue> = {
      name:    this.error.name,
      message: this.error.message,
    };
    if (this.error.stack !== undefined) {
      state.stack = this.error.stack;
    }
    if (this.error.cause !== undefined) {
      state.cause = this.error.cause as StorableValue;
    }
    for (const key of Object.keys(this.error)) {
      if (!(key in state) && key !== '__proto__' && key !== 'constructor') {
        state[key] = (this.error as Record<string, unknown>)[key] as StorableValue;
      }
    }
    return state as StorableValue;
  }

  static [RECONSTRUCT](
    state: StorableValue,
    _context: ReconstructionContext,
  ): StorableError {
    const s = state as Record<string, StorableValue>;
    const name = (s.name as string) ?? 'Error';
    const message = (s.message as string) ?? '';
    let error: Error;
    switch (name) {
      case 'TypeError':      error = new TypeError(message);      break;
      case 'RangeError':     error = new RangeError(message);     break;
      case 'SyntaxError':    error = new SyntaxError(message);    break;
      case 'ReferenceError': error = new ReferenceError(message); break;
      case 'URIError':       error = new URIError(message);       break;
      case 'EvalError':      error = new EvalError(message);      break;
      default:               error = new Error(message);          break;
    }
    if (error.name !== name) error.name = name;
    if (s.stack !== undefined) error.stack = s.stack as string;
    if (s.cause !== undefined) error.cause = s.cause;
    for (const key of Object.keys(s)) {
      if (!['name', 'message', 'stack', 'cause', '__proto__', 'constructor'].includes(key)) {
        (error as Record<string, unknown>)[key] = s[key];
      }
    }
    return new StorableError(error);
  }
}
```

#### 1.4.3 `StorableMap`

```typescript
export class StorableMap implements StorableInstance {
  readonly typeTag = 'Map@1';

  constructor(readonly map: Map<StorableValue, StorableValue>) {}

  [DECONSTRUCT](): StorableValue {
    return [...this.map.entries()] as StorableValue;
  }

  static [RECONSTRUCT](
    state: StorableValue,
    _context: ReconstructionContext,
  ): StorableMap {
    const entries = state as [StorableValue, StorableValue][];
    return new StorableMap(new Map(entries));
  }
}
```

#### 1.4.4 `StorableSet`

```typescript
export class StorableSet implements StorableInstance {
  readonly typeTag = 'Set@1';

  constructor(readonly set: Set<StorableValue>) {}

  [DECONSTRUCT](): StorableValue {
    return [...this.set] as StorableValue;
  }

  static [RECONSTRUCT](
    state: StorableValue,
    _context: ReconstructionContext,
  ): StorableSet {
    const elements = state as StorableValue[];
    return new StorableSet(new Set(elements));
  }
}
```

#### 1.4.5 `StorableDate`

```typescript
export class StorableDate implements StorableInstance {
  readonly typeTag = 'Date@1';

  constructor(readonly date: Date) {}

  [DECONSTRUCT](): StorableValue {
    return this.date.toISOString();
  }

  static [RECONSTRUCT](
    state: StorableValue,
    _context: ReconstructionContext,
  ): StorableDate {
    return new StorableDate(new Date(state as string));
  }
}
```

#### 1.4.6 `StorableUint8Array`

```typescript
export class StorableUint8Array implements StorableInstance {
  readonly typeTag = 'Bytes@1';

  constructor(readonly bytes: Uint8Array) {}

  [DECONSTRUCT](): StorableValue {
    return base64Encode(this.bytes);
  }

  static [RECONSTRUCT](
    state: StorableValue,
    _context: ReconstructionContext,
  ): StorableUint8Array {
    return new StorableUint8Array(base64Decode(state as string));
  }
}
```

#### 1.4.7 `bigint` — Not Wrapped

`bigint` is a JavaScript primitive (`typeof x === 'bigint'`), not an object. It
rides through the `StorableValue` layer directly, like `undefined`. No
`StorableBigInt` wrapper class is needed. The serialization layer handles
`bigint` with a dedicated handler (analogous to `UndefinedHandler`); see
Section 4.5.

#### 1.4.8 Design Notes

> **Why wrapper classes instead of inline serializer branches?** Each wrapper
> genuinely implements `StorableInstance`, so `isStorableInstance()` returns `true` for
> them. The serialization system dispatches all `StorableInstance` values through
> a single `StorableInstanceHandler` path — no per-type branches. This gives the
> serialization layer a uniform, simpler structure: it handles
> `StorableInstance`, `undefined`, `bigint`, and the structural types
> (arrays, objects, primitives), with no knowledge of specific native JS types.
>
> **Reconstruction returns the wrapper.** `StorableError[RECONSTRUCT]` returns
> a `StorableError`, not a raw `Error`. This is consistent with the three-layer
> separation: the middle layer (`StorableValue`) contains wrappers, not raw
> native objects. Code that needs the underlying native type uses
> `nativeValueFromStorableValue()` (Section 8) as a separate step.
>
> **File organization.** All five wrapper classes are expected to live in a
> single file (e.g., `storable-native-wrappers.ts`), since each is small
> (~30 lines) and they share the same imports.

### 1.5 Recursive Containers

**Arrays:**
- May be dense or sparse
- Elements may be `undefined` (a first-class storable; see Section 1.3)
- Sparse arrays (arrays with holes) are supported; holes are distinct from
  `undefined` and are represented using run-length encoding in serialized forms
  (see below and Section 5.3 for the specific JSON encoding)
- Non-index keys (named properties on arrays) cause rejection

> **Holes vs. `undefined`.** A hole (sparse slot) is distinct from an
> explicitly-set `undefined` element. Given `const a = [1, , 3]`, index `1` is
> a hole — `1 in a` is `false`. Given `const b = [1, undefined, 3]`, index `1`
> is an explicit `undefined` — `1 in b` is `true`. Both must round-trip
> faithfully:
>
> - Explicit `undefined` elements have a dedicated tagged representation in
>   serialized forms (distinct from `null`).
> - Holes have their own tagged representation, using run-length encoding:
>   each hole entry carries a positive integer count of consecutive holes.
>
> On deserialization, hole entries are reconstructed as true holes (absent
> indices in the resulting array, not `undefined` assignments), preserving the
> `in`-operator distinction. See Section 5.3 for the specific JSON encodings.

> **Array serialization strategy.** Even when an array contains holes, it is
> serialized as an array (not an object or other structure). Runs of consecutive
> holes are replaced by a single hole marker carrying the run length, preserving
> the array structure while efficiently encoding sparse arrays. See Section 5.3
> for the specific JSON encoding and examples.

**Objects:**
- Plain objects only (class instances must implement the storable protocol)
- Keys must be strings; symbol keys cause rejection
- Values must be storable; properties whose value is `undefined` are preserved
  (not omitted) — `undefined` is a first-class value, not a signal for deletion
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
 *
 * The native object wrapper classes (`StorableError`, `StorableMap`,
 * `StorableSet`, `StorableDate`, `StorableUint8Array`) implement this
 * interface, as do user-defined types (`Cell`, `Stream`) and system
 * types (`UnknownStorable`, `ProblematicStorable`).
 */
export interface StorableInstance {
  /**
   * Returns the essential state of this instance as a `StorableValue`. The
   * returned value may contain any `StorableValue`, including other
   * `StorableInstance`s, primitives, and plain objects/arrays.
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
export function isStorableInstance(value: unknown): value is StorableInstance {
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

The value returned by `[DECONSTRUCT]()` can contain any value that is itself a
`StorableValue` — including other `StorableInstance`s (such as native object
wrappers), primitives, and plain objects/arrays.

**The serialization system handles recursion, not the individual deconstructor
methods.** A `[DECONSTRUCT]` implementation returns its essential state without
recursively deconstructing nested values. The deconstructor does not have access
to the serialization machinery — by design, as it would be a layering
violation.

Similarly, `[RECONSTRUCT]` receives state where nested values have already been
reconstructed by the serialization system. Importantly, `[RECONSTRUCT]` returns
the **wrapper type**, not the raw native type. For example,
`StorableError[RECONSTRUCT]` returns a `StorableError` instance (which wraps an
`Error`), not a raw `Error`. Unwrapping to native types is a separate step via
`nativeValueFromStorableValue()` (Section 8).

### 2.9 Reconstruction Guarantees

The system follows an **immutable-forward** design:

- **Plain objects and arrays** are frozen (`Object.freeze()`) upon
  reconstruction. This applies to all `deserialize()` output paths, including
  `/quote` (Section 5.6) — the freeze is a property of the deserialization
  boundary, not of whether type-tag reconstruction occurred.
- **`StorableInstance`s** should ideally be frozen as well — this is the north
  star, though not yet a strict requirement.
- **No distinction** is made between regular and null-prototype plain objects;
  reconstruction always produces regular plain objects.

This immutability guarantee enables safe sharing of reconstructed values and
aligns with the reactive system's assumption that values don't mutate in place.

> **Immutability of native object wrappers.** Under the three-layer
> architecture, deserialization produces `StorableInstance` wrappers
> (`StorableMap`, `StorableSet`, etc.), not raw native types. Because the
> system controls the shape of these wrapper classes, they can be properly
> frozen with `Object.freeze()` — unlike the native types they wrap (e.g.,
> `Object.freeze()` on a `Map` does not prevent mutation via `set()`/`delete()`).
> The underlying native objects stored inside wrappers (e.g.,
> `StorableMap.map`) are not directly exposed to consumers of `StorableValue`
> — callers who need the native types use `nativeValueFromStorableValue()`
> (Section 8), which returns `FrozenMap` and `FrozenSet`
> (effectively-immutable wrappers) for collection types, preserving the
> immutability guarantee even after unwrapping.

---

## 3. Unknown Types

### 3.1 Overview

When deserializing, a context may encounter a type tag it doesn't recognize —
for example, data written by a newer version of the system. Unknown types are
**passed through** rather than rejected, preserving forward compatibility.

### 3.2 `UnknownStorable`

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

### 3.4 `ProblematicStorable` (Recommended)

It is recommended that implementations provide a `ProblematicStorable` type,
analogous to `UnknownStorable`, for cases where deconstruction or reconstruction
fails partway through. This allows graceful degradation rather than hard
failures — for example, a type whose `[RECONSTRUCT]` throws can be preserved as
a `ProblematicStorable` with the original tag, state, and error information.

```typescript
// file: packages/common/problematic-storable.ts

import {
  DECONSTRUCT,
  RECONSTRUCT,
  type StorableInstance,
  type ReconstructionContext,
} from './storable-protocol';

/**
 * Holds a value whose deconstruction or reconstruction failed. Preserves
 * the original tag and raw state for round-tripping and debugging.
 */
export class ProblematicStorable implements StorableInstance {
  constructor(
    /** The original type tag, e.g. `"MyType@1"`. */
    readonly typeTag: string,
    /** The raw state that could not be processed. */
    readonly state: StorableValue,
    /** A description of what went wrong. */
    readonly error: string,
  ) {}

  [DECONSTRUCT]() {
    return { type: this.typeTag, state: this.state, error: this.error };
  }

  static [RECONSTRUCT](
    state: { type: string; state: StorableValue; error: string },
    _context: ReconstructionContext,
  ): ProblematicStorable {
    return new ProblematicStorable(state.type, state.state, state.error);
  }
}
```

Like `UnknownStorable`, a `ProblematicStorable` round-trips through
serialization, preserving the original data so it is not silently lost. The
`error` field aids debugging by recording what went wrong. Whether to wrap
failures in `ProblematicStorable` or to throw is an implementation decision that
may vary by context — strict contexts (e.g., tests) may prefer to throw, while
lenient contexts (e.g., production reconstruction) may prefer graceful
degradation.

---

## 4. Serialization Contexts

### 4.1 Overview

Classes provide the *capability* to serialize via the storable protocol, but
they don't own the wire format. A **serialization context** owns the mapping
between classes and wire format tags, and handles format-specific
encoding/decoding.

### 4.2 SerializedForm

Each serialization context defines a `SerializedForm` — the type of values in
its wire format. For the JSON context, this is:

```typescript
// file: packages/common/serialization-context.ts

/** JSON-compatible wire format value. */
type JsonWireValue = null | boolean | number | string | JsonWireValue[] | { [key: string]: JsonWireValue };

/**
 * The wire format for the JSON serialization context. Other contexts (e.g.,
 * CBOR) would define their own `SerializedForm`.
 */
type SerializedForm = JsonWireValue;
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
> functions should be exported as methods on a namespace object — e.g.,
> `DataModel.serialize()` or `Serialization.serialize()`. The exact name is an
> implementation decision.

```typescript
// file: packages/common/serialization.ts

import { DECONSTRUCT, RECONSTRUCT, isStorableInstance } from './storable-protocol';
import type { SerializationContext, SerializedForm } from './serialization-context';
import { UnknownStorable } from './unknown-storable';

/**
 * Serialize a storable value for boundary crossing. Recursively processes
 * nested values.
 *
 * The input is `StorableValue`, which belongs to the middle layer of the
 * three-layer architecture. Raw native JS objects (`Error`, `Map`, etc.)
 * never reach this function — they are wrapped into `StorableInstance`
 * wrappers by the conversion layer (Section 8) before serialization.
 */
export function serialize(
  value: StorableValue,
  context: SerializationContext,
): SerializedForm {
  // --- StorableInstance ---
  // This arm handles ALL storable instances uniformly: user-defined types
  // (Cell, Stream), system types (UnknownStorable, ProblematicStorable),
  // AND native object wrappers (StorableError, StorableMap, StorableSet,
  // StorableDate, StorableUint8Array). No per-type branches needed.
  if (isStorableInstance(value)) {
    const state = value[DECONSTRUCT]();
    const tag = context.getTagFor(value);
    const serializedState = serialize(state, context); // recursive
    return context.encode(tag, serializedState);
  }

  // --- `bigint` ---
  // A primitive that rides through `StorableValue` without wrapping (like
  // `undefined`). Needs a dedicated handler since JSON has no native bigint.
  if (typeof value === 'bigint') {
    return context.encode('BigInt@1', value.toString());
  }

  // --- `undefined` ---
  // Serialized as a tagged type. Per Section 1.3, `undefined` always uses its
  // dedicated tagged representation regardless of context.
  if (value === undefined) {
    return context.encode('Undefined@1', null);
  }

  // --- Primitives ---
  if (value === null || typeof value === 'boolean'
      || typeof value === 'number' || typeof value === 'string') {
    // Primitives pass through to the wire format directly.
    return value as SerializedForm;
  }

  // --- Arrays ---
  // Sparse arrays are supported: runs of consecutive holes (absent indices)
  // are serialized as a single `hole` entry whose state is the run length
  // (a positive integer). This is distinct from explicit `undefined`
  // (serialized as `Undefined@1`). See Section 1.5.
  if (Array.isArray(value)) {
    const result: SerializedForm[] = [];
    let i = 0;
    while (i < value.length) {
      if (!(i in value)) {
        // Count consecutive holes starting at index `i`.
        let count = 0;
        while (i < value.length && !(i in value)) {
          count++;
          i++;
        }
        result.push(context.encode('hole', count));
      } else {
        result.push(serialize(value[i], context));
        i++;
      }
    }
    return result as SerializedForm;
  }

  // --- Plain objects ---
  // All enumerable own properties are serialized, including those whose value
  // is `undefined` (which serializes as `Undefined@1` per Section 1.3).
  const result: Record<string, SerializedForm> = {};
  for (const [key, val] of Object.entries(value as Record<string, StorableValue>)) {
    result[key] = serialize(val, context);
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
 *
 * The output is `StorableValue`. Native object types (Error, Map, etc.)
 * are reconstructed as their wrapper classes (`StorableError`, `StorableMap`,
 * etc.) via the standard `StorableInstance` class registry path. Callers who
 * need the underlying native objects use `nativeValueFromStorableValue()`
 * (Section 8) as a separate step.
 */
export function deserialize(
  data: SerializedForm,
  context: SerializationContext,
  runtime: ReconstructionContext,
): StorableValue {
  const decoded = context.decode(data);
  if (decoded !== null) {
    const { tag, state } = decoded;

    // `/object` unwrapping (Section 5.6): strip the wrapper and take the
    // inner object's keys literally; inner values go through normal
    // deserialization.
    if (tag === 'object') {
      const inner = state as Record<string, SerializedForm>;
      const result: Record<string, StorableValue> = {};
      for (const [key, val] of Object.entries(inner)) {
        result[key] = deserialize(val, context, runtime);
      }
      return Object.freeze(result);
    }

    // `/quote` literal handling (Section 5.6): return the inner value with
    // no deserialization of nested special forms. Deep-freeze arrays and
    // plain objects to uphold the immutability guarantee (Section 2.9).
    if (tag === 'quote') {
      return deepFreeze(state as StorableValue);
    }

    // `Undefined@1`: stateless type whose reconstruction produces the JS
    // value `undefined`.
    if (tag === 'Undefined@1') {
      return undefined;
    }

    // `hole` is not valid outside of array deserialization; if encountered
    // at top level or in an object, treat as an unknown type for safety.
    // (Array deserialization handles `hole` inline — see below.)

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

  // Arrays: recursively deserialize elements. `hole` entries use
  // run-length encoding — the state is a positive integer indicating how
  // many consecutive holes to skip. Those indices are left absent in the
  // result array, creating true holes.
  if (Array.isArray(data)) {
    // First pass: compute the logical length (sum of run lengths for
    // `hole` entries plus one for each non-hole entry).
    let logicalLength = 0;
    for (const entry of data) {
      const entryDecoded = context.decode(entry);
      if (entryDecoded !== null && entryDecoded.tag === 'hole') {
        logicalLength += entryDecoded.state as number;
      } else {
        logicalLength++;
      }
    }

    const result = new Array(logicalLength);
    let targetIndex = 0;
    for (const entry of data) {
      const entryDecoded = context.decode(entry);
      if (entryDecoded !== null && entryDecoded.tag === 'hole') {
        // Skip `state` indices — leave them absent, creating true holes.
        targetIndex += entryDecoded.state as number;
      } else {
        result[targetIndex] = deserialize(entry, context, runtime);
        targetIndex++;
      }
    }
    return Object.freeze(result);
  }

  // Plain objects: recursively deserialize values, then freeze.
  const result: Record<string, StorableValue> = {};
  for (const [key, val] of Object.entries(data)) {
    result[key] = deserialize(val, context, runtime);
  }
  return Object.freeze(result);
}

/**
 * Recursively freeze all plain objects and arrays in a value tree.
 * Used by `/quote` deserialization to uphold the immutability guarantee
 * (Section 2.9) on values that skip type-tag interpretation.
 */
function deepFreeze(value: StorableValue): StorableValue {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (i in value) {
        deepFreeze(value[i]);
      }
    }
    return Object.freeze(value);
  }
  for (const val of Object.values(value)) {
    deepFreeze(val as StorableValue);
  }
  return Object.freeze(value);
}
```

> **Implementation guidance: serialization context class registry.** The
> serialization context must register the native object wrapper classes so
> that `getClassFor('Error@1')` returns `StorableError`,
> `getClassFor('Map@1')` returns `StorableMap`, and so on. For tag resolution
> (`getTagFor`), the context can check for a `typeTag` property on the
> instance — the same pattern used by `UnknownStorable` and
> `ProblematicStorable`. This avoids `instanceof` cascades and scales cleanly
> as new wrapper types are added.

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
| **Iframe sandbox** | `runner` <-> `iframe-sandbox` | `postMessage` |
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

- `/` — sigil prefix (nodding to IPLD heritage)
- `<Type>` — `UpperCamelCase` type name
- `@<Version>` — version number (natural number, starting at 1)

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

// Undefined (stateless -- value is null)
// Tag: "Undefined@1"
// { "/Undefined@1": null }

// Array holes (run-length encoded; value is a positive integer; only valid
// inside arrays)
// Tag: "hole"
// { "/hole": <count> }   e.g. { "/hole": 1 }, { "/hole": 5 }

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

> **Sparse array encoding in JSON.** Even when an array contains holes, it is
> serialized as a JSON array. Runs of consecutive holes are represented by
> `hole` entries, each carrying the run length as a positive integer. This
> preserves the array-as-array structure while efficiently encoding sparse
> arrays:
>
> - `[1, , undefined, 3]` serializes as
>   `[1, { "/hole": 1 }, { "/Undefined@1": null }, 3]`.
> - `[1, , , , 5]` serializes as `[1, { "/hole": 3 }, 5]`.
> - A very sparse array like `a = []; a[1000000] = 'x'` serializes as
>   `[{ "/hole": 1000000 }, "x"]`.

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

#### `/object` — Single-Layer Escape

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

#### `/quote` — Fully Literal

Wraps a value that should be returned exactly as-is, with no deserialization
of any nested special forms:

```json
{ "/quote": { "/Link@1": { "id": "..." } } }
```

Deserializes to: `{ "/Link@1": { "id": "..." } }` — the inner structure is
*not* reconstructed. It remains a plain object.

**Freeze guarantee.** Although `/quote` skips type-tag interpretation, the
result is still deep-frozen (arrays and plain objects within the quoted value
are frozen via `Object.freeze()`). The immutability guarantee (Section 2.9)
is a property of `deserialize()` output, not of whether reconstruction
occurred. A caller receiving a value from `deserialize()` can always assume
it is immutable, regardless of whether it came from a `/quote` path, a
reconstructed type, or a plain literal.

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
- Sort plain-object keys lexicographically; preserve array element order and
  `StorableMap`/`StorableSet` insertion order.
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
 * Output format depends on context. When a string representation is needed,
 * base64 with the standard alphabet (`A-Za-z0-9+/`) is recommended; padding
 * (`=`) may be omitted unless required for unambiguity in a given context.
 * When no stringification is needed, raw hash bytes are perfectly acceptable.
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
  // TAG_ARRAY      = 0x08
  // TAG_OBJECT     = 0x09
  // TAG_STORABLE   = 0x0A
  // TAG_HOLE       = 0x0B
  //
  // Implementation feeds type-tagged data into the hasher:
  //
  // - `null`:              hash(TAG_NULL)
  // - `boolean`:           hash(TAG_BOOL, boolByte)
  // - `number`:            hash(TAG_NUMBER, ieee754Float64Bytes)
  // - `string`:            hash(TAG_STRING, utf16CodeUnits)
  // - `bigint`:            hash(TAG_BIGINT, signedTwosComplementBytes)
  // - `undefined`:         hash(TAG_UNDEFINED)
  // - `StorableUint8Array`: hash(TAG_BYTES, rawBytes)
  //                        (hashes the underlying byte content)
  // - `StorableDate`:      hash(TAG_DATE, int64MillisSinceEpoch)
  //                        (hashes the underlying timestamp)
  // - array:               hash(TAG_ARRAY, length, ...elementHash)
  //                        where `length` is the logical array length
  //                        (uint32 big-endian) and elements are hashed
  //                        in order:
  //                          if `i in array`: canonicalHash(array[i])
  //                          else (hole run): hash(TAG_HOLE, uint32(N))
  //                        (order-preserving)
  //
  //                        Holes use run-length encoding in the hash
  //                        stream, matching the wire format: a maximal
  //                        run of N consecutive holes is hashed as a
  //                        single `TAG_HOLE` followed by the run length.
  //                        The run length is encoded as uint32
  //                        big-endian (4 bytes). A single hole is
  //                        `hash(TAG_HOLE, uint32(1))`.
  //
  //                        Runs MUST be maximal — consecutive holes are
  //                        always coalesced into a single TAG_HOLE entry
  //                        so the hash is canonical. (An implementation
  //                        must not split a run of 10 holes into two
  //                        runs of 5; this would produce a different
  //                        hash.)
  //
  //                        When hashing from the wire format, each
  //                        `hole` entry maps directly to one
  //                        `TAG_HOLE + uint32(N)` in the hash (since
  //                        the wire format also uses maximal runs).
  //                        When hashing from an in-memory array, the
  //                        implementation must count consecutive absent
  //                        indices to form maximal runs.
  // - object:              hash(TAG_OBJECT, sortedKeys, ...canonicalHash(value))
  //                        (keys sorted lexicographically by UTF-8)
  // - `StorableInstance`:  hash(TAG_STORABLE, typeTag, canonicalHash(deconstructedState))
  //
  // The native object wrappers are hashed as follows:
  //
  // - `StorableError`, `StorableMap`, `StorableSet`, and other
  //   `StorableInstance`s with recursively-processable deconstructed state
  //   are hashed via TAG_STORABLE:
  //     hash(TAG_STORABLE, typeTag, canonicalHash(deconstructedState))
  //
  // - `StorableDate` and `StorableUint8Array` are special-cased: they use
  //   TAG_DATE and TAG_BYTES respectively, matching their logical content
  //   type rather than going through TAG_STORABLE with a string payload.
  //
  // Examples:
  // - `StorableError`:      hash(TAG_STORABLE, "Error@1", canonicalHash(errorState))
  // - `StorableMap`:        hash(TAG_STORABLE, "Map@1", canonicalHash(entries))
  //                         where entries are hashed in insertion order
  // - `StorableSet`:        hash(TAG_STORABLE, "Set@1", canonicalHash(elements))
  //                         where elements are hashed in insertion order
  // - `StorableDate`:       hash(TAG_DATE, int64MillisSinceEpoch)
  // - `StorableUint8Array`: hash(TAG_BYTES, rawBytes)
  //
  // Each type is tagged to prevent collisions between types with
  // identical content representations. In particular, holes (TAG_HOLE),
  // `undefined` (TAG_UNDEFINED), and `null` (TAG_NULL) all produce
  // distinct hashes, ensuring `[1, , 3]`, `[1, undefined, 3]`, and
  // `[1, null, 3]` are distinguishable by hash.
  //
  // Note: The canonical hash is a function of the logical value, not
  // any particular wire format. Implementations that hash from an
  // in-memory array and implementations that hash from the wire
  // format must produce identical hashes. Both use maximal-run RLE
  // for holes in the hash stream.
}
```

> **String encoding for hashing.** Strings are hashed as a sequence of UTF-16
> code units (two bytes per code unit, in platform byte order). This matches the
> native string encoding in JavaScript contexts, which are often on one or both
> sides of the serialization boundaries this spec defines. Future performance
> characterization may lead to a switch to UTF-8 encoding if the overhead of
> UTF-16 proves significant for non-BMP-heavy workloads.

> **Map/Set ordering in hashing.** Canonical hashing preserves insertion order
> for `StorableMap` entries and `StorableSet` elements, matching the serialized
> form. This means two `StorableMap`s or `StorableSet`s with the same elements
> in different insertion order will hash differently. This is intentional:
> insertion order is part of the observable semantics of `Map`/`Set` in
> JavaScript, so values that behave differently should not hash the same. (By
> contrast, plain objects are hashed with sorted keys, matching the existing
> convention that plain-object key order is not semantically significant.)

### 6.4 Relationship to Late Serialization

Canonical hashing operates on `StorableValue` directly, using deconstructed
state for `StorableInstance`s (including the native object wrappers) and
type-specific handling for primitives and containers. This makes identity
hashing independent of any particular wire encoding — the same hash whether
later serialized to JSON, CBOR, or Automerge.

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
boundary-only serialization and the three-layer architecture:

1. Update `StorableValue` to exclude raw native JS types, include
   `StorableInstance` (Section 1.2).
2. Introduce the native object wrapper classes (`StorableError`, etc.) that
   implement `StorableInstance` (Section 1.4).
3. Rework `toStorableValue()` / `toDeepStorableValue()` to wrap native types
   into `StorableInstance` wrappers and return frozen results (Section 8).
4. Add `nativeValueFromStorableValue()` for unwrapping back to native types
   (Section 8).
5. Remove early conversion points (e.g., `convertCellsToLinks()`,
   `toStorableValue()` wrapping `Error` as `{ "@Error": ... }`).
6. Introduce `SerializationContext` at each boundary (Section 4.7).
7. Update internal code to work with `StorableValue` types rather than JSON
   shapes or raw native objects.

> **`toJSON()` compatibility and migration.** `toStorableValue()` and its
> variants currently honor `toJSON()` methods on objects that have them — if an
> object has a `toJSON()` method and does not implement `StorableInstance`, the
> conversion functions call `toJSON()` and process the result. This preserves
> backward compatibility with existing code. However, `toJSON()` support is
> **marked for removal**: it eagerly converts to JSON-compatible shapes, which
> is incompatible with late serialization. Implementors should migrate to the
> storable protocol (`[DECONSTRUCT]`/`[RECONSTRUCT]`) instead. Once all callers
> have migrated, `toJSON()` support will be removed from the conversion
> functions.

### 7.2 Unifying JSON Encoding

Four legacy conventions in the current codebase must be migrated to the unified
`/<Type>@<Version>` format:

| Legacy Convention | Where Used | Example | New Form |
|-------------------|------------|---------|----------|
| IPLD sigil | Links (`sigil-types.ts`) | `{ "/": { "link@1": { id, path, space } } }` | `{ "/Link@1": { id, path, space } }` |
| `@` prefix | Errors (`storable-value.ts`) | `{ "@Error": { name, message, ... } }` | `{ "/Error@1": { name, message, ... } }` |
| `$` prefix (stream) | Streams (`builder/types.ts`) | `{ "$stream": true }` | `{ "/Stream@1": null }` |
| `$` prefix (alias) | Internal refs (`json-utils.ts`, `cell-handle.ts`) | `{ "$alias": { path, cell?, schema? } }` | `{ "/Link@1": { id, path, space, overwrite? } }` |

> **Note on `$stream`:** In the current codebase, `$stream` is a stateless
> marker — it signals that a cell path is a stream endpoint rather than carrying
> reconstructible state. Under the new encoding it becomes `{ "/Stream@1": null }`
> (a stateless tagged type per Section 5.5), preserving its marker semantics.
>
> **Note on `$alias`:** An alias is an internal cross-cell reference with an
> optional schema filter. During migration it maps to `/Link@1` with the
> appropriate `overwrite` property (e.g., `overwrite: "redirect"` for aliases
> that redirect writes to the target cell).

### 7.3 Replacing CID-Based Hashing

The canonical hashing approach (Section 6) replaces `merkle-reference` /
CID-based hashing. Since the system does not participate in the IPFS network,
CID formatting adds overhead without interoperability benefit. The canonical
hash operates on the logical data structure directly.

---

## 8. Conversion Functions

### 8.1 Overview

The conversion functions bridge the left layer (JS wild west) and the middle
layer (`StorableValue`). They form the boundary between arbitrary JavaScript
values and the strongly typed data model.

There are two directions:

- **JS wild west -> `StorableValue`:** `toStorableValue()`,
  `toDeepStorableValue()`, and `toStorableValueOrThrow()`.
- **`StorableValue` -> JS wild west:** `nativeValueFromStorableValue()` and
  `deepNativeValueFromStorableValue()`.

### 8.2 `toStorableValue()` and `toDeepStorableValue()`

```typescript
// file: packages/common/storable-value.ts

/**
 * Convert a value to `StorableValue`. Wraps native JS types (`Error`, `Map`,
 * etc.) into their `StorableInstance` wrapper classes. If the value is already
 * a valid `StorableValue`, returns it as-is.
 *
 * The input type is `StorableValue | StorableNativeObject` — the function
 * accepts values that are already storable (pass-through) or raw native JS
 * objects that need wrapping. Passing an unsupported type is a type error.
 *
 * **Freeze semantics (shallow):** By default, the returned value is frozen
 * at the top level via `Object.freeze()`. Nested values are NOT recursively
 * frozen. If the input is already a frozen `StorableValue`, returns the same
 * object. Pass `freeze: false` to skip freezing (see below).
 */
export function toStorableValue(
  value: StorableValue | StorableNativeObject,
  freeze?: boolean, // default: true
): StorableValue;

/**
 * Convert a value to `StorableValue`, recursively processing nested values.
 * Like `toStorableValue()` but:
 *
 * - Recursively descends into arrays and plain objects.
 * - Wraps native JS objects at any depth.
 * - **Single-pass design:** Validation, wrapping, and freezing are performed
 *   together in one recursive descent — there are no separate passes. Each
 *   node is checked, wrapped if needed, and frozen before the function
 *   returns from that level.
 * - If the input is already a deeply-frozen `StorableValue`, returns the
 *   same object (no copying).
 * - Detects circular references and throws.
 *
 * Pass `freeze: false` to perform wrapping and validation without freezing
 * (see "Freeze Semantics" below).
 */
export function toDeepStorableValue(
  value: StorableValue | StorableNativeObject,
  freeze?: boolean, // default: true
): StorableValue;
```

#### Conversion Rules

| Input Type | Output |
|------------|--------|
| `null`, `boolean`, `number`, `string`, `undefined`, `bigint` | Returned as-is (primitives are `StorableValue` directly). `-0` is normalized to `0`. Non-finite numbers (`NaN`, `Infinity`) cause rejection. |
| `StorableInstance` (including wrapper classes) | Returned as-is (already `StorableValue`). |
| `Error` | Wrapped into `StorableError`. Before wrapping, `cause` and custom enumerable properties are recursively converted to `StorableValue` (deep variant) or left as-is (shallow variant). Extra enumerable properties are preserved (see Section 1.4.1). This ensures that by the time `StorableError.[DECONSTRUCT]` runs, all nested values are already valid `StorableValue`. |
| `Map` | Wrapped into `StorableMap`. Keys and values are recursively converted (deep variant only). Extra enumerable properties on the `Map` object are silently dropped (see Section 1.4.1). |
| `Set` | Wrapped into `StorableSet`. Elements are recursively converted (deep variant only). Extra enumerable properties on the `Set` object are silently dropped (see Section 1.4.1). |
| `Date` | Wrapped into `StorableDate`. Extra enumerable properties on the `Date` object are silently dropped (see Section 1.4.1). |
| `Uint8Array` | Wrapped into `StorableUint8Array`. Extra enumerable properties on the `Uint8Array` object are silently dropped (see Section 1.4.1). |
| `StorableValue[]` | Shallow: returned as-is (frozen if `freeze` is true). Deep: elements recursively converted (frozen at each level if `freeze` is true). |
| `{ [key: string]: StorableValue }` | Shallow: returned as-is (frozen if `freeze` is true). Deep: values recursively converted (frozen at each level if `freeze` is true). |

#### Freeze Semantics

The immutable-forward design requires that `StorableValue` trees produced by
conversion are frozen **by default**:

- **`toStorableValue()` (shallow):** `Object.freeze()` on the top-level result.
- **`toDeepStorableValue()` (deep):** `Object.freeze()` at every level of
  nesting, performed in the **same recursive pass** as validation and wrapping.
  There are no separate passes — each node is checked, wrapped, and frozen
  before the recursion returns from that level.

If the input is already frozen (or deep-frozen for the deep variant), the same
object is returned — no defensive copying. This avoids unnecessary allocation
in the common case where values are already immutable.

The freeze check starts with a naive recursive `Object.isFrozen()` walk. This
is sufficient for correctness; optimization (e.g., a `WeakSet<object>` of known
deep-frozen objects) can be added later if profiling shows a need.

#### Optional `freeze` Parameter

All conversion functions accept an optional `freeze` parameter (default:
`true`). When `freeze` is `false`, the function performs validation and wrapping
but skips freezing:

```typescript
// Frozen (default) -- immutable result, safe for sharing.
const frozen = toDeepStorableValue(input);

// Unfrozen -- mutable result, caller can modify before freezing later.
const mutable = toDeepStorableValue(input, false);
```

This exists because JavaScript makes it difficult to update frozen values —
there is no "thaw" operation. Callers that need to build up a `StorableValue`
tree incrementally (e.g., merging data from multiple sources) can use
`freeze: false` to get a mutable tree, then freeze it when construction is
complete. The `freeze` parameter does not affect validation or wrapping — the
returned value is always a valid `StorableValue` regardless of its frozen state.

### 8.3 `toStorableValueOrThrow()`

```typescript
// file: packages/common/storable-value.ts

/**
 * Convert an arbitrary JavaScript value to `StorableValue`, throwing on
 * unsupported types. This is the boundary function for code that receives
 * `unknown` values from external sources.
 *
 * Behaves identically to `toStorableValue()` for supported types. For
 * unsupported types (e.g., `WeakMap`, `Promise`, DOM nodes), throws a
 * descriptive error.
 *
 * The `OrThrow` name follows the codebase convention of signaling "this
 * function may throw for type reasons" in the function name, making the
 * failure mode visible at call sites.
 *
 * The optional `freeze` parameter works the same as in `toStorableValue()`
 * (default: `true`; pass `false` to skip freezing).
 */
export function toStorableValueOrThrow(
  value: unknown,
  freeze?: boolean, // default: true
): StorableValue;

/**
 * Deep variant of `toStorableValueOrThrow()`. Recursively converts and
 * deep-freezes (single pass). Throws on unsupported types at any depth.
 *
 * Pass `freeze: false` to skip freezing.
 */
export function toDeepStorableValueOrThrow(
  value: unknown,
  freeze?: boolean, // default: true
): StorableValue;
```

The distinction between `toStorableValue()` and `toStorableValueOrThrow()`:

- **`toStorableValue()`** accepts `StorableValue | StorableNativeObject` —
  the caller has already ensured the value is a supported type. The function
  handles wrapping and freezing but does not need to validate type membership.

- **`toStorableValueOrThrow()`** accepts `unknown` — the caller is at a system
  boundary and cannot guarantee the type. The function validates and throws on
  unsupported types.

Both produce the same output for supported types. The split exists so that
internal code (which knows its types) gets cleaner signatures, while boundary
code (which doesn't) gets explicit error handling.

### 8.4 `canBeStored()`

```typescript
// file: packages/common/storable-value.ts

/**
 * Type guard: returns `true` if `toDeepStorableValue()` would succeed on
 * the given value — i.e., the value is a `StorableValue`, a
 * `StorableNativeObject`, or a tree of these types.
 *
 * This is a check-without-conversion function for system boundaries where
 * code receives `unknown` and needs to determine convertibility without
 * actually performing the conversion (and its associated wrapping, freezing,
 * and allocation).
 *
 * Relationship to other functions:
 * - `isStorableValue(x)`: "Is `x` already a `StorableValue`?" Does NOT
 *   return `true` for raw native types like `Error` or `Map`.
 * - `canBeStored(x)`: "Could `x` be converted to a `StorableValue` via
 *   `toDeepStorableValue()`?" Returns `true` for both `StorableValue`
 *   values AND `StorableNativeObject` values (and deep trees thereof).
 * - `toDeepStorableValueOrThrow(x)`: Actually performs the conversion,
 *   throwing on unsupported types.
 */
export function canBeStored(value: unknown): boolean;
```

The function recursively checks the value tree. It returns `true` if and only
if the value is:

- A primitive (`null`, `boolean`, `number` (finite), `string`, `undefined`,
  `bigint`)
- A `StorableInstance` (including the native object wrapper classes)
- A `StorableNativeObject` (`Error`, `Map`, `Set`, `Date`, `Uint8Array`)
- An array where every present element satisfies `canBeStored()`
- A plain object where every value satisfies `canBeStored()`

It returns `false` for unsupported types (`WeakMap`, `Promise`, DOM nodes,
class instances that don't implement `StorableInstance`, non-finite numbers,
etc.).

> **Performance note.** `canBeStored()` walks the value tree without
> allocating wrappers or frozen copies. For large trees, this is cheaper than
> calling `toDeepStorableValueOrThrow()` inside a try/catch, since it avoids
> the wrapping and freezing work that would be discarded on failure. However,
> if the caller intends to convert on success, calling
> `toDeepStorableValueOrThrow()` directly (and catching the error) avoids
> walking the tree twice.

### 8.5 `nativeValueFromStorableValue()`

```typescript
// file: packages/common/storable-value.ts

/**
 * Convert a `StorableValue` back to a value tree containing native JS types.
 * Wrapper classes are unwrapped to their native equivalents:
 *
 * - `StorableError`      -> `Error`
 * - `StorableMap`        -> `FrozenMap`
 * - `StorableSet`        -> `FrozenSet`
 * - `StorableDate`       -> `Date`
 * - `StorableUint8Array` -> `Uint8Array`
 *
 * Non-wrapper `StorableInstance` values (`Cell`, `Stream`, `UnknownStorable`,
 * `ProblematicStorable`, etc.) pass through unchanged.
 *
 * **Shallow:** Only unwraps the top-level value. Array elements and object
 * property values are not recursively unwrapped.
 *
 * **Immutability is preserved for collections.** `StorableMap` and
 * `StorableSet` unwrap to `FrozenMap` and `FrozenSet` respectively —
 * effectively-immutable wrappers around `Map` and `Set` that expose
 * read-only interfaces and throw on mutation attempts. This preserves
 * the immutable-forward guarantee even in the "JS wild west" layer.
 * Other native types (`Error`, `Date`, `Uint8Array`) are returned as
 * their standard mutable forms.
 */
export function nativeValueFromStorableValue(
  value: StorableValue,
): StorableValue | StorableNativeObject;

/**
 * Deep variant: recursively unwraps wrapper classes throughout the value tree.
 * Arrays and plain objects in the output are NOT frozen (they may contain
 * native types that the caller expects to use normally).
 */
export function deepNativeValueFromStorableValue(
  value: StorableValue,
): StorableValue | StorableNativeObject;
```

#### Unwrapping Rules

| Input | Output |
|-------|--------|
| `StorableError` | `Error` (mutable) |
| `StorableMap` | `FrozenMap` (read-only `Map` wrapper; throws on mutation) |
| `StorableSet` | `FrozenSet` (read-only `Set` wrapper; throws on mutation) |
| `StorableDate` | `Date` (mutable) |
| `StorableUint8Array` | `Uint8Array` (mutable) |
| Other `StorableInstance` | Passed through unchanged |
| Primitives | Passed through unchanged |
| Arrays (deep variant) | Recursively unwrapped; output array is NOT frozen |
| Plain objects (deep variant) | Recursively unwrapped; output object is NOT frozen |

The output type is `StorableValue | StorableNativeObject`, reflecting that the
result may contain native JS types at any depth.

> **Why `FrozenMap` / `FrozenSet`?** `Object.freeze()` does not prevent
> mutation of `Map` and `Set` — their `set()`, `delete()`, `add()`, and
> `clear()` methods remain callable on a frozen instance. `FrozenMap` and
> `FrozenSet` are thin wrappers that expose the read-only subset of the
> `Map`/`Set` API (`get`, `has`, `entries`, `forEach`, `size`, etc.) and throw
> on any mutation attempt. This ensures that data round-tripped through the
> storable layer remains effectively immutable even after unwrapping. The exact
> API of `FrozenMap` and `FrozenSet` is an implementation decision.

### 8.6 Round-Trip Guarantees

For any supported value `v`:

```
deepNativeValueFromStorableValue(toDeepStorableValue(v))
```

produces a value that is structurally equivalent to `v` — the same data at the
same positions. The round-tripped value is not necessarily `===` to the original
(wrapping and unwrapping creates new objects), and the **types may change** for
collections: a mutable `Map` becomes a `FrozenMap`, and a mutable `Set` becomes
a `FrozenSet`. The data content is preserved; the mutability is not.

Similarly, for any `StorableValue` `sv`:

```
toDeepStorableValue(deepNativeValueFromStorableValue(sv))
```

produces a `StorableValue` that is structurally equivalent to `sv`.

---

## Appendix A: Open Design Decisions

These questions may need resolution during implementation but do not block the
spec from being implementable.

- **Comparison semantics for rich types**: Should equality be by identity, by
  deconstructed state (or as if by deconstructed state — an implementation need
  not actually run a deconstructor), or configurable? This affects both runtime
  comparisons (e.g., in reactive system change detection) and `Map`/`Set` key
  behavior. Recommendation: start with identity semantics (the JS default) and
  revisit if structural equality is needed for specific use cases.

- **Type registry management**: How are serialization contexts configured? Static
  registration? Dynamic discovery? Who owns the registry? The isolation
  strategy (see `coordination/docs/2026-02-09-isolation-strategy.md`) proposes
  per-`Runtime` configuration via `ExperimentalOptions`, which provides a
  natural place for registry configuration per runtime instance.

- **Schema integration**: Each `StorableInstance` type implies a schema for its
  deconstructed state. How does this integrate with the schema language?
  Currently out of scope (schemas are listed as out-of-scope for this spec).

- **Exact canonical hash specification**: Precise byte-level specification of
  the hash algorithm (type tags, encoding of each type, handling of special
  cases like `-0` normalization). This should be specified as a separate
  document or appendix before the hashing implementation begins. (Note:
  `TAG_HOLE`'s run-length count encoding is now specified as uint32 big-endian;
  see Section 6.3. Consider unsigned LEB128 as a future optimization once
  measurement data is available to assess its impact.)

- **Migration path**: Out of scope for this spec. The detailed migration plan
  (sequencing of flag introductions, criteria for graduating each flag to
  default-on) will be addressed in a separate document.

- **`ReconstructionContext` extensibility**: The minimal interface defined in
  Section 2.5 covers `Cell` reconstruction. Other future storable types may
  need additional context methods. Should the interface be extended, or should
  types cast to a broader interface? Recommendation: extend the interface as
  needed; the indirection through an interface (rather than depending on
  `Runtime` directly) makes this straightforward.
