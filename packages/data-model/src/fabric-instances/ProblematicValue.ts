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
   * @inheritDoc
   *
   * Delegates to this class's `[CODEC]`, the source of truth for the encoded
   * form.
   */
  [DECONSTRUCT](): FabricValue {
    return ProblematicValue[CODEC].encode(this);
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
  deepClone(_frozen: boolean): ProblematicValue {
    throw new Error("Cannot yet handle deep cloning of `ProblematicValue`.");
  }

  protected shallowUnfrozenClone(): ProblematicValue {
    return new ProblematicValue(this.wireTypeTag, this.state, this.error);
  }

  /**
   * Reconstructs a `ProblematicValue` from its essential state. Delegates to
   * this class's `[CODEC]`, the source of truth for decoding.
   */
  static [RECONSTRUCT](
    state: { type: string; state: FabricValue; error: string },
    context: ReconstructionContext,
  ): ProblematicValue {
    return ProblematicValue[CODEC].decode(
      state.type,
      state,
      context,
    ) as ProblematicValue;
  }

  static #codec = Object.freeze(
    new (class ProblematicValueCodec extends BaseFabricCodec {
      constructor() {
        // No preferred wire tag: a `ProblematicValue` round-trips to its
        // *preserved* tag, which varies per instance.
        super(undefined, ProblematicValue);
      }

      /**
       * @inheritDoc
       *
       * Reads the preserved per-instance tag off the value.
       */
      override tagForValue(value: ProblematicValue): string {
        return value.wireTypeTag;
      }

      /**
       * @inheritDoc
       *
       * Deconstructs into a `{ type, state, error }` envelope carrying the
       * preserved tag, raw state, and failure description. Does NOT recurse
       * into `state` -- the serialization system handles that.
       */
      encode(value: ProblematicValue): FabricValue {
        return {
          type: value.wireTypeTag,
          state: value.state,
          error: value.error,
        };
      }

      /**
       * @inheritDoc
       *
       * Reconstructs a `ProblematicValue` from its `{ type, state, error }`
       * envelope. Honors `context.shouldDeepFreeze`.
       */
      decode(
        _wireTypeTag: string,
        state: FabricValue,
        context: ReconstructionContext,
      ): FabricValue {
        const s = state as { type: string; state: FabricValue; error: string };
        const result = new ProblematicValue(s.type, s.state, s.error);
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
