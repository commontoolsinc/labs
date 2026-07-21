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
> (`FabricSpecialObject`, `FabricInstance`, `FabricPrimitive`), and the
> in-process lifecycle symbols (`DEEP_FREEZE`, `IS_DEEP_FROZEN`) are
> defined in `packages/data-model/interface.ts`; the serialization
> vocabulary (the `CODEC` symbol, `FabricCodec`, `ReconstructionContext`,
> `SerializationContext`) lives in `packages/data-model/codec-common/`
> (Section 2). The dispatch and conversion
> functions are in `packages/data-model/fabric-value.ts`. Type declarations visible to
> patterns are in `packages/api/index.ts` (inline `interface` + `declare
> const` pattern). The `packages/runner/` wires concrete implementations
> into builder exports.

```typescript
// Shown at module scope.
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
  | number    // any number, including `-0`, `NaN`, and `±Infinity`; see Section 1.3
  | string
  | undefined // first-class fabric value; requires tagged representation in formats lacking native `undefined`
  | bigint    // large integers; rides through without wrapping (like `undefined`)
  | symbol    // registry-interned symbols only (`Symbol.keyFor(s)` returns a string); see Section 1.3

  // (b) Special primitives (FabricPrimitive subclasses — always frozen)
  | FabricEpochNsec
  | FabricEpochDays
  | FabricHash
  | FabricBytes
  | FabricRegExp

  // (c) Branded fabric types (custom types implementing the fabric protocol)
  //     This arm covers:
  //       - Native object wrappers: `FabricError`, `FabricMap`,
  //         `FabricSet` (Section 1.4)
  //       - User-defined types: `Cell`, `Stream`, etc.
  //       - System types: `DataUnavailable`, `UnknownValue`,
  //         `ProblematicValue`
  | FabricInstance

  // (d) Recursive containers
  | FabricValue[]
  | { [key: string]: FabricValue };
```

> **Restricted and excluded JS types.**
>
> - `symbol` — **Conditionally** part of the universe. Registry-interned
>   symbols (`Symbol.for(key)`, where `Symbol.keyFor(s)` returns a string)
>   are first-class fabric values: they are portable across realms and
>   processes via their registry key. **Unique** symbols (`Symbol(desc)`,
>   where `Symbol.keyFor(s)` returns `undefined`) have no portable
>   representation and are rejected. The TypeScript `symbol` type cannot
>   express this distinction, so it is enforced at runtime by the
>   conversion, hashing, and serialization boundaries (Sections 4.9, 6,
>   and 5). Symbol-keyed *properties* on plain objects are a separate
>   matter — see Section 1.5 (Recursive Containers / Objects).
> - `function` — Functions are opaque closures with no portable
>   representation. They are explicitly **not** representable as fabric
>   values, eliciting a thrown error from `fabricFromNativeValue()` and a
>   `false` return value from `isFabricCompatible()`. (`FabricInstance`s
>   are not functions in this sense — they are class instances whose
>   serialization is handled by their class's `[CODEC]`.)
>
>   A proposed, deliberately narrow exception adds a `FabricFactory` arm for
>   builder-created factories and codec-decoded factory shells admitted to the
>   internal data-model brand table. The function itself is the Fabric value
>   and encodes through `Factory@1`; there is no non-callable wrapper class.
>   This data-type brand does not grant executable trust, which is established
>   separately by resolving a content-addressed builder artifact. The exception
>   is not automatic under the current protocol: it requires branded-function
>   dispatch before generic function rejection, plus factory-state handling in
>   conversion, freezing, cloning, equality, hashing, and traversal. Every
>   unbranded function remains rejected. See
>   [First-Class Serializable Factories](../pattern-construction/node-factory-shipping.md).
>
> Of the two JS primitive types whose `typeof` results (`"symbol"` and
> `"function"`) describe non-data values, `symbol` has a corresponding
> `FabricValue` arm (with the runtime interned-vs-unique restriction
> above) and `"function"` does not **in the current model**. The proposal above
> adds only the branded `FabricFactory` function arm. All other `typeof` results
> (`"undefined"`, `"boolean"`, `"number"`, `"string"`, `"bigint"`,
> `"object"`) have unconditional `FabricValue` arms.

#### `FabricNativeObject`

A separate type — **outside** the `FabricValue` hierarchy — defines the raw
native JS object types that the conversion layer can handle:

```typescript
// Shown at module scope.
// file: packages/data-model/fabric-value.ts

/**
 * Union of raw native JS object types that the conversion layer can translate
 * to and from `FabricValue`. These types sit outside the `FabricValue`
 * hierarchy and only appear at conversion function boundaries (Section 8).
 *
 * Primitives like `bigint` and `undefined` are NOT included — they are
 * directly part of `FabricValue`. The wrapper classes (`FabricError`,
 * `FabricMap`, etc.) are also NOT this type — they are `FabricInstance`
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
> (`FabricInstance` + `[CODEC]`). See Section 7.1 for migration guidance.

### 1.3 Primitive Types

| Type | Constraints | Notes |
|------|-------------|-------|
| `null` | None | The null value |
| `boolean` | None | `true` or `false` |
| `number` | None | Any IEEE 754 binary64 value, including `-0`, `NaN`, and `±Infinity`. See the callout below. |
| `string` | None | Unicode text |
| `undefined` | None | First-class fabric value; see note below |
| `bigint` | None | Large integers; JSON-encoded as base64url (RFC 4648, Section 5) of two's complement big-endian bytes (Section 3 of `3-json-encoding.md`) |
| `symbol` | Registry-interned only | Only symbols for which `Symbol.keyFor(s)` returns a string (i.e., `Symbol.for(key)` symbols) are admitted. Unique symbols (`Symbol(desc)`) are rejected. See the callout below. |

> **`undefined` as a first-class fabric value.** `undefined` is a first-class
> fabric value that round-trips faithfully through serialization. Because most
> wire formats (including JSON) have no native `undefined` representation, the
> serialization system uses a dedicated tagged form for `undefined` — the same
> tagged form regardless of context (array element, object property value, or
> top-level value). See Section 3 of `3-json-encoding.md` for the specific JSON encoding. Deletion
> semantics (e.g., removing a cell's value when `undefined` is written at top
> level) are an application-level concern, not a serialization concern: the
> serializer faithfully records `undefined` and the application layer interprets
> the result.

> **`-0`, `NaN`, and `±Infinity`.** The hashing layer (Section 6.4 and
> `2-hash-byte-format.md` Section 4.3) and the JSON wire format (Section 5;
> `3-json-encoding.md` Section 3, `SpecialNumber@1`) both faithfully
> represent `-0`, `NaN`, `+Infinity`, and `-Infinity` as first-class
> values, distinct from `0` and from each other. All four values pass
> through `shallowFabricFromNativeValue()` and `fabricFromNativeValue()`
> (Section 4.9) unchanged — `-0` retains its sign
> (`Object.is(result, -0) === true`), and `NaN` / `±Infinity` round-trip
> through hashing and JSON encoding via the byte-level forms in
> `2-hash-byte-format.md` Section 4.3 and the `SpecialNumber@1` envelope in
> `3-json-encoding.md` Section 3. Value-equality among these values follows
> `Object.is()` — `-0` is distinct from `+0` while all `NaN`s are equal — as
> specified in Section 6.7.

> **Interned vs. unique symbols.** The hashing layer (Section 6.4 and
> `2-hash-byte-format.md` Section 4.6) and the JSON wire format
> (Section 5; `3-json-encoding.md` Section 3, `Symbol@1`) both faithfully
> represent registry-interned symbols, identifying them by their registry
> key (`Symbol.keyFor(s)`). Unique symbols (`Symbol(desc)` — those for
> which `Symbol.keyFor(s)` returns `undefined`) have no portable
> representation and are rejected at every layer. Interned symbols pass
> through `shallowFabricFromNativeValue()` and `fabricFromNativeValue()`
> (Section 4.9) unchanged: round-trip via `Symbol.for(key)` yields a result
> that is `===` to any other `Symbol.for(key)` in the same realm. Unique
> symbols throw with the message `"Cannot store unique (uninterned) symbol"`.

### 1.4 Native Object Wrapper Classes

Certain built-in JS types (`Error`, `Map`, `Set`) cannot
have `Symbol`-keyed methods added via prototype patching in a reliable,
cross-realm way. Rather than handling them with special-case logic in the
serializer, the system defines **wrapper classes** — one per native type — that
implement `FabricInstance`. The conversion layer (Section 8) wraps raw native
objects into these classes when bridging from the JS wild west to `FabricValue`,
and unwraps them when bridging back. (Native `RegExp` is also bridged by the
conversion layer, but into the `FabricRegExp` **primitive** rather than a
wrapper — see Section 1.4.5.)

Because each wrapper genuinely implements `FabricInstance` and hosts a
`[CODEC]` (Section 2.4), the serialization system processes them through
the same uniform codec dispatch as every other fabric class — no special
cases needed in the serializer. The hashing system also uses the standard
`TAG_INSTANCE` path for all wrappers. `FabricBytes` (the byte-sequence type)
has a dedicated `TAG_BYTES` tag for content-level identity (see Section 6.3),
but it is a `FabricPrimitive`, not a `FabricInstance`.

The **special primitive** types (`FabricEpochNsec`, `FabricEpochDays`,
`FabricHash`, `FabricBytes`, `FabricRegExp`) are **not** `FabricInstance`s —
they are `FabricPrimitive` subclasses (Section 1.4.6). `FabricPrimitive` extends
`FabricSpecialObject`, and the `FabricValue` union includes
`FabricSpecialObject`, so all `FabricPrimitive` subclasses are implicitly
members of `FabricValue`. They are always-frozen value types that bypass the
`freeze` option in conversion functions. Each hosts its own `[CODEC]` for
wire-format serialization, just like the wrappers; what distinguishes them
is the hashing layer, where each has a dedicated primitive hash tag rather
than the `TAG_INSTANCE` path (Section 6.3). They do not carry a
`wireTypeTag` property (no fabric type does, save the `ExplicitTagValue`
family; the wire tag is the codec's concern).

#### 1.4.1 Wrapper Class Summary

| Wrapper Class | Wraps | Type Tag | Encoded State | Notes |
|---------------|-------|----------|---------------|-------|
| `FabricError` | `Error` | `Error@1` | `{ type, name, message, stack?, cause?, ...custom }` | `type` is the constructor name (e.g. `"TypeError"`). `name` is the `.name` property if it differs from `type`, or `null` if it matches (the common case). Includes `message`, `stack` (if present), `cause` (if present), and custom enumerable properties. The conversion layer (Section 8.2) recursively converts nested values (including `cause` and custom properties) before wrapping, ensuring all values are `FabricValue` by the time the codec's `encode()` runs. |
| `FabricMap` | `Map` | `Map@1` | `[[key, value], ...]` | Entry pairs as an array of two-element arrays. Insertion order is preserved. Keys and values are recursively processed. **Implementation status: stubbed** — the tag is reserved and the class exists, but its members and codec currently throw (see Section 1.4.3). |
| `FabricSet` | `Set` | `Set@1` | `[value, ...]` | Elements as an array. Iteration order is preserved. Values are recursively processed. **Implementation status: stubbed** — the tag is reserved and the class exists, but its members and codec currently throw (see Section 1.4.4). |

(Native `RegExp` is also bridged by the conversion layer, but into the
`FabricRegExp` **primitive** — a `FabricPrimitive` subclass, not a wrapper. It
is therefore listed in the special-primitive table below and detailed in
Section 1.4.5, not here.)

Each wrapper class above:

- **Extends `FabricNativeWrapper<T>`** (which extends `BaseFabricInstance`,
  which in turn extends `FabricInstance`), inheriting the `shallowClone()`
  frozenness-management template method from `BaseFabricInstance` and
  providing a `toNativeValue(frozen)` method for unwrapping.
- **Hosts a static `[CODEC]`** (Section 2.4) whose `encode()` extracts
  essential state and whose `decode()` returns an instance of the wrapper
  class — **not** the raw native type. Callers who need the underlying
  native object use `nativeFromFabricValue()` (Section 8) to unwrap it.
  The wire tag (e.g., `"Error@1"`) is carried by the codec, not by the
  instances.
- **Has `[DEEP_FREEZE]` and `[IS_DEEP_FROZEN]` methods plus a `deepClone(frozen)`
  method** per the `FabricInstance` protocol (Section 2.3); the deep-freeze
  pair participates in the generic `deepFreeze()` dispatch (Section 8.6).

##### `FabricNativeWrapper<T>` Base Class

All native object wrappers share an abstract base class that extends
`BaseFabricInstance` (see Section 2.3) and adds methods for unwrapping back
to native form:

```typescript
// Shown for illustration only.
// file: packages/data-model/fabric-instances/FabricNativeWrapper.ts

/**
 * Abstract base class for `FabricInstance` wrappers that bridge native JS
 * objects into the `FabricValue` layer.
 * Provides a common `toNativeValue()` method used by both the shallow and
 * deep unwrap functions, replacing their `instanceof` cascades with a
 * single `instanceof FabricNativeWrapper` check.
 */
export abstract class FabricNativeWrapper<T extends object>
  extends BaseFabricInstance {
  /** The wrapped native value, used by `toNativeValue` for freeze-state checks. */
  protected abstract get wrappedValue(): T;

  /** Converts the wrapped value to frozen form (only called on state mismatch). */
  protected abstract toNativeFrozen(): T;

  /** Converts the wrapped value to thawed form (only called on state mismatch). */
  protected abstract toNativeThawed(): T;

  /** Returns the underlying native value, optionally frozen. */
  toNativeValue(frozen: boolean): T {
    const value = this.wrappedValue;
    if (frozen === Object.isFrozen(value)) return value;
    return frozen ? this.toNativeFrozen() : this.toNativeThawed();
  }

  /** @inheritDoc */
  deepClone(_frozen: boolean): FabricInstance {
    throw new Error(
      `Cannot yet handle deep cloning of \`${this.constructor.name}\`.`,
    );
  }
}
```

The `toNativeValue(frozen)` method returns the original wrapped value when
its freeze state already matches the `frozen` argument, and constructs a new
instance only when a freeze-state change is needed. This avoids defensive
copying in the common case and centralizes the freeze-state logic for all
wrapper types.

Unlike the wrappers above, the special primitive types (`FabricEpochNsec`,
`FabricEpochDays`, `FabricHash`, `FabricBytes`, `FabricRegExp`) are
**`FabricPrimitive` subclasses** and do not extend `FabricInstance`. They are
included in `FabricValue` via the `FabricSpecialObject` arm of the union
(Section 1.4.6). See Sections 1.4.5 through 1.4.10.

| Special Primitive Type | Extends | Wire Tag | Stored Value | Notes |
|------------------------|---------|----------|--------------|-------|
| `FabricEpochNsec` | `FabricPrimitive` | `EpochNsec@1` | `bigint` (signed nanoseconds from POSIX Epoch) | Primary temporal type. JS `Date` has only millisecond precision; conversion from `Date` multiplies by 10^6. When `Temporal` is available, `Temporal.Instant` maps naturally (it uses nanoseconds from epoch internally). |
| `FabricEpochDays` | `FabricPrimitive` | `EpochDays@1` | `bigint` (signed days from POSIX Epoch) | Day-precision temporal type. Anticipates `Temporal.PlainDate`. Mostly nascent — class and spec entry are defined, but full integration (Temporal types, calendar concerns) is deferred. |
| `FabricHash` | `FabricPrimitive` | `Hash@1` | `Uint8Array` (hash bytes, private) + `string` (algorithm tag) | Content identifier / hash. Stringifies as `<tag>:<base64urlhash>` (unpadded base64url, RFC 4648 Section 5). The first algorithm tag is `fid1` ("fabric ID, v1"). Wire state is `{ tag, hash }` (see Section 1.4.9). |
| `FabricBytes` | `FabricPrimitive` | `Bytes@1` | `Uint8Array` (private byte storage) | Immutable byte sequence. Input bytes are copied at construction time. Callers access bytes via `slice()`, `copyInto()`, and `length`. |
| `FabricRegExp` | `FabricPrimitive` | `RegExp@1` | `source` / `flags` / `flavor` strings | Regular-expression value. `source` is the pattern string (`regex.source`); `flags` is the flag string (`regex.flags`); `flavor` is the regex dialect identifier (e.g. `"es2025"`). Stores strings only; `value` returns a fresh native `RegExp` clone per call. Extra enumerable properties on a native `RegExp` cause rejection. |

#### Extra Enumerable Properties

**`FabricError`** MAY carry extra enumerable properties beyond the standard
fields (`type`, `name`, `message`, `stack`, `cause`). Custom properties on `Error`
objects are common JavaScript practice (e.g., `error.code`, `error.statusCode`),
so `FabricError` preserves them in an "extras" bag: the codec's `encode()`
includes them in its output, and `decode()` restores them on the
reconstructed instance (Section 1.4.2).

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

Unlike a thin wrapper holding a native `Error`, `FabricError` stores
**structured `FabricValue`-typed state** — fixed-schema slots (`type`,
`name`, `message`, `stack`, `cause`) plus a hidden "extras" bag of custom
enumerable properties accessed via map-like methods. The native `Error`
form is a *projection*, produced on demand by `toNativeValue()` (and
cached once the instance is frozen, when it can no longer go stale).

```typescript
// Shown for illustration only.
// file: packages/data-model/fabric-instances/FabricError.ts

/**
 * Structured state for constructing a `FabricError`. Spec slots are
 * `FabricValue`-typed; the optional `extras` carries any custom enumerable
 * properties (also in `FabricValue` form).
 */
export type FabricErrorState = {
  /** Constructor name of the originating native `Error`
   *  (e.g. `"TypeError"`). */
  readonly type: string;
  /**
   * The `.name` property. Pass `null` (or omit) to mean "same as `type`";
   * the resulting instance's `.name` is always a concrete string (`null`
   * is a wire-level optimization at the `[CODEC]` encode boundary, not
   * part of the public API).
   */
  readonly name?: string | null | undefined;
  /** The `.message` property. */
  readonly message: string;
  /** The `.stack` property, or `undefined`. */
  readonly stack: string | undefined;
  /** The `.cause` value, in `FabricValue` form, or `undefined`. */
  readonly cause: FabricValue | undefined;
  /** Optional custom enumerable own properties, in `FabricValue` form.
   *  Keys must not collide with the fixed-schema slot names or with
   *  prototype-sensitive keys. */
  readonly extras?:
    | Iterable<readonly [string, FabricValue]>
    | Readonly<Record<string, FabricValue>>
    | undefined;
};

/**
 * Wrapper for `Error` instances in the fabric type system. The publicly
 * observable state is entirely `FabricValue`-typed: fixed-schema slots
 * plus a hidden extras bag. The native `Error` form is produced on demand
 * by `toNativeValue()`.
 *
 * Like all `FabricInstance`s, a `FabricError` is wholeheartedly mutable
 * until frozen and immutable thereafter. The fixed-schema slots are plain
 * writable own properties: assigning to one throws once the instance is
 * `Object.freeze`'d. The extras bag mirrors this by gating `setExtra` /
 * `deleteExtra` on the frozen state. The serialization layer handles
 * `FabricError` via its static `[CODEC]`, which is the source of truth
 * for the encoded form.
 */
export class FabricError extends FabricNativeWrapper<Error> {
  type: string;
  name: string;       // always a concrete string on instances
  message: string;
  stack: string | undefined;
  cause: FabricValue | undefined;

  /** Hidden bag of custom enumerable properties. */
  readonly #extras: Map<string, FabricValue>;

  /**
   * Constructs from a `FabricErrorState` record. All state values must
   * already be in `FabricValue` form -- the conversion layer is
   * responsible for ensuring this when converting from a native `Error`.
   * Unsafe keys (`__proto__`, `constructor`) and fixed-schema slot names
   * are silently skipped in `extras`.
   */
  constructor(state: FabricErrorState);

  /**
   * Shallow conversion from a native `Error`, used by the shallow
   * conversion layer (Section 8.2). The error's `.cause` and custom
   * properties are stored as-is; the deep conversion path converts them
   * when needed.
   */
  static fromNativeError(error: Error): FabricError;

  // Extras-bag access (the bag is not exposed as an own property).
  // `setExtra`/`deleteExtra` throw on a frozen instance, on fixed-schema
  // slot names, and on prototype-sensitive keys.
  getExtra(key: string): FabricValue | undefined;
  hasExtra(key: string): boolean;
  setExtra(key: string, value: FabricValue): void;
  deleteExtra(key: string): boolean;
  get extraSize(): number;
  extraKeys(): IterableIterator<string>;
  extraEntries(): IterableIterator<[string, FabricValue]>;

  // ([DEEP_FREEZE] / [IS_DEEP_FROZEN] freeze `this` and recurse into
  // `cause` + the extras-bag values; `[SHALLOW_UNFROZEN_CLONE]()` copies the
  // slots + bag; `wrappedValue` / `toNativeFrozen()` / `toNativeThawed()`
  // build the native `Error` projection on demand. `deepClone(frozen)`
  // round-trips through the codec: `codec.decode(tag,
  // codec.encode(this), context)`. Bodies omitted for brevity.)

  static #codec = Object.freeze(
    new (class FabricErrorCodec extends BaseFabricCodec {
      constructor() {
        super(CODEC_TYPE_TAGS.Error, FabricError);
      }

      /**
       * Emits `{ type, name, message, stack?, cause?, ...extras }`.
       * `name` is emitted as `null` when it matches `type` (the common
       * case) to avoid redundancy; `decode()` interprets `null` as "same
       * as `type`."
       */
      encode(value: FabricError): FabricValue {
        const state: Record<string, FabricValue> = {
          type: value.type,
          name: value.name === value.type ? null : value.name,
          message: value.message,
        };
        if (value.stack !== undefined) {
          state.stack = value.stack;
        }
        if (value.cause !== undefined) {
          state.cause = value.cause;
        }
        for (const [key, val] of value.extraEntries()) {
          state[key] = val;
        }
        return state as FabricValue;
      }

      /**
       * Rebuilds a `FabricError` from wire state. Uses `type` for class
       * identity, falling back to `name` for backward compatibility with
       * data serialized before `type` was added; missing `message`
       * becomes `''`. Reserved and unsafe keys are excluded from the
       * extras. Honors `context.shouldDeepFreeze` (Section 2.5).
       */
      decode(
        _typeTag: string,
        state: FabricValue,
        context: ReconstructionContext,
      ): FabricValue {
        const s = state as Record<string, FabricValue>;
        const type = (s.type as string) ?? (s.name as string) ?? 'Error';
        const name = (s.name as string | null | undefined) ?? type;
        const message = (s.message as string) ?? '';

        const extras: Array<[string, FabricValue]> = [];
        for (const key of Object.keys(s)) {
          if (FABRIC_ERROR_RESERVED_KEYS.has(key) || UNSAFE_KEYS.has(key)) {
            continue;
          }
          extras.push([key, s[key]]);
        }

        const result = new FabricError({
          type,
          name,
          message,
          stack: s.stack as string | undefined,
          cause: s.cause,
          extras,
        });
        return context.shouldDeepFreeze ? deepFreeze(result) : result;
      }
    })(),
  );

  /** The codec for instances of this class. */
  static get [CODEC](): FabricCodec {
    return this.#codec;
  }
}
```

The native projection (`#buildNativeError()`, reached via
`toNativeValue()`) reconstructs the appropriate `Error` subclass from
`type` (via a constructor-name lookup, defaulting to `Error`), restores
`name` when it differs, and copies `stack`, `cause`, and the extras onto
the result. While the instance is mutable the projection is rebuilt on
each access; once frozen it is cached.

