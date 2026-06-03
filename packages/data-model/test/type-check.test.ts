import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { isFabricValue } from "../src/type-check.ts";
import { FabricError } from "../src/fabric-instances/FabricError.ts";
import { FabricBytes } from "../src/fabric-primitives/FabricBytes.ts";

describe("type-check", () => {
  describe("isFabricValue()", () => {
    describe("returns `true` for fabric values", () => {
      it("accepts booleans", () => {
        expect(isFabricValue(true)).toBe(true);
        expect(isFabricValue(false)).toBe(true);
      });

      it("accepts strings", () => {
        expect(isFabricValue("")).toBe(true);
        expect(isFabricValue("hello")).toBe(true);
        expect(isFabricValue("with\nnewlines")).toBe(true);
      });

      it("accepts finite numbers (including `-0`)", () => {
        expect(isFabricValue(0)).toBe(true);
        expect(isFabricValue(-0)).toBe(true);
        expect(isFabricValue(1)).toBe(true);
        expect(isFabricValue(-1)).toBe(true);
        expect(isFabricValue(3.14159)).toBe(true);
        expect(isFabricValue(Number.MAX_VALUE)).toBe(true);
        expect(isFabricValue(Number.MIN_VALUE)).toBe(true);
      });

      it("accepts non-finite numbers", () => {
        expect(isFabricValue(NaN)).toBe(true);
        expect(isFabricValue(Infinity)).toBe(true);
        expect(isFabricValue(-Infinity)).toBe(true);
      });

      it("accepts `bigint`", () => {
        expect(isFabricValue(0n)).toBe(true);
        expect(isFabricValue(123n)).toBe(true);
      });

      it("accepts interned symbols", () => {
        expect(isFabricValue(Symbol.for("k"))).toBe(true);
      });

      it("accepts `null`", () => {
        expect(isFabricValue(null)).toBe(true);
      });

      it("accepts `undefined`", () => {
        expect(isFabricValue(undefined)).toBe(true);
      });

      it("accepts plain objects", () => {
        expect(isFabricValue({})).toBe(true);
        expect(isFabricValue({ a: 1 })).toBe(true);
        expect(isFabricValue({ nested: { object: true } })).toBe(true);
      });

      it("accepts null-prototype objects", () => {
        const obj = Object.create(null) as Record<string, unknown>;
        obj.a = 1;
        expect(isFabricValue(obj)).toBe(true);
      });

      it("accepts dense arrays", () => {
        expect(isFabricValue([])).toBe(true);
        expect(isFabricValue([1, 2, 3])).toBe(true);
        expect(isFabricValue([{ a: 1 }, { b: 2 }])).toBe(true);
        expect(isFabricValue([null, "test", null])).toBe(true);
      });

      it("accepts arrays with `undefined` elements", () => {
        expect(isFabricValue([1, undefined, 3])).toBe(true);
        expect(isFabricValue([undefined])).toBe(true);
      });

      it("accepts sparse arrays (arrays with holes)", () => {
        const sparse: unknown[] = [];
        sparse[0] = 1;
        sparse[2] = 3; // hole at index 1
        expect(isFabricValue(sparse)).toBe(true);
      });

      it("accepts `FabricInstance` values", () => {
        const fe = FabricError.fromNativeError(new Error("test"));
        expect(isFabricValue(fe)).toBe(true);
      });

      it("accepts `FabricPrimitive` values", () => {
        const bytes = new FabricBytes(new Uint8Array([1, 2, 3]));
        expect(isFabricValue(bytes)).toBe(true);
      });

      it("does not recursively validate container contents", () => {
        // `isFabricValue()` is a shallow, per-se check; deep validation is
        // `isFabricCompatible()`'s job. A non-fabric nested value does not
        // make the container itself fail the per-se check.
        expect(isFabricValue({ a: Symbol("x") })).toBe(true);
        expect(isFabricValue([Symbol("x")])).toBe(true);
      });
    });

    describe("returns `false` for non-fabric values", () => {
      it("rejects arrays with extra non-numeric properties", () => {
        const arr = [1, 2, 3] as unknown[] & { foo?: string };
        arr.foo = "bar";
        expect(isFabricValue(arr)).toBe(false);
      });

      it("rejects sparse arrays with extra named properties", () => {
        // Length 3, hole at index 1, plus a named property "foo": still
        // rejected because the named property isn't a valid array index.
        const sparse = [] as unknown[] & { foo?: string };
        sparse[0] = 1;
        sparse[2] = 3;
        sparse.foo = "bar";
        expect(isFabricValue(sparse)).toBe(false);
      });

      it("rejects functions", () => {
        expect(isFabricValue(() => {})).toBe(false);
        expect(isFabricValue(function () {})).toBe(false);
        expect(isFabricValue(async () => {})).toBe(false);
      });

      it("rejects class instances", () => {
        expect(isFabricValue(new Date())).toBe(false);
        expect(isFabricValue(new Map())).toBe(false);
        expect(isFabricValue(new Set())).toBe(false);
        expect(isFabricValue(/regex/)).toBe(false);
      });

      it("rejects unique (uninterned) symbols", () => {
        expect(isFabricValue(Symbol("k"))).toBe(false);
      });
    });
  });
});
