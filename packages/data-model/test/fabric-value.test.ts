import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { type FabricValue, valueEqual } from "@/fabric-value.ts";
import { deepFreeze } from "@/deep-freeze.ts";
import { FabricBytes } from "@/fabric-primitives/FabricBytes.ts";
import { FabricRegExp } from "@/fabric-primitives/FabricRegExp.ts";
import { FabricEpochDays } from "@/fabric-primitives/FabricEpochDays.ts";
import { FabricError } from "@/fabric-instances/FabricError.ts";
import { UnknownValue } from "@/fabric-instances/UnknownValue.ts";

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

    it("throws when given a function (not a `FabricValue`)", () => {
      // A function is reachable only via an unsound cast; the comparison
      // rejects it rather than silently mis-answering, and does so regardless
      // of which argument is the function. (Distinct values are used so the
      // `Object.is()` fast path doesn't short-circuit before the check.)
      const fn = (() => {}) as unknown as FabricValue;
      const fn2 = (() => {}) as unknown as FabricValue;
      expect(() => valueEqual(fn, fn2)).toThrow();
      expect(() => valueEqual(fn, 1)).toThrow();
      expect(() => valueEqual(fn, { a: 1 })).toThrow();
      // The function on the right (`b`) is rejected symmetrically.
      expect(() => valueEqual({ a: 1 }, fn)).toThrow();
    });

    it("throws when given a non-record object (not a `FabricValue`)", () => {
      // A non-array, non-plain object (a `Date`, `Map`, or other class
      // instance) is reachable only via an unsound cast; reject it rather than
      // treat it as an empty record.
      const date = new Date() as unknown as FabricValue;
      const map = new Map() as unknown as FabricValue;
      expect(() => valueEqual(date, { a: 1 })).toThrow();
      expect(() => valueEqual({ a: 1 }, date)).toThrow();
      expect(() => valueEqual(map, {})).toThrow();
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
      expect(valueEqual({ a: 1 }, null)).toBe(false); // object vs null
      expect(valueEqual([1, 2], null)).toBe(false); // array vs null
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

      describe("given a special object and a plain value", () => {
        it("are not equal", () => {
          expect(valueEqual(new FabricBytes(new Uint8Array([1])), { 0: 1 }))
            .toBe(false);
          expect(valueEqual(new FabricBytes(new Uint8Array([])), {}))
            .toBe(false);
        });
      });

      describe("given two non-deep-frozen special objects of different classes", () => {
        it("short-circuits to unequal without hashing", () => {
          // A fresh `UnknownValue` is not auto-frozen, so the pair skips the
          // both-deep-frozen early hash and reaches the constructor check.
          const u = new UnknownValue("tag@1", 1);
          const fb = new FabricBytes(new Uint8Array([1]));
          expect(valueEqual(u, fb)).toBe(false);
          expect(valueEqual(fb, u)).toBe(false);
        });
      });
    });

    // Content equality is independent of frozen-state. The three states differ
    // only in which internal path decides them:
    //   DF (deep-frozen)            -> the both-deep-frozen early-hash fast-path
    //                                  (only when BOTH sides are DF).
    //   F  (frozen, NOT deep-frozen) -> shallow `Object.freeze` with a non-frozen
    //                                  nested value fails `isDeepFrozen()`, so it
    //                                  takes the general subtype + hash path.
    //   U  (unfrozen)                -> likewise the general subtype + hash path.
    // Every pairing must agree on the value answer regardless of state.
    describe("frozen-state matrix", () => {
      // The nested array keeps the shallow-frozen `F` build genuinely
      // not-deep-frozen (an all-primitive shallow freeze reads as deep-frozen).
      const equalShape = () => ({ a: 1, b: [2, 3] });
      const unequalShape = () => ({ a: 1, b: [2, 4] });

      const states: Record<"DF" | "F" | "U", (v: object) => object> = {
        DF: (v) => deepFreeze(v),
        F: (v) => Object.freeze(v),
        U: (v) => v,
      };
      const pairings: ["DF" | "F" | "U", "DF" | "F" | "U"][] = [
        ["DF", "DF"],
        ["DF", "F"],
        ["DF", "U"],
        ["F", "F"],
        ["F", "U"],
        ["U", "U"],
      ];

      for (const [sa, sb] of pairings) {
        it(`compares ${sa}/${sb} by content (equal -> true)`, () => {
          const a = states[sa](equalShape());
          const b = states[sb](equalShape());
          expect(valueEqual(a, b)).toBe(true);
        });

        it(`compares ${sa}/${sb} by content (unequal -> false)`, () => {
          const a = states[sa](equalShape());
          const b = states[sb](unequalShape());
          expect(valueEqual(a, b)).toBe(false);
        });
      }
    });

    // The cheap subtype short-circuits that resolve an object comparison
    // without computing a hash (taken when the sides are not both deep-frozen).
    describe("object-subtype-check branch", () => {
      describe("given a plain object and an array", () => {
        it("are not equal", () => {
          expect(valueEqual({ 0: 1, 1: 2 }, [1, 2])).toBe(false);
          expect(valueEqual([1, 2], { 0: 1, 1: 2 })).toBe(false);
        });
      });

      describe("given a Fabric* value and a plain object or array", () => {
        it("are not equal", () => {
          const fb = new FabricBytes(new Uint8Array([1, 2]));
          expect(valueEqual(fb, { 0: 1, 1: 2 })).toBe(false);
          expect(valueEqual({ 0: 1, 1: 2 }, fb)).toBe(false);
          expect(valueEqual(fb, [1, 2])).toBe(false);
          expect(valueEqual([1, 2], fb)).toBe(false);
        });
      });

      describe("given two same-subtype Fabric* values", () => {
        it("compares them by content", () => {
          // Same subtype falls through to the hash compare.
          expect(
            valueEqual(
              new FabricBytes(new Uint8Array([1, 2])),
              new FabricBytes(new Uint8Array([1, 2])),
            ),
          ).toBe(true);
          expect(
            valueEqual(
              new FabricBytes(new Uint8Array([1, 2])),
              new FabricBytes(new Uint8Array([3, 4])),
            ),
          ).toBe(false);
          expect(valueEqual(new FabricRegExp(/a/g), new FabricRegExp(/a/g)))
            .toBe(true);
          expect(valueEqual(new FabricEpochDays(7n), new FabricEpochDays(7n)))
            .toBe(true);
        });
      });

      describe("given two distinct `FabricPrimitive` subtypes", () => {
        it("returns `false`", () => {
          expect(
            valueEqual(
              new FabricBytes(new Uint8Array([1])),
              new FabricRegExp(/a/),
            ),
          )
            .toBe(false);
          expect(valueEqual(new FabricEpochDays(1n), new FabricRegExp(/a/)))
            .toBe(false);
        });
      });

      describe("given two distinct mutable `FabricInstance` subtypes", () => {
        it("returns `false`", () => {
          expect(
            valueEqual(
              FabricError.fromNativeError(new Error("eek")),
              new UnknownValue("Unknownie@123", null),
            ),
          )
            .toBe(false);
        });
      });

      describe("given two same-subtype plain containers", () => {
        it("compares them by content", () => {
          // Same subtype + same content -> hash -> true; differing -> false.
          expect(valueEqual({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true);
          expect(valueEqual({ a: 1, b: 2 }, { a: 1, b: 9 })).toBe(false);
          expect(valueEqual([1, 2, 3], [1, 2, 3])).toBe(true);
          expect(valueEqual([1, 2, 3], [1, 2, 9])).toBe(false);
        });
      });
    });
  });
});