#### 1.4.3 `FabricMap`

> **Implementation status: stubbed (tag reserved).** The live class
> exists with the full wrapper shape (including the native-projection
> members, with `toNativeFrozen()` producing a `FrozenMap`), and its
> `Map@1` tag is reserved in `CODEC_TYPE_TAGS`, but the protocol members
> and the codec's `encode()`/`decode()` currently throw
> (`"FabricMap: not yet implemented"`) — `FabricMap` is not yet used and
> is being reworked separately. The code below is the **normative
> target** the implementation must converge on; the wire format matches
> Section 1.4.1.

```typescript
// Shown at module scope.
// file: packages/data-model/fabric-instances/FabricMap.ts
// (Normative target -- the live codec is currently a throwing stub.)

/**
 * Wrapper for `Map` instances. Extra properties beyond the wrapped
 * collection are not supported on non-`Error` wrappers.
 */
export class FabricMap
  extends FabricNativeWrapper<Map<FabricValue, FabricValue>> {
  constructor(readonly map: Map<FabricValue, FabricValue>) {
    super();
  }

  // ([DEEP_FREEZE] / [IS_DEEP_FROZEN] freeze `this` and recurse into the
  // entries; `[SHALLOW_UNFROZEN_CLONE]()` copies `map` into a new wrapper;
  // `wrappedValue` / `toNativeFrozen()` (-> `FrozenMap`) /
  // `toNativeThawed()` are the native-projection members.)

  static #codec = Object.freeze(
    new (class FabricMapCodec extends BaseFabricCodec {
      constructor() {
        super(CODEC_TYPE_TAGS.Map, FabricMap);
      }

      /** Entry pairs as an array of two-element arrays; insertion order
       *  is preserved. */
      encode(value: FabricMap): FabricValue {
        return [...value.map.entries()] as FabricValue;
      }

      decode(
        _typeTag: string,
        state: FabricValue,
        context: ReconstructionContext,
      ): FabricValue {
        const entries = state as [FabricValue, FabricValue][];
        const result = new FabricMap(new Map(entries));
        return context.shouldDeepFreeze ? deepFreeze(result) : result;
      }
    })(),
  );

  /** The codec for instances of this class. */
  static get [CODEC](): FabricCodec {
    return this.#codec;
  }
}
```

#### 1.4.4 `FabricSet`

> **Implementation status: stubbed (tag reserved)**, exactly parallel to
> `FabricMap` (Section 1.4.3): the class shape and reserved `Set@1` tag
> exist (with `toNativeFrozen()` producing a `FrozenSet`); the protocol
> members and codec currently throw (`"FabricSet: not yet implemented"`).
> The code below is the **normative target**; the wire format matches
> Section 1.4.1.

```typescript
// Shown at module scope.
// file: packages/data-model/fabric-instances/FabricSet.ts
// (Normative target -- the live codec is currently a throwing stub.)

/**
 * Wrapper for `Set` instances.
 */
export class FabricSet extends FabricNativeWrapper<Set<FabricValue>> {
  constructor(readonly set: Set<FabricValue>) {
    super();
  }

  // (Lifecycle and native-projection members parallel to `FabricMap`.)

  static #codec = Object.freeze(
    new (class FabricSetCodec extends BaseFabricCodec {
      constructor() {
        super(CODEC_TYPE_TAGS.Set, FabricSet);
      }

      /** Elements as an array; iteration order is preserved. */
      encode(value: FabricSet): FabricValue {
        return [...value.set] as FabricValue;
      }

      decode(
        _typeTag: string,
        state: FabricValue,
        context: ReconstructionContext,
      ): FabricValue {
        const elements = state as FabricValue[];
        const result = new FabricSet(new Set(elements));
        return context.shouldDeepFreeze ? deepFreeze(result) : result;
      }
    })(),
  );

  /** The codec for instances of this class. */
  static get [CODEC](): FabricCodec {
    return this.#codec;
  }
}
```

#### 1.4.5 `FabricRegExp`

`FabricRegExp` is a `FabricPrimitive` subclass, not a native-object wrapper. A
regular expression is a leaf type with respect to references (it holds no
nested `FabricValue`s) and is reasonably conceived of as stateless: although a
JS `RegExp` carries mutable internal state (notably `lastIndex`), a
`FabricRegExp` never hands out its stored `RegExp` un-cloned, so no mutable
state is exposed. It therefore has a dedicated hash tag (`TAG_REGEXP`,
Section 6.3). Like every fabric class, it hosts its own `[CODEC]` (tag
`RegExp@1`) for wire-format serialization; being a `FabricPrimitive`, it
does not implement the `FabricInstance` members.

```typescript
// Shown for illustration only.
// file: packages/data-model/fabric-primitives/FabricRegExp.ts

import { FabricPrimitive } from './interface';

/**
 * Immutable regular-expression value in the fabric type system.
 *
 * The essential state is `{ source, flags, flavor }` — the values needed to
 * (re)construct an equivalent regex. The `flavor` string identifies the regex
 * dialect; only `"es2025"` (the default) is currently representable as a
 * native JS `RegExp`. The `flavor` field is forward-looking for multi-runtime
 * scenarios where different regex engines may be in use.
 *
 * For the `"es2025"` flavor the constructor proactively builds and retains a
 * private `RegExp` (validating the pattern eagerly and making `value` cheap);
 * the retained instance is never handed out directly, so `value` returns a
 * fresh clone on each call. Other flavors store their strings faithfully but
 * cannot yet produce a native `RegExp`, so `value` throws for them.
 *
 * A native `RegExp` argument with extra enumerable own properties is rejected
 * (death before confusion).
 */
export class FabricRegExp extends FabricPrimitive {
  // Constructed either from a native `RegExp` (implying the `"es2025"`
  // flavor) or from explicit `flavor` / `source` / `flags`.
  constructor(regex: RegExp);
  constructor(flavor: string, source: string, flags: string);

  /** The pattern source text. */
  get source(): string;

  /** The flags string (e.g. `"gi"`). */
  get flags(): string;

  /** Regex flavor/dialect identifier (e.g. `"es2025"`). */
  get flavor(): string;

  /**
   * A fresh native `RegExp` equivalent to this value, returned anew on each
   * call so the internal instance is never aliased out. Throws when the
   * flavor has no native `RegExp` representation.
   */
  get value(): RegExp;
}
```

