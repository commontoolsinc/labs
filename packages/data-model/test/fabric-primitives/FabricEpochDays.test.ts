import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { FabricEpochDays } from "@/fabric-primitives/FabricEpochDays.ts";
import { FabricInstance, FabricPrimitive } from "@/interface.ts";
import { shallowFabricFromNativeValue } from "@/fabric-value.ts";
import { CODEC } from "@/codec-common/interface.ts";
import { CODEC_TYPE_TAGS } from "@/codec-common/codec-type-tags.ts";
import { EMPTY_RECONSTRUCTION_CONTEXT } from "@/codec-common/EmptyReconstructionContext.ts";

const expectEpochDays = (value: unknown): FabricEpochDays => {
  expect(value).toBeInstanceOf(FabricEpochDays);
  if (!(value instanceof FabricEpochDays)) {
    throw new Error("expected FabricEpochDays");
  }
  return value;
};

describe("FabricEpochDays", () => {
  // Pure type-identity / supertype checks: cross-cutting carve-out per the
  // rule (don't fit a single member, aren't construction mechanics).
  it("is an instance of `FabricPrimitive`", () => {
    expect(new FabricEpochDays(0n) instanceof FabricPrimitive).toBe(
      true,
    );
  });

  it("is not a `FabricInstance` (it's a `FabricPrimitive`)", () => {
    const sd = new FabricEpochDays(0n);
    expect(sd instanceof FabricInstance).toBe(false);
  });

  describe("constructor()", () => {
    it("produces an always-frozen instance", () => {
      expect(Object.isFrozen(new FabricEpochDays(100n))).toBe(true);
    });
  });

  describe("instance members", () => {
    describe(".value", () => {
      it("wraps a `bigint` value", () => {
        const sd = new FabricEpochDays(19723n);
        expect(sd.value).toBe(19723n);
      });

      it("wraps zero (epoch day)", () => {
        const sd = new FabricEpochDays(0n);
        expect(sd.value).toBe(0n);
      });

      it("wraps negative values (pre-epoch)", () => {
        const sd = new FabricEpochDays(-365n);
        expect(sd.value).toBe(-365n);
      });
    });
  });

  describe("static members", () => {
    describe("[CODEC]", () => {
      const codec = FabricEpochDays[CODEC];
      const expectedTag = CODEC_TYPE_TAGS.EpochDays;
      const context = EMPTY_RECONSTRUCTION_CONTEXT;

      describe("recognizedTypeTag", () => {
        it("is the `EpochDays` wire type tag", () => {
          expect(codec.recognizedTypeTag).toBe(expectedTag);
        });
      });

      describe("canEncode()", () => {
        it("claims a `FabricEpochDays`, rejecting other values", () => {
          expect(codec.canEncode(new FabricEpochDays(0n))).toBe(true);
          expect(codec.canEncode("not an epoch")).toBe(false);
        });
      });

      describe("encode()", () => {
        it("encodes to a flat base64 string (epoch zero)", () => {
          const sd = new FabricEpochDays(0n);
          // Flat format: base64 string directly, not nested {"/BigInt@1": ...}.
          expect(codec.encode(sd)).toBe("AA");
        });
      });

      describe("decode()", () => {
        it("decodes a flat base64 string (epoch zero)", () => {
          const decoded = codec.decode(
            expectedTag,
            "AA",
            context,
          );
          const epochDays = expectEpochDays(decoded);
          expect(epochDays.value).toBe(0n);
        });
      });

      describe("round trip encode-decode", () => {
        it("round-trips at top level (epoch zero)", () => {
          const sd = new FabricEpochDays(0n);
          const decoded = codec.decode(
            expectedTag,
            codec.encode(sd),
            context,
          );
          const epochDays = expectEpochDays(decoded);
          expect(epochDays.value).toBe(0n);
        });

        it("round-trips positive day count", () => {
          const days = 19723n; // ~2024-01-01
          const sd = new FabricEpochDays(days);
          const decoded = codec.decode(
            expectedTag,
            codec.encode(sd),
            context,
          );
          const epochDays = expectEpochDays(decoded);
          expect(epochDays.value).toBe(days);
        });

        it("round-trips negative day count (pre-epoch)", () => {
          const days = -365n;
          const sd = new FabricEpochDays(days);
          const decoded = codec.decode(
            expectedTag,
            codec.encode(sd),
            context,
          );
          const epochDays = expectEpochDays(decoded);
          expect(epochDays.value).toBe(days);
        });
      });
    });
  });

  // Exercises the free `shallowFabricFromNativeValue()` rather than a member
  // of the class, so it lives directly under the class `describe()`.
  describe("shallowFabricFromNativeValue() integration", () => {
    it("passes through unchanged even with `freeze=false`", () => {
      const days = new FabricEpochDays(456n);
      // freeze=false should still return the same instance (not a copy).
      expect(shallowFabricFromNativeValue(days, false)).toBe(days);
    });
  });
});
