import type { StorableValue } from "./interface.ts";
import {
  DECONSTRUCT,
  RECONSTRUCT,
  type ReconstructionContext,
  type StorableInstance,
} from "./storable-protocol.ts";
import { ExplicitTagStorable } from "./explicit-tag-storable.ts";

/**
 * Holds an unrecognized type's data for round-tripping. When the serialization
 * system encounters an unknown tag during deserialization, it wraps the tag and
 * state here; on re-serialization, it uses the preserved `typeTag` to produce
 * the original wire format. See Section 3.3 of the formal spec.
 */
export class UnknownStorable extends ExplicitTagStorable
  implements StorableInstance {
  constructor(typeTag: string, state: StorableValue) {
    super(typeTag, state);
  }

  [DECONSTRUCT](): StorableValue {
    return { type: this.typeTag, state: this.state };
  }

  static [RECONSTRUCT](
    state: { type: string; state: StorableValue },
    _context: ReconstructionContext,
  ): UnknownStorable {
    return new UnknownStorable(state.type, state.state);
  }
}
