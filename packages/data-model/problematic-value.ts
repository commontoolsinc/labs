import {
  DECONSTRUCT,
  DEEP_FREEZE,
  type FabricValue,
  IS_DEEP_FROZEN,
  RECONSTRUCT,
  type ReconstructionContext,
} from "./interface.ts";
import { ExplicitTagValue } from "./explicit-tag-value.ts";
import { deepFreeze } from "./deep-freeze.ts";

/**
 * Container for a value whose deconstruction or reconstruction failed.
 * Preserves the original tag and raw state for round-tripping and debugging.
 * Used in lenient mode to allow graceful degradation rather than hard
 * failures. See Section 3.5 of the formal spec.
 */
export class ProblematicValue extends ExplicitTagValue {
  constructor(
    typeTag: string,
    state: FabricValue,
    /** Description of what went wrong. */
    readonly error: string,
  ) {
    super(typeTag, state);
  }

  [DECONSTRUCT](): FabricValue {
    return { type: this.typeTag, state: this.state, error: this.error };
  }

  /**
   * Deep-freezes in place. `typeTag` and `error` are immutable strings; the
   * only `FabricValue`-typed slot is `state`, which is recursed via
   * `subFreeze` before the wrapper itself is frozen.
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
  deepClone(_frozen: boolean): ProblematicValue {
    throw new Error("Cannot yet handle deep cloning of `ProblematicValue`.");
  }

  protected shallowUnfrozenClone(): ProblematicValue {
    return new ProblematicValue(this.typeTag, this.state, this.error);
  }

  static [RECONSTRUCT](
    state: { type: string; state: FabricValue; error: string },
    context: ReconstructionContext,
  ): ProblematicValue {
    const result = new ProblematicValue(state.type, state.state, state.error);
    // Honor `shouldDeepFreeze`: produce the type's correct deep-frozen form
    // via its `[DEEP_FREEZE]` member (recursing through `deepFreeze`).
    return context.shouldDeepFreeze ? deepFreeze(result) : result;
  }
}
