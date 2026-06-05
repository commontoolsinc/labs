/**
 * Empty `ReconstructionContext`: a singleton whose `getCell()` always throws.
 * Useful as a default for decode paths that aren't expected to encounter
 * `Cell` references (e.g. storage-boundary reads of values known to be
 * structurally flat).
 */

import type { FabricValue } from "@/interface.ts";
import type { FabricCodec } from "./interface.ts";

/** Standard type meaning "class" a/k/a constructor function. */
type Constructor<T = unknown> = abstract new (...args: any[]) => T;

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
  get wireTypeTag(): string {
    return this.#wireTypeTag;
  }

  /** @innheritDoc */
  canEncode(value: FabricValue): boolean {
    const cls = this.#uniqueHandledClass;

    return (cls !== undefined) && (value instanceof cls);
  }

  /** @inheritDoc */
  abstract decode(state: FabricValue, wireTypeTag: string): FabricValue;

  /** @inheritDoc */
  abstract encode(value: FabricValue): FabricValue;
}
