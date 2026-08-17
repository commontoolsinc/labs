import type { LiveEnvironment } from "@/codec-interface/interface.ts";

/**
 * The state of one act of encoding: the live environment the caller supplied,
 * and whatever the walk carries from node to node.
 *
 * An engine mints one of these per `encode()` call, through a factory its
 * subclass supplies, and threads it through the walk. A format needing more
 * than this class's own bookkeeping -- a wire marker, say -- subclasses it
 * and holds that alongside.
 *
 * Per call rather than per engine, because an engine may be re-entered: a
 * codec can reach back through a public entry point while a walk is already in
 * progress, and state held on the engine would be shared between the two.
 */
export class EncodeContext {
  readonly #env: LiveEnvironment;

  /**
   * The values whose encoding is in progress, or `undefined` before the first
   * container is entered.
   */
  #seen: Set<object> | undefined;

  /**
   * Constructs an instance.
   *
   * The environment is held for the same reason the decode side holds one: a
   * codec may need to reach the running system to encode a value, and the
   * alternative is threading it beside the context through every walk method.
   * An engine whose caller named none passes the null environment, so a codec
   * that does reach for one fails by name rather than by `undefined`.
   */
  constructor(env: LiveEnvironment) {
    this.#env = env;
  }

  /** The live environment this encode was given. */
  get env(): LiveEnvironment {
    return this.#env;
  }

  /**
   * Enters a value, refusing a repeat visit.
   *
   * The set behind this is created here rather than in the constructor, so
   * that encoding a lone self-representing value -- much the commonest case,
   * and the one where a fixed cost shows up most -- allocates nothing beyond
   * the context itself.
   *
   * @throws If `value` is already being encoded. A cycle has no encoding at
   *   all, so this refuses rather than reporting, unlike its decode-side
   *   counterpart: what is being refused is a local caller's own value, not
   *   data off a channel.
   */
  enter(value: object): void {
    const seen = this.#seen ??= new Set();

    if (seen.has(value)) {
      throw new Error("Circular reference detected during encoding");
    }

    seen.add(value);
  }

  /** Leaves a value, its encoding being finished. */
  leave(value: object): void {
    this.#seen?.delete(value);
  }
}
