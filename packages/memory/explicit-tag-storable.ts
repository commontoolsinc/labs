import type { StorableValue } from "./interface.ts";

/**
 * Base class for storable types that carry an explicit wire-format tag.
 * Used by `UnknownStorable` (unrecognized types) and `ProblematicStorable`
 * (failed deconstruction/reconstruction). Enables a single `instanceof`
 * check where code needs to handle both.
 *
 * See Section 3.2 of the formal spec.
 */
export abstract class ExplicitTagStorable {
  constructor(
    /** The original type tag, e.g. `"FutureType@2"`. */
    readonly typeTag: string,
    /** The raw state, already recursively processed by the deserializer. */
    readonly state: StorableValue,
  ) {}
}
