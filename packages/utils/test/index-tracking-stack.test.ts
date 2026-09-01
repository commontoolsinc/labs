/**
 * `IndexTrackingStack` answers its two lookups two ways -- by scanning, and
 * from the index it builds once it is tall enough -- so every question worth
 * asking gets asked on both sides of the height that builds one. The two must
 * agree, and a stack that crosses that height and comes back down must answer
 * as one that never crossed it.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { IndexTrackingStack } from "../src/index-tracking-stack.ts";

/**
 * The marks the class arranges itself around, which a test has to straddle.
 */
const MARKS = IndexTrackingStack.accessForTestingOnly;

/** How tall a stack has to be for the index to have been built. */
const TALL = MARKS.ADD_INDEX_AT + 5;

/** The two lookups, and which position of a repeated value each reports. */
const LOOKUPS = [
  { name: "indexOf", reports: "lowest" },
  { name: "lastIndexOf", reports: "highest" },
] as const;

/**
 * The two states a lookup can be answered from, as the height a stack is
 * padded to before a case's own values go onto it.
 */
const ARMS = [["scanning", 0], ["indexed", TALL]] as const;

/** Distinct objects, as many as asked for. */
function objects(count: number): object[] {
  const out: object[] = [];

  for (let at = 0; at < count; at++) out.push({ at });

  return out;
}

/**
 * A stack padded to `height` with distinct objects and then given `values`.
 *
 * The lookup between the two is what makes the indexed arm indexed *before*
 * the values arrive, so that they go in through the maintenance path rather
 * than being swept up by a later build. Which of the three sites keys a value
 * is the thing most easily left untested here.
 */
