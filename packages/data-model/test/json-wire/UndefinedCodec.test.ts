import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { FabricValue } from "@/interface.ts";
import { UndefinedCodec } from "@/json-wire/UndefinedCodec.ts";
import { WIRE_TYPE_TAGS } from "@/wire-common/wire-type-tags.ts";
import { EMPTY_RECONSTRUCTION_CONTEXT } from "@/wire-common/EmptyReconstructionContext.ts";

describe("UndefinedCodec", () => {
  describe("[CODEC]", () => {
    const codec = new UndefinedCodec();
    const context = EMPTY_RECONSTRUCTION_CONTEXT;

    it("has the `Undefined` wire type tag", () => {
      expect(codec.wireTypeTag).toBe(WIRE_TYPE_TAGS.Undefined);
    });

    it("encodes `undefined` to `null` state", () => {
      expect(codec.encode(undefined)).toBe(null);
    });

    it("decodes `null` state back to `undefined`", () => {
      const decoded = codec.decode(codec.wireTypeTag, null, context);
      expect(decoded).toBe(undefined);
    });

    it("round-trips `undefined` via encode -> decode", () => {
      const decoded = codec.decode(
        codec.wireTypeTag,
        codec.encode(undefined),
        context,
      );
      expect(decoded).toBe(undefined);
    });

    it("is distinct from `null` (encodes `null` state, not the `null` value itself)", () => {
      // `undefined` serializes to the `Undefined@1` tag with `null` state,
      // whereas `null` is a JSON-native value that is not codec-handled.
      expect(codec.canEncode(undefined)).toBe(true);
      expect(codec.canEncode(null)).toBe(false);
    });

    it("throws when decoding non-`null` state", () => {
      expect(() =>
        codec.decode(codec.wireTypeTag, 42 as unknown as FabricValue, context)
      ).toThrow("expected `null` state");
    });
  });
});
