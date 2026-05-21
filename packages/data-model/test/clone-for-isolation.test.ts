import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  cloneForIsolation,
  resetDataModelConfig,
  setDataModelConfig,
} from "../fabric-value.ts";
import type { FabricValue } from "../fabric-value.ts";
import { deepFreeze, isDeepFrozen } from "../deep-freeze.ts";
import { FabricBytes } from "../fabric-bytes.ts";
import { FabricEpochNsec } from "../fabric-epoch.ts";
import { FabricError } from "../fabric-native-instances.ts";

// ============================================================================
// `cloneForIsolation` tests
// ============================================================================
//
// Parameterized across both legacy and modern data-model flag states to keep
// the contract durable under either flag setting.

describe("cloneForIsolation", () => {
  afterEach(() => {
    resetDataModelConfig();
  });

  for (const modernMode of [false, true]) {
    const label = modernMode ? "modern" : "legacy";

    describe(`(${label} path)`, () => {
      beforeEach(() => setDataModelConfig(modernMode));

      // ----------------------------------------------------------------------
      // Primitives and FabricPrimitive
      // ----------------------------------------------------------------------

      describe("primitives & FabricPrimitive", () => {
        it("returns JS primitives unchanged", () => {
          expect(cloneForIsolation(42 as FabricValue)).toBe(42);
          expect(cloneForIsolation("hello" as FabricValue)).toBe("hello");
          expect(cloneForIsolation(true as FabricValue)).toBe(true);
          expect(cloneForIsolation(null)).toBe(null);
          expect(cloneForIsolation(42n as FabricValue)).toBe(42n);
        });

        it("returns FabricPrimitive subclasses by identity", () => {
          const epoch = new FabricEpochNsec(123n);
          expect(cloneForIsolation(epoch as unknown as FabricValue))
            .toBe(epoch);
          const bytes = new FabricBytes(new Uint8Array([1, 2, 3]));
          expect(cloneForIsolation(bytes as unknown as FabricValue))
            .toBe(bytes);
        });
      });

      // ----------------------------------------------------------------------
      // Identity preservation for already-deep-frozen subtrees
      // ----------------------------------------------------------------------

      describe("deep-frozen identity preservation", () => {
        it("returns a fully-deep-frozen input by identity", () => {
          const value = deepFreeze({
            a: { x: 1 },
            b: [1, 2, 3],
          }) as FabricValue;
          expect(cloneForIsolation(value)).toBe(value);
        });

        it("preserves deep-frozen subtrees by identity within a mutable parent", () => {
          const frozenChild = deepFreeze({ kept: true });
          const frozenSibling = deepFreeze({ kept: "yes" });
          // Mutable parent containing two deep-frozen children.
          const value = {
            a: frozenChild,
            b: frozenSibling,
          } as FabricValue;

          const result = cloneForIsolation(value) as Record<string, unknown>;

          // The outer object is freshly allocated (input was mutable).
          expect(result).not.toBe(value);
          // Both children retain their identity.
          expect(result.a).toBe(frozenChild);
          expect(result.b).toBe(frozenSibling);
          // And `isDeepFrozen` still passes on them post-clone.
          expect(isDeepFrozen(result.a)).toBe(true);
          expect(isDeepFrozen(result.b)).toBe(true);
        });

        it("clones mutable subtrees while preserving frozen ones", () => {
          const frozenSibling = deepFreeze({ kept: true });
          const mutableSibling = { mutable: true };
          const value = {
            kept: frozenSibling,
            churn: mutableSibling,
          } as FabricValue;

          const result = cloneForIsolation(value) as Record<string, unknown>;

          expect(result).not.toBe(value);
          expect(result.kept).toBe(frozenSibling); // identity preserved
          expect(result.churn).not.toBe(mutableSibling); // fresh copy
          expect(result.churn).toEqual({ mutable: true });
        });
      });

      // ----------------------------------------------------------------------
      // Mutable input is deep-cloned
      // ----------------------------------------------------------------------

      describe("mutable input cloning", () => {
        it("deep-clones a mutable object", () => {
          const inner = { x: 1 };
          const value = { a: inner } as FabricValue;
          const result = cloneForIsolation(value) as Record<string, unknown>;

          expect(result).not.toBe(value);
          expect(result.a).not.toBe(inner);
          expect(result.a).toEqual({ x: 1 });
        });

        it("deep-clones a mutable array", () => {
          const value = [1, 2, [3, 4]] as FabricValue;
          const result = cloneForIsolation(value) as unknown[];

          expect(result).not.toBe(value);
          expect(result[2]).not.toBe((value as unknown[])[2]);
          expect(result).toEqual([1, 2, [3, 4]]);
        });

        it("preserves null prototypes on objects", () => {
          const value = Object.create(null) as Record<string, unknown>;
          value.a = 1;
          const result = cloneForIsolation(value as FabricValue) as Record<
            string,
            unknown
          >;
          expect(Object.getPrototypeOf(result)).toBe(null);
          expect(result.a).toBe(1);
        });

        it("preserves sparse array holes", () => {
          // deno-lint-ignore no-sparse-arrays
          const value = [1, , 3] as FabricValue;
          const result = cloneForIsolation(value) as unknown[];
          expect(result.length).toBe(3);
          expect(0 in result).toBe(true);
          expect(1 in result).toBe(false); // sparse hole preserved
          expect(2 in result).toBe(true);
        });

        it("handles shared (diamond) references in mutable input", () => {
          const shared = { x: 1 };
          const value = { a: shared, b: shared } as FabricValue;
          const result = cloneForIsolation(value) as Record<string, unknown>;
          // Diamond preserved: both branches point at the same clone.
          expect(result.a).toBe(result.b);
          expect(result.a).not.toBe(shared); // freshly cloned
        });

        it("throws on a direct cycle in mutable input", () => {
          // `cloneForIsolation` doesn't try to recreate cycles (no Fabric
          // value is allowed to contain one). The implementation's `seen`
          // map prevents infinite recursion, but the result has a
          // self-referential structure that mirrors the input -- which is
          // arguably wrong (the result should be isolated), but matches
          // `isolateTransactionValue`'s prior behavior. Document via test.
          const obj = {} as Record<string, unknown>;
          obj.self = obj;
          const result = cloneForIsolation(obj as FabricValue) as Record<
            string,
            unknown
          >;
          expect(result).not.toBe(obj);
          // The clone has its own self-reference (the `seen` map made it
          // point back at the new copy, not the original).
          expect(result.self).toBe(result);
        });
      });

      // ----------------------------------------------------------------------
      // FabricInstance handling
      // ----------------------------------------------------------------------

      describe("FabricInstance", () => {
        it("returns a deep-frozen FabricInstance by identity", () => {
          const err = new FabricError(new Error("test"));
          Object.freeze(err.error);
          deepFreeze(err);
          expect(cloneForIsolation(err as unknown as FabricValue))
            .toBe(err);
        });

        it("deep-clones a non-deep-frozen FabricInstance via .deepClone(false)", () => {
          // A FabricError whose wrapped Error is mutable (so not
          // deep-frozen). cloneForIsolation should rebuild rather than
          // share the reference -- the "punt" bug in the prior
          // `isolateTransactionValue` is the thing this PR's separation
          // makes explicit.
          const err = new FabricError(new Error("test"));
          // Not frozen at all -> isDeepFrozen returns false.
          const result = cloneForIsolation(err as unknown as FabricValue);
          expect(result).toBeInstanceOf(FabricError);
          expect(result).not.toBe(err);
          // FabricError.deepClone is a stop-gap that preserves string-
          // valued state (notably `.message`). Match the existing
          // contract.
          expect((result as unknown as FabricError).error.message).toBe(
            "test",
          );
        });

        it("deep-clones a FabricInstance inside an unfrozen parent", () => {
          const err = new FabricError(new Error("nested"));
          const value = { err } as FabricValue;
          const result = cloneForIsolation(value) as Record<string, unknown>;
          expect(result).not.toBe(value);
          // FabricInstance was deep-cloned (not punted).
          expect(result.err).not.toBe(err);
          expect(result.err).toBeInstanceOf(FabricError);
        });
      });

      // ----------------------------------------------------------------------
      // Type violation
      // ----------------------------------------------------------------------

      describe("type-violation throw", () => {
        it("throws on a non-FabricValue class instance", () => {
          // `Date` isn't part of FabricValue (in modern it'd be wrapped
          // in a FabricInstance subclass; in legacy too). A bare `Date`
          // landing here is a type-violation upstream and the function
          // surfaces it rather than silently sharing the reference.
          const value = { when: new Date() } as unknown as FabricValue;
          expect(() => cloneForIsolation(value))
            .toThrow("unexpected non-FabricValue");
        });

        it("throws on a Map (similar non-FabricValue)", () => {
          const value = { m: new Map() } as unknown as FabricValue;
          expect(() => cloneForIsolation(value))
            .toThrow("unexpected non-FabricValue");
        });
      });
    });
  }
});
