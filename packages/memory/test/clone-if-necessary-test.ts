import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  cloneIfNecessary,
  resetStorableValueConfig,
  setStorableValueConfig,
} from "../storable-value.ts";
import type { StorableValue } from "../interface.ts";
import {
  StorableEpochNsec,
  StorableError,
} from "../storable-native-instances.ts";

// ============================================================================
// Tests
// ============================================================================

describe("cloneIfNecessary", () => {
  afterEach(() => {
    resetStorableValueConfig();
  });

  // --------------------------------------------------------------------------
  // Default state (flag OFF / legacy) -- identity passthrough
  // --------------------------------------------------------------------------

  describe("legacy path (flag OFF)", () => {
    it("returns the same object (identity passthrough)", () => {
      const value = { a: 1, b: [2, 3] } as StorableValue;
      expect(cloneIfNecessary(value)).toBe(value);
    });

    it("returns the same array (identity passthrough)", () => {
      const value = [1, 2, 3] as StorableValue;
      expect(cloneIfNecessary(value)).toBe(value);
    });

    it("passes through primitives", () => {
      expect(cloneIfNecessary(42 as StorableValue)).toBe(42);
      expect(cloneIfNecessary("hello" as StorableValue)).toBe("hello");
      expect(cloneIfNecessary(null)).toBe(null);
      expect(cloneIfNecessary(true as StorableValue)).toBe(true);
      expect(cloneIfNecessary(undefined)).toBe(undefined);
    });

    it("ignores options (identity passthrough regardless)", () => {
      const value = { a: 1 } as StorableValue;
      expect(cloneIfNecessary(value, { frozen: true })).toBe(value);
      expect(cloneIfNecessary(value, { frozen: false })).toBe(value);
      expect(cloneIfNecessary(value, { deep: false })).toBe(value);
    });
  });

  // --------------------------------------------------------------------------
  // Flag ON (rich) -- default options (frozen=true, deep=true, force=false)
  // --------------------------------------------------------------------------

  describe("rich path: default options (frozen=true, deep=true)", () => {
    it("passes through primitives unchanged", () => {
      setStorableValueConfig({ richStorableValues: true });
      expect(cloneIfNecessary(42 as StorableValue)).toBe(42);
      expect(cloneIfNecessary("hello" as StorableValue)).toBe("hello");
      expect(cloneIfNecessary(null)).toBe(null);
      expect(cloneIfNecessary(true as StorableValue)).toBe(true);
      expect(cloneIfNecessary(undefined)).toBe(undefined);
    });

    it("passes through bigint unchanged", () => {
      setStorableValueConfig({ richStorableValues: true });
      expect(cloneIfNecessary(42n as StorableValue)).toBe(42n);
    });

    it("returns a frozen copy of an unfrozen object", () => {
      setStorableValueConfig({ richStorableValues: true });
      const value = { a: 1, b: "two" } as StorableValue;
      const result = cloneIfNecessary(value);
      expect(result).toEqual({ a: 1, b: "two" });
      expect(result).not.toBe(value);
      expect(Object.isFrozen(result)).toBe(true);
    });

    it("returns a frozen copy of an unfrozen array", () => {
      setStorableValueConfig({ richStorableValues: true });
      const value = [1, 2, 3] as StorableValue;
      const result = cloneIfNecessary(value);
      expect(result).toEqual([1, 2, 3]);
      expect(result).not.toBe(value);
      expect(Object.isFrozen(result)).toBe(true);
    });

    it("deep-freezes nested structures", () => {
      setStorableValueConfig({ richStorableValues: true });
      const value = { a: { b: [1, 2] } } as StorableValue;
      const result = cloneIfNecessary(value) as Record<string, unknown>;
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.a)).toBe(true);
      const inner = (result.a as Record<string, unknown>).b;
      expect(Object.isFrozen(inner)).toBe(true);
    });

    it("returns already-deep-frozen value as-is (identity optimization)", () => {
      setStorableValueConfig({ richStorableValues: true });
      const inner = Object.freeze([1, 2]);
      const value = Object.freeze({ a: inner }) as StorableValue;
      const result = cloneIfNecessary(value);
      expect(result).toBe(value); // identity -- no clone needed
    });

    it("preserves deep-frozen subtrees as-is within unfrozen parent", () => {
      setStorableValueConfig({ richStorableValues: true });
      const frozenChild = Object.freeze({ x: Object.freeze([1, 2]) });
      const value = { a: frozenChild, b: "mutable" } as StorableValue;
      const result = cloneIfNecessary(value) as Record<string, unknown>;
      expect(result).not.toBe(value);
      expect(Object.isFrozen(result)).toBe(true);
      expect(result.a).toBe(frozenChild);
      expect(result.b).toBe("mutable");
    });
  });

  // --------------------------------------------------------------------------
  // frozen=false, force=true (default when frozen=false) -- deep
  // --------------------------------------------------------------------------

  describe("rich path: frozen=false (deep, force=true default)", () => {
    it("returns a mutable copy of a frozen object", () => {
      setStorableValueConfig({ richStorableValues: true });
      const value = Object.freeze({ a: 1, b: "two" }) as StorableValue;
      const result = cloneIfNecessary(value, { frozen: false });
      expect(result).toEqual({ a: 1, b: "two" });
      expect(result).not.toBe(value);
      expect(Object.isFrozen(result)).toBe(false);
    });

    it("returns a mutable array copy", () => {
      setStorableValueConfig({ richStorableValues: true });
      const value = Object.freeze([1, 2, 3]) as StorableValue;
      const result = cloneIfNecessary(value, { frozen: false });
      expect(result).toEqual([1, 2, 3]);
      expect(result).not.toBe(value);
      expect(Object.isFrozen(result)).toBe(false);
    });

    it("clones already-mutable values (force=true default)", () => {
      setStorableValueConfig({ richStorableValues: true });
      const inner = { x: 1 };
      const value = { a: inner, b: [2, 3] } as StorableValue;
      const result = cloneIfNecessary(value, { frozen: false }) as Record<
        string,
        unknown
      >;
      // Must be a different reference even though input is already mutable.
      expect(result).not.toBe(value);
      expect(result).toEqual({ a: { x: 1 }, b: [2, 3] });
      expect(Object.isFrozen(result)).toBe(false);
      expect(result.a).not.toBe(inner);
    });

    it("deep-unfreezes nested structures", () => {
      setStorableValueConfig({ richStorableValues: true });
      const inner = Object.freeze([1, 2]);
      const value = Object.freeze({
        a: Object.freeze({ b: inner }),
      }) as StorableValue;
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
  // Error cases
  // --------------------------------------------------------------------------

  describe("rich path: error cases", () => {
    it("throws for frozen=true, force=true", () => {
      setStorableValueConfig({ richStorableValues: true });
      const value = { a: 1 } as StorableValue;
      expect(() => cloneIfNecessary(value, { frozen: true, force: true }))
        .toThrow("frozen: true, force: true");
    });

    it("throws for frozen=false, force=false, deep=true", () => {
      setStorableValueConfig({ richStorableValues: true });
      const value = { a: 1 } as StorableValue;
      expect(() => cloneIfNecessary(value, { frozen: false, force: false }))
        .toThrow("frozen: false, force: false, deep: true");
    });
  });

  // --------------------------------------------------------------------------
  // shallow clone (deep=false)
  // --------------------------------------------------------------------------

  describe("rich path: shallow clone (deep=false)", () => {
    it("shallow-clones an unfrozen object to frozen", () => {
      setStorableValueConfig({ richStorableValues: true });
      const inner = { x: 1 };
      const value = { a: inner } as StorableValue;
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
      setStorableValueConfig({ richStorableValues: true });
      const value = Object.freeze({ a: 1 }) as StorableValue;
      const result = cloneIfNecessary(value, { deep: false });
      expect(result).toBe(value);
    });

    it("shallow-clones frozen object to mutable (deep=false, frozen=false)", () => {
      setStorableValueConfig({ richStorableValues: true });
      const value = Object.freeze({ a: 1, b: "two" }) as StorableValue;
      const result = cloneIfNecessary(value, {
        deep: false,
        frozen: false,
      }) as Record<string, unknown>;
      expect(result).not.toBe(value);
      expect(Object.isFrozen(result)).toBe(false);
      expect(result.a).toBe(1);
    });

    it("force-copies mutable object (shallow, frozen=false, force=true)", () => {
      setStorableValueConfig({ richStorableValues: true });
      const value = { a: 1 } as StorableValue;
      const result = cloneIfNecessary(value, {
        deep: false,
        frozen: false,
      }); // force defaults to true for frozen=false
      expect(result).not.toBe(value);
      expect(result).toEqual({ a: 1 });
      expect(Object.isFrozen(result)).toBe(false);
    });

    it("returns mutable as-is (shallow, frozen=false, force=false)", () => {
      setStorableValueConfig({ richStorableValues: true });
      const value = { a: 1 } as StorableValue;
      const result = cloneIfNecessary(value, {
        deep: false,
        frozen: false,
        force: false,
      });
      expect(result).toBe(value);
    });

    it("thaws frozen value (shallow, frozen=false, force=false)", () => {
      setStorableValueConfig({ richStorableValues: true });
      const value = Object.freeze({ a: 1 }) as StorableValue;
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
  // StorableError (StorableInstance)
  // --------------------------------------------------------------------------

  describe("StorableInstance", () => {
    it("clones StorableError via shallowClone protocol", () => {
      setStorableValueConfig({ richStorableValues: true });
      const error = new StorableError(new Error("test"));
      Object.freeze(error);
      const result = cloneIfNecessary(error as unknown as StorableValue);
      expect(result).toBeInstanceOf(StorableError);
      expect(Object.isFrozen(result)).toBe(true);
    });

    it("produces mutable StorableError clone when frozen=false", () => {
      setStorableValueConfig({ richStorableValues: true });
      const error = new StorableError(new Error("test"));
      Object.freeze(error);
      const result = cloneIfNecessary(
        error as unknown as StorableValue,
        { frozen: false },
      );
      expect(result).toBeInstanceOf(StorableError);
      expect(result).not.toBe(error);
      expect(Object.isFrozen(result)).toBe(false);
    });

    it("handles StorableError nested in an object", () => {
      setStorableValueConfig({ richStorableValues: true });
      const error = new StorableError(new Error("nested"));
      const value = { err: error, x: 42 } as StorableValue;
      const result = cloneIfNecessary(value) as Record<string, unknown>;
      expect(Object.isFrozen(result)).toBe(true);
      expect(result.err).toBeInstanceOf(StorableError);
      expect(result.x).toBe(42);
    });
  });

  // --------------------------------------------------------------------------
  // undefined preservation
  // --------------------------------------------------------------------------

  describe("undefined preservation", () => {
    it("preserves undefined in objects", () => {
      setStorableValueConfig({ richStorableValues: true });
      const value = { a: 1, b: undefined } as StorableValue;
      const result = cloneIfNecessary(value) as Record<string, unknown>;
      expect(result.b).toBe(undefined);
      expect("b" in result).toBe(true);
      expect(Object.isFrozen(result)).toBe(true);
    });

    it("preserves undefined in arrays", () => {
      setStorableValueConfig({ richStorableValues: true });
      const value = [1, undefined, 3] as StorableValue;
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
      setStorableValueConfig({ richStorableValues: true });
      const value = Object.create(null) as Record<string, unknown>;
      value.a = 1;
      value.b = "two";
      const result = cloneIfNecessary(
        value as StorableValue,
      ) as Record<string, unknown>;
      expect(Object.getPrototypeOf(result)).toBe(null);
      expect(result.a).toBe(1);
      expect(result.b).toBe("two");
      expect(Object.isFrozen(result)).toBe(true);
    });

    it("preserves null prototype when frozen=false", () => {
      setStorableValueConfig({ richStorableValues: true });
      const value = Object.create(null) as Record<string, unknown>;
      value.x = 42;
      const result = cloneIfNecessary(
        value as StorableValue,
        { frozen: false },
      ) as Record<string, unknown>;
      expect(Object.getPrototypeOf(result)).toBe(null);
      expect(result.x).toBe(42);
      expect(Object.isFrozen(result)).toBe(false);
    });

    it("preserves null prototype on shallow clone", () => {
      setStorableValueConfig({ richStorableValues: true });
      const value = Object.create(null) as Record<string, unknown>;
      value.a = 1;
      const result = cloneIfNecessary(
        value as StorableValue,
        { deep: false },
      ) as Record<string, unknown>;
      expect(Object.getPrototypeOf(result)).toBe(null);
      expect(result.a).toBe(1);
      expect(Object.isFrozen(result)).toBe(true);
    });

    it("preserves null prototype on shallow clone when frozen=false", () => {
      setStorableValueConfig({ richStorableValues: true });
      const value = Object.create(null) as Record<string, unknown>;
      value.b = 2;
      const result = cloneIfNecessary(
        value as StorableValue,
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
    it("passes through StorableEpochNsec unchanged", () => {
      setStorableValueConfig({ richStorableValues: true });
      const epoch = new StorableEpochNsec(1234567890n);
      Object.freeze(epoch);
      const result = cloneIfNecessary(epoch as unknown as StorableValue);
      expect(result).toBe(epoch);
    });

    it("passes through StorableEpochNsec when frozen=false", () => {
      setStorableValueConfig({ richStorableValues: true });
      const epoch = new StorableEpochNsec(42n);
      Object.freeze(epoch);
      const result = cloneIfNecessary(
        epoch as unknown as StorableValue,
        { frozen: false },
      );
      expect(result).toBe(epoch);
    });

    it("passes through StorableEpochNsec nested in an object", () => {
      setStorableValueConfig({ richStorableValues: true });
      const epoch = new StorableEpochNsec(999n);
      Object.freeze(epoch);
      const value = { time: epoch, label: "test" } as StorableValue;
      const result = cloneIfNecessary(value) as Record<string, unknown>;
      expect(Object.isFrozen(result)).toBe(true);
      expect(result.time).toBe(epoch);
      expect(result.label).toBe("test");
    });
  });

  // --------------------------------------------------------------------------
  // Circular reference detection
  // --------------------------------------------------------------------------

  describe("circular reference detection", () => {
    it("throws on direct circular object reference", () => {
      setStorableValueConfig({ richStorableValues: true });
      const obj = {} as Record<string, unknown>;
      obj.self = obj;
      expect(() => cloneIfNecessary(obj as StorableValue)).toThrow(
        "Cannot deep-clone circular reference",
      );
    });

    it("throws on circular array reference", () => {
      setStorableValueConfig({ richStorableValues: true });
      const arr: unknown[] = [1, 2];
      arr.push(arr);
      expect(() => cloneIfNecessary(arr as StorableValue)).toThrow(
        "Cannot deep-clone circular reference",
      );
    });

    it("throws on indirect circular reference", () => {
      setStorableValueConfig({ richStorableValues: true });
      const a = {} as Record<string, unknown>;
      const b = { parent: a } as Record<string, unknown>;
      a.child = b;
      expect(() => cloneIfNecessary(a as StorableValue)).toThrow(
        "Cannot deep-clone circular reference",
      );
    });

    it("handles shared (diamond) references without throwing", () => {
      setStorableValueConfig({ richStorableValues: true });
      const shared = { x: 1 };
      const value = { a: shared, b: shared } as StorableValue;
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
      setStorableValueConfig({ richStorableValues: true });
      const value = { a: 1 } as StorableValue;
      const richResult = cloneIfNecessary(value);
      expect(richResult).not.toBe(value);

      resetStorableValueConfig();
      const legacyResult = cloneIfNecessary(value);
      expect(legacyResult).toBe(value);
    });
  });
});
