import type { FabricValue } from "@/interface.ts";
import {
  DEEP_CLONE_CORE,
  DEEP_FREEZE,
  IS_DEEP_FROZEN,
  SHALLOW_UNFROZEN_CLONE,
} from "./BaseFabricInstance.ts";
import {
  CODEC,
  type NonterminalCodec,
  type ReconstructionContext,
} from "@/codec-interface/interface.ts";
import { BaseNonterminalCodec } from "@/codec-interface/BaseNonterminalCodec.ts";
import { ExplicitTagValue } from "./ExplicitTagValue.ts";
import { deepFreeze } from "@/deep-freeze.ts";
import { isFabricValue } from "@/type-check.ts";
import { toCompactDebugString } from "@/value-debug.ts";

/**
 * Container for a value whose deconstruction or reconstruction failed.
 * Preserves the original tag and raw state for round-tripping and debugging.
 * Used in lenient mode to allow graceful degradation rather than hard
 * failures. See Section 3.5 of the formal spec.
 *
 * `state` is whatever was at fault, which is why the constructor takes
 * anything at all: a wire format's states need not be `FabricValue`s, and the
 * one thing this class must not do is fail while reporting a failure. What is
 * already a `FabricValue` is kept exactly; anything else is replaced by a
 * debug rendering of it.
 *
 * The rendering is deliberately not a conversion. A `Uint8Array` could be
 * turned into a `FabricBytes` and a `RegExp` into a `FabricRegExp`, and doing
 * so would misreport the wire: a reader would find a `FabricBytes` in `state`
 * and conclude the payload carried one, when it carried raw bytes this format
 * does not accept. A string plainly reads as a description of the value rather
 * than the value, which is the honest answer where fidelity is not available.
 */
export class ProblematicValue extends ExplicitTagValue {
  /** Value for {@link #error}. */
  readonly #error;

  /**
   * Constructs an instance for the given tag and state, with `error`
   * describing what went wrong.
   *
   * @param wireTypeTag - The tag the faulty data arrived under.
   * @param state - What was at fault, of any type whatsoever. Kept as-is if it
   *   is a `FabricValue`, and otherwise replaced by a debug rendering.
   * @param error - Description of what went wrong.
   */
  constructor(wireTypeTag: string, state: any, error: string) {
    super(
      wireTypeTag,
      isFabricValue(state) ? state : toCompactDebugString(state, 200),
    );

    this.#error = error;
  }

  /** Description of what went wrong. */
  get error(): string {
    return this.#error;
  }

  /** Deep-freezes in place. */
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

  /** @inheritDoc Not yet implemented, so `deepClone()` throws. */
  protected [DEEP_CLONE_CORE](_frozen: boolean): ProblematicValue {
    throw new Error("Cannot yet handle deep cloning of `ProblematicValue`.");
  }

  protected [SHALLOW_UNFROZEN_CLONE](): ProblematicValue {
    return new ProblematicValue(this.wireTypeTag, this.state, this.error);
  }

  static #codec = Object.freeze(
    new (class ProblematicValueCodec extends BaseNonterminalCodec {
      /** Constructs an instance. */
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
  static get [CODEC](): NonterminalCodec {
    return this.#codec;
  }
}
