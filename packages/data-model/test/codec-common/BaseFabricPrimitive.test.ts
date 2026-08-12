/**
 * The primitive base class's own behavior, which comes down to one invariant.
 *
 * Every concrete primitive is required to extend this class rather than the
 * contract above it, and the type guard enforces that rather than merely
 * reporting on it: a value that is a `FabricPrimitive` but not a
 * `BaseFabricPrimitive` is a broken subclass, so the guard throws instead of
 * quietly answering `false` and letting the mistake travel.
 *
 * The placeholder member is here in order to be a member at all -- an instance
 * type with nothing in it would make an ordinary `value is` guard collapse --
 * and its only observable behavior is refusing to be called.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { FabricPrimitive } from "@/interface.ts";
import {
  BaseFabricPrimitive,
  EXAMPLE_METHOD,
} from "@/codec-common/BaseFabricPrimitive.ts";

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
