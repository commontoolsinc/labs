import type { StorableValue } from "./interface.ts";
import {
  DECONSTRUCT,
  RECONSTRUCT,
  type ReconstructionContext,
  type StorableInstance,
} from "./storable-protocol.ts";

/**
 * Holds an unrecognized type's data for round-tripping. When the serialization
 * system encounters an unknown tag during deserialization, it wraps the tag and
 * state here; on re-serialization, it uses the preserved `typeTag` to produce
 * the original wire format. See Section 3.2 of the formal spec.
 */
export class UnknownStorable implements StorableInstance {
  constructor(
    /** The original type tag, e.g. `"FutureType@2"`. */
    readonly typeTag: string,
    /** The raw state, already recursively processed by the deserializer. */
    readonly state: StorableValue,
  ) {}

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
