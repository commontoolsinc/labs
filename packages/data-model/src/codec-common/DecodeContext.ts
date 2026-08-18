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
   * The nodes whose decoding is in progress, or `undefined` before the first
   * node is entered.
   */
  #seen: Set<object> | undefined;

  /** Constructs an instance. */
  constructor(env: LiveEnvironment) {
    this.#env = env;
  }

  /** The live environment this decode was given. */
  get env(): LiveEnvironment {
    return this.#env;
  }

  /**
   * Enters a node, refusing a repeat visit.
   *
   * Whether a format guards cycles at all is decided by whether its walk
   * calls this: a format whose input it parses for itself is handed a tree by
   * construction, so it never does, and its set is never allocated. One
   * handed a tree it did not build enters every node it descends through.
   *
   * @returns `true` if the node was entered, `false` if it was already in
   *   progress -- which is a cycle, and the caller's to report. Reported
   *   rather than raised, unlike the encode side's refusal: a cycle here
   *   arrived from a channel, and every malformation off a channel settles
   *   against the engine's leniency.
   */
  enter(value: object): boolean {
    const seen = this.#seen ??= new Set();

    if (seen.has(value)) {
      return false;
    }

    seen.add(value);
    return true;
  }

  /** Leaves a node, its decoding being finished. */
  leave(value: object): void {
    this.#seen?.delete(value);
  }
}
