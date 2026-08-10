import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { createBaseJsonRegistry } from "@/codec-json/createBaseJsonRegistry.ts";
import { SELF_REP } from "@/codec-common/CodecRegistry.ts";
import { FabricError } from "@/fabric-instances/FabricError.ts";

describe("createBaseJsonRegistry", () => {
  it("returns a frozen registry", () => {
    expect(Object.isFrozen(createBaseJsonRegistry())).toBe(true);
  });

  it("returns a registry that refuses further registration", () => {
    expect(() => createBaseJsonRegistry().registerSelfRep("string"))
      .toThrow("Cannot modify frozen `CodecRegistry`");
  });

  it("returns a fresh registry on each call", () => {
    expect(createBaseJsonRegistry()).not.toBe(createBaseJsonRegistry());
  });

  it("registers the four types JSON cannot carry", () => {
    const registry = createBaseJsonRegistry();

    expect(registry.codecFromValue(1n)).toBeDefined();
    expect(registry.codecFromValue(NaN)).toBeDefined();
    expect(registry.codecFromValue(Symbol.for("florp"))).toBeDefined();
    expect(registry.codecFromValue(undefined)).toBeDefined();
  });

  it("reports the JSON scalars as self-representing", () => {
    const registry = createBaseJsonRegistry();

    expect(registry.codecFromValue(null)).toBe(SELF_REP);
    expect(registry.codecFromValue(true)).toBe(SELF_REP);
    expect(registry.codecFromValue(1)).toBe(SELF_REP);
    expect(registry.codecFromValue("florp")).toBe(SELF_REP);
  });

  it("registers no fabric class", () => {
    const registry = createBaseJsonRegistry();
    const value = FabricError.fromNativeError(new Error("boom"));

    expect(registry.codecFromValue(value)).toBe(undefined);
  });
});
