import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { StorableEpochDays, StorableEpochNsec } from "../storable-epoch.ts";
import { SpecialPrimitiveValue } from "../special-primitive-value.ts";
import { isStorableInstance } from "../storable-protocol.ts";
import {
  resetStorableValueConfig,
  setStorableValueConfig,
  shallowStorableFromNativeValue,
} from "../storable-value.ts";

describe("StorableEpochNsec", () => {
  it("wraps a bigint value", () => {
    const sn = new StorableEpochNsec(1234567890000000000n);
    expect(sn.value).toBe(1234567890000000000n);
  });

  it("wraps zero", () => {
    const sn = new StorableEpochNsec(0n);
    expect(sn.value).toBe(0n);
  });

  it("wraps negative values (pre-epoch)", () => {
    const sn = new StorableEpochNsec(-1000000000n);
    expect(sn.value).toBe(-1000000000n);
  });

  it("handles large future date (year 3000)", () => {
    const nsec = 32503680000000000000n;
    const sn = new StorableEpochNsec(nsec);
    expect(sn.value).toBe(nsec);
  });

  it("is instanceof StorableEpochNsec", () => {
    const sn = new StorableEpochNsec(42n);
    expect(sn instanceof StorableEpochNsec).toBe(true);
  });

  it("is instanceof SpecialPrimitiveValue", () => {
    expect(new StorableEpochNsec(0n) instanceof SpecialPrimitiveValue).toBe(
      true,
    );
  });

  it("instances are always frozen", () => {
    expect(Object.isFrozen(new StorableEpochNsec(42n))).toBe(true);
  });
});

describe("StorableEpochDays", () => {
  it("wraps a bigint value", () => {
    const sd = new StorableEpochDays(19723n);
    expect(sd.value).toBe(19723n);
  });

  it("wraps zero (epoch day)", () => {
    const sd = new StorableEpochDays(0n);
    expect(sd.value).toBe(0n);
  });

  it("wraps negative values (pre-epoch)", () => {
    const sd = new StorableEpochDays(-365n);
    expect(sd.value).toBe(-365n);
  });

  it("is instanceof StorableEpochDays", () => {
    const sd = new StorableEpochDays(100n);
    expect(sd instanceof StorableEpochDays).toBe(true);
  });

  it("is instanceof SpecialPrimitiveValue", () => {
    expect(new StorableEpochDays(0n) instanceof SpecialPrimitiveValue).toBe(
      true,
    );
  });

  it("instances are always frozen", () => {
    expect(Object.isFrozen(new StorableEpochDays(100n))).toBe(true);
  });
});

describe("StorableEpochNsec (protocol)", () => {
  it("is NOT a StorableInstance (no DECONSTRUCT)", () => {
    const sn = new StorableEpochNsec(0n);
    expect(isStorableInstance(sn)).toBe(false);
  });
});

describe("StorableEpochDays (protocol)", () => {
  it("is NOT a StorableInstance (no DECONSTRUCT)", () => {
    const sd = new StorableEpochDays(0n);
    expect(isStorableInstance(sd)).toBe(false);
  });
});

describe("SpecialPrimitiveValue (storable-value integration)", () => {
  it("passes through shallowStorableFromNativeValue unchanged even with freeze=false", () => {
    setStorableValueConfig({ richStorableValues: true });
    try {
      const nsec = new StorableEpochNsec(123n);
      const days = new StorableEpochDays(456n);
      // freeze=false should still return the same instance (not a copy).
      expect(shallowStorableFromNativeValue(nsec, false)).toBe(nsec);
      expect(shallowStorableFromNativeValue(days, false)).toBe(days);
    } finally {
      resetStorableValueConfig();
    }
  });
});
