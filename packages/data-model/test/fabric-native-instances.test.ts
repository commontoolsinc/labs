import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  DECONSTRUCT,
  DEEP_FREEZE,
  FabricInstance,
  type FabricValue,
  IS_DEEP_FROZEN,
  RECONSTRUCT,
} from "../interface.ts";
import { BaseReconstructionContext } from "../base-reconstruction-context.ts";
import {
  FabricError,
  FabricMap,
  FabricNativeWrapper,
  FabricRegExp,
  FabricSet,
  isConvertibleNativeInstance,
} from "../fabric-native-instances.ts";
import { nativeFromFabricValueModern } from "../fabric-value-modern.ts";
import { FrozenMap, FrozenSet } from "../frozen-builtins.ts";
import {
  NATIVE_TAGS,
  tagFromNativeClass,
  tagFromNativeValue,
} from "../native-type-tags.ts";
import { UnknownValue } from "../unknown-value.ts";
import { ProblematicValue } from "../problematic-value.ts";
import { ExplicitTagValue } from "../explicit-tag-value.ts";
import {
  deepFreeze,
  isDeepFrozen,
  isDeepFrozenFabricValue,
} from "../deep-freeze.ts";

/** Dummy reconstruction context for tests. */
class DummyReconstructionContext extends BaseReconstructionContext {
  override getCell(): never {
    throw new Error("getCell not implemented in test");
  }
}
const dummyContext = new DummyReconstructionContext();

// ============================================================================
// Tests
// ============================================================================

