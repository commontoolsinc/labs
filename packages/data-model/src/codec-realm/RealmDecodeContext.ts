import { DecodeContext } from "@/codec-common/DecodeContext.ts";
import type { LiveEnvironment } from "@/codec-interface/interface.ts";
import type { RealmFormatMarker } from "./interface.ts";

/**
 * The state of one act of realm decoding: the walk's own bookkeeping, plus the
 * marker the incoming envelope arrived under.
 */
export class RealmDecodeContext extends DecodeContext {
  /** The sender's marker, or `undefined` if the envelope carried none. */
  readonly #marker: RealmFormatMarker | undefined;

  /**
   * Constructs an instance.
   *
   * The marker comes from the envelope this act is decoding, which is why it
   * arrives here rather than being minted: structured cloning preserves shared
   * references, so the object at slot zero of the envelope is the same object
   * at slot zero of every tagged form beneath it, and `===` finds them.
   * Adopting one minted on this side would recognize nothing.
   *
   * `undefined` where the form carried nothing recognizable. This runs before
   * anything has established that the form is this format's, so it takes what
   * is there and leaves the refusing to the engine's conversion step.
   */
  constructor(env: LiveEnvironment, marker?: RealmFormatMarker) {
    super(env);
    this.#marker = marker;
  }

  /**
   * The marker this act recognizes a tagged form by, or `undefined` if the
   * envelope carried none.
   *
   * A context without one recognizes nothing, which is the safe answer rather
   * than a degenerate one: `undefined` is a value this format carries, so a
   * payload can put one in slot zero for free, and identity against an absent
   * marker would match it.
   */
  get marker(): RealmFormatMarker | undefined {
    return this.#marker;
  }
}