#### 1.4.6 `FabricSpecialObject` and `FabricPrimitive` (Base Classes)

The fabric type hierarchy uses two abstract base classes that share a common
root:

```
FabricSpecialObject (abstract root)
├── FabricInstance (abstract — object-like protocol types)
└── FabricPrimitive (abstract — immutable special primitives)
```

**`FabricSpecialObject`** is the common superclass of both branches. It enables
a single `instanceof FabricSpecialObject` check wherever code needs to recognize
any fabric-system value without caring which branch it belongs to.

```typescript
// file: packages/data-model/interface.ts

/**
 * Abstract base class for all fabric-system value types. This is the common
 * superclass of `FabricInstance` (object-like protocol types)
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
  `FabricBytes`, `FabricRegExp`).

```typescript
// Shown for illustration only.
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
// Shown at module scope.
// file: packages/data-model/fabric-primitives/FabricEpochNsec.ts

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
// Shown at module scope.
// file: packages/data-model/fabric-primitives/FabricEpochDays.ts

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
// Shown at module scope.
// file: packages/data-model/fabric-primitives/FabricHash.ts

/**
 * A content-addressed identifier: a hash digest paired with an algorithm tag.
 * Extends `FabricPrimitive` — treated like a primitive in the fabric type
 * system (always frozen, passes through conversion unchanged).
 *
 * The first algorithm tag is `fid1` ("fabric ID, v1"), which corresponds
 * to the SHA-256-based hash produced by `hashOf()` (Section 6.4).
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

  /** The algorithm tag (e.g., `"fid1"`). */
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

  /**
   * Parse an instance from its string representation
   * (`<tag>:<base64urlHash>`). Splits at the FIRST colon: the tag segment is
   * a colon-free identifier (e.g. `fid1`) and the hash segment is base64url
   * (which never contains a colon), so the first colon is the tag/hash
   * boundary. Entity URI schemes (`of:`, `computed:`) are NOT part of this
   * string — a caller must strip the scheme before parsing and carry it
   * alongside, since the scheme is part of the entity's identity. An input
   * that still carries a scheme leaves a colon in what would be the hash
   * segment, which is not valid base64url, so parsing fails loudly rather
   * than silently mis-splitting.
   */
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
- `FabricHash.fromString(s)` — parse from `<tag>:<base64urlHash>` (splits at
  the first colon; entity URI schemes like `of:`/`computed:` are NOT part of
  this string and must be stripped — and preserved — by the caller).

The `tag` field (formerly `algorithmTag`) is an opaque string identifier.
Known algorithm tags:

| Algorithm Tag | Meaning | Hash Algorithm | Output Size |
|:--------------|:--------|:---------------|:------------|
| `fid1`        | Fabric ID, version 1 | SHA-256 (Section 6.4) | 32 bytes |

Future algorithm tags may be added for different hash algorithms or versioned
content-addressing schemes. The algorithm tag is part of the content ID's
identity — two `FabricHash` instances with the same hash bytes but
different algorithm tags are distinct values.

Like every fabric class, `FabricHash` hosts a `[CODEC]` (tag `Hash@1`).
Its encoded state is `{ tag, hash }` — the algorithm tag plus the hash as
an unpadded base64url string (i.e., `.hashString`); `decode()` validates
both fields are strings, producing a `ProblematicValue` on malformed
state. See Section 5 of `3-json-encoding.md` for the wire format.

#### 1.4.10 `FabricBytes`

```typescript
// Shown for illustration only.
// file: packages/data-model/fabric-primitives/FabricBytes.ts

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
It does not implement the `FabricInstance` members; like every fabric
class, it hosts its own `[CODEC]` (tag `Bytes@1`), the same shape as
`FabricEpochNsec` and `FabricEpochDays`. The hashing system uses the
dedicated `TAG_BYTES` primitive tag (Section 6.3).

#### 1.4.11 `FabricLink`

`FabricLink` is a fabric-native `FabricInstance` — like the wrapper classes of
Sections 1.4.2–1.4.4, but not wrapping any native JS type — that represents a
**link**: the modern, object-shaped form of a reference to fabric data. It
wraps a single **payload**, a plain object (`FabricPlainObject`) of addressing
fields, as its sole nested `FabricValue`.

A link is a `FabricInstance` rather than a `FabricPrimitive` because its
payload is an **outgoing reference**, not leaf data: the payload may itself
carry nested `FabricValue`s (for example a schema filter), so a link is a
small object graph rather than an immutable scalar. Like every instance, a
`FabricLink` is mutable until frozen and immutable thereafter, and its protocol
members (`[DEEP_FREEZE]`, `[IS_DEEP_FROZEN]`, `deepClone()`, and the inherited
`shallowClone()`; Section 2.3) recurse through the payload as their one nested
value.

**The data-model does not constrain the payload's field set.** The value
definition here is deliberately general: the data-model requires only that the
payload be a plain object with no prototype-polluting keys, and treats its
entries as arbitrary `FabricValue`s. Which fields a link carries — and what
they mean — is a **consumer concern**: a module that uses links (for example a
runner's cell references) defines its own payload shape on top of this general
form. Keeping the field set unconstrained is what lets `FabricLink` be reused
across consumers, each specializing the general link value in its own way.

Like every fabric class, `FabricLink` hosts a static `[CODEC]` (Section 2.4)
with wire tag `Link@1`. Its encoded state **is** the payload object: the
codec's `encode()` returns the payload directly, and `decode()` reconstructs a
`FabricLink` from it (or a `ProblematicValue`, Section 3.5, if the payload is
malformed). The JSON wire form is the `/Link@1`-tagged envelope
`{ "/Link@1": <payload> }`; see Section 3 of `3-json-encoding.md` for the wire
encoding, and the migration table in Section 4 for how legacy link forms
(the IPLD sigil `{ "/": { "link@1": … } }` and `$alias`) map onto it.

```typescript
// Shown for illustration only.
// file: packages/data-model/fabric-instances/FabricLink.ts

/**
 * A link value: a `FabricInstance` wrapping a plain-object addressing
 * `payload` as its sole nested `FabricValue`. The data-model does not
 * constrain the payload's fields; consumers define their own payload shape.
 */
export class FabricLink extends BaseFabricInstance {
  constructor(payload: FabricPlainObject);

  /** The wrapped addressing payload. */
  get payload(): FabricPlainObject;

  /** The codec for instances of this class; wire tag `Link@1`. */
  static get [CODEC](): FabricCodec;
}
```

#### 1.4.12 `bigint` — Not Wrapped

`bigint` is a JavaScript primitive (`typeof x === 'bigint'`), not an object. It
rides through the `FabricValue` layer directly, like `undefined`. No
`FabricBigInt` wrapper class is needed. The serialization layer handles
`bigint` with a standalone codec (`BigIntCodec`, analogous to
`UndefinedCodec` — there is no owned class to host a `[CODEC]`); see
Section 4.5.

#### 1.4.13 Design Notes

> **Why wrapper classes instead of inline serializer branches?** Each wrapper
> genuinely implements `FabricInstance` and hosts its own `[CODEC]`, so the
> serialization system dispatches every wrapper through the same uniform
> codec path as any other fabric class — no per-type branches in the
> serializer. This gives the serialization layer a uniform, simpler
> structure: it handles codec-dispatched values and the structural types
> (arrays, objects, primitives), with no knowledge of specific native JS
> types.
>
> **Reconstruction returns the wrapper.** The `FabricError` codec's
> `decode()` returns
> a `FabricError`, not a raw `Error`. This is consistent with the three-layer
> separation: the middle layer (`FabricValue`) contains wrappers, not raw
> native objects. Code that needs the underlying native type uses
> `nativeFromFabricValue()` (Section 8) as a separate step.
>
> **File organization.** Each fabric-instance and fabric-primitive class
> lives in its own file: the `FabricInstance` subclasses (including the
> native object wrappers `FabricError`, `FabricMap`, `FabricSet`
> and the explicit-tag-value family) under
> `packages/data-model/fabric-instances/`; the `FabricPrimitive`
> subclasses (`FabricEpochNsec`, `FabricEpochDays`, `FabricHash`,
> `FabricBytes`, `FabricRegExp`) under
> `packages/data-model/fabric-primitives/`.

### 1.5 Recursive Containers

**Arrays:**
- May be dense or sparse
- Elements may be `undefined` (a first-class fabric value; see Section 1.3)
- Sparse arrays (arrays with holes) are supported; holes are distinct from
  `undefined` and are represented using run-length encoding in serialized forms
  (see below and Section 3 of `3-json-encoding.md` for the specific JSON encoding)
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
> `in`-operator distinction. See Section 3 of `3-json-encoding.md` for the specific JSON encodings.

> **Array serialization strategy.** Even when an array contains holes, it is
> serialized as an array (not an object or other structure). Runs of consecutive
> holes are replaced by a single hole marker carrying the run length, preserving
> the array structure while efficiently encoding sparse arrays. See Section 3 of
> `3-json-encoding.md` for the specific JSON encoding and examples.

**Objects:**
- Plain objects only (class instances must implement the fabric protocol)
- Keys must be strings; symbol-keyed *properties* cause rejection (this
  is distinct from symbol *values*, which are admitted per Section 1.2
  with the runtime restriction in Section 1.3)
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

### 1.7 Runtime Control Values

`DataUnavailable` is a runtime-owned `FabricInstance` control value indicating
that a computation cannot currently use a value. It is not a native-object
wrapper and is not structurally identified: plain authored objects with similar
fields remain ordinary data. Runtime guards recognize the concrete
`DataUnavailable` class and narrow its `reason` discriminator.

One class represents four variants through exact codec state:

```typescript
import type { FabricError } from "@commonfabric/data-model/fabric-instances";

type DataUnavailableState =
  | { readonly reason: "pending" }
  | { readonly reason: "error"; readonly error: FabricError }
  | { readonly reason: "syncing" }
  | { readonly reason: "schema-mismatch" };
```

The `pending`, `syncing`, and `schema-mismatch` values are deeply frozen,
interned instances. The `error` factory returns a fresh, deeply frozen instance
whose error is a deeply frozen `FabricError`; native `Error` input is converted
through the normal fabric conversion path first, so `cause` and enumerable
extra properties remain recursively representable.

`DataUnavailable` participates in the ordinary `FabricInstance` protocols:

- Its `[DEEP_FREEZE]`, `[IS_DEEP_FROZEN]`, shallow-clone, and deep-clone
  implementations include the discriminated state and nested `FabricError`.
  A requested frozen clone may reuse an already-frozen value;
  `deepClone(true)` of a non-error variant canonicalizes to its interned
  instance. An unfrozen clone is distinct, and an error deep clone applies the
  requested frozenness to the nested error as well.
- Equality and hashing use normal codec-state dispatch. The hash therefore
  includes the `DataUnavailable@1` type tag, the `reason`, and the nested
  `FabricError` state for the error variant; different reasons cannot collide
  merely because they share the same class.
- Its class codec is registered in the default `fabric-instances`
  `codecClasses()` list under the canonical `DataUnavailable@1` tag. Unknown
  future tags such as `DataUnavailable@2` follow the normal `UnknownValue`
  path rather than being interpreted by the version-1 codec (Section 3).

Because this is a non-native `FabricInstance`, fabric conversion accepts it as
an existing fabric value and native conversion passes it through unchanged.
The JSON state and validation rules are specified in
[`3-json-encoding.md`](./3-json-encoding.md), Section 3.

---

## 2. The Fabric Protocol

### 2.1 Overview

Types that the system controls opt into storability by implementing members
keyed by well-known symbols. This allows the system to serialize and
deserialize custom types without central registration at the type level.

The protocol has two complementary halves:

- The **instance protocol** (Section 2.3) covers in-process lifecycle: deep
  freezing and cloning. Its members live on each instance.
- The **codec protocol** (Section 2.4) covers serialization: each class hosts
  a `FabricCodec` — an encoder-decoder object that is the **single source of
  truth** for how instances of that class are serialized — as a static
  getter keyed by the `CODEC` symbol.

This split deliberately separates wire-format concerns from live in-process
representation: the codec vocabulary lives in its own module area
(`codec-common/`), and the dependency-free `interface.ts` carries no
serialization machinery at all. Two motivations drove this shape: the seam
between `FabricValue`'s encoding/decoding and the JSON-layer serialization
had grown rough and needed harmonizing, and the previous design had no clean
affordance for legacy-data migration/import (see the decode-only tag
discussion in Section 2.4).

### 2.2 Symbols

The serialization symbol lives with the codec vocabulary; the in-process
lifecycle symbols live on the implementation base class `BaseFabricInstance`
(Section 2.3), kept off the pure-protocol `FabricInstance` interface as
implementation plumbing.

```typescript
// file: packages/data-model/codec-common/interface.ts

/**
 * Well-known symbol for binding the getter `FabricClassWithCodec[CODEC]`.
 * A class hosts its serialization codec as a static getter keyed by this
 * symbol (see Section 2.4).
 */
export const CODEC: unique symbol = Symbol.for('data-model.codec');
```

```typescript
// file: packages/data-model/fabric-instances/BaseFabricInstance.ts

/**
 * Well-known symbol for deeply freezing a fabric instance in place. The
 * implementation freezes the instance's own internal slot(s) and recurses
 * into any nested `FabricValue`s via a `subFreeze` callback supplied by the
 * generic `deepFreeze()` utility. See Section 8.6.
 */
export const DEEP_FREEZE = Symbol.for('data-model.deepFreeze');

/**
 * Well-known symbol for checking whether a fabric instance is already
 * deeply frozen, without mutating it. The side-effect-free sibling of
 * `[DEEP_FREEZE]`: verifies the instance's own internal slot(s) are in
 * canonical deep-frozen form and recurses into any nested `FabricValue`s
 * via a `subIsDeepFrozen` callback, returning the boolean conjunction.
 * See Section 8.6.
 */
