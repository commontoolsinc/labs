import type { FabricValue } from "@/interface.ts";
import {
  DEEP_CLONE_CORE,
  DEEP_FREEZE,
  IS_DEEP_FROZEN,
  SHALLOW_UNFROZEN_CLONE,
} from "./BaseFabricInstance.ts";
import {
  CODEC,
  type FabricCodec,
  type ReconstructionContext,
} from "@/codec-common/interface.ts";
import { BaseFabricCodec } from "@/codec-common/BaseFabricCodec.ts";
import { deepFreeze } from "@/deep-freeze.ts";
import { CODEC_TYPE_TAGS } from "@/codec-common/codec-type-tags.ts";
import { FrozenSet } from "@/frozen-builtins.ts";
import { EmptyReconstructionContext } from "@/codec-common/EmptyReconstructionContext.ts";
import { FabricNativeWrapper } from "./FabricNativeWrapper.ts";
import { errorClassFromType } from "@/native-conversion.ts";
import { isUnsafeObjectKey } from "@commonfabric/utils/types";

/**
 * Reserved key set for `FabricError`'s extras bag: these names belong to the
 * fixed-schema slots (`type`, `name`, `message`, `stack`, `cause`) and cannot
 * be used as extras keys.
 */
const FABRIC_ERROR_RESERVED_KEYS: FrozenSet<string> = new FrozenSet([
  "type",
  "name",
  "message",
  "stack",
  "cause",
]);

/**
 * Structured state for constructing a `FabricError`. Spec slots are
 * `FabricValue`-typed; the optional `extras` carries any custom enumerable
 * properties (also in `FabricValue` form). After construction, extras are
 * accessed via map-like methods (`getExtra`, `setExtra`, etc.) on the
 * instance; they are not exposed as an own property.
 */
export type FabricErrorState = {
  /** Constructor name of the originating native `Error` (e.g. `"TypeError"`). */
  readonly type: string;
  /**
   * The `.name` property. Pass `null` (or omit) to mean "same as `type`"; the
   * resulting instance's `.name` is always a concrete string (`null` is a
   * wire-level optimization at the `[CODEC]` encode boundary, not part of the
   * public API).
   */
  readonly name?: string | null | undefined;
  /** The `.message` property. */
  readonly message: string;
  /** The `.stack` property, or `undefined`. */
  readonly stack: string | undefined;
  /** The `.cause` value, in `FabricValue` form, or `undefined`. */
  readonly cause: FabricValue | undefined;
  /**
   * Optional iterable of custom enumerable own properties, in `FabricValue`
   * form. Keys must not collide with the fixed-schema slot names or with
   * prototype-sensitive keys.
   */
  readonly extras?:
    | Iterable<readonly [string, FabricValue]>
    | Readonly<Record<string, FabricValue>>
    | undefined;
};

/**
 * Wrapper for `Error` instances in the fabric type system. Bridges native
 * `Error` (JS wild west) into the strongly-typed `FabricValue` layer by
 * implementing `FabricInstance`. The publicly observable state is entirely
 * `FabricValue`-typed: fixed-schema slots (`type`, `name`, `message`,
 * `stack`, `cause`) plus a hidden extras bag accessed via map-like methods
 * (`getExtra`, `setExtra`, `hasExtra`, `deleteExtra`, `extraKeys`,
 * `extraEntries`). The native `Error` form is produced on demand by
 * `toNativeValue()`.
 *
 * Like all `FabricInstance`s, a `FabricError` is wholeheartedly mutable
 * until frozen and immutable thereafter. The fixed-schema slots are plain
 * writable own properties: assigning to one throws once the instance is
 * `Object.freeze`'d (strict-mode non-writable-property semantics). The
 * extras bag mirrors this by gating `setExtra` / `deleteExtra` on the
 * frozen state. The serialization layer handles `FabricError` via its static
 * `[CODEC]`, which is the source of truth for the encoded form.
 * See Section 1.4.1 of the formal spec.
 */
export class FabricError extends FabricNativeWrapper<Error> {
  /** Constructor name of the originating native `Error` (e.g. `"TypeError"`). */
  type: string;
  /** The `.name` property (always a concrete string). */
  name: string;
  /** The `.message` property. */
  message: string;
  /** The `.stack` property, or `undefined`. */
  stack: string | undefined;
  /** The `.cause` value, in `FabricValue` form, or `undefined`. */
  cause: FabricValue | undefined;

  /** Hidden bag of custom enumerable properties, in `FabricValue` form. */
  readonly #extras: Map<string, FabricValue>;

  /**
   * Cached lazy native projection, populated only once this instance is
   * frozen (so the projection can never go stale against mutable state).
   * While unfrozen, `wrappedValue` rebuilds on each access; thawed copies
   * are always minted fresh by `toNativeThawed()`.
   */
  #nativeFrozen: Error | undefined;

