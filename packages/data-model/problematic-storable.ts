import type { StorableValue } from "./fabric-value.ts";
import { DECONSTRUCT, RECONSTRUCT } from "./storable-instance.ts";
import type { ReconstructionContext } from "./storable-protocol.ts";
import { ExplicitTagStorable } from "./explicit-tag-storable.ts";

/**
 * Holds a value whose deconstruction or reconstruction failed. Preserves the
 * original tag and raw state for round-tripping and debugging. Used in lenient
 * mode to allow graceful degradation rather than hard failures.
 * See Section 3.5 of the formal spec.
 */
export class ProblematicStorable extends ExplicitTagStorable {
  constructor(
    typeTag: string,
    state: StorableValue,
    /** A description of what went wrong. */
    readonly error: string,
  ) {
    super(typeTag, state);
  }

  [DECONSTRUCT](): StorableValue {
    return { type: this.typeTag, state: this.state, error: this.error };
  }

  protected shallowUnfrozenClone(): ProblematicStorable {
    return new ProblematicStorable(this.typeTag, this.state, this.error);
  }

  static [RECONSTRUCT](
    state: { type: string; state: StorableValue; error: string },
    _context: ReconstructionContext,
  ): ProblematicStorable {
    return new ProblematicStorable(state.type, state.state, state.error);
  }
}