export const IS_DEEP_FROZEN = Symbol.for('data-model.isDeepFrozen');

/**
 * Well-known symbol for the **internal** shallow-clone hook: a `protected`
 * template-method member that returns a new unfrozen copy of a fabric
 * instance. Unlike `[DEEP_FREEZE]` / `[IS_DEEP_FROZEN]`, which the generic
 * freeze utility invokes externally, this member is not part of the external
 * protocol surface — concrete subclasses implement it, and the
 * `shallowClone()` template method on `BaseFabricInstance` is its only caller
 * (Section 2.3).
 */
export const SHALLOW_UNFROZEN_CLONE = Symbol.for('data-model.shallowUnfrozenClone');

// Protocol evolution: Symbol.for('data-model.codec@2'), etc.
```

### 2.3 Instance Protocol

`FabricInstance` is the **pure abstract protocol surface** — the
`instanceof`-able contract that external code is written against. It
declares every member of the protocol as `abstract`, including
`shallowClone()`; it carries no implementations. Shared template-method
scaffolding lives on a separate abstract base class `BaseFabricInstance`
(below), which subclasses extend in practice.

The instance protocol covers in-process lifecycle only — deep freezing and
cloning. Serialization is **not** an instance concern: it lives on the
class-side `[CODEC]` (Section 2.4).

```typescript
// Shown for illustration only.
// file: packages/data-model/interface.ts

/**
 * Abstract base class for values that participate in the fabric protocol.
 * Extends `FabricSpecialObject` — the common root for all fabric-system
 * value types.
 *
 * This is the pure abstract protocol — the `instanceof`-able contract that
 * external code is written against. Concrete fabric-instance classes
 * extend `BaseFabricInstance` (a subclass of this one) rather than this
 * class directly; `BaseFabricInstance` is where shared template-method
 * scaffolding (such as `shallowClone()`) lives.
 *
 * Subclasses must implement:
 * - `[DEEP_FREEZE](subFreeze)` -- deeply freezes this instance in place.
 * - `[IS_DEEP_FROZEN](subIsDeepFrozen)` -- side-effect-free deep-frozen
 *   check, mirroring `[DEEP_FREEZE]`.
 * - `deepClone(frozen)` -- returns a new deep clone with the requested
 *   frozenness.
 * - `shallowClone(frozen)` -- returns a shallow clone with the requested
 *   frozenness. Concrete subclasses normally inherit this from
 *   `BaseFabricInstance` and instead implement `[SHALLOW_UNFROZEN_CLONE]()`
 *   (see below).
 *
 * Subclasses that participate in serialization also host a static
 * `[CODEC]` getter (the codec protocol; see Section 2.4).
 *
 * The native object wrapper classes (`FabricError`, `FabricMap`,
 * `FabricSet`) extend `BaseFabricInstance`, as do
 * user-defined types (`Cell`, `Stream`) and system types (`UnknownValue`,
 * `DataUnavailable`, `ProblematicValue`).
 *
 * Note: `FabricPrimitive` subclasses (`FabricEpochNsec`,
 * `FabricEpochDays`, `FabricHash`, `FabricBytes`, `FabricRegExp`) do NOT
 * extend this class — they extend `FabricPrimitive` instead.
 */
export abstract class FabricInstance extends FabricSpecialObject {
  /**
   * Deeply freezes this instance in place: freezes this instance's own
   * internal slot(s) and recurses into each nested `FabricValue` by calling
   * the provided `subFreeze` callback on it. Implementations must NOT call
   * `deepFreeze()` directly -- recursion is handed through the callback so
   * that the freeze utility's caching and cycle-detection bookkeeping is
   * preserved and no import cycle is introduced. Returns the (now
   * deeply-frozen) value; freeze-in-place implementations return `this`.
   * See Section 8.6.
   */
  abstract [DEEP_FREEZE](
    subFreeze: (value: FabricValue) => FabricValue,
  ): FabricValue;

  /**
   * Indicates whether this instance is already deeply frozen, without
   * mutating it. Checks this instance's own internal slot(s) are in
   * canonical deep-frozen form and recurses into each nested `FabricValue`
   * via the provided `subIsDeepFrozen` callback, returning the boolean
   * conjunction. Side-effect-free and must not throw: an instance that is
   * not in canonical deep-frozen form returns `false`. See Section 8.6.
   */
  abstract [IS_DEEP_FROZEN](
    subIsDeepFrozen: (value: FabricValue) => boolean,
  ): boolean;

  /**
   * Returns a new deep clone of this instance with equivalent data but no
   * shared structure for any unfrozen data in the original. When `frozen`
   * is `true`, produces a frozen instance with maximal structural sharing,
   * including returning `this` if it is already deep-frozen. When `frozen`
   * is `false`, produces a deeply-mutable instance with no visible shared
   * reference structure with the original.
   */
  abstract deepClone(frozen: boolean): FabricInstance;

  /**
   * Returns a shallow clone of this instance with the requested frozenness.
   * The concrete template-method implementation lives on
   * `BaseFabricInstance`; this declaration just pins the protocol surface so
   * that callers can invoke it through a `FabricInstance` reference.
   */
  abstract shallowClone(frozen: boolean): FabricInstance;
}
```

```typescript
// Shown for illustration only.
// file: packages/data-model/fabric-instances/BaseFabricInstance.ts

/**
 * Abstract base class providing shared scaffolding for `FabricInstance`
 * subclasses. Concrete `FabricInstance` classes extend this, not
 * `FabricInstance` directly: `FabricInstance` is the pure abstract protocol
 * (the `instanceof`-able contract that external code is written against),
 * while `BaseFabricInstance` is where shared template-method
 * implementations live.
 */
export abstract class BaseFabricInstance extends FabricInstance {
  /**
   * Returns a new unfrozen copy of this instance with the same data. Called
   * by `shallowClone()` when a new instance is needed.
   */
  protected abstract [SHALLOW_UNFROZEN_CLONE](): FabricInstance;

  /**
   * Returns a shallow clone of this instance with the requested frozenness.
   *
   * When `frozen` is `true` and this instance is already frozen, returns
   * `this` (identity optimization -- freezing is idempotent). In all other
   * cases, creates a new instance via `[SHALLOW_UNFROZEN_CLONE]()` and freezes
   * it if requested.
   *
   * This effectively-final template method manages the frozenness
   * contract:
   * - `shallowClone(true)` on a frozen instance returns `this` (identity).
   * - `shallowClone(true)` on an unfrozen instance returns a frozen clone.
   * - `shallowClone(false)` always returns a new unfrozen clone -- even
   *   if the instance is already unfrozen. The caller gets a distinct,
   *   mutable object.
   */
  shallowClone(frozen: boolean): FabricInstance {
    if (frozen && Object.isFrozen(this)) return this;
    const copy = this[SHALLOW_UNFROZEN_CLONE]();
    return frozen ? Object.freeze(copy) as FabricInstance : copy;
  }
}
```

> **Why an abstract class, not an interface?** The earlier spec defined
> `FabricInstance` as an interface with a single serialization method.
> The current design uses an abstract class so that `shallowClone()` can be
> an effectively-final template method (on `BaseFabricInstance`),
> encapsulating the frozenness-management contract (clone-if-necessary,
> freeze-if-requested) in one place. Concrete subclasses implement only
> `[SHALLOW_UNFROZEN_CLONE]()` (the type-specific copy logic) plus the
> deep-freeze pair; serialization lives on the class's `[CODEC]`
> (Section 2.4). Brand detection uses `instanceof FabricInstance` directly
> — no type guard function is needed (see Section 2.6).

> **Why a separate `BaseFabricInstance`?** Keeping `FabricInstance` pure
> abstract (no implementations) gives the protocol surface a clean,
> minimal definition for external consumers: the api-layer mirror in
> `packages/api/` exposes `FabricInstance` with its protocol members as
> abstract declarations, and `BaseFabricInstance` stays an internal
> implementation detail of the data-model package. External code written
> against `FabricInstance` is therefore stable against changes to the
> template-method scaffolding, and the `instanceof FabricInstance` brand
> check still catches every concrete fabric-instance value.

### 2.4 Codec Protocol

Serialization participation is class-level, not instance-level: a class
hosts a **codec** — an encoder-decoder object implementing `FabricCodec` —
as a static getter keyed by the `CODEC` symbol. The codec is the **single
source of truth** for how instances of that class are serialized; nothing
about serialization lives on the instances themselves.

```typescript
// Shown at module scope.
// file: packages/data-model/codec-common/interface.ts

/**
 * Interface for codecs (encoder-decoder objects). These are objects which
 * can extract "essential state" out of values (objects per se or otherwise)
 * and also take such "essential state" and produce values that are
 * equivalent (in a context-dependent sense) to the values that state was
 * extracted from.
 */
export interface FabricCodec {
  /**
   * The unique _direct_ class of instances, if any, that is associated with
   * the format this instance encodes. The codec system uses this to make a
   * quick determination about value compatibility before calling
   * `canEncode()` to confirm.
   */
  get uniqueHandledClass(): Constructor | undefined;

  /**
   * The unique wire format tag that is associated with the format this
   * instance decodes from, or `undefined` for a codec with no single tag.
   * When defined, the codec system uses it to mark state produced by
   * `encode()` and (by default) routes state so marked back to this
   * instance (or an equivalent) for decoding; a codec with no tag is not
   * registered for tag-based decode dispatch.
   */
  get recognizedTypeTag(): string | undefined;

  /** Returns `true` if this handler can encode the state of the given
   *  value. */
  canEncode(value: FabricValue): boolean;

  /**
   * Returns the wire type tag to use when encoding the given value. Only
   * ever called on a value for which `canEncode()` has returned `true`.
   * Unlike `recognizedTypeTag` -- the codec's single recognized tag, if it
   * has one -- this is the concrete tag for a _specific_ value; a codec
   * whose instances each carry their own per-instance tag reads it from
   * the value.
   */
  tagForValue(value: FabricValue): string;

  /**
   * Decodes a value from the given essential state, which is (alleged /
   * supposed) to be a value that was produced by an earlier call to
   * `encode()` on a compatible class to this one. The result is expected
   * to be a _shallow_ decoding. The codec system handles recursively
   * converting `state` contents as necessary.
   *
   * The given `typeTag` is what was associated with the given `state` and
   * does not necessarily correspond to `recognizedTypeTag` (depending on
   * how an instance of this class got hooked up).
   */
  decode(
    typeTag: string,
    state: FabricValue,
    context: ReconstructionContext,
  ): FabricValue;

  /**
   * Encodes the given value, returning its essential state. This is only
   * ever called after `canEncode()` has confirmed that `value` is
   * encodable by this instance. The result is expected to be a _shallow_
   * encoding. The codec system handles recursion as necessary.
   */
  encode(value: FabricValue): FabricValue;
}

/**
 * Interface for classes that provide a `FabricCodec` which is guaranteed to
 * operate on instances of the class.
 */
export interface FabricClassWithCodec {
  /** The codec instance to use for instances of this class. */
  get [CODEC](): FabricCodec;
}
```

Two helpers round out the vocabulary:

- **`BaseFabricCodec`** (`codec-common/BaseFabricCodec.ts`) supplies the
  common scaffolding: a constructor taking `(recognizedTypeTag,
  uniqueHandledClass)`, an `instanceof`-based `canEncode()`, and a
  `tagForValue()` that returns `recognizedTypeTag` (a codec with no
  recognized tag — whose instances carry per-instance tags — must
  override it). Concrete codecs extend it and implement `encode()` /
  `decode()`.
- **`codecOf(value)`** (`codec-common/codecOf.ts`) returns the `[CODEC]`
  of a value's class, throwing a "shouldn't happen" error if the class has
  none. The hashing system (Section 6) and other instance-state walkers
  use it.

Key contracts:

- **Codecs are shallow.** `encode()` returns one layer of essential state
  without recursing into nested values; `decode()` receives state whose
  nested values have already been decoded. The serialization context owns
  recursion and tag-wrapping (Section 4.5) — under the earlier
  type-handler design each handler did both itself, which smeared the
  format mechanics across every handler.
- **`decode()` is codec-side, not constructor-side**, for the same two
  reasons the earlier design used a separate static method: it receives a
  `ReconstructionContext` (Section 2.5) which shouldn't be mandated in a
  constructor signature, and it may return an existing instance
  (interning) rather than creating a new one — essential for types like
  `Cell` where identity matters.
- **`recognizedTypeTag` vs. `decode()`'s `typeTag` parameter.** The former
  is the single tag a codec is *registered* under; the latter is whatever
  tag the value *actually carried* on the wire. They usually agree, but
  the distinction is deliberate: a registry can route a legacy or
  alternate tag to an equivalent codec (a decode-only hookup), which is
  the affordance for legacy-data migration/import. The canonical tag
  constants (`CODEC_TYPE_TAGS`, `codec-common/codec-type-tags.ts`)
  reserve a section for exactly such decode-only "non-primary versions"
  of classes (e.g., a future `Map@2` decoding into the same class as
  `Map@1`).
- **The wire surface is explicit and curated.** Which classes participate
  in serialization is determined by curated `codecClasses()` lists (one
  each in `fabric-primitives/` and `fabric-instances/`), not by ad-hoc
  registration scattered across the codebase. See Section 4.5.

### 2.5 Reconstruction Context

```typescript
// Shown at module scope.
// file: packages/data-model/codec-common/interface.ts

/**
 * The minimal interface that codec `decode()` implementations may depend
 * on. In practice this is provided by the `Runtime` class from
 * `packages/runner/src/runtime.ts`, but defining it as an interface here
 * avoids a circular dependency between the fabric protocol and the runner.
 *
 * Implementors of `decode()` should depend on this interface, not on
 * the concrete `Runtime` class.
 */
export interface ReconstructionContext {
  /**
   * Resolves a cell reference. Used by types that need to intern or look
   * up existing instances during reconstruction.
   */
  getCell(ref: { id: string; path: string[]; space: string }): FabricInstance;

