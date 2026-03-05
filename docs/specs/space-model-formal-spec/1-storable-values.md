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
  including native objects like `Error`, `Map`, `Set`, `Date`, `RegExp`, and `Uint8Array`.
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
`Date`, `RegExp`, `Uint8Array`) do not appear here; they are handled by the conversion
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

  // (b) Special primitives (SpecialPrimitiveValue subclasses — direct datum
  //     members, not StorableInstance; always frozen)
  | StorableEpochNsec
  | StorableEpochDays
  | StorableContentId

  // (c) Branded storables (custom types implementing the storable protocol)
  //     This arm covers:
  //       - Native object wrappers: `StorableError`, `StorableMap`,
  //         `StorableSet`, `StorableRegExp`, `StorableUint8Array` (Section 1.4)
  //       - User-defined types: `Cell`, `Stream`, etc.
  //       - System types: `UnknownStorable`, `ProblematicStorable`
  | StorableInstance

  // (d) Recursive containers
  | StorableValue[]
  | { [key: string]: StorableValue };
```

> **Excluded JS types.** The following JavaScript types are explicitly **not**
> storable and cause rejection (thrown error) in `toStorableValueOrThrow()` and
> `canBeStored()`:
>
> - `symbol` — Symbols are inherently local (not serializable across realms or
>   processes). Symbol-keyed properties on objects are silently ignored; a bare
>   `symbol` value is rejected outright.
> - `function` — Functions are opaque closures with no portable representation.
>   Objects with a `[DECONSTRUCT]` method are not functions in this sense — they
>   are `StorableInstance`s.
>
> These are the two JS primitive types (`typeof` returns `"symbol"` or
> `"function"`) that are absent from the `StorableValue` union. All other
> `typeof` results (`"undefined"`, `"boolean"`, `"number"`, `"string"`,
> `"bigint"`, `"object"`) have corresponding `StorableValue` arms.

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
 * `StorableMap`, `StorableRegExp`, etc.) are also NOT this type — they are `StorableInstance`
 * implementations that live inside `StorableValue`.
 */
type StorableNativeObject =
  | Error
  | Map<StorableValue | StorableNativeObject, StorableValue | StorableNativeObject>
  | Set<StorableValue | StorableNativeObject>
  | Date
  | RegExp
  | Uint8Array
  | Blob
  | { toJSON(): unknown }; // Legacy — see below.
```

The `StorableNativeObject` type exists solely at function parameter/return
boundaries — for example, `toStorableValue()` accepts
`StorableValue | StorableNativeObject` as input (Section 8). It is never a
member of `StorableValue` or `StorableDatum`.

> **Legacy: `{ toJSON(): unknown }` variant.** The `toJSON()` arm of
> `StorableNativeObject` represents objects that provide a `toJSON()` method.
> The conversion functions call `toJSON()` and process the
> result (Section 8.2). This variant is **legacy and marked for removal** —
> callers should migrate to the storable protocol
> (`[DECONSTRUCT]`/`[RECONSTRUCT]`). See Section 7.1 for migration guidance.

### 1.3 Primitive Types

| Type | Constraints | Notes |
|------|-------------|-------|
| `null` | None | The null value |
| `boolean` | None | `true` or `false` |
| `number` | Must be finite | `-0` normalized to `0`; `NaN`/`Infinity` rejected |
| `string` | None | Unicode text |
| `undefined` | None | First-class storable; see note below |
| `bigint` | None | Large integers; JSON-encoded as base64url (RFC 4648, Section 5) of two's complement big-endian bytes (Section 5.3) |

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

Certain built-in JS types (`Error`, `Map`, `Set`, `RegExp`, `Uint8Array`) cannot
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
`TAG_INSTANCE` path for most wrappers, but optimizes `StorableUint8Array`
with a dedicated `TAG_BYTES` tag for content-level identity (see Section 6.3).

The **special primitive** types (`StorableEpochNsec`, `StorableEpochDays`,
`StorableContentId`) are **not** `StorableInstance`s — they are direct members
of `StorableDatum`, like `bigint`. They all extend `SpecialPrimitiveValue`
(Section 1.4.6), which marks them as always-frozen value types that bypass the
`freeze` option in conversion functions. They have dedicated canonical hash tags
and dedicated `TypeHandler`s for wire format serialization, but they do not
implement `[DECONSTRUCT]`, `[RECONSTRUCT]`, or carry a `typeTag` property.

#### 1.4.1 Wrapper Class Summary

| Wrapper Class | Wraps | Type Tag | Deconstructed State | Notes |
|---------------|-------|----------|---------------------|-------|
| `StorableError` | `Error` | `Error@1` | `{ type, name, message, stack?, cause?, ...custom }` | `type` is the constructor name (e.g. `"TypeError"`). `name` is the `.name` property if it differs from `type`, or `null` if it matches (the common case). Includes `message`, `stack` (if present), `cause` (if present), and custom enumerable properties. The conversion layer (Section 8.2) recursively converts nested values (including `cause` and custom properties) before wrapping, ensuring all values are `StorableValue` when `[DECONSTRUCT]` runs. |
| `StorableMap` | `Map` | `Map@1` | `[[key, value], ...]` | Entry pairs as an array of two-element arrays. Insertion order is preserved. Keys and values are recursively processed. |
| `StorableSet` | `Set` | `Set@1` | `[value, ...]` | Elements as an array. Iteration order is preserved. Values are recursively processed. |
| `StorableRegExp` | `RegExp` | `RegExp@1` | `{ source, flags, flavor }` | `source` is the pattern string (`regex.source`); `flags` is the flag string (`regex.flags`); `flavor` is the regex dialect identifier (e.g. `"es2025"`). Extra enumerable properties cause rejection. |
| `StorableUint8Array` | `Uint8Array` | `Bytes@1` | `string` (unpadded base64url, RFC 4648 Section 5; see Section 5.3) | Deconstructed state is a string. |

Each wrapper class above:

- **Implements `StorableInstance`** with a `[DECONSTRUCT]` method that extracts
  essential state from the wrapped native object.
- **Has a static `[RECONSTRUCT]` method** (following the `StorableClass<T>`
  pattern) that returns an instance of the wrapper class — **not** the raw
  native type. Callers who need the underlying native object use
  `nativeValueFromStorableValue()` (Section 8) to unwrap it.
- **Carries a `typeTag` property** (e.g., `"Error@1"`) used by the
  serialization context for tag resolution, following the pattern established
  by `UnknownStorable` and `ProblematicStorable`.

Unlike the wrappers above, the special primitive types (`StorableEpochNsec`,
`StorableEpochDays`, `StorableContentId`) are **direct members of
`StorableDatum`** and do not implement `StorableInstance`. They all extend
`SpecialPrimitiveValue` (Section 1.4.6), which provides always-frozen semantics.
See Sections 1.4.6 through 1.4.9.

| Direct Datum Type | Extends | Wire Tag | Stored Value | Notes |
|-------------------|---------|----------|--------------|-------|
| `StorableEpochNsec` | `SpecialPrimitiveValue` | `EpochNsec@1` | `bigint` (signed nanoseconds from POSIX Epoch) | Primary temporal type. JS `Date` has only millisecond precision; conversion from `Date` multiplies by 10^6. When `Temporal` is available, `Temporal.Instant` maps naturally (it uses nanoseconds from epoch internally). |
| `StorableEpochDays` | `SpecialPrimitiveValue` | `EpochDays@1` | `bigint` (signed days from POSIX Epoch) | Day-precision temporal type. Anticipates `Temporal.PlainDate`. Mostly nascent — class and spec entry are defined, but full integration (Temporal types, calendar concerns) is deferred. |
| `StorableContentId` | `SpecialPrimitiveValue` | _(none — see Section 1.4.9)_ | `Uint8Array` (hash bytes) + `string` (algorithm tag) | Content identifier / hash. Stringifies as `<algorithmTag>:<base64urlhash>` (unpadded base64url, RFC 4648 Section 5). The first algorithm tag is `fid1` ("fabric ID, v1"). |

#### Extra Enumerable Properties

**`StorableError`** MAY carry extra enumerable properties beyond the standard
fields (`type`, `name`, `message`, `stack`, `cause`). Custom properties on `Error`
objects are common JavaScript practice (e.g., `error.code`, `error.statusCode`),
so `StorableError` preserves them: `[DECONSTRUCT]` includes them in its output,
and `[RECONSTRUCT]` restores them on the reconstructed `Error`.

