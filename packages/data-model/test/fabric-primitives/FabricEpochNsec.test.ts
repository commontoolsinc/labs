import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { FabricEpochNsec } from "@/fabric-primitives/FabricEpochNsec.ts";
import { FabricInstance, FabricPrimitive } from "@/interface.ts";
import type { FabricValue } from "@/interface.ts";
import { shallowFabricFromNativeValue } from "@/fabric-value.ts";
import { CODEC } from "@/wire-common/interface.ts";
import { WIRE_TYPE_TAGS } from "@/wire-common/wire-type-tags.ts";
import { EMPTY_RECONSTRUCTION_CONTEXT } from "@/wire-common/EmptyReconstructionContext.ts";

describe("FabricEpochNsec", () => {
  // Pure type-identity / supertype checks: cross-cutting carve-out per the
  // rule (don't fit a single member, aren't construction mechanics).
  it("is an instance of `FabricPrimitive`", () => {
    expect(new FabricEpochNsec(0n) instanceof FabricPrimitive).toBe(
      true,
    );
  });

  it("is not a `FabricInstance` (no [DECONSTRUCT])", () => {
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
      const context = EMPTY_RECONSTRUCTION_CONTEXT;

      it("has the `EpochNsec` wire type tag", () => {
        expect(codec.wireTypeTag).toBe(WIRE_TYPE_TAGS.EpochNsec);
      });

      it("encodes to a flat base64 string (epoch zero)", () => {
        const sn = new FabricEpochNsec(0n);
        // Flat format: base64 string directly, not nested {"/BigInt@1": ...}.
        expect(codec.encode(sn as FabricValue)).toBe("AA");
      });

      it("round-trips at top level (epoch zero)", () => {
        const sn = new FabricEpochNsec(0n);
        const decoded = codec.decode(
          codec.wireTypeTag,
          codec.encode(sn as FabricValue),
          context,
        ) as unknown as FabricEpochNsec;
        expect(decoded).toBeInstanceOf(FabricEpochNsec);
        expect(decoded.value).toBe(0n);
      });

      it("round-trips positive nanosecond timestamp", () => {
        // 2024-01-01T00:00:00Z = 1704067200 seconds = 1704067200000000000 nsec
        const nsec = 1704067200000000000n;
        const sn = new FabricEpochNsec(nsec);
        const decoded = codec.decode(
          codec.wireTypeTag,
          codec.encode(sn as FabricValue),
          context,
        ) as unknown as FabricEpochNsec;
        expect(decoded).toBeInstanceOf(FabricEpochNsec);
        expect(decoded.value).toBe(nsec);
      });

      it("round-trips negative nanosecond timestamp (pre-epoch)", () => {
        const nsec = -86400000000000n; // -1 day in nanoseconds
        const sn = new FabricEpochNsec(nsec);
        const decoded = codec.decode(
          codec.wireTypeTag,
          codec.encode(sn as FabricValue),
          context,
        ) as unknown as FabricEpochNsec;
        expect(decoded).toBeInstanceOf(FabricEpochNsec);
        expect(decoded.value).toBe(nsec);
      });

      it("round-trips large future date", () => {
        // Year 3000-ish
        const nsec = 32503680000000000000n;
        const sn = new FabricEpochNsec(nsec);
        const decoded = codec.decode(
          codec.wireTypeTag,
          codec.encode(sn as FabricValue),
          context,
        ) as unknown as FabricEpochNsec;
        expect(decoded.value).toBe(nsec);
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
