import type { LiveEnvironment } from "@/codec-interface/interface.ts";

/**
 * The state of one act of decoding: the live environment the caller supplied,
 * and whatever the walk carries from node to node.
 *
 * An engine mints one of these per `decode()` call, through a factory its
 * subclass supplies. The environment is held here rather than threaded
 * separately because every walk method needs both, and a format needing more
 * -- a wire marker read off the incoming envelope, say -- subclasses this and
 * holds that alongside.
 *
 * Per call rather than per engine, for the reason `EncodeContext` gives, and
 * additionally because the environment is a per-call argument to begin with.
 */
export class DecodeContext {
  readonly #env: LiveEnvironment;

  /**
   * The nodes whose decoding is in progress, or `null` for a format that
   * cannot be handed a cycle.
   */
  readonly #seen: Set<object> | null;

  /**
   * Constructs an instance.
   *
   * `guardCycles` is the format's decision, not a caller's, and turns on
   * whether the format's transport can carry a graph. A format whose input it
   * parses for itself is handed a tree by construction and pays nothing here;
   * one handed a tree it did not build starts a set. Getting this wrong in the
   * permissive direction costs a set per decode and nothing else; in the other
   * direction it is an unbounded walk on hostile input.
   */
  constructor(env: LiveEnvironment, guardCycles = false) {
    this.#env = env;
    this.#seen = guardCycles ? new Set() : null;
  }

  /** The live environment this decode was given. */
  get env(): LiveEnvironment {
    return this.#env;
  }

  /**
   * Enters a node, if this context guards cycles at all.
   *
   * @returns `true` if the node was entered, `false` if it was already in
   *   progress -- which is a cycle, and the caller's to report. Reported
   *   rather than raised, unlike the encode side's refusal: a cycle here
   *   arrived from a channel, and every malformation off a channel settles
   *   against the engine's leniency.
   */
  enter(value: object): boolean {
    if (this.#seen === null) {
      return true;
    } else if (this.#seen.has(value)) {
      return false;
    }

    this.#seen.add(value);
    return true;
  }

  /** Leaves a node, its decoding being finished. */
  leave(value: object): void {
    this.#seen?.delete(value);
  }
}
