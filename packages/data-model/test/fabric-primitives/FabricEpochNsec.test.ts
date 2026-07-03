import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { FabricEpochNsec } from "@/fabric-primitives/FabricEpochNsec.ts";
import { FabricInstance, FabricPrimitive } from "@/interface.ts";
import { shallowFabricFromNativeValue } from "@/fabric-value.ts";
import { CODEC } from "@/codec-common/interface.ts";
import { CODEC_TYPE_TAGS } from "@/codec-common/codec-type-tags.ts";
import { EMPTY_RECONSTRUCTION_CONTEXT } from "@/codec-common/EmptyReconstructionContext.ts";

const expectEpochNsec = (value: unknown): FabricEpochNsec => {
  expect(value).toBeInstanceOf(FabricEpochNsec);
  if (!(value instanceof FabricEpochNsec)) {
    throw new Error("expected FabricEpochNsec");
  }
  return value;
};

describe("FabricEpochNsec", () => {
  // Pure type-identity / supertype checks: cross-cutting carve-out per the
  // rule (don't fit a single member, aren't construction mechanics).
  it("is an instance of `FabricPrimitive`", () => {
    expect(new FabricEpochNsec(0n) instanceof FabricPrimitive).toBe(
      true,
    );
  });

  it("is not a `FabricInstance` (it's a `FabricPrimitive`)", () => {
    const sn = new FabricEpochNsec(0n);
    expect(sn instanceof FabricInstance).toBe(false);
  });

  describe("constructor()", () => {
    it("produces an always-frozen instance", () => {
      expect(Object.isFrozen(new FabricEpochNsec(42n))).toBe(true);
    });
  });

  describe("instance members", () => {
    describe(".value", () => {
      it("wraps a `bigint` value", () => {
        const sn = new FabricEpochNsec(1234567890000000000n);
        expect(sn.value).toBe(1234567890000000000n);
      });

      it("wraps zero", () => {
        const sn = new FabricEpochNsec(0n);
        expect(sn.value).toBe(0n);
      });

      it("wraps negative values (pre-epoch)", () => {
        const sn = new FabricEpochNsec(-1000000000n);
        expect(sn.value).toBe(-1000000000n);
      });

      it("handles a large future date (year 3000)", () => {
        const nsec = 32503680000000000000n;
        const sn = new FabricEpochNsec(nsec);
        expect(sn.value).toBe(nsec);
      });
    });
  });

  describe("static members", () => {
    describe("[CODEC]", () => {
      const codec = FabricEpochNsec[CODEC];
      const expectedTag = CODEC_TYPE_TAGS.EpochNsec;
      const context = EMPTY_RECONSTRUCTION_CONTEXT;

      describe("recognizedTypeTag", () => {
        it("is the `EpochNsec` wire type tag", () => {
          expect(codec.recognizedTypeTag).toBe(expectedTag);
        });
      });

      describe("canEncode()", () => {
        it("claims a `FabricEpochNsec`, rejecting other values", () => {
          expect(codec.canEncode(new FabricEpochNsec(0n))).toBe(true);
          expect(codec.canEncode("not an epoch")).toBe(false);
        });
      });

      describe("encode()", () => {
        it("encodes to a flat base64 string (epoch zero)", () => {
          const sn = new FabricEpochNsec(0n);
          // Flat format: base64 string directly, not nested {"/BigInt@1": ...}.
          expect(codec.encode(sn)).toBe("AA");
        });
      });

      describe("decode()", () => {
        it("decodes a flat base64 string (epoch zero)", () => {
          const decoded = codec.decode(
            expectedTag,
            "AA",
            context,
          );
          const epochNsec = expectEpochNsec(decoded);
          expect(epochNsec.value).toBe(0n);
        });
      });

      describe("round trip encode-decode", () => {
        it("round-trips at top level (epoch zero)", () => {
          const sn = new FabricEpochNsec(0n);
          const decoded = codec.decode(
            expectedTag,
            codec.encode(sn),
            context,
          );
          const epochNsec = expectEpochNsec(decoded);
          expect(epochNsec.value).toBe(0n);
        });

        it("round-trips positive nanosecond timestamp", () => {
          // 2024-01-01T00:00:00Z = 1704067200 seconds = 1704067200000000000 nsec
          const nsec = 1704067200000000000n;
          const sn = new FabricEpochNsec(nsec);
          const decoded = codec.decode(
            expectedTag,
            codec.encode(sn),
            context,
          );
          const epochNsec = expectEpochNsec(decoded);
          expect(epochNsec.value).toBe(nsec);
        });

        it("round-trips negative nanosecond timestamp (pre-epoch)", () => {
          const nsec = -86400000000000n; // -1 day in nanoseconds
          const sn = new FabricEpochNsec(nsec);
          const decoded = codec.decode(
            expectedTag,
            codec.encode(sn),
            context,
          );
          const epochNsec = expectEpochNsec(decoded);
          expect(epochNsec.value).toBe(nsec);
        });

        it("round-trips large future date", () => {
          // Year 3000-ish
          const nsec = 32503680000000000000n;
          const sn = new FabricEpochNsec(nsec);
          const decoded = codec.decode(
            expectedTag,
            codec.encode(sn),
            context,
          );
          const epochNsec = expectEpochNsec(decoded);
          expect(epochNsec.value).toBe(nsec);
        });
      });
    });
  });

  // Exercises the free `shallowFabricFromNativeValue()` rather than a member
  // of the class, so it lives directly under the class `describe()`.
  describe("shallowFabricFromNativeValue() integration", () => {
    it("passes through unchanged even with `freeze=false`", () => {
      const nsec = new FabricEpochNsec(123n);
      // freeze=false should still return the same instance (not a copy).
      expect(shallowFabricFromNativeValue(nsec, false)).toBe(nsec);
    });
  });
});
