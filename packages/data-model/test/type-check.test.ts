import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  isFabricPlainObject,
  isFabricValue,
  isFabricValueLayer,
} from "@/type-check.ts";
import type { FabricValue } from "@/interface.ts";
import { FabricError } from "@/fabric-instances/FabricError.ts";
import { FabricBytes } from "@/fabric-primitives/FabricBytes.ts";
import { FabricEpochNsec } from "@/fabric-primitives/FabricEpochNsec.ts";

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

  describe("isFabricValue()", () => {
    describe("returns `true` for scalar members", () => {
      it("accepts booleans", () => {
        expect(isFabricValue(true)).toBe(true);
        expect(isFabricValue(false)).toBe(true);
      });

      it("accepts strings", () => {
        expect(isFabricValue("")).toBe(true);
        expect(isFabricValue("hello")).toBe(true);
      });

      it("accepts finite numbers (including `-0`)", () => {
        expect(isFabricValue(0)).toBe(true);
        expect(isFabricValue(-0)).toBe(true);
        expect(isFabricValue(3.14159)).toBe(true);
        expect(isFabricValue(Number.MAX_VALUE)).toBe(true);
      });

      it("accepts non-finite numbers (`NaN`, `±Infinity`)", () => {
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
    });

    describe("returns `true` for structural members, recursively", () => {
      it("accepts plain objects of fabric values", () => {
        expect(isFabricValue({})).toBe(true);
        expect(isFabricValue({ a: 1, b: "two", c: null })).toBe(true);
        expect(isFabricValue({ nested: { deeply: { value: 1 } } })).toBe(true);
      });

      it("accepts null-prototype objects", () => {
        const obj = Object.create(null) as Record<string, unknown>;
        obj.a = 1;
        expect(isFabricValue(obj)).toBe(true);
      });

      it("accepts arrays of fabric values", () => {
        expect(isFabricValue([])).toBe(true);
        expect(isFabricValue([1, 2, 3])).toBe(true);
        expect(isFabricValue([{ a: 1 }, [2, 3], "x"])).toBe(true);
      });

      it("accepts arrays with `undefined` elements and sparse holes", () => {
        expect(isFabricValue([1, undefined, 3])).toBe(true);
        const sparse: unknown[] = [];
        sparse[0] = 1;
        sparse[2] = 3; // hole at index 1
        expect(isFabricValue(sparse)).toBe(true);
      });

      it("accepts a `FabricPrimitive` (`FabricBytes`, `FabricEpochNsec`)", () => {
        expect(isFabricValue(new FabricBytes(new Uint8Array([1, 2, 3]))))
          .toBe(true);
        expect(isFabricValue(new FabricEpochNsec(0n))).toBe(true);
      });

      it("accepts a `FabricInstance` (`FabricError`)", () => {
        expect(isFabricValue(FabricError.fromNativeError(new Error("x"))))
          .toBe(true);
      });

      it("accepts a fabric instance nested in a tree", () => {
        const fe = FabricError.fromNativeError(new Error("nested"));
        expect(isFabricValue({ a: 1, e: fe, list: [fe] })).toBe(true);
      });
    });

    describe("membership is independent of frozen-ness", () => {
      it("accepts an unfrozen plain object and array", () => {
        // Structurally valid but not frozen: still a `FabricValue`. This is the
        // deliberate difference from `isDeepFrozenFabricValue()`.
        const obj = { a: 1, nested: { b: 2 } };
        expect(Object.isFrozen(obj)).toBe(false);
        expect(isFabricValue(obj)).toBe(true);
        expect(isFabricValue([1, [2, 3]])).toBe(true);
      });

      it("accepts an unfrozen `FabricInstance` (member by type)", () => {
        // A fabric instance is a member by type; membership does not require it
        // to be deep-frozen and does not recurse into its private interior.
        const fe = FabricError.fromNativeError(new Error("test"));
        expect(Object.isFrozen(fe)).toBe(false);
        expect(isFabricValue(fe)).toBe(true);
      });
    });

    describe("returns `false` for non-members", () => {
      it("rejects functions at the top level", () => {
        expect(isFabricValue(() => {})).toBe(false);
        expect(isFabricValue(function () {})).toBe(false);
        expect(isFabricValue(async () => {})).toBe(false);
      });

      it("rejects a function reached anywhere within the graph", () => {
        expect(isFabricValue({ a: 1, fn: () => {} })).toBe(false);
        expect(isFabricValue([1, [2, () => {}]])).toBe(false);
        expect(isFabricValue({ deep: { nested: { fn: () => {} } } }))
          .toBe(false);
      });

      it("rejects non-fabric class instances (`Date`, `Map`, `Set`, `RegExp`)", () => {
        expect(isFabricValue(new Date())).toBe(false);
        expect(isFabricValue(new Map())).toBe(false);
        expect(isFabricValue(new Set())).toBe(false);
        expect(isFabricValue(/regex/)).toBe(false);
      });

      it("rejects a non-fabric class instance nested in the graph", () => {
        expect(isFabricValue({ a: 1, d: new Date() })).toBe(false);
        expect(isFabricValue([1, [2, new Map()]])).toBe(false);
      });

      it("rejects arrays with enumerable named (non-index) properties", () => {
        const arr = [1, 2, 3] as unknown[] & { foo?: string };
        arr.foo = "bar";
        expect(isFabricValue(arr)).toBe(false);
      });

      it("rejects a named-property array nested in the graph", () => {
        const arr = [1, 2] as unknown[] & { extra?: number };
        arr.extra = 42;
        expect(isFabricValue({ data: arr })).toBe(false);
      });
    });

    describe("handles circular references", () => {
      it("terminates on a self-referential plain object", () => {
        const a: Record<string, unknown> = { x: 1 };
        a.self = a;
        expect(() => isFabricValue(a)).not.toThrow();
        expect(isFabricValue(a)).toBe(true);
      });

      it("terminates on a two-node cycle (a -> b -> a)", () => {
        const a: Record<string, unknown> = { tag: "a" };
        const b: Record<string, unknown> = { tag: "b" };
        a.next = b;
        b.next = a;
        expect(() => isFabricValue(a)).not.toThrow();
        expect(isFabricValue(a)).toBe(true);
      });

      it("terminates on a self-referential array", () => {
        const arr: unknown[] = [1, 2];
        arr.push(arr);
        expect(() => isFabricValue(arr)).not.toThrow();
        expect(isFabricValue(arr)).toBe(true);
      });

      it("still rejects a non-member reached past a cycle", () => {
        const a: Record<string, unknown> = { tag: "a" };
        a.self = a;
        a.bad = () => {};
        expect(isFabricValue(a)).toBe(false);
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
        // Not representable as a `FabricPlainObject`; reachable only via an unsound
        // cast, so the guard is fed them as `unknown`.
        expect(isFabricPlainObject(new Date() as unknown as FabricValue))
          .toBe(false);
        expect(isFabricPlainObject(new Map() as unknown as FabricValue))
          .toBe(false);
        expect(isFabricPlainObject(/regex/ as unknown as FabricValue))
          .toBe(false);
      });
    });
  });
});