  /**
   * Output-contract directive: when `true`, every codec `decode()`
   * implementation that consults this context must produce a deep-frozen
   * result; when `false`, a mutable result is acceptable. Same contract as
   * the `frozen` argument to `cloneIfNecessary()` (see
   * `packages/data-model/value-clone.ts`): `shouldDeepFreeze === true`
   * corresponds to `cloneIfNecessary(value, { frozen: true })`.
   *
   * Required (not optional): every context declares it. A shared
   * `BaseReconstructionContext`
   * (`packages/data-model/codec-common/BaseReconstructionContext.ts`)
   * centralizes the getter with a `true` default, mirroring
   * `cloneIfNecessary()`'s default; contexts opt out by overriding. An
   * `EmptyReconstructionContext` (same directory) covers context-less
   * decodes: its `getCell()` throws with a configurable message.
   */
  readonly shouldDeepFreeze: boolean;
}
```

> **Why an interface, not the concrete `Runtime`?** The fabric protocol is
> intended to live in a foundational package (`packages/data-model/`).
> If codec `decode()` implementations depended on the full `Runtime` type
> from `packages/runner/`, it would create a circular dependency. The
> `ReconstructionContext` interface captures the minimal surface needed for
> reconstruction. The `Runtime` class satisfies this interface. Future
> fabric types may extend `ReconstructionContext` if they need additional
> capabilities beyond `getCell` and `shouldDeepFreeze`.

### 2.6 Brand Detection

Because `FabricInstance` is an abstract class, the idiomatic brand check is
`instanceof`:

```typescript
// Shown at module scope.
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
// Shown for illustration only.
// Illustrative example -- not from the codebase.

import {
  type FabricValue,
} from '@commonfabric/data-model/interface';
import {
  CODEC,
  BaseFabricCodec,
  type FabricCodec,
  type ReconstructionContext,
} from '@commonfabric/data-model/codec-common';
import { BaseFabricInstance } from '@commonfabric/data-model/fabric-instances';

type TemperatureUnit = "C" | "F" | "K";

class Temperature extends BaseFabricInstance {
  // (deepFreeze protocol members
  //  omitted for brevity; see §2.3
  //  and §8 for the full pattern.)

  constructor(
    readonly value: number,
    readonly unit: TemperatureUnit,
  ) {
    super();
  }

  protected [SHALLOW_UNFROZEN_CLONE](): Temperature {
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

  /** The codec singleton: the source of truth for serialization. */
  static #codec = Object.freeze(
    new (class TemperatureCodec extends BaseFabricCodec {
      constructor() {
        super('Temperature@1', Temperature);
      }

      /** Extract essential state (shallow). */
      encode(value: Temperature): FabricValue {
        return { value: value.value, unit: value.unit };
      }

      /** Produce an instance from essential state (shallow). */
      decode(
        _typeTag: string,
        state: FabricValue,
        _context: ReconstructionContext,
      ): FabricValue {
        const s = state as { value: number; unit: TemperatureUnit };
        return new Temperature(s.value, s.unit);
      }
    })(),
  );

  /** The codec for instances of this class. */
  static get [CODEC](): FabricCodec {
    return this.#codec;
  }
}
```

> **Runtime validation in `decode()`.** The `TemperatureCodec.decode()`
> example above uses `state as { value: number; unit: TemperatureUnit }` — a
> bare type cast with no runtime validation. This is acceptable in a short
> illustrative example, but **production `decode()` implementations must
> validate the shape of `state` at runtime** before using it. The `state`
> parameter has been through serialization and deserialization; it may not
> conform to the expected TypeScript type. See Section 7.4 for the full
> rationale.

**Why the protocol matters.** Without the codec protocol, the serialization
system would see a `Temperature` as an opaque object and either reject it or
flatten it into `{ value: 100, unit: "C" }`. With the protocol, the
serialization system:

1. Finds the class's codec (via the registry; Section 4.5) and calls
   `codec.encode(value)` to extract the essential state.
2. Serializes that state (recursively handling any nested `FabricValue`s)
   and wraps it with the tag from `codec.tagForValue(value)`.
3. On deserialization, routes the tag back to the codec and calls
   `codec.decode(tag, state, context)` to produce a real `Temperature`
   instance with its methods intact.

**Reference types and `ReconstructionContext`.** The `Temperature` example
above is a simple value type -- its codec's `decode()` creates a fresh
instance each time. Reference types (such as the runtime's internal `Cell`
type) use the `ReconstructionContext` parameter to look up or intern
existing instances, ensuring that two references to the same logical entity
deserialize to the same object.

### 2.8 Encoded State and Recursion

The value returned by a codec's `encode()` can contain any value that is
itself a `FabricValue` — including other `FabricInstance`s (such as native
object wrappers), primitives, and plain objects/arrays.

**The serialization system handles recursion, not the individual codecs.**
An `encode()` implementation returns one shallow layer of essential state
without recursively encoding nested values. The codec does not have access
to the serialization machinery — by design, as it would be a layering
violation.

Similarly, `decode()` receives state where nested values have already been
decoded by the serialization system. Importantly, `decode()` returns the
**wrapper type**, not the raw native type. For example, the `FabricError`
codec produces a `FabricError` instance, not a raw `Error`. Unwrapping to
native types is a separate step via `nativeFromFabricValue()` (Section 8).

### 2.9 Reconstruction Guarantees

The system follows an **immutable-forward** design:

- **Plain objects and arrays** are frozen (`Object.freeze()`) upon
  reconstruction. This applies to all deserialization output paths, including
  `/quote` (Section 6 of `3-json-encoding.md`) — the freeze is a property of the deserialization
  boundary, not of whether type-tag reconstruction occurred.
- **`FabricInstance`s** should ideally be frozen as well — this is the north
  star, though not yet a strict requirement.
- **No distinction** is made between regular and null-prototype plain objects;
  reconstruction always produces regular plain objects.

This immutability guarantee enables safe sharing of reconstructed values and
aligns with the reactive system's assumption that values don't mutate in place.

> **Immutability of native object wrappers.** Under the three-layer
> architecture, deserialization produces `FabricInstance` wrappers
> (`FabricMap`, `FabricSet`, etc.), not raw native types. Because the
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
// Shown at module scope.
// file: packages/data-model/fabric-instances/ExplicitTagValue.ts

/**
 * Base class for fabric types that carry an explicit wire-format tag.
 * Used by `UnknownValue` (unrecognized types) and `ProblematicValue`
 * (failed deconstruction/reconstruction). Enables a single `instanceof`
 * check where code needs to handle both.
 *
 * Extends `BaseFabricInstance` so subclasses inherit the `shallowClone()`
 * template method.
 */
export abstract class ExplicitTagValue extends BaseFabricInstance {
  /** The value of `wireTypeTag`. */
  readonly #wireTypeTag;

  /** The value of `state`. */
  readonly #state;

  constructor(
    /** The original wire type tag, e.g. `"FutureType@2"`. */
    wireTypeTag: string,
    /** The raw state. */
    state: FabricValue,
  ) {
    super();

    this.#wireTypeTag = wireTypeTag;
    this.#state = state;
  }

  /** Arbitrary raw instance state. */
  get state(): FabricValue {
    return this.#state;
  }

  /**
   * The wire type tag preserved for this instance. Unlike other fabric
   * types -- whose tag is a per-class constant carried by the class's
   * `[CODEC]` -- an `ExplicitTagValue` carries a per-instance tag (the
   * original tag of a value that couldn't be recognized or reconstructed),
   * which its codec's `tagForValue()` reads back.
   */
  get wireTypeTag(): string {
    return this.#wireTypeTag;
  }
}
```

Each subclass hosts its own `[CODEC]`. These codecs are deliberate
"snowflakes": they declare **no `recognizedTypeTag`** (their instances each
carry a per-instance tag, which `tagForValue()` reads back), so they are
not registered for tag-based decode dispatch — an unrecognized tag reaches
them through the encoding context's unknown-tag arm instead (Section 4.5).
Their `encode()` returns the preserved **bare `state`** (not an envelope),
so a snowflake round-trips to the *same* storage form as the value it
stands in for.

### 3.3 `UnknownValue`

```typescript
// Shown for illustration only.
// file: packages/data-model/fabric-instances/UnknownValue.ts

import { DEEP_FREEZE, type FabricValue, IS_DEEP_FROZEN } from '../interface';
import {
  CODEC,
  type FabricCodec,
  type ReconstructionContext,
} from '../codec-common/interface';
import { BaseFabricCodec } from '../codec-common/BaseFabricCodec';
import { ExplicitTagValue } from './ExplicitTagValue';
import { deepFreeze } from '../deep-freeze';

/**
 * Container for an unrecognized type's data, used for round-tripping. When
 * the serialization system encounters an unknown tag during
 * deserialization, it wraps the tag and state here; on re-serialization,
 * it uses the preserved data to produce the original wire format.
 */
export class UnknownValue extends ExplicitTagValue {
  constructor(wireTypeTag: string, state: FabricValue) {
    super(wireTypeTag, state);
  }

  // ([DEEP_FREEZE] / [IS_DEEP_FROZEN] freeze `this` and recurse into
  // `state`; `[SHALLOW_UNFROZEN_CLONE]()` copies the two fields. Omitted for
  // brevity; see §2.3 and §8.6 for the pattern.)

  static #codec = Object.freeze(
    new (class UnknownValueCodec extends BaseFabricCodec {
      constructor() {
        // No recognized wire tag: an `UnknownValue` round-trips to its
        // *preserved* tag, which varies per instance.
        super(undefined, UnknownValue);
      }

      /** The instance's preserved per-instance tag. */
      override tagForValue(value: UnknownValue): string {
        return value.wireTypeTag;
      }

      /** The preserved bare state -- NOT an envelope. */
      encode(value: UnknownValue): FabricValue {
        return value.state;
      }

      decode(
        typeTag: string,
        state: FabricValue,
        context: ReconstructionContext,
      ): FabricValue {
        const result = new UnknownValue(typeTag, state);
        return context.shouldDeepFreeze ? deepFreeze(result) : result;
      }
    })(),
  );

  /** The codec for instances of this class. */
  static get [CODEC](): FabricCodec {
    return this.#codec;
  }
}
```

### 3.4 Behavior

- When the serialization system encounters an unknown type tag during
  deserialization, it constructs an `UnknownValue` directly from the
  original tag and (already-decoded) state. (The unknown-tag arm is the
  one decode path that does not route through a registered codec — there
  is, by definition, none to route to.)
- When re-serializing an `UnknownValue`, its codec's `tagForValue()` reads
  back the preserved tag and `encode()` returns the preserved bare state,
  reproducing the original wire format byte-for-byte.
- This allows data to round-trip through systems that don't understand it.

### 3.5 `ProblematicValue` (Recommended)

It is recommended that implementations provide a `ProblematicValue` type,
analogous to `UnknownValue`, for cases where encoding or decoding fails
partway through. This allows graceful degradation rather than hard
failures — for example, a type whose codec `decode()` throws can be
preserved as a `ProblematicValue` with the original tag, state, and error
information.

```typescript
// Shown for illustration only.
// file: packages/data-model/fabric-instances/ProblematicValue.ts

import { DEEP_FREEZE, type FabricValue, IS_DEEP_FROZEN } from '../interface';
import {
  CODEC,
  type FabricCodec,
  type ReconstructionContext,
} from '../codec-common/interface';
import { BaseFabricCodec } from '../codec-common/BaseFabricCodec';
import { ExplicitTagValue } from './ExplicitTagValue';
import { deepFreeze } from '../deep-freeze';

/**
 * Container for a value whose deconstruction or reconstruction failed.
 * Preserves the original tag and raw state for round-tripping and
 * debugging. Used in lenient mode to allow graceful degradation rather
 * than hard failures.
 */
export class ProblematicValue extends ExplicitTagValue {
  /** Value for `error`. */
  readonly #error;

  constructor(
    wireTypeTag: string,
    state: FabricValue,
    /** Description of what went wrong. */
    error: string,
  ) {
    super(wireTypeTag, state);

    this.#error = error;
  }

  /** Description of what went wrong. */
  get error(): string {
    return this.#error;
  }

  // ([DEEP_FREEZE] / [IS_DEEP_FROZEN] freeze `this` and recurse into
  // `state`; `[SHALLOW_UNFROZEN_CLONE]()` copies the three fields. Omitted
  // for brevity; see §2.3 and §8.6 for the pattern.)

  static #codec = Object.freeze(
    new (class ProblematicValueCodec extends BaseFabricCodec {
      constructor() {
        // No recognized wire tag: a `ProblematicValue` round-trips to its
        // *preserved* tag, which varies per instance.
        super(undefined, ProblematicValue);
      }

      /** The instance's preserved per-instance tag. */
      override tagForValue(value: ProblematicValue): string {
        return value.wireTypeTag;
      }

      /** The preserved bare state -- `error` is NOT serialized. */
      encode(value: ProblematicValue): FabricValue {
        return value.state;
      }

      decode(
        typeTag: string,
        state: FabricValue,
        context: ReconstructionContext,
      ): FabricValue {
        const result = new ProblematicValue(typeTag, state, '');
        return context.shouldDeepFreeze ? deepFreeze(result) : result;
      }
    })(),
  );

  /** The codec for instances of this class. */
  static get [CODEC](): FabricCodec {
    return this.#codec;
  }
}
```

Like `UnknownValue`, a `ProblematicValue` round-trips through
serialization, preserving the original data so it is not silently lost.
Note that the `error` field is **runtime-only, deliberately not
serialized**: the codec's `encode()` re-emits the preserved bare state
under the preserved tag, so the wire form is identical to that of the
value the `ProblematicValue` stands in for (and a later decode under a
then-recognized tag can recover the real value). The `error` field aids
in-process debugging by recording what went wrong; the failure-construction
paths (e.g., lenient mode) populate it. Whether to wrap failures in
`ProblematicValue` or to throw is an implementation decision that may vary
by context — strict contexts (e.g., tests) may prefer to throw, while
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
// file: packages/data-model/codec-json/interface.ts

/**
 * JSON-compatible wire format value. This is the intermediate tree
 * representation used during serialization tree walking -- NOT the final
 * serialized form (which is `string`). Internal to the JSON implementation.
 *
 * Deep-frozen invariant on the deserialize side: every wire tree that
 * enters deserialization is deep-frozen, enforced at the two construction
 * sites that feed it (`decode()` and `fromBytes()`, unified in
 * `#parseWireText()`). This is what lets the tag-unwrap and `/quote` arms
 * hand back extracted sub-trees directly without further copying. The
 * serialize-side wire trees are transient (`JSON.stringify`-ed and
 * discarded) and are not covered by this invariant. The `readonly` on the
 * array and object arms of the union expresses the deserialize-side
 * contract at the type level. See Section 8.6.
 */
export type JsonWireValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonWireValue[]
  | { readonly [key: string]: JsonWireValue };
