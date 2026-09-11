import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { FabricMap } from "@/fabric-instances/FabricMap.ts";
import { type DispatchingVisitorResult, NopValueVisitor } from "@/value-visit";
import { VisitInProgress } from "@/value-visit/VisitInProgress.ts";

describe("NopValueVisitor", () => {
  it("returns `undefined` from every visitor method, and `false` from `isDomainExtra()`", () => {
    const vis = new NopValueVisitor<unknown, unknown>();
    const instance = new FabricMap(new Map());

    expect(vis.isDomainExtra(new Date(0))).toBe(false);
    expect(vis.visitCycle(1, 0, 1)).toBeUndefined();
    expect(vis.visitFabricArray([])).toBeUndefined();
    expect(vis.visitFabricContainer([])).toBeUndefined();
    expect(vis.visitFabricInstance(instance)).toBeUndefined();
    expect(vis.visitFabricPlainObject({})).toBeUndefined();
    expect(vis.visitNonFabricValue(new Date(0))).toBeUndefined();
    expect(vis.visitPrimitive(1, "number")).toBeUndefined();
    expect(vis.visitValue(1)).toBeUndefined();
    expect(vis.visitedArrayElement([1], 0, 1)).toBeUndefined();
    expect(vis.visitedArrayGap([], 0, 1)).toBeUndefined();
    expect(vis.visitedFabricPlainObject({}, "k", 1)).toBeUndefined();
  });

  it("completes a visit of a nested value without descending", () => {
    class Counting extends NopValueVisitor<never, number> {
      calls = 0;
      override visitValue(): DispatchingVisitorResult<never, number> {
        this.calls++;
        return undefined;
      }
    }

    const vis = new Counting();

    expect(new VisitInProgress(vis).visit({ a: [1, 2] }, false))
      .toBeUndefined();
    expect(vis.calls).toBe(1);
  });
});
