import { deepFreeze } from "@/deep-freeze.ts";
import type { FabricValue } from "@/interface.ts";
import { toCompactDebugString } from "@/value-debug.ts";
import { BaseCodecAct } from "./BaseCodecAct.ts";
import { ProblematicStateError } from "./ProblematicStateError.ts";
import { ProblematicValue } from "./ProblematicValue.ts";

/**
 * The state of one act of decoding: what {@link BaseCodecAct} holds, plus how
 * this act reports wire data it finds malformed.
 *
 * An engine mints one of these per `decode()` call, through a factory its
 * subclass supplies. A format needing more -- a wire marker read off the
 * incoming envelope, say -- subclasses this and holds that alongside.
 *
 * The reporting members live here rather than on the engine because what they
 * settle is a property of the act: they run while a walk is in progress, and
 * every one of them is reached with the act already in hand.
 */
export class DecodeAct extends BaseCodecAct {
  /**
   * Enters a node, and returns whether it was entered.
   *
   * Whether a format guards cycles at all is decided by whether its walk
   * calls this: a format whose input it parses for itself is handed a tree by
   * construction, so it never does, and its set is never allocated. One
   * handed a tree it did not build enters every node it descends through.
   *
   * @returns `true` if the node was entered, `false` if it was already in
   *   progress -- which is a cycle, and the caller's to report.
   */
  enter(value: object): boolean {
    return this.tryEnter(value);
  }

  /**
   * Enters a container, reporting rather than entering if it is already in
   * progress.
   *
   * Reported rather than raised, unlike the encode side's refusal: a cycle
   * here arrived from a channel, and every malformation off a channel settles
   * against leniency. Raising unconditionally would also be the one refusal a
   * lenient decode could not contain.
   *
   * The report carries a rendering of the container rather than the container
   * itself, a cyclic graph being the one thing a `ProblematicValue` cannot
   * hold onto.
   *
   * @param value The container about to be walked.
   * @returns The report, or `null` if `value` was entered.
   * @throws If this act is not lenient.
   */
  enterOrReport(value: object): FabricValue | null {
    if (!this.enter(value)) {
      return this.reportMalformed(
        "",
        toCompactDebugString(value, 50),
        "circular reference in decoded data",
      );
    }

    return null;
  }

  /**
   * Settles a refusal of the serialized form itself against leniency: strictly
   * it raises, and leniently it becomes a `ProblematicValue`.
   *
   * A serialized form is data off a channel like any other, so being the wrong
   * shape for this format -- or the right shape around a payload that will not
   * parse -- is a malformation of the same kind as a bad state inside a
   * well-formed one, and settles the same way.
   *
   * Only this class's own refusal is settled. Anything else thrown while
   * converting a form is the format's own business and is re-raised untouched,
   * so a bug in a conversion does not come back as a `ProblematicValue`.
   *
   * Available to a format's own entry points, which reach a conversion without
   * passing through `decode()` -- `JsonCodecEngine`'s byte pair, for one.
   *
   * @throws Whatever it was given, if this act is not lenient or the throw was
   *   not a refusal.
   */
  settleSyntacticRefusal(e: unknown): FabricValue {
    if (this.config.lenient && (e instanceof ProblematicStateError)) {
      return this.reportMalformed(e.wireTypeTag, e.state, e.message);
    }

    // Rethrown rather than rebuilt, strictly: the refusal already names its
    // tag and state, and re-raising it keeps whatever `cause` it carries.
    throw e;
  }

  /**
   * Reports wire data the engine itself found malformed, settled against
   * leniency: strictly it raises, and leniently it becomes a
   * `ProblematicValue` in the result.
   *
   * A codec rejecting a state it was handed goes through the same setting.
   * Which of the two noticed is an implementation detail of where a check
   * happens to live, so it does not decide what a caller sees; leniency does.
   *
   * @param wireTypeTag The tag the malformed data arrived under, or the
   *   meta-tag naming the structure at fault. Of any type whatsoever: what
   *   sits in tag position is wire data like any other, and a tag that is not
   *   a tag is among the faults reported here. `ProblematicValue` renders what
   *   it cannot keep.
   * @param state The data at fault, of any type whatsoever, preserved so that
   *   a lenient result round-trips. A format whose states are not
   *   `FabricValue`s hands one over as it stands; `ProblematicValue` renders
   *   what it cannot keep.
   * @param error What is wrong with it, phrased to stand on its own -- it is
   *   the whole of the message when this raises.
   * @throws If this act is not lenient.
   */
  reportMalformed(
    wireTypeTag: any,
    state: any,
    error: string,
  ): FabricValue {
    if (!this.config.lenient) {
      throw new ProblematicStateError(wireTypeTag, state, error);
    }

    return deepFreeze(new ProblematicValue(wireTypeTag, state, error));
  }

  /**
   * Reports a key this runtime reserves, found in wire data, settled against
   * leniency like any other malformation.
   *
   * The names are `__proto__` and `constructor`, and what makes them a
   * boundary concern is that the walks rebuild an object by assignment: the
   * first routes through an inherited setter on a host that has one, and both
   * are refused rather than silently reshaped.
   *
   * @param key The reserved key.
   * @param state The object it was found in, preserved so a lenient result
   *   round-trips.
   * @throws If this act is not lenient.
   */
  reportReservedKey(key: string, state: any): FabricValue {
    return this.reportMalformed(
      key,
      state,
      `object contains a key this runtime reserves: "${key}"`,
    );
  }
}
