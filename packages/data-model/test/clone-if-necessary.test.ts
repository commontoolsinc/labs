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
//
// Both legacy and modern flag states use modern clone semantics: the legacy
// dispatch target delegates to `cloneIfNecessaryModern`. Test cases are
// parameterized across both modes to ensure the contract is durable under
// either flag setting.

describe("cloneIfNecessary", () => {
  // Always reset after each test to avoid leaking flag state.
  afterEach(() => {
    resetDataModelConfig();
  });

  for (const modernMode of [false, true]) {
    const label = modernMode ? "modern" : "legacy";

    // --------------------------------------------------------------------------
    // Error cases (validation runs before flag dispatch)
    // --------------------------------------------------------------------------

    describe(`error cases (${label} path)`, () => {
      beforeEach(() => setDataModelConfig(modernMode));

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

    // --------------------------------------------------------------------------
    // Default options (frozen=true, deep=true, force=false)
    // --------------------------------------------------------------------------

    describe(`default options (${label} path)`, () => {
      beforeEach(() => setDataModelConfig(modernMode));

      it("passes through primitives unchanged", () => {
        expect(cloneIfNecessary(42 as FabricValue)).toBe(42);
        expect(cloneIfNecessary("hello" as FabricValue)).toBe("hello");
        expect(cloneIfNecessary(null)).toBe(null);
        expect(cloneIfNecessary(true as FabricValue)).toBe(true);
        expect(cloneIfNecessary(undefined)).toBe(undefined);
      });

      it("passes through bigint unchanged", () => {
        expect(cloneIfNecessary(42n as FabricValue)).toBe(42n);
      });

      it("returns a frozen copy of an unfrozen object", () => {
        const value = { a: 1, b: "two" } as FabricValue;
        const result = cloneIfNecessary(value);
        expect(result).toEqual({ a: 1, b: "two" });
        expect(result).not.toBe(value);
        expect(Object.isFrozen(result)).toBe(true);
      });

      it("returns a frozen copy of an unfrozen array", () => {
        const value = [1, 2, 3] as FabricValue;
        const result = cloneIfNecessary(value);
        expect(result).toEqual([1, 2, 3]);
        expect(result).not.toBe(value);
        expect(Object.isFrozen(result)).toBe(true);
      });

      it("deep-freezes nested structures", () => {
        const value = { a: { b: [1, 2] } } as FabricValue;
        const result = cloneIfNecessary(value) as Record<string, unknown>;
        expect(Object.isFrozen(result)).toBe(true);
        expect(Object.isFrozen(result.a)).toBe(true);
        const inner = (result.a as Record<string, unknown>).b;
        expect(Object.isFrozen(inner)).toBe(true);
      });

      it("returns already-deep-frozen value as-is (identity optimization)", () => {
        const inner = Object.freeze([1, 2]);
        const value = Object.freeze({ a: inner }) as FabricValue;
        const result = cloneIfNecessary(value);
        expect(result).toBe(value); // identity -- no clone needed
      });

      it("preserves deep-frozen subtrees as-is within unfrozen parent", () => {
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

    describe(`frozen=false, deep clone (${label} path)`, () => {
      beforeEach(() => setDataModelConfig(modernMode));

      it("returns a mutable copy of a frozen object", () => {
        const value = Object.freeze({ a: 1, b: "two" }) as FabricValue;
        const result = cloneIfNecessary(value, { frozen: false });
        expect(result).toEqual({ a: 1, b: "two" });
        expect(result).not.toBe(value);
        expect(Object.isFrozen(result)).toBe(false);
      });

      it("returns a mutable array copy", () => {
        const value = Object.freeze([1, 2, 3]) as FabricValue;
        const result = cloneIfNecessary(value, { frozen: false });
        expect(result).toEqual([1, 2, 3]);
        expect(result).not.toBe(value);
        expect(Object.isFrozen(result)).toBe(false);
      });

      it("clones already-mutable values (force=true default)", () => {
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

    describe(`shallow clone (${label} path)`, () => {
      beforeEach(() => setDataModelConfig(modernMode));

      it("shallow-clones an unfrozen object to frozen", () => {
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
        const value = Object.freeze({ a: 1 }) as FabricValue;
        const result = cloneIfNecessary(value, { deep: false });
        expect(result).toBe(value);
      });

      it("shallow-clones frozen object to mutable (deep=false, frozen=false)", () => {
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
        const value = { a: 1 } as FabricValue;
        const result = cloneIfNecessary(value, {
          deep: false,
          frozen: false,
          force: false,
        });
        expect(result).toBe(value);
      });

      it("thaws frozen value (shallow, frozen=false, force=false)", () => {
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

    describe(`FabricInstance (${label} path)`, () => {
      beforeEach(() => setDataModelConfig(modernMode));

      it("frozen `FabricError` cannot yet be cloned", () => {
        const error = new FabricError(new Error("test"));
        Object.freeze(error);
        const func = () => cloneIfNecessary(error);
        expect(func).toThrow(/Cannot yet handle/);
      });

      it("produces mutable FabricError clone when frozen=false", () => {
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

    describe(`undefined preservation (${label} path)`, () => {
      beforeEach(() => setDataModelConfig(modernMode));

      it("preserves undefined in objects", () => {
        const value = { a: 1, b: undefined } as FabricValue;
        const result = cloneIfNecessary(value) as Record<string, unknown>;
        expect(result.b).toBe(undefined);
        expect("b" in result).toBe(true);
        expect(Object.isFrozen(result)).toBe(true);
      });

      it("preserves undefined in arrays", () => {
        const value = [1, undefined, 3] as FabricValue;
        const result = cloneIfNecessary(value) as unknown[];
        expect(result[1]).toBe(undefined);
        expect(1 in result).toBe(true);
        expect(Object.isFrozen(result)).toBe(true);
      });

      it("passes through undefined as top-level value", () => {
        expect(cloneIfNecessary(undefined, { frozen: false })).toBe(undefined);
      });

      it("passes through undefined with default options", () => {
        expect(cloneIfNecessary(undefined)).toBe(undefined);
      });
    });

    // --------------------------------------------------------------------------
    // null prototype preservation
    // --------------------------------------------------------------------------

    describe(`null prototype preservation (${label} path)`, () => {
      beforeEach(() => setDataModelConfig(modernMode));

      it("preserves null prototype on objects", () => {
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
    // FabricPrimitive pass-through
    // --------------------------------------------------------------------------

    describe(`FabricPrimitive (${label} path)`, () => {
      beforeEach(() => setDataModelConfig(modernMode));

      it("passes through FabricEpochNsec unchanged", () => {
        const epoch = new FabricEpochNsec(1234567890n);
        Object.freeze(epoch);
        const result = cloneIfNecessary(epoch as unknown as FabricValue);
        expect(result).toBe(epoch); // identity -- special primitives are immutable
      });

      it("passes through FabricEpochNsec when frozen=false", () => {
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

    describe(`circular reference detection (${label} path)`, () => {
      beforeEach(() => setDataModelConfig(modernMode));

      it("throws on direct circular object reference", () => {
        const obj = {} as Record<string, unknown>;
        obj.self = obj;
        expect(() => cloneIfNecessary(obj as FabricValue)).toThrow(
          "Cannot deep-clone circular reference",
        );
      });

      it("throws on circular array reference", () => {
        const arr: unknown[] = [1, 2];
        arr.push(arr);
        expect(() => cloneIfNecessary(arr as FabricValue)).toThrow(
          "Cannot deep-clone circular reference",
        );
      });

      it("throws on indirect circular reference", () => {
        const a = {} as Record<string, unknown>;
        const b = { parent: a } as Record<string, unknown>;
        a.child = b;
        expect(() => cloneIfNecessary(a as FabricValue)).toThrow(
          "Cannot deep-clone circular reference",
        );
      });

      it("handles shared (diamond) references without throwing", () => {
        const shared = { x: 1 };
        const value = { a: shared, b: shared } as FabricValue;
        // Shared (non-circular) references should not throw.
        const result = cloneIfNecessary(value) as Record<string, unknown>;
        expect(result).toEqual({ a: { x: 1 }, b: { x: 1 } });
        expect(Object.isFrozen(result)).toBe(true);
      });
    });
  }

  // --------------------------------------------------------------------------
  // Config lifecycle
  // --------------------------------------------------------------------------

  describe("config lifecycle", () => {
    it("clone semantics are preserved across mode switches", () => {
      const value = { a: 1 } as FabricValue;

      setDataModelConfig(true);
      const modernResult = cloneIfNecessary(value);
      expect(modernResult).not.toBe(value);
      expect(Object.isFrozen(modernResult)).toBe(true);
      expect(modernResult).toEqual({ a: 1 });

      resetDataModelConfig();
      const legacyResult = cloneIfNecessary(value);
      expect(legacyResult).not.toBe(value);
      expect(Object.isFrozen(legacyResult)).toBe(true);
      expect(legacyResult).toEqual({ a: 1 });
    });
  });
});