**`StorableMap`, `StorableSet`, `StorableRegExp`, `StorableEpochNsec`,
`StorableEpochDays`, `StorableContentId`, `StorableUint8Array`** must NOT carry
extra enumerable
properties. Their
stored value contains only the essential native data (entries, items,
epoch value, bytes respectively). Extra enumerable properties on the source
native object cause **rejection** — the conversion function throws. This follows
the principle "Death before confusion!" (Mark Miller): it is better to fail
loudly than to silently lose data. This matches the treatment of arrays, where
extra non-index properties also cause rejection (Section 1.5). Unlike `Error`,
these native types have no established convention for custom properties.

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
    //
    // `type` is the constructor name (e.g. "TypeError"), while `name` is
    // the `.name` property (which may differ if overridden). Since
    // `type === name` is the common case, `name` is emitted as `null`
    // when it matches `type` to avoid redundancy. `[RECONSTRUCT]`
    // interprets `null` name as "same as type."
    const type = this.error.constructor.name;
    const state: Record<string, StorableValue> = {
      type,
      name:    this.error.name === type ? null : this.error.name,
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
    // Use `type` (constructor name) for class lookup. Fall back to `name`
    // for backward compatibility with data serialized before `type` was
    // added. A `null` or absent `name` means "same as type."
    const type = (s.type as string) ?? (s.name as string) ?? 'Error';
    const name = (s.name as string | null) ?? type;
    const message = (s.message as string) ?? '';
    let error: Error;
    switch (type) {
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
      if (!['type', 'name', 'message', 'stack', 'cause', '__proto__', 'constructor'].includes(key)) {
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

#### 1.4.5 `StorableRegExp`

```typescript
// file: packages/common/storable-native-wrappers.ts

import {
  DECONSTRUCT, RECONSTRUCT,
  type StorableInstance, type ReconstructionContext,
} from './storable-protocol';

/**
 * Wrapper for native `RegExp` values. Implements `StorableInstance` so that
 * regular expressions participate in the standard serialization and hashing
 * paths.
 *
 * Essential state is the pattern `source` string, the `flags` string, and
 * the `flavor` string identifying the regex dialect. The only initially
 * defined flavor is `"es2025"` (ECMAScript 2025 regular expressions).
 * The `flavor` field is forward-looking for multi-runtime scenarios where
 * different regex engines may be in use.
 *
 * Extra enumerable properties on the wrapped `RegExp` cause rejection
 * (death before confusion).
 *
 * **Freeze behavior:** A frozen `RegExp` has an immutable `lastIndex`,
 * which prevents stateful use of `exec()` and `test()` with the `g`
 * (global) and `y` (sticky) flags. This is an inherent consequence of
 * `Object.freeze()` on `RegExp` objects and is consistent with the
 * immutable-forward design — callers who need stateful matching should
 * construct a new `RegExp` from the source and flags.
 */
export class StorableRegExp implements StorableInstance {
  readonly typeTag = 'RegExp@1';

  constructor(
    readonly regexp: RegExp,
    readonly flavor: string = 'es2025',
  ) {}

  [DECONSTRUCT](): StorableValue {
    return {
      source: this.regexp.source,
      flags: this.regexp.flags,
      flavor: this.flavor,
    };
  }

  static [RECONSTRUCT](
    state: StorableValue,
    _context: ReconstructionContext,
  ): StorableRegExp {
    const s = state as { source: string; flags: string; flavor?: string };
    const flavor = s.flavor ?? 'es2025';
    return new StorableRegExp(new RegExp(s.source, s.flags), flavor);
  }
}
```

#### 1.4.6 `SpecialPrimitiveValue` (Base Class)

`SpecialPrimitiveValue` is the abstract base class for non-`StorableInstance`
datum types that sit directly in the `StorableValue` union alongside JS
primitives. It is analogous to `ExplicitTagStorable` (Section 3.2) — both are
abstract bases that factor out shared structure — but for a different arm of
the type hierarchy:

- `ExplicitTagStorable` is the base for `StorableInstance` subtypes that carry
  an explicit wire-format tag (`UnknownStorable`, `ProblematicStorable`).
- `SpecialPrimitiveValue` is the base for direct datum types that behave like
  primitives but need a class wrapper (`StorableEpochNsec`, `StorableEpochDays`,
  `StorableContentId`).

```typescript
// file: packages/memory/special-primitive-value.ts

/**
 * Abstract base class for storable datum types that behave like primitives
 * but need a class wrapper for identity and type dispatch. Subclasses are
 * direct members of `StorableValue` (not `StorableInstance`s) and have
 * dedicated canonical hash tags and wire-format `TypeHandler`s.
 *
 * **Always-frozen semantics:** `SpecialPrimitiveValue` instances are
 * treated as inherently frozen, like JS primitives (`number`, `string`,
 * `bigint`, etc.). The `freeze` option on conversion functions
 * (`toStorableValue()`, `toDeepStorableValue()`, etc.) does not affect
 * them — they are always returned as-is, regardless of the `freeze`
 * setting. This is because their state is immutable by construction
 * (readonly fields, no mutation methods), so freezing is a no-op and
 * thawing is meaningless.
 */
export abstract class SpecialPrimitiveValue {}
```

Subclasses define their own state (e.g., `readonly value: bigint` for temporal
types, `readonly hash: Uint8Array` + `readonly algorithmTag: string` for
content IDs). The base class holds no state — its purpose is to provide a single
`instanceof SpecialPrimitiveValue` check where code needs to identify these
types uniformly (e.g., the conversion functions' freeze-bypass logic).

#### 1.4.7 `StorableEpochNsec`

```typescript
/**
 * Temporal type representing nanoseconds from the POSIX Epoch
 * (1970-01-01T00:00:00Z). Direct member of `StorableDatum` (not a
 * `StorableInstance`). This is the primary temporal type.
 *
 * JS `Date` has only millisecond precision, so conversion from `Date`
 * multiplies by 10^6 (losing sub-millisecond information). When `Temporal`
 * is available, `Temporal.Instant` maps naturally — it uses nanoseconds
 * from epoch internally.
 *
 * The underlying value is a `bigint`, not a string. This avoids baking
 * in any particular string representation (ISO 8601, etc.) and lets the
 * serialization layer use the same bigint encoding as `BigInt@1`.
 */
export class StorableEpochNsec extends SpecialPrimitiveValue {
  constructor(readonly value: bigint) {
    super();
  }
}
```

#### 1.4.8 `StorableEpochDays`

```typescript
/**
 * Temporal type representing days from the POSIX Epoch (1970-01-01).
 * Extends `SpecialPrimitiveValue` (not a `StorableInstance`).
 * Anticipates `Temporal.PlainDate`.
 *
 * Mostly nascent — the class and spec entry are defined, but full
 * integration with Temporal types and calendar concerns is deferred.
 *
 * The underlying value is a `bigint`.
 */
export class StorableEpochDays extends SpecialPrimitiveValue {
  constructor(readonly value: bigint) {
    super();
  }
}
```

#### 1.4.9 `StorableContentId`

```typescript
// file: packages/memory/storable-content-id.ts

/**
 * A content identifier — a hash that identifies a storable value by its
 * canonical hash bytes and an algorithm tag. Extends `SpecialPrimitiveValue`
 * (not a `StorableInstance`): it is a direct member of `StorableDatum`,
 * has a dedicated canonical hash tag, and is always-frozen.
 *
 * The first algorithm tag is `fid1` ("fabric ID, v1"), which corresponds
 * to the SHA-256-based canonical hash produced by `canonicalHash()`
 * (Section 6.4).
 *
 * Stringification: `<algorithmTag>:<base64urlhash>` where the encoding
 * uses base64url (RFC 4648, Section 5) with alphabet `A-Za-z0-9-_` and
 * no `=` padding. For example, a `fid1` content ID might stringify as
 * `fid1:n4bQgYhMfWWaL-qgxVrQFaO_TxsrC4Is0V1sFbDwCgg`.
 */
export class StorableContentId extends SpecialPrimitiveValue {
  constructor(
    /** The raw hash bytes (e.g., 32 bytes for SHA-256). */
    readonly hash: Uint8Array,
    /** The algorithm tag identifying the hash algorithm and version. */
    readonly algorithmTag: string,
  ) {
    super();
  }

  /** Returns `<algorithmTag>:<base64urlhash>` (unpadded base64url). */
  toString(): string {
    return `${this.algorithmTag}:${base64urlEncodeUnpadded(this.hash)}`;
  }
}
```

The `algorithmTag` field is an opaque string identifier. Known algorithm tags:

| Algorithm Tag | Meaning | Hash Algorithm | Output Size |
|:--------------|:--------|:---------------|:------------|
| `fid1`        | Fabric ID, version 1 | SHA-256 (Section 6.4) | 32 bytes |

Future algorithm tags may be added for different hash algorithms or versioned
content-addressing schemes. The algorithm tag is part of the content ID's
identity — two `StorableContentId` instances with the same hash bytes but
different algorithm tags are distinct values.

#### 1.4.10 `StorableUint8Array`

```typescript
export class StorableUint8Array implements StorableInstance {
  readonly typeTag = 'Bytes@1';

  constructor(readonly bytes: Uint8Array) {}

  [DECONSTRUCT](): StorableValue {
    return base64urlEncode(this.bytes);
  }

  static [RECONSTRUCT](
    state: StorableValue,
    _context: ReconstructionContext,
  ): StorableUint8Array {
    return new StorableUint8Array(base64urlDecode(state as string));
  }
}
```

#### 1.4.11 `bigint` — Not Wrapped

`bigint` is a JavaScript primitive (`typeof x === 'bigint'`), not an object. It
rides through the `StorableValue` layer directly, like `undefined`. No
`StorableBigInt` wrapper class is needed. The serialization layer handles
`bigint` with a dedicated handler (analogous to `UndefinedHandler`); see
Section 4.5.

#### 1.4.12 Design Notes

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
> **File organization.** The native object wrapper classes (`StorableError`,
> `StorableMap`, `StorableSet`, `StorableRegExp`, `StorableUint8Array`) and the
> `SpecialPrimitiveValue` subclasses (`StorableEpochNsec`,
> `StorableEpochDays`, `StorableContentId`) are each small (~30 lines) and
> may be organized into one or a few files as an implementation decision.

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
 * `StorableSet`, `StorableRegExp`, `StorableUint8Array`) implement this interface, as do
 * user-defined types (`Cell`, `Stream`) and system types
 * (`UnknownStorable`, `ProblematicStorable`).
 *
 * Note: `SpecialPrimitiveValue` subclasses (`StorableEpochNsec`,
 * `StorableEpochDays`, `StorableContentId`) are direct `StorableDatum`
 * members and do NOT implement this interface.
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

### 2.7 Example: Temperature (Illustrative)

The following example is artificial, designed to illustrate the `StorableInstance`
protocol. It is not part of the codebase.

A `Temperature` value type demonstrates why the protocol exists: without it, a
`Temperature` instance would serialize as a plain object `{ value: 100, unit:
"C" }`, losing its type identity and any methods. With the protocol, the
serialization system can round-trip it back to a real `Temperature` instance.

```typescript
// Illustrative example -- not from the codebase.

import {
  DECONSTRUCT,
  RECONSTRUCT,
  type StorableInstance,
  type StorableValue,
  type ReconstructionContext,
} from '@common/storable-protocol';

type TemperatureUnit = "C" | "F" | "K";

class Temperature implements StorableInstance {
  constructor(
    readonly value: number,
    readonly unit: TemperatureUnit,
  ) {}

  /** Convert to Celsius for comparison. */
  toCelsius(): number {
    switch (this.unit) {
      case "C": return this.value;
      case "F": return (this.value - 32) * 5 / 9;
      case "K": return this.value - 273.15;
    }
  }

  /** Return essential state for serialization. */
  [DECONSTRUCT]() {
    return { value: this.value, unit: this.unit };
  }

  /** Reconstruct from essential state. */
  static [RECONSTRUCT](
    state: StorableValue,
    _context: ReconstructionContext,
  ): Temperature {
    const s = state as { value: number; unit: TemperatureUnit };
    return new Temperature(s.value, s.unit);
  }
}
```

> **Runtime validation in `[RECONSTRUCT]`.** The `Temperature[RECONSTRUCT]`
> example above uses `state as { value: number; unit: TemperatureUnit }` — a
> bare type cast with no runtime validation. This is acceptable in a short
> illustrative example, but **production `[RECONSTRUCT]` implementations must
> validate the shape of `state` at runtime** before using it. The `state`
> parameter has been through serialization and deserialization; it may not
> conform to the expected TypeScript type. See Section 7.4 for the full
> rationale.

**Why the protocol matters.** Without `StorableInstance`, the serialization
system would see a `Temperature` as an opaque object and either reject it or
flatten it into `{ value: 100, unit: "C" }`. With the protocol, the
serialization system:

1. Calls `[DECONSTRUCT]()` to extract the essential state.
2. Serializes that state (recursively handling any nested `StorableValue`s).
3. On deserialization, calls `Temperature[RECONSTRUCT](state, context)` to
   produce a real `Temperature` instance with its methods intact.

**Reference types and `ReconstructionContext`.** The `Temperature` example above
is a simple value type -- its `[RECONSTRUCT]` creates a fresh instance each
time. Reference types (such as the runtime's internal `Cell` type) use the
`ReconstructionContext` parameter to look up or intern existing instances,
ensuring that two references to the same logical entity deserialize to the same
object.

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
  reconstruction. This applies to all deserialization output paths, including
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
> (`StorableMap`, `StorableSet`, `StorableRegExp`, etc.), not raw native types. Because the
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

### 3.2 `ExplicitTagStorable` (Base Class)

Both `UnknownStorable` and `ProblematicStorable` share a common pattern: they
carry an explicit wire-format type tag and raw state for round-tripping. The
abstract base class `ExplicitTagStorable` factors out these shared fields,
enabling a single `instanceof ExplicitTagStorable` check where code needs to
handle both subtypes uniformly (e.g., serialization dispatch).

```typescript
// file: packages/common/explicit-tag-storable.ts

/**
 * Base class for storable types that carry an explicit wire-format tag.
 * Used by UnknownStorable (unrecognized types) and ProblematicStorable
 * (failed deconstruction/reconstruction). Enables a single instanceof
 * check where code needs to handle both.
 */
export abstract class ExplicitTagStorable {
  constructor(
    /** The original type tag, e.g. `"FutureType@2"`. */
    readonly typeTag: string,
    /** The raw state, already recursively processed by the deserializer. */
    readonly state: StorableValue,
  ) {}
}
```

Each subclass implements `StorableInstance` (providing `[DECONSTRUCT]`) and a
static `[RECONSTRUCT]` independently. The base class holds only the shared
fields — `DECONSTRUCT` stays on each subclass since the deconstruction payloads
differ in shape.

### 3.3 `UnknownStorable`

```typescript
// file: packages/common/unknown-storable.ts

import {
  DECONSTRUCT,
  RECONSTRUCT,
  type StorableInstance,
  type ReconstructionContext,
} from './storable-protocol';
import { ExplicitTagStorable } from './explicit-tag-storable';

/**
 * Holds an unrecognized type's data for round-tripping. The serialization
 * system has special knowledge of this class: on deserialization of an unknown
 * tag, it wraps the tag and state here; on re-serialization, it uses the
 * preserved `typeTag` to produce the original wire format.
 */
export class UnknownStorable extends ExplicitTagStorable
  implements StorableInstance {
  constructor(typeTag: string, state: StorableValue) {
    super(typeTag, state);
  }

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

### 3.4 Behavior

- When the serialization system encounters an unknown type tag during
  deserialization, it wraps the original tag and state into `{ type, state }`
  and passes that to `UnknownStorable[RECONSTRUCT]`.
- When re-serializing an `UnknownStorable`, the system uses the preserved
  `typeTag` to produce the original wire format.
- This allows data to round-trip through systems that don't understand it.

### 3.5 `ProblematicStorable` (Recommended)

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
import { ExplicitTagStorable } from './explicit-tag-storable';

/**
 * Holds a value whose deconstruction or reconstruction failed. Preserves
 * the original tag and raw state for round-tripping and debugging.
 */
export class ProblematicStorable extends ExplicitTagStorable
  implements StorableInstance {
  constructor(
    typeTag: string,
    state: StorableValue,
    /** A description of what went wrong. */
    readonly error: string,
  ) {
    super(typeTag, state);
  }

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

### 4.2 Wire Format Types

The JSON encoding context uses an intermediate tree representation during
serialization and deserialization. This type is internal to the JSON
implementation — it is not part of the public boundary interface.

```typescript
// file: packages/memory/json-type-handlers.ts

/**
 * JSON-compatible wire format value. This is the intermediate tree
 * representation used during serialization tree walking -- NOT the final
 * serialized form (which is `string`). Internal to the JSON implementation.
 */
type JsonWireValue = null | boolean | number | string | JsonWireValue[] | { [key: string]: JsonWireValue };
```

### 4.3 Public Boundary Interface

The public interface for serialization contexts is parameterized by the
boundary type — `string` for JSON contexts, `Uint8Array` for binary contexts.
External callers use only `encode()` and `decode()`; all internal machinery
(tag wrapping, tree walking, type handler dispatch) is private to the context
implementation.

```typescript
// file: packages/memory/storable-protocol.ts

/**
 * Public boundary interface for serialization contexts. Encodes storable
 * values into a serialized form and decodes them back. The type parameter
 * `SerializedForm` is the boundary type: `string` for JSON contexts,
 * `Uint8Array` for binary contexts.
 *
 * This is the only interface external callers need. Internal tree-walking
 * machinery is private to the context implementation.
 */
export interface SerializationContext<SerializedForm = unknown> {
  /** Whether failed reconstructions produce `ProblematicStorable` instead of
   *  throwing. @default false */
  readonly lenient: boolean;

  /** Encode a storable value into serialized form for boundary crossing. */
  encode(value: StorableValue): SerializedForm;

  /** Decode a serialized form back into a storable value. */
  decode(data: SerializedForm, runtime: ReconstructionContext): StorableValue;
}
```

The JSON encoding context implements `SerializationContext<string>`:

- `encode(value)` serializes a `StorableValue` into the `/<Type>@<Version>`
  tagged wire format, then stringifies the result.
- `decode(data, runtime)` parses a JSON string, then deserializes tagged forms
  back into rich runtime types.

> **Previous design.** The earlier spec described `SerializationContext` as a
> lower-level interface with `getTagFor()`, `getClassFor()`, `encode(tag,
> state)`, and `decode(data)` methods — essentially exposing the tag
> wrapping/unwrapping mechanics as the public API. The current design pushes all
> of that machinery inside the context class, leaving only the clean
> `encode(value) -> SerializedForm` / `decode(data, runtime) -> StorableValue`
> boundary. This better reflects the principle that the context owns the full
> pipeline, not just the tag encoding step.

### 4.4 Serialization Flow

```
Encode:  value -> context.encode(value) -> serialized form (e.g., JSON string)
Decode:  serialized form -> context.decode(data, runtime) -> StorableValue
```

Internally, the JSON encoding context's `encode()` method calls a private
`serialize()` to walk the `StorableValue` tree and produce a `JsonWireValue`
tree, then stringifies it. The `decode()` method parses the JSON string, then
calls a private `deserialize()` to walk the `JsonWireValue` tree and
reconstruct rich runtime types. The recursive descent and type dispatch are
entirely internal to the context.

### 4.5 Type Handlers and Internal Tree Walking

The serialization and deserialization logic is implemented as private methods
on `JsonEncodingContext`. The context dispatches per-type logic to **type
handlers** — small objects that know how to serialize values of a specific type
and how to deserialize them from a specific tag.

```typescript
// file: packages/memory/json-type-handlers.ts

/**
 * Narrow interface for what type handlers need from the encoding context
 * during tree walking. Contains only the tag-wrapping and tag-lookup methods
 * needed by handler serialize/deserialize implementations.
 *
 * This is NOT a public interface -- it exists to type the `codec` parameter
 * passed to type handlers by the internal tree-walking engine.
 */
interface TypeHandlerCodec {
  /** Wrap a tag and state into the wire format's tagged representation. */
  wrapTag(tag: string, state: JsonWireValue): JsonWireValue;
  /** Get the wire format tag for a storable instance's type. */
  getTagFor(value: StorableInstance): string;
}

/**
 * Interface for per-type serialize/deserialize handlers. Each handler knows
 * how to serialize values of its type and how to deserialize them from a
 * specific tag. Handlers are registered in a `TypeHandlerRegistry`.
 */
interface TypeHandler {
  /** The wire format tag this handler deserializes from (e.g. `"BigInt@1"`). */
  readonly tag: string;

  /** Returns `true` if this handler can serialize the given value. */
  canSerialize(value: StorableValue): boolean;

  /**
   * Serialize the value. Only called after `canSerialize` returned `true`.
   * The handler is responsible for tag wrapping via `codec.wrapTag()` and
   * for recursively serializing nested values via the `recurse` callback.
   */
  serialize(
    value: StorableValue,
    codec: TypeHandlerCodec,
    recurse: (v: StorableValue) => JsonWireValue,
  ): JsonWireValue;

  /**
   * Deserialize a value from its wire format state. The state has already
   * been unwrapped (tag stripped) but inner values have NOT been recursively
   * deserialized -- the handler must call `recurse` on nested values.
   */
  deserialize(
    state: JsonWireValue,
    runtime: ReconstructionContext,
    recurse: (v: JsonWireValue) => StorableValue,
  ): StorableValue;
}
```

The built-in type handlers are:

| Handler | Tag | Serializes | Notes |
|---------|-----|------------|-------|
| `EpochNsecHandler` | `EpochNsec@1` | `StorableEpochNsec` | Direct `StorableDatum` member; matched by `instanceof`. |
| `EpochDaysHandler` | `EpochDays@1` | `StorableEpochDays` | Direct `StorableDatum` member; matched by `instanceof`. |
| `StorableInstanceHandler` | _(empty)_ | `StorableInstance` | Generic handler for all `StorableInstance` values. Uses `[DECONSTRUCT]` and the codec's tag methods. No tag for deserialization — individual instance types are deserialized via the class registry. |
| `BigIntHandler` | `BigInt@1` | `bigint` | Encodes as unpadded base64url of minimal two's complement big-endian bytes. |
| `UndefinedHandler` | `Undefined@1` | `undefined` | Stateless; state is `null`. |

Handler registration order matters for serialization: `EpochNsec` and
`EpochDays` are checked first (they are direct `StorableDatum` members matched
by `instanceof` and must be found before the generic `StorableInstanceHandler`),
then `StorableInstance` (generic protocol types via `isStorableInstance`), then
`bigint` and `undefined`. Primitives, arrays, and plain objects are handled as
fallthrough after no handler matches.

#### Private `serialize()` method

The context's private `serialize()` method walks the `StorableValue` tree:

1. **Type handler dispatch** — scans the handler registry; if a handler
   matches, delegates to it (with a `recurse` callback for nested values).
2. **Primitives** — `null`, `boolean`, `number`, `string` pass through to
   `JsonWireValue` directly.
3. **Arrays** — serialized element-by-element; sparse arrays use run-length
   encoded `hole` entries (Section 1.5).
4. **Plain objects** — serialized key-by-key; `/object` escaping applied per
   Section 5.6.

Circular references are detected via a `Set<object>` tracked during the walk.

#### Private `deserialize()` method

The context's private `deserialize()` method walks the `JsonWireValue` tree:

1. **Tag unwrapping** — checks for single-key objects with `/`-prefixed keys.
2. **Structural escapes** — handles `/object` (Section 5.6) and `/quote`
   (Section 5.6).
3. **Type handler dispatch** — looks up the tag in the registry; if found,
   delegates to the handler's `deserialize()`. When the context is in lenient
   mode, handler exceptions produce `ProblematicStorable` (Section 3.5).
4. **Class registry fallback** — for tags not handled by type handlers (e.g.,
   `Error@1`, `Map@1`, `Set@1`, `Bytes@1`, `RegExp@1`), the context looks up
   the `StorableClass` in its class registry, recursively deserializes the
   state, and calls `[RECONSTRUCT]`. Unknown tags produce `UnknownStorable`.
5. **Primitives** — pass through.
6. **Arrays** — recursively deserialized; `hole` entries reconstructed as true
   holes (absent indices).
7. **Plain objects** — recursively deserialized; output frozen.

> **Implementation guidance: class registry.** The `JsonEncodingContext`
> constructor registers native wrapper classes for deserialization:
> `StorableError`, `StorableMap`, `StorableSet`, `StorableUint8Array`,
> `StorableRegExp`. For tag resolution (`getTagFor`), the context checks for
> a `typeTag` property on the instance — the same pattern used by
> `UnknownStorable` and `ProblematicStorable`. `ExplicitTagStorable` instances
> use their preserved `typeTag` directly. This avoids `instanceof` cascades
> and scales cleanly as new wrapper types are added.

> **Previous design.** The earlier spec presented `serialize()` and
> `deserialize()` as standalone top-level functions that received the
> `SerializationContext` as a parameter. The current design moves these into
> private methods on `JsonEncodingContext`, keeping the public API clean
> (`encode()`/`decode()` only) and allowing the context to encapsulate its
> internal state (registry, codec view, lenient mode) without threading it
> through every recursive call.

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

### 4.8 JSON Encoding Dispatch

The storage boundary in `space.ts` routes through flag-gated dispatch functions
that bridge between the storage layer (JSON strings) and the runtime layer
(`StorableValue`). These functions live in a dedicated dispatch module
(`packages/memory/json-encoding-dispatch.ts`) and are reassigned at runtime
based on whether unified JSON encoding is enabled.

```typescript
// file: packages/memory/json-encoding-dispatch.ts

/**
 * Encode a storable value to a JSON string. When unified JSON encoding is
 * ON, serializes rich types (bigint, undefined, Map, etc.) into the
 * `/<Type>@<Version>` tagged wire format and stringifies. When OFF,
 * equivalent to `JSON.stringify(value)`.
 */
let jsonFromValue: (value: StorableValue) => string;

/**
 * Decode a JSON string back into a storable value. When unified JSON
 * encoding is ON, parses the string and deserializes tagged forms back
 * into rich runtime types. When OFF, equivalent to `JSON.parse(json)`.
 */
let valueFromJson: (json: string, runtime: ReconstructionContext) => StorableValue;
```

The dispatch is configured by `setJsonEncodingConfig(enabled)` /
`resetJsonEncodingConfig()`, called from the `Runtime` constructor and
`Runtime.dispose()` respectively:

- **Flag OFF (default):** `jsonFromValue` wraps `JSON.stringify` with a
  defensive guard that throws if the result is `undefined` — this can happen
  when the input is `undefined` (a first-class `StorableValue` per Section
  1.3), since `JSON.stringify(undefined)` returns `undefined` rather than a
  string. The guard ensures `jsonFromValue` always returns a `string` as its
  type signature promises. `valueFromJson` = `JSON.parse`. This is the legacy
  path — the storage layer sees plain JSON values with no tagged types.
- **Flag ON:** `jsonFromValue` routes through `JsonEncodingContext.encode()`,
  `valueFromJson` routes through `JsonEncodingContext.decode()`. Rich types
  are preserved across the storage boundary.

The dispatch module creates a single stateless `JsonEncodingContext` instance at
module load time and reuses it for all encode/decode operations.

In `space.ts`, the dispatch functions replace direct `JSON.stringify` /
`JSON.parse` calls at three sites:

- **Write path:** `jsonFromValue(datum)` replaces `JSON.stringify(datum)` in
  `importDatum()`.
- **Read path:** `valueFromJson(json, context)` replaces `JSON.parse(json)` at
  `recall()`, `getFact()`, and `toFact()`.

### 4.9 Storable Value Dispatch

The native-to-storable value boundary is managed by a similar flag-gated
dispatch module (`packages/memory/storable-value-dispatch.ts`). This module
provides `toStorable()` / `fromStorable()` functions that bridge the left layer
(JS wild west) and the middle layer (`StorableValue`) at the `Cell` read/write
boundary.

```typescript
// file: packages/memory/storable-value-dispatch.ts

/**
 * Convert a native JS value to storable form. When the flag is ON,
 * wraps native types (Error, Date, RegExp, etc.) into storable wrappers
 * and deep-freezes. When OFF, performs legacy deep conversion via
 * `toDeepStorableValue`.
 */
let toStorable: (value: StorableValue) => StorableValue;

/**
 * Convert a storable value back to native form. When the flag is ON,
 * unwraps storable wrappers (StorableError, StorableMap, etc.) back to
 * native JS types. When OFF, identity passthrough.
 */
let fromStorable: (value: StorableValue) => StorableValue;
```

The dispatch is configured by `setStorableValueConfig(enabled)` /
`resetStorableValueConfig()`, called from the `Runtime` constructor and
`Runtime.dispose()` respectively:

- **Flag OFF (default):** `toStorable` routes through `toDeepStorableValue`
  (the legacy conversion function). `fromStorable` is an identity passthrough.
- **Flag ON:** `toStorable` routes through `toDeepRichStorableValue` (which
  wraps native objects into `StorableInstance` wrappers per Section 8.2).
  `fromStorable` routes through `deepNativeValueFromStorableValue` (which
  unwraps `StorableInstance` wrappers back to native JS types per Section 8.5).

In the `Cell` implementation:

- **Read path:** `Cell.getRaw()` calls `fromStorable(value)` to unwrap
  storable wrappers before returning values to the JS wild west.
- **Write path:** `Cell.setRaw()` calls `toStorable(value)` to wrap native
  types into storable form before storing.

> **Config lifecycle.** Both dispatch modules (`json-encoding-dispatch` and
> `storable-value-dispatch`) follow the same lifecycle pattern: the `Runtime`
> constructor calls the `set*Config()` function to activate the dispatch based
> on `ExperimentalOptions`, and `Runtime.dispose()` calls `reset*Config()` to
> restore defaults. This prevents flag leakage between runtime instances or
> test runs.

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

> **Base64url encoding convention.** All base64-encoded values in the JSON wire
> format use the URL-safe base64url alphabet (`A-Za-z0-9-_`, per RFC 4648
> Section 5) and **must omit** trailing `=` padding characters. Encoders must
> not emit padding; decoders must **reject** input containing `=` padding
> characters or standard-base64 characters (`+`, `/`). This convention applies
> to `Bytes@1`, `BigInt@1`, `EpochNsec@1`, and `EpochDays@1` state values.

```typescript
// file: packages/memory/json-type-handlers.ts (illustrative -- tag-to-format map)

/**
 * Standard JSON encodings for all built-in special types.
 *
 * In each case, the tag string (e.g. `"Link@1"`) is passed to the context's
 * internal `wrapTag()` method, which prepends `/` to produce the JSON key
 * (e.g. `"/Link@1"`).
 */

// Cell references (links to other documents)
// Tag: "Link@1"
// { "/Link@1": { id: string, path: string[], space: string } }

// Errors
// Tag: "Error@1"
// { "/Error@1": { type: string, name: string | null, message: string, stack?: string, cause?: ..., ... } }

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

// Binary data (base64url-encoded per the base64url convention above)
// Tag: "Bytes@1"
// { "/Bytes@1": string }

// Epoch nanoseconds (bigint, encoded per BigInt@1 conventions)
// Tag: "EpochNsec@1"
// { "/EpochNsec@1": string }
//
// The state is the base64url encoding of the bigint value's minimal two's
// complement representation in big-endian byte order — the same encoding
// as BigInt@1.

// Epoch days (bigint, encoded per BigInt@1 conventions)
// Tag: "EpochDays@1"
// { "/EpochDays@1": string }
//
// Same encoding convention as EpochNsec@1 (base64url of two's complement
// big-endian bytes).

// BigInts (base64url of two's complement big-endian bytes; see convention above)
// Tag: "BigInt@1"
// { "/BigInt@1": string }
//
// The state is the base64url encoding of the value's minimal two's complement
// representation in big-endian byte order. The minimum byte length is 1 —
// even `0n` produces a single `0x00` byte. Examples:
//   - `0n`  → single byte 0x00 → "AA"
//   - `1n`  → 0x01             → "AQ"
//   - `-1n` → 0xFF             → "_w"
//   - `128n` → 0x00 0x80       → "AIA"  (leading 0x00 needed: 0x80 alone would decode as -128)
//   - `-128n` → 0x80           → "gA"
// This matches the canonical hash byte format (Section 6.4), which already
// uses two's complement big-endian for BigInt payloads.
```

> **Deserialization validation.** Deserialization cannot assume type safety from
> the wire. Each type handler must validate the format of its state before
> processing. For example, a handler whose state is a base64url string (such as
> `BigInt@1`, `EpochNsec@1`, `EpochDays@1`, or `Bytes@1`) must validate that
> its state is a `string` containing valid unpadded base64url before decoding. On
> malformed input — wrong type, invalid format, or missing fields — the handler
> should produce a `ProblematicStorable` (Section 3.5) rather than throwing or
> silently producing garbage. This principle applies to all type handlers. Wire
> data is untrusted input. See Section 7.4 for the broader principle that
> applies to all code consuming deserialized values.

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
is a property of deserialization output, not of whether reconstruction
occurred. A caller receiving a value from the context's `decode()` can always assume
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

The JSON encoding context's internal `wrapTag()` / `unwrapTag()` methods
generate and parse `/<Type>@<Version>` keys. The context is also responsible
for:

- Re-wrapping unknown types using the `typeTag` preserved in
  `UnknownStorable` and `ExplicitTagStorable`.
- Managing the class registry for deserialization of known `StorableInstance`
  types (e.g., `StorableError`, `StorableMap`, `StorableSet`, `StorableRegExp`,
  `StorableUint8Array`).
- Providing a narrow `TypeHandlerCodec` view to type handlers during tree
  walking, exposing only `wrapTag()` and `getTagFor()`.

Note: `/object` escaping (Section 5.6) is applied directly by the context's
private `serialize()` method in its plain-objects path, since it is structural
escaping rather than type encoding.

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

### 6.3 Suggested Tag Bytes

The following single-byte type tags are used by the canonical hash byte format
and are recommended for any binary encoding of `StorableValue`s. They are
organized into three categories by high nibble:

**Meta tags (`0x0N`)** — structural markers that are not themselves value types:

| Tag               | Hex    | Decimal | Used for                        |
|:------------------|:-------|:--------|:--------------------------------|
| `TAG_END`         | `0x00` | 0       | end-of-sequence sentinel         |
| `TAG_HOLE`        | `0x01` | 1       | sparse array holes (run-length) |

**Compound tags (`0x1N`)** — containers whose children are tagged values:

| Tag               | Hex    | Decimal | Used for                        |
|:------------------|:-------|:--------|:--------------------------------|
| `TAG_ARRAY`       | `0x10` | 16      | plain arrays                    |
| `TAG_OBJECT`      | `0x11` | 17      | plain objects                   |
| `TAG_INSTANCE`    | `0x12` | 18      | `StorableInstance` (general)    |

**Primitive tags (`0x2N`)** — leaf value types:

| Tag               | Hex    | Decimal | Used for                        |
|:------------------|:-------|:--------|:--------------------------------|
| `TAG_NULL`        | `0x20` | 32      | `null`                          |
| `TAG_UNDEFINED`   | `0x21` | 33      | `undefined`                     |
| `TAG_BOOLEAN`     | `0x22` | 34      | `boolean`                       |
| `TAG_NUMBER`      | `0x23` | 35      | `number` (finite, non-NaN)      |
| `TAG_STRING`      | `0x24` | 36      | `string`                        |
| `TAG_BYTES`       | `0x25` | 37      | `StorableUint8Array`            |
| `TAG_BIGINT`      | `0x26` | 38      | `bigint`                        |
| `TAG_EPOCH_NSEC`  | `0x27` | 39      | `StorableEpochNsec`             |
| `TAG_EPOCH_DAYS`  | `0x28` | 40      | `StorableEpochDays`             |
| `TAG_CONTENT_ID`  | `0x29` | 41      | `StorableContentId`             |

All unassigned values are reserved for future use. The category structure
(meta/compound/primitive) is a convention for readability and is not enforced by
the encoding — a decoder should handle any tag byte it encounters regardless of
nibble range.

> **Scope.** These tag bytes are defined here for use by any wire format that
> needs to distinguish `StorableValue` types at the byte level. The canonical
> hash byte format (`2-canonical-hash-byte-format.md`) is the first consumer;
> future binary serialization formats may reuse the same tag assignments.

### 6.4 Hashing Algorithm

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
 * Specific hashing contexts (e.g., pattern ID generation vs. request
 * deduplication) specify which algorithm is used in that context.
 *
 * The return value is a `StorableContentId` instance (Section 1.4.9),
 * which encapsulates the raw hash bytes and the algorithm tag. The
 * algorithm tag for SHA-256 is `fid1` ("fabric ID, v1"). Callers who
 * need a string representation can call `toString()` on the result,
 * which produces `<algorithmTag>:<base64urlhash>` (unpadded base64url
 * with the URL-safe alphabet `A-Za-z0-9-_`, per RFC 4648 Section 5;
 * see Section 5.3).
 */
export function canonicalHash(
  value: StorableValue,
  algorithm?: 'sha256' | 'blake2b',
): StorableContentId {
  // Type tag bytes — see Section 6.3 for the full table.
  // Tag categories: meta (0x0N), compound (0x1N), primitive (0x2N).
  //
  // Implementation feeds type-tagged data into the hasher.
  // Byte-length prefixes for raw payloads use unsigned LEB128.
  // Compound types (array, object) use TAG_END instead of a count prefix.
  //
  // - `null`:              hash(TAG_NULL)
  // - `boolean`:           hash(TAG_BOOLEAN, boolByte)
  // - `number`:            hash(TAG_NUMBER, ieee754Float64Bytes)
  // - `string`:            hash(TAG_STRING, leb128(utf8ByteLen), utf8Bytes)
  // - `bigint`:            hash(TAG_BIGINT, leb128(byteLen), signedTwosComplementBytes)
  // - `undefined`:         hash(TAG_UNDEFINED)
  // - `StorableUint8Array`: hash(TAG_BYTES, leb128(byteLen), rawBytes)
  //                        (hashes the underlying byte content)
  // - `StorableEpochNsec`: hash(TAG_EPOCH_NSEC, leb128(byteLen), twosComplementBytes)
  //                        (same payload format as TAG_BIGINT but distinct tag)
  // - `StorableEpochDays`: hash(TAG_EPOCH_DAYS, leb128(byteLen), twosComplementBytes)
  //                        (same payload format as TAG_BIGINT but distinct tag)
  // - `StorableContentId`: hash(TAG_CONTENT_ID, leb128(algTagLen), algTagUtf8,
  //                              leb128(hashByteLen), hashBytes)
  //                        (algorithm tag as UTF-8 string, then raw hash bytes)
  // - array:               hash(TAG_ARRAY, ...elements, TAG_END)
  //                        Elements are hashed in index order:
  //                          if `i in array`: canonicalHash(array[i])
  //                          else (hole run): hash(TAG_HOLE, leb128(N))
  //                        TAG_END marks the end of the element sequence.
  //                        (order-preserving)
  //
  //                        Holes use run-length encoding in the hash
  //                        stream, matching the wire format: a maximal
  //                        run of N consecutive holes is hashed as a
  //                        single `TAG_HOLE` followed by the run length
  //                        (unsigned LEB128). A single hole is
  //                        `hash(TAG_HOLE, leb128(1))`.
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
  //                        `TAG_HOLE + leb128(N)` in the hash (since
  //                        the wire format also uses maximal runs).
  //                        When hashing from an in-memory array, the
  //                        implementation must count consecutive absent
  //                        indices to form maximal runs.
  // - object:              hash(TAG_OBJECT, ...sortedKeyValuePairs, TAG_END)
  //                        Keys sorted lexicographically by UTF-8.
  //                        Each pair: TAG_STRING key + tagged value.
  //                        TAG_END marks the end of the pair sequence.
  // - `StorableInstance`:  hash(TAG_INSTANCE, leb128(typeTagLen), typeTag,
  //                              canonicalHash(deconstructedState))
  //
  // The native object wrappers and temporal types are hashed as follows:
  //
  // - `StorableError`, `StorableMap`, `StorableSet`, `StorableRegExp`,
  //   and other `StorableInstance`s with recursively-processable
  //   deconstructed state are hashed via TAG_INSTANCE:
  //     hash(TAG_INSTANCE, leb128(typeTagLen), typeTag,
  //          canonicalHash(deconstructedState))
  //
  // - `StorableUint8Array` uses TAG_BYTES (dedicated primitive tag).
  // - `StorableEpochNsec` uses TAG_EPOCH_NSEC (dedicated primitive tag).
  // - `StorableEpochDays` uses TAG_EPOCH_DAYS (dedicated primitive tag).
  // - `StorableContentId` uses TAG_CONTENT_ID (dedicated primitive tag).
  //
  // Examples:
  // - `StorableError`:      hash(TAG_INSTANCE, ..., "Error@1", canonicalHash(errorState))
  // - `StorableMap`:        hash(TAG_INSTANCE, ..., "Map@1", canonicalHash(entries))
  //                         where entries are hashed in insertion order
  // - `StorableSet`:        hash(TAG_INSTANCE, ..., "Set@1", canonicalHash(elements))
  //                         where elements are hashed in insertion order
  // - `StorableRegExp`:     hash(TAG_INSTANCE, ..., "RegExp@1", canonicalHash({source, flags, flavor}))
  // - `StorableEpochNsec`:  hash(TAG_EPOCH_NSEC, leb128(byteLen), twosComplementBytes)
  // - `StorableEpochDays`:  hash(TAG_EPOCH_DAYS, leb128(byteLen), twosComplementBytes)
  // - `StorableContentId`:  hash(TAG_CONTENT_ID, leb128(algTagLen), algTagUtf8,
  //                               leb128(hashByteLen), hashBytes)
  // - `StorableUint8Array`: hash(TAG_BYTES, leb128(byteLen), rawBytes)
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

> **String encoding for hashing.** Strings are hashed as UTF-8 byte sequences,
> prefixed by their byte length (unsigned LEB128). See the byte-level spec
> (`2-canonical-hash-byte-format.md`, Section 4.4) for the precise encoding.

> **Map/Set ordering in hashing.** Canonical hashing preserves insertion order
> for `StorableMap` entries and `StorableSet` elements, matching the serialized
> form. This means two `StorableMap`s or `StorableSet`s with the same elements
> in different insertion order will hash differently. This is intentional:
> insertion order is part of the observable semantics of `Map`/`Set` in
> JavaScript, so values that behave differently should not hash the same. (By
> contrast, plain objects are hashed with sorted keys, matching the existing
> convention that plain-object key order is not semantically significant.)

### 6.5 Relationship to Late Serialization

Canonical hashing operates on `StorableValue` directly, using deconstructed
state for `StorableInstance`s (including the native object wrappers) and
type-specific handling for primitives and containers. This makes identity
hashing independent of any particular wire encoding — the same hash whether
later serialized to JSON, CBOR, or Automerge.

### 6.6 Use Cases

Canonical hashing is used for:
- Pattern ID generation (derived from pattern definition)
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

### 7.4 Untrusted Deserialized Input

**Deserialized values must not be trusted for type safety.** After
serialization and deserialization, a value may not conform to the TypeScript
type that code assumes — the wire format carries no type guarantees, and a
round-trip through JSON (or any other encoding) can silently produce values
whose runtime shape does not match their static type.

This applies at every point where deserialized data is consumed:

- **`[RECONSTRUCT]` implementations** (Section 2.4) receive `state:
  StorableValue`. The state has been deserialized by the serialization system,
  but its internal structure is determined by whatever was on the wire.
  Implementations must validate the shape of `state` at runtime — checking
  property existence, types, and constraints — rather than relying on a type
  cast (e.g., `state as { value: number }`). See the note in Section 2.7 for a
  concrete example.

- **JSON type handlers** (Section 5.3) must validate the format of their state
  before processing. Malformed input should produce a `ProblematicStorable`
  rather than throwing or silently producing garbage.

- **Canonical hashing** (Section 6.3) may operate on values that have been
  through a deserialization round-trip. Code that extracts properties from
  `StorableInstance` values (e.g., casting to `{ typeTag: string }`) must
  validate those properties at runtime.

- **Application code** that reads values from cells, IPC messages, or any other
  boundary listed in Section 4.7 should treat the values as untrusted until
  validated.

The general principle: a type cast (`as T`) is a compile-time assertion with no
runtime effect. After a serialization boundary, the only reliable way to
confirm a value's shape is runtime checking.

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
 * frozen. The caller's input is never mutated — if the top-level value is
 * an unfrozen array or object, a shallow copy is made before freezing. If
 * the input is already a frozen `StorableValue`, returns the same object.
 * Pass `freeze: false` to skip freezing (see below).
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
 * - **No caller mutation:** The caller's input objects are never frozen or
 *   modified in place. When freezing is needed, shallow copies are made
 *   first. If the input is already a deeply-frozen `StorableValue`, returns
 *   the same object (no copying needed).
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
| `SpecialPrimitiveValue` (`StorableEpochNsec`, `StorableEpochDays`, `StorableContentId`) | Returned as-is. Always-frozen: the `freeze` option has no effect on these types (see Section 1.4.6). |
| `StorableInstance` (including wrapper classes) | Returned as-is (already `StorableValue`). |
| `Error` | Wrapped into `StorableError`. Before wrapping, `cause` and custom enumerable properties are recursively converted to `StorableValue` (deep variant) or left as-is (shallow variant). Extra enumerable properties are preserved (see Section 1.4.1). This ensures that by the time `StorableError.[DECONSTRUCT]` runs, all nested values are already valid `StorableValue`. |
| `Map` | Wrapped into `StorableMap`. Keys and values are recursively converted (deep variant only). Extra enumerable properties on the `Map` object cause **rejection** (throw) — it is better to fail loudly than silently lose data. |
| `Set` | Wrapped into `StorableSet`. Elements are recursively converted (deep variant only). Extra enumerable properties on the `Set` object cause **rejection** (throw) — it is better to fail loudly than silently lose data. |
| `Date` | Wrapped into `StorableEpochNsec`. The `Date`'s millisecond timestamp is converted to nanoseconds: `BigInt(date.getTime()) * 1_000_000n`. Note the millisecond precision limitation — sub-millisecond information is not available from `Date`. Extra enumerable properties on the `Date` object cause **rejection** (throw) — it is better to fail loudly than silently lose data. |
| `RegExp` | Wrapped into `StorableRegExp`. The `source` and `flags` are extracted from the native `RegExp`; `flavor` defaults to `"es2025"` (it is a wrapper-level property, not a native `RegExp` property). Extra enumerable properties on the `RegExp` object cause **rejection** (throw) — it is better to fail loudly than silently lose data. |
| `Uint8Array` | Wrapped into `StorableUint8Array`. Extra enumerable properties on the `Uint8Array` object cause **rejection** (throw) — it is better to fail loudly than silently lose data. |
| `Blob` | **Throws.** `Blob` content is only accessible via asynchronous methods (`arrayBuffer()`, `stream()`), so the synchronous conversion path cannot extract its bytes. Callers must convert a `Blob` to `Uint8Array` before passing it to `toStorableValue()`. A future async conversion path may accept `Blob` directly. |
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

**Caller arguments are never mutated.** The conversion functions must not call
`Object.freeze()` on the caller's input objects. When `freeze` is `true` and
the input is an unfrozen array or plain object, the function creates a shallow
copy and freezes the copy. This ensures that callers can safely pass mutable
data structures without side effects — the caller's objects remain mutable
after the call returns. (Wrapper objects like `StorableError` are freshly
constructed by the conversion function, so freezing them is not a mutation of
caller state.)

**Always-frozen types bypass the `freeze` option.** JS primitives (`null`,
`boolean`, `number`, `string`, `undefined`, `bigint`) are inherently immutable
and pass through unchanged regardless of the `freeze` setting.
`SpecialPrimitiveValue` instances (`StorableEpochNsec`, `StorableEpochDays`,
`StorableContentId`) are treated the same way — they are always returned as-is,
never copied or modified by the freeze/thaw logic. Their state is immutable by
construction (readonly fields, no mutation methods), so `Object.freeze()` is
unnecessary and thawing is meaningless. See Section 1.4.6.

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
 * Type predicate: returns `true` if `toDeepStorableValue()` would succeed on
 * the given value — i.e., the value is a `StorableValue`, a
 * `StorableNativeObject`, or a tree of these types. The return type is a
 * type predicate (`value is StorableValue | StorableNativeObject`), so
 * callers can use `canBeStored(x)` as a type guard in conditionals.
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
export function canBeStored(
  value: unknown,
): value is StorableValue | StorableNativeObject;
```

The function recursively checks the value tree. It returns `true` if and only
if the value is:

- A primitive (`null`, `boolean`, `number` (finite), `string`, `undefined`,
  `bigint`)
- A `StorableInstance` (including the native object wrapper classes)
- A `StorableNativeObject` (`Error`, `Map`, `Set`, `Date`, `RegExp`,
  `Uint8Array`, or an object with a `toJSON()` method — legacy)
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
 * - `StorableError`      -> `Error` (original if freeze state matches; copy otherwise)
 * - `StorableMap`        -> `FrozenMap` / `Map` (original if freeze state matches; copy otherwise)
 * - `StorableSet`        -> `FrozenSet` / `Set` (original if freeze state matches; copy otherwise)
 * - `StorableRegExp`     -> `RegExp` (frozen or unfrozen; see note on `lastIndex`)
 * - `StorableEpochNsec`  -> the bigint value (nanoseconds from POSIX Epoch)
 * - `StorableEpochDays`  -> the bigint value (days from POSIX Epoch)
 * - `StorableContentId`  -> passed through unchanged (always-frozen; Section 1.4.6)
 * - `StorableUint8Array` -> `Blob` (when frozen) or original `Uint8Array` (when not)
 *
 * Non-wrapper `StorableInstance` values (`Cell`, `Stream`, `UnknownStorable`,
 * `ProblematicStorable`, etc.) pass through unchanged.
 *
 * **Shallow:** Only unwraps the top-level value. Array elements and object
 * property values are not recursively unwrapped. However, non-wrapper values
 * (arrays, plain objects) may be copied to match the `frozen` argument —
 * for example, a frozen array is returned as-is when `frozen` is `true`,
 * but a new unfrozen copy is returned when `frozen` is `false`.
 *
 * **The `frozen` argument is always honored.** The freeze state of every
 * value in the output matches the `frozen` argument. When `freeze` is `true`
 * (the default), `StorableMap` and `StorableSet` unwrap to `FrozenMap` and
 * `FrozenSet` respectively — effectively-immutable wrappers that expose
 * read-only interfaces and throw on mutation attempts. The temporal types
 * (`StorableEpochNsec`, `StorableEpochDays`) unwrap to their bigint values,
 * which are inherently immutable primitives. `StorableContentId` passes
 * through unchanged — it is always-frozen (Section 1.4.5).
 * `StorableUint8Array` unwraps to `Blob`, which is
 * inherently immutable (see rationale below). `StorableError` unwraps to a
 * frozen `Error`. This preserves the immutable-forward guarantee even in the
 * "JS wild west" layer. When `freeze` is `false`, mutable native types are
 * returned instead.
 *
 * **No defensive copying.** Wrappers return their internal reference directly
 * when the freeze state already matches. A new object is constructed only
 * when the type must change to satisfy the `frozen` argument (e.g., wrapping
 * a plain `Map` in `FrozenMap`). The wrapper's purpose is to provide the
 * storable interface, not to
 * act as a data firewall.
 */
export function nativeValueFromStorableValue(
  value: StorableValue,
  freeze?: boolean, // default: true
): StorableValue | StorableNativeObject;

/**
 * Deep variant: recursively unwraps wrapper classes throughout the value tree.
 * The `freeze` parameter controls whether immutable variants are used for
 * collections and binary data (default: `true`).
 */
export function deepNativeValueFromStorableValue(
  value: StorableValue,
  freeze?: boolean, // default: true
): StorableValue | StorableNativeObject;
```

#### Unwrapping Rules

| Input | Output (frozen) | Output (not frozen) |
|-------|-----------------|---------------------|
| `StorableError` | `Error` (original if already frozen; frozen copy otherwise) | `Error` (original if already unfrozen; mutable copy otherwise) |
| `StorableMap` | `FrozenMap` (original if already `FrozenMap`; new wrapper otherwise) | `Map` (original if already plain `Map`; mutable copy otherwise) |
| `StorableSet` | `FrozenSet` (original if already `FrozenSet`; new wrapper otherwise) | `Set` (original if already plain `Set`; mutable copy otherwise) |
| `StorableRegExp` | `RegExp` (frozen via `Object.freeze()`; `lastIndex` immutable) | `RegExp` (original reference; mutable `lastIndex`) |
| `StorableEpochNsec` | `bigint` (the nanosecond value; inherently immutable) | `bigint` (same — primitives have no mutable/immutable distinction) |
| `StorableEpochDays` | `bigint` (the day value; inherently immutable) | `bigint` (same) |
| `StorableContentId` | Passed through unchanged (always-frozen; Section 1.4.6) | Passed through unchanged (same) |
| `StorableUint8Array` | `Blob` (inherently immutable; always new) | `Uint8Array` (original reference) |
| Other `StorableInstance` | Passed through unchanged | Passed through unchanged |
| Primitives | Passed through unchanged | Passed through unchanged |
| Arrays (deep variant) | Recursively unwrapped; output frozen | Recursively unwrapped; output NOT frozen |
| Plain objects (deep variant) | Recursively unwrapped; output frozen | Recursively unwrapped; output NOT frozen |

The output type is `StorableValue | StorableNativeObject`, reflecting that the
result may contain native JS types at any depth.

**The `frozen` parameter is always honored.** The freeze state of every value in
the output tree matches the `frozen` argument. Specifically:

- If `frozen` is `true` and the value's freeze state already matches, the
  original reference is returned as-is.
- If `frozen` is `true` and the value is unfrozen, a new frozen variant is
  constructed (e.g., wrapping a `Map` in `FrozenMap`).
- If `frozen` is `false` and the value is frozen, a new unfrozen (mutable) copy
  is returned.
- If `frozen` is `false` and the value is already unfrozen, the original
  reference is returned as-is (or a copy is returned if structural changes are
  needed, e.g., unwrapping children in the deep variant).

This applies uniformly to all output values — arrays, plain objects, `Error`s,
and all wrapper-derived native types. Primitives are inherently immutable and
need no freeze/thaw action. A new object is constructed only when the freeze
state differs between the stored value and the requested output.

For the **shallow** function, non-wrapper values (arrays and plain objects) may
be copied to match the `frozen` argument. Primitives pass through unchanged.

**Deep variant recurses into `StorableError` internals.** The deep variant
(`deepNativeValueFromStorableValue`) recurses into `StorableError` internals —
specifically, the `cause` chain and custom enumerable properties — unwrapping any
nested `StorableInstance` values. This ensures the output is fully "native JS"
with no storable wrappers at any depth. Without this recursion, an Error's
`cause` could still contain `StorableInstance` wrappers (e.g., a nested
`StorableError`).

> **Why `FrozenMap` / `FrozenSet`?** `Object.freeze()` does not prevent
> mutation of `Map` and `Set` — their `set()`, `delete()`, `add()`, and
> `clear()` methods remain callable on a frozen instance. `FrozenMap` and
> `FrozenSet` are thin wrappers that expose the read-only subset of the
> `Map`/`Set` API (`get`, `has`, `entries`, `forEach`, `size`, etc.) and throw
> on any mutation attempt. This ensures that data round-tripped through the
> storable layer remains effectively immutable even after unwrapping. The exact
> API of `FrozenMap` and `FrozenSet` is an implementation decision.

> **Why bigint for temporal unwrapping?** `StorableEpochNsec` and
> `StorableEpochDays` unwrap to their raw `bigint` values rather than to
> `Date` objects. This avoids precision loss (JS `Date` has only millisecond
> precision, while epoch nanoseconds can represent sub-millisecond instants)
> and bigint is an immutable primitive, so no freeze/thaw action is needed.
> Callers who need a `Date` for interop can construct one from the nanosecond
> value: `new Date(Number(epochNsec / 1_000_000n))` (with the caveat that
> sub-millisecond precision is lost).

> **Why `Blob` for frozen `Uint8Array`?** `Object.freeze()` does not prevent
> mutation of typed array contents — the indexed elements of a `Uint8Array`
> remain writable on a frozen instance. `Blob` is the standard Web API type
> for immutable binary data: once created, its contents cannot be modified.
> Callers who need byte-level access can use `await blob.arrayBuffer()` or
> `blob.stream()` to read the data. When `freeze` is `false`, a regular
> mutable `Uint8Array` is returned instead.
>
> **Asymmetry note:** `Blob` is an output type only — `nativeValueFromStorableValue()`
> may return a `Blob`, but `toStorableValue()` does not accept `Blob` as input
> because `Blob` content is only accessible asynchronously. Callers converting
> a `Blob` back to `StorableValue` must first extract its bytes (e.g.,
> `new Uint8Array(await blob.arrayBuffer())`) and pass the `Uint8Array`. A
> future async conversion path may accept `Blob` directly.

### 8.6 Round-Trip Guarantees

For any supported value `v`:

```
deepNativeValueFromStorableValue(toDeepStorableValue(v))
```

produces a value that is structurally equivalent to `v` — the same data at the
same positions. The round-tripped value may or may not be `===` to the original:
when the freeze state already matches, wrappers return their internal reference
directly; when it differs, a new object is constructed. The **freeze state of
the output always matches the `frozen` argument**: when `frozen` is `true` (the
default), the output tree is fully frozen — arrays and plain objects are frozen
via `Object.freeze()`, a mutable `Map` becomes a `FrozenMap`, a mutable `Set`
becomes a `FrozenSet`, temporal wrappers unwrap to their bigint values, a
`Uint8Array` becomes
a `Blob`, and `Error`s are frozen. When `frozen` is `false`, the output tree is
fully mutable. The data content is preserved; the mutability matches the `frozen`
argument.

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

- **Exact canonical hash specification**: The precise byte-level format is
  defined in `2-canonical-hash-byte-format.md`. All lengths and counts use
  unsigned LEB128 encoding; see that document for the complete specification
  of type tags, encoding per type, and illustrative examples.

- **Migration path**: Out of scope for this spec. The detailed migration plan
  (sequencing of flag introductions, criteria for graduating each flag to
  default-on) will be addressed in a separate document.

- **`ReconstructionContext` extensibility**: The minimal interface defined in
  Section 2.5 covers `Cell` reconstruction. Other future storable types may
  need additional context methods. Should the interface be extended, or should
  types cast to a broader interface? Recommendation: extend the interface as
  needed; the indirection through an interface (rather than depending on
  `Runtime` directly) makes this straightforward.
