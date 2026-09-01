/**
 * `IndexTrackingStack` answers its two lookups two ways -- by scanning, and
 * from the index it builds once it is tall enough -- so every question worth
 * asking gets asked on both sides of {@link IndexTrackingStack.INDEX_AT}. The
 * two must agree, and a stack that crosses the threshold and comes back down
 * must answer as one that never crossed it.
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
const TALL = IndexTrackingStack.INDEX_AT + 5;

/**
 * A stack holding the given objects, padded first to `height` with distinct
 * objects of its own, so that one test body can be run on either side of the
 * threshold.
 */
function stackOf(height: number, values: readonly object[]) {
  const stack = new IndexTrackingStack();

  for (const filler of objects(height)) stack.push(filler);
  for (const value of values) stack.push(value);

  return stack;
}

describe("IndexTrackingStack", () => {
  describe("length", () => {
    it("is zero for a fresh stack", () => {
      expect(new IndexTrackingStack().length).toBe(0);
    });

    it("counts what has been pushed and not popped", () => {
      const stack = new IndexTrackingStack();

      for (const value of objects(TALL)) stack.push(value);
      expect(stack.length).toBe(TALL);

      for (let at = 0; at < 10; at++) stack.pop();
      expect(stack.length).toBe(TALL - 10);
    });

    it("stays at zero when an empty stack is popped", () => {
      const stack = new IndexTrackingStack();

      stack.pop();

      expect(stack.length).toBe(0);
    });
  });

  describe("pop()", () => {
    it("returns `undefined` for an empty stack", () => {
      expect(new IndexTrackingStack().pop()).toBeUndefined();
    });

    it("returns the objects it pops, topmost first", () => {
      const held = objects(3);
      const stack = new IndexTrackingStack();

      for (const value of held) stack.push(value);

      expect(stack.pop()).toBe(held[2]);
      expect(stack.pop()).toBe(held[1]);
      expect(stack.pop()).toBe(held[0]);
      expect(stack.pop()).toBeUndefined();
    });

    it("returns the objects it pops from an indexed stack", () => {
      const held = objects(3);
      const stack = stackOf(TALL, held);

      expect(stack.pop()).toBe(held[2]);
      expect(stack.pop()).toBe(held[1]);
      expect(stack.pop()).toBe(held[0]);
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

  describe("crossing the threshold", () => {
    it("answers the same after coming back down as a stack that never went up", () => {
      // The index outlives the height that built it, so from here on the two
      // implementations are being compared directly on the same question.
      const held = objects(4);
      const climbed = new IndexTrackingStack();
      const flat = new IndexTrackingStack();

      for (const filler of objects(TALL)) climbed.push(filler);
      for (let at = 0; at < TALL; at++) climbed.pop();
      for (const value of held) climbed.push(value);
      for (const value of held) flat.push(value);

      expect(climbed.length).toBe(flat.length);
      held.forEach((value, at) => {
        expect(climbed.indexOf(value)).toBe(flat.indexOf(value));
        expect(climbed.indexOf(value)).toBe(at);
        expect(climbed.lastIndexOf(value)).toBe(flat.lastIndexOf(value));
      });
      expect(climbed.indexOf({})).toBe(flat.indexOf({}));
    });

    it("carries both positions of an object already held twice into the index", () => {
      // The index is built by grouping the stack as it stands, so an object
      // already holding two positions is the case where that grouping has to
      // produce a pair rather than overwrite.
      const twice = {};
      const stack = new IndexTrackingStack();

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
      const stack = new IndexTrackingStack();

      stack.push(early);
      for (const filler of objects(TALL)) stack.push(filler);

      expect(stack.indexOf(early)).toBe(0);
      expect(stack.lastIndexOf(early)).toBe(0);
    });
  });
});
