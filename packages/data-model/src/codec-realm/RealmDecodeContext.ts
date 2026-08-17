import { DecodeContext } from "@/codec-common/DecodeContext.ts";
import type { RealmFormatMarker } from "./interface.ts";

/**
 * The state of one act of realm decoding: the walk's own bookkeeping, plus the
 * marker the incoming envelope arrived under.
 *
 * The marker is the sender's rather than one minted here, which is what makes
 * recognition work across the boundary: structured cloning preserves shared
 * references, so the object at slot zero of the envelope is the same object at
 * slot zero of every tagged form beneath it, and `===` finds them. Adopting
 * one minted on this side would recognize nothing.
 */
export class RealmDecodeContext extends DecodeContext {
  /** The sender's marker, or `undefined` before the envelope is read. */
  #marker: RealmFormatMarker | undefined;

  /**
   * The marker this act recognizes a tagged form by, or `undefined` if none
   * has been adopted.
   *
   * A context without one recognizes nothing, which is the safe answer rather
   * than a degenerate one: `undefined` is a value this format carries, so a
   * payload can put one in slot zero for free, and identity against an absent
   * marker would match it.
   */
  get marker(): RealmFormatMarker | undefined {
    return this.#marker;
  }

  /**
   * Adopts the marker read from the incoming envelope.
   *
   * Separate from construction because the marker is data: it is read from the
   * envelope this act is decoding, and the envelope is checked before anything
   * is taken from it. One act adopts once.
   *
   * @throws If this act has already adopted one.
   */
  adoptMarker(marker: RealmFormatMarker): void {
    if (this.#marker !== undefined) {
      throw new Error("This decode has already adopted a marker.");
    }

    this.#marker = marker;
  }
}
