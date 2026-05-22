import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  cloneForIsolation,
  fabricFromNativeValue,
  resetDataModelConfig,
  setDataModelConfig,
} from "../fabric-value.ts";
import type { FabricValue } from "../fabric-value.ts";
import { deepFreeze, isDeepFrozen } from "../deep-freeze.ts";
import { FabricBytes } from "../FabricBytes.ts";
import { FabricEpochNsec } from "../fabric-epoch.ts";
import { FabricError } from "../fabric-native-instances.ts";

// ============================================================================
// cloneForIsolation
// ============================================================================
//
// Contract: produce a deep clone isolated from later source mutation, while
// preserving the identity of already-deep-frozen subtrees by reference. Throws
// on any non-`FabricValue` (e.g. a raw `Date`/`Map`/`Error`). Parameterized
// across both flag states (clone semantics are flag-independent).

describe("cloneForIsolation", () => {
  afterEach(() => {
    resetDataModelConfig();
  });

  for (const modernMode of [false, true]) {
    const label = modernMode ? "modern" : "legacy";

    describe(`primitives & special primitives (${label})`, () => {
      it("returns primitives as-is", () => {
        setDataModelConfig(modernMode);
        expect(cloneForIsolation(42 as FabricValue)).toBe(42);
        expect(cloneForIsolation("hi" as FabricValue)).toBe("hi");
        expect(cloneForIsolation(null as FabricValue)).toBe(null);
        expect(cloneForIsolation(undefined as FabricValue)).toBe(undefined);
        expect(cloneForIsolation(true as FabricValue)).toBe(true);
      });

      it("returns FabricPrimitive instances by identity (immutable)", () => {
        setDataModelConfig(modernMode);
        const bytes = new FabricBytes(new Uint8Array([1, 2, 3]));
        const epoch = new FabricEpochNsec(123n);
        expect(cloneForIsolation(bytes as FabricValue)).toBe(bytes);
        expect(cloneForIsolation(epoch as FabricValue)).toBe(epoch);
      });
    });

    describe(`deep-frozen identity preservation (${label})`, () => {
      it("returns a fully deep-frozen input by identity", () => {
        setDataModelConfig(modernMode);
        const frozen = deepFreeze({ a: 1, b: { c: 2 } } as FabricValue);
        expect(cloneForIsolation(frozen)).toBe(frozen);
      });

      it("preserves frozen subtrees by identity within a mutable parent", () => {
        setDataModelConfig(modernMode);
        const frozenChild = deepFreeze({ c: 2 } as FabricValue);
        const parent = { a: 1, child: frozenChild } as FabricValue;
        const result = cloneForIsolation(parent) as Record<string, unknown>;
        expect(result).not.toBe(parent); // parent was mutable -> cloned
        expect(result.child).toBe(frozenChild); // frozen subtree shared
        expect(result).toEqual({ a: 1, child: { c: 2 } });
      });
    });

    describe(`mutable input cloning (${label})`, () => {
      it("deep-clones a mutable object (not same, but equal)", () => {
        setDataModelConfig(modernMode);
        const src = { a: 1, b: { c: 2 } } as FabricValue;
        const result = cloneForIsolation(src) as Record<string, unknown>;
        expect(result).not.toBe(src);
        expect(result.b).not.toBe((src as Record<string, unknown>).b);
        expect(result).toEqual({ a: 1, b: { c: 2 } });
        // Mutating the source must not affect the isolated clone.
        (src as Record<string, unknown>).a = 99;
        expect(result.a).toBe(1);
      });

      it("result is mutable along non-frozen paths", () => {
        setDataModelConfig(modernMode);
        const result = cloneForIsolation(
          { a: [1, 2] } as FabricValue,
        ) as Record<string, unknown>;
        expect(Object.isFrozen(result)).toBe(false);
        expect(isDeepFrozen(result as FabricValue)).toBe(false);
      });

      it("deep-clones arrays and preserves sparse holes", () => {
        setDataModelConfig(modernMode);
        // deno-lint-ignore no-sparse-arrays
        const src = [1, , 3] as unknown as FabricValue;
        const result = cloneForIsolation(src) as unknown[];
        expect(result).not.toBe(src);
        expect(result.length).toBe(3);
        expect(0 in result).toBe(true);
        expect(1 in result).toBe(false);
        expect(2 in result).toBe(true);
      });

      it("preserves null-prototype objects", () => {
        setDataModelConfig(modernMode);
        const src = Object.assign(Object.create(null), { x: 1 }) as FabricValue;
        const result = cloneForIsolation(src);
        expect(Object.getPrototypeOf(result)).toBe(null);
        expect(result).toEqual(Object.assign(Object.create(null), { x: 1 }));
      });

      it("handles diamond references by preserving sharing", () => {
        setDataModelConfig(modernMode);
        const shared = { s: 1 };
        const src = { a: shared, b: shared } as unknown as FabricValue;
        const result = cloneForIsolation(src) as Record<string, unknown>;
        expect(result.a).toBe(result.b); // sharing preserved
        expect(result.a).not.toBe(shared); // but cloned
      });

      it("terminates on direct cycles", () => {
        setDataModelConfig(modernMode);
        const src: Record<string, unknown> = { a: 1 };
        src.self = src;
        const result = cloneForIsolation(src as FabricValue) as Record<
          string,
          unknown
        >;
        expect(result).not.toBe(src);
        expect(result.self).toBe(result); // cycle re-pointed to the clone
        expect(result.a).toBe(1);
      });
    });

    describe(`FabricInstance handling (${label})`, () => {
      it("returns a deep-frozen FabricError by identity", () => {
        setDataModelConfig(modernMode);
        const fe = FabricError.fromNativeError(new Error("boom"));
        Object.freeze(fe);
        expect(isDeepFrozen(fe)).toBe(true);
        expect(cloneForIsolation(fe as unknown as FabricValue)).toBe(fe);
      });

      it("deep-clones a mutable FabricError", () => {
        setDataModelConfig(modernMode);
        const fe = FabricError.fromNativeError(
          new Error("boom", { cause: { mutable: true } }),
        );
        Object.freeze(fe); // wrapper frozen, cause mutable -> not deep-frozen
        expect(isDeepFrozen(fe)).toBe(false);
        const result = cloneForIsolation(fe as unknown as FabricValue);
        expect(result).toBeInstanceOf(FabricError);
        expect(result).not.toBe(fe);
        expect((result as unknown as FabricError).message).toBe("boom");
      });

      it("preserves a nested deep-frozen FabricError by identity", () => {
        setDataModelConfig(modernMode);
        const fe = FabricError.fromNativeError(new Error("nested"));
        Object.freeze(fe);
        const parent = { err: fe, x: 1 } as unknown as FabricValue;
        const result = cloneForIsolation(parent) as Record<string, unknown>;
        expect(result).not.toBe(parent);
        expect(result.err).toBe(fe);
      });
    });

    describe(`type-violation throws (${label})`, () => {
      it("throws on a raw Date", () => {
        setDataModelConfig(modernMode);
        expect(() => cloneForIsolation(new Date() as unknown as FabricValue))
          .toThrow(/Cannot clone for isolation/);
      });

      it("throws on a raw Map", () => {
        setDataModelConfig(modernMode);
        expect(() => cloneForIsolation(new Map() as unknown as FabricValue))
          .toThrow(/Cannot clone for isolation/);
      });

      it("throws on a raw Error nested in a plain object", () => {
        setDataModelConfig(modernMode);
        const src = { err: new Error("raw") } as unknown as FabricValue;
        expect(() => cloneForIsolation(src)).toThrow(
          /Cannot clone for isolation/,
        );
      });
    });

    describe(`interaction with proper conversion (${label})`, () => {
      it("isolates a converted Error tree without throwing", () => {
        setDataModelConfig(modernMode);
        // `fabricFromNativeValue` produces a proper value (in modern mode a
        // FabricError whose cause is itself a FabricValue; in legacy mode an
        // `@Error` plain object), so isolation must not choke on it.
        const converted = fabricFromNativeValue(
          new Error("outer", { cause: new Error("inner") }),
          false,
        );
        const result = cloneForIsolation(converted);
        if (modernMode) {
          expect(result).toBeInstanceOf(FabricError);
        } else {
          // Legacy: `@Error` plain-object wrapper, deep-cloned for isolation.
          expect(result).toHaveProperty("@Error");
        }
      });
    });
  }
});
