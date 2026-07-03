import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { SymbolCodec } from "@/codec-common/SymbolCodec.ts";
import { CODEC_TYPE_TAGS } from "@/codec-common/codec-type-tags.ts";
import { EMPTY_RECONSTRUCTION_CONTEXT } from "@/codec-common/EmptyReconstructionContext.ts";
import { ProblematicValue } from "@/fabric-instances/ProblematicValue.ts";

describe("SymbolCodec", () => {
  const codec = new SymbolCodec();
  const expectedTag = CODEC_TYPE_TAGS.Symbol;
  const context = EMPTY_RECONSTRUCTION_CONTEXT;

  describe("instance members", () => {
    describe("recognizedTypeTag", () => {
      it("is the `Symbol` wire type tag", () => {
        expect(codec.recognizedTypeTag).toBe(expectedTag);
      });
    });

    describe("canEncode()", () => {
      it("claims interned symbols, rejects unique ones", () => {
        // Unique symbols have no registry key, so the codec declines them; this
        // is what lets a default-configured context fail loudly rather than
        // silently flatten the symbol.
        expect(codec.canEncode(Symbol("nope"))).toBe(false);
        // Registry-interned symbols are claimed.
        expect(codec.canEncode(Symbol.for("yes"))).toBe(true);
      });
    });

    describe("encode()", () => {
      it('encodes `Symbol.for("foo")` to its registry key', () => {
        expect(codec.encode(Symbol.for("foo"))).toBe("foo");
      });

      it('encodes `Symbol.for("")` (empty key)', () => {
        expect(codec.encode(Symbol.for(""))).toBe("");
      });
    });

    describe("decode()", () => {
      it("decodes non-string state to `ProblematicValue`", () => {
        const result = codec.decode(
          expectedTag,
          42,
          context,
        );
        expect(result).toBeInstanceOf(ProblematicValue);
        expect((result as unknown as ProblematicValue).wireTypeTag).toBe(
          "Symbol@1",
        );
      });
    });

    describe("round trip encode-decode", () => {
      it("round-trips an interned symbol to the same registry instance", () => {
        const result = codec.decode(
          expectedTag,
          codec.encode(Symbol.for("hello")),
          context,
        );
        expect(typeof result).toBe("symbol");
        expect(result).toBe(Symbol.for("hello"));
      });

      it("round-trips a key with non-ASCII characters", () => {
        const key = "café-☕-\u{1F600}";
        const result = codec.decode(
          expectedTag,
          codec.encode(Symbol.for(key)),
          context,
        );
        expect(result).toBe(Symbol.for(key));
      });
    });

    describe("registry dispatch", () => {
      it("can be registered directly in a custom registry", async () => {
        const { CodecRegistry } = await import(
          "@/codec-json/CodecRegistry.ts"
        );
        const registry = new CodecRegistry();
        registry.register(codec);

        expect(codec.uniqueHandledClass).toBe(Symbol);
        expect(registry.codecFromValue(Symbol.for("direct"))).toBe(codec);
      });
    });
  });
});
