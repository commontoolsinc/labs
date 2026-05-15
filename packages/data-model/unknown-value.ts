import {
  DECONSTRUCT,
  DEEP_FREEZE,
  type FabricValue,
  RECONSTRUCT,
  type ReconstructionContext,
} from "./interface.ts";
import { ExplicitTagValue } from "./explicit-tag-value.ts";

/**
 * Container for an unrecognized type's data, used for round-tripping. When
 * the serialization system encounters an unknown tag during deserialization,
 * it wraps the tag and state here; on re-serialization, it uses the preserved
 * `typeTag` to produce the original wire format. See Section 3.3 of the
 * formal spec.
 */
export class UnknownValue extends ExplicitTagValue {
  constructor(typeTag: string, state: FabricValue) {
    super(typeTag, state);
  }

  [DECONSTRUCT](): FabricValue {
    return { type: this.typeTag, state: this.state };
  }

  /** @inheritDoc */
  [DEEP_FREEZE](
    _subFreeze: (value: FabricValue) => FabricValue,
  ): FabricValue {
    throw new Error("Cannot yet deep-freeze `UnknownValue`.");
  }

  /** @inheritDoc */
  deepClone(_frozen: boolean): UnknownValue {
    throw new Error("Cannot yet handle deep cloning of `UnknownValue`.");
  }

  protected shallowUnfrozenClone(): UnknownValue {
    return new UnknownValue(this.typeTag, this.state);
  }

  static [RECONSTRUCT](
    state: { type: string; state: FabricValue },
    _context: ReconstructionContext,
  ): UnknownValue {
    return new UnknownValue(state.type, state.state);
  }
}
