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
   * Returns the `{ type, state, error }` envelope (preserved tag, raw state,
   * and failure description). This is the protocol/hashing form; the wire form
   * (via `[CODEC]`) is the bare `state`, with the tag carried separately.
   */
  [DECONSTRUCT](): FabricValue {
    return { type: this.wireTypeTag, state: this.state, error: this.error };
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
   * Reconstructs a `ProblematicValue` from its `[DECONSTRUCT]` envelope.
   * Forwards to `[CODEC].decode` with the preserved tag and bare state; the
   * envelope's `error` is dropped, since it is not part of the codec form.
   */
  static [RECONSTRUCT](
    state: { type: string; state: FabricValue; error: string },
    context: ReconstructionContext,
  ): ProblematicValue {
    return ProblematicValue[CODEC].decode(
      state.type,
      state.state,
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
       * Returns the bare inner `state`. The tag travels separately (via
       * {@link #tagForValue}), and the failure `error` is not part of the
       * codec form -- so a `ProblematicValue` round-trips to the same storage
       * form as the value it stands in for. Does NOT recurse into `state` --
       * the serialization system handles that.
       */
      encode(value: ProblematicValue): FabricValue {
        return value.state;
      }

      /**
       * @inheritDoc
       *
       * Reconstructs a `ProblematicValue` from its wire `wireTypeTag` and bare
       * `state`. The original failure `error` is not carried by the codec form,
       * so the result has none. Honors `context.shouldDeepFreeze`.
       */
      decode(
        wireTypeTag: string,
        state: FabricValue,
        context: ReconstructionContext,
      ): FabricValue {
        const result = new ProblematicValue(wireTypeTag, state, "");
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
