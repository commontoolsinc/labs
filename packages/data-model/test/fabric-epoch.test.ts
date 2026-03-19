import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { FabricEpochDays, FabricEpochNsec } from "../fabric-epoch.ts";
import { SpecialPrimitiveValue } from "../special-primitive-value.ts";
import { isFabricInstance } from "../fabric-protocol.ts";
import {
  resetDataModelConfig,
  setDataModelConfig,
  shallowFabricFromNativeValue,
} from "../fabric-value.ts";

describe("FabricEpochNsec", () => {
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

  it("handles large future date (year 3000)", () => {
    const nsec = 32503680000000000000n;
    const sn = new FabricEpochNsec(nsec);
    expect(sn.value).toBe(nsec);
  });

  it("is instanceof FabricEpochNsec", () => {
    const sn = new FabricEpochNsec(42n);
    expect(sn instanceof FabricEpochNsec).toBe(true);
  });

  it("is instanceof SpecialPrimitiveValue", () => {
    expect(new FabricEpochNsec(0n) instanceof SpecialPrimitiveValue).toBe(
      true,
    );
  });

  it("instances are always frozen", () => {
    expect(Object.isFrozen(new FabricEpochNsec(42n))).toBe(true);
  });
});

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

  it("is instanceof SpecialPrimitiveValue", () => {
    expect(new FabricEpochDays(0n) instanceof SpecialPrimitiveValue).toBe(
      true,
    );
  });

  it("instances are always frozen", () => {
    expect(Object.isFrozen(new FabricEpochDays(100n))).toBe(true);
  });
});

describe("FabricEpochNsec (protocol)", () => {
  it("is NOT a FabricInstance (no DECONSTRUCT)", () => {
    const sn = new FabricEpochNsec(0n);
    expect(isFabricInstance(sn)).toBe(false);
  });
});

describe("FabricEpochDays (protocol)", () => {
  it("is NOT a FabricInstance (no DECONSTRUCT)", () => {
    const sd = new FabricEpochDays(0n);
    expect(isFabricInstance(sd)).toBe(false);
  });
});

describe("SpecialPrimitiveValue (fabric-value integration)", () => {
  it("passes through shallowFabricFromNativeValue unchanged even with freeze=false", () => {
    setDataModelConfig({ modernDataModel: true });
    try {
      const nsec = new FabricEpochNsec(123n);
      const days = new FabricEpochDays(456n);
      // freeze=false should still return the same instance (not a copy).
      expect(shallowFabricFromNativeValue(nsec, false)).toBe(nsec);
      expect(shallowFabricFromNativeValue(days, false)).toBe(days);
    } finally {
      resetDataModelConfig();
    }
  });
});
