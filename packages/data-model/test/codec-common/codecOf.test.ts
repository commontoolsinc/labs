import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { FabricSpecialObject, JSON_CODEC } from "@/interface.ts";
import {
  CODEC,
  codecOf,
  type DecomposingCodec,
  type TerminalCodec,
} from "@/codec-common/index.ts";
import type { JsonCodecValue } from "@/codec-json/interface.ts";
import { FabricError } from "@/fabric-instances/FabricError.ts";
import { FabricBytes } from "@/fabric-primitives/FabricBytes.ts";

describe("codecOf()", () => {
  describe("given no `altCodec`", () => {
    it("returns the class's `[CODEC]` for a `FabricInstance`", () => {
      const err = FabricError.fromNativeError(new Error("x"));
      expect(codecOf(err)).toBe(FabricError[CODEC]);
    });

    it("throws for a `FabricPrimitive`", () => {
      // A primitive's codec terminates an encoding, so it is bound per wire
      // format under that format's own symbol rather than to `[CODEC]`.
      const fb = new FabricBytes(new Uint8Array([1, 2, 3]));
      expect(() => codecOf(fb)).toThrow("no `[CODEC]`");
    });

    it("throws for a `FabricSpecialObject` binding no `[CODEC]`", () => {
      class NoCodec extends FabricSpecialObject {}
      expect(() => codecOf(new NoCodec())).toThrow("no `[CODEC]`");
    });
  });

  describe("given an `altCodec`", () => {
    it("returns the alternative for a `FabricPrimitive`", () => {
      const fb = new FabricBytes(new Uint8Array([1, 2, 3]));
      expect(codecOf(fb, JSON_CODEC)).toBe(FabricBytes[JSON_CODEC]);
    });

    it("prefers `[CODEC]` when the class binds both", () => {
      // No class in the tree binds both, so this needs a double: with only a
      // real class the two symbols cannot disagree, and the case would pass
      // whichever one the implementation preferred.
      class BothCodecs extends FabricSpecialObject {
        static get [CODEC](): DecomposingCodec {
          return FabricError[CODEC];
        }

        static get [JSON_CODEC](): TerminalCodec<JsonCodecValue> {
          return FabricBytes[JSON_CODEC];
        }
      }

      expect(codecOf(new BothCodecs(), JSON_CODEC)).toBe(FabricError[CODEC]);
    });

    it("throws when the class binds neither symbol", () => {
      class NoCodec extends FabricSpecialObject {}
      expect(() => codecOf(new NoCodec(), JSON_CODEC))
        .toThrow("no `[CODEC]`");
    });
  });
});