```

### 4.3 Public Boundary Interface

The public interface for serialization contexts is parameterized by the
boundary type — `string` for JSON contexts, `Uint8Array` for binary contexts.
External callers use only `encode()` and `decode()`; all internal machinery
(tag wrapping, tree walking, codec dispatch) is private to the context
implementation.

```typescript
// Shown at module scope.
// file: packages/data-model/codec-common/interface.ts

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

  /** Encodes a fabric value into serialized form for boundary crossing. */
  encode(value: FabricValue): SerializedForm;

  /** Decodes a serialized form back into a fabric value. */
  decode(
    data: SerializedForm,
    context: ReconstructionContext,
  ): FabricValue;
}
```

The JSON encoding context implements `SerializationContext<string>`:

- `encode(value)` serializes a `FabricValue` into the `/<Type>@<Version>`
  tagged wire format, then stringifies the result.
- `decode(data, context)` parses a JSON string, then deserializes tagged
  forms back into modern runtime types.

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
Decode:  serialized form -> context.decode(data, context) -> FabricValue
```

Internally, the JSON encoding context's `encode()` method calls a private
encode walker (`#encodeValue()`) to walk the `FabricValue` tree and produce
a `JsonWireValue` tree, then stringifies it. The `decode()` method parses
the JSON string, then calls a private decode walker (`#decodeValue()`) to
walk the `JsonWireValue` tree and reconstruct modern runtime types. The
recursive descent and codec dispatch are entirely internal to the context.

### 4.5 Codecs, the Registry, and Internal Tree Walking

The serialization and deserialization logic is implemented as private
methods on `JsonEncodingContext`. The context dispatches per-type logic to
the **codecs** (Section 2.4) held in a **`CodecRegistry`** — the JSON
context's index of which codec handles which class (for encoding) and
which tag (for decoding). Codecs are shallow: the context owns recursion
and tag-wrapping, and each codec translates exactly one layer.

```typescript
// Shown for illustration only.
// file: packages/data-model/codec-json/CodecRegistry.ts

/**
 * Sentinel returned by `CodecRegistry.codecFromValue()` for a
 * self-representing value -- one that is its own wire form (encoded as-is,
 * with no codec and no tag).
 */
export const SELF_REP = 'self-rep' as const;

/**
 * Registry of `FabricCodec`s. Provides tag-based lookup for decoding, and
 * primitive-type and class matching for encoding.
 */
export class CodecRegistry {
  /**
   * Registers a codec, indexing it by its `recognizedTypeTag` (for decode)
   * and its `uniqueHandledClass` (for encode dispatch). Either may be
   * `undefined`, in which case the codec is left unindexed for the
   * corresponding lookup.
   */
  register(codec: FabricCodec): void;

  /**
   * Registers a codec for a primitive `type` (a `typeof` result, or
   * `"null"`). Indexes the codec by its `recognizedTypeTag` (for decode)
   * and by `type` (for O(1) encode dispatch on primitives).
   */
  registerPrimitive(type: PrimitiveTypeName, codec: FabricCodec): void;

  /**
   * Registers a primitive `type` as self-representing: a value of that
   * type is its own wire form, so `codecFromValue()` returns `SELF_REP`
   * for it. A type may be both self-representing and have a
   * `registerPrimitive()` codec (e.g. `"number"`); the codec is tried
   * first.
   */
  registerSelfRep(type: PrimitiveTypeName): void;

  /**
   * Finds how to encode the given value: a `FabricCodec` that can encode
   * it, `SELF_REP` if it is a self-representing primitive, or `undefined`
   * if neither matches (the caller falls through to structural handling
   * for arrays and plain objects, or fails for an unencodable value).
   */
  codecFromValue(
    value: FabricValue,
  ): FabricCodec | typeof SELF_REP | undefined;

  /** Looks up a codec by tag for decoding. */
  codecFromTag(typeTag: string): FabricCodec | undefined;
}
```

Encode dispatch is O(1) on both paths — there is no linear scan over
registered codecs:

1. **Primitive** — `switch (typeof value)` (with `"null"` for `null`)
   selects a primitive `type` key; the type's registered codec is tried
   first (via `canEncode()`), then self-representation.
2. **Object** — a class map keyed by the value's exact constructor.

#### The default registry

`createDefaultRegistry()` (`codec-json/createDefaultRegistry.ts`) builds
the registry the shared JSON context uses. The wire-format surface is
**explicit and curated**: fabric classes whose instances have a fixed wire
tag supply their codec via the static `[CODEC]`, and the curated
`codecClasses()` list from each of `fabric-primitives/` and
`fabric-instances/` is the source of truth for which classes participate —
the wire surface is curated there, in one obvious place per area, rather
than implied by scattered registrations.

| Registration | Codec / type | Tag | Notes |
|--------------|--------------|-----|-------|
| `register(cls[CODEC])` | `FabricBytes` | `Bytes@1` | Via `fabric-primitives` `codecClasses()`. |
| 〃 | `FabricHash` | `Hash@1` | 〃 |
| 〃 | `FabricEpochNsec` | `EpochNsec@1` | 〃 |
| 〃 | `FabricEpochDays` | `EpochDays@1` | 〃 |
| 〃 | `FabricRegExp` | `RegExp@1` | 〃 |
| 〃 | `DataUnavailable` | `DataUnavailable@1` | Via `fabric-instances` `codecClasses()`; reason-discriminated runtime control value (Section 1.7). |
| 〃 | `FabricError` | `Error@1` | Via `fabric-instances` `codecClasses()`. |
| 〃 | `FabricMap` | `Map@1` | 〃 (implementation currently stubbed; see Section 1.4.3). |
| 〃 | `FabricSet` | `Set@1` | 〃 (implementation currently stubbed; see Section 1.4.4). |
| 〃 | `UnknownValue` | _(per-instance)_ | No `recognizedTypeTag`; `tagForValue()` reads the preserved tag (Section 3). |
| 〃 | `ProblematicValue` | _(per-instance)_ | 〃 |
| `registerPrimitive` | `BigIntCodec` (`bigint`) | `BigInt@1` | Encodes as unpadded base64 of minimal two's complement big-endian bytes. Standalone codec in `codec-common/` — no owned class to host a `[CODEC]`. |
| 〃 | `SpecialNumberCodec` (`number`) | `SpecialNumber@1` | Catches `-0` / `NaN` / `±Infinity`; finite numbers fall to self-representation. |
| 〃 | `SymbolCodec` (`symbol`) | `Symbol@1` | Registry-interned symbols only; an uninterned symbol matches no codec and is correctly unencodable. |
| 〃 | `UndefinedCodec` (`undefined`) | `Undefined@1` | Stateless; state is `null`. |
| `registerSelfRep` | `null`, `boolean`, `number`, `string` | _(none)_ | Self-representing: emitted as-is. `number` is registered both ways; the codec is tried first. |

The canonical tag strings live in `CODEC_TYPE_TAGS`
(`codec-common/codec-type-tags.ts`); the structural meta tags (`quote`,
`hole`, `object`) live in `CODEC_META_TAGS`
(`codec-common/codec-meta-tags.ts`).

An un-codec'd `FabricSpecialObject` reaching the encoder is a **hard
error** — every wire form is explicitly represented; there is no implicit
fallback for fabric classes. Arrays and plain objects (the structural
types) are handled by the walker itself after no codec matches.

#### Private encode walker (`#encodeValue()`)

The context's private encode walker processes the `FabricValue` tree:

1. **Codec dispatch** — `codecFromValue()` finds how to encode the value.
   A `SELF_REP` result means the value is its own wire form (emitted
   as-is). A codec result drives the standard tagged encoding: the walker
   reads the tag via `codec.tagForValue(value)`, gets one shallow layer of
   state via `codec.encode(value)`, **recursively encodes that state
   itself**, and wraps the result as `{ "/<tag>": state }`. (The walker
   uses `tagForValue()` rather than any property of the value, because it
   is up to the codec — not the value — to determine the correct tag.)
2. **Mandate guard** — a `FabricSpecialObject` that no codec matched is a
   hard error: every fabric class's wire form must be explicitly
   represented by a registered codec.
3. **Arrays** — serialized element-by-element; sparse arrays use
   run-length encoded `hole` entries (Section 1.5).
4. **Plain objects** — serialized key-by-key, iterating keys in UTF-8 byte
   order (matching the canonical key order used by hashing; see Section 10
   of `3-json-encoding.md`), making the encoding deterministic across
   insertion orders; `/object` / `/quote` escaping applied per Section 6
   of `3-json-encoding.md`.

Circular references are detected via a `Set<object>` tracked during the walk.

#### Private decode walker (`#decodeValue()`)

The context's private decode walker processes the `JsonWireValue` tree:

1. **Tag unwrapping** — checks for single-key objects with `/`-prefixed
   keys.
2. **Structural escapes** — handles `/quote` (literal pass-through) and
   `/object` (entry-by-entry decode), per Section 6 of
   `3-json-encoding.md`.
3. **State decode + bare-`/` check** — for any other tag, the walker first
   recursively decodes the wrapped state, then rejects an empty tag (a
   bare `"/"` key) as an encoding error, producing a `ProblematicValue`
   (Section 3.5; see also Section 9 of `3-json-encoding.md`).
4. **Codec dispatch** — `codecFromTag()` routes the tag to its registered
   codec's `decode()`. When the context is in lenient mode, codec
   exceptions produce `ProblematicValue`. Values returned from this arm
   are guaranteed deep-frozen at the walker boundary (the contract holds
   for both the codec-produced value and the lenient-mode
   `ProblematicValue`), so callers need not each freeze. This contract is
   scoped to this arm only; the unknown-tag arm (step 5) is intentionally
   not covered. See Section 8.6 for the full deep-freeze protocol and the
   egress-freezing call sites.
5. **Unknown tags** — a tag with no registered codec produces an
   `UnknownValue` wrapping the tag and (already-decoded) state, preserving
   the form for round-tripping (Section 3).
6. **Primitives** — pass through.
7. **Arrays** — recursively deserialized; `hole` entries reconstructed as
   true holes (absent indices).
8. **Plain objects** — recursively deserialized; output frozen. Any
   `/`-prefixed key in a plain (non-single-key-tagged) object is reserved:
   the walker produces a `ProblematicValue` rather than silently
   round-tripping it (Section 9 of `3-json-encoding.md`).

> **Previous design: type handlers + class registry.** The earlier design
> dispatched per-type logic to `TypeHandler` objects (which did their own
> tag-wrapping *and* recursion) plus a separate tag→class registry for the
> wrapper classes, with a generic `FabricInstanceHandler` covering
> everything else; tag resolution checked a `wireTypeTag` property on each
> instance. That made the wire-serializable surface implicit and smeared
> the format mechanics across every handler. The codec model replaces all
> of it: codecs are shallow (the context owns recursion and tag-wrapping),
> the surface is explicit and curated, the class registry is retired
> (concrete types decode through their own codecs; unknown tags fall
> straight to `UnknownValue`), and per-instance `wireTypeTag` survives
> only on the `ExplicitTagValue` family, read back via `tagForValue()`.

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
| **Background service** | `shell` <-> `background-piece-service` | worker messages |
| **HTML reconciler** | `html` reconciler (runs in a web worker) | worker messages |
| **Network sync** | `toolshed` <-> remote peers | WebSocket/HTTP |
| **Cross-space** | space A <-> space B | if in separate processes |

Each boundary uses a serialization context appropriate to its format and
version requirements.

> **Note:** The `html` package reconciler (`html/src/worker/reconciler.ts`)
> calls `convertCellsToLinks` in a web worker context. Threading serialization
> options to this call site requires worker-initialization-time configuration,
> since the reconciler does not have direct access to a `Runtime` instance.

### 4.8 JSON Encoding

The storage boundary routes through functions that bridge between the
storage layer (JSON strings) and the runtime layer (`FabricValue`). These
functions live in a dedicated module
(`packages/data-model/codec-json/json-encoding.ts`).

```typescript
// Shown for illustration only.
// file: packages/data-model/codec-json/json-encoding.ts

/**
 * Encodes a fabric value to a JSON string in the standard `FabricValue`
 * JSON-embedded encoding, prefixed with the format-identifying tag
 * `fvj1:`.
 */
export function jsonFromValue(value: FabricValue): string;

/**
 * Decodes a string in the `FabricValue` JSON-embedded encoding format. If
 * `context` is omitted, a shared decode-framed empty context is
 * substituted, which throws if any reconstruction is needed.
 */
export function valueFromJson(
  json: string,
  context?: ReconstructionContext,
): FabricValue;

/**
 * Like `valueFromJson()`, except the decoded result is expected to be a
 * plain object. Throws if it turns out to be something else.
 */
export function plainObjectFromJson<T extends object = object>(
  json: string,
  context?: ReconstructionContext,
): T;

/**
 * Indicates if the given text has a "first-blush" appearance as valid
 * encoded JSON as defined by this module (i.e., carries the `fvj1:`
 * prefix).
 */
export function seemsLikeJsonEncodedFabricValue(value: string): boolean;
```

The module creates a single stateless `JsonEncodingContext` instance at
module load time and reuses it for all encode/decode operations.

The `memory` package wraps these at its serialization boundary
(`packages/memory/v2.ts`):

- **Write path:** `encodeMemoryBoundary(value)` calls `jsonFromValue(value)`.
- **Read path:** `decodeMemoryBoundary(source)` calls
  `valueFromJson(source, context)` with a memory `ReconstructionContext`.

### 4.9 Fabric Value Conversion

The native-to-fabric-value boundary is managed by
`packages/data-model/native-conversion.ts`. This module provides
`fabricFromNativeValue()` / `nativeFromFabricValue()` functions that bridge
the left layer (JS wild west) and the middle layer (`FabricValue`) at the
`Cell` read/write boundary.

The module also provides a shallow conversion function
(`shallowFabricFromNativeValue()`) and a type-check function
(`isFabricCompatible()`). The public surface is re-exported from
`fabric-value.ts`, which also defines the comparison function `valueEqual()`.

```typescript
// Shown for illustration only.
// file: packages/data-model/native-conversion.ts

/**
 * Convert a native JS value to fabric form (deep, recursive). Wraps native
 * types into fabric wrappers (Section 8.2). When `freeze` is `true` (the
 * default), the result tree is deep-frozen; when `false`, wrapping and
 * validation still occur but the result is left mutable. An input that is
 * already a deep-frozen `FabricValue` is returned as-is (identity
 * optimization).
 */
export function fabricFromNativeValue(
  value: unknown,
  freeze = true,
): FabricValue;

/**
 * Convert a fabric value back to native form, unwrapping fabric wrappers
 * back to native JS types (Section 8.4).
 */
export function nativeFromFabricValue(
  value: FabricValue,
  frozen?: boolean,
): FabricValue;
```

In the `Cell` implementation:

- **Read path:** `Cell.getRaw()` calls `nativeFromFabricValue(value)` to
  unwrap fabric wrappers before returning values to the JS wild west.
- **Write path:** `Cell.setRaw()` calls `fabricFromNativeValue(value)` to
  wrap native types into fabric form before storing.