describe("fabric-native-instances", () => {
  // --------------------------------------------------------------------------
  // FabricError
  // --------------------------------------------------------------------------

  describe("FabricError", () => {
    it("implements FabricInstance (instanceof returns true)", () => {
      const se = FabricError.fromNativeError(new Error("test"));
      expect(se instanceof FabricInstance).toBe(true);
    });

    it("has typeTag 'Error@1'", () => {
      const se = FabricError.fromNativeError(new Error("test"));
      expect(se.typeTag).toBe("Error@1");
    });

    it("wraps the Error's FabricValue-shaped state", () => {
      const err = new TypeError("bad");
      const se = FabricError.fromNativeError(err);
      expect(se.type).toBe("TypeError");
      expect(se.name).toBe("TypeError");
      expect(se.message).toBe("bad");
    });

    it("is instanceof FabricNativeWrapper", () => {
      const se = FabricError.fromNativeError(new Error("test"));
      expect(se instanceof FabricNativeWrapper).toBe(true);
    });

    it("[DECONSTRUCT] returns type, name=null (common case), message, stack", () => {
      const se = FabricError.fromNativeError(new Error("hello"));
      const state = se[DECONSTRUCT]() as Record<string, FabricValue>;
      expect(state.type).toBe("Error");
      expect(state.name).toBe(null);
      expect(state.message).toBe("hello");
      expect(typeof state.stack).toBe("string");
    });

    it("[DECONSTRUCT] name is null when type === name (TypeError)", () => {
      const se = FabricError.fromNativeError(new TypeError("bad"));
      const state = se[DECONSTRUCT]() as Record<string, FabricValue>;
      expect(state.type).toBe("TypeError");
      expect(state.name).toBe(null);
    });

    it("[DECONSTRUCT] name is non-null when type !== name", () => {
      const err = new TypeError("bad");
      err.name = "CustomName";
      const se = FabricError.fromNativeError(err);
      const state = se[DECONSTRUCT]() as Record<string, FabricValue>;
      expect(state.type).toBe("TypeError");
      expect(state.name).toBe("CustomName");
    });

    it("[DECONSTRUCT] includes cause when present", () => {
      const inner = FabricError.fromNativeError(new Error("inner"));
      const outer = FabricError.fromNativeError(
        new Error("outer", { cause: inner }),
      );
      const state = outer[DECONSTRUCT]() as Record<string, FabricValue>;
      expect(state.cause).toBe(inner);
    });

    it("[DECONSTRUCT] includes custom enumerable properties", () => {
      const err = new Error("oops");
      (err as unknown as Record<string, unknown>).code = 42;
      (err as unknown as Record<string, unknown>).detail = "more info";
      const se = FabricError.fromNativeError(err);
      const state = se[DECONSTRUCT]() as Record<string, FabricValue>;
      expect(state.code).toBe(42);
      expect(state.detail).toBe("more info");
    });

    it("[DECONSTRUCT] does not copy __proto__ or constructor keys", () => {
      const err = new Error("test");
      Object.defineProperty(err, "__proto__", {
        value: "bad",
        enumerable: true,
      });
      const se = FabricError.fromNativeError(err);
      const state = se[DECONSTRUCT]() as Record<string, FabricValue>;
      expect("__proto__" in state).toBe(false);
    });

    it("[DECONSTRUCT] custom props do not override built-in fields", () => {
      const err = new Error("original");
      // Manually set an enumerable "message" property -- should not override
      Object.defineProperty(err, "message", {
        value: "original",
        enumerable: true,
      });
      (err as unknown as Record<string, unknown>).name = "Error";
      const se = FabricError.fromNativeError(err);
      const state = se[DECONSTRUCT]() as Record<string, FabricValue>;
      expect(state.message).toBe("original");
    });

    it("[DECONSTRUCT] omits stack when undefined", () => {
      const err = new Error("no stack");
      err.stack = undefined;
      const se = FabricError.fromNativeError(err);
      const state = se[DECONSTRUCT]() as Record<string, FabricValue>;
      expect("stack" in state).toBe(false);
    });

    it("[RECONSTRUCT] creates FabricError from state (null name = same as type)", () => {
      const state = {
        type: "Error",
        name: null,
        message: "hello",
      } as FabricValue;
      const result = FabricError[RECONSTRUCT](state, dummyContext);
      expect(result).toBeInstanceOf(FabricError);
      expect(result.toNativeValue(true)).toBeInstanceOf(Error);
      expect(result.name).toBe("Error");
      expect(result.message).toBe("hello");
    });

    it("[RECONSTRUCT] creates correct Error subclass from type (null name)", () => {
      const cases: [string, ErrorConstructor][] = [
        ["TypeError", TypeError],
        ["RangeError", RangeError],
        ["SyntaxError", SyntaxError],
        ["ReferenceError", ReferenceError],
        ["URIError", URIError],
        ["EvalError", EvalError],
      ];
      for (const [type, cls] of cases) {
        const state = { type, name: null, message: "test" } as FabricValue;
        const result = FabricError[RECONSTRUCT](state, dummyContext);
        expect(result.toNativeValue(true)).toBeInstanceOf(cls);
        expect(result.name).toBe(type);
      }
    });

    it("[RECONSTRUCT] handles type != name (e.g. TypeError with custom name)", () => {
      const state = {
        type: "TypeError",
        name: "CustomTypeName",
        message: "mismatch",
      } as FabricValue;
      const result = FabricError[RECONSTRUCT](state, dummyContext);
      expect(result.toNativeValue(true)).toBeInstanceOf(TypeError);
      expect(result.name).toBe("CustomTypeName");
    });

    it("[RECONSTRUCT] falls back to name when type is absent (back-compat)", () => {
      const state = {
        name: "TypeError",
        message: "old format",
      } as FabricValue;
      const result = FabricError[RECONSTRUCT](state, dummyContext);
      expect(result.toNativeValue(true)).toBeInstanceOf(TypeError);
    });

    it("[RECONSTRUCT] handles custom name", () => {
      const state = {
        type: "Error",
        name: "MyCustomError",
        message: "custom",
      } as FabricValue;
      const result = FabricError[RECONSTRUCT](state, dummyContext);
      expect(result.name).toBe("MyCustomError");
    });

    it("[RECONSTRUCT] restores cause and custom properties", () => {
      const state = {
        type: "Error",
        name: null,
        message: "with extras",
        cause: "something went wrong",
        code: 404,
      } as FabricValue;
      const result = FabricError[RECONSTRUCT](state, dummyContext);
      expect(result.cause).toBe("something went wrong");
      expect(result.getExtra("code")).toBe(404);
    });

    it("round-trips through DECONSTRUCT/RECONSTRUCT", () => {
      const original = new Error("round trip");
      original.name = "CustomError";
      (original as unknown as Record<string, unknown>).code = 42;
      const se = FabricError.fromNativeError(original);

      const state = se[DECONSTRUCT]();
      const restored = FabricError[RECONSTRUCT](state, dummyContext);

      expect(restored.name).toBe("CustomError");
      expect(restored.message).toBe("round trip");
      expect(restored.getExtra("code")).toBe(42);
    });

    it("round-trips TypeError with overridden name", () => {
      const original = new TypeError("bad value");
      original.name = "SpecialType";
      const se = FabricError.fromNativeError(original);

      const state = se[DECONSTRUCT]() as Record<string, FabricValue>;
      expect(state.type).toBe("TypeError");
      expect(state.name).toBe("SpecialType");

      const restored = FabricError[RECONSTRUCT](
        state as FabricValue,
        dummyContext,
      );
      expect(restored.toNativeValue(true)).toBeInstanceOf(TypeError);
      expect(restored.name).toBe("SpecialType");
    });

    it("toNativeValue(true) returns a frozen Error projection", () => {
      const err = new Error("native");
      const se = FabricError.fromNativeError(err);
      const result = se.toNativeValue(true);
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toBe("native");
      expect(Object.isFrozen(result)).toBe(true);
      // The originating native Error is not stored / not mutated.
      expect(Object.isFrozen(err)).toBe(false);
    });

    it("toNativeValue(true) returns the same projection on repeat calls", () => {
      const se = FabricError.fromNativeError(new Error("native"));
      const a = se.toNativeValue(true);
      const b = se.toNativeValue(true);
      expect(a).toBe(b);
      expect(Object.isFrozen(a)).toBe(true);
    });

    it("toNativeValue(false) returns a fresh unfrozen Error projection", () => {
      const se = FabricError.fromNativeError(new Error("native"));
      const result = se.toNativeValue(false);
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toBe("native");
      expect(Object.isFrozen(result)).toBe(false);
    });

    it("toNativeValue(false) returns a fresh copy each call", () => {
      const se = FabricError.fromNativeError(new Error("native"));
      const a = se.toNativeValue(false);
      const b = se.toNativeValue(false);
      expect(a).not.toBe(b);
      expect(a.message).toBe(b.message);
    });
  });

  // --------------------------------------------------------------------------
  // Stub wrappers
  // --------------------------------------------------------------------------

  describe("stub wrappers", () => {
    it("FabricMap implements FabricInstance", () => {
      const sm = new FabricMap(new Map());
      expect(sm instanceof FabricInstance).toBe(true);
      expect(sm.typeTag).toBe("Map@1");
    });

    it("FabricMap is instanceof FabricNativeWrapper", () => {
      const sm = new FabricMap(new Map());
      expect(sm instanceof FabricNativeWrapper).toBe(true);
    });

    it("FabricMap [DECONSTRUCT] throws (stub)", () => {
      const sm = new FabricMap(new Map());
      expect(() => sm[DECONSTRUCT]()).toThrow("not yet implemented");
    });

    it("FabricMap [RECONSTRUCT] throws (stub)", () => {
      expect(() => FabricMap[RECONSTRUCT](null, dummyContext)).toThrow(
        "not yet implemented",
      );
    });

    it("FabricMap.toNativeValue(true) returns FrozenMap", () => {
      const map = new Map<FabricValue, FabricValue>([["a", 1]]);
      const sm = new FabricMap(map);
      const result = sm.toNativeValue(true);
      expect(result).toBeInstanceOf(FrozenMap);
      expect((result as FrozenMap<string, number>).get("a")).toBe(1);
    });

    it("FabricMap.toNativeValue(false) returns the original Map", () => {
      const map = new Map<FabricValue, FabricValue>([["a", 1]]);
      const sm = new FabricMap(map);
      const result = sm.toNativeValue(false);
      expect(result).toBe(map); // same reference
      expect(result).toBeInstanceOf(Map);
      expect(result).not.toBeInstanceOf(FrozenMap);
    });

    it("FabricMap.toNativeValue(true) returns same FrozenMap if already frozen", () => {
      const fm = new FrozenMap<FabricValue, FabricValue>([["a", 1]]);
      const sm = new FabricMap(fm);
      const result = sm.toNativeValue(true);
      expect(result).toBe(fm); // same reference
    });

    it("FabricMap.toNativeValue(false) copies a FrozenMap to mutable Map", () => {
      const fm = new FrozenMap<FabricValue, FabricValue>([["a", 1]]);
      const sm = new FabricMap(fm);
      const result = sm.toNativeValue(false);
      expect(result).not.toBe(fm);
      expect(result).toBeInstanceOf(Map);
      expect(result).not.toBeInstanceOf(FrozenMap);
      expect(result.get("a" as FabricValue)).toBe(1);
    });

    it("FabricSet implements FabricInstance", () => {
      const ss = new FabricSet(new Set());
      expect(ss instanceof FabricInstance).toBe(true);
      expect(ss.typeTag).toBe("Set@1");
    });

    it("FabricSet [DECONSTRUCT] throws (stub)", () => {
      const ss = new FabricSet(new Set());
      expect(() => ss[DECONSTRUCT]()).toThrow("not yet implemented");
    });

    it("FabricSet.toNativeValue(true) returns FrozenSet", () => {
      const set = new Set<FabricValue>([1, 2]);
      const ss = new FabricSet(set);
      const result = ss.toNativeValue(true);
      expect(result).toBeInstanceOf(FrozenSet);
      expect((result as FrozenSet<number>).has(1)).toBe(true);
    });

    it("FabricSet.toNativeValue(false) returns the original Set", () => {
      const set = new Set<FabricValue>([1, 2]);
      const ss = new FabricSet(set);
      const result = ss.toNativeValue(false);
      expect(result).toBe(set); // same reference
      expect(result).toBeInstanceOf(Set);
      expect(result).not.toBeInstanceOf(FrozenSet);
    });

    it("FabricSet.toNativeValue(true) returns same FrozenSet if already frozen", () => {
      const fs = new FrozenSet<FabricValue>([1, 2]);
      const ss = new FabricSet(fs);
      const result = ss.toNativeValue(true);
      expect(result).toBe(fs); // same reference
    });

    it("FabricSet.toNativeValue(false) copies a FrozenSet to mutable Set", () => {
      const fs = new FrozenSet<FabricValue>([1, 2]);
      const ss = new FabricSet(fs);
      const result = ss.toNativeValue(false);
      expect(result).not.toBe(fs);
      expect(result).toBeInstanceOf(Set);
      expect(result).not.toBeInstanceOf(FrozenSet);
      expect(result.has(1 as FabricValue)).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // nativeFromFabricValueModern (deep unwrap)
  // --------------------------------------------------------------------------

  describe("nativeFromFabricValueModern", () => {
    it("unwraps FabricError in nested object", () => {
      const se = FabricError.fromNativeError(new Error("deep"));
      const obj = { error: se } as FabricValue;
      const result = nativeFromFabricValueModern(obj) as Record<
        string,
        unknown
      >;
      expect(result.error).toBeInstanceOf(Error);
      expect((result.error as Error).message).toBe("deep");
    });

    it("unwraps FabricMap in nested array", () => {
      const sm = new FabricMap(
        new Map<FabricValue, FabricValue>([["k", "v"]]),
      );
      const arr = [sm] as FabricValue;
      const result = nativeFromFabricValueModern(arr) as unknown[];
      expect(result[0]).toBeInstanceOf(FrozenMap);
    });

    it("unwraps FabricMap to mutable Map when frozen=false", () => {
      const sm = new FabricMap(
        new Map<FabricValue, FabricValue>([["k", "v"]]),
      );
      const arr = [sm] as FabricValue;
      const result = nativeFromFabricValueModern(arr, false) as unknown[];
      expect(result[0]).toBeInstanceOf(Map);
      expect(result[0]).not.toBeInstanceOf(FrozenMap);
    });

    it("passes through primitives at all levels", () => {
      const obj = { a: 1, b: "two", c: null, d: true } as FabricValue;
      const result = nativeFromFabricValueModern(obj) as Record<
        string,
        unknown
      >;
      expect(result).toEqual({ a: 1, b: "two", c: null, d: true });
    });

    it("recursively unwraps nested structures", () => {
      const se = FabricError.fromNativeError(new Error("nested"));
      const obj = {
        outer: {
          inner: se,
        },
      } as FabricValue;
      const result = nativeFromFabricValueModern(obj) as {
        outer: { inner: Error };
      };
      expect(result.outer.inner).toBeInstanceOf(Error);
      expect(result.outer.inner.message).toBe("nested");
    });

    it("deeply unwraps FabricError in objects (frozen)", () => {
      const err = new Error("deep");
      const se = FabricError.fromNativeError(err);
      const obj = {
        error: se,
        code: 500,
      } as unknown as FabricValue;
      const result = nativeFromFabricValueModern(obj) as Record<
        string,
        unknown
      >;
      expect(result.error).toBeInstanceOf(Error);
      expect((result.error as Error).message).toBe("deep");
      expect(Object.isFrozen(result.error)).toBe(true);
      expect(result.code).toBe(500);
      expect(Object.isFrozen(result)).toBe(true);
    });

    it("deeply unwraps FabricError in arrays (frozen)", () => {
      const err = new Error("array");
      const se = FabricError.fromNativeError(err);
      const arr = [1, se, 3] as unknown as FabricValue;
      const result = nativeFromFabricValueModern(arr) as unknown[];
      expect(result[0]).toBe(1);
      expect(result[1]).toBeInstanceOf(Error);
      expect((result[1] as Error).message).toBe("array");
      expect(Object.isFrozen(result[1])).toBe(true);
      expect(result[2]).toBe(3);
      expect(Object.isFrozen(result)).toBe(true);
    });

    it("output is not frozen when frozen=false", () => {
      const obj = Object.freeze({
        a: 1,
        b: "two",
      }) as unknown as FabricValue;
      const result = nativeFromFabricValueModern(obj, false) as Record<
        string,
        unknown
      >;
      // Output should be a new, unfrozen object.
      expect(Object.isFrozen(result)).toBe(false);
      result.a = 99; // should not throw
      expect(result.a).toBe(99);
    });

    it("output is frozen when frozen=true (default)", () => {
      const obj = { a: 1, b: "two" } as unknown as FabricValue;
      const result = nativeFromFabricValueModern(obj) as Record<
        string,
        unknown
      >;
      expect(Object.isFrozen(result)).toBe(true);
    });

    it("preserves sparse holes", () => {
      const arr = new Array(3) as FabricValue[];
      arr[0] = 1;
      arr[2] = 3;
      Object.freeze(arr);
      const result = nativeFromFabricValueModern(
        arr as FabricValue,
      ) as unknown[];
      expect(result.length).toBe(3);
      expect(result[0]).toBe(1);
      expect(1 in result).toBe(false); // hole preserved
      expect(result[2]).toBe(3);
    });

    it("passes through non-native FabricInstance", () => {
      const us = new UnknownValue("Test@1", null);
      const obj = { thing: us } as unknown as FabricValue;
      const result = nativeFromFabricValueModern(obj) as Record<
        string,
        unknown
      >;
      expect(result.thing).toBe(us);
    });

    it("deeply unwraps FabricMap to FrozenMap", () => {
      const map = new Map<FabricValue, FabricValue>([
        ["x", 10],
      ] as [FabricValue, FabricValue][]);
      const sm = new FabricMap(map);
      const obj = { data: sm } as unknown as FabricValue;
      const result = nativeFromFabricValueModern(obj) as Record<
        string,
        unknown
      >;
      expect(result.data).toBeInstanceOf(FrozenMap);
      expect((result.data as Map<string, number>).get("x")).toBe(10);
    });

    it("deeply unwraps FabricSet to FrozenSet", () => {
      const set = new Set<FabricValue>([42] as FabricValue[]);
      const ss = new FabricSet(set);
      const arr = [ss] as unknown as FabricValue;
      const result = nativeFromFabricValueModern(arr) as unknown[];
      expect(result[0]).toBeInstanceOf(FrozenSet);
      expect((result[0] as Set<number>).has(42)).toBe(true);
    });

    it("deeply unwraps Error internals (C2)", () => {
      // Error with a FabricError cause and a custom FabricMap property.
      const innerErr = new Error("inner");
      const innerSe = FabricError.fromNativeError(innerErr);
      const outerErr = new Error("outer");
      outerErr.cause = innerSe;
      (outerErr as unknown as Record<string, unknown>).data = new FabricMap(
        new Map([["k", 1]] as [FabricValue, FabricValue][]),
      );
      const outerSe = FabricError.fromNativeError(outerErr);

      const result = nativeFromFabricValueModern(
        outerSe as FabricValue,
      ) as Error;
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toBe("outer");
      // cause should be deeply unwrapped to a native Error, not FabricError.
      expect(result.cause).toBeInstanceOf(Error);
      expect((result.cause as Error).message).toBe("inner");
      // custom property should be unwrapped to FrozenMap.
      const data = (result as unknown as Record<string, unknown>).data;
      expect(data).toBeInstanceOf(FrozenMap);
    });

    it("deeply unwraps Error internals unfrozen (C2)", () => {
      const innerErr = new Error("inner");
      const innerSe = FabricError.fromNativeError(innerErr);
      const outerErr = new Error("outer");
      outerErr.cause = innerSe;
      const outerSe = FabricError.fromNativeError(outerErr);

      const result = nativeFromFabricValueModern(
        outerSe as FabricValue,
        false,
      ) as Error;
      expect(result).toBeInstanceOf(Error);
      expect(Object.isFrozen(result)).toBe(false);
      expect(result.cause).toBeInstanceOf(Error);
      expect(Object.isFrozen(result.cause)).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // tagFromNativeValue / tagFromNativeClass / isConvertibleNativeInstance
  // --------------------------------------------------------------------------

  describe("tagFromNativeValue", () => {
    it("returns Error tag for standard Error subclasses", () => {
      const cases: [string, Error][] = [
        ["Error", new Error("test")],
        ["TypeError", new TypeError("test")],
        ["RangeError", new RangeError("test")],
        ["SyntaxError", new SyntaxError("test")],
        ["ReferenceError", new ReferenceError("test")],
        ["URIError", new URIError("test")],
        ["EvalError", new EvalError("test")],
      ];
      for (const [_name, value] of cases) {
        expect(tagFromNativeValue(value)).toBe(NATIVE_TAGS.Error);
      }
    });

    it("returns Error tag for exotic Error subclass (custom class)", () => {
      class MyFancyError extends Error {
        constructor(msg: string) {
          super(msg);
          this.name = "MyFancyError";
        }
      }
      const exotic = new MyFancyError("exotic");
      // Constructor is MyFancyError, not in the switch -- falls back to
      // Error.isError().
      expect(tagFromNativeValue(exotic)).toBe(NATIVE_TAGS.Error);
    });

    it("returns Map tag for Map instances", () => {
      expect(tagFromNativeValue(new Map())).toBe(NATIVE_TAGS.Map);
    });

    it("returns Set tag for Set instances", () => {
      expect(tagFromNativeValue(new Set())).toBe(NATIVE_TAGS.Set);
    });

    it("returns Date tag for Date instances", () => {
      expect(tagFromNativeValue(new Date())).toBe(NATIVE_TAGS.Date);
    });

    it("returns Uint8Array tag for Uint8Array instances", () => {
      expect(tagFromNativeValue(new Uint8Array())).toBe(
        NATIVE_TAGS.Uint8Array,
      );
    });

    it("returns Object tag for plain objects", () => {
      expect(tagFromNativeValue({})).toBe(NATIVE_TAGS.Object);
    });

    it("returns Array tag for arrays", () => {
      expect(tagFromNativeValue([])).toBe(NATIVE_TAGS.Array);
    });

    it("returns RegExp tag for RegExp instances", () => {
      expect(tagFromNativeValue(/abc/)).toBe(NATIVE_TAGS.RegExp);
    });

    it("returns Object tag for null-prototype objects (no constructor)", () => {
      const obj = Object.create(null);
      expect(tagFromNativeValue(obj)).toBe(NATIVE_TAGS.Object);
    });

    it("returns HasToJSON tag for plain objects with toJSON()", () => {
      const obj = { toJSON: () => "converted" };
      expect(tagFromNativeValue(obj)).toBe(NATIVE_TAGS.HasToJSON);
    });

    it("returns HasToJSON tag for arrays with toJSON()", () => {
      const arr = [1, 2, 3] as unknown[] & { toJSON?: () => unknown };
      arr.toJSON = () => "custom array";
      expect(tagFromNativeValue(arr)).toBe(NATIVE_TAGS.HasToJSON);
    });

    it("returns HasToJSON tag for class instances with toJSON()", () => {
      class Custom {
        toJSON() {
          return { x: 1 };
        }
      }
      expect(tagFromNativeValue(new Custom())).toBe(NATIVE_TAGS.HasToJSON);
    });

    it("returns Date tag for Date (not HasToJSON despite Date.toJSON)", () => {
      expect(tagFromNativeValue(new Date())).toBe(NATIVE_TAGS.Date);
    });

    // Functions are non-objects and return Primitive from tagFromNativeValue.
    // In practice, functions with toJSON() are handled separately in
    // the modern conversion path, not via tagFromNativeValue.
    it("returns Primitive for functions (even with toJSON)", () => {
      const fn = () => {};
      (fn as unknown as { toJSON: () => string }).toJSON = () => "converted";
      expect(tagFromNativeValue(fn)).toBe(NATIVE_TAGS.Primitive);
    });
  });

  describe("tagFromNativeClass", () => {
    it("returns Error tag for standard Error constructors", () => {
      const constructors = [
        Error,
        TypeError,
        RangeError,
        SyntaxError,
        ReferenceError,
        URIError,
        EvalError,
      ];
      for (const ctor of constructors) {
        expect(tagFromNativeClass(ctor)).toBe(NATIVE_TAGS.Error);
      }
    });

    it("returns Error tag for exotic Error subclass constructor", () => {
      class ExoticError extends Error {}
      // Constructor is ExoticError, not in the switch -- falls back to
      // Error.isError(prototype) check.
      expect(tagFromNativeClass(ExoticError)).toBe(NATIVE_TAGS.Error);
    });

    it("returns correct tags for Array, Object, Map, Set, Date, Uint8Array", () => {
      expect(tagFromNativeClass(Array)).toBe(NATIVE_TAGS.Array);
      expect(tagFromNativeClass(Object)).toBe(NATIVE_TAGS.Object);
      expect(tagFromNativeClass(Map)).toBe(NATIVE_TAGS.Map);
      expect(tagFromNativeClass(Set)).toBe(NATIVE_TAGS.Set);
      expect(tagFromNativeClass(Date)).toBe(NATIVE_TAGS.Date);
      expect(tagFromNativeClass(Uint8Array)).toBe(NATIVE_TAGS.Uint8Array);
    });

    it("returns RegExp tag for RegExp constructor", () => {
      expect(tagFromNativeClass(RegExp)).toBe(NATIVE_TAGS.RegExp);
    });

    it("returns null for unrecognized constructors", () => {
      expect(tagFromNativeClass(WeakMap)).toBe(null);
      expect(tagFromNativeClass(Promise)).toBe(null);
    });

    it("returns HasToJSON for class with toJSON on prototype", () => {
      class WithToJSON {
        toJSON() {
          return { x: 1 };
        }
      }
      expect(tagFromNativeClass(WithToJSON)).toBe(NATIVE_TAGS.HasToJSON);
    });

    it("returns HasToJSON for subclass inheriting toJSON", () => {
      class Base {
        toJSON() {
          return "base";
        }
      }
      class Sub extends Base {}
      expect(tagFromNativeClass(Sub)).toBe(NATIVE_TAGS.HasToJSON);
    });

    it("returns Date tag for Date (not HasToJSON despite Date.prototype.toJSON)", () => {
      expect(tagFromNativeClass(Date)).toBe(NATIVE_TAGS.Date);
    });

    it("returns null for class without toJSON", () => {
      class Plain {}
      expect(tagFromNativeClass(Plain)).toBe(null);
    });
  });

  describe("isConvertibleNativeInstance", () => {
    it("returns true for all convertible types", () => {
      expect(isConvertibleNativeInstance(new Error("e"))).toBe(true);
      expect(isConvertibleNativeInstance(new TypeError("e"))).toBe(true);
      expect(isConvertibleNativeInstance(new Map())).toBe(true);
      expect(isConvertibleNativeInstance(new Set())).toBe(true);
      expect(isConvertibleNativeInstance(new Date())).toBe(true);
      expect(isConvertibleNativeInstance(new Uint8Array())).toBe(true);
    });

    it("returns true for exotic Error subclass", () => {
      class WeirdError extends RangeError {}
      expect(isConvertibleNativeInstance(new WeirdError("weird"))).toBe(true);
    });

    it("returns true for RegExp", () => {
      expect(isConvertibleNativeInstance(/abc/)).toBe(true);
    });

    it("returns false for non-convertible types", () => {
      expect(isConvertibleNativeInstance({})).toBe(false);
      expect(isConvertibleNativeInstance([])).toBe(false);
      expect(isConvertibleNativeInstance(new WeakMap())).toBe(false);
    });

    it("returns false for objects with toJSON()", () => {
      expect(isConvertibleNativeInstance({ toJSON: () => "x" })).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // data-model-protocol: FabricInstance instanceof checks
  // --------------------------------------------------------------------------

  describe("FabricInstance instanceof checks", () => {
    it("returns false for null", () => {
      expect((null as unknown) instanceof FabricInstance).toBe(false);
    });

    it("returns false for undefined", () => {
      expect((undefined as unknown) instanceof FabricInstance).toBe(false);
    });

    it("returns false for primitives", () => {
      expect((42 as unknown) instanceof FabricInstance).toBe(false);
      expect(("hello" as unknown) instanceof FabricInstance).toBe(false);
      expect((true as unknown) instanceof FabricInstance).toBe(false);
    });

    it("returns false for plain objects", () => {
      expect(({} as unknown) instanceof FabricInstance).toBe(false);
      expect(({ a: 1 } as unknown) instanceof FabricInstance).toBe(false);
    });

    it("returns true for UnknownValue", () => {
      const us = new UnknownValue("Test@1", null);
      expect(us instanceof FabricInstance).toBe(true);
    });

    it("returns true for ProblematicValue", () => {
      const ps = new ProblematicValue("Test@1", null, "oops");
      expect(ps instanceof FabricInstance).toBe(true);
    });

    it("returns true for custom FabricInstance subclass", () => {
      class CustomFabInst extends FabricInstance {
        [DECONSTRUCT](): FabricValue {
          return { value: 42 };
        }
        [DEEP_FREEZE](
          _subFreeze: (value: FabricValue) => FabricValue,
        ): FabricValue {
          return this as unknown as FabricValue;
        }
        [IS_DEEP_FROZEN](
          _subIsDeepFrozen: (value: FabricValue) => boolean,
        ): boolean {
          return Object.isFrozen(this);
        }
        deepClone(_frozen: boolean): CustomFabInst {
          return new CustomFabInst();
        }
        protected shallowUnfrozenClone(): CustomFabInst {
          return new CustomFabInst();
        }
      }
      const instance = new CustomFabInst();
      expect(instance instanceof FabricInstance).toBe(true);
    });

    it("returns true for FabricError", () => {
      const se = FabricError.fromNativeError(new Error("test"));
      expect(se instanceof FabricInstance).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // UnknownValue
  // --------------------------------------------------------------------------

  describe("UnknownValue", () => {
    it("preserves typeTag and state", () => {
      const us = new UnknownValue("FancyType@3", { data: [1, 2, 3] });
      expect(us.typeTag).toBe("FancyType@3");
      expect(us.state).toEqual({ data: [1, 2, 3] });
    });

    it("has DECONSTRUCT method", () => {
      const us = new UnknownValue("Test@1", "state");
      expect(us[DECONSTRUCT]()).toEqual({
        type: "Test@1",
        state: "state",
      });
    });
  });

  // --------------------------------------------------------------------------
  // ProblematicValue
  // --------------------------------------------------------------------------

  describe("ProblematicValue", () => {
    it("preserves typeTag, state, and error", () => {
      const ps = new ProblematicValue("BadType@1", { x: 1 }, "boom");
      expect(ps.typeTag).toBe("BadType@1");
      expect(ps.state).toEqual({ x: 1 });
      expect(ps.error).toBe("boom");
    });

    it("has DECONSTRUCT method", () => {
      const ps = new ProblematicValue("T@1", "s", "e");
      expect(ps[DECONSTRUCT]()).toEqual({
        type: "T@1",
        state: "s",
        error: "e",
      });
    });
  });

  // --------------------------------------------------------------------------
  // ExplicitTagValue base class
  // --------------------------------------------------------------------------

  describe("ExplicitTagValue", () => {
    it("UnknownValue is an instance of ExplicitTagValue", () => {
      const us = new UnknownValue("Test@1", "state");
      expect(us instanceof ExplicitTagValue).toBe(true);
    });

    it("ProblematicValue is an instance of ExplicitTagValue", () => {
      const ps = new ProblematicValue("Test@1", "state", "oops");
      expect(ps instanceof ExplicitTagValue).toBe(true);
    });

    it("ExplicitTagValue provides access to typeTag and state", () => {
      const us: ExplicitTagValue = new UnknownValue("Tag@2", 42);
      expect(us.typeTag).toBe("Tag@2");
      expect(us.state).toBe(42);

      const ps: ExplicitTagValue = new ProblematicValue(
        "Bad@1",
        "data",
        "err",
      );
      expect(ps.typeTag).toBe("Bad@1");
      expect(ps.state).toBe("data");
    });
  });

  // --------------------------------------------------------------------------
  // [DEEP_FREEZE] / [IS_DEEP_FROZEN] protocol (F1)
  // --------------------------------------------------------------------------

  // Two complementary surfaces, kept SEPARATE on purpose (merge of U1 +
  // U4/#3612). They are NOT duplicates:
  //
  //   * "via dispatch" exercises the entry points `deepFreeze()` /
  //     `isDeepFrozenFabricValue()` -- i.e. the dispatch layer
  //     (`deep-freeze.ts` arm-3 / type-guard) correctly ROUTES to each
  //     instance's protocol member.
  //   * "direct member invocation" exercises the `[DEEP_FREEZE]` /
  //     `[IS_DEEP_FROZEN]` members THEMSELVES, called on the instance with
  //     a recursion callback, with no dependency on the dispatcher.
  //
  // U1 shipped only the protocol defs/impls/stubs (no dispatcher), so its
  // coverage had to invoke members directly; U4/#3612 adds the dispatcher
  // and its routing coverage. On the merged branch both layers exist, so
  // both surfaces are retained -- drop neither.

  describe("[DEEP_FREEZE] / [IS_DEEP_FROZEN] protocol — via dispatch", () => {
    describe("FabricError", () => {
      it("[DEEP_FREEZE] freezes wrapper + recurses cause", () => {
        const inner = FabricError.fromNativeError(new Error("cause"));
        const fe = FabricError.fromNativeError(
          new Error("outer", { cause: inner }),
        );
        const result = deepFreeze(fe);
        expect(result).toBe(fe); // freeze-in-place identity
        expect(Object.isFrozen(fe)).toBe(true);
        expect(isDeepFrozen(inner)).toBe(true);
      });

      it("[DEEP_FREEZE] recurses enumerable custom props (preserved via extras)", () => {
        const err = new Error("e");
        const childObj = { nested: 1 };
        (err as unknown as Record<string, unknown>).custom = childObj;
        const fe = FabricError.fromNativeError(err);
        deepFreeze(fe);
        // Non-string custom state is preserved AND deep-frozen.
        expect(fe.getExtra("custom")).toBe(childObj);
        expect(Object.isFrozen(childObj)).toBe(true);
      });

      it("[IS_DEEP_FROZEN] true only when wrapper + cause are frozen", () => {
        const fe = FabricError.fromNativeError(new Error("test"));
        expect(isDeepFrozenFabricValue(fe)).toBe(false);
        Object.freeze(fe); // wrapper only; some descendants still mutable
        // (May be true since this particular FabricError has no nested
        // FabricValue descendants beyond primitive strings.)
        deepFreeze(fe);
        expect(isDeepFrozenFabricValue(fe)).toBe(true);
      });
    });

    // FabricMap/FabricSet deliberately keep throwing stubs for the protocol
    // methods (per Dan's PR #3612 review: not yet used, reworked separately).
    describe("FabricMap (throwing stub)", () => {
      it("[DEEP_FREEZE] throws not-yet-implemented", () => {
        const fm = new FabricMap(
          new FrozenMap<FabricValue, FabricValue>([["a", 1]]),
        );
        expect(() => deepFreeze(fm)).toThrow("FabricMap: not yet implemented");
      });

      it("[IS_DEEP_FROZEN] throws not-yet-implemented (via type guard)", () => {
        const fm = new FabricMap(
          new FrozenMap<FabricValue, FabricValue>([["a", 1]]),
        );
        Object.freeze(fm);
        expect(() => isDeepFrozenFabricValue(fm)).toThrow(
          "FabricMap: not yet implemented",
        );
      });
    });

    describe("FabricSet (throwing stub)", () => {
      it("[DEEP_FREEZE] throws not-yet-implemented", () => {
        const fs = new FabricSet(new FrozenSet<FabricValue>([1, 2]));
        expect(() => deepFreeze(fs)).toThrow("FabricSet: not yet implemented");
      });

      it("[IS_DEEP_FROZEN] throws not-yet-implemented (via type guard)", () => {
        const fs = new FabricSet(new FrozenSet<FabricValue>([1, 2]));
        Object.freeze(fs);
        expect(() => isDeepFrozenFabricValue(fs)).toThrow(
          "FabricSet: not yet implemented",
        );
      });
    });

    describe("FabricRegExp", () => {
      it("[DEEP_FREEZE] freezes the wrapped RegExp in place", () => {
        const fr = new FabricRegExp(/abc/g);
        expect(Object.isFrozen(fr.regex)).toBe(false);
        const result = deepFreeze(fr);
        expect(result).toBe(fr);
        expect(Object.isFrozen(fr)).toBe(true);
        expect(Object.isFrozen(fr.regex)).toBe(true);
      });

      it("[IS_DEEP_FROZEN] true only when wrapper + RegExp frozen", () => {
        const fr = new FabricRegExp(/abc/g);
        expect(isDeepFrozenFabricValue(fr)).toBe(false);
        deepFreeze(fr);
        expect(isDeepFrozenFabricValue(fr)).toBe(true);
      });
    });

    describe("ExplicitTagValue subclasses", () => {
      it("ProblematicValue [DEEP_FREEZE] recurses state, freezes in place", () => {
        const child = { x: 1 };
        const pv = new ProblematicValue(
          "Bad@1",
          child as unknown as FabricValue,
          "oops",
        );
        const result = deepFreeze(pv);
        expect(result).toBe(pv);
        expect(Object.isFrozen(pv)).toBe(true);
        expect(Object.isFrozen(child)).toBe(true);
        expect(isDeepFrozenFabricValue(pv)).toBe(true);
      });

      it("UnknownValue [DEEP_FREEZE] recurses state, freezes in place", () => {
        const child = { y: 2 };
        const uv = new UnknownValue(
          "Fancy@3",
          child as unknown as FabricValue,
        );
        const result = deepFreeze(uv);
        expect(result).toBe(uv);
        expect(Object.isFrozen(uv)).toBe(true);
        expect(Object.isFrozen(child)).toBe(true);
        expect(isDeepFrozenFabricValue(uv)).toBe(true);
      });
    });
  });

  // These exercise the `[DEEP_FREEZE]` / `[IS_DEEP_FROZEN]` protocol members
  // DIRECTLY (invoking them on the instance with a recursion callback),
  // rather than through `deepFreeze()` / `isDeepFrozenFabricValue()`. The
  // callbacks below use `deepFreeze` / `isDeepFrozen` only as recursion
  // helpers on the nested (plain) sub-values -- never as the entry point for
  // the instance itself.
  describe(
    "[DEEP_FREEZE] / [IS_DEEP_FROZEN] protocol — direct member invocation",
    () => {
      const subFreeze = (v: FabricValue): FabricValue => deepFreeze(v);
      const subIsDeepFrozen = (v: FabricValue): boolean => isDeepFrozen(v);

      describe("FabricError", () => {
        it("[DEEP_FREEZE] freezes wrapper + recurses cause", () => {
          const inner = FabricError.fromNativeError(new Error("cause"));
          const fe = FabricError.fromNativeError(
            new Error("outer", { cause: inner }),
          );
          const result = fe[DEEP_FREEZE](subFreeze);
          expect(result).toBe(fe); // freeze-in-place identity
          expect(Object.isFrozen(fe)).toBe(true);
          expect(isDeepFrozen(inner)).toBe(true);
        });

        it("[DEEP_FREEZE] recurses enumerable custom props (preserved via extras)", () => {
          const err = new Error("e");
          const childObj = { nested: 1 };
          (err as unknown as Record<string, unknown>).custom = childObj;
          const fe = FabricError.fromNativeError(err);
          fe[DEEP_FREEZE](subFreeze);
          // Non-string custom state is preserved AND deep-frozen.
          expect(fe.getExtra("custom")).toBe(childObj);
          expect(Object.isFrozen(childObj)).toBe(true);
        });

        it("[IS_DEEP_FROZEN] true only when wrapper is frozen", () => {
          const fe = FabricError.fromNativeError(new Error("test"));
          expect(fe[IS_DEEP_FROZEN](subIsDeepFrozen)).toBe(false);
          fe[DEEP_FREEZE](subFreeze);
          expect(fe[IS_DEEP_FROZEN](subIsDeepFrozen)).toBe(true);
        });
      });

      // FabricMap/FabricSet deliberately keep throwing stubs for the protocol
      // methods (per Dan's PR #3612 review: not yet used, reworked separately).
      describe("FabricMap (throwing stub)", () => {
        it("[DEEP_FREEZE] throws not-yet-implemented", () => {
          const fm = new FabricMap(
            new FrozenMap<FabricValue, FabricValue>([["a", 1]]),
          );
          expect(() => fm[DEEP_FREEZE](subFreeze)).toThrow(
            "FabricMap: not yet implemented",
          );
        });

        it("[IS_DEEP_FROZEN] throws not-yet-implemented", () => {
          const fm = new FabricMap(
            new FrozenMap<FabricValue, FabricValue>([["a", 1]]),
          );
          Object.freeze(fm);
          expect(() => fm[IS_DEEP_FROZEN](subIsDeepFrozen)).toThrow(
            "FabricMap: not yet implemented",
          );
        });
      });

      describe("FabricSet (throwing stub)", () => {
        it("[DEEP_FREEZE] throws not-yet-implemented", () => {
          const fs = new FabricSet(new FrozenSet<FabricValue>([1, 2]));
          expect(() => fs[DEEP_FREEZE](subFreeze)).toThrow(
            "FabricSet: not yet implemented",
          );
        });

        it("[IS_DEEP_FROZEN] throws not-yet-implemented", () => {
          const fs = new FabricSet(new FrozenSet<FabricValue>([1, 2]));
          Object.freeze(fs);
          expect(() => fs[IS_DEEP_FROZEN](subIsDeepFrozen)).toThrow(
            "FabricSet: not yet implemented",
          );
        });
      });

      describe("FabricRegExp", () => {
        it("[DEEP_FREEZE] freezes the wrapped RegExp in place", () => {
          const fr = new FabricRegExp(/abc/g);
          expect(Object.isFrozen(fr.regex)).toBe(false);
          const result = fr[DEEP_FREEZE](subFreeze);
          expect(result).toBe(fr);
          expect(Object.isFrozen(fr)).toBe(true);
          expect(Object.isFrozen(fr.regex)).toBe(true);
        });

        it("[IS_DEEP_FROZEN] true only when wrapper + RegExp frozen", () => {
          const fr = new FabricRegExp(/abc/g);
          expect(fr[IS_DEEP_FROZEN](subIsDeepFrozen)).toBe(false);
          fr[DEEP_FREEZE](subFreeze);
          expect(fr[IS_DEEP_FROZEN](subIsDeepFrozen)).toBe(true);
        });
      });

      describe("ExplicitTagValue subclasses", () => {
        it("ProblematicValue [DEEP_FREEZE] recurses state, freezes in place", () => {
          const child = { x: 1 };
          const pv = new ProblematicValue(
            "Bad@1",
            child as unknown as FabricValue,
            "oops",
          );
          const result = pv[DEEP_FREEZE](subFreeze);
          expect(result).toBe(pv);
          expect(Object.isFrozen(pv)).toBe(true);
          expect(Object.isFrozen(child)).toBe(true);
          expect(pv[IS_DEEP_FROZEN](subIsDeepFrozen)).toBe(true);
        });

        it("UnknownValue [DEEP_FREEZE] recurses state, freezes in place", () => {
          const child = { y: 2 };
          const uv = new UnknownValue(
            "Fancy@3",
            child as unknown as FabricValue,
          );
          const result = uv[DEEP_FREEZE](subFreeze);
          expect(result).toBe(uv);
          expect(Object.isFrozen(uv)).toBe(true);
          expect(Object.isFrozen(child)).toBe(true);
          expect(uv[IS_DEEP_FROZEN](subIsDeepFrozen)).toBe(true);
        });
      });
    },
  );

  // --------------------------------------------------------------------------
  // [RECONSTRUCT] honors ReconstructionContext.shouldDeepFreeze
  // --------------------------------------------------------------------------

  describe("[RECONSTRUCT] honors shouldDeepFreeze", () => {
    const frozenCtx = new DummyReconstructionContext(true);
    const mutableCtx = new DummyReconstructionContext(false);

    it("FabricError: shouldDeepFreeze true => deep-frozen, false => mutable", () => {
      const state = {
        type: "Error",
        name: null,
        message: "boom",
      } as unknown as FabricValue;
      const frozen = FabricError[RECONSTRUCT](state, frozenCtx);
      expect(isDeepFrozen(frozen)).toBe(true);
      const mutable = FabricError[RECONSTRUCT](state, mutableCtx);
      expect(Object.isFrozen(mutable)).toBe(false);
    });

    it("FabricRegExp: shouldDeepFreeze true => deep-frozen, false => mutable", () => {
      const state = {
        source: "abc",
        flags: "g",
        flavor: "es2025",
      } as unknown as FabricValue;
      const frozen = FabricRegExp[RECONSTRUCT](state, frozenCtx);
      expect(isDeepFrozen(frozen)).toBe(true);
      expect(Object.isFrozen(frozen.regex)).toBe(true);
      const mutable = FabricRegExp[RECONSTRUCT](state, mutableCtx);
      expect(Object.isFrozen(mutable)).toBe(false);
    });

    it("ProblematicValue: shouldDeepFreeze true => deep-frozen, false => mutable", () => {
      const state = {
        type: "Bad@1",
        state: { x: 1 },
        error: "oops",
      } as unknown as { type: string; state: FabricValue; error: string };
      const frozen = ProblematicValue[RECONSTRUCT](state, frozenCtx);
      expect(isDeepFrozen(frozen)).toBe(true);
      const mutable = ProblematicValue[RECONSTRUCT](state, mutableCtx);
      expect(Object.isFrozen(mutable)).toBe(false);
    });

    it("UnknownValue: shouldDeepFreeze true => deep-frozen, false => mutable", () => {
      const state = { type: "Fancy@3", state: { y: 2 } } as unknown as {
        type: string;
        state: FabricValue;
      };
      const frozen = UnknownValue[RECONSTRUCT](state, frozenCtx);
      expect(isDeepFrozen(frozen)).toBe(true);
      const mutable = UnknownValue[RECONSTRUCT](state, mutableCtx);
      expect(Object.isFrozen(mutable)).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Arm 3 cycle behavior via [DEEP_FREEZE] protocol
  //
  // Cycle-capable wired impls: `FabricError` (recurses through
  // `error.cause` + custom enumerable own properties), `ProblematicValue`
  // (recurses through `state`), `UnknownValue` (recurses through
  // `state`). `FabricRegExp.[DEEP_FREEZE]` ignores its `subFreeze`
  // parameter (only freezes `this.regex` + `this`) and so is structurally
  // cycle-free by construction at the protocol level -- omitted
  // intentionally, not a gap.
  //
  // Termination assertion: a cycle without shared-`inProgress` threading
  // would manifest as `RangeError: Maximum call stack size exceeded` (a
  // clean fast throw, not a hang); `.not.toThrow()` is the discriminating
  // assertion.
  // --------------------------------------------------------------------------

  describe("Arm 3 cycle behavior via [DEEP_FREEZE]", () => {
    it("FabricError: cycle through `error.cause` terminates", () => {
      // Build a cycle: a plain-object wrapper holds the FabricError, and the
      // FabricError's `error.cause` points back at the wrapper. When
      // `deepFreeze(wrapper)` runs Arm 4 it recurses into the FabricError
      // (Arm 3), which subFreezes `error.cause` = wrapper, which re-enters
      // `deepFreeze()` -> the FabricError again -> ...
      const err = new Error("cycle-cause");
      const fe = FabricError.fromNativeError(err);
      const wrapper: Record<string, unknown> = { fe };
      err.cause = wrapper;
      expect(() => deepFreeze(wrapper)).not.toThrow();
      expect(Object.isFrozen(wrapper)).toBe(true);
      expect(Object.isFrozen(fe)).toBe(true);
    });

    it("ProblematicValue: cycle through `state` terminates", () => {
      const cycle: Record<string, unknown> = { x: 1 };
      const pv = new ProblematicValue("Cycle@1", cycle as FabricValue, "oops");
      cycle.back = pv;
      expect(() => deepFreeze(pv)).not.toThrow();
      expect(Object.isFrozen(pv)).toBe(true);
      expect(Object.isFrozen(cycle)).toBe(true);
    });

    it("UnknownValue: cycle through `state` terminates", () => {
      const cycle: Record<string, unknown> = { y: 2 };
      const uv = new UnknownValue("Cycle@1", cycle as FabricValue);
      cycle.back = uv;
      expect(() => deepFreeze(uv)).not.toThrow();
      expect(Object.isFrozen(uv)).toBe(true);
      expect(Object.isFrozen(cycle)).toBe(true);
    });

    it("cross-instance cycle (FabricError <-> ProblematicValue) terminates", () => {
      // Two `FabricInstance` subclasses pointing into each other via their
      // recursing slots. Both must terminate, both must end deep-frozen.
      // FabricError snapshots its FabricValue state at construction, so wire
      // up the native Error's `cause` BEFORE `fromNativeError`.
      const peShared: Record<string, unknown> = { tag: "shared" };
      const pv = new ProblematicValue(
        "Cycle@1",
        peShared as FabricValue,
        "loop",
      );
      const err = new Error("cross-cycle") as Error & { cause: unknown };
      err.cause = pv;
      const fe = FabricError.fromNativeError(err);
      peShared.fe = fe;
      expect(() => deepFreeze(fe)).not.toThrow();
      expect(Object.isFrozen(fe)).toBe(true);
      expect(Object.isFrozen(pv)).toBe(true);
      expect(Object.isFrozen(peShared)).toBe(true);
    });
  });
});
