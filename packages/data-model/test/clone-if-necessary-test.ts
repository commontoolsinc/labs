import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  cloneIfNecessary,
  resetDataModelConfig,
  setDataModelConfig,
} from "../fabric-value.ts";
import type { FabricValue } from "../fabric-value.ts";
import { FabricEpochNsec } from "../fabric-epoch.ts";
import { FabricError } from "../fabric-native-instances.ts";

// ============================================================================
// Tests
// ============================================================================

describe("cloneIfNecessary", () => {
  // Always reset after each test to avoid leaking flag state.
  afterEach(() => {
    resetDataModelConfig();
  });

  // --------------------------------------------------------------------------
  // Error cases (both legacy and rich -- validation runs before flag dispatch)
  // --------------------------------------------------------------------------

  for (const richMode of [false, true]) {
    const label = richMode ? "rich" : "legacy";
    describe(`error cases (${label} path)`, () => {
      if (richMode) {
        beforeEach(() => setDataModelConfig({ modernDataModel: true }));
      }

      it("throws for frozen=true, force=true", () => {
        const value = { a: 1 } as FabricValue;
        expect(() => cloneIfNecessary(value, { frozen: true, force: true }))
          .toThrow("frozen: true, force: true");
      });

      it("throws for frozen=false, force=false, deep=true", () => {
        const value = { a: 1 } as FabricValue;
        expect(() => cloneIfNecessary(value, { frozen: false, force: false }))
          .toThrow("frozen: false, force: false, deep: true");
      });
    });
  }

  // --------------------------------------------------------------------------
  // Default state (flag OFF / legacy) -- identity passthrough
  // --------------------------------------------------------------------------

  describe("legacy path (flag OFF)", () => {
    it("returns the same object (identity passthrough)", () => {
      const value = { a: 1, b: [2, 3] } as FabricValue;
      expect(cloneIfNecessary(value)).toBe(value);
    });

    it("returns the same array (identity passthrough)", () => {
      const value = [1, 2, 3] as FabricValue;
      expect(cloneIfNecessary(value)).toBe(value);
    });

    it("passes through primitives", () => {
      expect(cloneIfNecessary(42 as FabricValue)).toBe(42);
      expect(cloneIfNecessary("hello" as FabricValue)).toBe("hello");
      expect(cloneIfNecessary(null)).toBe(null);
      expect(cloneIfNecessary(true as FabricValue)).toBe(true);
      expect(cloneIfNecessary(undefined)).toBe(undefined);
    });

    it("returns identity for frozen=true (default)", () => {
      const value = { a: 1 } as FabricValue;
      expect(cloneIfNecessary(value, { frozen: true })).toBe(value);
    });

    it("returns identity for deep=false with frozen=true (default)", () => {
      const value = { a: 1 } as FabricValue;
      expect(cloneIfNecessary(value, { deep: false })).toBe(value);
    });

    it("clones when frozen=false (mutable copy via structuredClone)", () => {
      const value = { a: 1 } as FabricValue;
      const result = cloneIfNecessary(value, { frozen: false });
      expect(result).not.toBe(value);
      expect(result).toEqual({ a: 1 });
      expect(Object.isFrozen(result)).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Legacy path: deep mutable clone (frozen=false, deep=true, force=true)
  // --------------------------------------------------------------------------

  describe("legacy path: deep mutable clone (frozen=false)", () => {
    it("deep-clones a nested object", () => {
      const inner = { x: 1 };
      const value = { a: inner, b: [2, 3] } as FabricValue;
      const result = cloneIfNecessary(value, { frozen: false }) as Record<
        string,
        unknown
      >;
      expect(result).not.toBe(value);
      expect(result).toEqual({ a: { x: 1 }, b: [2, 3] });
      // Inner objects are also cloned (deep).
      expect(result.a).not.toBe(inner);
      expect(result.b).not.toBe((value as Record<string, unknown>).b);
    });

    it("deep-clones an array of objects", () => {
      const obj1 = { x: 1 };
      const obj2 = { y: 2 };
      const value = [obj1, obj2] as FabricValue;
      const result = cloneIfNecessary(value, { frozen: false }) as unknown[];
      expect(result).not.toBe(value);
      expect(result).toEqual([{ x: 1 }, { y: 2 }]);
      expect(result[0]).not.toBe(obj1);
      expect(result[1]).not.toBe(obj2);
    });

    it("deep-clones a frozen object into a mutable copy", () => {
      const value = Object.freeze({
        a: Object.freeze({ b: 1 }),
      }) as FabricValue;
      const result = cloneIfNecessary(value, { frozen: false }) as Record<
        string,
        unknown
      >;
      expect(result).not.toBe(value);
      expect(result).toEqual({ a: { b: 1 } });
      expect(Object.isFrozen(result)).toBe(false);
    });

    it("primitives pass through unchanged", () => {
      expect(cloneIfNecessary(42 as FabricValue, { frozen: false })).toBe(42);
      expect(cloneIfNecessary("hi" as FabricValue, { frozen: false })).toBe(
        "hi",
      );
      expect(cloneIfNecessary(null, { frozen: false })).toBe(null);
      expect(cloneIfNecessary(true as FabricValue, { frozen: false })).toBe(
        true,
      );
    });

    it("preserves null values in objects", () => {
      const value = { a: null, b: 1 } as FabricValue;
      const result = cloneIfNecessary(value, { frozen: false }) as Record<
        string,
        unknown
      >;
      expect(result).not.toBe(value);
      expect(result.a).toBe(null);
      expect(result.b).toBe(1);
    });

    it("clones deeply nested structures", () => {
      const value = { a: { b: { c: { d: 42 } } } } as FabricValue;
      const result = cloneIfNecessary(value, { frozen: false }) as Record<
        string,
        unknown
      >;
      expect(result).not.toBe(value);
      expect(result).toEqual({ a: { b: { c: { d: 42 } } } });
      const innerA = result.a as Record<string, unknown>;
      const origA = (value as Record<string, unknown>).a as Record<
        string,
        unknown
      >;
      expect(innerA).not.toBe(origA);
    });

    it("handles empty object", () => {
      const value = {} as FabricValue;
      const result = cloneIfNecessary(value, { frozen: false });
      expect(result).not.toBe(value);
      expect(result).toEqual({});
    });

    it("handles empty array", () => {
      const value = [] as unknown as FabricValue;
      const result = cloneIfNecessary(value, { frozen: false });
      expect(result).not.toBe(value);
      expect(result).toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  // Legacy path: shallow mutable clone (frozen=false, deep=false)
  // --------------------------------------------------------------------------

  describe("legacy path: shallow mutable clone (frozen=false, deep=false)", () => {
    it("shallow-clones an object, preserving inner references", () => {
      const inner = { x: 1 };
      const value = { a: inner, b: 2 } as FabricValue;
      const result = cloneIfNecessary(value, {
        frozen: false,
        deep: false,
      }) as Record<string, unknown>;
      expect(result).not.toBe(value);
      expect(result).toEqual({ a: { x: 1 }, b: 2 });
      // Shallow: inner is same reference.
      expect(result.a).toBe(inner);
    });

    it("shallow-clones an array, preserving inner references", () => {
      const inner = { x: 1 };
      const value = [inner, 2, 3] as FabricValue;
      const result = cloneIfNecessary(value, {
        frozen: false,
        deep: false,
      }) as unknown[];
      expect(result).not.toBe(value);
      expect(result).toEqual([{ x: 1 }, 2, 3]);
      // Shallow: inner is same reference.
      expect(result[0]).toBe(inner);
    });

    it("shallow-clones a frozen object into a mutable copy", () => {
      const frozenInner = Object.freeze({ x: 1 });
      const value = Object.freeze({ a: frozenInner }) as FabricValue;
      const result = cloneIfNecessary(value, {
        frozen: false,
        deep: false,
      }) as Record<string, unknown>;
      expect(result).not.toBe(value);
      expect(Object.isFrozen(result)).toBe(false);
      // Shallow: inner stays frozen (same reference).
      expect(result.a).toBe(frozenInner);
      expect(Object.isFrozen(result.a)).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Legacy path: frozen=true (identity passthrough)
  // --------------------------------------------------------------------------

  describe("legacy path: frozen=true options (identity passthrough)", () => {
    it("returns identity for unfrozen object", () => {
      const value = { a: 1, b: { c: 2 } } as FabricValue;
      expect(cloneIfNecessary(value, { frozen: true })).toBe(value);
    });

    it("returns identity for frozen object", () => {
      const value = Object.freeze({ a: 1 }) as FabricValue;
      expect(cloneIfNecessary(value, { frozen: true })).toBe(value);
    });

    it("returns identity for unfrozen array", () => {
      const value = [1, 2, 3] as FabricValue;
      expect(cloneIfNecessary(value, { frozen: true })).toBe(value);
    });

    it("returns identity for frozen array", () => {
      const value = Object.freeze([1, 2, 3]) as FabricValue;
      expect(cloneIfNecessary(value, { frozen: true })).toBe(value);
    });

    it("returns identity with deep=false, frozen=true", () => {
      const value = { a: { b: 1 } } as FabricValue;
      expect(cloneIfNecessary(value, { frozen: true, deep: false })).toBe(
        value,
      );
    });
  });

  // --------------------------------------------------------------------------
  // Legacy path: undefined handling
  // --------------------------------------------------------------------------

  describe("legacy path: undefined handling", () => {
    it("passes through undefined as top-level value", () => {
      expect(cloneIfNecessary(undefined, { frozen: false })).toBe(undefined);
    });

    it("passes through undefined with default options", () => {
      expect(cloneIfNecessary(undefined)).toBe(undefined);
    });
  });

  // --------------------------------------------------------------------------
  // Flag ON (rich) -- default options (frozen=true, deep=true, force=false)
  // --------------------------------------------------------------------------

  describe("rich path: default options (frozen=true, deep=true)", () => {
    it("passes through primitives unchanged", () => {
      setDataModelConfig({ modernDataModel: true });
      expect(cloneIfNecessary(42 as FabricValue)).toBe(42);
      expect(cloneIfNecessary("hello" as FabricValue)).toBe("hello");
      expect(cloneIfNecessary(null)).toBe(null);
      expect(cloneIfNecessary(true as FabricValue)).toBe(true);
      expect(cloneIfNecessary(undefined)).toBe(undefined);
    });

    it("passes through bigint unchanged", () => {
      setDataModelConfig({ modernDataModel: true });
      expect(cloneIfNecessary(42n as FabricValue)).toBe(42n);
    });

    it("returns a frozen copy of an unfrozen object", () => {
      setDataModelConfig({ modernDataModel: true });
      const value = { a: 1, b: "two" } as FabricValue;
      const result = cloneIfNecessary(value);
      expect(result).toEqual({ a: 1, b: "two" });
      expect(result).not.toBe(value);
      expect(Object.isFrozen(result)).toBe(true);
    });

    it("returns a frozen copy of an unfrozen array", () => {
      setDataModelConfig({ modernDataModel: true });
      const value = [1, 2, 3] as FabricValue;
      const result = cloneIfNecessary(value);
      expect(result).toEqual([1, 2, 3]);
      expect(result).not.toBe(value);
      expect(Object.isFrozen(result)).toBe(true);
    });

    it("deep-freezes nested structures", () => {
      setDataModelConfig({ modernDataModel: true });
      const value = { a: { b: [1, 2] } } as FabricValue;
      const result = cloneIfNecessary(value) as Record<string, unknown>;
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.a)).toBe(true);
      const inner = (result.a as Record<string, unknown>).b;
      expect(Object.isFrozen(inner)).toBe(true);
    });

    it("returns already-deep-frozen value as-is (identity optimization)", () => {
      setDataModelConfig({ modernDataModel: true });
      const inner = Object.freeze([1, 2]);
      const value = Object.freeze({ a: inner }) as FabricValue;
      const result = cloneIfNecessary(value);
      expect(result).toBe(value); // identity -- no clone needed
    });

    it("preserves deep-frozen subtrees as-is within unfrozen parent", () => {
      setDataModelConfig({ modernDataModel: true });
      // `frozenChild` is a deep-frozen subtree.
      const frozenChild = Object.freeze({ x: Object.freeze([1, 2]) });
      // `value` is NOT frozen (unfrozen parent), so it must be cloned.
      const value = { a: frozenChild, b: "mutable" } as FabricValue;
      const result = cloneIfNecessary(value) as Record<string, unknown>;
      // The outer object is a new frozen clone.
      expect(result).not.toBe(value);
      expect(Object.isFrozen(result)).toBe(true);
      // The deep-frozen subtree is preserved by identity -- not re-cloned.
      expect(result.a).toBe(frozenChild);
      expect(result.b).toBe("mutable");
    });
  });

  // --------------------------------------------------------------------------
  // frozen=false, force=true (default when frozen=false) -- deep
  // --------------------------------------------------------------------------

  describe("rich path: frozen=false (deep, force=true default)", () => {
    it("returns a mutable copy of a frozen object", () => {
      setDataModelConfig({ modernDataModel: true });
      const value = Object.freeze({ a: 1, b: "two" }) as FabricValue;
      const result = cloneIfNecessary(value, { frozen: false });
      expect(result).toEqual({ a: 1, b: "two" });
      expect(result).not.toBe(value);
      expect(Object.isFrozen(result)).toBe(false);
    });

    it("returns a mutable array copy", () => {
      setDataModelConfig({ modernDataModel: true });
      const value = Object.freeze([1, 2, 3]) as FabricValue;
      const result = cloneIfNecessary(value, { frozen: false });
      expect(result).toEqual([1, 2, 3]);
      expect(result).not.toBe(value);
      expect(Object.isFrozen(result)).toBe(false);
    });

    it("clones already-mutable values (force=true default)", () => {
      setDataModelConfig({ modernDataModel: true });
      const inner = { x: 1 };
      const value = { a: inner, b: [2, 3] } as FabricValue;
      const result = cloneIfNecessary(value, { frozen: false }) as Record<
        string,
        unknown
      >;
      // Must be a different reference, even though input is already mutable.
      expect(result).not.toBe(value);
      expect(result).toEqual({ a: { x: 1 }, b: [2, 3] });
      expect(Object.isFrozen(result)).toBe(false);
      // Nested values are also cloned.
      expect(result.a).not.toBe(inner);
      expect(result.b).not.toBe((value as Record<string, unknown>).b);
    });

    it("deep-unfreezes nested structures", () => {
      setDataModelConfig({ modernDataModel: true });
      const inner = Object.freeze([1, 2]);
      const value = Object.freeze({
        a: Object.freeze({ b: inner }),
      }) as FabricValue;
      const result = cloneIfNecessary(value, { frozen: false }) as Record<
        string,
        unknown
      >;
      expect(Object.isFrozen(result)).toBe(false);
      expect(Object.isFrozen(result.a)).toBe(false);
      const innerResult = (result.a as Record<string, unknown>).b;
      expect(Object.isFrozen(innerResult)).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // shallow clone (deep=false)
  // --------------------------------------------------------------------------

  describe("rich path: shallow clone (deep=false)", () => {
    it("shallow-clones an unfrozen object to frozen", () => {
      setDataModelConfig({ modernDataModel: true });
      const inner = { x: 1 };
      const value = { a: inner } as FabricValue;
      const result = cloneIfNecessary(value, { deep: false }) as Record<
        string,
        unknown
      >;
      expect(result).not.toBe(value);
      expect(Object.isFrozen(result)).toBe(true);
      // Shallow: inner reference is preserved (not deep-cloned).
      expect(result.a).toBe(inner);
    });

    it("returns already-frozen object as-is (shallow, force=false)", () => {
      setDataModelConfig({ modernDataModel: true });
      const value = Object.freeze({ a: 1 }) as FabricValue;
      const result = cloneIfNecessary(value, { deep: false });
      expect(result).toBe(value);
    });

    it("shallow-clones frozen object to mutable (deep=false, frozen=false)", () => {
      setDataModelConfig({ modernDataModel: true });
      const value = Object.freeze({ a: 1, b: "two" }) as FabricValue;
      const result = cloneIfNecessary(value, {
        deep: false,
        frozen: false,
      }) as Record<string, unknown>;
      expect(result).not.toBe(value);
      expect(Object.isFrozen(result)).toBe(false);
      expect(result.a).toBe(1);
    });

    it("force-copies mutable object (shallow, frozen=false, force=true)", () => {
      setDataModelConfig({ modernDataModel: true });
      const value = { a: 1 } as FabricValue;
      const result = cloneIfNecessary(value, {
        deep: false,
        frozen: false,
      }); // force defaults to true for frozen=false
      expect(result).not.toBe(value);
      expect(result).toEqual({ a: 1 });
      expect(Object.isFrozen(result)).toBe(false);
    });

    it("returns mutable as-is (shallow, frozen=false, force=false)", () => {
      setDataModelConfig({ modernDataModel: true });
      const value = { a: 1 } as FabricValue;
      const result = cloneIfNecessary(value, {
        deep: false,
        frozen: false,
        force: false,
      });
      expect(result).toBe(value);
    });

    it("thaws frozen value (shallow, frozen=false, force=false)", () => {
      setDataModelConfig({ modernDataModel: true });
      const value = Object.freeze({ a: 1 }) as FabricValue;
      const result = cloneIfNecessary(value, {
        deep: false,
        frozen: false,
        force: false,
      });
      expect(result).not.toBe(value);
      expect(result).toEqual({ a: 1 });
      expect(Object.isFrozen(result)).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // FabricError (FabricInstance)
  // --------------------------------------------------------------------------

  describe("FabricInstance", () => {
    it("clones FabricError via shallowClone protocol", () => {
      setDataModelConfig({ modernDataModel: true });
      const error = new FabricError(new Error("test"));
      Object.freeze(error);
      const result = cloneIfNecessary(error as unknown as FabricValue);
      expect(result).toBeInstanceOf(FabricError);
      expect(Object.isFrozen(result)).toBe(true);
    });

    it("produces mutable FabricError clone when frozen=false", () => {
      setDataModelConfig({ modernDataModel: true });
      const error = new FabricError(new Error("test"));
      Object.freeze(error);
      const result = cloneIfNecessary(
        error as unknown as FabricValue,
        { frozen: false },
      );
      expect(result).toBeInstanceOf(FabricError);
      expect(result).not.toBe(error);
      expect(Object.isFrozen(result)).toBe(false);
    });

    it("handles FabricError nested in an object", () => {
      setDataModelConfig({ modernDataModel: true });
      const error = new FabricError(new Error("nested"));
      const value = { err: error, x: 42 } as FabricValue;
      const result = cloneIfNecessary(value) as Record<string, unknown>;
      expect(Object.isFrozen(result)).toBe(true);
      expect(result.err).toBeInstanceOf(FabricError);
      expect(result.x).toBe(42);
    });
  });

  // --------------------------------------------------------------------------
  // undefined preservation
  // --------------------------------------------------------------------------

  describe("undefined preservation", () => {
    it("preserves undefined in objects", () => {
      setDataModelConfig({ modernDataModel: true });
      const value = { a: 1, b: undefined } as FabricValue;
      const result = cloneIfNecessary(value) as Record<string, unknown>;
      expect(result.b).toBe(undefined);
      expect("b" in result).toBe(true);
      expect(Object.isFrozen(result)).toBe(true);
    });

    it("preserves undefined in arrays", () => {
      setDataModelConfig({ modernDataModel: true });
      const value = [1, undefined, 3] as FabricValue;
      const result = cloneIfNecessary(value) as unknown[];
      expect(result[1]).toBe(undefined);
      expect(1 in result).toBe(true);
      expect(Object.isFrozen(result)).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // null prototype preservation
  // --------------------------------------------------------------------------

  describe("null prototype preservation", () => {
    it("preserves null prototype on objects", () => {
      setDataModelConfig({ modernDataModel: true });
      const value = Object.create(null) as Record<string, unknown>;
      value.a = 1;
      value.b = "two";
      const result = cloneIfNecessary(
        value as FabricValue,
      ) as Record<string, unknown>;
      expect(Object.getPrototypeOf(result)).toBe(null);
      expect(result.a).toBe(1);
      expect(result.b).toBe("two");
      expect(Object.isFrozen(result)).toBe(true);
    });

    it("preserves null prototype when frozen=false", () => {
      setDataModelConfig({ modernDataModel: true });
      const value = Object.create(null) as Record<string, unknown>;
      value.x = 42;
      const result = cloneIfNecessary(
        value as FabricValue,
        { frozen: false },
      ) as Record<string, unknown>;
      expect(Object.getPrototypeOf(result)).toBe(null);
      expect(result.x).toBe(42);
      expect(Object.isFrozen(result)).toBe(false);
    });

    it("preserves null prototype on shallow clone", () => {
      setDataModelConfig({ modernDataModel: true });
      const value = Object.create(null) as Record<string, unknown>;
      value.a = 1;
      const result = cloneIfNecessary(
        value as FabricValue,
        { deep: false },
      ) as Record<string, unknown>;
      expect(Object.getPrototypeOf(result)).toBe(null);
      expect(result.a).toBe(1);
      expect(Object.isFrozen(result)).toBe(true);
    });

    it("preserves null prototype on shallow clone when frozen=false", () => {
      setDataModelConfig({ modernDataModel: true });
      const value = Object.create(null) as Record<string, unknown>;
      value.b = 2;
      const result = cloneIfNecessary(
        value as FabricValue,
        { frozen: false, deep: false },
      ) as Record<string, unknown>;
      expect(Object.getPrototypeOf(result)).toBe(null);
      expect(result.b).toBe(2);
      expect(Object.isFrozen(result)).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // SpecialPrimitiveValue pass-through
  // --------------------------------------------------------------------------

  describe("SpecialPrimitiveValue", () => {
    it("passes through FabricEpochNsec unchanged", () => {
      setDataModelConfig({ modernDataModel: true });
      const epoch = new FabricEpochNsec(1234567890n);
      Object.freeze(epoch);
      const result = cloneIfNecessary(epoch as unknown as FabricValue);
      expect(result).toBe(epoch); // identity -- special primitives are immutable
    });

    it("passes through FabricEpochNsec when frozen=false", () => {
      setDataModelConfig({ modernDataModel: true });
      const epoch = new FabricEpochNsec(42n);
      Object.freeze(epoch);
      // frozen parameter is irrelevant for special primitives
      const result = cloneIfNecessary(
        epoch as unknown as FabricValue,
        { frozen: false },
      );
      expect(result).toBe(epoch); // identity -- special primitives are immutable
    });

    it("passes through FabricEpochNsec nested in an object", () => {
      setDataModelConfig({ modernDataModel: true });
      const epoch = new FabricEpochNsec(999n);
      Object.freeze(epoch);
      const value = { time: epoch, label: "test" } as FabricValue;
      const result = cloneIfNecessary(value) as Record<string, unknown>;
      expect(Object.isFrozen(result)).toBe(true);
      expect(result.time).toBe(epoch); // same instance -- not cloned
      expect(result.label).toBe("test");
    });
  });

  // --------------------------------------------------------------------------
  // Circular reference detection
  // --------------------------------------------------------------------------

  describe("circular reference detection", () => {
    it("throws on direct circular object reference", () => {
      setDataModelConfig({ modernDataModel: true });
      const obj = {} as Record<string, unknown>;
      obj.self = obj;
      expect(() => cloneIfNecessary(obj as FabricValue)).toThrow(
        "Cannot deep-clone circular reference",
      );
    });

    it("throws on circular array reference", () => {
      setDataModelConfig({ modernDataModel: true });
      const arr: unknown[] = [1, 2];
      arr.push(arr);
      expect(() => cloneIfNecessary(arr as FabricValue)).toThrow(
        "Cannot deep-clone circular reference",
      );
    });

    it("throws on indirect circular reference", () => {
      setDataModelConfig({ modernDataModel: true });
      const a = {} as Record<string, unknown>;
      const b = { parent: a } as Record<string, unknown>;
      a.child = b;
      expect(() => cloneIfNecessary(a as FabricValue)).toThrow(
        "Cannot deep-clone circular reference",
      );
    });

    it("handles shared (diamond) references without throwing", () => {
      setDataModelConfig({ modernDataModel: true });
      const shared = { x: 1 };
      const value = { a: shared, b: shared } as FabricValue;
      // Shared (non-circular) references should not throw.
      const result = cloneIfNecessary(value) as Record<string, unknown>;
      expect(result).toEqual({ a: { x: 1 }, b: { x: 1 } });
      expect(Object.isFrozen(result)).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Config lifecycle
  // --------------------------------------------------------------------------

  describe("config lifecycle", () => {
    it("switching from rich to legacy restores identity passthrough", () => {
      setDataModelConfig({ modernDataModel: true });
      const value = { a: 1 } as FabricValue;
      const richResult = cloneIfNecessary(value);
      expect(richResult).not.toBe(value); // rich path clones

      resetDataModelConfig();
      const legacyResult = cloneIfNecessary(value);
      expect(legacyResult).toBe(value); // legacy path is identity
    });
  });
});