#### Module structure

The implementation is split across several files for separation of concerns:

| File | Purpose |
|------|---------|
| `fabric-value.ts` | Public surface: re-exports the conversion functions (from `native-conversion.ts`), the type declarations (from `interface.ts`), and the clone helpers (from `value-clone.ts`); defines `valueEqual()` |
| `native-conversion.ts` | Conversion: `fabricFromNativeValue`, `shallowFabricFromNativeValue`, `nativeFromFabricValue`, `isFabricCompatible` |
| `fabric-instances/` | `FabricInstance` subclasses, each in its own file: `BaseFabricInstance.ts`, `FabricNativeWrapper.ts`, `FabricError.ts`, `FabricMap.ts`, `FabricSet.ts`, `ExplicitTagValue.ts`, `UnknownValue.ts`, `ProblematicValue.ts` (plus an `index.ts` barrel). |
| `fabric-primitives/` | `FabricPrimitive` subclasses, each in its own file: `BaseFabricPrimitive.ts`, `FabricBytes.ts`, `FabricHash.ts`, `FabricEpochNsec.ts`, `FabricEpochDays.ts`, `FabricRegExp.ts` (plus an `index.ts` barrel). |

---

## 5. JSON Encoding for Special Types

The JSON encoding for fabric values — the `/<Type>@<Version>` wire format,
type encodings, escaping mechanisms, and the `/`-key reservation rule — is
specified in a dedicated document:

**See [`3-json-encoding.md`](./3-json-encoding.md)**

---

## 6. Hashing

### 6.1 Overview

The system uses hashing for content-based identity. The hashing scheme
operates directly on the natural data structure without intermediate tree
construction.

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

The following single-byte type tags are used by the hash byte format and are
recommended for any binary encoding of `FabricValue`s. They are
organized into four categories by high nibble:

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

| Tag               | Hex    | Decimal | Used for                          |
|:------------------|:-------|:--------|:----------------------------------|
| `TAG_NULL`        | `0x20` | 32      | `null`                            |
| `TAG_UNDEFINED`   | `0x21` | 33      | `undefined`                       |
| `TAG_BOOLEAN`     | `0x22` | 34      | `boolean`                         |
| `TAG_NUMBER`      | `0x23` | 35      | `number` (any IEEE 754 binary64)  |
| `TAG_STRING`      | `0x24` | 36      | `string` (direct form)            |
| `TAG_BYTES`       | `0x25` | 37      | `FabricBytes`                     |
| `TAG_BIGINT`      | `0x26` | 38      | `bigint`                          |
| `TAG_EPOCH_NSEC`  | `0x27` | 39      | `FabricEpochNsec`                 |
| `TAG_EPOCH_DAYS`  | `0x28` | 40      | `FabricEpochDays`                 |
| `TAG_HASH`        | `0x29` | 41      | `FabricHash`                      |
| `TAG_SYMBOL`      | `0x2A` | 42      | `symbol` (registry-interned only) |
| `TAG_REGEXP`      | `0x2B` | 43      | `FabricRegExp`                    |

**Optimized tags (`0xFN`)** — hash-level substitutes that replace the raw
payload of a primitive type with a digest, when doing so shortens the byte
stream fed to the outer hasher:

| Tag                | Hex    | Decimal | Used for                                 |
|:-------------------|:-------|:--------|:-----------------------------------------|
| `TAG_STRING_HASH`  | `0xF0` | 240     | `string` (hashed form; see byte-format spec §4.4) |

All unassigned values are reserved for future use. The category structure
(meta/compound/primitive/optimized) is a convention for readability and is not
enforced by the encoding — a decoder should handle any tag byte it encounters
regardless of nibble range.

> **Scope.** These tag bytes are defined here for use by any wire format that
> needs to distinguish `FabricValue` types at the byte level. The hash byte
> format (`2-hash-byte-format.md`) is the first consumer; future binary
> serialization formats may reuse the same tag assignments.

### 6.4 Hashing Algorithm

```typescript
// Shown for illustration only.
// file: packages/data-model/value-hash.ts

/**
 * Compute a hash for a fabric value. The hash is encoding-independent:
 * the same identity whether later serialized to JSON, CBOR, or any
 * other format.
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
 * Section 3 of `3-json-encoding.md`).
 *
 * Two public entry points are provided:
 * - `hashOf(value)` — returns a `FabricHash`.
 * - `hashStringOf(value)` — returns a plain `string` (the hash
 *   as base64url, without the algorithm tag). This avoids `FabricHash`
 *   allocation when only the string form is needed.
 *
 * Both functions cache results: constants for `null`, `undefined`,
 * `true`, `false`; an LRU cache for primitives (`string`, `number`,
 * `bigint`); and a WeakMap for deep-frozen objects.
 *
 * Native `Date`, `RegExp`, and `Uint8Array` values are handled via
 * on-the-fly conversion to their fabric equivalents
 * (`shallowFabricFromNativeValue`), then hashed in their converted
 * form.
 */
export function hashOf(value: unknown): FabricHash {
  // Type tag bytes — see Section 6.3 for the full table.
  // Tag categories: meta (0x0N), compound (0x1N), primitive (0x2N),
  // optimized (0xFN).
  //
  // Implementation feeds type-tagged data into the hasher.
  // Byte-length prefixes for raw payloads use unsigned LEB128.
  // Compound types (array, object) use TAG_END instead of a count prefix.
  //
  // Strings use two forms based on UTF-8 byte length (threshold is 64
  // bytes; see byte-format spec §4.4). The helper `hashStr(s)` emits:
  //   - direct form (utf8ByteLen <= 64):
  //       hash(TAG_STRING, leb128(utf8ByteLen), utf8Bytes)
  //   - hashed form (utf8ByteLen > 64):
  //       hash(TAG_STRING_HASH, sha256(utf8Bytes))
  // The `hashStr` abstraction is used wherever the algorithm emits a
  // complete tagged string — including object keys, FabricInstance type
  // tags, and FabricHash algorithm tags.
  //
  // - `null`:              hash(TAG_NULL)
  // - `boolean`:           hash(TAG_BOOLEAN, boolByte)
  // - `number`:            hash(TAG_NUMBER, ieee754Float64Bytes)
  // - `string`:            hashStr(s)
  // - `bigint`:            hash(TAG_BIGINT, leb128(byteLen), signedTwosComplementBytes)
  // - `undefined`:         hash(TAG_UNDEFINED)
  // - `FabricBytes`:      hash(TAG_BYTES, leb128(byteLen), rawBytes)
  //                        (hashes the underlying byte content)
  // - `FabricEpochNsec`: hash(TAG_EPOCH_NSEC, leb128(byteLen), twosComplementBytes)
  //                        (same payload format as TAG_BIGINT but distinct tag)
  // - `FabricEpochDays`: hash(TAG_EPOCH_DAYS, leb128(byteLen), twosComplementBytes)
  //                        (same payload format as TAG_BIGINT but distinct tag)
  // - `FabricHash`: hash(TAG_HASH, hashStr(algTag), leb128(hashByteLen), hashBytes)
  //                        (algorithm tag as a tagged string, then raw hash bytes)
  // - array:               hash(TAG_ARRAY, ...elements, TAG_END)
  //                        Elements are hashed in index order:
  //                          if `i in array`: hashOf(array[i])
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
  //                        Each pair: hashStr(key) + tagged value.
  //                        TAG_END marks the end of the pair sequence.
  // - `FabricInstance`:  hash(TAG_INSTANCE, hashStr(codec.tagForValue(v)),
  //                              hashOf(codec.encode(v)))
  //                        where `codec` is `codecOf(v)` -- the class's
  //                        `[CODEC]` (Section 2.4), the same source of
  //                        truth the serialization layer uses.
  //
  // The native object wrappers and temporal types are hashed as follows:
  //
  // - `DataUnavailable`, `FabricError`, `FabricMap`, `FabricSet`,
  //   and other `FabricInstance`s with recursively-processable
  //   encoded state are hashed via TAG_INSTANCE:
  //     hash(TAG_INSTANCE, hashStr(codec.tagForValue(v)),
  //          hashOf(codec.encode(v)))
  //
  // - `FabricBytes` uses TAG_BYTES (dedicated primitive tag).
  // - `FabricEpochNsec` uses TAG_EPOCH_NSEC (dedicated primitive tag).
  // - `FabricEpochDays` uses TAG_EPOCH_DAYS (dedicated primitive tag).
  // - `FabricHash` uses TAG_HASH (dedicated primitive tag).
  // - `FabricRegExp` uses TAG_REGEXP (dedicated primitive tag).
  //
  // Examples (existing type tags are all short enough for the direct
  // string form, so `hashStr(tag)` below expands to
  // `TAG_STRING, leb128(utf8ByteLen), utf8Bytes`):
  // - `FabricError`:      hash(TAG_INSTANCE, hashStr("Error@1"), hashOf(errorState))
  // - `DataUnavailable`: hash(TAG_INSTANCE, hashStr("DataUnavailable@1"),
  //                              hashOf(unavailableState))
  // - `FabricMap`:        hash(TAG_INSTANCE, hashStr("Map@1"), hashOf(entries))
  //                         where entries are hashed in insertion order
  // - `FabricSet`:        hash(TAG_INSTANCE, hashStr("Set@1"), hashOf(elements))
  //                         where elements are hashed in insertion order
  // - `FabricEpochNsec`:  hash(TAG_EPOCH_NSEC, leb128(byteLen), twosComplementBytes)
  // - `FabricEpochDays`:  hash(TAG_EPOCH_DAYS, leb128(byteLen), twosComplementBytes)
  // - `FabricHash`:  hash(TAG_HASH, hashStr(algTag), leb128(hashByteLen), hashBytes)
  // - `FabricBytes`:      hash(TAG_BYTES, leb128(byteLen), rawBytes)
  // - `FabricRegExp`:     hash(TAG_REGEXP, hashStr(source), hashStr(flags),
  //                               hashStr(flavor))
  //
  // Each type is tagged to prevent collisions between types with
  // identical content representations. In particular, holes (TAG_HOLE),
  // `undefined` (TAG_UNDEFINED), and `null` (TAG_NULL) all produce
  // distinct hashes, ensuring `[1, , 3]`, `[1, undefined, 3]`, and
  // `[1, null, 3]` are distinguishable by hash.
  //
  // Note: The hash is a function of the logical value, not any
  // particular wire format. Implementations that hash from an
  // in-memory array and implementations that hash from the wire
  // format must produce identical hashes. Both use maximal-run RLE
  // for holes in the hash stream.
}
```

> **String encoding for hashing.** Strings are hashed as UTF-8 byte sequences,
> prefixed by their byte length (unsigned LEB128). See the byte-level spec
> (`2-hash-byte-format.md`, Section 4.4) for the precise encoding.

> **Map/Set ordering in hashing.** Hashing preserves insertion order for
> `FabricMap` entries and `FabricSet` elements, matching the serialized
> form. This means two `FabricMap`s or `FabricSet`s with the same elements
> in different insertion order will hash differently. This is intentional:
> insertion order is part of the observable semantics of `Map`/`Set` in
> JavaScript, so values that behave differently should not hash the same. (By
> contrast, plain objects are hashed with sorted keys, matching the existing
> convention that plain-object key order is not semantically significant.)

### 6.5 Relationship to Late Serialization

Hashing operates on `FabricValue` directly, using codec-encoded state for
`FabricInstance`s (including the native object wrappers; via `codecOf()`,
Section 2.4) and type-specific handling for primitives and containers.
This makes identity hashing independent of any particular wire encoding —
the same hash whether later serialized to JSON, CBOR, or Automerge.

### 6.6 Use Cases

Hashing is used for:
- Pattern ID generation (derived from pattern definition)
- Request deduplication
- Causal chain references (hashing the causal tree of what led to the data's
  existence)

Entity IDs remain stable addresses (analogous to IPNS names) pointing to the
most current version of the data. Hashes are not used as entity addresses.

### 6.7 Value Equality

`FabricValue`s are compared for logical (content) equality by
`valueEqual(a: FabricValue, b: FabricValue): boolean`. This is the equality
the reactive system's change-detection and no-op gates depend on, and the
equality that `Map` / `Set` key behavior over fabric values is expected to
follow.

**Governing principle.** Value-equality follows `Object.is()` at the primitive
level, and content-hash equality (Section 6.4) is defined to agree with it —
equivalently, two `FabricValue`s are value-equal exactly when their content
hashes are equal. `Object.is()`, not `===`, is the operator the contract
names, and the two disagree in exactly the two cases the hashing layer already
distinguishes:

- **`-0` ≠ `+0`.** `Object.is(-0, +0)` is `false`, so `-0` and `+0` are
  distinct fabric values and hash distinctly (Section 6.4;
  `2-hash-byte-format.md` Section 4.3). (`===` would conflate them, treating
  `-0 === +0` as `true`.)
- **All `NaN`s are value-equal.** `Object.is(NaN, NaN)` is `true`, so every
  `NaN` is value-equal to every other `NaN` — including bitwise-distinct
  payloads, which the hashing layer canonicalizes to a single quiet `NaN`
  (Section 6.4; `2-hash-byte-format.md` Section 4.3) — and all `NaN`s hash
  identically. (`===` would report `NaN !== NaN`.)

Every other primitive falls through to ordinary same-value equality:
`+Infinity`, `-Infinity`, and each finite number equals itself and nothing
else, and likewise for `string`, `boolean`, `bigint`, interned `symbol`,
`null`, and `undefined`.

**Objects, arrays, and instances.** Non-primitive fabric values are compared
by canonical content hash: `valueEqual(a, b)` holds exactly when
`hashStringOf(a) === hashStringOf(b)` (Section 6.4). Because the content hash
reflects logical content and carries the primitive-leaf distinctions above, a
`-0`, `NaN`, or any other value nested arbitrarily deep inside a plain object,
array, `FabricMap`, `FabricSet`, or other `FabricInstance` inherits the same
equality. Deciding object equality by content hash (rather than by a naive
property walk) is also what lets structurally distinct values be told apart —
a sparse array hole vs. a stored `undefined`, a present `undefined` vs. an
absent key (Section 6.4), and two distinct `FabricInstance`s of the same class
that carry no enumerable own-properties.

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
> fabric protocol (`FabricInstance` + `[CODEC]`) instead. Once all callers
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
> (a stateless tagged type per Section 5 of `3-json-encoding.md`), preserving its marker semantics.
>
> **Note on `$alias`:** An alias is an internal cross-cell reference with an
> optional schema filter. During migration it maps to `/Link@1` with the
> appropriate `overwrite` property (e.g., `overwrite: "redirect"` for aliases
> that redirect writes to the target cell).

