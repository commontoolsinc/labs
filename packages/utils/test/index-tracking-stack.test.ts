/**
 * `IndexTrackingStack` answers its two lookups two ways -- by scanning, and
 * from the index it builds once it is tall enough -- so every question worth
 * asking gets asked on both sides of
 * `ADD_INDEX_AT`. The two must agree, and a stack
 * that crosses the threshold and comes back down must answer as one that never
 * crossed it.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { IndexTrackingStack } from "../src/index-tracking-stack.ts";

/** Distinct objects, as many as a test asks for. */
function objects(count: number): object[] {
  const out: object[] = [];

  for (let at = 0; at < count; at++) out.push({ at });

  return out;
}

/** How tall a stack has to be for the index to have been built. */
/**
 * The marks the class arranges itself around, which a test has to straddle.
 */
const MARKS = IndexTrackingStack.accessForTestingOnly;

const TALL = MARKS.ADD_INDEX_AT + 5;

/**
 * A stack holding the given objects, padded first to `height` with distinct
 * objects of its own, so that one test body can be run on either side of the
 * threshold.
 */
function stackOf(height: number, values: readonly object[]) {
  const stack = new IndexTrackingStack<object>();

  for (const filler of objects(height)) stack.push(filler);

  // An index is built by a lookup, not by growth, so a padded stack is not an
  // indexed one until something has asked it a position.
  stack.indexOf({});

  for (const value of values) stack.push(value);

  return stack;
}

