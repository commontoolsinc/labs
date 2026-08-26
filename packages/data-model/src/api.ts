/**
 * Pattern-visible declarations for the fabric value type system, in the form
 * that `@commonfabric/api` re-exports to patterns. Everything here is an
 * interface, a type, or a `declare const`, except for the one brand-key
 * constant, so the module's only runtime footprint is that constant.
 *
 * The canonical implementations live in this module's siblings --
 * `interface.ts`, `fabric-primitives/FabricHash.ts`,
 * `fabric-primitives/FabricEpochNsec.ts`, and the rest -- and these
 * declarations mirror their public surface. The two must agree: where they
 * drift, pattern type-checking diverges from runtime behavior.
 *
 * Every concrete `FabricPrimitive` subclass needs an instanceof-capable
 * declaration here, that being an interface, a constructor interface, and a
 * `declare const` combining the two.
 *
 * This module has no imports, and can have none. `@commonfabric/api`
 * re-exports it to patterns, and the script that builds the type file the
 * sandbox is served inlines this text rather than following a specifier out of
 * it, so a specifier named here would reach a compiler that resolves none.
 */

/**
 * The nominal brand key declared on `FabricSpecialObject`. It exists only in
 * the type system — a runtime instance never carries the key; `instanceof
 * FabricSpecialObject` is its runtime form. Schema `required` presence
 * checks must therefore treat this key as satisfied by any
 * `FabricSpecialObject` rather than probing for it with `in`.
 */
export const FABRIC_SPECIAL_OBJECT_BRAND = "@commonfabric/FabricSpecialObject";

/**
 * Common base class for `FabricInstance` and `FabricPrimitive`. Enables a
 * single `instanceof` check for any fabric-system value type.
 *
 * The `@commonfabric/FabricSpecialObject` member is a nominal brand with no
 * runtime existence — see the canonical declaration in
 * `data-model/src/interface.ts` for why it is a well-known string key and not
 * a `unique symbol`. The two declarations must agree exactly.
 */
export interface FabricSpecialObject {
  readonly "@commonfabric/FabricSpecialObject": true;
}

export interface FabricSpecialObjectConstructor {
  prototype: FabricSpecialObject;
}

export declare const FabricSpecialObject:
  & FabricSpecialObjectConstructor
  & (abstract new (...args: any) => FabricSpecialObject);

/**
 * Abstract base class for values that participate in the fabric protocol.
 *
 * An instance holds all of its state privately and makes it reachable only
 * through members, so it has no own properties at all. A structural view of
 * one -- a spread, `Object.keys()`, a naive walk -- therefore sees nothing.
 */
export interface FabricInstance extends FabricSpecialObject {
  shallowClone(frozen: boolean): FabricInstance;
}

export interface FabricInstanceConstructor {
  prototype: FabricInstance;
}

export declare const FabricInstance:
  & FabricInstanceConstructor
  & (abstract new (...args: any) => FabricInstance);

/** Abstract base class for `FabricPrimitive` types. */
export interface FabricPrimitive extends FabricSpecialObject {}

export interface FabricPrimitiveConstructor {
  prototype: FabricPrimitive;
}

export declare const FabricPrimitive:
  & FabricPrimitiveConstructor
  & (abstract new (...args: any) => FabricPrimitive);

/**
 * Temporal type representing nanoseconds from the POSIX Epoch.
 * Wraps a `bigint` value.
 */
export interface FabricEpochNsec extends FabricPrimitive {
  readonly value: bigint;
}

export interface FabricEpochNsecConstructor {
  new (value: bigint): FabricEpochNsec;
  prototype: FabricEpochNsec;
}

export declare const FabricEpochNsec: FabricEpochNsecConstructor;

/**
 * Temporal type representing a particular day, as a count of days from the
 * POSIX Epoch. Wraps a `bigint` value.
 */
export interface FabricEpochDay extends FabricPrimitive {
  readonly value: bigint;
}

export interface FabricEpochDayConstructor {
  new (value: bigint): FabricEpochDay;
  prototype: FabricEpochDay;
}

export declare const FabricEpochDay: FabricEpochDayConstructor;

/**
 * A content-addressed identifier: a hash digest paired with an algorithm tag.
 * Extends `FabricPrimitive` -- treated like a primitive in the fabric type
 * system (always frozen, passes through conversion unchanged).
 */
