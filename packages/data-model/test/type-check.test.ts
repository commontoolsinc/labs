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
    describe("given a scalar `FabricValue`", () => {
      it("returns `true` for a boolean", () => {
        expect(isFabricValueLayer(true)).toBe(true);
        expect(isFabricValueLayer(false)).toBe(true);
      });

      it("returns `true` for a string", () => {
        expect(isFabricValueLayer("")).toBe(true);
        expect(isFabricValueLayer("hello")).toBe(true);
        expect(isFabricValueLayer("with\nnewlines")).toBe(true);
      });

      it("returns `true` for a finite number (including `-0`)", () => {
        expect(isFabricValueLayer(0)).toBe(true);
        expect(isFabricValueLayer(-0)).toBe(true);
        expect(isFabricValueLayer(1)).toBe(true);
        expect(isFabricValueLayer(-1)).toBe(true);
        expect(isFabricValueLayer(3.14159)).toBe(true);
        expect(isFabricValueLayer(Number.MAX_VALUE)).toBe(true);
        expect(isFabricValueLayer(Number.MIN_VALUE)).toBe(true);
      });

      it("returns `true` for a non-finite number", () => {
        expect(isFabricValueLayer(NaN)).toBe(true);
        expect(isFabricValueLayer(Infinity)).toBe(true);
        expect(isFabricValueLayer(-Infinity)).toBe(true);
      });

      it("returns `true` for a `bigint`", () => {
        expect(isFabricValueLayer(0n)).toBe(true);
        expect(isFabricValueLayer(123n)).toBe(true);
      });

      it("returns `true` for an interned symbol", () => {
        expect(isFabricValueLayer(Symbol.for("k"))).toBe(true);
      });

      it("returns `true` for `null`", () => {
        expect(isFabricValueLayer(null)).toBe(true);
      });

      it("returns `true` for `undefined`", () => {
        expect(isFabricValueLayer(undefined)).toBe(true);
      });
    });

    describe("given a container or fabric object", () => {
      it("returns `true` for a plain object", () => {
        expect(isFabricValueLayer({})).toBe(true);
        expect(isFabricValueLayer({ a: 1 })).toBe(true);
        expect(isFabricValueLayer({ nested: { object: true } })).toBe(true);
      });

      it("returns `true` for a null-prototype object", () => {
        const obj = Object.create(null) as Record<string, unknown>;
        obj.a = 1;
        expect(isFabricValueLayer(obj)).toBe(true);
      });

      it("returns `true` for a dense array", () => {
        expect(isFabricValueLayer([])).toBe(true);
        expect(isFabricValueLayer([1, 2, 3])).toBe(true);
        expect(isFabricValueLayer([{ a: 1 }, { b: 2 }])).toBe(true);
        expect(isFabricValueLayer([null, "test", null])).toBe(true);
      });

      it("returns `true` for an array with `undefined` elements", () => {
        expect(isFabricValueLayer([1, undefined, 3])).toBe(true);
        expect(isFabricValueLayer([undefined])).toBe(true);
      });

      it("returns `true` for a sparse array (with holes)", () => {
        const sparse: unknown[] = [];
        sparse[0] = 1;
        sparse[2] = 3; // hole at index 1
        expect(isFabricValueLayer(sparse)).toBe(true);
      });

      it("returns `true` for a `FabricInstance`", () => {
        const fe = FabricError.fromNativeError(new Error("test"));
        expect(isFabricValueLayer(fe)).toBe(true);
      });

      it("returns `true` for a `FabricPrimitive`", () => {
        const bytes = new FabricBytes(new Uint8Array([1, 2, 3]));
        expect(isFabricValueLayer(bytes)).toBe(true);
      });

      it("returns `true` without recursively validating contents", () => {
        // `isFabricValueLayer()` is a shallow, per-se check; deep validation is
        // `isFabricCompatible()`'s job. A non-fabric nested value does not
        // make the container itself fail the per-se check.
        expect(isFabricValueLayer({ a: Symbol("x") })).toBe(true);
        expect(isFabricValueLayer([Symbol("x")])).toBe(true);
      });
    });

    describe("given a non-`FabricValue`", () => {
      it("returns `false` for an array with extra non-numeric properties", () => {
        const arr = [1, 2, 3] as unknown[] & { foo?: string };
        arr.foo = "bar";
        expect(isFabricValueLayer(arr)).toBe(false);
      });

      it("returns `false` for a sparse array with extra named properties", () => {
        // Length 3, hole at index 1, plus a named property "foo": still
        // `false` because the named property isn't a valid array index.
        const sparse = [] as unknown[] & { foo?: string };
        sparse[0] = 1;
        sparse[2] = 3;
        sparse.foo = "bar";
        expect(isFabricValueLayer(sparse)).toBe(false);
      });

      it("returns `false` for a function", () => {
        expect(isFabricValueLayer(() => {})).toBe(false);
        expect(isFabricValueLayer(function () {})).toBe(false);
        expect(isFabricValueLayer(async () => {})).toBe(false);
      });

      it("returns `false` for a class instance", () => {
        expect(isFabricValueLayer(new Date())).toBe(false);
        expect(isFabricValueLayer(new Map())).toBe(false);
        expect(isFabricValueLayer(new Set())).toBe(false);
        expect(isFabricValueLayer(/regex/)).toBe(false);
      });

      it("returns `false` for a unique (uninterned) symbol", () => {
        expect(isFabricValueLayer(Symbol("k"))).toBe(false);
      });
    });
  });

  describe("isFabricValue()", () => {
    describe("given a scalar `FabricValue`", () => {
      it("returns `true` for a boolean", () => {
        expect(isFabricValue(true)).toBe(true);
        expect(isFabricValue(false)).toBe(true);
      });

      it("returns `true` for a string", () => {
        expect(isFabricValue("")).toBe(true);
        expect(isFabricValue("hello")).toBe(true);
      });

      it("returns `true` for a finite number (including `-0`)", () => {
        expect(isFabricValue(0)).toBe(true);
        expect(isFabricValue(-0)).toBe(true);
        expect(isFabricValue(3.14159)).toBe(true);
        expect(isFabricValue(Number.MAX_VALUE)).toBe(true);
      });

      it("returns `true` for a non-finite number (`NaN`, `±Infinity`)", () => {
        expect(isFabricValue(NaN)).toBe(true);
        expect(isFabricValue(Infinity)).toBe(true);
        expect(isFabricValue(-Infinity)).toBe(true);
      });

      it("returns `true` for a `bigint`", () => {
        expect(isFabricValue(0n)).toBe(true);
        expect(isFabricValue(123n)).toBe(true);
      });

      it("returns `true` for an interned symbol", () => {
        // Registry-interned symbols are portable and are members, matching
        // `isFabricValueLayer()`.
        expect(isFabricValue(Symbol.for("k"))).toBe(true);
      });

      it("returns `true` for `null`", () => {
        expect(isFabricValue(null)).toBe(true);
      });

      it("returns `true` for `undefined`", () => {
        expect(isFabricValue(undefined)).toBe(true);
      });
    });

    describe("given a nested container", () => {
      it("returns `true` for a plain object of `FabricValue`s", () => {
        expect(isFabricValue({})).toBe(true);
        expect(isFabricValue({ a: 1, b: "two", c: null })).toBe(true);
        expect(isFabricValue({ nested: { deeply: { value: 1 } } })).toBe(true);
      });

      it("returns `true` for a null-prototype object", () => {
        const obj = Object.create(null) as Record<string, unknown>;
        obj.a = 1;
        expect(isFabricValue(obj)).toBe(true);
      });

      it("returns `true` for an array of `FabricValue`s", () => {
        expect(isFabricValue([])).toBe(true);
        expect(isFabricValue([1, 2, 3])).toBe(true);
        expect(isFabricValue([{ a: 1 }, [2, 3], "x"])).toBe(true);
      });

      it("returns `true` for an array with `undefined` elements and sparse holes", () => {
        expect(isFabricValue([1, undefined, 3])).toBe(true);
        const sparse: unknown[] = [];
        sparse[0] = 1;
        sparse[2] = 3; // hole at index 1
        expect(isFabricValue(sparse)).toBe(true);
      });

      it("returns `true` for a `FabricPrimitive` (`FabricBytes`, `FabricEpochNsec`)", () => {
        expect(isFabricValue(new FabricBytes(new Uint8Array([1, 2, 3]))))
          .toBe(true);
        expect(isFabricValue(new FabricEpochNsec(0n))).toBe(true);
      });

      it("returns `true` for a `FabricInstance` (`FabricError`)", () => {
        expect(isFabricValue(FabricError.fromNativeError(new Error("x"))))
          .toBe(true);
      });

      it("returns `true` for a `FabricInstance` nested in a tree", () => {
        const fe = FabricError.fromNativeError(new Error("nested"));
        expect(isFabricValue({ a: 1, e: fe, list: [fe] })).toBe(true);
      });
    });

    describe("given an unfrozen value (membership ignores frozen-ness)", () => {
      it("returns `true` for an unfrozen plain object and array", () => {
        // Structurally valid but not frozen: still a `FabricValue`. This is the
        // deliberate difference from `isDeepFrozenFabricValue()`.
        const obj = { a: 1, nested: { b: 2 } };
        expect(Object.isFrozen(obj)).toBe(false);
        expect(isFabricValue(obj)).toBe(true);
        expect(isFabricValue([1, [2, 3]])).toBe(true);
      });

      it("returns `true` for an unfrozen `FabricInstance` (member by type)", () => {
        // A `FabricInstance` is a member by type; membership does not require it
        // to be deep-frozen and does not recurse into its private interior.
        const fe = FabricError.fromNativeError(new Error("test"));
        expect(Object.isFrozen(fe)).toBe(false);
        expect(isFabricValue(fe)).toBe(true);
      });
    });

    describe("given a non-`FabricValue`", () => {
      it("returns `false` for a function at the top level", () => {
        expect(isFabricValue(() => {})).toBe(false);
        expect(isFabricValue(function () {})).toBe(false);
        expect(isFabricValue(async () => {})).toBe(false);
      });

      it("returns `false` for a function reached anywhere within the graph", () => {
        expect(isFabricValue({ a: 1, fn: () => {} })).toBe(false);
        expect(isFabricValue([1, [2, () => {}]])).toBe(false);
        expect(isFabricValue({ deep: { nested: { fn: () => {} } } }))
          .toBe(false);
      });

      it("returns `false` for a non-fabric class instance (`Date`, `Map`, `Set`, `RegExp`)", () => {
        expect(isFabricValue(new Date())).toBe(false);
        expect(isFabricValue(new Map())).toBe(false);
        expect(isFabricValue(new Set())).toBe(false);
        expect(isFabricValue(/regex/)).toBe(false);
      });

      it("returns `false` for a non-fabric class instance nested in the graph", () => {
        expect(isFabricValue({ a: 1, d: new Date() })).toBe(false);
        expect(isFabricValue([1, [2, new Map()]])).toBe(false);
      });

      it("returns `false` for an array with enumerable named (non-index) properties", () => {
        const arr = [1, 2, 3] as unknown[] & { foo?: string };
        arr.foo = "bar";
        expect(isFabricValue(arr)).toBe(false);
      });

      it("returns `false` for a named-property array nested in the graph", () => {
        const arr = [1, 2] as unknown[] & { extra?: number };
        arr.extra = 42;
        expect(isFabricValue({ data: arr })).toBe(false);
      });

      it("returns `false` for a unique (uninterned) symbol", () => {
        expect(isFabricValue(Symbol("k"))).toBe(false);
      });

      it("returns `false` for a unique (uninterned) symbol reached within the graph", () => {
        expect(isFabricValue({ a: 1, s: Symbol("nope") })).toBe(false);
        expect(isFabricValue([Symbol("nope")])).toBe(false);
      });
    });

    describe("given a circular reference", () => {
      it("returns `true` (terminates) for a self-referential plain object", () => {
        const a: Record<string, unknown> = { x: 1 };
        a.self = a;
        expect(() => isFabricValue(a)).not.toThrow();
        expect(isFabricValue(a)).toBe(true);
      });

      it("returns `true` (terminates) for a two-node cycle (a -> b -> a)", () => {
        const a: Record<string, unknown> = { tag: "a" };
        const b: Record<string, unknown> = { tag: "b" };
        a.next = b;
        b.next = a;
        expect(() => isFabricValue(a)).not.toThrow();
        expect(isFabricValue(a)).toBe(true);
      });

      it("returns `true` (terminates) for a self-referential array", () => {
        const arr: unknown[] = [1, 2];
        arr.push(arr);
        expect(() => isFabricValue(arr)).not.toThrow();
        expect(isFabricValue(arr)).toBe(true);
      });

      it("returns `false` for a non-member reached past a cycle", () => {
        const a: Record<string, unknown> = { tag: "a" };
        a.self = a;
        a.bad = () => {};
        expect(isFabricValue(a)).toBe(false);
      });
    });
  });

  describe("isFabricPlainObject()", () => {
    describe("given the plain-record arm of `FabricValue`", () => {
      it("returns `true` for a plain object", () => {
        expect(isFabricPlainObject({})).toBe(true);
        expect(isFabricPlainObject({ a: 1, b: "two" })).toBe(true);
      });

      it("returns `true` for a null-prototype object", () => {
        const obj = Object.create(null) as Record<string, never>;
        expect(isFabricPlainObject(obj)).toBe(true);
      });
    });

    describe("given a non-record `FabricValue`", () => {
      it("returns `false` for an array", () => {
        expect(isFabricPlainObject([])).toBe(false);
        expect(isFabricPlainObject([1, 2, 3])).toBe(false);
      });

      it("returns `false` for `null`", () => {
        expect(isFabricPlainObject(null)).toBe(false);
      });

      it("returns `false` for `undefined`", () => {
        expect(isFabricPlainObject(undefined)).toBe(false);
      });

      it("returns `false` for a primitive", () => {
        expect(isFabricPlainObject(1)).toBe(false);
        expect(isFabricPlainObject("a")).toBe(false);
        expect(isFabricPlainObject(true)).toBe(false);
        expect(isFabricPlainObject(42n)).toBe(false);
      });

      it("returns `false` for a `FabricSpecialObject`", () => {
        expect(isFabricPlainObject(new FabricBytes(new Uint8Array([1]))))
          .toBe(false);
        expect(isFabricPlainObject(FabricError.fromNativeError(new Error("x"))))
          .toBe(false);
      });

      it("returns `false` for a non-plain class instance (`Date`, `Map`, …)", () => {
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
