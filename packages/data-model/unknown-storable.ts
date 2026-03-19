import type { FabricValue } from "./fabric-value.ts";
import { DECONSTRUCT, RECONSTRUCT } from "./storable-instance.ts";
import type { ReconstructionContext } from "./storable-protocol.ts";
import { ExplicitTagStorable } from "./explicit-tag-storable.ts";

/**
 * Holds an unrecognized type's data for round-tripping. When the serialization
 * system encounters an unknown tag during deserialization, it wraps the tag and
 * state here; on re-serialization, it uses the preserved `typeTag` to produce
 * the original wire format. See Section 3.3 of the formal spec.
 */
export class UnknownStorable extends ExplicitTagStorable {
  constructor(typeTag: string, state: FabricValue) {
    super(typeTag, state);
  }

  [DECONSTRUCT](): FabricValue {
    return { type: this.typeTag, state: this.state };
  }

  protected shallowUnfrozenClone(): UnknownStorable {
    return new UnknownStorable(this.typeTag, this.state);
  }

  static [RECONSTRUCT](
    state: { type: string; state: FabricValue },
    _context: ReconstructionContext,
  ): UnknownStorable {
    return new UnknownStorable(state.type, state.state);
  }
}