  /**
   * Constructs from a `FabricErrorState` record. All state values must already
   * be in `FabricValue` form -- the conversion layer is responsible for
   * ensuring this when constructing from a native `Error`. Use
   * `FabricError.fromNativeError()` for shallow conversion from a native
   * `Error`.
   */
  constructor(state: FabricErrorState) {
    super();
    this.type = state.type;
    this.name = state.name ?? state.type;
    this.message = state.message;
    this.stack = state.stack;
    this.cause = state.cause;
    this.#extras = new Map();
    const extras = state.extras;
    if (extras !== undefined) {
      const entries: Iterable<readonly [string, FabricValue]> =
        Symbol.iterator in extras
          ? extras as Iterable<readonly [string, FabricValue]>
          : Object.entries(extras as Record<string, FabricValue>);
      for (const [key, value] of entries) {
        if (isUnsafeObjectKey(key) || FABRIC_ERROR_RESERVED_KEYS.has(key)) {
          continue;
        }
        this.#extras.set(key, value);
      }
    }
  }

  /**
   * Shallow conversion from a native `Error`. Used by the shallow conversion
   * layer (`shallowFabricFromNativeValueModern`). The error's `.cause` and
   * custom properties are stored as-is (cast to `FabricValue`); the deep
   * conversion path is responsible for converting them when needed.
   */
  static fromNativeError(error: Error): FabricError {
    const type = error.constructor.name;
    const name = error.name === type ? null : error.name;
    const extras: Array<[string, FabricValue]> = [];
    for (const key of Object.keys(error)) {
      if (isUnsafeObjectKey(key) || FABRIC_ERROR_RESERVED_KEYS.has(key)) {
        continue;
      }
      extras.push([
        key,
        (error as unknown as Record<string, FabricValue>)[key],
      ]);
    }
    return new FabricError({
      type,
      name,
      message: error.message,
      stack: error.stack,
      cause: error.cause as FabricValue | undefined,
      extras,
    });
  }

  /** Returns the value associated with `key`, or `undefined`. */
  getExtra(key: string): FabricValue | undefined {
    return this.#extras.get(key);
  }

  /** Returns `true` if `key` is present in the extras bag. */
  hasExtra(key: string): boolean {
    return this.#extras.has(key);
  }

  /**
   * Sets `key` to `value` in the extras bag. Throws if this instance is
   * frozen, if `key` is a fixed-schema slot name, or if `key` is a
   * prototype-sensitive key (`__proto__`, `constructor`).
   */
  setExtra(key: string, value: FabricValue): void {
    if (Object.isFrozen(this)) {
      throw new Error("Cannot modify frozen FabricError");
    }
    if (isUnsafeObjectKey(key)) {
      throw new Error(`Cannot use unsafe key in FabricError extras: ${key}`);
    }
    if (FABRIC_ERROR_RESERVED_KEYS.has(key)) {
      throw new Error(
        `Cannot use fixed-schema slot name in FabricError extras: ${key}`,
      );
    }
    this.#extras.set(key, value);
  }

  /**
   * Removes `key` from the extras bag, returning `true` if it was present.
   * Throws if this instance is frozen.
   */
  deleteExtra(key: string): boolean {
    if (Object.isFrozen(this)) {
      throw new Error("Cannot modify frozen FabricError");
    }
    return this.#extras.delete(key);
  }

  /** Returns the number of entries in the extras bag. */
  get extraSize(): number {
    return this.#extras.size;
  }

  /** Returns the keys present in the extras bag. */
  extraKeys(): IterableIterator<string> {
    return this.#extras.keys();
  }

  /** Returns the `[key, value]` entries in the extras bag. */
  extraEntries(): IterableIterator<[string, FabricValue]> {
    return this.#extras.entries();
  }

  /**
   * Deep-freezes in place. Freezes this instance and recurses into the
   * `FabricValue`-typed `cause` and extras-bag values via `subFreeze`. The
   * extras bag's mutation methods are gated by this instance's frozen state,
   * so freezing `this` is sufficient -- there is no separate `Object.freeze`
   * on the bag itself (a `Map` ignores `Object.freeze` for `set`/`delete`).
   * There is no native-`Error` slot to freeze -- the native projection is a
   * derivation produced on demand, not stored as canonical state.
   */
  [DEEP_FREEZE](
    subFreeze: (value: FabricValue) => FabricValue,
  ): FabricValue {
    if (this.cause !== undefined) {
      subFreeze(this.cause);
    }
    for (const value of this.#extras.values()) {
      subFreeze(value);
    }
    return Object.freeze(this) as unknown as FabricValue;
  }

