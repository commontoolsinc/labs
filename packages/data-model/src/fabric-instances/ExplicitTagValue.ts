import type { FabricValue } from "../interface.ts";
import { BaseFabricInstance } from "./BaseFabricInstance.ts";

/**
 * Base class for fabric types that carry an explicit wire-format tag.
 * Used by `UnknownValue` (unrecognized types) and `ProblematicValue`
 * (failed deconstruction/reconstruction). Enables a single `instanceof`
 * check where code needs to handle both.
 *
 * Extends `BaseFabricInstance` so subclasses inherit the `shallowClone()`
 * template method.
 *
 * See Section 3.2 of the formal spec.
 */
export abstract class ExplicitTagValue extends BaseFabricInstance {
  constructor(
    /** The original type tag, e.g. `"FutureType@2"`. */
    readonly typeTag: string,
    /** The raw state, already recursively processed by the deserializer. */
    readonly state: FabricValue,
  ) {
    super();
  }
}
