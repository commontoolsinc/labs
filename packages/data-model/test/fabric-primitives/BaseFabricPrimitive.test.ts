import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { FabricPrimitive } from "@/interface.ts";
import {
  BaseFabricPrimitive,
  EXAMPLE_METHOD,
} from "@/fabric-primitives/BaseFabricPrimitive.ts";

/**
 * Minimal `BaseFabricPrimitive` subclass for exercising the static guard in
 * isolation, independent of any production primitive.
 */
class ProbePrimitive extends BaseFabricPrimitive {}

/**
 * A rogue direct subclass of `FabricPrimitive` that bypasses
 * `BaseFabricPrimitive` -- the shape the invariant forbids. Used only to
 * witness `isInstance()`'s enforcement throw; no production class is built this
 * way.
 */
class RoguePrimitive extends FabricPrimitive {}

describe("BaseFabricPrimitive", () => {
  describe("inheritance", () => {
    it("is a subclass of `FabricPrimitive`", () => {
      const probe = new ProbePrimitive();
      expect(probe instanceof BaseFabricPrimitive).toBe(true);
      expect(probe instanceof FabricPrimitive).toBe(true);
    });
  });

  describe("isInstance()", () => {
    it("is `true` for a `BaseFabricPrimitive`", () => {
      expect(BaseFabricPrimitive.isInstance(new ProbePrimitive())).toBe(true);
    });

    it("is `false` for non-fabric values", () => {
      expect(BaseFabricPrimitive.isInstance(null)).toBe(false);
      expect(BaseFabricPrimitive.isInstance(42)).toBe(false);
      expect(BaseFabricPrimitive.isInstance("x")).toBe(false);
      expect(BaseFabricPrimitive.isInstance({})).toBe(false);
      expect(BaseFabricPrimitive.isInstance([])).toBe(false);
    });

    it("throws for a `FabricPrimitive` that is not a `BaseFabricPrimitive`", () => {
      expect(() => BaseFabricPrimitive.isInstance(new RoguePrimitive()))
        .toThrow(
          "Shouldn't happen",
        );
    });
  });

  describe("`[EXAMPLE_METHOD]` (placeholder seed)", () => {
    it("throws when invoked (unimplemented stub)", () => {
      expect(() => new ProbePrimitive()[EXAMPLE_METHOD]()).toThrow(
        "Not implemented",
      );
    });
  });
});
