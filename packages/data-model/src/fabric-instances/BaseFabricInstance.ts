import { FabricInstance, type FabricValue } from "@/interface.ts";

/**
 * Well-known symbol for deeply freezing a fabric instance in place. The method
 * freezes the instance's own internal slot(s) and recurses into any nested
 * `FabricValue`s via the provided `subFreeze` callback. This is an abstract
 * member of `BaseFabricInstance`, so the generic `deepFreeze()` operates on any
 * fabric instance by gating on `instanceof` against `BaseFabricInstance` and
 * invoking this member -- it does not enumerate concrete subclasses.
 * Distinct from `deepClone()`: `[DEEP_FREEZE]` freezes the existing instance
 * in place; `deepClone()` constructs a new instance.
 */
export const DEEP_FREEZE: unique symbol = Symbol.for("common.deepFreeze");

/**
 * Well-known symbol for checking whether a fabric instance is already deeply
 * frozen, without mutating it. The sibling-of-`[DEEP_FREEZE]` *check*: it
 * verifies the instance's own internal slot(s) are in canonical deep-frozen
 * form and recurses into any nested `FabricValue`s via the provided
 * `subIsDeepFrozen` callback, returning the boolean conjunction. This is an
 * abstract member of `BaseFabricInstance`, so the generic deep-frozen type
 * guard operates on any fabric instance by gating on `instanceof` against
 * `BaseFabricInstance` and invoking this member -- it does not enumerate
 * concrete subclasses.
 *
 * Unlike `[DEEP_FREEZE]`, this method is side-effect-free and never throws:
 * a not-in-canonical-deep-frozen-form instance answers `false`, it does not
 * crash. (`[DEEP_FREEZE]` is a mutator and uses "death before confusion" on
 * a malformed internal slot; a status check must not.)
 */
export const IS_DEEP_FROZEN: unique symbol = Symbol.for(
  "common.isDeepFrozen",
);

/**
 * Abstract base class providing shared scaffolding for `FabricInstance`
 * subclasses. Concrete `FabricInstance` classes extend this, not
 * `FabricInstance` directly: `FabricInstance` is the pure abstract protocol
 * (the `instanceof`-able contract that external code is written against), while
 * `BaseFabricInstance` is where shared template-method implementations and the
 * freeze-protocol plumbing (`[DEEP_FREEZE]()`, `[IS_DEEP_FROZEN]()`) live.
 *
 * TODO(danfuzz): `deepClone()` should grow a base implementation here that
 * defers to a sibling `protected abstract` method (mirroring the
 * `shallowClone()`/`shallowUnfrozenClone()` template-method split), at which
 * point individual subclasses stop implementing `deepClone()` directly.
 */
export abstract class BaseFabricInstance extends FabricInstance {
  //
  // Static members
  //

  /**
   * Type guard for `BaseFabricInstance`, which also enforces the invariant that
   * every `FabricInstance` is in fact a `BaseFabricInstance`. Concrete
   * fabric-instance classes are required to extend `BaseFabricInstance` (never
   * `FabricInstance` directly), so a value that is a `FabricInstance` but not a
   * `BaseFabricInstance` indicates a broken subclass. Use this in preference to
   * a bare `instanceof BaseFabricInstance` where dispatch relies on the members
   * declared here (e.g. the generic freeze machinery), so the invariant is
   * actively enforced rather than silently skipped.
   *
   * @throws If `value` is a `FabricInstance` that is not a `BaseFabricInstance`
   *   -- the "shouldn't happen" invariant violation.
   */
  static isInstance(value: unknown): value is BaseFabricInstance {
    if (value instanceof BaseFabricInstance) {
      return true;
    } else if (value instanceof FabricInstance) {
      throw new Error(
        "Shouldn't happen: `FabricInstance` that is not a `BaseFabricInstance`.",
      );
    }

    return false;
  }

  //
  // Instance members
  //

  /**
   * Deeply freezes this instance in place: freezes this instance's own
   * internal slot(s) and recurses into each nested `FabricValue` by calling
   * the provided `subFreeze` callback on it. Implementations must NOT import
   * or call `deepFreeze()` directly -- recursion is handed through the
   * callback so that the freeze utility's caching / cycle-detection
   * bookkeeping is preserved and no import cycle is introduced.
   *
   * Returns the (now deeply-frozen) value. Freeze-in-place implementations
   * return `this`.
   */
  abstract [DEEP_FREEZE](
    subFreeze: (value: FabricValue) => FabricValue,
  ): FabricValue;

  /**
   * Indicates whether this instance is already deeply frozen, without
   * mutating it. Checks this instance's own internal slot(s) are in
   * canonical deep-frozen form and recurses into each nested `FabricValue`
   * via the provided `subIsDeepFrozen` callback, returning the boolean
   * conjunction. Implementations must NOT import or call the deep-frozen
   * type guard directly -- recursion is handed through the callback,
   * mirroring `[DEEP_FREEZE]`'s callback shape and avoiding an import cycle.
   *
   * Side-effect-free and must not throw: an instance that is not in
   * canonical deep-frozen form returns `false`.
   */
  abstract [IS_DEEP_FROZEN](
    subIsDeepFrozen: (value: FabricValue) => boolean,
  ): boolean;

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
    // Cast needed: `Object.freeze()` returns `Readonly<T>`, which TS considers
    // incompatible with abstract class types due to protected members.
    return frozen ? Object.freeze(copy) as FabricInstance : copy;
  }
}
