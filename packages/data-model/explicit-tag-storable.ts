import type { FabricValue } from "./fabric-value.ts";
import { FabricInstance } from "./storable-instance.ts";

/**
 * Base class for storable types that carry an explicit wire-format tag.
 * Used by `UnknownStorable` (unrecognized types) and `ProblematicStorable`
 * (failed deconstruction/reconstruction). Enables a single `instanceof`
 * check where code needs to handle both.
 *
 * Extends `FabricInstance` so subclasses inherit the `shallowClone()` method.
 *
 * See Section 3.2 of the formal spec.
 */
export abstract class ExplicitTagStorable extends FabricInstance {
  constructor(
    /** The original type tag, e.g. `"FutureType@2"`. */
    readonly typeTag: string,
    /** The raw state, already recursively processed by the deserializer. */
    readonly state: FabricValue,
  ) {
    super();
  }
}
