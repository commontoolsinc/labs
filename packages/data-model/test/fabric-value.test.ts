import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { valueEqual } from "@/fabric-value.ts";

describe("fabric-value", () => {
  describe("valueEqual()", () => {
    it("returns `true` for equal primitives", () => {
      expect(valueEqual(1, 1)).toBe(true);
      expect(valueEqual("a", "a")).toBe(true);
      expect(valueEqual(true, true)).toBe(true);
      expect(valueEqual(null, null)).toBe(true);
      expect(valueEqual(undefined, undefined)).toBe(true);
    });

    it("returns `false` for differing primitives", () => {
      expect(valueEqual(1, 2)).toBe(false);
      expect(valueEqual("a", "b")).toBe(false);
      expect(valueEqual(true, false)).toBe(false);
      expect(valueEqual(null, undefined)).toBe(false);
    });

    it("compares `bigint` values", () => {
      expect(valueEqual(42n, 42n)).toBe(true);
      expect(valueEqual(1n, 2n)).toBe(false);
    });

    it("returns `true` for structurally-equal objects", () => {
      expect(valueEqual({ a: 1, b: "two" }, { a: 1, b: "two" })).toBe(true);
    });

    it("returns `false` for objects that differ in a value or key", () => {
      expect(valueEqual({ a: 1 }, { a: 2 })).toBe(false);
      expect(valueEqual({ a: 1 }, { b: 1 })).toBe(false);
    });

    it("returns `true` for structurally-equal arrays", () => {
      expect(valueEqual([1, 2, 3], [1, 2, 3])).toBe(true);
    });

    it("returns `false` for arrays that differ in length or element", () => {
      expect(valueEqual([1, 2], [1, 2, 3])).toBe(false);
      expect(valueEqual([1, 2, 3], [1, 9, 3])).toBe(false);
    });

    it("compares nested structures deeply", () => {
      expect(valueEqual({ x: { y: [1, 2] } }, { x: { y: [1, 2] } })).toBe(true);
      expect(valueEqual({ x: { y: [1, 2] } }, { x: { y: [1, 3] } })).toBe(
        false,
      );
    });
  });
});
