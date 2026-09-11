import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { FabricMap } from "@/fabric-instances/FabricMap.ts";
import {
  ContainerIteratingValueVisitor,
  type DispatchingVisitorResult,
  DO_RECURSE_KEYS_VALUES,
  DO_RECURSE_VALUES,
  DO_VISIT_SUBTYPE,
  type LeafVisitorResult,
} from "@/value-visit";

describe("ContainerIteratingValueVisitor", () => {
  class Iterating extends ContainerIteratingValueVisitor<never, never> {
    override isDomainExtra(_value: unknown): _value is never {
      return false;
    }
    override visitCycle(): LeafVisitorResult<never, never> {
      return undefined;
    }
    override visitNonFabricValue(): LeafVisitorResult<never, never> {
      return undefined;
    }
    override visitPrimitive(): LeafVisitorResult<never, never> {
      return undefined;
    }
    override visitValue(): DispatchingVisitorResult<never, never> {
      return undefined;
    }
  }

  describe("instance members", () => {
    describe("visitFabricContainer()", () => {
      it("returns `DO_VISIT_SUBTYPE`", () => {
        expect(new Iterating().visitFabricContainer([])).toBe(DO_VISIT_SUBTYPE);
      });
    });

    describe("visitFabricArray()", () => {
      it("returns `DO_RECURSE_VALUES`", () => {
        expect(new Iterating().visitFabricArray([1])).toBe(DO_RECURSE_VALUES);
      });
    });

    describe("visitFabricPlainObject()", () => {
      it("returns `DO_RECURSE_VALUES`", () => {
        expect(new Iterating().visitFabricPlainObject({ a: 1 })).toBe(
          DO_RECURSE_VALUES,
        );
      });
    });

    describe("visitFabricInstance()", () => {
      it("returns `DO_RECURSE_KEYS_VALUES`", () => {
        const instance = new FabricMap(new Map());

        expect(new Iterating().visitFabricInstance(instance)).toBe(
          DO_RECURSE_KEYS_VALUES,
        );
      });
    });

    describe("the `visited*()` methods", () => {
      it("return `undefined`", () => {
        const vis = new Iterating();

        expect(vis.visitedArrayElement([1], 0, 1)).toBeUndefined();
        expect(vis.visitedArrayGap([], 0, 1)).toBeUndefined();
        expect(vis.visitedMapping({}, "k", 1)).toBeUndefined();
      });
    });
  });
});
