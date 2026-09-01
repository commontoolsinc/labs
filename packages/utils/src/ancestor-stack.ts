/**
 * The chain of values a walk is currently inside, and the answer to "is this
 * value one of them, and at what depth?" -- which is what a walk over a value
 * graph asks in order to recognize a cycle.
 *
 * The chain is held as a stack rather than as a keyed collection, because at
 * the depths a value graph actually has, scanning a short array by identity
 * costs less than hashing every value in and out again. That advantage narrows
 * as a graph deepens and reverses around depth 256, so past {@link #INDEX_AT}
 * the stack keeps an index beside itself and answers from that: how deep a
 * graph goes is the caller's business, and a scan alone would be quadratic in
 * it.
 *
 * A value may sit in the chain once. Pushing one already in it is what a
 * caller checks for and declines to do, that being the cycle it is looking
 * for, so the depth an entry records stays the depth it was pushed at.
 */
export class AncestorStack {
  /** The chain, in order, so an entry's index is its depth. */
  readonly #stack: object[] = [];

  /**
   * Depth by value, once the chain has been deep enough to want one, and
   * `undefined` until then. Kept for the rest of the walk once built: a chain
   * that reached the depth once is apt to reach it again, and rebuilding at
   * each crossing would cost more than maintaining it.
   */
  #index: Map<object, number> | undefined;

  /** Pushes a value onto the chain, at the current depth. */
  push(value: object): void {
    const depth = this.#stack.length;

    this.#stack.push(value);

    if (this.#index !== undefined) {
      this.#index.set(value, depth);
    } else if (this.#stack.length > AncestorStack.INDEX_AT) {
      const index = new Map<object, number>();

      for (let at = 0; at < this.#stack.length; at++) {
        index.set(this.#stack[at]!, at);
      }

      this.#index = index;
    }
  }

  /** Pops the deepest value off the chain. */
  pop(): void {
    const value = this.#stack.pop();

    if (value !== undefined) {
      this.#index?.delete(value);
    }
  }

  /**
   * The depth at which the given value sits in the chain, or `-1` if it is not
   * in it.
   */
  depthOf(value: object): number {
    const index = this.#index;

    if (index === undefined) {
      return this.#stack.indexOf(value);
    }

    const depth = index.get(value);

    return (depth === undefined) ? -1 : depth;
  }

  //
  // Static members
  //

  /**
   * The depth past which an index is kept. Set well below the depth at which
   * the scan and a keyed lookup cost the same, so that crossing it never costs
   * more than not having crossed it.
   */
  static readonly INDEX_AT = 64;
}