export interface FabricHash extends FabricPrimitive {
  readonly tag: string;
  readonly bytes: Uint8Array;
  readonly length: number;
  readonly hashString: string;
  toString(): string;
}

export interface FabricHashConstructor {
  new (
    hash: Uint8Array | ArrayBufferLike,
    tag: string,
    transfer?: boolean,
  ): FabricHash;
  prototype: FabricHash;
}

export declare const FabricHash: FabricHashConstructor;

/**
 * The modern, object-shaped form of a link reference, wrapping the link's
 * addressing payload (a `FabricPlainObject`: its addressing fields plus an optional
 * `schema`). Extends `FabricInstance` (not `FabricPrimitive`): the payload is an
 * outgoing reference (it may carry an arbitrary-`FabricValue` `schema`), so a
 * link is a small object graph, not a leaf.
 */
export interface FabricLink extends FabricInstance {
  readonly payload: FabricPlainObject;
}

export interface FabricLinkConstructor {
  new (payload: FabricPlainObject): FabricLink;
  prototype: FabricLink;
}

export declare const FabricLink: FabricLinkConstructor;

/**
 * An immutable, frozen sequence of bytes. Extends `FabricPrimitive` --
 * treated like a primitive in the fabric type system (always frozen, passes
 * through conversion unchanged). Read the bytes with `slice()`,
 * `sliceBuffer()`, or `copyInto()`.
 */
export interface FabricBytes extends FabricPrimitive {
  readonly length: number;
  slice(start?: number, end?: number): Uint8Array<ArrayBuffer>;
  sliceBuffer(start?: number, end?: number): ArrayBuffer;
  copyInto(target: Uint8Array, offset?: number, length?: number): number;
}

export interface FabricBytesConstructor {
  new (bytes: Uint8Array | ArrayBufferLike, transfer?: boolean): FabricBytes;
  prototype: FabricBytes;
}

export declare const FabricBytes: FabricBytesConstructor;

/**
 * An immutable regular expression. Extends `FabricPrimitive` -- treated like a
 * primitive in the fabric type system (always frozen, passes through
 * conversion unchanged).
 *
 * The pattern is held as a flavor / source / flags triple rather than as a
 * native `RegExp`, so that flavors with no native representation can still be
 * carried. `value` reconstitutes a native `RegExp` where one exists.
 */
export interface FabricRegExp extends FabricPrimitive {
  readonly source: string;
  readonly flags: string;
  readonly flavor: string;

  /**
   * A fresh native `RegExp` equivalent to this value, returned anew on each
   * call so the internal instance is never aliased out. Throws for a flavor
   * with no native `RegExp` representation.
   */
  readonly value: RegExp;
}

export interface FabricRegExpConstructor {
  new (regex: RegExp): FabricRegExp;
  new (flavor: string, source: string, flags: string): FabricRegExp;
  prototype: FabricRegExp;
}

export declare const FabricRegExp: FabricRegExpConstructor;

/**
 * An immutable asymmetric key pair. Extends `FabricPrimitive` -- treated like
 * a primitive in the fabric type system (always frozen, passes through
 * conversion unchanged).
 *
 * An instance either holds handles -- two `CryptoKey`s, whose material this
 * realm may have no way to reach -- or holds material, the two keys as bytes.
 * `hasMaterial` says which, and every accessor belonging to the other arm
 * throws.
 */
export interface FabricKeyPair extends FabricPrimitive {
  readonly algorithm: string;
  readonly hasMaterial: boolean;

  /**
   * A `CryptoKeyPair` holding this instance's two keys. The record is a new
   * object on each call, so a caller may do as it likes with it; the two
   * `CryptoKey`s within it are this instance's own, and are the same two
   * objects on every call. Throws when this instance holds material.
   */
  readonly cryptoKeyPair: CryptoKeyPair;

  /** The public key's handle. Throws when this instance holds material. */
  readonly publicCryptoKey: CryptoKey;

  /** The private key's handle. Throws when this instance holds material. */
  readonly privateCryptoKey: CryptoKey;

  /** The public key's bytes. Throws when this instance holds handles. */
  readonly publicKeyBytes: FabricBytes;

