import { FabricInstance, type FabricValue } from "@/interface.ts";
// Used only inside method bodies: this import participates in a module cycle
// with `deep-freeze.ts` (which imports this module's symbols and class for its
// generic dispatch), which is safe for call-time function use but must not be
// dereferenced during module evaluation.
import { deepFreeze, isDeepFrozen } from "@/deep-freeze.ts";

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
export const DEEP_FREEZE: unique symbol = Symbol.for("data-model.deepFreeze");

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
  "data-model.isDeepFrozen",
);

/**
 * Well-known symbol for producing a new unfrozen copy of a fabric instance with
 * the same data. This is the `protected` template-method primitive that the
 * concrete `shallowClone()` calls when it needs a fresh instance; each concrete
 * subclass implements it. Symbol-keyed as implementation plumbing (matching
 * `[DEEP_FREEZE]` / `[IS_DEEP_FROZEN]`), while `shallowClone()` stays a
 * regular-named client method.
 */
export const SHALLOW_UNFROZEN_CLONE: unique symbol = Symbol.for(
  "data-model.shallowUnfrozenClone",
);

/**
 * Well-known symbol for producing a new deep clone of a fabric instance,
 * cloning nested `FabricValue`s to the requested frozenness. This is the
 * `protected` template-method primitive that the concrete `deepClone()` calls
 * when a fresh instance is needed; each concrete subclass implements it.
 * Symbol-keyed as implementation plumbing (matching
 * `[SHALLOW_UNFROZEN_CLONE]`), while `deepClone()` stays a regular-named
 * client method. Unlike the shallow core, this core takes the `frozen` intent:
 * a deep clone's nested handling depends on it (already-deep-frozen subtrees
 * may be identity-shared when `frozen` is `true` -- the "maximal structural
 * sharing" the `deepClone()` contract promises -- but must be force-copied
 * when `frozen` is `false`).
 */
export const DEEP_CLONE_CORE: unique symbol = Symbol.for(
  "data-model.deepCloneCore",
);

/**
 * Abstract base class providing shared scaffolding for `FabricInstance`
 * subclasses. Concrete `FabricInstance` classes extend this, not
 * `FabricInstance` directly: `FabricInstance` is the pure abstract protocol
 * (the `instanceof`-able contract that external code is written against), while
 * `BaseFabricInstance` is where shared template-method implementations and the
 * freeze-protocol plumbing (`[DEEP_FREEZE]()`, `[IS_DEEP_FROZEN]()`) live.
 */
export abstract class BaseFabricInstance extends FabricInstance {
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
  protected abstract [SHALLOW_UNFROZEN_CLONE](): FabricInstance;

  /**
   * Returns a shallow clone of this instance with the requested frozenness.
   *
   * When `frozen` is `true` and this instance is already frozen, returns
   * `this` (identity optimization -- freezing is idempotent). In all other
   * cases, creates a new instance via `[SHALLOW_UNFROZEN_CLONE]()` and freezes
   * it if requested.
   */
  shallowClone(frozen: boolean): FabricInstance {
    if (frozen && Object.isFrozen(this)) return this;
    const copy = this[SHALLOW_UNFROZEN_CLONE]();
    // Cast needed: `Object.freeze()` returns `Readonly<T>`, which TS considers
    // incompatible with abstract class types due to protected members.
    return frozen ? Object.freeze(copy) as FabricInstance : copy;
  }

  /**
   * Returns a new deep clone of this instance, cloning nested `FabricValue`s
   * to the requested frozenness (see `[DEEP_CLONE_CORE]`'s symbol doc). The
   * returned instance itself is not yet frozen: the `deepClone()` template
   * method owns the identity optimization and the final freeze. Called by
   * `deepClone()` when a fresh instance is needed.
   */
  protected abstract [DEEP_CLONE_CORE](frozen: boolean): FabricInstance;

  /**
   * Returns a deep clone of this instance with the requested frozenness.
   *
   * When `frozen` is `true` and this instance is already *deeply* frozen,
   * returns `this` (identity optimization). Note the asymmetry with
   * `shallowClone()`: shallow identity gates on `Object.isFrozen(this)` (only
   * the instance's own slot need be frozen), whereas deep identity must gate
   * on `isDeepFrozen(this)` -- a shallowly-frozen instance whose nested
   * `FabricValue`s are still mutable is not safe to alias as a deep clone. In
   * all other cases, creates a new instance via `[DEEP_CLONE_CORE](frozen)`
   * and deep-freezes it if requested.
   */
  deepClone(frozen: boolean): FabricInstance {
    if (frozen && isDeepFrozen(this)) return this;
    const copy = this[DEEP_CLONE_CORE](frozen);
    return frozen ? deepFreeze(copy) : copy;
  }

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
   * This uses "death before confusion" on the mismatch: rather than quietly
   * answer `false` for a direct `FabricInstance` subclass (which would let it
   * bypass its freeze protocol and be cached as deep-frozen while only
   * shallow-frozen), it throws, surfacing the broken subclass at the point of
   * use. The throw is intentional despite the predicate-style name.
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
}
