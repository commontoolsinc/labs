import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { isFabricPlainObject, isFabricValueLayer } from "@/type-check.ts";
import { FabricError } from "@/fabric-instances/FabricError.ts";
import { FabricBytes } from "@/fabric-primitives/FabricBytes.ts";

describe("type-check", () => {
  describe("isFabricValueLayer()", () => {
    describe("returns `true` for fabric values", () => {
      it("accepts booleans", () => {
        expect(isFabricValueLayer(true)).toBe(true);
        expect(isFabricValueLayer(false)).toBe(true);
      });

      it("accepts strings", () => {
        expect(isFabricValueLayer("")).toBe(true);
        expect(isFabricValueLayer("hello")).toBe(true);
        expect(isFabricValueLayer("with\nnewlines")).toBe(true);
      });

      it("accepts finite numbers (including `-0`)", () => {
        expect(isFabricValueLayer(0)).toBe(true);
        expect(isFabricValueLayer(-0)).toBe(true);
        expect(isFabricValueLayer(1)).toBe(true);
        expect(isFabricValueLayer(-1)).toBe(true);
        expect(isFabricValueLayer(3.14159)).toBe(true);
        expect(isFabricValueLayer(Number.MAX_VALUE)).toBe(true);
        expect(isFabricValueLayer(Number.MIN_VALUE)).toBe(true);
      });

      it("accepts non-finite numbers", () => {
        expect(isFabricValueLayer(NaN)).toBe(true);
        expect(isFabricValueLayer(Infinity)).toBe(true);
        expect(isFabricValueLayer(-Infinity)).toBe(true);
      });

      it("accepts `bigint`", () => {
        expect(isFabricValueLayer(0n)).toBe(true);
        expect(isFabricValueLayer(123n)).toBe(true);
      });

      it("accepts interned symbols", () => {
        expect(isFabricValueLayer(Symbol.for("k"))).toBe(true);
      });

      it("accepts `null`", () => {
        expect(isFabricValueLayer(null)).toBe(true);
      });

      it("accepts `undefined`", () => {
        expect(isFabricValueLayer(undefined)).toBe(true);
      });

      it("accepts plain objects", () => {
        expect(isFabricValueLayer({})).toBe(true);
        expect(isFabricValueLayer({ a: 1 })).toBe(true);
        expect(isFabricValueLayer({ nested: { object: true } })).toBe(true);
      });

      it("accepts null-prototype objects", () => {
        const obj = Object.create(null) as Record<string, unknown>;
        obj.a = 1;
        expect(isFabricValueLayer(obj)).toBe(true);
      });

      it("accepts dense arrays", () => {
        expect(isFabricValueLayer([])).toBe(true);
        expect(isFabricValueLayer([1, 2, 3])).toBe(true);
        expect(isFabricValueLayer([{ a: 1 }, { b: 2 }])).toBe(true);
        expect(isFabricValueLayer([null, "test", null])).toBe(true);
      });

      it("accepts arrays with `undefined` elements", () => {
        expect(isFabricValueLayer([1, undefined, 3])).toBe(true);
        expect(isFabricValueLayer([undefined])).toBe(true);
      });

      it("accepts sparse arrays (arrays with holes)", () => {
        const sparse: unknown[] = [];
        sparse[0] = 1;
        sparse[2] = 3; // hole at index 1
        expect(isFabricValueLayer(sparse)).toBe(true);
      });

      it("accepts `FabricInstance` values", () => {
        const fe = FabricError.fromNativeError(new Error("test"));
        expect(isFabricValueLayer(fe)).toBe(true);
      });

      it("accepts `FabricPrimitive` values", () => {
        const bytes = new FabricBytes(new Uint8Array([1, 2, 3]));
        expect(isFabricValueLayer(bytes)).toBe(true);
      });

      it("does not recursively validate container contents", () => {
        // `isFabricValueLayer()` is a shallow, per-se check; deep validation is
        // `isFabricCompatible()`'s job. A non-fabric nested value does not
        // make the container itself fail the per-se check.
        expect(isFabricValueLayer({ a: Symbol("x") })).toBe(true);
        expect(isFabricValueLayer([Symbol("x")])).toBe(true);
      });
    });

    describe("returns `false` for non-fabric values", () => {
      it("rejects arrays with extra non-numeric properties", () => {
        const arr = [1, 2, 3] as unknown[] & { foo?: string };
        arr.foo = "bar";
        expect(isFabricValueLayer(arr)).toBe(false);
      });

      it("rejects sparse arrays with extra named properties", () => {
        // Length 3, hole at index 1, plus a named property "foo": still
        // rejected because the named property isn't a valid array index.
        const sparse = [] as unknown[] & { foo?: string };
        sparse[0] = 1;
        sparse[2] = 3;
        sparse.foo = "bar";
        expect(isFabricValueLayer(sparse)).toBe(false);
      });

      it("rejects functions", () => {
        expect(isFabricValueLayer(() => {})).toBe(false);
        expect(isFabricValueLayer(function () {})).toBe(false);
        expect(isFabricValueLayer(async () => {})).toBe(false);
      });

      it("rejects class instances", () => {
        expect(isFabricValueLayer(new Date())).toBe(false);
        expect(isFabricValueLayer(new Map())).toBe(false);
        expect(isFabricValueLayer(new Set())).toBe(false);
        expect(isFabricValueLayer(/regex/)).toBe(false);
      });

      it("rejects unique (uninterned) symbols", () => {
        expect(isFabricValueLayer(Symbol("k"))).toBe(false);
      });
    });
  });

  describe("isFabricPlainObject()", () => {
    describe("returns `true` for the plain-record arm of `FabricValue`", () => {
      it("accepts a plain object", () => {
        expect(isFabricPlainObject({})).toBe(true);
        expect(isFabricPlainObject({ a: 1, b: "two" })).toBe(true);
      });

      it("accepts a null-prototype object", () => {
        const obj = Object.create(null) as Record<string, never>;
        expect(isFabricPlainObject(obj)).toBe(true);
      });
    });

    describe("returns `false` for non-record `FabricValue`s", () => {
      it("rejects arrays", () => {
        expect(isFabricPlainObject([])).toBe(false);
        expect(isFabricPlainObject([1, 2, 3])).toBe(false);
      });

      it("rejects `null`", () => {
        expect(isFabricPlainObject(null)).toBe(false);
      });

      it("rejects `undefined`", () => {
        expect(isFabricPlainObject(undefined)).toBe(false);
      });

      it("rejects primitives", () => {
        expect(isFabricPlainObject(1)).toBe(false);
        expect(isFabricPlainObject("a")).toBe(false);
        expect(isFabricPlainObject(true)).toBe(false);
        expect(isFabricPlainObject(42n)).toBe(false);
      });

      it("rejects `FabricSpecialObject` values", () => {
        expect(isFabricPlainObject(new FabricBytes(new Uint8Array([1]))))
          .toBe(false);
        expect(isFabricPlainObject(FabricError.fromNativeError(new Error("x"))))
          .toBe(false);
      });

      it("rejects non-plain class instances (`Date`, `Map`, …)", () => {
        // These values are not FabricValue objects, but the guard accepts unknown input.
        expect(isFabricPlainObject(new Date())).toBe(false);
        expect(isFabricPlainObject(new Map())).toBe(false);
        expect(isFabricPlainObject(/regex/)).toBe(false);
      });
    });
  });
});
