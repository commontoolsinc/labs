import { BaseCodecAct } from "./BaseCodecAct.ts";

/**
 * The state of one act of encoding: what {@link BaseCodecAct} holds, plus the
 * refusal a cycle gets on the way out.
 *
 * An engine mints one of these per `encode()` call, through a factory its
 * subclass supplies, and threads it through the walk. A format needing more
 * than this class's own bookkeeping -- a wire marker, say -- subclasses it
 * and holds that alongside.
 */
export class EncodeAct extends BaseCodecAct {
  /**
   * Enters a value, refusing a repeat visit.
   *
   * @throws If `value` is already being encoded. A cycle has no encoding at
   *   all, so this refuses rather than reporting, unlike its decode-side
   *   counterpart: what is being refused is a local caller's own value, not
   *   data off a channel.
   */
  enter(value: object): void {
    if (!this.tryEnter(value)) {
      throw new Error("Circular reference detected during encoding");
    }
  }
}
