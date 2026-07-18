import { FabricPrimitive } from "@/interface.ts";

/**
 * Abstract base class for `FabricPrimitive` subclasses. Concrete
 * `FabricPrimitive` classes extend this, not `FabricPrimitive` directly:
 * `FabricPrimitive` is the pure abstract contract that external code is written
 * against, while `BaseFabricPrimitive` is the designated home for shared
 * implementation. Beyond the static invariant guard below it currently adds no
 * members of its own (its counterpart `BaseFabricInstance` carries the
 * `shallowClone()` template method).
 */
export abstract class BaseFabricPrimitive extends FabricPrimitive {
  //
  // Static members
  //

  /**
   * Type guard for `BaseFabricPrimitive`, which also enforces the invariant
   * that every `FabricPrimitive` is in fact a `BaseFabricPrimitive`. Concrete
   * fabric-primitive classes are required to extend `BaseFabricPrimitive`
   * (never `FabricPrimitive` directly), so a value that is a `FabricPrimitive`
   * but not a `BaseFabricPrimitive` indicates a broken subclass. Mirrors
   * `BaseFabricInstance.isInstance()`.
   *
   * @throws If `value` is a `FabricPrimitive` that is not a
   *   `BaseFabricPrimitive` -- the "shouldn't happen" invariant violation.
   */
  static isInstance(value: unknown): value is BaseFabricPrimitive {
    if (value instanceof BaseFabricPrimitive) {
      return true;
    } else if (value instanceof FabricPrimitive) {
      throw new Error(
        "Shouldn't happen: `FabricPrimitive` that is not a `BaseFabricPrimitive`.",
      );
    }

    return false;
  }
}
