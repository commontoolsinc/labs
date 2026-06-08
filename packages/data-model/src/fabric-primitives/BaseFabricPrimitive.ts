import { FabricPrimitive } from "@/interface.ts";
import { FabricDeconstructable } from "@/wire-common/interface.ts";

/**
 * Abstract base class providing shared scaffolding for `FabricPrimitive`
 * subclasses. Concrete `FabricPrimitive` classes are intended to extend this,
 * not `FabricPrimitive` directly: `FabricPrimitive` is the pure abstract
 * contract that external code is written against, while `BaseFabricPrimitive`
 * is where shared implementation lives.
 */
export abstract class BaseFabricPrimitive extends FabricPrimitive {
  //
  // Instance members
  //

  /**
   * The type tag to use for this instance to identify it in wire protocols
   * for which instances of this type do not have a protocol-specific form.
   */
  abstract get wireTypeTag(): string;

  //
  // Static members
  //

  /**
   * Gets the `.wireTypeTag` from a value which is _supposed_ to be an instance
   * of this class but is only statically known / assumed to be an instance of
   * the fully abstract `FabricPrimitive`. Throws a "shouldn't happen" error if
   * there's trouble.
   */
  static wireTypeTagOf(value: FabricPrimitive | FabricDeconstructable): string {
    if (!(value instanceof BaseFabricPrimitive)) {
      throw new Error(
        "Shouldn't happen: Encountered a `FabricPrimitive` which is not a `BaseFabricPrimitive`.",
      );
    }

    const result = value.wireTypeTag;

    if (typeof result !== "string") {
      throw new Error(
        "Shouldn't happen: Encountered a `FabricPrimitive` with a non-string `wireTypeTag`.",
      );
    }

    return result;
  }
}
