import type { Constructor } from "@commonfabric/utils/types";
import type { FabricValue } from "@/interface.ts";
import type { FabricCodec, ReconstructionContext } from "./interface.ts";

/**
 * Base class for `FabricCodec` which provides commonly-needed functionality.
 */
export abstract class BaseFabricCodec implements FabricCodec {
  #recognizedTypeTag: string | undefined;
  #uniqueHandledClass: Constructor | undefined;

  /**
   * Constructs an instance.
   */
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
        "Shouldn't happen: codec has no recognized tag; `tagForValue()` must be overridden.",
      );
    }
    return this.#recognizedTypeTag;
  }

  /** @inheritDoc */
  abstract decode(
    typeTag: string,
    state: FabricValue,
    context: ReconstructionContext,
  ): FabricValue;

  /** @inheritDoc */
  abstract encode(value: FabricValue): FabricValue;
}
