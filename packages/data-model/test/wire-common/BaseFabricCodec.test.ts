import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { FabricValue } from "@/interface.ts";
import { BaseFabricCodec } from "@/wire-common/BaseFabricCodec.ts";
import type { ReconstructionContext } from "@/wire-common/interface.ts";

/**
 * Minimal concrete `BaseFabricCodec` for exercising the base class's own
 * behavior. `encode` / `decode` are not under test here, so they throw.
 */
class TestCodec extends BaseFabricCodec {
  encode(_value: FabricValue): FabricValue {
    throw new Error("Unimplemented.");
  }

  decode(
    _wireTypeTag: string,
    _state: FabricValue,
    _context: ReconstructionContext,
  ): FabricValue {
    throw new Error("Unimplemented.");
  }
}

describe("BaseFabricCodec", () => {
  describe("instance members", () => {
    describe("wireTypeTag", () => {
      it("returns the tag passed to the constructor", () => {
        expect(new TestCodec("Foo@1", undefined).wireTypeTag).toBe("Foo@1");
      });

      it("is `undefined` when constructed with no preferred tag", () => {
        expect(new TestCodec(undefined, undefined).wireTypeTag).toBe(undefined);
      });
    });

    describe("tagForValue()", () => {
      it("returns the codec's preferred `wireTypeTag`", () => {
        const codec = new TestCodec("Foo@1", undefined);
        expect(codec.tagForValue("anything" as FabricValue)).toBe("Foo@1");
      });

      it("throws when the codec has no preferred tag (must be overridden)", () => {
        const codec = new TestCodec(undefined, undefined);
        expect(() => codec.tagForValue("anything" as FabricValue)).toThrow(
          "no preferred tag",
        );
      });
    });
  });
});
