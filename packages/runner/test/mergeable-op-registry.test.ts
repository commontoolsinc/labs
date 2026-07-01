import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { MERGEABLE_OP_METHODS } from "@commonfabric/api";
import { patchOpDescriptors } from "@commonfabric/memory/v2/patch";
import { MERGEABLE_WIRE_OPS } from "../src/storage/mergeable-ops.ts";

// Ties the three places a mergeable patch op is registered together, so a new op
// added to one but not the others fails loudly here rather than silently
// degrading a mergeable write to a whole-value diff:
//
//   1. api MERGEABLE_OP_METHODS      — the author method + wire tag + classification
//   2. runner storage/mergeable-ops  — how the op folds intent and builds wire ops
//   3. memory v2/patch descriptors   — the wire op's shape, apply, and touched paths
describe("mergeable op registry consistency", () => {
  const catalogWireOps = MERGEABLE_OP_METHODS.map((op) => op.wireOp);

  it("every catalog method records a real wire patch op", () => {
    for (const { method, wireOp } of MERGEABLE_OP_METHODS) {
      expect(
        Object.hasOwn(patchOpDescriptors, wireOp),
        `Cell.${method} records "${wireOp}", which is not a registered PatchOp ` +
          `(add a descriptor in memory/v2/patch.ts)`,
      ).toBe(true);
    }
  });

  it("the catalog and the runner registry cover the same wire ops", () => {
    expect([...catalogWireOps].sort()).toEqual([...MERGEABLE_WIRE_OPS].sort());
  });

  it("maps each method to a distinct wire op", () => {
    const methods = MERGEABLE_OP_METHODS.map((op) => op.method);
    expect(new Set(methods).size).toBe(methods.length);
    expect(new Set(catalogWireOps).size).toBe(catalogWireOps.length);
  });
});
