/**
 * Empty `ReconstructionContext`: a singleton whose `getCell()` always throws.
 * Useful as a default for decode paths that aren't expected to encounter
 * `Cell` references (e.g. storage-boundary reads of values known to be
 * structurally flat).
 */

import type { Constructor } from "@commonfabric/utils/types";
import type { FabricValue } from "@/interface.ts";
import type { FabricCodec, ReconstructionContext } from "./interface.ts";

/**
 * Base class for `FabricCodec` which provides commonly-needed functionality.
 */
export abstract class BaseFabricCodec implements FabricCodec {
  #wireTypeTag: string;
  #uniqueHandledClass: Constructor | undefined;

  /**
   * Constructs an instance.
   */
  constructor(
    /** The preferred wire type tag. */
    wireTypeTag: string,
    /**
     * The unique class (constructor function), if any, whose _direct_ instances
     * this instance handles.
     */
    uniqueHandledClass: Constructor | undefined,
  ) {
    this.#wireTypeTag = wireTypeTag;
    this.#uniqueHandledClass = uniqueHandledClass;
  }

  /** @inheritDoc */
  get uniqueHandledClass(): Constructor | undefined {
    return this.#uniqueHandledClass;
  }

  /** @inheritDoc */
  get wireTypeTag(): string {
    return this.#wireTypeTag;
  }

  /** @innheritDoc */
  canEncode(value: FabricValue): boolean {
    const cls = this.#uniqueHandledClass;

    return (cls !== undefined) && (value instanceof cls);
  }

  /** @inheritDoc */
  abstract decode(
    wireTypeTag: string,
    state: FabricValue,
    context: ReconstructionContext,
  ): FabricValue;

  /** @inheritDoc */
  abstract encode(value: FabricValue): FabricValue;
}
