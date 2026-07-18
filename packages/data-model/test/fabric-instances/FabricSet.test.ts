import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { FabricInstance, type FabricValue } from "@/interface.ts";
import {
  DEEP_FREEZE,
  IS_DEEP_FROZEN,
} from "@/fabric-instances/BaseFabricInstance.ts";
import { CODEC } from "@/codec-common/interface.ts";
import { CODEC_TYPE_TAGS } from "@/codec-common/codec-type-tags.ts";
import { EMPTY_RECONSTRUCTION_CONTEXT } from "@/codec-common/EmptyReconstructionContext.ts";
import { FabricSet } from "@/fabric-instances/FabricSet.ts";
import { FrozenSet } from "@/frozen-builtins.ts";
import { deepFreeze, isDeepFrozenFabricValue } from "@/deep-freeze.ts";
import { subFreeze, subIsDeepFrozen } from "./fixtures.ts";

describe("FabricSet", () => {
  // Pure type-identity / supertype check: cross-cutting carve-out per the
  // rule (doesn't fit a single member, isn't construction mechanics).
  it("implements `FabricInstance`", () => {
    const ss = new FabricSet(new Set());
    expect(ss instanceof FabricInstance).toBe(true);
  });

  describe("instance members", () => {
    describe("toNativeValue()", () => {
      it("returns a `FrozenSet` when `frozen` is `true`", () => {
        const set = new Set<FabricValue>([1, 2]);
        const ss = new FabricSet(set);
        const result = ss.toNativeValue(true);
        expect(result).toBeInstanceOf(FrozenSet);
        expect((result as FrozenSet<number>).has(1)).toBe(true);
      });

      it("returns the original `Set` when `frozen` is `false`", () => {
        const set = new Set<FabricValue>([1, 2]);
        const ss = new FabricSet(set);
        const result = ss.toNativeValue(false);
        expect(result).toBe(set); // same reference
        expect(result).toBeInstanceOf(Set);
        expect(result).not.toBeInstanceOf(FrozenSet);
      });

      it("returns the same `FrozenSet` if already frozen (`frozen=true`)", () => {
        const fs = new FrozenSet<FabricValue>([1, 2]);
        const ss = new FabricSet(fs);
        const result = ss.toNativeValue(true);
        expect(result).toBe(fs); // same reference
      });

      it("copies a `FrozenSet` to a mutable `Set` (`frozen=false`)", () => {
        const fs = new FrozenSet<FabricValue>([1, 2]);
        const ss = new FabricSet(fs);
        const result = ss.toNativeValue(false);
        expect(result).not.toBe(fs);
        expect(result).toBeInstanceOf(Set);
        expect(result).not.toBeInstanceOf(FrozenSet);
        expect(result.has(1 as FabricValue)).toBe(true);
      });
    });

    describe("`[DEEP_FREEZE]` / `[IS_DEEP_FROZEN]`", () => {
      it("via dispatch: `[DEEP_FREEZE]` throws not-yet-implemented", () => {
        const fs = new FabricSet(new FrozenSet<FabricValue>([1, 2]));
        expect(() => deepFreeze(fs)).toThrow("FabricSet: not yet implemented");
      });

      it("via dispatch: `[IS_DEEP_FROZEN]` throws not-yet-implemented (via type guard)", () => {
        const fs = new FabricSet(new FrozenSet<FabricValue>([1, 2]));
        Object.freeze(fs);
        expect(() => isDeepFrozenFabricValue(fs)).toThrow(
          "FabricSet: not yet implemented",
        );
      });

      it("via direct member invocation: `[DEEP_FREEZE]` throws not-yet-implemented", () => {
        const fs = new FabricSet(new FrozenSet<FabricValue>([1, 2]));
        expect(() => fs[DEEP_FREEZE](subFreeze)).toThrow(
          "FabricSet: not yet implemented",
        );
      });

      it("via direct member invocation: `[IS_DEEP_FROZEN]` throws not-yet-implemented", () => {
        const fs = new FabricSet(new FrozenSet<FabricValue>([1, 2]));
        Object.freeze(fs);
        expect(() => fs[IS_DEEP_FROZEN](subIsDeepFrozen)).toThrow(
          "FabricSet: not yet implemented",
        );
      });
    });
  });

  describe("static members", () => {
    // Nominal coverage: the codec exists and reports its wire tag and claims
    // its instances, but `encode()` / `decode()` are throwing stubs until
    // `Set` support is implemented.
    describe("[CODEC]", () => {
      const codec = FabricSet[CODEC];
      const expectedTag = CODEC_TYPE_TAGS.Set;
      const context = EMPTY_RECONSTRUCTION_CONTEXT;

      describe("recognizedTypeTag", () => {
        it("is the `Set` wire type tag", () => {
          expect(codec.recognizedTypeTag).toBe(expectedTag);
        });
      });

      describe("canEncode()", () => {
        it("claims a `FabricSet`, rejecting other values", () => {
          expect(codec.canEncode(new FabricSet(new Set()))).toBe(true);
          expect(codec.canEncode("not a set")).toBe(false);
        });
      });

      describe("encode()", () => {
        it("throws (stub)", () => {
          expect(() => codec.encode(new FabricSet(new Set()))).toThrow(
            "not yet implemented",
          );
        });
      });

      describe("decode()", () => {
        it("throws (stub)", () => {
          expect(() => codec.decode(expectedTag, null, context)).toThrow(
            "not yet implemented",
          );
        });
      });
    });
  });
});
