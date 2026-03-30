import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  DECONSTRUCT,
  FabricInstance,
  type FabricValue,
  RECONSTRUCT,
  type ReconstructionContext,
} from "../interface.ts";
import {
  FabricError,
  FabricMap,
  FabricNativeWrapper,
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

/** Dummy reconstruction context for tests. */
const dummyContext: ReconstructionContext = {
  getCell(_ref) {
    throw new Error("getCell not implemented in test");
  },
};

// ============================================================================
// Tests
// ============================================================================

describe("fabric-native-instances", () => {
  // --------------------------------------------------------------------------
  // FabricError
  // --------------------------------------------------------------------------

  describe("FabricError", () => {
    it("implements FabricInstance (instanceof returns true)", () => {
      const se = new FabricError(new Error("test"));
      expect(se instanceof FabricInstance).toBe(true);
    });

    it("has typeTag 'Error@1'", () => {
      const se = new FabricError(new Error("test"));
      expect(se.typeTag).toBe("Error@1");
    });

    it("wraps the original Error", () => {
      const err = new TypeError("bad");
      const se = new FabricError(err);
      expect(se.error).toBe(err);
    });

    it("is instanceof FabricNativeWrapper", () => {
      const se = new FabricError(new Error("test"));
      expect(se instanceof FabricNativeWrapper).toBe(true);
    });

    it("[DECONSTRUCT] returns type, name=null (common case), message, stack", () => {
      const se = new FabricError(new Error("hello"));
      const state = se[DECONSTRUCT]() as Record<string, FabricValue>;
      expect(state.type).toBe("Error");
      expect(state.name).toBe(null);
      expect(state.message).toBe("hello");
      expect(typeof state.stack).toBe("string");
    });

    it("[DECONSTRUCT] name is null when type === name (TypeError)", () => {
      const se = new FabricError(new TypeError("bad"));
      const state = se[DECONSTRUCT]() as Record<string, FabricValue>;
      expect(state.type).toBe("TypeError");
      expect(state.name).toBe(null);
    });

    it("[DECONSTRUCT] name is non-null when type !== name", () => {
      const err = new TypeError("bad");
      err.name = "CustomName";
      const se = new FabricError(err);
      const state = se[DECONSTRUCT]() as Record<string, FabricValue>;
      expect(state.type).toBe("TypeError");
      expect(state.name).toBe("CustomName");
    });

    it("[DECONSTRUCT] includes cause when present", () => {
      const inner = new FabricError(new Error("inner"));
      const outer = new FabricError(
        new Error("outer", { cause: inner }),
      );
      const state = outer[DECONSTRUCT]() as Record<string, FabricValue>;
      expect(state.cause).toBe(inner);
    });

    it("[DECONSTRUCT] includes custom enumerable properties", () => {
      const err = new Error("oops");
      (err as unknown as Record<string, unknown>).code = 42;
      (err as unknown as Record<string, unknown>).detail = "more info";
      const se = new FabricError(err);
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
      const se = new FabricError(err);
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
      const se = new FabricError(err);
      const state = se[DECONSTRUCT]() as Record<string, FabricValue>;
      expect(state.message).toBe("original");
    });

    it("[DECONSTRUCT] omits stack when undefined", () => {
      const err = new Error("no stack");
      err.stack = undefined;
      const se = new FabricError(err);
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
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.name).toBe("Error");
      expect(result.error.message).toBe("hello");
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
        expect(result.error).toBeInstanceOf(cls);
        expect(result.error.name).toBe(type);
      }
    });

    it("[RECONSTRUCT] handles type != name (e.g. TypeError with custom name)", () => {
      const state = {
        type: "TypeError",
        name: "CustomTypeName",
        message: "mismatch",
      } as FabricValue;
      const result = FabricError[RECONSTRUCT](state, dummyContext);
      expect(result.error).toBeInstanceOf(TypeError);
      expect(result.error.name).toBe("CustomTypeName");
    });

    it("[RECONSTRUCT] falls back to name when type is absent (back-compat)", () => {
      const state = {
        name: "TypeError",
        message: "old format",
      } as FabricValue;
      const result = FabricError[RECONSTRUCT](state, dummyContext);
      expect(result.error).toBeInstanceOf(TypeError);
    });

    it("[RECONSTRUCT] handles custom name", () => {
      const state = {
        type: "Error",
        name: "MyCustomError",
        message: "custom",
      } as FabricValue;
      const result = FabricError[RECONSTRUCT](state, dummyContext);
      expect(result.error.name).toBe("MyCustomError");
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
      expect(result.error.cause).toBe("something went wrong");
      expect(
        (result.error as unknown as Record<string, unknown>).code,
      ).toBe(404);
    });

    it("round-trips through DECONSTRUCT/RECONSTRUCT", () => {
      const original = new Error("round trip");
      original.name = "CustomError";
      (original as unknown as Record<string, unknown>).code = 42;
      const se = new FabricError(original);

      const state = se[DECONSTRUCT]();
      const restored = FabricError[RECONSTRUCT](state, dummyContext);

      expect(restored.error.name).toBe("CustomError");
      expect(restored.error.message).toBe("round trip");
      expect(
        (restored.error as unknown as Record<string, unknown>).code,
      ).toBe(42);
    });

    it("round-trips TypeError with overridden name", () => {
      const original = new TypeError("bad value");
      original.name = "SpecialType";
      const se = new FabricError(original);

      const state = se[DECONSTRUCT]() as Record<string, FabricValue>;
      expect(state.type).toBe("TypeError");
      expect(state.name).toBe("SpecialType");

      const restored = FabricError[RECONSTRUCT](
        state as FabricValue,
        dummyContext,
      );
      expect(restored.error).toBeInstanceOf(TypeError);
      expect(restored.error.name).toBe("SpecialType");
    });

    it("toNativeValue(true) returns frozen error (copy of unfrozen)", () => {
      const err = new Error("native");
      const se = new FabricError(err);
      const result = se.toNativeValue(true);
      // Creates a frozen copy since the input is unfrozen.
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toBe("native");
      expect(Object.isFrozen(result)).toBe(true);
      // Original should NOT be mutated.
      expect(Object.isFrozen(err)).toBe(false);
    });

    it("toNativeValue(true) returns same error if already frozen", () => {
      const err = new Error("native");
      Object.freeze(err);
      const se = new FabricError(err);
      const result = se.toNativeValue(true);
      expect(result).toBe(err); // same reference
      expect(Object.isFrozen(result)).toBe(true);
    });

    it("toNativeValue(false) returns unfrozen error", () => {
      const err = new Error("native");
      const se = new FabricError(err);
      const result = se.toNativeValue(false);
      expect(result).toBe(err); // same reference (already unfrozen)
      expect(Object.isFrozen(result)).toBe(false);
    });

    it("toNativeValue(false) returns unfrozen copy of frozen error", () => {
      const err = new Error("native");
      Object.freeze(err);
      const se = new FabricError(err);
      const result = se.toNativeValue(false);
      // Creates an unfrozen copy since the input is frozen.
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toBe("native");
      expect(Object.isFrozen(result)).toBe(false);
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
      const se = new FabricError(new Error("deep"));
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
      const se = new FabricError(new Error("nested"));
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
    // toRichStorableValueBase, not via tagFromNativeValue.
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
});