describe("IndexTrackingStack", () => {
  describe("depth", () => {
    it("is zero for a fresh stack", () => {
      expect(new IndexTrackingStack<object>().depth).toBe(0);
    });

    it("counts what has been pushed and not popped", () => {
      const stack = new IndexTrackingStack<object>();

      for (const value of objects(TALL)) stack.push(value);
      expect(stack.depth).toBe(TALL);

      for (let at = 0; at < 10; at++) stack.pop();
      expect(stack.depth).toBe(TALL - 10);
    });

    it("stays at zero when an empty stack is popped", () => {
      const stack = new IndexTrackingStack<object>();

      stack.popElseUndefined();

      expect(stack.depth).toBe(0);
    });
  });

  describe("pop()", () => {
    it("throws for an empty stack", () => {
      expect(() => new IndexTrackingStack<object>().pop()).toThrow();
    });

    it("returns the objects it pops, topmost first", () => {
      const held = objects(3);
      const stack = new IndexTrackingStack<object>();

      for (const value of held) stack.push(value);

      expect(stack.pop()).toBe(held[2]);
      expect(stack.pop()).toBe(held[1]);
      expect(stack.pop()).toBe(held[0]);
      expect(() => stack.pop()).toThrow();
    });

    it("returns the objects it pops from an indexed stack", () => {
      const held = objects(3);
      const stack = stackOf(TALL, held);

      expect(stack.pop()).toBe(held[2]);
      expect(stack.pop()).toBe(held[1]);
      expect(stack.pop()).toBe(held[0]);
    });
  });

  describe("popElseUndefined()", () => {
    it("returns `undefined` for an empty stack", () => {
      expect(new IndexTrackingStack<object>().popElseUndefined())
        .toBeUndefined();
    });

    it("returns the objects it pops, topmost first", () => {
      const held = objects(2);
      const stack = new IndexTrackingStack<object>();

      for (const value of held) stack.push(value);

      expect(stack.popElseUndefined()).toBe(held[1]);
      expect(stack.popElseUndefined()).toBe(held[0]);
      expect(stack.popElseUndefined()).toBeUndefined();
    });

    it("maintains the index, given an indexed stack", () => {
      const twice = {};
      const stack = stackOf(TALL, [twice, {}, twice]);

      expect(stack.popElseUndefined()).toBe(twice);

      expect(stack.lastIndexOf(twice)).toBe(TALL);
      expect(stack.depth).toBe(TALL + 2);
    });
  });

  describe("popExpect()", () => {
    it("pops the object it was told to expect", () => {
      const held = objects(2);
      const stack = new IndexTrackingStack<object>();

      for (const value of held) stack.push(value);
      stack.popExpect(held[1]!);

      expect(stack.depth).toBe(1);
      expect(stack.indexOf(held[1]!)).toBe(-1);
    });

    it("throws for an object that is in the stack but not on top", () => {
      const held = objects(2);
      const stack = new IndexTrackingStack<object>();

      for (const value of held) stack.push(value);

      expect(() => stack.popExpect(held[0]!)).toThrow();
    });

    it("throws for an object the stack does not hold", () => {
      const stack = new IndexTrackingStack<object>();

      stack.push({});

      expect(() => stack.popExpect({})).toThrow();
    });

    it("throws for an empty stack", () => {
      expect(() => new IndexTrackingStack<object>().popExpect({})).toThrow();
    });

    it("leaves the stack as it was when it throws", () => {
      const held = objects(2);
      const stack = new IndexTrackingStack<object>();

      for (const value of held) stack.push(value);
      expect(() => stack.popExpect(held[0]!)).toThrow();

      expect(stack.depth).toBe(2);
      expect(stack.indexOf(held[0]!)).toBe(0);
      expect(stack.lastIndexOf(held[1]!)).toBe(1);
    });

    it("maintains the index, given an indexed stack", () => {
      // The successful arm has to be a real pop on either side of the
      // threshold, index maintenance included.
      const twice = {};
      const stack = stackOf(TALL, [twice, {}, twice]);

      stack.popExpect(twice);

      expect(stack.depth).toBe(TALL + 2);
      expect(stack.lastIndexOf(twice)).toBe(TALL);
      expect(stack.indexOf(twice)).toBe(TALL);
    });
  });

  describe("indexOf() and lastIndexOf()", () => {
    for (
      const [where, height] of [["scanning", 0], ["indexed", TALL]] as const
    ) {
      describe(where, () => {
        it("reports -1 for an object it does not hold", () => {
          const stack = stackOf(height, []);

          expect(stack.indexOf({})).toBe(-1);
          expect(stack.lastIndexOf({})).toBe(-1);
        });

        it("reports each object's position", () => {
          const held = objects(4);
          const stack = stackOf(height, held);

          held.forEach((value, at) => {
            expect(stack.indexOf(value)).toBe(height + at);
            expect(stack.lastIndexOf(value)).toBe(height + at);
          });
        });

        it("compares by identity rather than by value", () => {
          const stack = stackOf(height, [{ same: 1 }]);

          expect(stack.indexOf({ same: 1 })).toBe(-1);
          expect(stack.lastIndexOf({ same: 1 })).toBe(-1);
        });

        it("reports -1 for an object that has been popped", () => {
          const [kept, dropped] = objects(2) as [object, object];
          const stack = stackOf(height, [kept, dropped]);

          stack.pop();

          expect(stack.indexOf(kept)).toBe(height);
          expect(stack.indexOf(dropped)).toBe(-1);
          expect(stack.lastIndexOf(dropped)).toBe(-1);
        });

        it("reports the lowest and the highest position of a repeated object", () => {
          const twice = {};
          const stack = stackOf(height, [twice, {}, twice]);

          expect(stack.indexOf(twice)).toBe(height);
          expect(stack.lastIndexOf(twice)).toBe(height + 2);
        });

        it("keeps the earlier position of a repeated object when the later one is popped", () => {
          const twice = {};
          const stack = stackOf(height, [twice, {}, twice]);

          stack.pop();

          expect(stack.indexOf(twice)).toBe(height);
          expect(stack.lastIndexOf(twice)).toBe(height);
        });

        it("walks back through the positions of an object held three times", () => {
          // Two occurrences would not tell a positions stack from a pair of
          // numbers; three is where popping through them has to be in order.
          const thrice = {};
          const stack = stackOf(height, [thrice, {}, thrice, {}, thrice]);

          expect(stack.indexOf(thrice)).toBe(height);
          expect(stack.lastIndexOf(thrice)).toBe(height + 4);

          stack.pop();
          expect(stack.lastIndexOf(thrice)).toBe(height + 2);

          stack.pop();
          stack.pop();
          expect(stack.lastIndexOf(thrice)).toBe(height);
          expect(stack.indexOf(thrice)).toBe(height);
        });

        it("reports -1 once every position of a repeated object is popped", () => {
          const twice = {};
          const stack = stackOf(height, [twice, {}, twice]);

          stack.pop();
          stack.pop();
          stack.pop();

          expect(stack.indexOf(twice)).toBe(-1);
          expect(stack.lastIndexOf(twice)).toBe(-1);
        });
      });
    }
  });

  describe("a domain holding `undefined` and `NaN`", () => {
    // What a parametric stack costs: `undefined` stops being a signal, and the
    // scan and the index stop agreeing on their own. Each case runs on both
    // sides of the threshold, since only one of the two is at issue in each.
    for (
      const [where, height] of [["scanning", 0], ["indexed", TALL]] as const
    ) {
      describe(where, () => {
        /** A stack of the padded height, then the given values. */
        function stackOfAny(values: readonly unknown[]) {
          const stack = new IndexTrackingStack<unknown>();

          for (const filler of objects(height)) stack.push(filler);
          for (const value of values) stack.push(value);

          return stack;
        }

        it("finds `undefined` where it was pushed", () => {
          const stack = stackOfAny([undefined, {}, undefined]);

          expect(stack.indexOf(undefined)).toBe(height);
          expect(stack.lastIndexOf(undefined)).toBe(height + 2);
        });

        it("finds `NaN`, which strict comparison never would", () => {
          const stack = stackOfAny([NaN, {}, NaN]);

          expect(stack.indexOf(NaN)).toBe(height);
          expect(stack.lastIndexOf(NaN)).toBe(height + 2);
        });

        it("finds `0` where `0` was pushed, and not where `-0` was", () => {
          const stack = stackOfAny([-0, 0]);

          expect(stack.indexOf(0)).toBe(height + 1);
          expect(stack.lastIndexOf(0)).toBe(height + 1);
        });

        it("finds `-0` where `-0` was pushed, and not where `0` was", () => {
          const stack = stackOfAny([0, -0]);

          expect(stack.indexOf(-0)).toBe(height + 1);
          expect(stack.lastIndexOf(-0)).toBe(height + 1);
        });

        it("holds `-0` and `0` apart across every position of each", () => {
          const stack = stackOfAny([-0, 0, -0, 0]);

          expect(stack.indexOf(-0)).toBe(height);
          expect(stack.lastIndexOf(-0)).toBe(height + 2);
          expect(stack.indexOf(0)).toBe(height + 1);
          expect(stack.lastIndexOf(0)).toBe(height + 3);
        });

        it("does not find a `-0` for a `NaN`, nor either for the other", () => {
          const stack = stackOfAny([NaN]);

          expect(stack.indexOf(-0)).toBe(-1);
          expect(stack.indexOf(0)).toBe(-1);
          expect(stack.lastIndexOf(-0)).toBe(-1);
        });

        it("finds neither `0` nor `-0` in a stack holding neither", () => {
          const stack = stackOfAny([1, {}]);

          expect(stack.indexOf(0)).toBe(-1);
          expect(stack.indexOf(-0)).toBe(-1);
          expect(stack.lastIndexOf(0)).toBe(-1);
          expect(stack.lastIndexOf(-0)).toBe(-1);
        });

        it("pops an expected `-0` and refuses an expected `0` for it", () => {
          const stack = stackOfAny([-0]);

          expect(() => stack.popExpect(0)).toThrow();
          expect(stack.depth).toBe(height + 1);

          stack.popExpect(-0);

          expect(stack.depth).toBe(height);
        });

        it("pops an expected `0` and refuses an expected `-0` for it", () => {
          const stack = stackOfAny([0]);

          expect(() => stack.popExpect(-0)).toThrow();

          stack.popExpect(0);

          expect(stack.depth).toBe(height);
        });

        it("stops finding a popped `-0` while keeping a `0` below it", () => {
          // The stand-in key the index gives `-0` has to come off with it, and
          // to have been a different entry from the one `0` holds.
          const stack = stackOfAny([0, -0]);

          stack.pop();

          expect(stack.indexOf(-0)).toBe(-1);
          expect(stack.indexOf(0)).toBe(height);
        });

        it("pops an expected `undefined` off the top", () => {
          const stack = stackOfAny([undefined]);

          stack.popExpect(undefined);

          expect(stack.depth).toBe(height);
        });

        it("pops an expected `NaN` off the top", () => {
          const stack = stackOfAny([NaN]);

          stack.popExpect(NaN);

          expect(stack.depth).toBe(height);
        });
      });
    }

    it("refuses `popExpect(undefined)` on an empty stack", () => {
      // The trap the type parameter opens: reading past the bottom of an empty
      // stack yields `undefined`, which would meet the expectation.
      expect(() => new IndexTrackingStack<unknown>().popExpect(undefined))
        .toThrow();
    });

    it("refuses `pop()` on an empty stack whose domain holds `undefined`", () => {
      expect(() => new IndexTrackingStack<unknown>().pop()).toThrow();
    });

    it("pops an `undefined` that is really there", () => {
      const stack = new IndexTrackingStack<unknown>();

      stack.push(undefined);

      expect(stack.pop()).toBeUndefined();
      expect(stack.depth).toBe(0);
    });

    it("leaves `depth` to tell an empty stack from a held `undefined`", () => {
      // `popElseUndefined()` cannot, which is what its doc says; this is what
      // a caller uses instead.
      const held = new IndexTrackingStack<unknown>();
      const empty = new IndexTrackingStack<unknown>();

      held.push(undefined);

      expect(held.popElseUndefined()).toBeUndefined();
      expect(empty.popElseUndefined()).toBeUndefined();
      expect(held.depth).toBe(0);
      expect(empty.depth).toBe(0);
    });
  });

  describe("crossing the threshold", () => {
    it("answers the same after coming back down as a stack that never went up", () => {
      // The index outlives the height that built it, so from here on the two
      // implementations are being compared directly on the same question.
      const held = objects(4);
      const climbed = new IndexTrackingStack<object>();
      const flat = new IndexTrackingStack<object>();

      for (const filler of objects(TALL)) climbed.push(filler);
      climbed.indexOf({});
      for (let at = 0; at < TALL; at++) climbed.pop();
      for (const value of held) climbed.push(value);
      for (const value of held) flat.push(value);

      expect(climbed.depth).toBe(flat.depth);
      held.forEach((value, at) => {
        expect(climbed.indexOf(value)).toBe(flat.indexOf(value));
        expect(climbed.indexOf(value)).toBe(at);
        expect(climbed.lastIndexOf(value)).toBe(flat.lastIndexOf(value));
      });
      expect(climbed.indexOf({})).toBe(flat.indexOf({}));
    });

    it("answers from the scan again once the index has been dropped", () => {
      // Coming back down past `DROP_INDEX_BELOW` drops the index, so what
      // is used afterwards is the scan -- over a stack that a `Map` was
      // tracking a moment ago, and has to have stopped tracking cleanly.
      const twice = {};
      const stack = new IndexTrackingStack<object>();

      stack.push(twice);
      stack.push(twice);
      for (const filler of objects(TALL)) stack.push(filler);
      stack.indexOf({});
      while (stack.depth > 2) stack.pop();

      expect(stack.depth).toBe(2);
      expect(stack.indexOf(twice)).toBe(0);
      expect(stack.lastIndexOf(twice)).toBe(1);
      expect(stack.indexOf({})).toBe(-1);
    });

    it("builds the index again when it grows back past the threshold", () => {
      // A rebuild from a stack that has held an index before is a different
      // path from the first build, and it has to arrive at the same answers.
      const twice = {};
      const stack = new IndexTrackingStack<object>();

      for (const filler of objects(TALL)) stack.push(filler);
      stack.indexOf({});
      while (stack.depth > 0) stack.pop();

      stack.push(twice);
      stack.push(twice);
      for (const filler of objects(TALL)) stack.push(filler);

      expect(stack.indexOf(twice)).toBe(0);
      expect(stack.lastIndexOf(twice)).toBe(1);
    });

    it("carries both positions of an object already held twice into the index", () => {
      // The index is built by grouping the stack as it stands, so an object
      // already holding two positions is the case where that grouping has to
      // produce a pair rather than overwrite.
      const twice = {};
      const stack = new IndexTrackingStack<object>();

      stack.push(twice);
      stack.push(twice);
      for (const filler of objects(TALL)) stack.push(filler);

      expect(stack.indexOf(twice)).toBe(0);
      expect(stack.lastIndexOf(twice)).toBe(1);
    });

    it("carries the objects already held into the index it builds", () => {
      // The index is built from the stack as it stands, so what was pushed
      // before the crossing has to arrive in it.
      const early = {};
      const stack = new IndexTrackingStack<object>();

      stack.push(early);
      for (const filler of objects(TALL)) stack.push(filler);

      expect(stack.indexOf(early)).toBe(0);
      expect(stack.lastIndexOf(early)).toBe(0);
    });
  });
});
