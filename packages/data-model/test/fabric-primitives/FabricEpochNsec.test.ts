import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { FabricEpochNsec } from "../../src/fabric-primitives/FabricEpochNsec.ts";
import { FabricInstance, FabricPrimitive } from "../../src/interface.ts";
import {
  resetDataModelConfig,
  setDataModelConfig,
  shallowFabricFromNativeValue,
} from "../../src/fabric-value.ts";

describe("FabricEpochNsec", () => {
  // Pure type-identity / supertype checks: cross-cutting carve-out per the
  // rule (don't fit a single member, aren't construction mechanics).
  it("is an instance of `FabricEpochNsec`", () => {
    const sn = new FabricEpochNsec(42n);
    expect(sn instanceof FabricEpochNsec).toBe(true);
  });

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
      it("wraps a bigint value", () => {
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

  // Exercises the free `shallowFabricFromNativeValue()` rather than a member
  // of the class, so it lives directly under the class `describe()`.
  describe("shallowFabricFromNativeValue() integration", () => {
    it("passes through unchanged even with freeze=false", () => {
      setDataModelConfig(true);
      try {
        const nsec = new FabricEpochNsec(123n);
        // freeze=false should still return the same instance (not a copy).
        expect(shallowFabricFromNativeValue(nsec, false)).toBe(nsec);
      } finally {
        resetDataModelConfig();
      }
    });
  });
});
