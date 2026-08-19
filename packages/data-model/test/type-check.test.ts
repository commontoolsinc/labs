/**
 * Membership in the `FabricValue` type, asked one level deep and asked all the
 * way down, plus the narrowing to its plain-record arm.
 *
 * The two depths ask the same question at different scopes, and the cases are
 * arranged around where that difference tells.
 *
 * Frozen-ness is deliberately not part of membership, and a group here says so
 * outright -- the two are easy to conflate when nearly every fabric value in
 * circulation happens to be frozen. Cycles are handled rather than refused.
 */

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

    describe("given a plain object with unrepresentable keys", () => {
      // A symbol is a valid fabric *value* but not a property *name*:
      // `FabricPlainObject` is keyed by `string`. A non-enumerable string key
      // has no representation either, being dropped by every encoding.

      it("returns `false` for a symbol-keyed property", () => {
        const obj = { a: 1 } as Record<string | symbol, unknown>;
        obj[Symbol("s")] = 2;
        expect(isFabricValueLayer(obj)).toBe(false);
      });

      it("returns `false` for a registered symbol-keyed property", () => {
        const obj = { a: 1 } as Record<string | symbol, unknown>;
        obj[Symbol.for("s")] = 2;
        expect(isFabricValueLayer(obj)).toBe(false);
      });

      it("returns `false` for a non-enumerable string-keyed property", () => {
        const obj = { a: 1 };
        Object.defineProperty(obj, "hidden", { value: 2, enumerable: false });
        expect(isFabricValueLayer(obj)).toBe(false);
      });

      it("returns `false` for an accessor-backed property", () => {
        // An accessor is live code, not inert data: a read executes it and can
        // return a different value every time. Freezing does not change that.
        const obj = { a: 1 };
        Object.defineProperty(obj, "g", { get: () => 2, enumerable: true });
        expect(isFabricValueLayer(obj)).toBe(false);
        expect(isFabricValueLayer(Object.freeze(obj))).toBe(false);
      });

      it("returns `false` for a setter-only property", () => {
        const obj = { a: 1 };
        Object.defineProperty(obj, "s", { set: () => {}, enumerable: true });
        expect(isFabricValueLayer(obj)).toBe(false);
      });

      it("returns `true` for an object whose keys are all enumerable strings", () => {
        expect(isFabricValueLayer({ a: 1, b: 2 })).toBe(true);
        expect(isFabricValueLayer({})).toBe(true);
      });

      it("returns `false` for a property name this runtime reserves", () => {
        // Not a statement about the data model: such an object is perfectly
        // inert, and a runtime that does not route assignment through a
        // prototype chain would carry it fine. It is refused because in this
        // host the name cannot survive the copy that every boundary performs.
        expect(isFabricValueLayer({ ["__proto__"]: 1, other: 2 })).toBe(false);
        expect(isFabricValueLayer({ ["constructor"]: 1 })).toBe(false);
      });

      it("returns `false` for a null-prototype object", () => {
        // A record has one shape here: `Object.prototype`-rooted. A prototype
        // is not part of what a value says as data and would not survive
        // encoding, so a value carrying a different one is refused rather than
        // accepted and quietly changed.
        const obj = Object.create(null) as Record<string, unknown>;
        obj.a = 1;
        expect(isFabricValueLayer(obj)).toBe(false);
        expect(isFabricValueLayer(Object.create(null))).toBe(false);
      });
    });

    describe("given a non-`FabricValue`", () => {
      it("returns `false` for an array with extra non-numeric properties", () => {
        const arr = [1, 2, 3] as unknown[] & { foo?: string };
        arr.foo = "bar";
        expect(isFabricValueLayer(arr)).toBe(false);
      });

      it("returns `false` for an array with a symbol-keyed property", () => {
        const arr = [1, 2, 3];
        (arr as unknown as Record<symbol, unknown>)[Symbol("foo")] = "bar";
        expect(isFabricValueLayer(arr)).toBe(false);
      });

      it("returns `false` for an array with an accessor-backed index", () => {
        // An accessor is live code, not inert data: a read executes it and can
        // return a different value every time. Freezing does not change that.
        const arr = [1, 2, 3];
        Object.defineProperty(arr, 1, {
          get: () => 22,
          enumerable: true,
          configurable: false,
        });
        expect(isFabricValueLayer(arr)).toBe(false);
        expect(isFabricValueLayer(Object.freeze(arr))).toBe(false);
      });

      it("returns `false` for an array with a setter-only index", () => {
        const arr = [1, 2, 3];
        Object.defineProperty(arr, 2, { set: () => {}, enumerable: true });
        expect(isFabricValueLayer(arr)).toBe(false);
      });

      it("returns `false` for an `Array` subclass instance", () => {
        // A subclass prototype is live code just as an accessor is, and
        // freezing the instance does not change that.
        class Sub extends Array {}
        const sub = new Sub();
        sub.push(1, 2);
        expect(isFabricValueLayer(sub)).toBe(false);
        expect(isFabricValueLayer(Object.freeze(sub))).toBe(false);
      });

      it("returns `false` for an array whose prototype was severed", () => {
        const severed: unknown[] = [1, 2];
        Object.setPrototypeOf(severed, null);
        expect(isFabricValueLayer(severed)).toBe(false);
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
    it("returns `true` for a schema using the `if` / `then` / `else` keywords", () => {
      // This system's schemas are themselves fabric values, and JSON Schema
      // spells conditional subschemas with those three keywords. So `then` is
      // a data key a schema routinely carries, and reserving it -- as a
      // defense against promise resolution adopting a callable `then` -- would
      // stop an ordinary schema being a fabric value at all. That hazard is
      // handled where a property can become callable, in the value proxies,
      // rather than by refusing the name here.
      expect(isFabricValue({
        type: "object",
        if: { properties: { kind: { const: "a" } } },
        then: { required: ["aField"] },
        else: { required: ["bField"] },
      })).toBe(true);
    });

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

      it("returns `false` for a reserved property name, at any depth", () => {
        const unsafe = { ["__proto__"]: 1 };
        expect(isFabricValue(unsafe)).toBe(false);
        expect(isFabricValue({ nested: unsafe })).toBe(false);
        expect(isFabricValue([unsafe])).toBe(false);
        expect(isFabricValue({ ["constructor"]: 1 })).toBe(false);
      });

      it("returns `false` for a null-prototype object, at any depth", () => {
        const obj = Object.create(null) as Record<string, unknown>;
        obj.a = 1;
        expect(isFabricValue(obj)).toBe(false);
        expect(isFabricValue({ nested: obj })).toBe(false);
        expect(isFabricValue([obj])).toBe(false);
      });

      it("returns `false` for an object with a symbol-keyed property", () => {
        const obj = { a: 1 } as Record<string | symbol, unknown>;
        obj[Symbol("s")] = 2;
        expect(isFabricValue(obj)).toBe(false);
      });

      it("returns `false` for an object with a non-enumerable string key", () => {
        const obj = { a: 1 };
        Object.defineProperty(obj, "hidden", { value: 2, enumerable: false });
        expect(isFabricValue(obj)).toBe(false);
      });

      it("returns `false` for a symbol-keyed object nested in the graph", () => {
        const inner = { a: 1 } as Record<string | symbol, unknown>;
        inner[Symbol("s")] = 2;
        expect(isFabricValue({ outer: [inner] })).toBe(false);
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
        // A `FabricInstance` is a member by type. Membership does not require
        // it to be deep-frozen, and does not recurse into its private
        // interior.
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

      it("returns `false` for an accessor-backed property, at any depth", () => {
        // An accessor is live code, not inert data: a read executes it and can
        // return a different value every time. Freezing does not change that.
        const top = { a: 1 };
        Object.defineProperty(top, "g", { get: () => 2, enumerable: true });
        expect(isFabricValue(top)).toBe(false);
        expect(isFabricValue(Object.freeze(top))).toBe(false);

        const inner = { b: 3 };
        Object.defineProperty(inner, "g", { get: () => 4, enumerable: true });
        expect(isFabricValue({ outer: inner })).toBe(false);
        expect(isFabricValue([1, [inner]])).toBe(false);
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

      it("returns `false` for an array with a symbol-keyed property", () => {
        const arr = [1, 2, 3];
        (arr as unknown as Record<symbol, unknown>)[Symbol("foo")] = "bar";
        expect(isFabricValue(arr)).toBe(false);
      });

      it("returns `false` for an array with a non-enumerable named property", () => {
        const arr = [1, 2, 3];
        Object.defineProperty(arr, "foo", { value: "bar", enumerable: false });
        expect(isFabricValue(arr)).toBe(false);
      });

      it("returns `false` for an accessor-backed array index, at any depth", () => {
        // An accessor is live code, not inert data, no matter the container:
        // an array index reaches it just as a plain-object key does.
        const top = [1, 2, 3];
        Object.defineProperty(top, 1, {
          get: () => 22,
          enumerable: true,
          configurable: false,
        });
        expect(isFabricValue(top)).toBe(false);
        expect(isFabricValue(Object.freeze(top))).toBe(false);

        const inner = [4, 5];
        Object.defineProperty(inner, 0, { set: () => {}, enumerable: true });
        expect(isFabricValue({ data: inner })).toBe(false);
        expect(isFabricValue([1, [inner]])).toBe(false);
      });

      it("returns `false` for a symbol-keyed-property array nested in the graph", () => {
        const arr = [1, 2];
        (arr as unknown as Record<symbol, unknown>)[Symbol.for("extra")] = 42;
        expect(isFabricValue({ data: arr })).toBe(false);
      });

      it("returns `false` for an indirect `Array` instance, at any depth", () => {
        // A subclass prototype is live code no matter the container: an
        // overridden `Symbol.iterator` makes iteration yield content the
        // indices never show, and freezing does not reach the prototype.
        class Sub extends Array {}
        const top = new Sub();
        top.push(1, 2);
        expect(isFabricValue(top)).toBe(false);
        expect(isFabricValue(Object.freeze(top))).toBe(false);
        expect(isFabricValue({ data: top })).toBe(false);
        expect(isFabricValue([1, [top]])).toBe(false);

        const severed: unknown[] = [3, 4];
        Object.setPrototypeOf(severed, null);
        expect(isFabricValue(severed)).toBe(false);
        expect(isFabricValue({ data: severed })).toBe(false);
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
        // Not representable as a `FabricPlainObject`, and reachable only via
        // an unsound cast, so the guard is fed them as `unknown`.
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
