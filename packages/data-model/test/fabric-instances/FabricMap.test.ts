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
import { FabricMap } from "@/fabric-instances/FabricMap.ts";
import { FabricNativeWrapper } from "@/fabric-instances/FabricNativeWrapper.ts";
import { FrozenMap } from "@/frozen-builtins.ts";
import { deepFreeze, isDeepFrozenFabricValue } from "@/deep-freeze.ts";
import { subFreeze, subIsDeepFrozen } from "./fixtures.ts";

describe("FabricMap", () => {
  // Pure type-identity / supertype checks: cross-cutting carve-out per the
  // rule (they don't fit a single member, aren't construction mechanics).
  it("implements `FabricInstance`", () => {
    const sm = new FabricMap(new Map());
    expect(sm instanceof FabricInstance).toBe(true);
  });

  it("is an instance of `FabricNativeWrapper`", () => {
    const sm = new FabricMap(new Map());
    expect(sm instanceof FabricNativeWrapper).toBe(true);
  });

  describe("instance members", () => {
    describe("toNativeValue()", () => {
      it("returns a `FrozenMap` when `frozen` is `true`", () => {
        const map = new Map<FabricValue, FabricValue>([["a", 1]]);
        const sm = new FabricMap(map);
        const result = sm.toNativeValue(true);
        expect(result).toBeInstanceOf(FrozenMap);
        expect((result as FrozenMap<string, number>).get("a")).toBe(1);
      });

      it("returns the original `Map` when `frozen` is `false`", () => {
        const map = new Map<FabricValue, FabricValue>([["a", 1]]);
        const sm = new FabricMap(map);
        const result = sm.toNativeValue(false);
        expect(result).toBe(map); // same reference
        expect(result).toBeInstanceOf(Map);
        expect(result).not.toBeInstanceOf(FrozenMap);
      });

      it("returns the same `FrozenMap` if already frozen (`frozen=true`)", () => {
        const fm = new FrozenMap<FabricValue, FabricValue>([["a", 1]]);
        const sm = new FabricMap(fm);
        const result = sm.toNativeValue(true);
        expect(result).toBe(fm); // same reference
      });

      it("copies a `FrozenMap` to a mutable `Map` (`frozen=false`)", () => {
        const fm = new FrozenMap<FabricValue, FabricValue>([["a", 1]]);
        const sm = new FabricMap(fm);
        const result = sm.toNativeValue(false);
        expect(result).not.toBe(fm);
        expect(result).toBeInstanceOf(Map);
        expect(result).not.toBeInstanceOf(FrozenMap);
        expect(result.get("a" as FabricValue)).toBe(1);
      });
    });

    // FabricMap deliberately keeps throwing stubs for the protocol methods
    // (per Dan's PR #3612 review: not yet used, reworked separately).
    describe("`[DEEP_FREEZE]` / `[IS_DEEP_FROZEN]`", () => {
      it("via dispatch: `[DEEP_FREEZE]` throws not-yet-implemented", () => {
        const fm = new FabricMap(
          new FrozenMap<FabricValue, FabricValue>([["a", 1]]),
        );
        expect(() => deepFreeze(fm)).toThrow("FabricMap: not yet implemented");
      });

      it("via dispatch: `[IS_DEEP_FROZEN]` throws not-yet-implemented (via type guard)", () => {
        const fm = new FabricMap(
          new FrozenMap<FabricValue, FabricValue>([["a", 1]]),
        );
        Object.freeze(fm);
        expect(() => isDeepFrozenFabricValue(fm)).toThrow(
          "FabricMap: not yet implemented",
        );
      });

      it("via direct member invocation: `[DEEP_FREEZE]` throws not-yet-implemented", () => {
        const fm = new FabricMap(
          new FrozenMap<FabricValue, FabricValue>([["a", 1]]),
        );
        expect(() => fm[DEEP_FREEZE](subFreeze)).toThrow(
          "FabricMap: not yet implemented",
        );
      });

      it("via direct member invocation: `[IS_DEEP_FROZEN]` throws not-yet-implemented", () => {
        const fm = new FabricMap(
          new FrozenMap<FabricValue, FabricValue>([["a", 1]]),
        );
        Object.freeze(fm);
        expect(() => fm[IS_DEEP_FROZEN](subIsDeepFrozen)).toThrow(
          "FabricMap: not yet implemented",
        );
      });
    });
  });

  describe("static members", () => {
    // Nominal coverage: the codec exists and reports its wire tag and claims
    // its instances, but `encode()` / `decode()` are throwing stubs until
    // `Map` support is implemented.
    describe("[CODEC]", () => {
      const codec = FabricMap[CODEC];
      const expectedTag = CODEC_TYPE_TAGS.Map;
      const context = EMPTY_RECONSTRUCTION_CONTEXT;

      describe("recognizedTypeTag", () => {
        it("is the `Map` wire type tag", () => {
          expect(codec.recognizedTypeTag).toBe(expectedTag);
        });
      });

      describe("canEncode()", () => {
        it("claims a `FabricMap`, rejecting other values", () => {
          expect(codec.canEncode(new FabricMap(new Map()))).toBe(true);
          expect(codec.canEncode("not a map")).toBe(false);
        });
      });

      describe("encode()", () => {
        it("throws (stub)", () => {
          expect(() => codec.encode(new FabricMap(new Map()))).toThrow(
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
