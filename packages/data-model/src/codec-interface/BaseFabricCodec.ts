import type { Constructor } from "@commonfabric/utils/types";
import type { FabricValue } from "@/interface.ts";
import type { FabricCodec, ReconstructionContext } from "./interface.ts";

/**
 * Base class for `FabricCodec` which provides commonly-needed functionality:
 * the matching members, and a `tagForValue()` that answers with the codec's one
 * recognized tag.
 *
 * It is abstract in `encode()` and `decode()` and, deliberately, in identity:
 * extend {@link BaseNonterminalCodec} or {@link BaseTerminalCodec} rather than
 * this directly. Those two are what tell the codec system whether a state is
 * more work for the walker or the walker's final answer, a difference no
 * signature can carry -- and extending one of them fixes the `Encoded` domain
 * in the same stroke, so the declaration and its consequence cannot drift
 * apart.
 */
export abstract class BaseFabricCodec<Encoded> implements FabricCodec<Encoded> {
  #recognizedTypeTag: string | undefined;
  #uniqueHandledClass: Constructor | undefined;

  /** Constructs an instance. */
  constructor(
    /**
     * The wire type tag this codec recognizes, or `undefined` for a codec with
     * no single tag.
     */
    recognizedTypeTag: string | undefined,
    /**
     * The unique class (constructor function), if any, whose _direct_ instances
     * this instance handles.
     */
    uniqueHandledClass: Constructor | undefined,
  ) {
    this.#recognizedTypeTag = recognizedTypeTag;
    this.#uniqueHandledClass = uniqueHandledClass;
  }

  //
  // Subclass contract
  //

  /** @inheritDoc */
  abstract decode(
    typeTag: string,
    state: Encoded,
    context: ReconstructionContext,
  ): FabricValue;

  /** @inheritDoc */
  abstract encode(value: FabricValue): Encoded;

  //
  // Instance members
  //

  /** @inheritDoc */
  get uniqueHandledClass(): Constructor | undefined {
    return this.#uniqueHandledClass;
  }

  /** @inheritDoc */
  get recognizedTypeTag(): string | undefined {
    return this.#recognizedTypeTag;
  }

  /** @innheritDoc */
  canEncode(value: FabricValue): boolean {
    const cls = this.#uniqueHandledClass;

    return (cls !== undefined) && (value instanceof cls);
  }

  /**
   * @inheritDoc
   *
   * Returns this codec's {@link #recognizedTypeTag}. A codec with no recognized
   * tag (whose instances carry per-instance tags) must override this.
   */
  tagForValue(_value: FabricValue): string {
    if (this.#recognizedTypeTag === undefined) {
      throw new Error(
        "Shouldn't happen: codec has no recognized tag; `tagForValue()` must " +
          "be overridden.",
      );
    }
    return this.#recognizedTypeTag;
  }
}
