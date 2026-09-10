import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  aggregateSumLeaf,
  aggregateSumValue,
  combineAggregateSums,
} from "../src/builtins/aggregate-sum.ts";

/** Sums leaves in the supplied order without intermediate rounding. */
function sum(values: number[]): number {
  return aggregateSumValue(
    values.map(aggregateSumLeaf).reduce(
      combineAggregateSums,
      aggregateSumLeaf(0),
    ),
  );
}

describe("aggregate-sum", () => {
  it("retains small contributions regardless of combine order", () => {
    for (
      const values of [
        [1e16, 1, -1e16],
        [1e16, -1e16, 1],
        [1, 1e16, -1e16],
        [-1e16, 1, 1e16],
      ]
    ) {
      expect(sum(values)).toBe(1);
    }
    const left = combineAggregateSums(
      aggregateSumLeaf(1e16),
      aggregateSumLeaf(1),
    );
    const right = combineAggregateSums(
      aggregateSumLeaf(1),
      aggregateSumLeaf(-1e16),
    );
    expect(
      aggregateSumValue(combineAggregateSums(left, aggregateSumLeaf(-1e16))),
    )
      .toBe(1);
    expect(
      aggregateSumValue(combineAggregateSums(aggregateSumLeaf(1e16), right)),
    )
      .toBe(1);
  });

  it("rounds halfway results to the even significand", () => {
    expect(sum([1, 2 ** -53])).toBe(1);
    expect(sum([1, 2 ** -52, 2 ** -53])).toBe(1 + 2 ** -51);
    expect(sum([-1, -(2 ** -53)])).toBe(-1);
    expect(sum([1, 2 ** -53, Number.MIN_VALUE])).toBe(1 + 2 ** -52);
  });

  it("preserves subnormals and cancellation at both ends of the finite range", () => {
    expect(sum([Number.MIN_VALUE, Number.MIN_VALUE])).toBe(
      2 * Number.MIN_VALUE,
    );
    expect(sum([Number.MAX_VALUE, Number.MIN_VALUE, -Number.MAX_VALUE]))
      .toBe(Number.MIN_VALUE);
    expect(sum([Number.MAX_VALUE, Number.MAX_VALUE])).toBe(Infinity);
    expect(sum([-Number.MAX_VALUE, -Number.MAX_VALUE])).toBe(-Infinity);
    expect(sum([Number.MAX_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE]))
      .toBe(Number.MAX_VALUE);
  });

  it("propagates non-finite contributions and returns positive zero for cancellation", () => {
    expect(sum([Infinity, 1])).toBe(Infinity);
    expect(sum([-Infinity, 1])).toBe(-Infinity);
    expect(sum([Infinity, -Infinity])).toBeNaN();
    expect(sum([NaN, 1])).toBeNaN();
    expect(Object.is(sum([]), 0)).toBe(true);
    expect(Object.is(sum([-0]), 0)).toBe(true);
    expect(Object.is(sum([-1, 1]), 0)).toBe(true);
  });
});
