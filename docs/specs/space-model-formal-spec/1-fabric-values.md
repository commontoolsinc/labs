# Fabric Values

This document specifies the immutable data representation for the Space Model:
what values can be stored, how custom types participate in serialization, and how
values are identified by content.

## Status

Draft formal spec — extracted from the data model proposal.

---

## 1. Fabric Value Types

### 1.1 Overview

The system stores **fabric values** — data that can flow through the runtime
as modern types and be serialized to wire/storage formats at boundary crossings.
All persistent data and in-flight messages use this representation.

The key design principle is **late serialization**: modern types flow through the
runtime as themselves; serialization to wire/storage formats happens only at
boundary crossings (persistence, IPC, network).

#### Three-Layer Architecture

The data model is organized into three explicit layers:

```
JavaScript "wild west" (unknown/any) <-> Strongly typed (FabricValue) <-> Serialized (Uint8Array)
```

- **Left layer — JS wild west.** Arbitrary JavaScript values (`unknown`/`any`),
  including native objects like `Error`, `Map`, `Set`, `Date`, `RegExp`, and `Uint8Array`.
  Code in this layer has no type guarantees about what it is handling.

- **Middle layer — `FabricValue`.** The strongly typed core of the data model.
  Contains only primitives, `FabricInstance` implementations (including wrapper
  classes for native JS types), and recursive containers. No raw native JS
  objects appear at this layer — they are wrapped into `FabricInstance`
  implementations by the conversion functions (Section 8).

- **Right layer — Serialized form.** The wire/storage representation
  (`Uint8Array` for binary formats, JSON-compatible trees for the JSON context).
  Serialization operates exclusively on `FabricValue` input; it never sees raw
  native JS objects.

Conversion functions bridge the left and middle layers:
`shallowFabricFromNativeValue()` / `fabricFromNativeValue()` convert from JS
values to `FabricValue`, wrapping native objects into `FabricInstance` wrappers
and freezing the result. `nativeFromFabricValue()` converts back, unwrapping
`FabricInstance` wrappers to their native JS equivalents. See Section 8 for
the full specification of these functions.

### 1.2 Type Universe

A `FabricValue` is defined as the following union. This is the **middle
layer** — the strongly typed core. Raw native JS objects (`Error`, `Map`, `Set`,
`Date`, `RegExp`, `Uint8Array`) do not appear here; they are handled by the conversion
layer (Section 8) and represented in `FabricValue` trees as `FabricInstance`
wrapper classes (Section 1.4).

> **Package note:** The data model implementation lives in
> `packages/data-model/`. The fabric-value types, base classes
> (`FabricSpecialObject`, `FabricInstance`, `FabricPrimitive`), and
> protocol symbols (`DECONSTRUCT`, `RECONSTRUCT`) are defined in
> `packages/data-model/interface.ts`. The dispatch and conversion
> functions are in `packages/data-model/fabric-value.ts`. Type declarations visible to
> patterns are in `packages/api/index.ts` (inline `interface` + `declare
> const` pattern). The `packages/runner/` wires concrete implementations
> into builder exports.

```typescript
// file: packages/data-model/fabric-value.ts

/**
 * The complete set of values that can flow through the runtime, be stored
 * persistently, or be transmitted across boundaries. This is the "middle
 * layer" of the three-layer architecture — no raw native JS objects appear
 * here.
 */
type FabricValue =
  // (a) Primitives
  | null
  | boolean
  | number    // finite only; `NaN` and `Infinity` rejected
  | string
  | undefined // first-class fabric value; requires tagged representation in formats lacking native `undefined`
  | bigint    // large integers; rides through without wrapping (like `undefined`)

  // (b) Special primitives (FabricPrimitive subclasses — always frozen)
  | FabricEpochNsec
  | FabricEpochDays
  | FabricHash
  | FabricBytes

  // (c) Branded fabric types (custom types implementing the fabric protocol)
  //     This arm covers:
  //       - Native object wrappers: `FabricError`, `FabricMap`,
  //         `FabricSet`, `FabricRegExp` (Section 1.4)
  //       - User-defined types: `Cell`, `Stream`, etc.
  //       - System types: `UnknownValue`, `ProblematicValue`
  | FabricInstance

  // (d) Recursive containers
  | FabricValue[]
  | { [key: string]: FabricValue };
```

> **Excluded JS types.** The following JavaScript types are explicitly **not**
> representable as fabric values, eliciting a thrown error from
> `fabricFromNativeValue()` and a `false` return value from
> `isFabricCompatible()`:
>
> - `symbol` — Symbols are inherently local (not serializable across realms or
>   processes). Symbol-keyed properties on objects are silently ignored; a bare
>   `symbol` value is rejected outright.
> - `function` — Functions are opaque closures with no portable representation.
>   Objects with a `[DECONSTRUCT]` method are not functions in this sense — they
>   are `FabricInstance`s.
>
> These are the two JS primitive types (`typeof` returns `"symbol"` or
> `"function"`) that are absent from the `FabricValue` union. All other
> `typeof` results (`"undefined"`, `"boolean"`, `"number"`, `"string"`,
> `"bigint"`, `"object"`) have corresponding `FabricValue` arms.

#### `FabricNativeObject`

A separate type — **outside** the `FabricValue` hierarchy — defines the raw
native JS object types that the conversion layer can handle:

```typescript
// file: packages/data-model/fabric-value.ts

/**
 * Union of raw native JS object types that the conversion layer can translate
 * to and from `FabricValue`. These types sit outside the `FabricValue`
 * hierarchy and only appear at conversion function boundaries (Section 8).
 *
 * Primitives like `bigint` and `undefined` are NOT included — they are
 * directly part of `FabricValue`. The wrapper classes (`FabricError`,
 * `FabricMap`, `FabricRegExp`, etc.) are also NOT this type — they are `FabricInstance`
 * implementations that live inside `FabricValue`.
 */
type FabricNativeObject =
  | Error
  | Map<FabricValue | FabricNativeObject, FabricValue | FabricNativeObject>
  | Set<FabricValue | FabricNativeObject>
  | Date
  | RegExp
  | Uint8Array
  | { toJSON(): unknown }; // Legacy — see below.
```

The `FabricNativeObject` type exists solely at function parameter/return
boundaries — for example, `shallowFabricFromNativeValue()` accepts
`FabricValue | FabricNativeObject` as input (Section 8). It is never a
member of `FabricValue`.

> **Legacy: `{ toJSON(): unknown }` variant.** The `toJSON()` arm of
> `FabricNativeObject` represents objects that provide a `toJSON()` method.
> The conversion functions call `toJSON()` and process the
> result (Section 8.2). This variant is **legacy and marked for removal** —
> callers should migrate to the fabric protocol
> (`[DECONSTRUCT]`/`[RECONSTRUCT]`). See Section 7.1 for migration guidance.

### 1.3 Primitive Types

| Type | Constraints | Notes |
|------|-------------|-------|
| `null` | None | The null value |
| `boolean` | None | `true` or `false` |
| `number` | Must be finite | `-0` normalized to `0`; `NaN`/`Infinity` rejected |
| `string` | None | Unicode text |
| `undefined` | None | First-class fabric value; see note below |
| `bigint` | None | Large integers; JSON-encoded as base64url (RFC 4648, Section 5) of two's complement big-endian bytes (Section 5.3) |

> **`undefined` as a first-class fabric value.** `undefined` is a first-class
> fabric value that round-trips faithfully through serialization. Because most
> wire formats (including JSON) have no native `undefined` representation, the
> serialization system uses a dedicated tagged form for `undefined` — the same
> tagged form regardless of context (array element, object property value, or
> top-level value). See Section 5.3 for the specific JSON encoding. Deletion
> semantics (e.g., removing a cell's value when `undefined` is written at top
> level) are an application-level concern, not a serialization concern: the
> serializer faithfully records `undefined` and the application layer interprets
> the result.

> **`-0` normalization:** Negative zero (`-0`) is normalized to positive zero
> (`0`) during fabric-value conversion (i.e., `shallowFabricFromNativeValue()`),
> before the value reaches a serialization boundary. This matches
> `JSON.stringify` behavior and ensures that `0` and `-0` produce the same
> serialized form and canonical hash. In the current codebase, this
> normalization happens in `packages/data-model/fabric-value-modern.ts` at the
> `shallowFabricFromNativeValueModern()` call site.

> **Future: `-0` and non-finite numbers.** The current design normalizes `-0`
> and rejects `NaN`/`Infinity`/`-Infinity`. Because the serialization system
> uses typed tags (Section 5), a future version could represent these values
> with full fidelity via dedicated type tags, without ambiguity. This option is
> preserved by the architecture but not currently needed.

### 1.4 Native Object Wrapper Classes

Certain built-in JS types (`Error`, `Map`, `Set`, `RegExp`) cannot
have `Symbol`-keyed methods added via prototype patching in a reliable,
cross-realm way. Rather than handling them with special-case logic in the
serializer, the system defines **wrapper classes** — one per native type — that
implement `FabricInstance`. The conversion layer (Section 8) wraps raw native
objects into these classes when bridging from the JS wild west to `FabricValue`,
and unwraps them when bridging back.

Because each wrapper genuinely implements `FabricInstance` (with real
`[DECONSTRUCT]` and `[RECONSTRUCT]` methods), the serialization system
processes them through the same uniform `FabricInstance` path — no special
cases needed in the serializer. The hashing system also uses the standard
`TAG_INSTANCE` path for all wrappers. `FabricBytes` (the byte-sequence type)
has a dedicated `TAG_BYTES` tag for content-level identity (see Section 6.3),
but it is a `FabricPrimitive`, not a `FabricInstance`.

The **special primitive** types (`FabricEpochNsec`, `FabricEpochDays`,
`FabricHash`, `FabricBytes`) are **not** `FabricInstance`s — they are
`FabricPrimitive` subclasses (Section 1.4.6). `FabricPrimitive` extends
`FabricSpecialObject`, and the `FabricValue` union includes
`FabricSpecialObject`, so all `FabricPrimitive` subclasses are implicitly
members of `FabricValue`. They are always-frozen value types that bypass the
`freeze` option in conversion functions. They have dedicated canonical hash
tags and dedicated `TypeHandler`s for wire format serialization, but they do
not implement `[DECONSTRUCT]`, `[RECONSTRUCT]`, or carry a `typeTag`
property.

#### 1.4.1 Wrapper Class Summary

| Wrapper Class | Wraps | Type Tag | Deconstructed State | Notes |
|---------------|-------|----------|---------------------|-------|
| `FabricError` | `Error` | `Error@1` | `{ type, name, message, stack?, cause?, ...custom }` | `type` is the constructor name (e.g. `"TypeError"`). `name` is the `.name` property if it differs from `type`, or `null` if it matches (the common case). Includes `message`, `stack` (if present), `cause` (if present), and custom enumerable properties. The conversion layer (Section 8.2) recursively converts nested values (including `cause` and custom properties) before wrapping, ensuring all values are `FabricValue` when `[DECONSTRUCT]` runs. |
| `FabricMap` | `Map` | `Map@1` | `[[key, value], ...]` | Entry pairs as an array of two-element arrays. Insertion order is preserved. Keys and values are recursively processed. |
| `FabricSet` | `Set` | `Set@1` | `[value, ...]` | Elements as an array. Iteration order is preserved. Values are recursively processed. |
| `FabricRegExp` | `RegExp` | `RegExp@1` | `{ source, flags, flavor }` | `source` is the pattern string (`regex.source`); `flags` is the flag string (`regex.flags`); `flavor` is the regex dialect identifier (e.g. `"es2025"`). Extra enumerable properties cause rejection. |

