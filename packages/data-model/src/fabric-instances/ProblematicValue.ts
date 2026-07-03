import { DEEP_FREEZE, type FabricValue, IS_DEEP_FROZEN } from "@/interface.ts";
import {
  CODEC,
  type FabricCodec,
  type ReconstructionContext,
} from "@/codec-common/interface.ts";
import { BaseFabricCodec } from "@/codec-common/BaseFabricCodec.ts";
import { ExplicitTagValue } from "./ExplicitTagValue.ts";
import { deepFreeze } from "@/deep-freeze.ts";

/**
 * Container for a value whose deconstruction or reconstruction failed.
 * Preserves the original tag and raw state for round-tripping and debugging.
 * Used in lenient mode to allow graceful degradation rather than hard
 * failures. See Section 3.5 of the formal spec.
 */
export class ProblematicValue extends ExplicitTagValue {
  /** Value for {@link #error}. */
  readonly #error;

  constructor(
    wireTypeTag: string,
    state: FabricValue,
    /** Description of what went wrong. */
    error: string,
  ) {
    super(wireTypeTag, state);

    this.#error = error;
  }

  /** Description of what went wrong. */
  get error(): string {
    return this.#error;
  }

  /**
   * Deep-freezes in place.
   */
  [DEEP_FREEZE](
    subFreeze: (value: FabricValue) => FabricValue,
  ): FabricValue {
    subFreeze(this.state);
    return Object.freeze(this);
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
    return new ProblematicValue(this.wireTypeTag, this.state, this.error);
  }

  static #codec = Object.freeze(
    new (class ProblematicValueCodec extends BaseFabricCodec {
      constructor() {
        // No preferred wire tag: a `ProblematicValue` round-trips to its
        // *preserved* tag, which varies per instance.
        super(undefined, ProblematicValue);
      }

      /** @inheritDoc */
      override tagForValue(value: ProblematicValue): string {
        return value.wireTypeTag;
      }

      /** @inheritDoc */
      encode(value: ProblematicValue): FabricValue {
        return value.state;
      }

      /** @inheritDoc */
      decode(
        typeTag: string,
        state: FabricValue,
        context: ReconstructionContext,
      ): FabricValue {
        const result = new ProblematicValue(typeTag, state, "");
        // Honor `shouldDeepFreeze`: produce the type's correct deep-frozen
        // form via its `[DEEP_FREEZE]` member (recursing through `deepFreeze`).
        return context.shouldDeepFreeze ? deepFreeze(result) : result;
      }
    })(),
  );

  /** The codec for instances of this class. */
  static get [CODEC](): FabricCodec {
    return this.#codec;
  }
}
