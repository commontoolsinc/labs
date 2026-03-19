import type { FabricValue } from "./fabric-value.ts";
import { DECONSTRUCT, RECONSTRUCT } from "./fabric-instance.ts";
import type { ReconstructionContext } from "./fabric-protocol.ts";
import { ExplicitTagValue } from "./explicit-tag-value.ts";

/**
 * Holds a value whose deconstruction or reconstruction failed. Preserves the
 * original tag and raw state for round-tripping and debugging. Used in lenient
 * mode to allow graceful degradation rather than hard failures.
 * See Section 3.5 of the formal spec.
 */
export class ProblematicValue extends ExplicitTagValue {
  constructor(
    typeTag: string,
    state: FabricValue,
    /** A description of what went wrong. */
    readonly error: string,
  ) {
    super(typeTag, state);
  }

  [DECONSTRUCT](): FabricValue {
    return { type: this.typeTag, state: this.state, error: this.error };
  }

  protected shallowUnfrozenClone(): ProblematicValue {
    return new ProblematicValue(this.typeTag, this.state, this.error);
  }

  static [RECONSTRUCT](
    state: { type: string; state: FabricValue; error: string },
    _context: ReconstructionContext,
  ): ProblematicValue {
    return new ProblematicValue(state.type, state.state, state.error);
  }
}
