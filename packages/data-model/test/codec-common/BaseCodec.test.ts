import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { FabricValue } from "@/interface.ts";
import { BaseCodec } from "@/codec-common/BaseCodec.ts";
import type { ReconstructionContext } from "@/codec-common/interface.ts";

/**
 * Minimal concrete `BaseCodec` for exercising the base class's own behavior.
 * `encode` / `decode` are not under test here, so they throw.
 */
class TestCodec extends BaseCodec<FabricValue> {
  encode(_value: FabricValue): FabricValue {
    throw new Error("Unimplemented.");
  }

  decode(
    _typeTag: string,
    _state: FabricValue,
    _context: ReconstructionContext,
  ): FabricValue {
    throw new Error("Unimplemented.");
  }
}

describe("BaseCodec", () => {
  describe("instance members", () => {
    describe("recognizedTypeTag", () => {
      it("returns the tag passed to the constructor", () => {
        expect(new TestCodec("Foo@1", undefined).recognizedTypeTag).toBe(
          "Foo@1",
        );
      });

      it("is `undefined` when constructed with no recognized tag", () => {
        expect(new TestCodec(undefined, undefined).recognizedTypeTag).toBe(
          undefined,
        );
      });
    });

    describe("tagForValue()", () => {
      it("returns the codec's `recognizedTypeTag`", () => {
        const codec = new TestCodec("Foo@1", undefined);
        expect(codec.tagForValue("anything")).toBe("Foo@1");
      });

      it("throws when the codec has no recognized tag (must be overridden)", () => {
        const codec = new TestCodec(undefined, undefined);
        expect(() => codec.tagForValue("anything")).toThrow(
          "no recognized tag",
        );
      });
    });
  });
});
