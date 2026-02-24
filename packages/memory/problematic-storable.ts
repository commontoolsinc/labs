import type { StorableValue } from "./interface.ts";
import {
  DECONSTRUCT,
  RECONSTRUCT,
  type ReconstructionContext,
  type StorableInstance,
} from "./storable-protocol.ts";

/**
 * Holds a value whose deconstruction or reconstruction failed. Preserves the
 * original tag and raw state for round-tripping and debugging. Used in lenient
 * mode to allow graceful degradation rather than hard failures.
 * See Section 3.4 of the formal spec.
 */
export class ProblematicStorable implements StorableInstance {
  constructor(
    /** The original type tag, e.g. `"MyType@1"`. */
    readonly typeTag: string,
    /** The raw state that could not be processed. */
    readonly state: StorableValue,
    /** A description of what went wrong. */
    readonly error: string,
  ) {}

  [DECONSTRUCT](): StorableValue {
    return { type: this.typeTag, state: this.state, error: this.error };
  }

  static [RECONSTRUCT](
    state: { type: string; state: StorableValue; error: string },
    _context: ReconstructionContext,
  ): ProblematicStorable {
    return new ProblematicStorable(state.type, state.state, state.error);
  }
}
