/**
 * A stack of objects offering `Array`-style {@link #indexOf} and {@link
 * #lastIndexOf}, comparing by identity. An object's index is counted from the
 * bottom, so the first object pushed is at index `0`, and an index does not
 * change while things are pushed above it.
 *
 * Both lookups are answered by scanning below {@link #INDEX_AT} entries, and
 * by an index built and maintained past that. Which one answers is not
 * observable beyond the cost: a scan is linear in the stack's height where a
 * keyed lookup is not, and the two are within reach of each other only over a
 * range that a short stack sits well below.
 *
 * An object may be pushed more than once, and then occupies as many positions
 * as it was pushed at. That is what makes the two lookups differ, and what the
 * index has to record per object rather than as a single number.
 */
export class IndexTrackingStack {
  /** The objects, in order, so an object's position is its index. */
  readonly #stack: object[] = [];

  /**
   * The positions each object occupies, ascending, once the stack has been
   * tall enough to want them, and `undefined` until then.
   *
   * Kept for the rest of the stack's life once built, so a stack that has been
   * past {@link #INDEX_AT} and come back down goes on answering from the index
   * at a height where a stack that never went up would still be scanning --
   * and goes on paying for it, at about what it pays above the threshold. A
   * caller that pushes deep once and then stays shallow for a long time is the
   * shape that costs.
   */
  #positions: Map<object, number[]> | undefined;

  /**
   * How deep the stack is: how many objects it holds, which is also the index
   * the next object pushed will take.
   */
  get depth(): number {
    return this.#stack.length;
  }

  /**
   * The lowest index at which the given object sits, or `-1` if it is not in
   * the stack.
   */
  indexOf(value: object): number {
    const positions = this.#positions;

    if (positions === undefined) {
      return this.#stack.indexOf(value);
    }

    return positions.get(value)?.[0] ?? -1;
  }

  /**
   * The highest index at which the given object sits, or `-1` if it is not in
   * the stack.
   */
  lastIndexOf(value: object): number {
    const positions = this.#positions;

    if (positions === undefined) {
      return this.#stack.lastIndexOf(value);
    }

    const found = positions.get(value);

    return (found === undefined) ? -1 : found[found.length - 1]!;
  }

  /**
   * Pops the topmost object off the stack and returns it.
   *
   * @throws If the stack is empty.
   */
  pop(): object {
    const value = this.popElseUndefined();

    if (value === undefined) {
      throw new Error("Cannot pop an empty stack.");
    }

    return value;
  }

  /**
   * Pops the topmost object off the stack and returns it, or returns
   * `undefined` if the stack is empty.
   */
  popElseUndefined(): object | undefined {
    const value = this.#stack.pop();

    if (value === undefined) {
      return undefined;
    }

    const found = this.#positions?.get(value);

    if (found !== undefined) {
      // The positions of one object ascend, and what came off the stack is the
      // highest of them, so it is the last of these.
      found.pop();

      if (found.length === 0) {
        this.#positions!.delete(value);
      }
    }

    return value;
  }

  /**
   * Pops the topmost object off the stack, which has to be the given one.
   * The stack is left as it was if it is not: what a caller has to sort out
   * is one unbalanced push and pop, not that plus a pop it did not intend.
   *
   * @throws If the stack is empty, or its topmost object is not `expected`.
   */
  popExpect(expected: object): void {
    if (this.#stack[this.#stack.length - 1] !== expected) {
      throw new Error("Popped an object other than the expected one.");
    }

    this.pop();
  }

  /** Pushes an object onto the stack, at the current top. */
  push(value: object): void {
    const at = this.#stack.length;

    this.#stack.push(value);

    if (this.#positions !== undefined) {
      const found = this.#positions.get(value);

      if (found === undefined) {
        this.#positions.set(value, [at]);
      } else {
        found.push(at);
      }
    } else if (this.#stack.length > IndexTrackingStack.INDEX_AT) {
      const positions = new Map<object, number[]>();

      for (let index = 0; index < this.#stack.length; index++) {
        const value = this.#stack[index]!;
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

  //
  // Static members
  //

  /**
   * The height past which an index is kept. Set well below the height at which
   * a scan and a keyed lookup cost the same, so that crossing it never costs
   * more than not having crossed it.
   */
  static readonly INDEX_AT = 64;
}