  /**
   * Side-effect-free check mirroring `[DEEP_FREEZE]`'s canonical form: this
   * instance is frozen, and the `cause` plus each value in the extras bag
   * are recursively deep-frozen. Never throws.
   */
  [IS_DEEP_FROZEN](
    subIsDeepFrozen: (value: FabricValue) => boolean,
  ): boolean {
    if (!Object.isFrozen(this)) return false;
    if (this.cause !== undefined && !subIsDeepFrozen(this.cause)) {
      return false;
    }
    for (const value of this.#extras.values()) {
      if (!subIsDeepFrozen(value)) return false;
    }
    return true;
  }

  /** @inheritDoc */
  protected [SHALLOW_UNFROZEN_CLONE](): FabricError {
    return new FabricError({
      type: this.type,
      name: this.name,
      message: this.message,
      stack: this.stack,
      cause: this.cause,
      extras: this.#extras,
    });
  }

  /**
   * Returns the frozen native projection. Once this instance is frozen the
   * projection is cached (state can no longer change, so the cache is always
   * valid); while mutable it is rebuilt on each access. `toNativeValue(false)`
   * uses `toNativeThawed()` to mint a thawed copy each time.
   */
  protected get wrappedValue(): Error {
    if (!Object.isFrozen(this)) {
      // Mutable: state may still change, so never cache.
      return this.#buildNativeError(true);
    }
    if (this.#nativeFrozen === undefined) {
      this.#nativeFrozen = this.#buildNativeError(true);
    }
    return this.#nativeFrozen;
  }

  /** @inheritDoc */
  protected toNativeFrozen(): Error {
    return this.wrappedValue;
  }

  /** @inheritDoc */
  protected toNativeThawed(): Error {
    return this.#buildNativeError(false);
  }

  /**
   * Builds a fresh native `Error` from this `FabricError`'s state. `cause`
   * and extras are copied through as-is (no recursive unwrap). Callers that
   * need recursive unwrap should use `nativeFromFabricValue()`.
   */
  #buildNativeError(frozen: boolean): Error {
    const ErrorClass = errorClassFromType(this.type);
    const error = new ErrorClass(this.message);
    if (error.name !== this.name) error.name = this.name;
    if (this.stack !== undefined) error.stack = this.stack;
    if (this.cause !== undefined) error.cause = this.cause;
    for (const [key, value] of this.#extras) {
      (error as unknown as Record<string, unknown>)[key] = value;
    }
    return frozen ? Object.freeze(error) : error;
  }

  /**
   * @inheritDoc
   *
   * Round-trips through the codec, matching the codec's `shouldDeepFreeze` to
   * this clone's `frozen` intent (the `deepClone()` template owns the final
   * top-level freeze).
   *
   * KNOWN GAP (pre-existing): `encode()` passes `cause` and the extras through
   * by reference, so an unfrozen clone still SHARES those nested values with
   * the original -- it is not yet fully deeply independent. Pinned by a test
   * in `FabricError.test.ts`.
   */
  protected override [DEEP_CLONE_CORE](frozen: boolean): FabricError {
    const codec = FabricError[CODEC];
    const reconstructContext = new EmptyReconstructionContext(
      frozen,
      "no runtime context (FabricError deep-clone path).",
    );
    return codec.decode(
      CODEC_TYPE_TAGS.Error,
      codec.encode(this),
      reconstructContext,
    ) as FabricError;
  }

  static #codec = Object.freeze(
    new (class FabricErrorCodec extends BaseFabricCodec {
      constructor() {
        super(CODEC_TYPE_TAGS.Error, FabricError);
      }

      /** @inheritDoc */
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

      /** @inheritDoc */
      decode(
        _typeTag: string,
        state: FabricValue,
        context: ReconstructionContext,
      ): FabricValue {
        const s = state as Record<string, FabricValue>;
        const type = (s.type as string) ?? (s.name as string) ?? "Error";
        // `null` `name` means "same as `type`" (the wire-level optimization).
        const name = (s.name as string | null | undefined) ?? type;
        const message = (s.message as string) ?? "";
        const stack = s.stack as string | undefined;
        const cause = s.cause;

        const extras: Array<[string, FabricValue]> = [];
        for (const key of Object.keys(s)) {
          if (FABRIC_ERROR_RESERVED_KEYS.has(key) || isUnsafeObjectKey(key)) {
            continue;
          }
          extras.push([key, s[key]]);
        }

        const result = new FabricError({
          type,
          name,
          message,
          stack,
          cause,
          extras,
        });
        // Honor `shouldDeepFreeze`: produce the type's correct deep-frozen
        // form via its `[DEEP_FREEZE]` member (recursing through `deepFreeze`).
        return context.shouldDeepFreeze ? deepFreeze(result) : result;
      }
    })(),
  );

  /** The codec for instances of this class. */
  static get [CODEC](): FabricCodec {
    return this.#codec;
  }
}
