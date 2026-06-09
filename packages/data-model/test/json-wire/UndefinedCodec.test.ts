import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { UndefinedCodec } from "@/json-wire/UndefinedCodec.ts";
import { WIRE_TYPE_TAGS } from "@/wire-common/wire-type-tags.ts";
import { EMPTY_RECONSTRUCTION_CONTEXT } from "@/wire-common/EmptyReconstructionContext.ts";

describe("UndefinedCodec", () => {
  const codec = new UndefinedCodec();
  const expectedTag = WIRE_TYPE_TAGS.Undefined;
  const context = EMPTY_RECONSTRUCTION_CONTEXT;

  describe("instance members", () => {
    describe("wireTypeTag", () => {
      it("is the `Undefined` wire type tag", () => {
        expect(codec.wireTypeTag).toBe(expectedTag);
      });
    });

    describe("canEncode()", () => {
      it("claims `undefined`, rejects `null` (and other values)", () => {
        // `undefined` serializes to the `Undefined@1` tag with `null` state,
        // whereas `null` is a JSON-native value that is not codec-handled.
        expect(codec.canEncode(undefined)).toBe(true);
        expect(codec.canEncode(null)).toBe(false);
        expect(codec.canEncode(0)).toBe(false);
      });
    });

    describe("encode()", () => {
      it("encodes `undefined` to `null` state", () => {
        expect(codec.encode(undefined)).toBe(null);
      });
    });

    describe("decode()", () => {
      it("decodes `null` state back to `undefined`", () => {
        const decoded = codec.decode(expectedTag, null, context);
        expect(decoded).toBe(undefined);
      });

      it("round-trips `undefined` via encode -> decode", () => {
        const decoded = codec.decode(
          expectedTag,
          codec.encode(undefined),
          context,
        );
        expect(decoded).toBe(undefined);
      });

      it("throws when decoding non-`null` state", () => {
        expect(() => codec.decode(expectedTag, 42, context)).toThrow(
          "expected `null` state",
        );
      });
    });
  });
});
