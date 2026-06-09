import { DEEP_FREEZE, type FabricValue, IS_DEEP_FROZEN } from "@/interface.ts";
import {
  CODEC,
  DECONSTRUCT,
  type FabricCodec,
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
   * Returns the `{ type, state }` envelope (preserved tag and raw state). This
   * is the protocol/hashing form; the wire form (via `[CODEC]`) is the bare
   * `state`, with the tag carried separately.
   */
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
       * Returns the bare inner `state`. The tag travels separately (via
       * {@link #tagForValue}), so an `UnknownValue` round-trips to the same
       * storage form as the value it stands in for. Does NOT recurse into
       * `state` -- the serialization system handles that.
       */
      encode(value: UnknownValue): FabricValue {
        return value.state;
      }

      /**
       * @inheritDoc
       *
       * Reconstructs an `UnknownValue` from its wire `wireTypeTag` and bare
       * `state`. Honors `context.shouldDeepFreeze`.
       */
      decode(
        wireTypeTag: string,
        state: FabricValue,
        context: ReconstructionContext,
      ): FabricValue {
        const result = new UnknownValue(wireTypeTag, state);
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
