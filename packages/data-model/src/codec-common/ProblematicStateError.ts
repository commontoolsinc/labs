import type { FabricValue } from "@/interface.ts";
import { toCompactDebugString } from "@/value-debug.ts";
import { toReportableState } from "./toReportableState.ts";

/**
 * Error thrown when a state cannot be decoded and the engine is not lenient.
 * The strict-mode counterpart of `ProblematicValue`: the same three facts --
 * the tag, the state at fault, and what is wrong with it -- disposed of by
 * throwing rather than by being returned in the result. Which of the two a
 * caller gets is settled by `lenient` alone.
 *
 * Carrying the state is the point. A bare `Error` reduces it to whatever the
 * message happens to quote, so a caller that wants to inspect what actually
 * arrived has to parse prose. `state` holds it in the same form
 * `ProblematicValue` would, via {@link toReportableState}.
 */
export class ProblematicStateError extends Error {
  /** Value for {@link #wireTypeTag}. */
  readonly #wireTypeTag: string;

  /** Value for {@link #state}. */
  readonly #state: FabricValue;

  /**
   * Constructs an instance.
   *
   * @param wireTypeTag - The tag the faulty data arrived under.
   * @param state - What was at fault, of any type whatsoever; rendered if it
   *   is not a `FabricValue`.
   * @param message - What is wrong with it.
   * @param options - Standard `Error` options, notably `cause`.
   */
  constructor(
    wireTypeTag: string,
    state: any,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);

    this.name = "ProblematicStateError";
    this.#wireTypeTag = wireTypeTag;
    this.#state = toReportableState(state);
  }

  /** The tag the faulty data arrived under. */
  get wireTypeTag(): string {
    return this.#wireTypeTag;
  }

  /** What was at fault, in reportable form. */
  get state(): FabricValue {
    return this.#state;
  }

  //
  // Static members
  //

  /**
   * Answers with an instance accounting for something a codec threw, which
   * JavaScript permits to be any value at all. An `Error` contributes its
   * message and is kept as `cause`, so nothing about it is lost to a caller
   * willing to look; anything else is rendered, there being no message to
   * take.
   *
   * Where `thrown` is already an instance bearing this same tag and state, it
   * is returned as it stands rather than wrapped.
   *
   * @param wireTypeTag - The tag the faulty data arrived under.
   * @param state - The state the codec was handed.
   * @param thrown - Whatever the codec threw.
   */
  static fromThrown(
    wireTypeTag: string,
    state: any,
    thrown: unknown,
  ): ProblematicStateError {
    const reportable = toReportableState(state);

    if (
      (thrown instanceof ProblematicStateError) &&
      (thrown.wireTypeTag === wireTypeTag) && (thrown.state === reportable)
    ) {
      // Already an account of this same failure. Wrapping it would say
      // nothing the original does not, at the cost of a `cause` chain a
      // reader has to walk to reach the message that matters.
      return thrown;
    }

    return new ProblematicStateError(
      wireTypeTag,
      reportable,
      (thrown instanceof Error) ? thrown.message : toCompactDebugString(thrown),
      { cause: thrown },
    );
  }
}
