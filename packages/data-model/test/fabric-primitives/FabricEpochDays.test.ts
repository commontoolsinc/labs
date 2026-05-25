import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { FabricEpochDays } from "../../src/fabric-primitives/FabricEpochDays.ts";
import { FabricInstance, FabricPrimitive } from "../../src/interface.ts";
import {
  resetDataModelConfig,
  setDataModelConfig,
  shallowFabricFromNativeValue,
} from "../../src/fabric-value.ts";

describe("FabricEpochDays", () => {
  it("wraps a bigint value", () => {
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

  it("is instanceof FabricEpochDays", () => {
    const sd = new FabricEpochDays(100n);
    expect(sd instanceof FabricEpochDays).toBe(true);
  });

  it("is instanceof FabricPrimitive", () => {
    expect(new FabricEpochDays(0n) instanceof FabricPrimitive).toBe(
      true,
    );
  });

  it("instances are always frozen", () => {
    expect(Object.isFrozen(new FabricEpochDays(100n))).toBe(true);
  });

  describe("protocol", () => {
    it("is NOT a FabricInstance (no DECONSTRUCT)", () => {
      const sd = new FabricEpochDays(0n);
      expect(sd instanceof FabricInstance).toBe(false);
    });
  });

  describe("fabric-value integration", () => {
    it("passes through shallowFabricFromNativeValue unchanged even with freeze=false", () => {
      setDataModelConfig(true);
      try {
        const days = new FabricEpochDays(456n);
        // freeze=false should still return the same instance (not a copy).
        expect(shallowFabricFromNativeValue(days, false)).toBe(days);
      } finally {
        resetDataModelConfig();
      }
    });
  });
});
