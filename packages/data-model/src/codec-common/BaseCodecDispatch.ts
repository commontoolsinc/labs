import type { Constructor } from "@commonfabric/utils/types";
import type { FabricValue } from "@/interface.ts";
import type { CodecDispatch } from "./interface.ts";

/**
 * Base class supplying the value-matching half of a codec (see
 * {@link CodecDispatch}), which both kinds implement identically. It declares
 * no `encode()` or `decode()`, because those are exactly where the two kinds
 * differ; extend {@link BaseFabricCodec} or {@link BaseTerminalCodec} rather
 * than this, so that the choice of kind is made by the `extends` clause and
 * cannot drift from the signatures beneath it.
 */
export abstract class BaseCodecDispatch implements CodecDispatch {
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