  /** The private key's bytes. Throws when this instance holds handles. */
  readonly privateKeyBytes: FabricBytes;
}

export interface FabricKeyPairConstructor {
  new (pair: CryptoKeyPair): FabricKeyPair;
  new (
    algorithm: string,
    publicKey: FabricBytes | Uint8Array,
    privateKey: FabricBytes | Uint8Array,
  ): FabricKeyPair;
  prototype: FabricKeyPair;
}

export declare const FabricKeyPair: FabricKeyPairConstructor;

/**
 * Structured state for constructing a `FabricError`. The fixed-schema slots
 * are `FabricValue`-typed; `extras` carries any custom enumerable properties,
 * whose keys must not collide with the slot names.
 */
export type FabricErrorState = {
  /** Constructor name of the originating native `Error` (e.g. `"TypeError"`). */
  readonly type: string;
  /** The `.name` property. Omit to mean "same as `type`". */
  readonly name?: string | null | undefined;
  /** The `.message` property. */
  readonly message: string;
  /** The `.stack` property, or `undefined`. */
  readonly stack: string | undefined;
  /** The `.cause` value, in `FabricValue` form, or `undefined`. */
  readonly cause: FabricValue | undefined;
  /** Custom enumerable own properties, in `FabricValue` form. */
  readonly extras?:
    | Iterable<readonly [string, FabricValue]>
    | Readonly<Record<string, FabricValue>>
    | undefined;
};

/**
 * An error carried as a `FabricValue`. Extends `FabricInstance` (not
 * `FabricPrimitive`): it holds fixed-schema slots plus a bag of extras, and
 * `cause` may be an arbitrary `FabricValue`, so it is a small object graph
 * rather than a leaf.
 *
 * Like every `FabricInstance` it is mutable until frozen, and every mutator --
 * the slot setters along with `setExtra()` and `deleteExtra()` -- throws once
 * the instance is frozen.
 */
export interface FabricError extends FabricInstance {
  type: string;
  name: string;
  message: string;
  stack: string | undefined;
  cause: FabricValue | undefined;

  getExtra(key: string): FabricValue | undefined;
  hasExtra(key: string): boolean;
  setExtra(key: string, value: FabricValue): void;
  deleteExtra(key: string): boolean;
  readonly extraSize: number;
  extraKeys(): IterableIterator<string>;
  extraEntries(): IterableIterator<[string, FabricValue]>;
}

export interface FabricErrorConstructor {
  new (state: FabricErrorState): FabricError;
  fromNativeError(error: Error): FabricError;
  prototype: FabricError;
}

export declare const FabricError: FabricErrorConstructor;

// TODO(danfuzz): `FabricMap` and `FabricSet` are deliberately absent from the
// declarations above. Both need substantial rework before they are useful, and
// declaring them here would imply a utility they do not yet have. Their
// absence is a decision, not an oversight; revisit once that rework lands.

/**
 * The full set of values that the fabric storage layer can represent.
 *
 * From a typesystem perspective, all `FabricValue`s are immutable (deeply
 * read-only), _except_ members of the `FabricInstance` tree. `FabricInstance`s
 * expose arbitrary methods which can cause a change of instance state including
 * changing the set of outgoing references from the instance. This is an
 * _intentional_ hole, because TypeScript has no ergonomic/pithy way to express
 * the desired semantics. (To be clear, it _can_ be done, just not cleanly.)
 */
export type FabricValue =
  | null
  | boolean
  | number
  | string
  | bigint
  | symbol
  | FabricSpecialObject
  | FabricArray
  | FabricPlainObject
  | undefined;

/**
 * The container types that are part of `FabricValue`. Note that
 * `FabricSpecialObject` is a combination of container and non-container.
 */
export type FabricContainerValue =
  | FabricArray
  | FabricInstance // One of the two direct subclasses of `FabricSpecialObject`.
  | FabricPlainObject;

/** A `FabricValue` other than `null` or `undefined`. */
export type NonNullableFabricValue = NonNullable<FabricValue>;

/** Read-only array of `FabricValue`s. */
export interface FabricArray extends ReadonlyArray<FabricValue> {}

/** Read-only object/record of `FabricValue`s. */
export interface FabricPlainObject
  extends Readonly<Record<string, FabricValue>> {}
