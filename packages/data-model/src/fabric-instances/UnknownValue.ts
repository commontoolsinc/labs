import {
  DECONSTRUCT,
  DEEP_FREEZE,
  type FabricValue,
  IS_DEEP_FROZEN,
} from "../interface.ts";
import {
  RECONSTRUCT,
  type ReconstructionContext,
} from "../wire-common/interface.ts";
import { ExplicitTagValue } from "./ExplicitTagValue.ts";
import { deepFreeze } from "../deep-freeze.ts";

/**
 * Container for an unrecognized type's data, used for round-tripping. When the
 * serialization system encounters an unknown tag during deserialization, it
 * wraps the tag and state here; on re-serialization, it uses the preserved data
 * to produce the original wire format. See Section 3.3 of the formal spec.
 */
export class UnknownValue extends ExplicitTagValue {
  constructor(wireTypeTag: string, state: FabricValue) {
    super(wireTypeTag, state);
  }

  [DECONSTRUCT](): FabricValue {
    return { type: this.wireTypeTag, state: this.state };
  }

  /**
   * Deep-freezes in place.
   */
  [DEEP_FREEZE](
    subFreeze: (value: FabricValue) => FabricValue,
  ): FabricValue {
    subFreeze(this.state);
    return Object.freeze(this) as unknown as FabricValue;
  }

  /**
   * Side-effect-free check mirroring `[DEEP_FREEZE]`'s canonical form: this
   * wrapper is frozen and `state` is recursively deep-frozen. Never throws.
   */
  [IS_DEEP_FROZEN](
    subIsDeepFrozen: (value: FabricValue) => boolean,
  ): boolean {
    return Object.isFrozen(this) && subIsDeepFrozen(this.state);
  }

  /** @inheritDoc */
  deepClone(_frozen: boolean): UnknownValue {
    throw new Error("Cannot yet handle deep cloning of `UnknownValue`.");
  }

  protected shallowUnfrozenClone(): UnknownValue {
    return new UnknownValue(this.wireTypeTag, this.state);
  }

  static [RECONSTRUCT](
    state: { type: string; state: FabricValue },
    context: ReconstructionContext,
  ): UnknownValue {
    const result = new UnknownValue(state.type, state.state);
    // Honor `shouldDeepFreeze`: produce the type's correct deep-frozen form
    // via its `[DEEP_FREEZE]` member (recursing through `deepFreeze`).
    return context.shouldDeepFreeze ? deepFreeze(result) : result;
  }
}
