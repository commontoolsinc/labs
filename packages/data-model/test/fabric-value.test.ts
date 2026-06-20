import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { valueEqual } from "@/fabric-value.ts";
import { FabricBytes } from "@/fabric-primitives/FabricBytes.ts";
import { FabricRegExp } from "@/fabric-primitives/FabricRegExp.ts";
import { FabricEpochDays } from "@/fabric-primitives/FabricEpochDays.ts";

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

    it("returns `false` across mismatched shapes", () => {
      expect(valueEqual([1, 2], { 0: 1, 1: 2 })).toBe(false); // array vs object
      expect(valueEqual([1, 2], 5)).toBe(false); // array vs primitive
      expect(valueEqual({ a: 1 }, 5)).toBe(false); // object vs primitive
    });

    it("distinguishes object key count and present-undefined vs absent", () => {
      expect(valueEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
      expect(valueEqual({ a: undefined }, {})).toBe(false);
      expect(valueEqual({ a: undefined }, { a: undefined })).toBe(true);
    });

    it("distinguishes an array hole from a stored `undefined`", () => {
      expect(valueEqual([1, , 3], [1, undefined, 3])).toBe(false);
      expect(valueEqual([1, , 3], [1, , 3])).toBe(true);
    });

    // CT-1770: FabricPrimitives keep their state in private fields, so a
    // generic enumerable-own-prop comparison (`deepEqual`) conflates every
    // distinct same-class instance. `valueEqual` compares them by content.
    describe("FabricSpecialObject values (CT-1770)", () => {
      it("distinguishes FabricBytes by content", () => {
        const a = new FabricBytes(new Uint8Array([1, 2, 3, 4]));
        const b = new FabricBytes(new Uint8Array([9, 8, 7, 6]));
        expect(valueEqual(a, b)).toBe(false);
        expect(valueEqual(a, new FabricBytes(new Uint8Array([1, 2, 3, 4]))))
          .toBe(true);
      });

      it("distinguishes FabricRegExp and FabricEpochDays by content", () => {
        expect(valueEqual(new FabricRegExp(/a/g), new FabricRegExp(/b/g)))
          .toBe(false);
        expect(valueEqual(new FabricRegExp(/a/g), new FabricRegExp(/a/g)))
          .toBe(true);
        expect(valueEqual(new FabricEpochDays(1n), new FabricEpochDays(2n)))
          .toBe(false);
      });

      it("distinguishes a FabricPrimitive nested inside a plain container", () => {
        const wrap = (bytes: number[]) => ({
          v: [new FabricBytes(new Uint8Array(bytes))],
        });
        expect(valueEqual(wrap([1, 2]), wrap([3, 4]))).toBe(false);
        expect(valueEqual(wrap([1, 2]), wrap([1, 2]))).toBe(true);
      });

      it("a special object never equals a plain value", () => {
        expect(valueEqual(new FabricBytes(new Uint8Array([1])), { 0: 1 }))
          .toBe(false);
        expect(valueEqual(new FabricBytes(new Uint8Array([])), {})).toBe(false);
      });
    });
  });
});
