import { DEEP_FREEZE, type FabricValue, IS_DEEP_FROZEN } from "@/interface.ts";
import {
  CODEC,
  DECONSTRUCT,
  type FabricCodec,
  RECONSTRUCT,
  type ReconstructionContext,
} from "@/wire-common/interface.ts";
import { BaseFabricCodec } from "@/wire-common/BaseFabricCodec.ts";
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
   * @inheritDoc
   *
   * Delegates to this class's `[CODEC]`, the source of truth for the encoded
   * form.
   */
  [DECONSTRUCT](): FabricValue {
    return UnknownValue[CODEC].encode(this);
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

  /**
   * Reconstructs an `UnknownValue` from its essential state. Delegates to this
   * class's `[CODEC]`, the source of truth for decoding.
   */
  static [RECONSTRUCT](
    state: { type: string; state: FabricValue },
    context: ReconstructionContext,
  ): UnknownValue {
    return UnknownValue[CODEC].decode(
      state.type,
      state,
      context,
    ) as UnknownValue;
  }

  static #codec = Object.freeze(
    new (class UnknownValueCodec extends BaseFabricCodec {
      constructor() {
        // No preferred wire tag: an `UnknownValue` round-trips to its
        // *preserved* tag, which varies per instance.
        super(undefined, UnknownValue);
      }

      /**
       * @inheritDoc
       *
       * Reads the preserved per-instance tag off the value.
       */
      override tagForValue(value: UnknownValue): string {
        return value.wireTypeTag;
      }

      /**
       * @inheritDoc
       *
       * Deconstructs into a `{ type, state }` envelope carrying the preserved
       * tag and raw state. Does NOT recurse into `state` -- the serialization
       * system handles that.
       */
      encode(value: UnknownValue): FabricValue {
        return { type: value.wireTypeTag, state: value.state };
      }

      /**
       * @inheritDoc
       *
       * Reconstructs an `UnknownValue` from its `{ type, state }` envelope.
       * Honors `context.shouldDeepFreeze`.
       */
      decode(
        _wireTypeTag: string,
        state: FabricValue,
        context: ReconstructionContext,
      ): FabricValue {
        const s = state as { type: string; state: FabricValue };
        const result = new UnknownValue(s.type, s.state);
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
