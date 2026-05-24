import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { FabricEpochDays } from "../../src/fabric-primitives/FabricEpochDays.ts";
import { FabricEpochNsec } from "../../src/fabric-primitives/FabricEpochNsec.ts";
import {
  resetDataModelConfig,
  setDataModelConfig,
  shallowFabricFromNativeValue,
} from "../../src/fabric-value.ts";

describe("fabric-epoch", () => {
  it("passes through shallowFabricFromNativeValue unchanged even with freeze=false", () => {
    setDataModelConfig(true);
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
