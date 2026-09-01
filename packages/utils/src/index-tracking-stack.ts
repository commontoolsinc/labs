/**
 * A stack of values offering `Array`-style {@link #indexOf} and {@link
 * #lastIndexOf}. A value's index is counted from the bottom, so the first
 * value pushed is at index `0`, and an index does not change while things are
 * pushed above it.
 *
 * Values are compared the way `Map` compares its keys: by identity for an
 * object, by value for a primitive, and `NaN` matching itself. That is not
 * what `Array.prototype.indexOf` does -- it compares strictly, and so never
 * finds a `NaN` -- which matters here because both are used, and the two have
 * to agree.
 *
 * Both lookups are answered by scanning while the stack is short, and by an
 * index once it has reached {@link #ADD_INDEX_AT} values. Which one is used
 * is not observable beyond the cost: a scan is linear in the stack's height
 * where a keyed lookup is not, and the two are within reach of each other only
 * over a range that a short stack sits well below.
 *
 * What the marks weigh is the whole of a stack's use, maintenance included,
 * rather than a lookup on its own. Where an index exists it is used, at any
 * height: maintaining it is what a short stack is being spared, and that is
 * already spent by the time a lookup asks.
 *
 * The index is dropped again once the stack falls below
 * {@link #DROP_INDEX_BELOW}, so a stack that grew tall once and came back down
 * goes back to scanning rather than paying for a height it no longer has. The
 * two marks are kept apart so that ordinary movement does not build and drop
 * repeatedly: only a stack swinging across the whole gap between them
 * rebuilds, and one hovering near either mark does not.
 *
 * A value may be pushed more than once, and then occupies as many positions as
 * it was pushed at. That is what makes the two lookups differ, and what the
 * index has to record per value rather than as a single number.
 */
export class IndexTrackingStack<T> {
  /** The values, in order, so a value's position is its index. */
  readonly #stack: T[] = [];

  /**
   * The positions each value occupies, ascending, while the stack is tall
   * enough to want them, and `undefined` otherwise.
   */
  #positions: Map<T, number[]> | undefined;

  /**
   * How deep the stack is: how many values it holds, which is also the index
   * the next value pushed will take.
   */
  get depth(): number {
    return this.#stack.length;
  }

  /**
   * The lowest index at which the given value sits, or `-1` if it is not in
   * the stack.
   */
  indexOf(value: T): number {
    const positions = this.#positions;

    if (positions !== undefined) {
      return positions.get(value)?.[0] ?? -1;
    } else if (value === value) {
      return this.#stack.indexOf(value);
    }

    return this.#stack.findIndex((held) => held !== held);
  }

  /**
   * The highest index at which the given value sits, or `-1` if it is not in
   * the stack.
   */
  lastIndexOf(value: T): number {
    const positions = this.#positions;

    if (positions !== undefined) {
      const found = positions.get(value);

      return (found === undefined) ? -1 : found[found.length - 1]!;
    } else if (value === value) {
      return this.#stack.lastIndexOf(value);
    }

    return this.#stack.findLastIndex((held) => held !== held);
  }

  /**
   * Pops the topmost value off the stack and returns it.
   *
   * @throws If the stack is empty.
   */
  pop(): T {
    if (this.#stack.length === 0) {
      throw new Error("Cannot pop an empty stack.");
    }

    return this.#popNonEmpty();
  }

  /**
   * Pops the topmost value off the stack and returns it, or returns
   * `undefined` if the stack is empty.
   *
   * This cannot tell an empty stack from one whose topmost value is
   * `undefined`, so it is for a caller whose `T` does not admit that. One
   * whose `T` does has {@link #depth} to ask with, and {@link #pop}.
   */
  popElseUndefined(): T | undefined {
    return (this.#stack.length === 0) ? undefined : this.#popNonEmpty();
  }

  /**
   * Pops the topmost value off the stack, which has to be the given one. The
   * stack is left as it was if it is not: what a caller has to sort out is one
   * unbalanced push and pop, not that plus a pop it did not intend.
   *
   * @throws If the stack is empty, or its topmost value is not `expected`.
   */
  popExpect(expected: T): void {
    if (this.#stack.length === 0) {
      throw new Error("Cannot pop an empty stack.");
    }

    const top = this.#stack[this.#stack.length - 1] as T;

    // Compared as the index compares, rather than with `!==`, so that a `NaN`
    // expectation is met by a `NaN` on top. An empty stack has been refused
    // above, so this is not reading past the bottom for it.
    if (!((top === expected) || ((top !== top) && (expected !== expected)))) {
      throw new Error("The top of the stack is not the expected value.");
    }

    this.#popNonEmpty();
  }

  /** Pushes a value onto the stack, at the current top. */
  push(value: T): void {
    const at = this.#stack.length;

    this.#stack.push(value);

    if (this.#positions !== undefined) {
      const found = this.#positions.get(value);

      if (found === undefined) {
        this.#positions.set(value, [at]);
      } else {
        found.push(at);
      }
    } else if (this.#stack.length >= IndexTrackingStack.ADD_INDEX_AT) {
      const positions = new Map<T, number[]>();

      for (let index = 0; index < this.#stack.length; index++) {
        const value = this.#stack[index] as T;
        const found = positions.get(value);

        if (found === undefined) {
          positions.set(value, [index]);
        } else {
          found.push(index);
        }
      }

      this.#positions = positions;
    }
  }

  /**
   * Pops off a stack already known not to be empty, and returns what came off.
   */
  #popNonEmpty(): T {
    const value = this.#stack.pop() as T;
    const found = this.#positions?.get(value);

    if (found !== undefined) {
      // The positions of one value ascend, and what came off the stack is the
      // highest of them, so it is the last of these.
      found.pop();

      if (found.length === 0) {
        this.#positions!.delete(value);
      }

      if (this.#stack.length < IndexTrackingStack.DROP_INDEX_BELOW) {
        this.#positions = undefined;
      }
    }

    return value;
  }

  //
  // Static members
  //

  /**
   * The height at which an index is built. Set well below the height at which
   * a scan and a keyed lookup cost the same, so that reaching it never costs
   * more than not having reached it.
   */
  static readonly ADD_INDEX_AT = 64;

  /**
   * The height below which the index is dropped. The gap between this and
   * {@link #ADD_INDEX_AT} is what keeps a stack from building and dropping
   * over and over: a stack has to swing across the whole of it to rebuild.
   */
  static readonly DROP_INDEX_BELOW = 32;
}
