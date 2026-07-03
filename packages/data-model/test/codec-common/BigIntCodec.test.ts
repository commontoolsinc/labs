import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { BigIntCodec } from "@/codec-common/BigIntCodec.ts";
import { CODEC_TYPE_TAGS } from "@/codec-common/codec-type-tags.ts";
import { EMPTY_RECONSTRUCTION_CONTEXT } from "@/codec-common/EmptyReconstructionContext.ts";
import { ProblematicValue } from "@/fabric-instances/ProblematicValue.ts";

describe("BigIntCodec", () => {
  const codec = new BigIntCodec();
  const expectedTag = CODEC_TYPE_TAGS.BigInt;
  const context = EMPTY_RECONSTRUCTION_CONTEXT;

  describe("instance members", () => {
    describe("recognizedTypeTag", () => {
      it("is the `BigInt` wire type tag", () => {
        expect(codec.recognizedTypeTag).toBe(expectedTag);
      });
    });

    describe("canEncode()", () => {
      it("only claims `bigint` values", () => {
        // `bigint` serializes to `BigInt@1`, whereas `number` does not -- the
        // two produce distinct wire forms.
        expect(codec.canEncode(42n)).toBe(true);
        expect(codec.canEncode(42)).toBe(false);
      });
    });

    describe("encode()", () => {
      it("encodes `42n` to base64url of two's complement bytes", () => {
        // 42n -> [0x2a] -> base64 "Kg"
        expect(codec.encode(42n)).toBe("Kg");
      });

      it('encodes `0n` to base64 `"AA"`', () => {
        // 0n -> [0x00] -> base64 "AA"
        expect(codec.encode(0n)).toBe("AA");
      });

      it('encodes `-1n` to base64url `"_w"`', () => {
        // -1n -> [0xFF] -> base64url "_w"
        expect(codec.encode(-1n)).toBe("_w");
      });

      it('encodes `1n` to base64 `"AQ"`', () => {
        // 1n -> [0x01] -> base64 "AQ"
        expect(codec.encode(1n)).toBe("AQ");
      });

      it("encodes `128n` with sign-extension byte", () => {
        // 128n -> [0x00, 0x80] -> base64 "AIA"
        expect(codec.encode(128n)).toBe("AIA");
      });

      it("produces unpadded base64 output (no trailing `=`)", () => {
        // 42n produces 1 byte -> 2 base64 chars (would be "Kg==" with padding)
        const b64 = codec.encode(42n) as string;
        expect(b64).toBe("Kg");
        expect(b64).not.toContain("=");
      });
    });

    describe("decode()", () => {
      it("accepts unpadded base64url input", () => {
        // "Kg" is the standard unpadded base64url encoding of 42n.
        const result = codec.decode(expectedTag, "Kg", context);
        expect(result).toBe(42n);
      });

      it("accepts padded base64 input", () => {
        // "Kg==" is the padded form of "Kg" (42n) -- padding is accepted by the
        // web-standard Uint8Array.fromBase64.
        const result = codec.decode(expectedTag, "Kg==", context);
        expect(result).toBe(42n);
      });

      it("decodes non-string state to `ProblematicValue`", () => {
        const result = codec.decode(
          expectedTag,
          42,
          context,
        );
        expect(result).toBeInstanceOf(ProblematicValue);
        const prob = result as unknown as ProblematicValue;
        expect(prob.wireTypeTag).toBe("BigInt@1");
        expect(prob.state).toBe(42);
      });

      it("decodes `null` state to `ProblematicValue`", () => {
        const result = codec.decode(expectedTag, null, context);
        expect(result).toBeInstanceOf(ProblematicValue);
      });

      it("decodes object state to `ProblematicValue`", () => {
        const result = codec.decode(
          expectedTag,
          { bad: true },
          context,
        );
        expect(result).toBeInstanceOf(ProblematicValue);
      });

      it("decodes empty base64 string to `ProblematicValue`", () => {
        const result = codec.decode(expectedTag, "", context);
        expect(result).toBeInstanceOf(ProblematicValue);
        const prob = result as unknown as ProblematicValue;
        expect(prob.wireTypeTag).toBe("BigInt@1");
      });
    });

    describe("round trip encode-decode", () => {
      it("round-trips at top level", () => {
        const decoded = codec.decode(expectedTag, codec.encode(42n), context);
        expect(decoded).toBe(42n);
      });

      it("round-trips negative bigint", () => {
        const decoded = codec.decode(expectedTag, codec.encode(-999n), context);
        expect(decoded).toBe(-999n);
      });

      it("round-trips zero bigint", () => {
        const decoded = codec.decode(expectedTag, codec.encode(0n), context);
        expect(decoded).toBe(0n);
      });

      it("round-trips `1n`", () => {
        const decoded = codec.decode(expectedTag, codec.encode(1n), context);
        expect(decoded).toBe(1n);
      });

      it("round-trips `-1n`", () => {
        const decoded = codec.decode(expectedTag, codec.encode(-1n), context);
        expect(decoded).toBe(-1n);
      });

      it("round-trips large bigint", () => {
        const big = 2n ** 64n;
        const decoded = codec.decode(expectedTag, codec.encode(big), context);
        expect(decoded).toBe(big);
      });

      it("round-trips large negative bigint", () => {
        const big = -(2n ** 64n);
        const decoded = codec.decode(expectedTag, codec.encode(big), context);
        expect(decoded).toBe(big);
      });

      it("round-trips boundary value `127n`", () => {
        const decoded = codec.decode(expectedTag, codec.encode(127n), context);
        expect(decoded).toBe(127n);
      });

      it("round-trips boundary value `128n`", () => {
        const decoded = codec.decode(expectedTag, codec.encode(128n), context);
        expect(decoded).toBe(128n);
      });

      it("round-trips boundary value `-128n`", () => {
        const decoded = codec.decode(expectedTag, codec.encode(-128n), context);
        expect(decoded).toBe(-128n);
      });

      it("round-trips boundary value `-129n`", () => {
        const decoded = codec.decode(expectedTag, codec.encode(-129n), context);
        expect(decoded).toBe(-129n);
      });
    });

    describe("registry dispatch", () => {
      it("can be registered directly in a custom registry", async () => {
        const { CodecRegistry } = await import(
          "@/codec-json/CodecRegistry.ts"
        );
        const registry = new CodecRegistry();
        registry.register(codec);

        expect(codec.uniqueHandledClass).toBe(BigInt);
        expect(registry.codecFromValue(42n)).toBe(codec);
      });
    });
  });
});
