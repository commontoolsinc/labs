import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { DECONSTRUCT, isStorable, RECONSTRUCT } from "../storable-protocol.ts";
import type { ReconstructionContext } from "../storable-protocol.ts";
import type { StorableValue } from "../interface.ts";
import {
  deepNativeValueFromStorableValue,
  FrozenMap,
  FrozenSet,
  nativeValueFromStorableValue,
  StorableDate,
  StorableError,
  StorableMap,
  StorableNativeWrapper,
  StorableSet,
  StorableUint8Array,
} from "../storable-native-instances.ts";

/** Dummy reconstruction context for tests. */
const dummyContext: ReconstructionContext = {
  getCell(_ref) {
    throw new Error("getCell not implemented in test");
  },
};

// ============================================================================
// Tests
// ============================================================================

describe("storable-native-instances", () => {
  // --------------------------------------------------------------------------
  // StorableError
  // --------------------------------------------------------------------------

  describe("StorableError", () => {
    it("implements StorableInstance (isStorable returns true)", () => {
      const se = new StorableError(new Error("test"));
      expect(isStorable(se)).toBe(true);
    });

    it("has typeTag 'Error@1'", () => {
      const se = new StorableError(new Error("test"));
      expect(se.typeTag).toBe("Error@1");
    });

    it("wraps the original Error", () => {
      const err = new TypeError("bad");
      const se = new StorableError(err);
      expect(se.error).toBe(err);
    });

    it("is instanceof StorableNativeWrapper", () => {
      const se = new StorableError(new Error("test"));
      expect(se instanceof StorableNativeWrapper).toBe(true);
    });

    it("[DECONSTRUCT] returns type, name=null (common case), message, stack", () => {
      const se = new StorableError(new Error("hello"));
      const state = se[DECONSTRUCT]() as Record<string, StorableValue>;
      expect(state.type).toBe("Error");
      expect(state.name).toBe(null);
      expect(state.message).toBe("hello");
      expect(typeof state.stack).toBe("string");
    });

    it("[DECONSTRUCT] name is null when type === name (TypeError)", () => {
      const se = new StorableError(new TypeError("bad"));
      const state = se[DECONSTRUCT]() as Record<string, StorableValue>;
      expect(state.type).toBe("TypeError");
      expect(state.name).toBe(null);
    });

    it("[DECONSTRUCT] name is non-null when type !== name", () => {
      const err = new TypeError("bad");
      err.name = "CustomName";
      const se = new StorableError(err);
      const state = se[DECONSTRUCT]() as Record<string, StorableValue>;
      expect(state.type).toBe("TypeError");
      expect(state.name).toBe("CustomName");
    });

    it("[DECONSTRUCT] includes cause when present", () => {
      const inner = new StorableError(new Error("inner"));
      const outer = new StorableError(
        new Error("outer", { cause: inner }),
      );
      const state = outer[DECONSTRUCT]() as Record<string, StorableValue>;
      expect(state.cause).toBe(inner);
    });

    it("[DECONSTRUCT] includes custom enumerable properties", () => {
      const err = new Error("oops");
      (err as unknown as Record<string, unknown>).code = 42;
      (err as unknown as Record<string, unknown>).detail = "more info";
      const se = new StorableError(err);
      const state = se[DECONSTRUCT]() as Record<string, StorableValue>;
      expect(state.code).toBe(42);
      expect(state.detail).toBe("more info");
    });

    it("[DECONSTRUCT] does not copy __proto__ or constructor keys", () => {
      const err = new Error("test");
      Object.defineProperty(err, "__proto__", {
        value: "bad",
        enumerable: true,
      });
      const se = new StorableError(err);
      const state = se[DECONSTRUCT]() as Record<string, StorableValue>;
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
      const se = new StorableError(err);
      const state = se[DECONSTRUCT]() as Record<string, StorableValue>;
      expect(state.message).toBe("original");
    });

    it("[DECONSTRUCT] omits stack when undefined", () => {
      const err = new Error("no stack");
      err.stack = undefined;
      const se = new StorableError(err);
      const state = se[DECONSTRUCT]() as Record<string, StorableValue>;
      expect("stack" in state).toBe(false);
    });

    it("[RECONSTRUCT] creates StorableError from state (null name = same as type)", () => {
      const state = {
        type: "Error",
        name: null,
        message: "hello",
      } as StorableValue;
      const result = StorableError[RECONSTRUCT](state, dummyContext);
      expect(result).toBeInstanceOf(StorableError);
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
        const state = { type, name: null, message: "test" } as StorableValue;
        const result = StorableError[RECONSTRUCT](state, dummyContext);
        expect(result.error).toBeInstanceOf(cls);
        expect(result.error.name).toBe(type);
      }
    });

    it("[RECONSTRUCT] handles type != name (e.g. TypeError with custom name)", () => {
      const state = {
        type: "TypeError",
        name: "CustomTypeName",
        message: "mismatch",
      } as StorableValue;
      const result = StorableError[RECONSTRUCT](state, dummyContext);
      expect(result.error).toBeInstanceOf(TypeError);
      expect(result.error.name).toBe("CustomTypeName");
    });

    it("[RECONSTRUCT] falls back to name when type is absent (back-compat)", () => {
      const state = {
        name: "TypeError",
        message: "old format",
      } as StorableValue;
      const result = StorableError[RECONSTRUCT](state, dummyContext);
      expect(result.error).toBeInstanceOf(TypeError);
    });

    it("[RECONSTRUCT] handles custom name", () => {
      const state = {
        type: "Error",
        name: "MyCustomError",
        message: "custom",
      } as StorableValue;
      const result = StorableError[RECONSTRUCT](state, dummyContext);
      expect(result.error.name).toBe("MyCustomError");
    });

    it("[RECONSTRUCT] restores cause and custom properties", () => {
      const state = {
        type: "Error",
        name: null,
        message: "with extras",
        cause: "something went wrong",
        code: 404,
      } as StorableValue;
      const result = StorableError[RECONSTRUCT](state, dummyContext);
      expect(result.error.cause).toBe("something went wrong");
      expect(
        (result.error as unknown as Record<string, unknown>).code,
      ).toBe(404);
    });

    it("round-trips through DECONSTRUCT/RECONSTRUCT", () => {
      const original = new Error("round trip");
      original.name = "CustomError";
      (original as unknown as Record<string, unknown>).code = 42;
      const se = new StorableError(original);

      const state = se[DECONSTRUCT]();
      const restored = StorableError[RECONSTRUCT](state, dummyContext);

      expect(restored.error.name).toBe("CustomError");
      expect(restored.error.message).toBe("round trip");
      expect(
        (restored.error as unknown as Record<string, unknown>).code,
      ).toBe(42);
    });

    it("round-trips TypeError with overridden name", () => {
      const original = new TypeError("bad value");
      original.name = "SpecialType";
      const se = new StorableError(original);

      const state = se[DECONSTRUCT]() as Record<string, StorableValue>;
      expect(state.type).toBe("TypeError");
      expect(state.name).toBe("SpecialType");

      const restored = StorableError[RECONSTRUCT](
        state as StorableValue,
        dummyContext,
      );
      expect(restored.error).toBeInstanceOf(TypeError);
      expect(restored.error.name).toBe("SpecialType");
    });

    it("toNativeValue returns the wrapped error", () => {
      const err = new Error("native");
      const se = new StorableError(err);
      expect(se.toNativeValue(true)).toBe(err);
      expect(se.toNativeValue(false)).toBe(err);
    });
  });

  // --------------------------------------------------------------------------
  // Stub wrappers (StorableMap, StorableSet, StorableDate, StorableUint8Array)
  // --------------------------------------------------------------------------

  describe("stub wrappers", () => {
    it("StorableMap implements StorableInstance", () => {
      const sm = new StorableMap(new Map());
      expect(isStorable(sm)).toBe(true);
      expect(sm.typeTag).toBe("Map@1");
    });

    it("StorableMap is instanceof StorableNativeWrapper", () => {
      const sm = new StorableMap(new Map());
      expect(sm instanceof StorableNativeWrapper).toBe(true);
    });

    it("StorableMap [DECONSTRUCT] throws (stub)", () => {
      const sm = new StorableMap(new Map());
      expect(() => sm[DECONSTRUCT]()).toThrow("not yet implemented");
    });

    it("StorableMap [RECONSTRUCT] throws (stub)", () => {
      expect(() => StorableMap[RECONSTRUCT](null, dummyContext)).toThrow(
        "not yet implemented",
      );
    });

    it("StorableMap.toNativeValue(true) returns FrozenMap", () => {
      const map = new Map<StorableValue, StorableValue>([["a", 1]]);
      const sm = new StorableMap(map);
      const result = sm.toNativeValue(true);
      expect(result).toBeInstanceOf(FrozenMap);
      expect((result as FrozenMap<string, number>).get("a")).toBe(1);
    });

    it("StorableMap.toNativeValue(false) returns mutable Map", () => {
      const map = new Map<StorableValue, StorableValue>([["a", 1]]);
      const sm = new StorableMap(map);
      const result = sm.toNativeValue(false);
      expect(result).toBeInstanceOf(Map);
      expect(result).not.toBeInstanceOf(FrozenMap);
      (result as Map<string, number>).set("b", 2);
      expect((result as Map<string, number>).get("b")).toBe(2);
    });

    it("StorableSet implements StorableInstance", () => {
      const ss = new StorableSet(new Set());
      expect(isStorable(ss)).toBe(true);
      expect(ss.typeTag).toBe("Set@1");
    });

    it("StorableSet [DECONSTRUCT] throws (stub)", () => {
      const ss = new StorableSet(new Set());
      expect(() => ss[DECONSTRUCT]()).toThrow("not yet implemented");
    });

    it("StorableSet.toNativeValue(true) returns FrozenSet", () => {
      const set = new Set<StorableValue>([1, 2]);
      const ss = new StorableSet(set);
      const result = ss.toNativeValue(true);
      expect(result).toBeInstanceOf(FrozenSet);
      expect((result as FrozenSet<number>).has(1)).toBe(true);
    });

    it("StorableSet.toNativeValue(false) returns mutable Set", () => {
      const set = new Set<StorableValue>([1, 2]);
      const ss = new StorableSet(set);
      const result = ss.toNativeValue(false);
      expect(result).toBeInstanceOf(Set);
      expect(result).not.toBeInstanceOf(FrozenSet);
      (result as Set<number>).add(3);
      expect((result as Set<number>).has(3)).toBe(true);
    });

    it("StorableDate implements StorableInstance", () => {
      const sd = new StorableDate(new Date());
      expect(isStorable(sd)).toBe(true);
      expect(sd.typeTag).toBe("Date@1");
    });

    it("StorableDate [DECONSTRUCT] throws (stub)", () => {
      const sd = new StorableDate(new Date());
      expect(() => sd[DECONSTRUCT]()).toThrow("not yet implemented");
    });

    it("StorableDate.toNativeValue returns the Date", () => {
      const date = new Date("2024-01-01");
      const sd = new StorableDate(date);
      expect(sd.toNativeValue(true)).toBe(date);
    });

    it("StorableUint8Array implements StorableInstance", () => {
      const su = new StorableUint8Array(new Uint8Array([1, 2, 3]));
      expect(isStorable(su)).toBe(true);
      expect(su.typeTag).toBe("Bytes@1");
    });

    it("StorableUint8Array [DECONSTRUCT] throws (stub)", () => {
      const su = new StorableUint8Array(new Uint8Array());
      expect(() => su[DECONSTRUCT]()).toThrow("not yet implemented");
    });

    it("StorableUint8Array.toNativeValue returns the Uint8Array", () => {
      const bytes = new Uint8Array([1, 2, 3]);
      const su = new StorableUint8Array(bytes);
      expect(su.toNativeValue(true)).toBe(bytes);
    });
  });

  // --------------------------------------------------------------------------
  // FrozenMap
  // --------------------------------------------------------------------------

  describe("FrozenMap", () => {
    it("is instanceof Map", () => {
      const fm = new FrozenMap([["a", 1]]);
      expect(fm instanceof Map).toBe(true);
    });

    it("is Object.isFrozen", () => {
      const fm = new FrozenMap([["a", 1]]);
      expect(Object.isFrozen(fm)).toBe(true);
    });

    it("supports read operations", () => {
      const fm = new FrozenMap<string, number>([["a", 1], ["b", 2]]);
      expect(fm.size).toBe(2);
      expect(fm.get("a")).toBe(1);
      expect(fm.get("b")).toBe(2);
      expect(fm.has("a")).toBe(true);
      expect(fm.has("c")).toBe(false);
    });

    it("throws on set()", () => {
      const fm = new FrozenMap<string, number>([["a", 1]]);
      expect(() => fm.set("b", 2)).toThrow("Cannot mutate a FrozenMap");
    });

    it("throws on delete()", () => {
      const fm = new FrozenMap<string, number>([["a", 1]]);
      expect(() => fm.delete("a")).toThrow("Cannot mutate a FrozenMap");
    });

    it("throws on clear()", () => {
      const fm = new FrozenMap<string, number>([["a", 1]]);
      expect(() => fm.clear()).toThrow("Cannot mutate a FrozenMap");
    });

    it("supports forEach iteration", () => {
      const fm = new FrozenMap([["x", 10], ["y", 20]]);
      const entries: [string, number][] = [];
      fm.forEach((v, k) => entries.push([k, v]));
      expect(entries).toEqual([["x", 10], ["y", 20]]);
    });

    it("supports empty construction", () => {
      const fm = new FrozenMap();
      expect(fm.size).toBe(0);
    });

    it("supports null entries argument", () => {
      const fm = new FrozenMap(null);
      expect(fm.size).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // FrozenSet
  // --------------------------------------------------------------------------

  describe("FrozenSet", () => {
    it("is instanceof Set", () => {
      const fs = new FrozenSet([1, 2, 3]);
      expect(fs instanceof Set).toBe(true);
    });

    it("is Object.isFrozen", () => {
      const fs = new FrozenSet([1, 2, 3]);
      expect(Object.isFrozen(fs)).toBe(true);
    });

    it("supports read operations", () => {
      const fs = new FrozenSet<number>([1, 2, 3]);
      expect(fs.size).toBe(3);
      expect(fs.has(1)).toBe(true);
      expect(fs.has(4)).toBe(false);
    });

    it("throws on add()", () => {
      const fs = new FrozenSet<number>([1]);
      expect(() => fs.add(2)).toThrow("Cannot mutate a FrozenSet");
    });

    it("throws on delete()", () => {
      const fs = new FrozenSet<number>([1]);
      expect(() => fs.delete(1)).toThrow("Cannot mutate a FrozenSet");
    });

    it("throws on clear()", () => {
      const fs = new FrozenSet<number>([1]);
      expect(() => fs.clear()).toThrow("Cannot mutate a FrozenSet");
    });

    it("supports forEach iteration", () => {
      const fs = new FrozenSet([10, 20, 30]);
      const values: number[] = [];
      fs.forEach((v) => values.push(v));
      expect(values).toEqual([10, 20, 30]);
    });

    it("supports empty construction", () => {
      const fs = new FrozenSet();
      expect(fs.size).toBe(0);
    });

    it("supports null values argument", () => {
      const fs = new FrozenSet(null);
      expect(fs.size).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // nativeValueFromStorableValue (shallow unwrap)
  // --------------------------------------------------------------------------

  describe("nativeValueFromStorableValue", () => {
    it("unwraps StorableError to Error", () => {
      const err = new TypeError("test");
      const se = new StorableError(err);
      const result = nativeValueFromStorableValue(se as StorableValue);
      expect(result).toBe(err);
    });

    it("unwraps StorableMap to FrozenMap (default frozen)", () => {
      const map = new Map<StorableValue, StorableValue>([["a", 1]]);
      const sm = new StorableMap(map);
      const result = nativeValueFromStorableValue(sm as StorableValue);
      expect(result).toBeInstanceOf(FrozenMap);
      expect((result as FrozenMap<string, number>).get("a")).toBe(1);
    });

    it("unwraps StorableMap to mutable Map when frozen=false", () => {
      const map = new Map<StorableValue, StorableValue>([["a", 1]]);
      const sm = new StorableMap(map);
      const result = nativeValueFromStorableValue(sm as StorableValue, false);
      expect(result).toBeInstanceOf(Map);
      expect(result).not.toBeInstanceOf(FrozenMap);
    });

    it("unwraps StorableSet to FrozenSet (default frozen)", () => {
      const set = new Set<StorableValue>([1, 2, 3]);
      const ss = new StorableSet(set);
      const result = nativeValueFromStorableValue(ss as StorableValue);
      expect(result).toBeInstanceOf(FrozenSet);
      expect((result as FrozenSet<number>).has(1)).toBe(true);
    });

    it("unwraps StorableSet to mutable Set when frozen=false", () => {
      const set = new Set<StorableValue>([1, 2, 3]);
      const ss = new StorableSet(set);
      const result = nativeValueFromStorableValue(ss as StorableValue, false);
      expect(result).toBeInstanceOf(Set);
      expect(result).not.toBeInstanceOf(FrozenSet);
    });

    it("unwraps StorableDate to Date", () => {
      const date = new Date("2024-01-01");
      const sd = new StorableDate(date);
      const result = nativeValueFromStorableValue(sd as StorableValue);
      expect(result).toBe(date);
    });

    it("unwraps StorableUint8Array to Uint8Array", () => {
      const bytes = new Uint8Array([1, 2, 3]);
      const su = new StorableUint8Array(bytes);
      const result = nativeValueFromStorableValue(su as StorableValue);
      expect(result).toBe(bytes);
    });

    it("passes through primitives", () => {
      expect(nativeValueFromStorableValue(42)).toBe(42);
      expect(nativeValueFromStorableValue("hello")).toBe("hello");
      expect(nativeValueFromStorableValue(null)).toBe(null);
      expect(nativeValueFromStorableValue(true)).toBe(true);
    });

    it("passes through plain objects", () => {
      const obj = { a: 1 } as StorableValue;
      expect(nativeValueFromStorableValue(obj)).toBe(obj);
    });

    it("passes through arrays", () => {
      const arr = [1, 2] as StorableValue;
      expect(nativeValueFromStorableValue(arr)).toBe(arr);
    });
  });

  // --------------------------------------------------------------------------
  // deepNativeValueFromStorableValue (deep unwrap)
  // --------------------------------------------------------------------------

  describe("deepNativeValueFromStorableValue", () => {
    it("unwraps StorableError in nested object", () => {
      const se = new StorableError(new Error("deep"));
      const obj = { error: se } as StorableValue;
      const result = deepNativeValueFromStorableValue(obj) as Record<
        string,
        unknown
      >;
      expect(result.error).toBeInstanceOf(Error);
      expect((result.error as Error).message).toBe("deep");
    });

    it("unwraps StorableMap in nested array", () => {
      const sm = new StorableMap(
        new Map<StorableValue, StorableValue>([["k", "v"]]),
      );
      const arr = [sm] as StorableValue;
      const result = deepNativeValueFromStorableValue(arr) as unknown[];
      expect(result[0]).toBeInstanceOf(FrozenMap);
    });

    it("unwraps StorableMap to mutable Map when frozen=false", () => {
      const sm = new StorableMap(
        new Map<StorableValue, StorableValue>([["k", "v"]]),
      );
      const arr = [sm] as StorableValue;
      const result = deepNativeValueFromStorableValue(arr, false) as unknown[];
      expect(result[0]).toBeInstanceOf(Map);
      expect(result[0]).not.toBeInstanceOf(FrozenMap);
    });

    it("passes through primitives at all levels", () => {
      const obj = { a: 1, b: "two", c: null, d: true } as StorableValue;
      const result = deepNativeValueFromStorableValue(obj) as Record<
        string,
        unknown
      >;
      expect(result).toEqual({ a: 1, b: "two", c: null, d: true });
    });

    it("recursively unwraps nested structures", () => {
      const se = new StorableError(new Error("nested"));
      const obj = {
        outer: {
          inner: se,
        },
      } as StorableValue;
      const result = deepNativeValueFromStorableValue(obj) as {
        outer: { inner: Error };
      };
      expect(result.outer.inner).toBeInstanceOf(Error);
      expect(result.outer.inner.message).toBe("nested");
    });
  });
});
