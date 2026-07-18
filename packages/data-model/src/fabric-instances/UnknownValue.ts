import type { FabricValue } from "@/interface.ts";
import {
  DEEP_FREEZE,
  IS_DEEP_FROZEN,
  SHALLOW_UNFROZEN_CLONE,
} from "./BaseFabricInstance.ts";
import {
  CODEC,
  type FabricCodec,
  type ReconstructionContext,
} from "@/codec-common/interface.ts";
import { BaseFabricCodec } from "@/codec-common/BaseFabricCodec.ts";
import { ExplicitTagValue } from "./ExplicitTagValue.ts";
import { deepFreeze } from "@/deep-freeze.ts";

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

  protected [SHALLOW_UNFROZEN_CLONE](): UnknownValue {
    return new UnknownValue(this.wireTypeTag, this.state);
  }

  static #codec = Object.freeze(
    new (class UnknownValueCodec extends BaseFabricCodec {
      constructor() {
        // No preferred wire tag: an `UnknownValue` round-trips to its
        // *preserved* tag, which varies per instance.
        super(undefined, UnknownValue);
      }

      /** @inheritDoc */
      override tagForValue(value: UnknownValue): string {
        return value.wireTypeTag;
      }

      /** @inheritDoc */
      encode(value: UnknownValue): FabricValue {
        return value.state;
      }

      /** @inheritDoc */
      decode(
        typeTag: string,
        state: FabricValue,
        context: ReconstructionContext,
      ): FabricValue {
        const result = new UnknownValue(typeTag, state);
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
