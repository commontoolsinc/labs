import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  deepCloneIfNecessary,
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

describe("deepCloneIfNecessary", () => {
  // Always reset after each test to avoid leaking flag state.
  afterEach(() => {
    resetStorableValueConfig();
  });

  // --------------------------------------------------------------------------
  // Default state (flag OFF / legacy) -- identity passthrough
  // --------------------------------------------------------------------------

  describe("legacy path (flag OFF)", () => {
    it("returns the same object (identity passthrough)", () => {
      const value = { a: 1, b: [2, 3] } as StorableValue;
      expect(deepCloneIfNecessary(value)).toBe(value);
    });

    it("returns the same array (identity passthrough)", () => {
      const value = [1, 2, 3] as StorableValue;
      expect(deepCloneIfNecessary(value)).toBe(value);
    });

    it("passes through primitives", () => {
      expect(deepCloneIfNecessary(42 as StorableValue)).toBe(42);
      expect(deepCloneIfNecessary("hello" as StorableValue)).toBe("hello");
      expect(deepCloneIfNecessary(null)).toBe(null);
      expect(deepCloneIfNecessary(true as StorableValue)).toBe(true);
      expect(deepCloneIfNecessary(undefined)).toBe(undefined);
    });

    it("ignores frozen parameter (identity passthrough regardless)", () => {
      const value = { a: 1 } as StorableValue;
      expect(deepCloneIfNecessary(value, true)).toBe(value);
      expect(deepCloneIfNecessary(value, false)).toBe(value);
    });
  });

  // --------------------------------------------------------------------------
  // Flag ON (rich) -- deep-clone with frozenness control
  // --------------------------------------------------------------------------

  describe("rich path (flag ON)", () => {
    // -- Primitives --

    it("passes through primitives unchanged", () => {
      setStorableValueConfig({ richStorableValues: true });
      expect(deepCloneIfNecessary(42 as StorableValue)).toBe(42);
      expect(deepCloneIfNecessary("hello" as StorableValue)).toBe("hello");
      expect(deepCloneIfNecessary(null)).toBe(null);
      expect(deepCloneIfNecessary(true as StorableValue)).toBe(true);
      expect(deepCloneIfNecessary(undefined)).toBe(undefined);
    });

    it("passes through bigint unchanged", () => {
      setStorableValueConfig({ richStorableValues: true });
      expect(deepCloneIfNecessary(42n as StorableValue)).toBe(42n);
    });

    // -- Frozen=true (default) --

    it("returns a frozen copy of an unfrozen object", () => {
      setStorableValueConfig({ richStorableValues: true });
      const value = { a: 1, b: "two" } as StorableValue;
      const result = deepCloneIfNecessary(value);
      expect(result).toEqual({ a: 1, b: "two" });
      expect(result).not.toBe(value);
      expect(Object.isFrozen(result)).toBe(true);
    });

    it("returns a frozen copy of an unfrozen array", () => {
      setStorableValueConfig({ richStorableValues: true });
      const value = [1, 2, 3] as StorableValue;
      const result = deepCloneIfNecessary(value);
      expect(result).toEqual([1, 2, 3]);
      expect(result).not.toBe(value);
      expect(Object.isFrozen(result)).toBe(true);
    });

    it("deep-freezes nested structures", () => {
      setStorableValueConfig({ richStorableValues: true });
      const value = { a: { b: [1, 2] } } as StorableValue;
      const result = deepCloneIfNecessary(value) as Record<string, unknown>;
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.a)).toBe(true);
      const inner = (result.a as Record<string, unknown>).b;
      expect(Object.isFrozen(inner)).toBe(true);
    });

    it("returns already-deep-frozen value as-is (identity optimization)", () => {
      setStorableValueConfig({ richStorableValues: true });
      const inner = Object.freeze([1, 2]);
      const value = Object.freeze({ a: inner }) as StorableValue;
      const result = deepCloneIfNecessary(value);
      expect(result).toBe(value); // identity -- no clone needed
    });

    // -- Frozen=false (mutable copy) --

    it("returns a mutable copy when frozen=false", () => {
      setStorableValueConfig({ richStorableValues: true });
      const value = Object.freeze({ a: 1, b: "two" }) as StorableValue;
      const result = deepCloneIfNecessary(value, false);
      expect(result).toEqual({ a: 1, b: "two" });
      expect(result).not.toBe(value);
      expect(Object.isFrozen(result)).toBe(false);
    });

    it("returns a mutable array copy when frozen=false", () => {
      setStorableValueConfig({ richStorableValues: true });
      const value = Object.freeze([1, 2, 3]) as StorableValue;
      const result = deepCloneIfNecessary(value, false);
      expect(result).toEqual([1, 2, 3]);
      expect(result).not.toBe(value);
      expect(Object.isFrozen(result)).toBe(false);
    });

    it("clones already-mutable values when frozen=false (not identity)", () => {
      setStorableValueConfig({ richStorableValues: true });
      const inner = { x: 1 };
      const value = { a: inner, b: [2, 3] } as StorableValue;
      const result = deepCloneIfNecessary(value, false) as Record<
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

    it("deep-unfreezes nested structures when frozen=false", () => {
      setStorableValueConfig({ richStorableValues: true });
      const inner = Object.freeze([1, 2]);
      const value = Object.freeze({
        a: Object.freeze({ b: inner }),
      }) as StorableValue;
      const result = deepCloneIfNecessary(value, false) as Record<
        string,
        unknown
      >;
      expect(Object.isFrozen(result)).toBe(false);
      expect(Object.isFrozen(result.a)).toBe(false);
      const innerResult = (result.a as Record<string, unknown>).b;
      expect(Object.isFrozen(innerResult)).toBe(false);
    });

    // -- StorableError (StorableInstance) --

    it("clones StorableError via shallowClone protocol", () => {
      setStorableValueConfig({ richStorableValues: true });
      const error = new StorableError(new Error("test"));
      Object.freeze(error);
      const result = deepCloneIfNecessary(error as unknown as StorableValue);
      expect(result).toBeInstanceOf(StorableError);
      expect(Object.isFrozen(result)).toBe(true);
    });

    it("produces mutable StorableError clone when frozen=false", () => {
      setStorableValueConfig({ richStorableValues: true });
      const error = new StorableError(new Error("test"));
      Object.freeze(error);
      const result = deepCloneIfNecessary(
        error as unknown as StorableValue,
        false,
      );
      expect(result).toBeInstanceOf(StorableError);
      expect(result).not.toBe(error);
      expect(Object.isFrozen(result)).toBe(false);
    });

    // -- Nested StorableInstance inside container --

    it("handles StorableError nested in an object", () => {
      setStorableValueConfig({ richStorableValues: true });
      const error = new StorableError(new Error("nested"));
      const value = { err: error, x: 42 } as StorableValue;
      const result = deepCloneIfNecessary(value) as Record<string, unknown>;
      expect(Object.isFrozen(result)).toBe(true);
      expect(result.err).toBeInstanceOf(StorableError);
      expect(result.x).toBe(42);
    });

    // -- undefined preservation --

    it("preserves undefined in objects", () => {
      setStorableValueConfig({ richStorableValues: true });
      const value = { a: 1, b: undefined } as StorableValue;
      const result = deepCloneIfNecessary(value) as Record<string, unknown>;
      expect(result.b).toBe(undefined);
      expect("b" in result).toBe(true);
      expect(Object.isFrozen(result)).toBe(true);
    });

    it("preserves undefined in arrays", () => {
      setStorableValueConfig({ richStorableValues: true });
      const value = [1, undefined, 3] as StorableValue;
      const result = deepCloneIfNecessary(value) as unknown[];
      expect(result[1]).toBe(undefined);
      expect(1 in result).toBe(true);
      expect(Object.isFrozen(result)).toBe(true);
    });

    // -- null prototype preservation --

    it("preserves null prototype on objects", () => {
      setStorableValueConfig({ richStorableValues: true });
      const value = Object.create(null) as Record<string, unknown>;
      value.a = 1;
      value.b = "two";
      const result = deepCloneIfNecessary(
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
      const result = deepCloneIfNecessary(
        value as StorableValue,
        false,
      ) as Record<string, unknown>;
      expect(Object.getPrototypeOf(result)).toBe(null);
      expect(result.x).toBe(42);
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
      const result = deepCloneIfNecessary(epoch as unknown as StorableValue);
      expect(result).toBe(epoch); // identity -- special primitives are immutable
    });

    it("passes through StorableEpochNsec when frozen=false", () => {
      setStorableValueConfig({ richStorableValues: true });
      const epoch = new StorableEpochNsec(42n);
      Object.freeze(epoch);
      // frozen parameter is irrelevant for special primitives
      const result = deepCloneIfNecessary(
        epoch as unknown as StorableValue,
        false,
      );
      expect(result).toBe(epoch);
    });

    it("passes through StorableEpochNsec nested in an object", () => {
      setStorableValueConfig({ richStorableValues: true });
      const epoch = new StorableEpochNsec(999n);
      Object.freeze(epoch);
      const value = { time: epoch, label: "test" } as StorableValue;
      const result = deepCloneIfNecessary(value) as Record<string, unknown>;
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
      setStorableValueConfig({ richStorableValues: true });
      const obj = {} as Record<string, unknown>;
      obj.self = obj;
      expect(() => deepCloneIfNecessary(obj as StorableValue)).toThrow(
        "Cannot deep-clone circular reference",
      );
    });

    it("throws on circular array reference", () => {
      setStorableValueConfig({ richStorableValues: true });
      const arr: unknown[] = [1, 2];
      arr.push(arr);
      expect(() => deepCloneIfNecessary(arr as StorableValue)).toThrow(
        "Cannot deep-clone circular reference",
      );
    });

    it("throws on indirect circular reference", () => {
      setStorableValueConfig({ richStorableValues: true });
      const a = {} as Record<string, unknown>;
      const b = { parent: a } as Record<string, unknown>;
      a.child = b;
      expect(() => deepCloneIfNecessary(a as StorableValue)).toThrow(
        "Cannot deep-clone circular reference",
      );
    });

    it("handles shared (diamond) references without throwing", () => {
      setStorableValueConfig({ richStorableValues: true });
      const shared = { x: 1 };
      const value = { a: shared, b: shared } as StorableValue;
      // Shared (non-circular) references should not throw.
      const result = deepCloneIfNecessary(value) as Record<string, unknown>;
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
      const richResult = deepCloneIfNecessary(value);
      expect(richResult).not.toBe(value); // rich path clones

      resetStorableValueConfig();
      const legacyResult = deepCloneIfNecessary(value);
      expect(legacyResult).toBe(value); // legacy path is identity
    });
  });
});
