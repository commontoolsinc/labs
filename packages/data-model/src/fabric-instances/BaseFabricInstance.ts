import { FabricInstance } from "../interface.ts";

/**
 * Abstract base class providing shared scaffolding for `FabricInstance`
 * subclasses. Concrete `FabricInstance` classes extend this, not
 * `FabricInstance` directly: `FabricInstance` is the pure abstract protocol
 * (the `instanceof`-able contract that external code is written against), while
 * `BaseFabricInstance` is where shared template-method implementations live.
 *
 * TODO(danfuzz): `deepClone()` should grow a base implementation here that
 * defers to a sibling `protected abstract` method (mirroring the
 * `shallowClone()`/`shallowUnfrozenClone()` template-method split), at which
 * point individual subclasses stop implementing `deepClone()` directly.
 */
export abstract class BaseFabricInstance extends FabricInstance {
  //
  // Instance members
  //

  /**
   * The type tag to use for this instance to identify it in wire protocols.
   */
  abstract get wireTypeTag(): string;

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

  //
  // Static members
  //

  /**
   * Gets the `.wireTypeTag` from a value which is _supposed_ to be an instance
   * of this class but is only statically known / assumed to be an instance of
   * the fully abstract `FabricInstance`. Throws a "shouldn't happen" error if
   * there's trouble.
   */
  static wireTypeTagOf(value: FabricInstance): string {
    if (!(value instanceof BaseFabricInstance)) {
      throw new Error(
        "Shouldn't happen: Encountered a `FabricInstance` which is not a `BaseFabricInstance`.",
      );
    }

    const result = value.wireTypeTag;

    if (typeof result !== "string") {
      throw new Error(
        "Shouldn't happen: Encountered a `BaseFabricInstance` with a non-string `wireTypeTag`.",
      );
    }

    return result;
  }
}
