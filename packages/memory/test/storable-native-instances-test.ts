import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  DECONSTRUCT,
  isStorableInstance,
  RECONSTRUCT,
} from "../storable-protocol.ts";
import type { ReconstructionContext } from "../storable-protocol.ts";
import type { StorableValue } from "../interface.ts";
import {
  deepNativeValueFromStorableValue,
  nativeValueFromStorableValue,
  StorableDate,
  StorableError,
  StorableMap,
  StorableNativeWrapper,
  StorableSet,
  StorableUint8Array,
} from "../storable-native-instances.ts";
import { FrozenDate, FrozenMap, FrozenSet } from "../frozen-builtins.ts";

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
    it("implements StorableInstance (isStorableInstance returns true)", () => {
      const se = new StorableError(new Error("test"));
      expect(isStorableInstance(se)).toBe(true);
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

    it("toNativeValue(true) returns frozen error (copy of unfrozen)", () => {
      const err = new Error("native");
      const se = new StorableError(err);
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
      const se = new StorableError(err);
      const result = se.toNativeValue(true);
      expect(result).toBe(err); // same reference
      expect(Object.isFrozen(result)).toBe(true);
    });

    it("toNativeValue(false) returns unfrozen error", () => {
      const err = new Error("native");
      const se = new StorableError(err);
      const result = se.toNativeValue(false);
      expect(result).toBe(err); // same reference (already unfrozen)
      expect(Object.isFrozen(result)).toBe(false);
    });

    it("toNativeValue(false) returns unfrozen copy of frozen error", () => {
      const err = new Error("native");
      Object.freeze(err);
      const se = new StorableError(err);
      const result = se.toNativeValue(false);
      // Creates an unfrozen copy since the input is frozen.
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toBe("native");
      expect(Object.isFrozen(result)).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Stub wrappers (StorableMap, StorableSet, StorableDate, StorableUint8Array)
  // --------------------------------------------------------------------------

  describe("stub wrappers", () => {
    it("StorableMap implements StorableInstance", () => {
      const sm = new StorableMap(new Map());
      expect(isStorableInstance(sm)).toBe(true);
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

    it("StorableMap.toNativeValue(false) returns the original Map", () => {
      const map = new Map<StorableValue, StorableValue>([["a", 1]]);
      const sm = new StorableMap(map);
      const result = sm.toNativeValue(false);
      expect(result).toBe(map); // same reference
      expect(result).toBeInstanceOf(Map);
      expect(result).not.toBeInstanceOf(FrozenMap);
    });

    it("StorableMap.toNativeValue(true) returns same FrozenMap if already frozen", () => {
      const fm = new FrozenMap<StorableValue, StorableValue>([["a", 1]]);
      const sm = new StorableMap(fm);
      const result = sm.toNativeValue(true);
      expect(result).toBe(fm); // same reference
    });

    it("StorableMap.toNativeValue(false) copies a FrozenMap to mutable Map", () => {
      const fm = new FrozenMap<StorableValue, StorableValue>([["a", 1]]);
      const sm = new StorableMap(fm);
      const result = sm.toNativeValue(false);
      expect(result).not.toBe(fm);
      expect(result).toBeInstanceOf(Map);
      expect(result).not.toBeInstanceOf(FrozenMap);
      expect(result.get("a" as StorableValue)).toBe(1);
    });

    it("StorableSet implements StorableInstance", () => {
      const ss = new StorableSet(new Set());
      expect(isStorableInstance(ss)).toBe(true);
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

    it("StorableSet.toNativeValue(false) returns the original Set", () => {
      const set = new Set<StorableValue>([1, 2]);
      const ss = new StorableSet(set);
      const result = ss.toNativeValue(false);
      expect(result).toBe(set); // same reference
      expect(result).toBeInstanceOf(Set);
      expect(result).not.toBeInstanceOf(FrozenSet);
    });

    it("StorableSet.toNativeValue(true) returns same FrozenSet if already frozen", () => {
      const fs = new FrozenSet<StorableValue>([1, 2]);
      const ss = new StorableSet(fs);
      const result = ss.toNativeValue(true);
      expect(result).toBe(fs); // same reference
    });

    it("StorableSet.toNativeValue(false) copies a FrozenSet to mutable Set", () => {
      const fs = new FrozenSet<StorableValue>([1, 2]);
      const ss = new StorableSet(fs);
      const result = ss.toNativeValue(false);
      expect(result).not.toBe(fs);
      expect(result).toBeInstanceOf(Set);
      expect(result).not.toBeInstanceOf(FrozenSet);
      expect(result.has(1 as StorableValue)).toBe(true);
    });

    it("StorableDate implements StorableInstance", () => {
      const sd = new StorableDate(new Date());
      expect(isStorableInstance(sd)).toBe(true);
      expect(sd.typeTag).toBe("Date@1");
    });

    it("StorableDate [DECONSTRUCT] throws (stub)", () => {
      const sd = new StorableDate(new Date());
      expect(() => sd[DECONSTRUCT]()).toThrow("not yet implemented");
    });

    it("StorableDate.toNativeValue(true) returns FrozenDate", () => {
      const date = new Date("2024-01-01");
      const sd = new StorableDate(date);
      const result = sd.toNativeValue(true);
      expect(result).toBeInstanceOf(FrozenDate);
      expect(result).toBeInstanceOf(Date);
      expect(result.getTime()).toBe(date.getTime());
    });

    it("StorableDate.toNativeValue(false) returns the original Date", () => {
      const date = new Date("2024-01-01");
      const sd = new StorableDate(date);
      const result = sd.toNativeValue(false);
      expect(result).toBe(date); // same reference
      expect(result).not.toBeInstanceOf(FrozenDate);
    });

    it("StorableDate.toNativeValue(true) returns same FrozenDate if already frozen", () => {
      const fd = new FrozenDate("2024-01-01");
      const sd = new StorableDate(fd);
      const result = sd.toNativeValue(true);
      expect(result).toBe(fd); // same reference
    });

    it("StorableDate.toNativeValue(false) copies a FrozenDate to mutable Date", () => {
      const fd = new FrozenDate("2024-01-01");
      const sd = new StorableDate(fd);
      const result = sd.toNativeValue(false);
      expect(result).not.toBe(fd);
      expect(result).toBeInstanceOf(Date);
      expect(result).not.toBeInstanceOf(FrozenDate);
      expect(result.getTime()).toBe(fd.getTime());
    });

    it("StorableUint8Array implements StorableInstance", () => {
      const su = new StorableUint8Array(new Uint8Array([1, 2, 3]));
      expect(isStorableInstance(su)).toBe(true);
      expect(su.typeTag).toBe("Bytes@1");
    });

    it("StorableUint8Array [DECONSTRUCT] throws (stub)", () => {
      const su = new StorableUint8Array(new Uint8Array());
      expect(() => su[DECONSTRUCT]()).toThrow("not yet implemented");
    });

    it("StorableUint8Array.toNativeValue(true) returns Blob", () => {
      const bytes = new Uint8Array([1, 2, 3]);
      const su = new StorableUint8Array(bytes);
      const result = su.toNativeValue(true);
      expect(result).toBeInstanceOf(Blob);
      expect((result as Blob).size).toBe(3);
      expect((result as Blob).type).toBe("");
    });

    it("StorableUint8Array.toNativeValue(true) Blob contains correct data", async () => {
      const bytes = new Uint8Array([10, 20, 30]);
      const su = new StorableUint8Array(bytes);
      const blob = su.toNativeValue(true) as Blob;
      const buf = await blob.arrayBuffer();
      expect(new Uint8Array(buf)).toEqual(new Uint8Array([10, 20, 30]));
    });

    it("StorableUint8Array.toNativeValue(false) returns the original", () => {
      const bytes = new Uint8Array([1, 2, 3]);
      const su = new StorableUint8Array(bytes);
      const result = su.toNativeValue(false);
      expect(result).toBe(bytes); // same reference
      expect(result).toBeInstanceOf(Uint8Array);
    });
  });

  // --------------------------------------------------------------------------
  // nativeValueFromStorableValue (shallow unwrap)
  // --------------------------------------------------------------------------

  describe("nativeValueFromStorableValue", () => {
    it("unwraps StorableError to frozen Error (default)", () => {
      const err = new TypeError("test");
      const se = new StorableError(err);
      const result = nativeValueFromStorableValue(se as StorableValue);
      // Creates a frozen copy since the input error is unfrozen.
      expect(result).toBeInstanceOf(TypeError);
      expect((result as Error).message).toBe("test");
      expect(Object.isFrozen(result)).toBe(true);
    });

    it("unwraps StorableMap to FrozenMap (default frozen)", () => {
      const map = new Map<StorableValue, StorableValue>([["a", 1]]);
      const sm = new StorableMap(map);
      const result = nativeValueFromStorableValue(sm as StorableValue);
      expect(result).toBeInstanceOf(FrozenMap);
      expect((result as FrozenMap<string, number>).get("a")).toBe(1);
    });

    it("unwraps StorableMap to original Map when frozen=false", () => {
      const map = new Map<StorableValue, StorableValue>([["a", 1]]);
      const sm = new StorableMap(map);
      const result = nativeValueFromStorableValue(sm as StorableValue, false);
      expect(result).toBe(map); // same reference
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

    it("unwraps StorableSet to original Set when frozen=false", () => {
      const set = new Set<StorableValue>([1, 2, 3]);
      const ss = new StorableSet(set);
      const result = nativeValueFromStorableValue(ss as StorableValue, false);
      expect(result).toBe(set); // same reference
      expect(result).toBeInstanceOf(Set);
      expect(result).not.toBeInstanceOf(FrozenSet);
    });

    it("unwraps StorableDate to FrozenDate (default)", () => {
      const date = new Date("2024-01-01");
      const sd = new StorableDate(date);
      const result = nativeValueFromStorableValue(sd as StorableValue);
      expect(result).toBeInstanceOf(FrozenDate);
      expect((result as Date).getTime()).toBe(date.getTime());
    });

    it("unwraps StorableUint8Array to Blob (default frozen)", () => {
      const bytes = new Uint8Array([1, 2, 3]);
      const su = new StorableUint8Array(bytes);
      const result = nativeValueFromStorableValue(su as StorableValue);
      expect(result).toBeInstanceOf(Blob);
      expect((result as Blob).size).toBe(3);
    });

    it("unwraps StorableUint8Array to original Uint8Array when frozen=false", () => {
      const bytes = new Uint8Array([1, 2, 3]);
      const su = new StorableUint8Array(bytes);
      const result = nativeValueFromStorableValue(su as StorableValue, false);
      expect(result).toBe(bytes); // same reference
    });

    it("passes through primitives", () => {
      expect(nativeValueFromStorableValue(42)).toBe(42);
      expect(nativeValueFromStorableValue("hello")).toBe("hello");
      expect(nativeValueFromStorableValue(null)).toBe(null);
      expect(nativeValueFromStorableValue(true)).toBe(true);
    });

    it("returns frozen copy of unfrozen plain objects (frozen=true)", () => {
      const obj = { a: 1 } as StorableValue;
      const result = nativeValueFromStorableValue(obj);
      expect(Object.isFrozen(result)).toBe(true);
      expect((result as Record<string, unknown>).a).toBe(1);
    });

    it("passes through frozen plain objects (frozen=true)", () => {
      const obj = Object.freeze({ a: 1 }) as StorableValue;
      expect(nativeValueFromStorableValue(obj)).toBe(obj);
    });

    it("passes through unfrozen plain objects (frozen=false)", () => {
      const obj = { a: 1 } as StorableValue;
      expect(nativeValueFromStorableValue(obj, false)).toBe(obj);
    });

    it("returns frozen copy of unfrozen arrays (frozen=true)", () => {
      const arr = [1, 2] as StorableValue;
      const result = nativeValueFromStorableValue(arr);
      expect(Object.isFrozen(result)).toBe(true);
      expect(result).toEqual([1, 2]);
    });

    it("passes through frozen arrays (frozen=true)", () => {
      const arr = Object.freeze([1, 2]) as StorableValue;
      expect(nativeValueFromStorableValue(arr)).toBe(arr);
    });

    it("passes through unfrozen arrays (frozen=false)", () => {
      const arr = [1, 2] as StorableValue;
      expect(nativeValueFromStorableValue(arr, false)).toBe(arr);
    });

    it("freezing a sparse array preserves holes", () => {
      // Create a sparse array: [1, <hole>, 3]
      const sparse = new Array(3) as StorableValue[];
      sparse[0] = 1 as StorableValue;
      sparse[2] = 3 as StorableValue;
      const result = nativeValueFromStorableValue(
        sparse as StorableValue,
      ) as unknown[];
      expect(Object.isFrozen(result)).toBe(true);
      expect(result.length).toBe(3);
      expect(result[0]).toBe(1);
      expect(result[2]).toBe(3);
      // Verify index 1 is a true hole, not undefined.
      expect(!(1 in result)).toBe(true);
    });

    it("unfreezing a sparse array preserves holes", () => {
      // Create a frozen sparse array: [1, <hole>, 3]
      const sparse = new Array(3) as StorableValue[];
      sparse[0] = 1 as StorableValue;
      sparse[2] = 3 as StorableValue;
      Object.freeze(sparse);
      const result = nativeValueFromStorableValue(
        sparse as StorableValue,
        false,
      ) as unknown[];
      expect(Object.isFrozen(result)).toBe(false);
      expect(result.length).toBe(3);
      expect(result[0]).toBe(1);
      expect(result[2]).toBe(3);
      // Verify index 1 is a true hole, not undefined.
      expect(!(1 in result)).toBe(true);
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
