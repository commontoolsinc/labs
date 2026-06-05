import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { FabricEpochDays } from "@/fabric-primitives/FabricEpochDays.ts";
import { FabricInstance, FabricPrimitive } from "@/interface.ts";
import { shallowFabricFromNativeValue } from "@/fabric-value.ts";

describe("FabricEpochDays", () => {
  // Pure type-identity / supertype checks: cross-cutting carve-out per the
  // rule (don't fit a single member, aren't construction mechanics).
  it("is an instance of `FabricPrimitive`", () => {
    expect(new FabricEpochDays(0n) instanceof FabricPrimitive).toBe(
      true,
    );
  });

  it("is not a `FabricInstance` (no [DECONSTRUCT])", () => {
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