function stackOf(height: number, values: readonly unknown[]) {
  const stack = new IndexTrackingStack();

  for (const filler of objects(height)) stack.push(filler);
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

    it("tells an empty stack from one holding an `undefined`", () => {
      // `popElseUndefined()` cannot, which is what its doc says; this is what
      // a caller uses instead.
      const held = new IndexTrackingStack();
      const empty = new IndexTrackingStack();

      held.push(undefined);

      expect(held.popElseUndefined()).toBeUndefined();
      expect(empty.popElseUndefined()).toBeUndefined();
      expect(held.depth).toBe(0);
      expect(empty.depth).toBe(0);
    });
  });

  describe("pop()", () => {
    it("throws given an empty stack", () => {
      expect(() => new IndexTrackingStack<object>().pop()).toThrow();
    });

    it("throws given an empty stack whose domain holds `undefined`", () => {
      expect(() => new IndexTrackingStack().pop()).toThrow();
    });

    it("returns the values it pops, topmost first", () => {
      const held = objects(3);
      const stack = new IndexTrackingStack<object>();

      for (const value of held) stack.push(value);

      expect(stack.pop()).toBe(held[2]);
      expect(stack.pop()).toBe(held[1]);
      expect(stack.pop()).toBe(held[0]);
      expect(() => stack.pop()).toThrow();
    });

    it("returns the values it pops from an indexed stack", () => {
      const held = objects(3);
      const stack = stackOf(TALL, held);

      expect(stack.pop()).toBe(held[2]);
      expect(stack.pop()).toBe(held[1]);
      expect(stack.pop()).toBe(held[0]);
    });

    it("pops an `undefined` that is really there", () => {
      const stack = new IndexTrackingStack();

      stack.push(undefined);

      expect(stack.pop()).toBeUndefined();
      expect(stack.depth).toBe(0);
    });
  });

  describe("popElseUndefined()", () => {
    it("returns `undefined` for an empty stack", () => {
      expect(new IndexTrackingStack<object>().popElseUndefined())
        .toBeUndefined();
    });

    it("returns the values it pops, topmost first", () => {
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
    it("pops the value it was told to expect", () => {
      const held = objects(2);
      const stack = new IndexTrackingStack<object>();

      for (const value of held) stack.push(value);
      stack.popExpect(held[1]!);

      expect(stack.depth).toBe(1);
      expect(stack.indexOf(held[1]!)).toBe(-1);
    });

    it("throws given a value that is in the stack but not on top", () => {
      const held = objects(2);
      const stack = new IndexTrackingStack<object>();

      for (const value of held) stack.push(value);

      expect(() => stack.popExpect(held[0]!)).toThrow();
    });

    it("throws given a value the stack does not hold", () => {
      const stack = new IndexTrackingStack<object>();

      stack.push({});

      expect(() => stack.popExpect({})).toThrow();
    });

    it("throws given an empty stack", () => {
      expect(() => new IndexTrackingStack<object>().popExpect({})).toThrow();
    });

    it("throws given an empty stack rather than meeting an `undefined`", () => {
      // The trap a parametric domain opens: reading past the bottom of an
      // empty stack yields `undefined`, which would meet the expectation.
      expect(() => new IndexTrackingStack().popExpect(undefined))
        .toThrow();
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
      const twice = {};
      const stack = stackOf(TALL, [twice, {}, twice]);

      stack.popExpect(twice);

      expect(stack.depth).toBe(TALL + 2);
      expect(stack.lastIndexOf(twice)).toBe(TALL);
      expect(stack.indexOf(twice)).toBe(TALL);
    });

    for (const [where, height] of ARMS) {
      describe(where, () => {
        it("pops an expected `undefined` off the top", () => {
          const stack = stackOf(height, [undefined]);

          stack.popExpect(undefined);

          expect(stack.depth).toBe(height);
        });

        it("pops an expected `NaN` off the top", () => {
          const stack = stackOf(height, [NaN]);

          stack.popExpect(NaN);

          expect(stack.depth).toBe(height);
        });

        it("pops an expected `-0` off the top", () => {
          const stack = stackOf(height, [-0]);

          stack.popExpect(-0);

          expect(stack.depth).toBe(height);
        });

        it("throws given a `0` expected of a `-0` on top", () => {
          const stack = stackOf(height, [-0]);

          expect(() => stack.popExpect(0)).toThrow();
          expect(stack.depth).toBe(height + 1);
        });

        it("pops an expected `0` off the top", () => {
          const stack = stackOf(height, [0]);

          stack.popExpect(0);

          expect(stack.depth).toBe(height);
        });

        it("throws given a `-0` expected of a `0` on top", () => {
          const stack = stackOf(height, [0]);

          expect(() => stack.popExpect(-0)).toThrow();
          expect(stack.depth).toBe(height + 1);
        });
      });
    }
  });

  for (const lookup of LOOKUPS) {
    describe(`${lookup.name}()`, () => {
      /** The position of a repeated value this lookup reports, of two. */
      const ofTwo = (first: number, last: number) =>
        (lookup.reports === "lowest") ? first : last;

      for (const [where, height] of ARMS) {
        describe(where, () => {
          it("reports -1 for a value it does not hold", () => {
            const stack = stackOf(height, []);

            expect(stack[lookup.name]({})).toBe(-1);
          });

          it("reports each value's position", () => {
            const held = objects(4);
            const stack = stackOf(height, held);

            held.forEach((value, at) => {
              expect(stack[lookup.name](value)).toBe(height + at);
            });
          });

          it("compares by identity rather than by value", () => {
            const stack = stackOf(height, [{ same: 1 }]);

            expect(stack[lookup.name]({ same: 1 })).toBe(-1);
          });

          it("reports -1 for a value that has been popped", () => {
            const [kept, dropped] = objects(2) as [object, object];
            const stack = stackOf(height, [kept, dropped]);

            stack.pop();

            expect(stack[lookup.name](kept)).toBe(height);
            expect(stack[lookup.name](dropped)).toBe(-1);
          });

          it(`reports the ${lookup.reports} position of a repeated value`, () => {
            const twice = {};
            const stack = stackOf(height, [twice, {}, twice]);

            expect(stack[lookup.name](twice)).toBe(ofTwo(height, height + 2));
          });

          it("keeps the earlier position when the later one is popped", () => {
            const twice = {};
            const stack = stackOf(height, [twice, {}, twice]);

            stack.pop();

            expect(stack[lookup.name](twice)).toBe(height);
          });

          it("walks back through the positions of a value held three times", () => {
            // Two occurrences would not tell a positions stack from a pair of
            // numbers; three is where popping through them has to be in order.
            const thrice = {};
            const stack = stackOf(height, [thrice, {}, thrice, {}, thrice]);

            expect(stack[lookup.name](thrice))
              .toBe(ofTwo(height, height + 4));

            stack.pop();
            expect(stack[lookup.name](thrice))
              .toBe(ofTwo(height, height + 2));

            stack.pop();
            stack.pop();
            expect(stack[lookup.name](thrice)).toBe(height);
          });

          it("reports -1 once every position of a repeated value is popped", () => {
            const twice = {};
            const stack = stackOf(height, [twice, {}, twice]);

            stack.pop();
            stack.pop();
            stack.pop();

            expect(stack[lookup.name](twice)).toBe(-1);
          });

          it("finds `undefined` where it was pushed", () => {
            const stack = stackOf(height, [undefined, {}, undefined]);

            expect(stack[lookup.name](undefined))
              .toBe(ofTwo(height, height + 2));
          });

          it("finds `NaN`, which strict comparison never would", () => {
            const stack = stackOf(height, [NaN, {}, NaN]);

            expect(stack[lookup.name](NaN)).toBe(ofTwo(height, height + 2));
          });

          it("holds `-0` and `0` apart across every position of each", () => {
            const stack = stackOf(height, [-0, 0, -0, 0]);

            expect(stack[lookup.name](-0)).toBe(ofTwo(height, height + 2));
            expect(stack[lookup.name](0)).toBe(ofTwo(height + 1, height + 3));
          });

          it("does not find a zero of either sign for a `NaN`", () => {
            const stack = stackOf(height, [NaN]);

            expect(stack[lookup.name](-0)).toBe(-1);
            expect(stack[lookup.name](0)).toBe(-1);
          });

          it("finds neither `0` nor `-0` in a stack holding neither", () => {
            const stack = stackOf(height, [1, {}]);

            expect(stack[lookup.name](0)).toBe(-1);
            expect(stack[lookup.name](-0)).toBe(-1);
          });
        });
      }
    });
  }

  describe("special values through an index that is already live", () => {
    // Three different pieces of code key the index: the build sweeps a whole
    // stack, `push()` keys one value onto a live index, and `pop()` keys one
    // off. A suite that reaches only the build passes while either of the
    // others is broken, so each gets its own group here.

    /** A stack tall enough to hold an index, holding it, and holding a `0`. */
    function indexedStack() {
      const stack = new IndexTrackingStack();

      for (const filler of objects(TALL)) stack.push(filler);
      stack.push(0);
      stack.indexOf({});

      return stack;
    }

    describe("push()", () => {
      it("keys a `NaN` pushed onto an already-indexed stack", () => {
        const stack = indexedStack();

        stack.push(NaN);

        expect(stack.indexOf(NaN)).toBe(TALL + 1);
        expect(stack.lastIndexOf(NaN)).toBe(TALL + 1);
      });

      it("keys a `-0` apart from a `0` the stack already holds", () => {
        const stack = indexedStack();

        stack.push(-0);

        expect(stack.indexOf(-0)).toBe(TALL + 1);
        expect(stack.indexOf(0)).toBe(TALL);
      });
    });

    describe("pop()", () => {
      it("takes a `-0` off without disturbing a held `0`", () => {
        // Keyed by the raw value it would take a position off the `0` entry
        // instead, a `Map` reading a `-0` key as `0`.
        const stack = indexedStack();

        stack.push(-0);
        stack.pop();

        expect(stack.indexOf(0)).toBe(TALL);
        expect(stack.indexOf(-0)).toBe(-1);
      });

      it("takes a `NaN` off, after which it is not found", () => {
        const stack = indexedStack();

        stack.push(NaN);
        stack.pop();

        expect(stack.indexOf(NaN)).toBe(-1);
        expect(stack.indexOf(0)).toBe(TALL);
      });
    });

    describe("indexOf()", () => {
      // The build runs here, a lookup being what triggers one, so these are
      // the cases where a value was already on the stack when it was keyed.
      it("sweeps a `-0` and a `0` into separate entries as it builds", () => {
        const stack = new IndexTrackingStack();

        stack.push(0);
        stack.push(-0);
        for (const filler of objects(TALL)) stack.push(filler);
        stack.indexOf({});

        expect(stack.indexOf(0)).toBe(0);
        expect(stack.indexOf(-0)).toBe(1);
      });

      it("sweeps a `NaN` into its own entry as it builds", () => {
        const stack = new IndexTrackingStack();

        stack.push(NaN);
        stack.push(0);
        for (const filler of objects(TALL)) stack.push(filler);
        stack.indexOf({});

        expect(stack.indexOf(NaN)).toBe(0);
        expect(stack.indexOf(0)).toBe(1);
      });
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
      // Coming back down past the low mark drops the index, so what is used
      // afterwards is the scan -- over a stack that a `Map` was tracking a
      // moment ago, and has to have stopped tracking cleanly.
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

    it("carries both positions of a value already held twice into the index", () => {
      // The index is built by grouping the stack as it stands, so a value
      // already holding two positions is the case where that grouping has to
      // produce a pair rather than overwrite.
      const twice = {};
      const stack = new IndexTrackingStack<object>();

      stack.push(twice);
      stack.push(twice);
      for (const filler of objects(TALL)) stack.push(filler);
      stack.indexOf({});

      expect(stack.indexOf(twice)).toBe(0);
      expect(stack.lastIndexOf(twice)).toBe(1);
    });
  });
});
