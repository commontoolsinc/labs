import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { SpecialNumberCodec } from "@/codec-common/SpecialNumberCodec.ts";
import { CODEC_TYPE_TAGS } from "@/codec-common/codec-type-tags.ts";
import { EMPTY_RECONSTRUCTION_CONTEXT } from "@/codec-common/EmptyReconstructionContext.ts";
import { ProblematicValue } from "@/fabric-instances/ProblematicValue.ts";

describe("SpecialNumberCodec", () => {
  const codec = new SpecialNumberCodec();
  const expectedTag = CODEC_TYPE_TAGS.SpecialNumber;
  const context = EMPTY_RECONSTRUCTION_CONTEXT;

  describe("instance members", () => {
    describe("recognizedTypeTag", () => {
      it("is the `SpecialNumber` wire type tag", () => {
        expect(codec.recognizedTypeTag).toBe(expectedTag);
      });
    });

    describe("canEncode()", () => {
      it("claims the four special numeric values, rejects ordinary ones", () => {
        expect(codec.canEncode(-0)).toBe(true);
        expect(codec.canEncode(NaN)).toBe(true);
        expect(codec.canEncode(Infinity)).toBe(true);
        expect(codec.canEncode(-Infinity)).toBe(true);
        // Ordinary finite numbers (and `+0`) are not claimed.
        expect(codec.canEncode(42)).toBe(false);
        expect(codec.canEncode(0)).toBe(false);
      });
    });

    describe("encode()", () => {
      it('encodes `-0` to the literal `"-0"`', () => {
        expect(codec.encode(-0)).toBe("-0");
      });

      it('encodes `NaN` to the literal `"NaN"`', () => {
        expect(codec.encode(NaN)).toBe("NaN");
      });

      it('encodes `+Infinity` to the literal `"+Infinity"`', () => {
        expect(codec.encode(Infinity)).toBe("+Infinity");
      });

      it('encodes `-Infinity` to the literal `"-Infinity"`', () => {
        expect(codec.encode(-Infinity)).toBe("-Infinity");
      });

      it('any `NaN` bit pattern encodes as the literal `"NaN"`', () => {
        const view = new DataView(new ArrayBuffer(8));
        view.setBigUint64(0, 0x7ff8000000000001n, false);
        const nonCanonicalNaN = view.getFloat64(0, false);
        expect(Number.isNaN(nonCanonicalNaN)).toBe(true);
        expect(codec.encode(nonCanonicalNaN)).toBe("NaN");
      });
    });

    describe("decode()", () => {
      it("decodes non-string state to `ProblematicValue`", () => {
        const result = codec.decode(
          expectedTag,
          0,
          context,
        );
        expect(result).toBeInstanceOf(ProblematicValue);
        expect((result as ProblematicValue).wireTypeTag).toBe(
          "SpecialNumber@1",
        );
      });

      it("decodes an unknown literal to `ProblematicValue`", () => {
        // "Infinity" (missing leading +) is not a recognized literal.
        const result = codec.decode(expectedTag, "Infinity", context);
        expect(result).toBeInstanceOf(ProblematicValue);
        expect((result as ProblematicValue).wireTypeTag).toBe(
          "SpecialNumber@1",
        );
      });
    });

    describe("round trip encode-decode", () => {
      it("round-trips `-0` (preserves sign of zero)", () => {
        const result = codec.decode(expectedTag, codec.encode(-0), context);
        expect(Object.is(result, -0)).toBe(true);
      });

      it("round-trips `NaN`", () => {
        const result = codec.decode(expectedTag, codec.encode(NaN), context);
        expect(Number.isNaN(result)).toBe(true);
      });

      it("round-trips `+Infinity`", () => {
        const result = codec.decode(
          expectedTag,
          codec.encode(Infinity),
          context,
        );
        expect(result).toBe(Infinity);
      });

      it("round-trips `-Infinity`", () => {
        const result = codec.decode(
          expectedTag,
          codec.encode(-Infinity),
          context,
        );
        expect(result).toBe(-Infinity);
      });
    });
  });
});