### 7.3 Replacing CID-Based Hashing

The hashing approach (Section 6) replaces `merkle-reference` / CID-based
hashing. Since the system does not participate in the IPFS network, CID
formatting adds overhead without interoperability benefit. The hash operates
on the logical data structure directly.

### 7.4 Untrusted Deserialized Input

**Deserialized values must not be trusted for type safety.** After
serialization and deserialization, a value may not conform to the TypeScript
type that code assumes — the wire format carries no type guarantees, and a
round-trip through JSON (or any other encoding) can silently produce values
whose runtime shape does not match their static type.

This applies at every point where deserialized data is consumed:

- **Codec `decode()` implementations** (Section 2.4) receive `state:
  FabricValue`. The state has been deserialized by the serialization system,
  but its internal structure is determined by whatever was on the wire.
  Implementations must validate the shape of `state` at runtime — checking
  property existence, types, and constraints — rather than relying on a type
  cast (e.g., `state as { value: number }`). See the note in Section 2.7 for a
  concrete example.

- **JSON-side codec decoding** (Section 3 of `3-json-encoding.md`) must
  validate the format of its state before processing. Malformed input
  should produce a `ProblematicValue` rather than throwing or silently
  producing garbage (a codec may also throw and rely on a lenient context
  to do the wrapping; Section 4.5).

- **Hashing** (Section 6.3) may operate on values that have been
  through a deserialization round-trip. Code that extracts properties from
  `FabricInstance` values must validate those properties at runtime.

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
// Shown for illustration only.
// file: packages/data-model/native-conversion.ts

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
| `null`, `boolean`, `number`, `string`, `undefined`, `bigint` | Returned as-is (primitives are `FabricValue` directly). All numbers pass through unchanged, including `-0`, `NaN`, and `±Infinity`. See Section 1.3 callout for layer-by-layer details. |
| `symbol` | Registry-interned symbols (`Symbol.keyFor(s)` returns a string) returned as-is; unique symbols (`Symbol(desc)`) throw with the message `"Cannot store unique (uninterned) symbol"`. See Section 1.3 callout for layer-by-layer details. |
| `FabricPrimitive` (`FabricEpochNsec`, `FabricEpochDays`, `FabricHash`, `FabricBytes`) | Returned as-is. Always-frozen: the `freeze` option has no effect on these types (see Section 1.4.6). |
| `FabricInstance` (including wrapper classes) | Returned as-is (already `FabricValue`). |
| `Error` | Wrapped into `FabricError`. Before wrapping, `cause` and custom enumerable properties are recursively converted to `FabricValue` (deep variant) or left as-is (shallow variant). Extra enumerable properties are preserved (see Section 1.4.1). This ensures that by the time the `FabricError` codec's `encode()` runs, all nested values are already valid `FabricValue`. |
| `Map` | Wrapped into `FabricMap`. Keys and values are recursively converted (deep variant only). Extra enumerable properties on the `Map` object cause **rejection** (throw) — it is better to fail loudly than silently lose data. |
| `Set` | Wrapped into `FabricSet`. Elements are recursively converted (deep variant only). Extra enumerable properties on the `Set` object cause **rejection** (throw) — it is better to fail loudly than silently lose data. |
| `Date` | Wrapped into `FabricEpochNsec`. The `Date`'s millisecond timestamp is converted to nanoseconds: `BigInt(date.getTime()) * 1_000_000n`. Note the millisecond precision limitation — sub-millisecond information is not available from `Date`. Extra enumerable properties on the `Date` object cause **rejection** (throw) — it is better to fail loudly than silently lose data. |
| `RegExp` | Converted into `FabricRegExp` (a `FabricPrimitive`, not a wrapper). The `source` and `flags` are extracted from the native `RegExp`; `flavor` defaults to `"es2025"` (it is a `FabricRegExp`-level property, not a native `RegExp` property). Extra enumerable properties on the `RegExp` object cause **rejection** (throw) — it is better to fail loudly than silently lose data. |
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
> `packages/data-model/value-clone.ts`) to handle frozenness adjustment
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
place; see Section 8.6 for its full protocol, dispatch shape, and the
boundary-crossing egress contracts. At sites where schema objects are
merged or combined (e.g., schema `merge()` and `combine()` functions),
pass-through paths — where the input is returned as the result without
structural modification — must copy the value before freezing to avoid
mutating caller-owned schema objects. The general principle: `deepFreeze()`
freezes in place, so if the caller retains a reference to a mutable
object, the function must not freeze that object as a side effect. Callers
at these sites should copy before freezing rather than relying on the
input being "safe to freeze."

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
// Shown inside a pattern body.
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
// Shown for illustration only.
// file: packages/data-model/native-conversion.ts

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
 * Relationship to other functions and checks:
 * - The narrower conceptual check -- "is `x` already a `FabricValue`?",
 *   which would NOT accept raw native types like `Error` or `Map` -- has
 *   no standalone predicate; a dedicated `isFabricValue()` is a noted
 *   TODO in `deep-freeze.ts`.
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

- A primitive (`null`, `boolean`, `number`, `string`, `undefined`, `bigint`).
  All numbers are accepted, including `-0`, `NaN`, and `±Infinity`; see the
  Section 1.3 callout.
- A registry-interned `symbol` (one for which `Symbol.keyFor(s)` returns a
  string). Unique symbols return `false`; see the Section 1.3 callout.
- A `FabricInstance` (including the native object wrapper classes)
- A `FabricNativeObject` (`Error`, `Map`, `Set`, `Date`, `RegExp`,
  `Uint8Array`, or an object with a `toJSON()` method — legacy)
- An array where every present element satisfies `isFabricCompatible()`
- A plain object where every value satisfies `isFabricCompatible()`

It returns `false` for unsupported types (`WeakMap`, `Promise`, DOM nodes,
class instances that don't implement `FabricInstance`, etc.) and for unique
symbols.

> **Performance note.** `isFabricCompatible()` walks the value tree without
> allocating wrappers or frozen copies. For large trees, this is cheaper than
> calling `fabricFromNativeValue()` inside a try/catch, since it avoids the
> wrapping and freezing work that would be discarded on failure. However, if
> the caller intends to convert on success, calling
> `fabricFromNativeValue()` directly (and catching the error) avoids walking
> the tree twice.

### 8.4 `nativeFromFabricValue()`

```typescript
// Shown for illustration only.
// file: packages/data-model/native-conversion.ts

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
 *
 * `FabricPrimitive` subclasses (`FabricEpochNsec`, `FabricEpochDays`,
 * `FabricHash`, `FabricBytes`, `FabricRegExp`) pass through unchanged — they
 * are always-frozen (Section 1.4.6). (`FabricRegExp` exposes its native form
 * via `value`, which returns a fresh `RegExp` clone; it is not unwrapped to a
 * native `RegExp` by this function.)
 *
 * **The `frozen` argument is always honored.** The freeze state of every
 * value in the output matches the `frozen` argument. When `frozen` is
 * `true` (the default), unwrapped wrappers use immutable variants
 * (`FrozenMap`, `FrozenSet`, frozen `Error`). When `frozen` is `false`,
 * mutable native types are returned instead.
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
| `FabricEpochNsec` | Passed through unchanged (`FabricPrimitive`; always-frozen) | Passed through unchanged (same) |
| `FabricEpochDays` | Passed through unchanged (`FabricPrimitive`; always-frozen) | Passed through unchanged (same) |
| `FabricHash` | Passed through unchanged (always-frozen; Section 1.4.6) | Passed through unchanged (same) |
| `FabricBytes` | Passed through unchanged (always-frozen; Section 1.4.6) | Passed through unchanged (same) |
| `FabricRegExp` | Passed through unchanged (`FabricPrimitive`; always-frozen) | Passed through unchanged (same) |
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

### 8.6 Deep-Freeze Protocol and Egress Contracts

`FabricValue` trees produced by reconstruction at boundary-crossings are
deep-frozen by default. This is enforced via a small protocol on
`BaseFabricInstance` together with a generic top-level utility that dispatches
across the four kinds of values that can appear in a `FabricValue` tree.

#### Instance protocol members

Every concrete `FabricInstance` provides the three members below
(Section 2.3). Their declarations are split by concern: the freeze-protocol
members `[DEEP_FREEZE]` and `[IS_DEEP_FROZEN]` are declared on
`BaseFabricInstance` — the abstract base that concrete instance classes extend
— keeping this implementation plumbing off the pure-protocol `FabricInstance`
interface, while `deepClone()` and the inherited `shallowClone()` are declared
on `FabricInstance` itself. These members, plus the class-side `[CODEC]`
(serialization; Section 2.4), are the whole instance protocol:

- **`[DEEP_FREEZE](subFreeze)`** — Deeply freezes this instance in place
  and returns it. The implementation freezes the instance's own internal
  slot(s) and calls the provided `subFreeze` callback on each nested
  `FabricValue`. Implementations must NOT call `deepFreeze()` directly:
  recursion is handed through the callback so that the freeze utility's
  caching and cycle-detection bookkeeping is preserved and no import cycle
  is introduced.

- **`[IS_DEEP_FROZEN](subIsDeepFrozen)`** — Side-effect-free sibling of
  `[DEEP_FREEZE]`: returns `true` if this instance's own internal slot(s)
  are in canonical deep-frozen form and every nested `FabricValue`
  (visited via the `subIsDeepFrozen` callback) is also deep-frozen.
  An instance that is not in canonical deep-frozen form returns `false`;
  the check must not throw.

- **`deepClone(frozen)`** — Returns a new deep clone of this instance with
  equivalent data but no shared structure for any unfrozen data in the
  original. When `frozen === true`, produces a frozen instance with
  maximal structural sharing (including returning `this` if already
  deep-frozen). When `frozen === false`, produces a deeply-mutable
  instance with no visible shared reference structure with the original.

The `subFreeze` / `subIsDeepFrozen` callbacks (rather than direct utility
imports) keep the protocol layering clean and let the outer utility thread
its shared cycle-detection state through implementations transparently.

#### `deepFreeze()` and the 4-arm dispatch

The generic top-level utility (`packages/data-model/deep-freeze.ts`)
recursively freezes a `FabricValue` in place. It dispatches on four arms
in order:

1. **Necessarily- or already-known-deep-frozen value** — primitives
   (`null` and `typeof !== "object"`) and objects already recorded in the
   internal deep-frozen cache. Short-circuits unchanged.

2. **`FabricPrimitive` instance** — `FabricPrimitive` subclasses
   (`FabricEpochNsec`, `FabricEpochDays`, `FabricHash`, `FabricBytes`;
   Section 1.4.6) self-freeze at construction and have no outbound
   references. Short-circuits unchanged.

3. **`FabricInstance`** — Delegates to the instance's `[DEEP_FREEZE]`
   member with a `subFreeze` callback that recurses back through the same
   utility, threading the shared cycle-detection state. The dispatch
   gates on `instanceof` against the abstract base; it does not enumerate
   concrete subclasses. The (now deep-frozen) result is recorded in the
   deep-frozen cache so subsequent `isDeepFrozen()` checks short-circuit
   in O(1).

4. **Plain object or array** — Recurses into children, then freezes the
   container with `Object.freeze()`. Arrays preserve sparse holes. The
   container is recorded in the deep-frozen cache.

A shared `inProgress` set, threaded through all recursive calls (including
into participating `FabricInstance`s' `[DEEP_FREEZE]` impls via the
`subFreeze` callback closure), makes the utility cycle-safe: a cycle back
to a value the outer call is already deep-freezing short-circuits rather
than recursing.

#### `isDeepFrozenFabricValue()` and the 4-arm type guard

The type guard (`isDeepFrozenFabricValue`) is the side-effect-free sibling
of `deepFreeze()`. It mirrors the same arm shape:

1. Primitives are accepted directly.
2. `FabricPrimitive` instances are accepted directly.
3. `FabricInstance` instances delegate to their `[IS_DEEP_FROZEN]` member
   with a `subIsDeepFrozen` callback that recurses back through the same
   guard.
4. Plain objects and arrays must be `Object.isFrozen` and have every
   child accepted by the guard.

Visited objects are tracked in a per-call `Set` for cycle safety.

#### Egress-freezing call sites

The deep-freeze contract is enforced at the points where reconstructed
values cross from internal serialization machinery to callers:

- **The decode walker's codec dispatch arm.**
  Every value returned from this arm passes through `deepFreeze()` before
  returning. This covers the codec-produced value (often a
  `FabricPrimitive` subclass, already frozen — the cache hit makes this
  O(1)) and the lenient-mode `ProblematicValue` fallback. The
  unknown-tag arm (`UnknownValue`) is a separate sibling branch and is
  intentionally NOT covered by this contract; broadening the contract
  there is a separate follow-on. See Section 4.5 step 4.

- **`JsonWireValue` parse boundary.** The `#parseWireText()` helper
  (invoked by `decode()` and `fromBytes()`) deep-freezes the parsed wire
  tree before handing it to the decode walker. This is what makes the
  deserialize-side `JsonWireValue` invariant load-bearing: tag-unwrap and
  the `/quote` arm can hand back extracted sub-trees directly without
  further copying because the input tree is already deep-frozen.

- **Codec `decode()` implementations honoring `shouldDeepFreeze`.** When a
  reconstruction call's `ReconstructionContext.shouldDeepFreeze` is
  `true` (Section 2.5; the safe default), each codec `decode()`
  implementation produces a deep-frozen result (typically via the
  instance's own `[DEEP_FREEZE]`, recursing through `deepFreeze()`).

- **`deepFreeze()` at schema merge/combine sites.** See Section 8.2.

---

## Appendix A: Open Design Decisions

These questions may need resolution during implementation but do not block the
spec from being implementable.

- **Type registry management**: How are serialization contexts configured? Static
  registration? Dynamic discovery? Who owns the registry? The isolation
  strategy (see `coordination/docs/2026-02-09-isolation-strategy.md`) proposes
  per-`Runtime` configuration via `ExperimentalOptions`, which provides a
  natural place for registry configuration per runtime instance.

- **Schema integration**: Each `FabricInstance` type implies a schema for its
  encoded state. How does this integrate with the schema language?
  Currently out of scope (schemas are listed as out-of-scope for this spec).

- **Exact hash specification**: The precise byte-level format is defined in
  `2-hash-byte-format.md`. All lengths and counts use unsigned LEB128
  encoding; see that document for the complete specification of type tags,
  encoding per type, and illustrative examples.

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
  `fabricFromNativeValue()` conversion in these methods (Section 4.9) is correct
  but forward-looking: it will become load-bearing when user-facing patterns
  start storing rich types through the schema-aware `set()` path.