Each wrapper class above:

- **Extends `FabricNativeWrapper<T>`** (which in turn extends
  `FabricInstance`), inheriting the `shallowClone()` frozenness-management
  method and providing a `toNativeValue(frozen)` method for unwrapping.
- **Has a `[DECONSTRUCT]` method** that extracts essential state from the
  wrapped native object.
- **Has a static `[RECONSTRUCT]` method** (following the `FabricClass<T>`
  pattern) that returns an instance of the wrapper class — **not** the raw
  native type. Callers who need the underlying native object use
  `nativeFromFabricValue()` (Section 8) to unwrap it.
- **Carries a `typeTag` property** (e.g., `"Error@1"`) used by the
  serialization context for tag resolution, following the pattern established
  by `UnknownValue` and `ProblematicValue`.

##### `FabricNativeWrapper<T>` Base Class

All native object wrappers share an abstract base class that extends
`FabricInstance` and adds methods for unwrapping back to native form:

```typescript
// file: packages/data-model/fabric-native-instances.ts

/**
 * Abstract base class for `FabricInstance` wrappers that bridge native JS
 * objects (Error, Map, Set, RegExp) into the `FabricValue` layer. Provides
 * a common `toNativeValue()` method used by the unwrap functions
 * (`nativeFromFabricValue`, Section 8.4), replacing `instanceof`
 * cascades with a single `instanceof FabricNativeWrapper` check.
 */
abstract class FabricNativeWrapper<T extends object>
  extends FabricInstance {
  abstract readonly typeTag: string;

  /** The wrapped native value, used by `toNativeValue` for freeze-state checks. */
  protected abstract get wrappedValue(): T;

  /** Convert the wrapped value to frozen form (only called on state mismatch). */
  protected abstract toNativeFrozen(): T;

  /** Convert the wrapped value to thawed form (only called on state mismatch). */
  protected abstract toNativeThawed(): T;

  /** Return the underlying native value, optionally frozen. */
  toNativeValue(frozen: boolean): T {
    const value = this.wrappedValue;
    if (frozen === Object.isFrozen(value)) return value;
    return frozen ? this.toNativeFrozen() : this.toNativeThawed();
  }
}
```

The `toNativeValue(frozen)` method returns the original wrapped value when
its freeze state already matches the `frozen` argument, and constructs a new
instance only when a freeze-state change is needed. This avoids defensive
copying in the common case and centralizes the freeze-state logic for all
wrapper types.

Unlike the wrappers above, the special primitive types (`FabricEpochNsec`,
`FabricEpochDays`, `FabricHash`, `FabricBytes`) are **`FabricPrimitive`
subclasses** and do not extend `FabricInstance`. They are included in
`FabricValue` via the `FabricSpecialObject` arm of the union (Section 1.4.6).
See Sections 1.4.6 through 1.4.10.

| Special Primitive Type | Extends | Wire Tag | Stored Value | Notes |
|------------------------|---------|----------|--------------|-------|
| `FabricEpochNsec` | `FabricPrimitive` | `EpochNsec@1` | `bigint` (signed nanoseconds from POSIX Epoch) | Primary temporal type. JS `Date` has only millisecond precision; conversion from `Date` multiplies by 10^6. When `Temporal` is available, `Temporal.Instant` maps naturally (it uses nanoseconds from epoch internally). |
| `FabricEpochDays` | `FabricPrimitive` | `EpochDays@1` | `bigint` (signed days from POSIX Epoch) | Day-precision temporal type. Anticipates `Temporal.PlainDate`. Mostly nascent — class and spec entry are defined, but full integration (Temporal types, calendar concerns) is deferred. |
| `FabricHash` | `FabricPrimitive` | _(none — see Section 1.4.9)_ | `Uint8Array` (hash bytes, private) + `string` (algorithm tag) | Content identifier / hash. Stringifies as `<tag>:<base64urlhash>` (unpadded base64url, RFC 4648 Section 5). The first algorithm tag is `fid1` ("fabric ID, v1"). |
| `FabricBytes` | `FabricPrimitive` | `Bytes@1` | `Uint8Array` (private byte storage) | Immutable byte sequence. Input bytes are copied at construction time. Callers access bytes via `slice()`, `copyInto()`, and `length`. |

#### Extra Enumerable Properties

**`FabricError`** MAY carry extra enumerable properties beyond the standard
fields (`type`, `name`, `message`, `stack`, `cause`). Custom properties on `Error`
objects are common JavaScript practice (e.g., `error.code`, `error.statusCode`),
so `FabricError` preserves them: `[DECONSTRUCT]` includes them in its output,
and `[RECONSTRUCT]` restores them on the reconstructed `Error`.

**`FabricMap`, `FabricSet`, `FabricRegExp`, `FabricEpochNsec`,
`FabricEpochDays`, `FabricHash`, `FabricBytes`** must NOT carry
extra enumerable
properties. Their
stored value contains only the essential native data (entries, items,
epoch value, bytes respectively). Extra enumerable properties on the source
native object cause **rejection** — the conversion function throws. This follows
the principle "Death before confusion!" (Mark Miller): it is better to fail
loudly than to silently lose data. This matches the treatment of arrays, where
extra non-index properties also cause rejection (Section 1.5). Unlike `Error`,
these native types have no established convention for custom properties.

#### 1.4.2 `FabricError`

```typescript
// file: packages/data-model/fabric-native-instances.ts

import {
  DECONSTRUCT, RECONSTRUCT,
  FabricInstance, type ReconstructionContext,
} from './interface';

/**
 * Wrapper for native `Error` values. Extends `FabricNativeWrapper<Error>`
 * so that errors participate in the standard serialization, hashing, and
 * unwrapping paths.
 */
export class FabricError extends FabricNativeWrapper<Error> {
  readonly typeTag = 'Error@1';

  constructor(readonly error: Error) {
    super();
  }

  [DECONSTRUCT](): FabricValue {
    // IMPORTANT: By the time [DECONSTRUCT] is called, all nested values
    // must already be FabricValue. The conversion layer (Section 8.2)
    // is responsible for recursively converting Error internals (cause,
    // custom properties) BEFORE wrapping into FabricError. This method
    // simply extracts the already-converted state.
    //
    // `type` is the constructor name (e.g. "TypeError"), while `name` is
    // the `.name` property (which may differ if overridden). Since
    // `type === name` is the common case, `name` is emitted as `null`
    // when it matches `type` to avoid redundancy. `[RECONSTRUCT]`
    // interprets `null` name as "same as type."
    const type = this.error.constructor.name;
    const state: Record<string, FabricValue> = {
      type,
      name:    this.error.name === type ? null : this.error.name,
      message: this.error.message,
    };
    if (this.error.stack !== undefined) {
      state.stack = this.error.stack;
    }
    if (this.error.cause !== undefined) {
      state.cause = this.error.cause as FabricValue;
    }
    for (const key of Object.keys(this.error)) {
      if (!(key in state) && key !== '__proto__' && key !== 'constructor') {
        state[key] = (this.error as Record<string, unknown>)[key] as FabricValue;
      }
    }
    return state as FabricValue;
  }

  static [RECONSTRUCT](
    state: FabricValue,
    _context: ReconstructionContext,
  ): FabricError {
    const s = state as Record<string, FabricValue>;
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
    return new FabricError(error);
  }
}
```

#### 1.4.3 `FabricMap`

```typescript
export class FabricMap
  extends FabricNativeWrapper<Map<FabricValue, FabricValue>> {
  readonly typeTag = 'Map@1';

  constructor(readonly map: Map<FabricValue, FabricValue>) {
    super();
  }

  [DECONSTRUCT](): FabricValue {
    return [...this.map.entries()] as FabricValue;
  }

  static [RECONSTRUCT](
    state: FabricValue,
    _context: ReconstructionContext,
  ): FabricMap {
    const entries = state as [FabricValue, FabricValue][];
    return new FabricMap(new Map(entries));
  }
}
```

#### 1.4.4 `FabricSet`

```typescript
export class FabricSet extends FabricNativeWrapper<Set<FabricValue>> {
  readonly typeTag = 'Set@1';

  constructor(readonly set: Set<FabricValue>) {
    super();
  }

  [DECONSTRUCT](): FabricValue {
    return [...this.set] as FabricValue;
  }

  static [RECONSTRUCT](
    state: FabricValue,
    _context: ReconstructionContext,
  ): FabricSet {
    const elements = state as FabricValue[];
    return new FabricSet(new Set(elements));
  }
}
```

#### 1.4.5 `FabricRegExp`

```typescript
// file: packages/data-model/fabric-native-instances.ts

import {
  DECONSTRUCT, RECONSTRUCT,
  FabricInstance, type ReconstructionContext,
} from './interface';

/**
 * Wrapper for native `RegExp` values. Extends `FabricNativeWrapper<RegExp>`
 * so that regular expressions participate in the standard serialization,
 * hashing, and unwrapping paths.
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
export class FabricRegExp extends FabricNativeWrapper<RegExp> {
  readonly typeTag = 'RegExp@1';

  constructor(
    readonly regex: RegExp,
    readonly flavor: string = 'es2025',
  ) {
    super();
  }

  [DECONSTRUCT](): FabricValue {
    return {
      source: this.regex.source,
      flags: this.regex.flags,
      flavor: this.flavor,
    };
  }

  static [RECONSTRUCT](
    state: FabricValue,
    _context: ReconstructionContext,
  ): FabricRegExp {
    const s = state as { source: string; flags: string; flavor?: string };
    const flavor = s.flavor ?? 'es2025';
    return new FabricRegExp(new RegExp(s.source, s.flags), flavor);
  }
}
```

#### 1.4.6 `FabricSpecialObject` and `FabricPrimitive` (Base Classes)

The fabric type hierarchy uses two abstract base classes that share a common
root:

```
FabricSpecialObject (abstract root)
├── FabricInstance (abstract — protocol types with DECONSTRUCT/RECONSTRUCT)
└── FabricPrimitive (abstract — immutable special primitives)
```

**`FabricSpecialObject`** is the common superclass of both branches. It enables
a single `instanceof FabricSpecialObject` check wherever code needs to recognize
any fabric-system value without caring which branch it belongs to.

```typescript
// file: packages/data-model/interface.ts

/**
 * Abstract base class for all fabric-system value types. This is the common
 * superclass of `FabricInstance` (protocol types with DECONSTRUCT/RECONSTRUCT)
 * and `FabricPrimitive` (immutable special primitives). It enables a single
 * `instanceof FabricSpecialObject` check wherever code needs to recognize any
 * fabric-system value without caring which branch of the hierarchy it
 * belongs to.
 */
export abstract class FabricSpecialObject {}
```

**`FabricPrimitive`** is the abstract base class for non-`FabricInstance` types
that are included in `FabricValue` via the `FabricSpecialObject` arm of the
union. It extends `FabricSpecialObject`.

- `ExplicitTagValue` is the base for `FabricInstance` subtypes that carry
  an explicit wire-format tag (`UnknownValue`, `ProblematicValue`).
- `FabricPrimitive` is the base for types that behave like primitives but
  need a class wrapper (`FabricEpochNsec`, `FabricEpochDays`, `FabricHash`,
  `FabricBytes`).

