import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { flowPrecisionSchemaForBuiltin } from "../src/cfc/flow-precision.ts";
import type { ListOpArgumentUsage } from "../src/builtins/list-op-argument-usage.ts";

// Regression guard for flow-precision claims vs op argument usage (audit, W0.6).
//
// PointwiseWriteDependency (map) and ElementLocalExpansion (filter/flatMap)
// assert that each output position derives only from the corresponding input
// element. That is false when the op reads the whole `array` or data-bearing
// `params` — a cross-key dependency. These element-local claims must be dropped
// in that case; the purely structural claims (PointwisePresencePreserved,
// StableRelativeOrder) stay.

const claimTypes = (schema: unknown): string[] => {
  const ifc = (schema as { ifc?: { flowPrecisionClaim?: { claims?: Array<{ type: string }> } } })
    .ifc;
  return (ifc?.flowPrecisionClaim?.claims ?? []).map((c) => c.type);
};

const usage = (over: Partial<ListOpArgumentUsage>): ListOpArgumentUsage => ({
  usesElement: true,
  usesIndex: false,
  usesArray: false,
  usesParams: false,
  ...over,
});

describe("flow-precision claims vs op argument usage", () => {
  it("keeps all map claims when the op is element-local", () => {
    const schema = flowPrecisionSchemaForBuiltin("map", undefined, usage({}));
    expect(claimTypes(schema).sort()).toEqual(
      ["PointwisePresencePreserved", "PointwiseWriteDependency"].sort(),
    );
  });

  it("drops PointwiseWriteDependency when a map op reads the array", () => {
    const schema = flowPrecisionSchemaForBuiltin(
      "map",
      undefined,
      usage({ usesArray: true }),
    );
    expect(claimTypes(schema)).toEqual(["PointwisePresencePreserved"]);
  });

  it("drops PointwiseWriteDependency when a map op reads params", () => {
    const schema = flowPrecisionSchemaForBuiltin(
      "map",
      undefined,
      usage({ usesParams: true }),
    );
    expect(claimTypes(schema)).toEqual(["PointwisePresencePreserved"]);
  });

  it("drops ElementLocalExpansion for filter/flatMap reading the array", () => {
    for (const builtin of ["filter", "flatMap"]) {
      const schema = flowPrecisionSchemaForBuiltin(
        builtin,
        undefined,
        usage({ usesArray: true }),
      );
      expect(claimTypes(schema)).toEqual(["StableRelativeOrder"]);
    }
  });

  it("keeps all filter/flatMap claims when element-local", () => {
    for (const builtin of ["filter", "flatMap"]) {
      const schema = flowPrecisionSchemaForBuiltin(builtin, undefined, usage({}));
      expect(claimTypes(schema).sort()).toEqual(
        ["ElementLocalExpansion", "StableRelativeOrder"].sort(),
      );
    }
  });

  it("keeps all claims when argument usage is unknown (backward compatible)", () => {
    const schema = flowPrecisionSchemaForBuiltin("map");
    expect(claimTypes(schema).sort()).toEqual(
      ["PointwisePresencePreserved", "PointwiseWriteDependency"].sort(),
    );
  });
});
