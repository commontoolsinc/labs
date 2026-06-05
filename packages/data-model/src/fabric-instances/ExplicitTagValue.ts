import type { FabricValue } from "@/interface.ts";
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
  /** The value of {@link #wireTypeTag}. */
  readonly #wireTypeTag;

  /** The value of {@link #state}. */
  readonly #state;

  constructor(
    /** The original wire type tag, e.g. `"FutureType@2"`. */
    wireTypeTag: string,
    /** The raw state. */
    state: FabricValue,
  ) {
    super();

    this.#wireTypeTag = wireTypeTag;
    this.#state = state; // TODO(danfuzz): Should be guaranteed deep-frozen.
  }

  /** Arbitrary raw instance state. */
  get state(): FabricValue {
    return this.#state;
  }

  /** @inheritDoc */
  get wireTypeTag(): string {
    return this.#wireTypeTag;
  }
}