```typescript
// file: packages/data-model/interface.ts

/**
 * Abstract base class for "special primitive" fabric types — values that
 * behave like primitives in the fabric type system but are represented as
 * class instances for type safety and dispatch. Covers temporal types,
 * content IDs, byte sequences, and similar.
 *
 * Extends `FabricSpecialObject` so that `instanceof FabricSpecialObject`
 * catches both `FabricPrimitive` and `FabricInstance` subtypes.
 *
 * **Always-frozen semantics:** `FabricPrimitive` instances are treated as
 * inherently frozen, like JS primitives (`number`, `string`, `bigint`,
 * etc.). The `freeze` option on conversion functions
 * (`shallowFabricFromNativeValue()`, `fabricFromNativeValue()`, etc.)
 * does not affect them — they are always
 * returned as-is, regardless of the `freeze` setting. This is because
 * their state is immutable by construction (readonly fields, no mutation
 * methods), so freezing is a no-op and thawing is meaningless. Each leaf
 * subclass must call `Object.freeze(this)` at the end of its constructor,
 * after all fields are initialized.
 */
export abstract class FabricPrimitive extends FabricSpecialObject {}
```

Subclasses define their own state (e.g., `readonly value: bigint` for temporal
types, private `#hash: Uint8Array` + private `#tag: string` for content IDs,
private `#bytes: Uint8Array` for byte sequences). The base class holds no
state — its purpose is to provide a single `instanceof FabricPrimitive` check
where code needs to identify these types uniformly (e.g., the conversion
functions' freeze-bypass logic).

#### 1.4.7 `FabricEpochNsec`

```typescript
// file: packages/data-model/fabric-epoch.ts

/**
 * Temporal type representing nanoseconds from the POSIX Epoch
 * (1970-01-01T00:00:00Z). Direct member of `FabricValue` (not a
 * `FabricInstance`). This is the primary temporal type.
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
export class FabricEpochNsec extends FabricPrimitive {
  constructor(readonly value: bigint) {
    super();
    Object.freeze(this);
  }
}
```

#### 1.4.8 `FabricEpochDays`

```typescript
// file: packages/data-model/fabric-epoch.ts

/**
 * Temporal type representing days from the POSIX Epoch (1970-01-01).
 * Extends `FabricPrimitive` (not a `FabricInstance`).
 * Anticipates `Temporal.PlainDate`.
 *
 * Mostly nascent — the class and spec entry are defined, but full
 * integration with Temporal types and calendar concerns is deferred.
 *
 * The underlying value is a `bigint`.
 */
export class FabricEpochDays extends FabricPrimitive {
  constructor(readonly value: bigint) {
    super();
    Object.freeze(this);
  }
}
```

#### 1.4.9 `FabricHash`

```typescript
// file: packages/data-model/fabric-hash.ts

/**
 * A content-addressed identifier: a hash digest paired with an algorithm tag.
 * Extends `FabricPrimitive` — treated like a primitive in the fabric type
 * system (always frozen, passes through conversion unchanged).
 *
 * The first algorithm tag is `fid1` ("fabric ID, v1"), which corresponds
 * to the SHA-256-based canonical hash produced by `hashOfModern()`
 * (Section 6.4).
 *
 * Stringification produces `<tag>:<base64urlHash>` where `<base64urlHash>`
 * is the unpadded base64url encoding (RFC 4648 Section 5) of the hash
 * bytes. For example: `fid1:n4bQgYhMfWWaL-qgxVrQFaO_TxsrC4Is0V1sFbDwCgg`.
 *
 * Immutable by convention: instances are `Object.freeze()`-d at construction
 * time, and the constructor assumes ownership of the `hash` bytes (callers
 * must not mutate the `Uint8Array` after passing it in, since JS cannot
 * freeze `ArrayBuffer` contents). The string form is cached internally so
 * that repeated `toString()` calls are O(1).
 */
export class FabricHash extends FabricPrimitive {
  readonly #hash: Uint8Array;
  readonly #tag: string;
  readonly #justHashString: string;
  readonly #fullStringForm: string;

  /**
   * @param hash - The raw hash bytes (ownership transferred to this instance).
   * @param tag - Algorithm identifier (e.g., `"fid1"` for fabric ID v1).
   */
  constructor(hash: Uint8Array, tag: string) {
    super();
    this.#hash = hash;
    this.#tag = tag;
    this.#justHashString = toUnpaddedBase64url(hash);
    this.#fullStringForm = `${tag}:${this.#justHashString}`;
    Object.freeze(this);
  }

  /** Defensive copy of the raw hash bytes. */
  get bytes(): Uint8Array {
    return new Uint8Array(this.#hash);
  }

  /** Length of the hash in bytes. */
  get length(): number {
    return this.#hash.length;
  }

  /** The algorithm tag (e.g., `"fid1"`, `"legacy"`). */
  get tag(): string {
    return this.#tag;
  }

  /** String form of the hash _without_ an algorithm tag. */
  get hashString(): string {
    return this.#justHashString;
  }

  /** Copy the hash bytes into `target` starting at offset 0. Returns `target`. */
  copyInto(target: Uint8Array): Uint8Array {
    target.set(this.#hash);
    return target;
  }

  /** Returns `<tag>:<base64urlHash>` (unpadded base64url). */
  override toString(): string {
    return this.#fullStringForm;
  }

  /** Parse an instance from its string representation (`<tag>:<base64urlHash>`). */
  static fromString(source: string): FabricHash {
    const colonIndex = source.indexOf(":");
    if (colonIndex === -1) {
      throw new ReferenceError(`Invalid content hash string: ${source}`);
    }
    const tag = source.substring(0, colonIndex);
    const hashBase64url = source.substring(colonIndex + 1);
    return new FabricHash(fromBase64url(hashBase64url), tag);
  }
}
```

The hash bytes are private (`#hash`). The public API provides:

- `.bytes` — defensive copy of the raw hash bytes.
- `.length` — byte count of the hash.
- `.tag` — the algorithm tag (e.g., `"fid1"`).
- `.hashString` — the hash as an unpadded base64url string, without the tag.
- `.copyInto(target)` — copies hash bytes into a caller-provided buffer.
- `.toString()` — `<tag>:<base64urlHash>`.
- `FabricHash.fromString(s)` — parse from `<tag>:<base64urlHash>`.

The `tag` field (formerly `algorithmTag`) is an opaque string identifier.
Known algorithm tags:

| Algorithm Tag | Meaning | Hash Algorithm | Output Size |
|:--------------|:--------|:---------------|:------------|
| `fid1`        | Fabric ID, version 1 | SHA-256 (Section 6.4) | 32 bytes |

Future algorithm tags may be added for different hash algorithms or versioned
content-addressing schemes. The algorithm tag is part of the content ID's
identity — two `FabricHash` instances with the same hash bytes but
different algorithm tags are distinct values.

#### 1.4.10 `FabricBytes`

```typescript
// file: packages/data-model/fabric-bytes.ts

/**
 * Immutable byte sequence in the fabric type system. Extends `FabricPrimitive`
 * — treated like a primitive (always frozen, passes through conversion
 * unchanged). Direct member of `FabricValue` via the `FabricPrimitive` arm.
 *
 * The underlying bytes are private. Callers access them through:
 * - `length` — the byte count.
 * - `slice()` — returns an unshared copy (or sub-range).
 * - `copyInto()` — copies bytes into a caller-provided buffer.
 *
 * Immutable by convention: instances are `Object.freeze()`-d at construction
 * time, and the constructor copies the input bytes so the caller cannot mutate
 * them after construction. (JS cannot freeze `ArrayBuffer` contents, so the
 * copy is the defense.)
 */
export class FabricBytes extends FabricPrimitive {
  readonly #bytes: Uint8Array;

  /**
   * Constructs a `FabricBytes` from raw bytes. The input is copied;
   * the caller may freely mutate the original after construction.
   */
  constructor(bytes: Uint8Array) {
    super();
    this.#bytes = new Uint8Array(bytes);
    Object.freeze(this);
  }

  /** The number of bytes. */
  get length(): number {
    return this.#bytes.length;
  }

  /**
   * Return a copy of the bytes (or a sub-range). The returned array is
   * unshared — the caller may mutate it freely.
   */
  slice(start?: number, end?: number): Uint8Array {
    return this.#bytes.slice(start, end);
  }

  /**
   * Copy bytes from this instance into a caller-provided buffer.
   */
  copyInto(target: Uint8Array, offset?: number, length?: number): number {
    // ... bounds checking, then:
    // target.set(this.#bytes.subarray(offset, offset + toCopy));
    // return toCopy;
  }
}
```

Unlike the previous `FabricUint8Array` (which was a `FabricInstance` wrapping
`Uint8Array` via `FabricNativeWrapper`), `FabricBytes` is a `FabricPrimitive`.
It does not implement `[DECONSTRUCT]`/`[RECONSTRUCT]` and has no `typeTag`
property. The serialization system handles it via a dedicated `TypeHandler`
(tag `Bytes@1`), similar to how it handles `FabricEpochNsec` and
`FabricEpochDays`. The hashing system uses the dedicated `TAG_BYTES` primitive
tag (Section 6.3).

#### 1.4.11 `bigint` — Not Wrapped

`bigint` is a JavaScript primitive (`typeof x === 'bigint'`), not an object. It
rides through the `FabricValue` layer directly, like `undefined`. No
`FabricBigInt` wrapper class is needed. The serialization layer handles
`bigint` with a dedicated handler (analogous to `UndefinedHandler`); see
Section 4.5.

#### 1.4.12 Design Notes

> **Why wrapper classes instead of inline serializer branches?** Each wrapper
> genuinely implements `FabricInstance`, so `instanceof FabricInstance` is `true` for
> them. The serialization system dispatches all `FabricInstance` values through
> a single `FabricInstanceHandler` path — no per-type branches. This gives the
> serialization layer a uniform, simpler structure: it handles
> `FabricInstance`, `undefined`, `bigint`, and the structural types
> (arrays, objects, primitives), with no knowledge of specific native JS types.
>
> **Reconstruction returns the wrapper.** `FabricError[RECONSTRUCT]` returns
> a `FabricError`, not a raw `Error`. This is consistent with the three-layer
> separation: the middle layer (`FabricValue`) contains wrappers, not raw
> native objects. Code that needs the underlying native type uses
> `nativeFromFabricValue()` (Section 8) as a separate step.
>
> **File organization.** The native object wrapper classes (`FabricError`,
> `FabricMap`, `FabricSet`, `FabricRegExp`) live in
> `fabric-native-instances.ts`. The `FabricPrimitive` subclasses
> (`FabricEpochNsec`, `FabricEpochDays`, `FabricHash`, `FabricBytes`)
> each have their own file (`fabric-epoch.ts`, `fabric-hash.ts`,
> `fabric-bytes.ts`).

### 1.5 Recursive Containers

**Arrays:**
- May be dense or sparse
- Elements may be `undefined` (a first-class fabric value; see Section 1.3)
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
- Plain objects only (class instances must implement the fabric protocol)
- Keys must be strings; symbol keys cause rejection
- Values must be valid fabric values; properties whose value is `undefined` are preserved
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

Cycles *across* documents are supported via explicit links (fabric instances
that reference other documents). Two cells can reference each other, forming a
cycle in the broader data graph. The no-cycles constraint applies only to the
serializable content of a single cell.

The within-document prohibition is inherited from JSON's tree structure and could
be relaxed if a future storage format supports cyclic references natively.

---

## 2. The Fabric Protocol

### 2.1 Overview

Types that the system controls opt into storability by implementing methods
keyed by well-known symbols. This allows the system to serialize and
deserialize custom types without central registration at the type level.

### 2.2 Symbols

```typescript
// file: packages/data-model/interface.ts

/**
 * Well-known symbol for deconstructing a fabric instance into its
 * essential state. The returned value may be or contain nested `FabricValue`s
 * (including other `FabricInstance`s); the serialization system handles
 * recursion.
 */
export const DECONSTRUCT = Symbol.for('common.deconstruct');

/**
 * Well-known symbol for reconstructing a fabric instance from its
 * essential state. Static method on the class.
 */
export const RECONSTRUCT = Symbol.for('common.reconstruct');

// Protocol evolution: Symbol.for('common.deconstruct@2'), etc.
```

### 2.3 Instance Protocol

```typescript
// file: packages/data-model/interface.ts

/**
 * Abstract base class for values that participate in the fabric protocol.
 * Extends `FabricSpecialObject` — the common root for all fabric-system
 * value types.
 *
 * Subclasses must implement:
 * - `[DECONSTRUCT]()` -- returns essential state for serialization.
 * - `shallowUnfrozenClone()` -- returns a new unfrozen copy of this instance.
 *
 * `shallowClone(frozen)` is an effectively-final method that manages the
 * frozenness contract:
 * - `shallowClone(true)` on a frozen instance returns `this` (identity).
 * - `shallowClone(true)` on an unfrozen instance returns a frozen clone.
 * - `shallowClone(false)` always returns a new unfrozen clone -- even if the
 *   instance is already unfrozen. The caller gets a distinct, mutable object.
 *
 * The native object wrapper classes (`FabricError`, `FabricMap`,
 * `FabricSet`, `FabricRegExp`) extend this class, as do user-defined
 * types (`Cell`, `Stream`) and system types (`UnknownValue`,
 * `ProblematicValue`).
 *
 * Note: `FabricPrimitive` subclasses (`FabricEpochNsec`,
 * `FabricEpochDays`, `FabricHash`, `FabricBytes`) do NOT extend
 * this class — they extend `FabricPrimitive` instead.
 */
export abstract class FabricInstance extends FabricSpecialObject {
  /**
   * Returns the essential state of this instance as a `FabricValue`. The
   * returned value may contain any `FabricValue`, including other
   * `FabricInstance`s, primitives, and plain objects/arrays.
   *
   * Implementations must NOT recursively deconstruct nested values --
   * the serialization system handles that.
   */
  abstract [DECONSTRUCT](): FabricValue;

  /**
   * Returns a new unfrozen copy of this instance with the same data. Called
   * by `shallowClone()` when a new instance is needed.
   */
  protected abstract shallowUnfrozenClone(): FabricInstance;

  /**
   * Returns a shallow clone of this instance with the requested frozenness.
   *
   * When `frozen` is `true` and this instance is already frozen, returns
   * `this` (identity optimization -- freezing is idempotent). In all other
   * cases, creates a new instance via `shallowUnfrozenClone()` and freezes
   * it if requested.
   */
  shallowClone(frozen: boolean): FabricInstance {
    if (frozen && Object.isFrozen(this)) return this;
    const copy = this.shallowUnfrozenClone();
    return frozen ? Object.freeze(copy) as FabricInstance : copy;
  }
}
```

> **Return type rationale:** The return type of `[DECONSTRUCT]` is
> `FabricValue` rather than `unknown` to make the contract explicit: a
> deconstructor must return a value that the serialization system can process.
> Returning a non-fabric value (e.g., a `WeakMap` or a DOM node) would be a
> bug.

> **Why an abstract class, not an interface?** The earlier spec defined
> `FabricInstance` as an interface with `[DECONSTRUCT]` as the sole method.
> The current design uses an abstract class so that `shallowClone()` can be
> an effectively-final method on the base class, encapsulating the
> frozenness-management contract (clone-if-necessary, freeze-if-requested) in
> one place. Subclasses implement only `shallowUnfrozenClone()` (the
> type-specific copy logic) and `[DECONSTRUCT]` (the serialization state
> extraction). Brand detection uses `instanceof FabricInstance` directly —
> no type guard function is needed (see Section 2.6).

### 2.4 Class Protocol

```typescript
// file: packages/data-model/interface.ts

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
export interface FabricClass<T extends FabricInstance> {
  /**
   * Reconstruct an instance from essential state. Nested values in `state`
   * have already been reconstructed by the serialization system. May return
   * an existing instance (interning) rather than creating a new one.
   */
  [RECONSTRUCT](state: FabricValue, context: ReconstructionContext): T;
}
```

### 2.5 Reconstruction Context

```typescript
// file: packages/data-model/interface.ts

/**
 * The minimal interface that `[RECONSTRUCT]` implementations may depend on.
 * In practice this is provided by the `Runtime` class from
 * `packages/runner/src/runtime.ts`, but defining it as an interface here
 * avoids a circular dependency between the fabric protocol and the runner.
 *
 * Implementors of `[RECONSTRUCT]` should depend on this interface, not on
 * the concrete `Runtime` class.
 */
export interface ReconstructionContext {
  /**
   * Resolve a cell reference. Used by `Cell[RECONSTRUCT]` and similar types
   * that need to intern or look up existing instances.
   */
  getCell(ref: { id: string; path: string[]; space: string }): FabricInstance;
}
```

> **Why an interface, not the concrete `Runtime`?** The fabric protocol is
> intended to live in a foundational package (`packages/data-model/`).
> If `[RECONSTRUCT]` depended on the full `Runtime` type
> from `packages/runner/`, it would create a circular dependency. The
> `ReconstructionContext` interface captures the minimal surface needed for
> reconstruction. The `Runtime` class satisfies this interface. Future
> fabric types may extend `ReconstructionContext` if they need additional
> capabilities beyond `getCell`.

### 2.6 Brand Detection

Because `FabricInstance` is an abstract class, the idiomatic brand check is
`instanceof`:

```typescript
if (value instanceof FabricInstance) {
  // value is a FabricInstance
}
```

No dedicated type guard function is needed.

> **`instanceof` vs. property-brand check.** The earlier spec used a
> property-brand check (`DECONSTRUCT in value`) because `FabricInstance` was
> an interface. Now that `FabricInstance` is an abstract class, `instanceof`
> is the natural and more robust check. It avoids false positives from objects
> that happen to have a `[DECONSTRUCT]` property without extending the base
> class.

### 2.7 Example: Temperature (Illustrative)

The following example is artificial, designed to illustrate the `FabricInstance`
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
  FabricInstance,
  type FabricValue,
  type ReconstructionContext,
} from '@commontools/data-model';

type TemperatureUnit = "C" | "F" | "K";

class Temperature extends FabricInstance {
  constructor(
    readonly value: number,
    readonly unit: TemperatureUnit,
  ) {
    super();
  }

  protected shallowUnfrozenClone(): Temperature {
    return new Temperature(this.value, this.unit);
  }

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
    state: FabricValue,
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

**Why the protocol matters.** Without `FabricInstance`, the serialization
system would see a `Temperature` as an opaque object and either reject it or
flatten it into `{ value: 100, unit: "C" }`. With the protocol, the
serialization system:

1. Calls `[DECONSTRUCT]()` to extract the essential state.
2. Serializes that state (recursively handling any nested `FabricValue`s).
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
`FabricValue` — including other `FabricInstance`s (such as native object
wrappers), primitives, and plain objects/arrays.

**The serialization system handles recursion, not the individual deconstructor
methods.** A `[DECONSTRUCT]` implementation returns its essential state without
recursively deconstructing nested values. The deconstructor does not have access
to the serialization machinery — by design, as it would be a layering
violation.

Similarly, `[RECONSTRUCT]` receives state where nested values have already been
reconstructed by the serialization system. Importantly, `[RECONSTRUCT]` returns
the **wrapper type**, not the raw native type. For example,
`FabricError[RECONSTRUCT]` returns a `FabricError` instance (which wraps an
`Error`), not a raw `Error`. Unwrapping to native types is a separate step via
`nativeFromFabricValue()` (Section 8).

### 2.9 Reconstruction Guarantees

The system follows an **immutable-forward** design:

- **Plain objects and arrays** are frozen (`Object.freeze()`) upon
  reconstruction. This applies to all deserialization output paths, including
  `/quote` (Section 5.6) — the freeze is a property of the deserialization
  boundary, not of whether type-tag reconstruction occurred.
- **`FabricInstance`s** should ideally be frozen as well — this is the north
  star, though not yet a strict requirement.
- **No distinction** is made between regular and null-prototype plain objects;
  reconstruction always produces regular plain objects.

This immutability guarantee enables safe sharing of reconstructed values and
aligns with the reactive system's assumption that values don't mutate in place.

> **Immutability of native object wrappers.** Under the three-layer
> architecture, deserialization produces `FabricInstance` wrappers
> (`FabricMap`, `FabricSet`, `FabricRegExp`, etc.), not raw native types. Because the
> system controls the shape of these wrapper classes, they can be properly
> frozen with `Object.freeze()` — unlike the native types they wrap (e.g.,
> `Object.freeze()` on a `Map` does not prevent mutation via `set()`/`delete()`).
> The underlying native objects stored inside wrappers (e.g.,
> `FabricMap.map`) are not directly exposed to consumers of `FabricValue`
> — callers who need the native types use `nativeFromFabricValue()`
> (Section 8), which returns `FrozenMap` and `FrozenSet`
> (effectively-immutable wrappers) for collection types, preserving the
> immutability guarantee even after unwrapping.

---

## 3. Unknown Types

### 3.1 Overview

When deserializing, a context may encounter a type tag it doesn't recognize —
for example, data written by a newer version of the system. Unknown types are
**passed through** rather than rejected, preserving forward compatibility.

### 3.2 `ExplicitTagValue` (Base Class)

Both `UnknownValue` and `ProblematicValue` share a common pattern: they
carry an explicit wire-format type tag and raw state for round-tripping. The
abstract base class `ExplicitTagValue` factors out these shared fields,
enabling a single `instanceof ExplicitTagValue` check where code needs to
handle both subtypes uniformly (e.g., serialization dispatch).

```typescript
// file: packages/data-model/explicit-tag-value.ts

/**
 * Base class for fabric types that carry an explicit wire-format tag.
 * Used by UnknownValue (unrecognized types) and ProblematicValue
 * (failed deconstruction/reconstruction). Enables a single instanceof
 * check where code needs to handle both.
 *
 * Extends `FabricInstance` so subclasses inherit the `shallowClone()`
 * method.
 */
export abstract class ExplicitTagValue extends FabricInstance {
  constructor(
    /** The original type tag, e.g. `"FutureType@2"`. */
    readonly typeTag: string,
    /** The raw state, already recursively processed by the deserializer. */
    readonly state: FabricValue,
  ) {
    super();
  }
}
```

Each subclass provides `[DECONSTRUCT]` and a static `[RECONSTRUCT]`
independently. The base class holds only the shared fields — `DECONSTRUCT`
stays on each subclass since the deconstruction payloads differ in shape.

### 3.3 `UnknownValue`

```typescript
// file: packages/data-model/unknown-value.ts

import {
  DECONSTRUCT,
  RECONSTRUCT,
  type ReconstructionContext,
} from './interface';
import { ExplicitTagValue } from './explicit-tag-value';

/**
 * Holds an unrecognized type's data for round-tripping. The serialization
 * system has special knowledge of this class: on deserialization of an unknown
 * tag, it wraps the tag and state here; on re-serialization, it uses the
 * preserved `typeTag` to produce the original wire format.
 */
export class UnknownValue extends ExplicitTagValue {
  constructor(typeTag: string, state: FabricValue) {
    super(typeTag, state);
  }

  [DECONSTRUCT]() {
    return { type: this.typeTag, state: this.state };
  }

  static [RECONSTRUCT](
    state: { type: string; state: FabricValue },
    _context: ReconstructionContext,
  ): UnknownValue {
    return new UnknownValue(state.type, state.state);
  }
}
```

### 3.4 Behavior

- When the serialization system encounters an unknown type tag during
  deserialization, it wraps the original tag and state into `{ type, state }`
  and passes that to `UnknownValue[RECONSTRUCT]`.
- When re-serializing an `UnknownValue`, the system uses the preserved
  `typeTag` to produce the original wire format.
- This allows data to round-trip through systems that don't understand it.

### 3.5 `ProblematicValue` (Recommended)

It is recommended that implementations provide a `ProblematicValue` type,
analogous to `UnknownValue`, for cases where deconstruction or reconstruction
fails partway through. This allows graceful degradation rather than hard
failures — for example, a type whose `[RECONSTRUCT]` throws can be preserved as
a `ProblematicValue` with the original tag, state, and error information.

```typescript
// file: packages/data-model/problematic-value.ts

import {
  DECONSTRUCT,
  RECONSTRUCT,
  type ReconstructionContext,
} from './interface';
import { ExplicitTagValue } from './explicit-tag-value';

/**
 * Holds a value whose deconstruction or reconstruction failed. Preserves
 * the original tag and raw state for round-tripping and debugging.
 */
export class ProblematicValue extends ExplicitTagValue {
  constructor(
    typeTag: string,
    state: FabricValue,
    /** A description of what went wrong. */
    readonly error: string,
  ) {
    super(typeTag, state);
  }

  [DECONSTRUCT]() {
    return { type: this.typeTag, state: this.state, error: this.error };
  }

  static [RECONSTRUCT](
    state: { type: string; state: FabricValue; error: string },
    _context: ReconstructionContext,
  ): ProblematicValue {
    return new ProblematicValue(state.type, state.state, state.error);
  }
}
```

Like `UnknownValue`, a `ProblematicValue` round-trips through
serialization, preserving the original data so it is not silently lost. The
`error` field aids debugging by recording what went wrong. Whether to wrap
failures in `ProblematicValue` or to throw is an implementation decision that
may vary by context — strict contexts (e.g., tests) may prefer to throw, while
lenient contexts (e.g., production reconstruction) may prefer graceful
degradation.

---

## 4. Serialization Contexts

### 4.1 Overview

Classes provide the *capability* to serialize via the fabric protocol, but
they don't own the wire format. A **serialization context** owns the mapping
between classes and wire format tags, and handles format-specific
encoding/decoding.

### 4.2 Wire Format Types

The JSON encoding context uses an intermediate tree representation during
serialization and deserialization. This type is internal to the JSON
implementation — it is not part of the public boundary interface.

```typescript
// file: packages/data-model/json-type-handlers.ts

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
// file: packages/data-model/interface.ts

/**
 * Public boundary interface for serialization contexts. Encodes fabric
 * values into a serialized form and decodes them back. The type parameter
 * `SerializedForm` is the boundary type: `string` for JSON contexts,
 * `Uint8Array` for binary contexts.
 *
 * This is the only interface external callers need. Internal tree-walking
 * machinery is private to the context implementation.
 */
export interface SerializationContext<SerializedForm = unknown> {
  /** Whether failed reconstructions produce `ProblematicValue` instead of
   *  throwing. @default false */
  readonly lenient: boolean;

  /** Encode a fabric value into serialized form for boundary crossing. */
  encode(value: FabricValue): SerializedForm;

  /** Decode a serialized form back into a fabric value. */
  decode(data: SerializedForm, runtime: ReconstructionContext): FabricValue;
}
```

The JSON encoding context implements `SerializationContext<string>`:

- `encode(value)` serializes a `FabricValue` into the `/<Type>@<Version>`
  tagged wire format, then stringifies the result.
- `decode(data, runtime)` parses a JSON string, then deserializes tagged forms
  back into modern runtime types.

> **Previous design.** The earlier spec described `SerializationContext` as a
> lower-level interface with `getTagFor()`, `getClassFor()`, `encode(tag,
> state)`, and `decode(data)` methods — essentially exposing the tag
> wrapping/unwrapping mechanics as the public API. The current design pushes all
> of that machinery inside the context class, leaving only the clean
> `encode(value) -> SerializedForm` / `decode(data, runtime) -> FabricValue`
> boundary. This better reflects the principle that the context owns the full
> pipeline, not just the tag encoding step.

### 4.4 Serialization Flow

```
Encode:  value -> context.encode(value) -> serialized form (e.g., JSON string)
Decode:  serialized form -> context.decode(data, runtime) -> FabricValue
```

Internally, the JSON encoding context's `encode()` method calls a private
`serialize()` to walk the `FabricValue` tree and produce a `JsonWireValue`
tree, then stringifies it. The `decode()` method parses the JSON string, then
calls a private `deserialize()` to walk the `JsonWireValue` tree and
reconstruct modern runtime types. The recursive descent and type dispatch are
entirely internal to the context.

### 4.5 Type Handlers and Internal Tree Walking

The serialization and deserialization logic is implemented as private methods
on `JsonEncodingContext`. The context dispatches per-type logic to **type
handlers** — small objects that know how to serialize values of a specific type
and how to deserialize them from a specific tag.

```typescript
// file: packages/data-model/json-type-handlers.ts

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
  /** Get the wire format tag for a fabric instance's type. */
  getTagFor(value: FabricInstance): string;
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
  canSerialize(value: FabricValue): boolean;

  /**
   * Serialize the value. Only called after `canSerialize` returned `true`.
   * The handler is responsible for tag wrapping via `codec.wrapTag()` and
   * for recursively serializing nested values via the `recurse` callback.
   */
  serialize(
    value: FabricValue,
    codec: TypeHandlerCodec,
    recurse: (v: FabricValue) => JsonWireValue,
  ): JsonWireValue;

  /**
   * Deserialize a value from its wire format state. The state has already
   * been unwrapped (tag stripped) but inner values have NOT been recursively
   * deserialized -- the handler must call `recurse` on nested values.
   */
  deserialize(
    state: JsonWireValue,
    runtime: ReconstructionContext,
    recurse: (v: JsonWireValue) => FabricValue,
  ): FabricValue;
}
```

The built-in type handlers are:

| Handler | Tag | Serializes | Notes |
|---------|-----|------------|-------|
| `EpochNsecHandler` | `EpochNsec@1` | `FabricEpochNsec` | `FabricPrimitive` subclass; matched by `instanceof`. |
| `EpochDaysHandler` | `EpochDays@1` | `FabricEpochDays` | `FabricPrimitive` subclass; matched by `instanceof`. |
| `BytesHandler` | `Bytes@1` | `FabricBytes` | `FabricPrimitive` subclass; matched by `instanceof`. |
| `FabricInstanceHandler` | _(empty)_ | `FabricInstance` | Generic handler for all `FabricInstance` values. Uses `[DECONSTRUCT]` and the codec's tag methods. No tag for deserialization — individual instance types are deserialized via the class registry. |
| `BigIntHandler` | `BigInt@1` | `bigint` | Encodes as unpadded base64url of minimal two's complement big-endian bytes. |
| `UndefinedHandler` | `Undefined@1` | `undefined` | Stateless; state is `null`. |

Handler registration order matters for serialization: `EpochNsec`,
`EpochDays`, and `Bytes` are checked first (they are `FabricPrimitive`
subclasses matched by `instanceof` and must be found before the generic
`FabricInstanceHandler`), then `FabricInstance` (generic protocol types via
`instanceof FabricInstance`), then `bigint` and `undefined`. Primitives,
arrays, and plain objects are handled as fallthrough after no handler matches.

#### Private `serialize()` method

The context's private `serialize()` method walks the `FabricValue` tree:

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
   mode, handler exceptions produce `ProblematicValue` (Section 3.5).
4. **Class registry fallback** — for tags not handled by type handlers (e.g.,
   `Error@1`, `Map@1`, `Set@1`, `RegExp@1`), the context looks up
   the `FabricClass` in its class registry, recursively deserializes the
   state, and calls `[RECONSTRUCT]`. Unknown tags produce `UnknownValue`.
5. **Primitives** — pass through.
6. **Arrays** — recursively deserialized; `hole` entries reconstructed as true
   holes (absent indices).
7. **Plain objects** — recursively deserialized; output frozen.

> **Implementation guidance: class registry.** The `JsonEncodingContext`
> constructor registers native wrapper classes for deserialization:
> `FabricError`, `FabricMap`, `FabricSet`, `FabricRegExp`. For tag
> resolution (`getTagFor`), the context checks for
> a `typeTag` property on the instance — the same pattern used by
> `UnknownValue` and `ProblematicValue`. `ExplicitTagValue` instances
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
(`FabricValue`). These functions live in a dedicated dispatch module
(`packages/data-model/json-encoding.ts`) and are reassigned at runtime
based on whether unified JSON encoding is enabled.

```typescript
// file: packages/data-model/json-encoding.ts

/**
 * Encode a fabric value to a JSON string. When unified JSON encoding is
 * ON, serializes modern types (bigint, undefined, Map, etc.) into the
 * `/<Type>@<Version>` tagged wire format and stringifies. When OFF,
 * equivalent to `JSON.stringify(value)`.
 */
let jsonFromValue: (value: FabricValue) => string;

/**
 * Decode a JSON string back into a fabric value. When unified JSON
 * encoding is ON, parses the string and deserializes tagged forms back
 * into modern runtime types. When OFF, equivalent to `JSON.parse(json)`.
 */
let valueFromJson: (json: string, runtime: ReconstructionContext) => FabricValue;
```

The dispatch is configured by `setJsonEncodingConfig(enabled)` /
`resetJsonEncodingConfig()`, called from the `Runtime` constructor and
`Runtime.dispose()` respectively:

- **Flag OFF (default):** `jsonFromValue` wraps `JSON.stringify` with a
  defensive guard that throws if the result is `undefined` — this can happen
  when the input is `undefined` (a first-class `FabricValue` per Section
  1.3), since `JSON.stringify(undefined)` returns `undefined` rather than a
  string. The guard ensures `jsonFromValue` always returns a `string` as its
  type signature promises. `valueFromJson` = `JSON.parse`. This is the legacy
  path — the storage layer sees plain JSON values with no tagged types.
- **Flag ON:** `jsonFromValue` routes through `JsonEncodingContext.encode()`,
  `valueFromJson` routes through `JsonEncodingContext.decode()`. Modern types
  are preserved across the storage boundary.

The dispatch module creates a single stateless `JsonEncodingContext` instance at
module load time and reuses it for all encode/decode operations.

In `space.ts`, the dispatch functions replace direct `JSON.stringify` /
`JSON.parse` calls at three sites:

- **Write path:** `jsonFromValue(datum)` replaces `JSON.stringify(datum)` in
  `importDatum()`.
- **Read path:** `valueFromJson(json, context)` replaces `JSON.parse(json)` at
  `recall()`, `getFact()`, and `toFact()`.

### 4.9 Fabric Value Dispatch

The native-to-fabric-value boundary is managed by a similar flag-gated
dispatch module (`packages/data-model/fabric-value.ts`). This consolidated module
provides `fabricFromNativeValue()` / `nativeFromFabricValue()` functions
that bridge the left layer (JS wild west) and the middle layer
(`FabricValue`) at the `Cell` read/write boundary.

The module also re-exports flag-dispatched type-check functions
(`isFabricValue()`, `isFabricCompatible()`), a shallow conversion function
(`shallowFabricFromNativeValue()`), and a comparison function
(`valueEqual()`).

```typescript
// file: packages/data-model/fabric-value.ts

/**
 * Convert a native JS value to fabric form (deep, recursive).
 * Flag OFF (legacy): performs deep conversion via `fabricFromNativeValueLegacy`.
 * Flag ON (modern): wraps native types into fabric wrappers and deep-freezes
 * via `fabricFromNativeValueModern`.
 */
export function fabricFromNativeValue(value: unknown, freeze?: boolean): FabricValue {
  return modernDataModelEnabled
    ? fabricFromNativeValueModern(value, freeze)
    : fabricFromNativeValueLegacy(value);
}

/**
 * Convert a fabric value back to native form.
 * Flag OFF (legacy): identity passthrough.
 * Flag ON (modern): unwraps fabric wrappers via `nativeFromFabricValueModern`.
 */
export function nativeFromFabricValue(value: FabricValue, frozen?: boolean): FabricValue {
  return modernDataModelEnabled
    ? nativeFromFabricValueModern(value, frozen) as FabricValue
    : value;
}
```

The dispatch flag is set by `setDataModelConfig(enabled)` /
`resetDataModelConfig()`, called from the `Runtime` constructor and
`Runtime.dispose()` respectively:

- **Flag OFF (default):** `fabricFromNativeValue` routes through
  `fabricFromNativeValueLegacy` (the legacy conversion function).
  `nativeFromFabricValue` is an identity passthrough.
- **Flag ON (modern):** `fabricFromNativeValue` routes through
  `fabricFromNativeValueModern` (which wraps native objects into
  `FabricInstance` wrappers per Section 8.2). `nativeFromFabricValue`
  routes through `nativeFromFabricValueModern` (which unwraps
  `FabricInstance` wrappers back to native JS types per Section 8.4).

#### Module structure

The implementation is split across several files for separation of concerns:

| File | Purpose |
|------|---------|
| `fabric-value.ts` | Dispatch module: flag-gated public API, config lifecycle |
| `fabric-value-modern.ts` | Modern (flag-ON) conversion: `shallowFabricFromNativeValueModern`, `fabricFromNativeValueModern`, `isFabricValueModern`, `isFabricCompatibleModern` |
| `fabric-value-legacy.ts` | Legacy (flag-OFF) conversion: `fabricFromNativeValueLegacy`, `isFabricValueLegacy`, `isFabricCompatibleLegacy` |
| `array-utils.ts` | Pure utilities shared by both paths: `isArrayIndexPropertyName`, `isArrayWithOnlyIndexProperties` |
| `fabric-native-instances.ts` | Native object wrapper classes (`FabricError`, `FabricMap`, etc.) and unwrap functions (`nativeFromFabricValue`, `nativeFromFabricValueModern`) |

In the `Cell` implementation:

- **Read path:** `Cell.getRaw()` calls `nativeFromFabricValue(value)` to
  unwrap fabric wrappers before returning values to the JS wild west.
- **Write path:** `Cell.setRaw()` calls `fabricFromNativeValue(value)` to
  wrap native types into fabric form before storing.

> **Config lifecycle.** Both dispatch modules (`json-encoding` and
> `fabric-value`) follow the same lifecycle pattern: the `Runtime`
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
// file: packages/data-model/json-type-handlers.ts (illustrative -- tag-to-format map)

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
> should produce a `ProblematicValue` (Section 3.5) rather than throwing or
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
  `UnknownValue` and `ExplicitTagValue`.
- Managing the class registry for deserialization of known `FabricInstance`
  types (e.g., `FabricError`, `FabricMap`, `FabricSet`, `FabricRegExp`).
- Providing a narrow `TypeHandlerCodec` view to type handlers during tree
  walking, exposing only `wrapTag()` and `getTagFor()`.

Note: `/object` escaping (Section 5.6) is applied directly by the context's
private `serialize()` method in its plain-objects path, since it is structural
escaping rather than type encoding.

### 5.8 Unknown Type Handling

When a JSON context encounters a `/<Type>@<Version>` key it doesn't recognize,
it wraps the data in `UnknownValue` (see Section 3) to preserve it for
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
  `FabricMap`/`FabricSet` insertion order.
- Hash type tags + content in a single pass.
- No intermediate allocations beyond the hash state.
- The hash reflects the logical content, not any particular encoding or
  intermediate representation.

### 6.3 Suggested Tag Bytes

The following single-byte type tags are used by the canonical hash byte format
and are recommended for any binary encoding of `FabricValue`s. They are
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
| `TAG_INSTANCE`    | `0x12` | 18      | `FabricInstance` (general)    |

**Primitive tags (`0x2N`)** — leaf value types:

| Tag               | Hex    | Decimal | Used for                        |
|:------------------|:-------|:--------|:--------------------------------|
| `TAG_NULL`        | `0x20` | 32      | `null`                          |
| `TAG_UNDEFINED`   | `0x21` | 33      | `undefined`                     |
| `TAG_BOOLEAN`     | `0x22` | 34      | `boolean`                       |
| `TAG_NUMBER`      | `0x23` | 35      | `number` (finite, non-NaN)      |
| `TAG_STRING`      | `0x24` | 36      | `string`                        |
| `TAG_BYTES`       | `0x25` | 37      | `FabricBytes`                 |
| `TAG_BIGINT`      | `0x26` | 38      | `bigint`                        |
| `TAG_EPOCH_NSEC`  | `0x27` | 39      | `FabricEpochNsec`             |
| `TAG_EPOCH_DAYS`  | `0x28` | 40      | `FabricEpochDays`             |
| `TAG_CONTENT_ID`  | `0x29` | 41      | `FabricHash`             |

All unassigned values are reserved for future use. The category structure
(meta/compound/primitive) is a convention for readability and is not enforced by
the encoding — a decoder should handle any tag byte it encounters regardless of
nibble range.

> **Scope.** These tag bytes are defined here for use by any wire format that
> needs to distinguish `FabricValue` types at the byte level. The canonical
> hash byte format (`2-canonical-hash-byte-format.md`) is the first consumer;
> future binary serialization formats may reuse the same tag assignments.

### 6.4 Hashing Algorithm

```typescript
// file: packages/data-model/value-hash-modern.ts

/**
 * Compute a canonical hash for a fabric value. The hash is
 * encoding-independent: the same identity whether later serialized
 * to JSON, CBOR, or any other format.
 *
 * The digest algorithm is SHA-256. Future additions (e.g., BLAKE2b)
 * would use the same byte-level input format; only the digest function
 * changes.
 *
 * The return value is a `FabricHash` instance (Section 1.4.9),
 * which encapsulates the raw hash bytes and the algorithm tag. The
 * algorithm tag for SHA-256 is `fid1` ("fabric ID, v1"). Callers who
 * need a string representation can call `toString()` on the result,
 * which produces `<tag>:<base64urlhash>` (unpadded base64url with the
 * URL-safe alphabet `A-Za-z0-9-_`, per RFC 4648 Section 5; see
 * Section 5.3).
 *
 * Two public entry points are provided:
 * - `hashOfModern(value)` — returns a `FabricHash`.
 * - `hashOfModernAsString(value)` — returns a plain `string` (the hash
 *   as base64url, without the algorithm tag). This avoids `FabricHash`
 *   allocation when only the string form is needed.
 *
 * Both functions cache results: constants for `null`, `undefined`,
 * `true`, `false`; an LRU cache for primitives (`string`, `number`,
 * `bigint`); and a WeakMap for deep-frozen objects.
 *
 * Native `Date`, `RegExp`, and `Uint8Array` values are handled via
 * on-the-fly conversion to their fabric equivalents
 * (`shallowFabricFromNativeValueModern`), then hashed in their converted
 * form.
 */
export function hashOfModern(value: unknown): FabricHash {
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
  // - `FabricBytes`:      hash(TAG_BYTES, leb128(byteLen), rawBytes)
  //                        (hashes the underlying byte content)
  // - `FabricEpochNsec`: hash(TAG_EPOCH_NSEC, leb128(byteLen), twosComplementBytes)
  //                        (same payload format as TAG_BIGINT but distinct tag)
  // - `FabricEpochDays`: hash(TAG_EPOCH_DAYS, leb128(byteLen), twosComplementBytes)
  //                        (same payload format as TAG_BIGINT but distinct tag)
  // - `FabricHash`: hash(TAG_CONTENT_ID, leb128(algTagLen), algTagUtf8,
  //                              leb128(hashByteLen), hashBytes)
  //                        (algorithm tag as UTF-8 string, then raw hash bytes)
  // - array:               hash(TAG_ARRAY, ...elements, TAG_END)
  //                        Elements are hashed in index order:
  //                          if `i in array`: hashOfModern(array[i])
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
  // - `FabricInstance`:  hash(TAG_INSTANCE, leb128(typeTagLen), typeTag,
  //                              hashOfModern(deconstructedState))
  //
  // The native object wrappers and temporal types are hashed as follows:
  //
  // - `FabricError`, `FabricMap`, `FabricSet`, `FabricRegExp`,
  //   and other `FabricInstance`s with recursively-processable
  //   deconstructed state are hashed via TAG_INSTANCE:
  //     hash(TAG_INSTANCE, leb128(typeTagLen), typeTag,
  //          hashOfModern(deconstructedState))
  //
  // - `FabricBytes` uses TAG_BYTES (dedicated primitive tag).
  // - `FabricEpochNsec` uses TAG_EPOCH_NSEC (dedicated primitive tag).
  // - `FabricEpochDays` uses TAG_EPOCH_DAYS (dedicated primitive tag).
  // - `FabricHash` uses TAG_CONTENT_ID (dedicated primitive tag).
  //
  // Examples:
  // - `FabricError`:      hash(TAG_INSTANCE, ..., "Error@1", hashOfModern(errorState))
  // - `FabricMap`:        hash(TAG_INSTANCE, ..., "Map@1", hashOfModern(entries))
  //                         where entries are hashed in insertion order
  // - `FabricSet`:        hash(TAG_INSTANCE, ..., "Set@1", hashOfModern(elements))
  //                         where elements are hashed in insertion order
  // - `FabricRegExp`:     hash(TAG_INSTANCE, ..., "RegExp@1", hashOfModern({source, flags, flavor}))
  // - `FabricEpochNsec`:  hash(TAG_EPOCH_NSEC, leb128(byteLen), twosComplementBytes)
  // - `FabricEpochDays`:  hash(TAG_EPOCH_DAYS, leb128(byteLen), twosComplementBytes)
  // - `FabricHash`:  hash(TAG_CONTENT_ID, leb128(algTagLen), algTagUtf8,
  //                               leb128(hashByteLen), hashBytes)
  // - `FabricBytes`:      hash(TAG_BYTES, leb128(byteLen), rawBytes)
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
> for `FabricMap` entries and `FabricSet` elements, matching the serialized
> form. This means two `FabricMap`s or `FabricSet`s with the same elements
> in different insertion order will hash differently. This is intentional:
> insertion order is part of the observable semantics of `Map`/`Set` in
> JavaScript, so values that behave differently should not hash the same. (By
> contrast, plain objects are hashed with sorted keys, matching the existing
> convention that plain-object key order is not semantically significant.)

### 6.5 Relationship to Late Serialization

Canonical hashing operates on `FabricValue` directly, using deconstructed
state for `FabricInstance`s (including the native object wrappers) and
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

1. Update `FabricValue` to exclude raw native JS types, include
   `FabricInstance` (Section 1.2).
2. Introduce the native object wrapper classes (`FabricError`, etc.) that
   implement `FabricInstance` (Section 1.4).
3. Rework `shallowFabricFromNativeValue()` / `fabricFromNativeValue()` to
   wrap native types into `FabricInstance` wrappers and return frozen results
   (Section 8).
4. Add `nativeFromFabricValue()` for unwrapping back to native types
   (Section 8).
5. Remove early conversion points (e.g., `convertCellsToLinks()`,
   legacy `Error` wrapping as `{ "@Error": ... }`).
6. Introduce `SerializationContext` at each boundary (Section 4.7).
7. Update internal code to work with `FabricValue` types rather than JSON
   shapes or raw native objects.

> **`toJSON()` compatibility and migration.** The conversion functions and their
> variants currently honor `toJSON()` methods on objects that have them — if an
> object has a `toJSON()` method and does not implement `FabricInstance`, the
> conversion functions call `toJSON()` and process the result. This preserves
> backward compatibility with existing code. However, `toJSON()` support is
> **marked for removal**: it eagerly converts to JSON-compatible shapes, which
> is incompatible with late serialization. Implementors should migrate to the
> fabric protocol (`[DECONSTRUCT]`/`[RECONSTRUCT]`) instead. Once all callers
> have migrated, `toJSON()` support will be removed from the conversion
> functions.

### 7.2 Unifying JSON Encoding

Four legacy conventions in the current codebase must be migrated to the unified
`/<Type>@<Version>` format:

| Legacy Convention | Where Used | Example | New Form |
|-------------------|------------|---------|----------|
| IPLD sigil | Links (`sigil-types.ts`) | `{ "/": { "link@1": { id, path, space } } }` | `{ "/Link@1": { id, path, space } }` |
| `@` prefix | Errors (`fabric-value.ts`) | `{ "@Error": { name, message, ... } }` | `{ "/Error@1": { name, message, ... } }` |
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
  FabricValue`. The state has been deserialized by the serialization system,
  but its internal structure is determined by whatever was on the wire.
  Implementations must validate the shape of `state` at runtime — checking
  property existence, types, and constraints — rather than relying on a type
  cast (e.g., `state as { value: number }`). See the note in Section 2.7 for a
  concrete example.

- **JSON type handlers** (Section 5.3) must validate the format of their state
  before processing. Malformed input should produce a `ProblematicValue`
  rather than throwing or silently producing garbage.

- **Canonical hashing** (Section 6.3) may operate on values that have been
  through a deserialization round-trip. Code that extracts properties from
  `FabricInstance` values (e.g., casting to `{ typeTag: string }`) must
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
layer (`FabricValue`). They form the boundary between arbitrary JavaScript
values and the strongly typed data model.

There are two directions:

- **JS wild west -> `FabricValue`:** `shallowFabricFromNativeValue()`
  (shallow) and `fabricFromNativeValue()` (deep, recursive).
- **`FabricValue` -> JS wild west:** `nativeFromFabricValue()` (deep,
  recursive).

### 8.2 `shallowFabricFromNativeValue()` and `fabricFromNativeValue()`

```typescript
// file: packages/data-model/fabric-value.ts

/**
 * Convert a value to `FabricValue` without recursing into nested values.
 * Wraps native JS types (`Error`, `Date`, `RegExp`, `Uint8Array`) into
 * their `FabricInstance` or `FabricPrimitive` wrapper classes. If the value
 * is already a valid `FabricValue`, returns it as-is.
 *
 * The input type is `unknown` — the function accepts any JavaScript value.
 * Unsupported types cause a thrown error.
 *
 * **Freeze semantics (shallow):** By default, the returned value is frozen
 * at the top level via `Object.freeze()`. Nested values are NOT recursively
 * frozen. The caller's input is never mutated — if the top-level value is
 * an unfrozen array or object, a shallow copy is made before freezing. If
 * the input is already a frozen `FabricValue`, returns the same object.
 * Pass `freeze: false` to skip freezing (see below).
 */
export function shallowFabricFromNativeValue(
  value: unknown,
  freeze?: boolean, // default: true
): FabricValueLayer;

/**
 * Convert a value to `FabricValue`, recursively processing nested values
 * (deep conversion). This is the primary conversion entry point.
 *
 * - Recursively descends into arrays and plain objects.
 * - Wraps native JS objects at any depth.
 * - **Single-pass design:** Validation, wrapping, and freezing are performed
 *   together in one recursive descent — there are no separate passes. Each
 *   node is checked, wrapped if needed, and frozen before the function
 *   returns from that level.
 * - **No caller mutation:** The caller's input objects are never frozen or
 *   modified in place. When freezing is needed, shallow copies are made
 *   first. If the input is already a deeply-frozen `FabricValue`, returns
 *   the same object (no copying needed).
 * - Detects circular references and throws.
 * - Throws on unsupported types at any depth.
 *
 * Pass `freeze: false` to perform wrapping and validation without freezing
 * (see "Freeze Semantics" below).
 */
export function fabricFromNativeValue(
  value: unknown,
  freeze?: boolean, // default: true
): FabricValue;
```

#### Conversion Rules

| Input Type | Output |
|------------|--------|
| `null`, `boolean`, `number`, `string`, `undefined`, `bigint` | Returned as-is (primitives are `FabricValue` directly). `-0` is normalized to `0`. Non-finite numbers (`NaN`, `Infinity`) cause rejection. |
| `FabricPrimitive` (`FabricEpochNsec`, `FabricEpochDays`, `FabricHash`, `FabricBytes`) | Returned as-is. Always-frozen: the `freeze` option has no effect on these types (see Section 1.4.6). |
| `FabricInstance` (including wrapper classes) | Returned as-is (already `FabricValue`). |
| `Error` | Wrapped into `FabricError`. Before wrapping, `cause` and custom enumerable properties are recursively converted to `FabricValue` (deep variant) or left as-is (shallow variant). Extra enumerable properties are preserved (see Section 1.4.1). This ensures that by the time `FabricError.[DECONSTRUCT]` runs, all nested values are already valid `FabricValue`. |
| `Map` | Wrapped into `FabricMap`. Keys and values are recursively converted (deep variant only). Extra enumerable properties on the `Map` object cause **rejection** (throw) — it is better to fail loudly than silently lose data. |
| `Set` | Wrapped into `FabricSet`. Elements are recursively converted (deep variant only). Extra enumerable properties on the `Set` object cause **rejection** (throw) — it is better to fail loudly than silently lose data. |
| `Date` | Wrapped into `FabricEpochNsec`. The `Date`'s millisecond timestamp is converted to nanoseconds: `BigInt(date.getTime()) * 1_000_000n`. Note the millisecond precision limitation — sub-millisecond information is not available from `Date`. Extra enumerable properties on the `Date` object cause **rejection** (throw) — it is better to fail loudly than silently lose data. |
| `RegExp` | Wrapped into `FabricRegExp`. The `source` and `flags` are extracted from the native `RegExp`; `flavor` defaults to `"es2025"` (it is a wrapper-level property, not a native `RegExp` property). Extra enumerable properties on the `RegExp` object cause **rejection** (throw) — it is better to fail loudly than silently lose data. |
| `Uint8Array` | Wrapped into `FabricBytes`. The input bytes are copied (the caller may mutate the original afterward). Extra enumerable properties on the `Uint8Array` object cause **rejection** (throw) — it is better to fail loudly than silently lose data. |
| `FabricValue[]` | Shallow: returned as-is (frozen if `freeze` is true). Deep: elements recursively converted (frozen at each level if `freeze` is true). |
| `{ [key: string]: FabricValue }` | Shallow: returned as-is (frozen if `freeze` is true). Deep: values recursively converted (frozen at each level if `freeze` is true). |

> **Implementation: tag-based type dispatch.** The conversion functions use a
> tag-based dispatch mechanism (`tagFromNativeValue()` in
> `packages/data-model/native-type-tags.ts`) to classify values in O(1) via a `switch` on
> the value's constructor. This replaces sequential `instanceof` chains with a
> single constructor lookup that returns a tag string (e.g., `"Error"`,
> `"Date"`, `"RegExp"`, `"Array"`, `"Object"`, `"Primitive"`,
> `"FabricInstance"`). The conversion function then switches on the tag to
> route to the appropriate wrapping logic. Fallback paths handle exotic Error
> subclasses (via `Error.isError()`), cross-realm arrays (via
> `Array.isArray()`), null-prototype objects, and objects with `toJSON()`
> methods.

> **Implementation: centralized shallow-clone utility.** The conversion
> functions use a centralized `cloneIfNecessary()` utility (in
> `packages/data-model/fabric-value-modern.ts`) to handle frozenness adjustment
> for values that are already valid `FabricValue` but whose freeze state
> does not match the requested `freeze` argument. This function dispatches on
> the same native tag to clone primitives (no-op), arrays (shallow copy
> preserving sparse holes), plain objects (spread copy), and
> `FabricInstance` values (via the protocol's `shallowClone()` method from
> Section 2.3). It centralizes clone-for-frozenness logic that was previously
> duplicated across conversion call sites.

#### Freeze Semantics

The immutable-forward design requires that `FabricValue` trees produced by
conversion are frozen **by default**:

- **`shallowFabricFromNativeValue()` (shallow):** `Object.freeze()` on the
  top-level result.
- **`fabricFromNativeValue()` (deep):** `Object.freeze()` at every level of
  nesting, performed in the **same recursive pass** as validation and wrapping.
  There are no separate passes — each node is checked, wrapped, and frozen
  before the recursion returns from that level.

**Caller arguments are never mutated.** The conversion functions must not call
`Object.freeze()` on the caller's input objects. When `freeze` is `true` and
the input is an unfrozen array or plain object, the function creates a shallow
copy and freezes the copy. This ensures that callers can safely pass mutable
data structures without side effects — the caller's objects remain mutable
after the call returns. (Wrapper objects like `FabricError` are freshly
constructed by the conversion function, so freezing them is not a mutation of
caller state.)

**`deepFreeze` at schema merge/combine sites.** The `deepFreeze()` utility
(in `packages/data-model/deep-freeze.ts`) recursively freezes an object tree in
place. At sites where schema objects are merged or combined (e.g., schema
`merge()` and `combine()` functions), pass-through paths — where the input is
returned as the result without structural modification — must copy the value
before freezing to avoid mutating caller-owned schema objects. The general
principle: `deepFreeze()` freezes in place, so if the caller retains a
reference to a mutable object, the function must not freeze that object as a
side effect. Callers at these sites should copy before freezing rather than
relying on the input being "safe to freeze."

**Always-frozen types bypass the `freeze` option.** JS primitives (`null`,
`boolean`, `number`, `string`, `undefined`, `bigint`) are inherently immutable
and pass through unchanged regardless of the `freeze` setting.
`FabricPrimitive` instances (`FabricEpochNsec`, `FabricEpochDays`,
`FabricHash`, `FabricBytes`) are treated the same way — they are always returned as-is,
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
const frozen = fabricFromNativeValue(input);

// Unfrozen -- mutable result, caller can modify before freezing later.
const mutable = fabricFromNativeValue(input, false);
```

This exists because JavaScript makes it difficult to update frozen values —
there is no "thaw" operation. Callers that need to build up a `FabricValue`
tree incrementally (e.g., merging data from multiple sources) can use
`freeze: false` to get a mutable tree, then freeze it when construction is
complete. The `freeze` parameter does not affect validation or wrapping — the
returned value is always a valid `FabricValue` regardless of its frozen state.

### 8.3 `isFabricCompatible()`

```typescript
// file: packages/data-model/fabric-value.ts

/**
 * Type predicate: returns `true` if `fabricFromNativeValue()` would succeed
 * on the given value — i.e., the value is a `FabricValue`, a
 * `FabricNativeObject`, or a tree of these types. The return type is a
 * type predicate (`value is FabricValue | FabricNativeObject`), so
 * callers can use `isFabricCompatible(x)` as a type guard in conditionals.
 *
 * This is a check-without-conversion function for system boundaries where
 * code receives `unknown` and needs to determine convertibility without
 * actually performing the conversion (and its associated wrapping, freezing,
 * and allocation).
 *
 * Relationship to other functions:
 * - `isFabricValue(x)`: "Is `x` already a `FabricValue`?" Does NOT
 *   return `true` for raw native types like `Error` or `Map`.
 * - `isFabricCompatible(x)`: "Could `x` be converted to a `FabricValue` via
 *   `fabricFromNativeValue()`?" Returns `true` for both `FabricValue`
 *   values AND `FabricNativeObject` values (and deep trees thereof).
 * - `fabricFromNativeValue(x)`: Actually performs the conversion,
 *   throwing on unsupported types.
 */
export function isFabricCompatible(
  value: unknown,
): value is FabricValue | FabricNativeObject;
```

The function recursively checks the value tree. It returns `true` if and only
if the value is:

- A primitive (`null`, `boolean`, `number` (finite), `string`, `undefined`,
  `bigint`)
- A `FabricInstance` (including the native object wrapper classes)
- A `FabricNativeObject` (`Error`, `Map`, `Set`, `Date`, `RegExp`,
  `Uint8Array`, or an object with a `toJSON()` method — legacy)
- An array where every present element satisfies `isFabricCompatible()`
- A plain object where every value satisfies `isFabricCompatible()`

It returns `false` for unsupported types (`WeakMap`, `Promise`, DOM nodes,
class instances that don't implement `FabricInstance`, non-finite numbers,
etc.).

> **Performance note.** `isFabricCompatible()` walks the value tree without
> allocating wrappers or frozen copies. For large trees, this is cheaper than
> calling `fabricFromNativeValue()` inside a try/catch, since it avoids the
> wrapping and freezing work that would be discarded on failure. However, if
> the caller intends to convert on success, calling
> `fabricFromNativeValue()` directly (and catching the error) avoids walking
> the tree twice.

### 8.4 `nativeFromFabricValue()`

```typescript
// file: packages/data-model/fabric-value.ts

/**
 * Deep unwrap: recursively walk a `FabricValue` tree, unwrapping any
 * `FabricNativeWrapper` values to their underlying native types via
 * `toNativeValue()`. Non-native `FabricInstance` values (`Cell`, `Stream`,
 * `UnknownValue`, `ProblematicValue`, etc.) pass through unchanged.
 *
 * Wrapper classes are unwrapped to their native equivalents:
 *
 * - `FabricError`      -> `Error` (with cause and custom properties
 *                         recursively unwrapped)
 * - `FabricMap`        -> `FrozenMap` / `Map`
 * - `FabricSet`        -> `FrozenSet` / `Set`
 * - `FabricRegExp`     -> `RegExp`
 *
 * `FabricPrimitive` subclasses (`FabricEpochNsec`, `FabricEpochDays`,
 * `FabricHash`, `FabricBytes`) pass through unchanged — they are
 * always-frozen (Section 1.4.6).
 *
 * **The `frozen` argument is always honored.** The freeze state of every
 * value in the output matches the `frozen` argument. When `frozen` is
 * `true` (the default), unwrapped wrappers use immutable variants
 * (`FrozenMap`, `FrozenSet`, frozen `Error`). When `frozen` is `false`,
 * mutable native types are returned instead.
 *
 * This is a flag-dispatched function: when the modern data model flag is
 * ON, delegates to `nativeFromFabricValueModern()`; when OFF (legacy),
 * returns the value as-is (legacy values contain no wrappers).
 */
export function nativeFromFabricValue(
  value: FabricValue,
  frozen?: boolean, // default: true
): FabricValue;
```

#### Unwrapping Rules

| Input | Output (frozen) | Output (not frozen) |
|-------|-----------------|---------------------|
| `FabricError` | `Error` (original if already frozen; frozen copy otherwise) | `Error` (original if already unfrozen; mutable copy otherwise) |
| `FabricMap` | `FrozenMap` (original if already `FrozenMap`; new wrapper otherwise) | `Map` (original if already plain `Map`; mutable copy otherwise) |
| `FabricSet` | `FrozenSet` (original if already `FrozenSet`; new wrapper otherwise) | `Set` (original if already plain `Set`; mutable copy otherwise) |
| `FabricRegExp` | `RegExp` (frozen via `Object.freeze()`; `lastIndex` immutable) | `RegExp` (original reference; mutable `lastIndex`) |
| `FabricEpochNsec` | Passed through unchanged (`FabricPrimitive`; always-frozen) | Passed through unchanged (same) |
| `FabricEpochDays` | Passed through unchanged (`FabricPrimitive`; always-frozen) | Passed through unchanged (same) |
| `FabricHash` | Passed through unchanged (always-frozen; Section 1.4.6) | Passed through unchanged (same) |
| `FabricBytes` | Passed through unchanged (always-frozen; Section 1.4.6) | Passed through unchanged (same) |
| Other `FabricInstance` | Passed through unchanged | Passed through unchanged |
| Primitives | Passed through unchanged | Passed through unchanged |
| Arrays | Recursively unwrapped; output frozen | Recursively unwrapped; output NOT frozen |
| Plain objects | Recursively unwrapped; output frozen | Recursively unwrapped; output NOT frozen |

The output type is `FabricValue | FabricNativeObject`, reflecting that the
result may contain native JS types at any depth.

> **Implementation: `FabricNativeWrapper` dispatch.** The unwrapping
> functions use a single `instanceof FabricNativeWrapper` check to identify
> all native object wrappers, then delegate to `toNativeValue(frozen)` on the
> base class. This replaces the previous pattern of per-wrapper `instanceof`
> cascades (`instanceof FabricError`, `instanceof FabricMap`, etc.) with
> a single branch. The `toNativeValue()` method (defined on
> `FabricNativeWrapper`, Section 1.4.1) handles the freeze-state check and
> delegates to the subclass's `toNativeFrozen()` or `toNativeThawed()` when a
> state change is needed.

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

**Recurses into `FabricError` internals.** The function recurses into
`FabricError` internals —
specifically, the `cause` chain and custom enumerable properties — unwrapping any
nested `FabricInstance` values. This ensures the output is fully "native JS"
with no fabric wrappers at any depth. Without this recursion, an Error's
`cause` could still contain `FabricInstance` wrappers (e.g., a nested
`FabricError`).

> **Why `FrozenMap` / `FrozenSet`?** `Object.freeze()` does not prevent
> mutation of `Map` and `Set` — their `set()`, `delete()`, `add()`, and
> `clear()` methods remain callable on a frozen instance. `FrozenMap` and
> `FrozenSet` are thin wrappers that expose the read-only subset of the
> `Map`/`Set` API (`get`, `has`, `entries`, `forEach`, `size`, etc.) and throw
> on any mutation attempt. This ensures that data round-tripped through the
> fabric layer remains effectively immutable even after unwrapping. The exact
> API of `FrozenMap` and `FrozenSet` is an implementation decision.

> **Why `FabricPrimitive` subclasses pass through unchanged.**
> `FabricEpochNsec`, `FabricEpochDays`, `FabricHash`, and `FabricBytes` are
> all `FabricPrimitive` subclasses — always frozen at construction time with
> no mutable state. They have no native equivalent to unwrap to (unlike
> `FabricError` → `Error` or `FabricMap` → `Map`), so the unwrap function
> returns them as-is.

> **Why `FabricBytes` copies its input.** `FabricBytes` is a
> `FabricPrimitive` — always frozen at construction time with its bytes
> defensively copied. Unlike the old `FabricUint8Array` (which was a
> `FabricInstance` that unwrapped to `Blob` or `Uint8Array`), `FabricBytes`
> has no native equivalent to unwrap to. Callers who need raw bytes can use
> `slice()` or `copyInto()` on the `FabricBytes` instance directly.

### 8.5 Round-Trip Guarantees

For any supported value `v`:

```
nativeFromFabricValue(fabricFromNativeValue(v))
```

produces a value that is structurally equivalent to `v` — the same data at the
same positions. The round-tripped value may or may not be `===` to the original:
when the freeze state already matches, wrappers return their internal reference
directly; when it differs, a new object is constructed. The **freeze state of
the output always matches the `frozen` argument**: when `frozen` is `true` (the
default), the output tree is fully frozen — arrays and plain objects are frozen
via `Object.freeze()`, a mutable `Map` becomes a `FrozenMap`, a mutable `Set`
becomes a `FrozenSet`, temporal wrappers unwrap to their bigint values,
`FabricHash` and `FabricBytes` pass through unchanged, and `Error`s are
frozen. When `frozen` is `false`, the output tree is
fully mutable. The data content is preserved; the mutability matches the `frozen`
argument.

Similarly, for any `FabricValue` `sv`:

```
fabricFromNativeValue(nativeFromFabricValue(sv))
```

produces a `FabricValue` that is structurally equivalent to `sv`.

---

## Appendix A: Open Design Decisions

These questions may need resolution during implementation but do not block the
spec from being implementable.

- **Comparison semantics for modern types**: Should equality be by identity, by
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

- **Schema integration**: Each `FabricInstance` type implies a schema for its
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
  Section 2.5 covers `Cell` reconstruction. Other future fabric types may
  need additional context methods. Should the interface be extended, or should
  types cast to a broader interface? Recommendation: extend the interface as
  needed; the indirection through an interface (rather than depending on
  `Runtime` directly) makes this straightforward.

- **`getRaw()` / `setRaw()` middle-layer contract**: Emerging consensus is
  that `Cell.getRaw()` and `Cell.setRaw()` should traffic in `FabricValue`
  (middle layer), not arbitrary native JS values (wild west). A usage survey
  of all call sites in the codebase found that every existing caller operates
  on well-defined fabric data (plain objects, arrays, strings, links, stream
  markers) — no call site stores or retrieves raw native types like `Error`,
  `Date`, `RegExp`, `Map`, `Set`, or `Uint8Array` through these methods.
  Formalizing this contract (e.g., refining the type parameter `T` of
  `IAnyCell` to `extends FabricValue`) would make the implicit expectation
  explicit without breaking any current caller. The `nativeFromFabricValue()` /
  `fabricFromNativeValue()` dispatch in these methods (Section 4.9) is correct but
  forward-looking: it will become load-bearing when user-facing patterns
  start storing modern types through the schema-aware `set()` path.
