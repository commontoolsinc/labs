import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { FabricInstance, FabricPrimitive } from "@/interface.ts";
import { FabricRegExp } from "@/fabric-primitives/FabricRegExp.ts";
import { CODEC } from "@/codec-common/interface.ts";
import { CODEC_TYPE_TAGS } from "@/codec-common/codec-type-tags.ts";
import { EMPTY_RECONSTRUCTION_CONTEXT } from "@/codec-common/EmptyReconstructionContext.ts";
import { ProblematicValue } from "@/fabric-instances/ProblematicValue.ts";
import { isConvertibleNativeInstance } from "@/native-conversion.ts";
import {
  isFabricCompatible,
  shallowFabricFromNativeValue,
} from "@/fabric-value.ts";
import {
  NATIVE_TAGS,
  tagFromNativeClass,
  tagFromNativeValue,
} from "@/native-type-tags.ts";
import { jsonFromValue, valueFromJson } from "@/codec-json/index.ts";
import { hashOf } from "@/value-hash.ts";

const expectFabricRegExp = (value: unknown): FabricRegExp => {
  expect(value).toBeInstanceOf(FabricRegExp);
  if (!(value instanceof FabricRegExp)) {
    throw new Error("expected FabricRegExp");
  }
  return value;
};

describe("FabricRegExp", () => {
  // Pure type-identity / supertype check: cross-cutting carve-out per the
  // rule (doesn't fit a single member, isn't construction mechanics).
  it("extends `FabricPrimitive` (not `FabricInstance`)", () => {
    const re = new FabricRegExp(/abc/gi);
    expect(re instanceof FabricPrimitive).toBe(true);
    expect(re instanceof FabricInstance).toBe(false);
  });

  describe("constructor()", () => {
    it("produces an always-frozen instance", () => {
      expect(Object.isFrozen(new FabricRegExp(/abc/))).toBe(true);
    });

    describe("given a `RegExp`", () => {
      it("retains the `source` and `flags` and implies the `es2025` flavor", () => {
        const re = new FabricRegExp(/test/i);
        expect(re.source).toBe("test");
        expect(re.flags).toBe("i");
        expect(re.flavor).toBe("es2025");
      });

      it("does not alias the input `RegExp`", () => {
        const original = /abc/gi;
        const re = new FabricRegExp(original);
        original.lastIndex = 5;
        expect(re.value.lastIndex).toBe(0);
      });

      it("rejects one with extra enumerable properties", () => {
        const original = /abc/g;
        (original as RegExp & Record<string, unknown>).custom = 1;
        expect(() => new FabricRegExp(original)).toThrow(
          "Cannot store RegExp with extra enumerable properties",
        );
      });
    });

    describe("given explicit `flavor`/`source`/`flags`", () => {
      it("retains all three", () => {
        const re = new FabricRegExp("pcre2", "ab+c", "g");
        expect(re.flavor).toBe("pcre2");
        expect(re.source).toBe("ab+c");
        expect(re.flags).toBe("g");
      });
    });
  });

  describe("instance members", () => {
    describe(".source", () => {
      it("returns the pattern source text", () => {
        expect(new FabricRegExp(/^foo\d+\.bar$/).source).toBe(
          "^foo\\d+\\.bar$",
        );
      });
    });

    describe(".flags", () => {
      it("returns the flags string", () => {
        expect(new FabricRegExp(/abc/gim).flags).toBe("gim");
      });

      it("returns empty `flags` for a no-flag regexp", () => {
        expect(new FabricRegExp(/abc/).flags).toBe("");
      });
    });

    describe(".flavor", () => {
      it("defaults to `es2025` for a `RegExp` argument", () => {
        expect(new FabricRegExp(/abc/).flavor).toBe("es2025");
      });

      it("returns an explicit flavor", () => {
        expect(new FabricRegExp("pcre2", "abc", "g").flavor).toBe("pcre2");
      });
    });

    describe(".value", () => {
      it("returns an equivalent native `RegExp` for the `es2025` flavor", () => {
        const value = new FabricRegExp(/abc/gi).value;
        expect(value).toBeInstanceOf(RegExp);
        expect(value.source).toBe("abc");
        expect(value.flags).toBe("gi");
      });

      it("returns a fresh clone on each call (not the stored object)", () => {
        const re = new FabricRegExp(/abc/g);
        expect(re.value).not.toBe(re.value);
      });

      it("returns a `RegExp` whose mutation does not affect the value", () => {
        const re = new FabricRegExp(/abc/g);
        re.value.lastIndex = 5;
        expect(re.value.lastIndex).toBe(0);
      });

      it("throws for a non-`es2025` flavor (no native representation yet)", () => {
        const re = new FabricRegExp("pcre2", "abc", "g");
        expect(() => re.value).toThrow("pcre2");
      });
    });
  });

  describe("static members", () => {
    describe("[CODEC]", () => {
      const codec = FabricRegExp[CODEC];
      const expectedTag = CODEC_TYPE_TAGS.RegExp;
      const context = EMPTY_RECONSTRUCTION_CONTEXT;

      describe("recognizedTypeTag", () => {
        it("is the `RegExp` wire type tag", () => {
          expect(codec.recognizedTypeTag).toBe(expectedTag);
        });
      });

      describe("canEncode()", () => {
        it("claims a `FabricRegExp`, rejecting other values", () => {
          expect(codec.canEncode(new FabricRegExp(/ab+c/gi))).toBe(true);
          expect(codec.canEncode("not a regexp")).toBe(false);
        });
      });

      describe("encode()", () => {
        it("encodes to a `{ source, flags, flavor }` object", () => {
          const re = new FabricRegExp(/ab+c/gi);
          expect(codec.encode(re)).toEqual({
            flags: "gi",
            flavor: "es2025",
            source: "ab+c",
          });
        });
      });

      describe("decode()", () => {
        it("decodes non-object state to `ProblematicValue`", () => {
          const decoded = codec.decode(expectedTag, "nope", context);
          expect(decoded).toBeInstanceOf(ProblematicValue);
        });
      });

      describe("round trip encode-decode", () => {
        it("round-trips a regex (source, flags, flavor)", () => {
          const re = new FabricRegExp(/ab+c/gi);
          const decoded = codec.decode(
            expectedTag,
            codec.encode(re),
            context,
          );
          const fabricRegExp = expectFabricRegExp(decoded);
          expect(fabricRegExp.source).toBe("ab+c");
          expect(fabricRegExp.flags).toBe("gi");
          expect(fabricRegExp.flavor).toBe("es2025");
        });

        it("round-trips a flagless regex", () => {
          const re = new FabricRegExp("es2025", "^x*$", "");
          const decoded = codec.decode(
            expectedTag,
            codec.encode(re),
            context,
          );
          const fabricRegExp = expectFabricRegExp(decoded);
          expect(fabricRegExp.source).toBe("^x*$");
          expect(fabricRegExp.flags).toBe("");
        });
      });
    });
  });

  // The following exercise free functions' handling of `FabricRegExp` /
  // `RegExp` rather than members of the class itself, so they live directly
  // under the class `describe()` (the cross-cutting carve-out).
  describe("round-trip via `jsonFromValue()` / `valueFromJson()`", () => {
    it("round-trips a `FabricRegExp`", () => {
      const original = new FabricRegExp(/hello\s+world/gim);
      const restored = valueFromJson(jsonFromValue(original)) as FabricRegExp;
      expect(restored).toBeInstanceOf(FabricRegExp);
      expect(restored.source).toBe(original.source);
      expect(restored.flags).toBe(original.flags);
      expect(restored.flavor).toBe("es2025");
    });

    it("round-trips with various flag combinations", () => {
      const flagSets = ["", "g", "i", "m", "s", "u", "y", "d", "gi", "gims"];
      for (const flags of flagSets) {
        const original = new FabricRegExp(new RegExp("test", flags));
        const restored = valueFromJson(jsonFromValue(original)) as FabricRegExp;
        expect(restored.flags).toBe(original.flags);
        expect(restored.flavor).toBe("es2025");
      }
    });

    it("round-trips a non-`es2025` flavor faithfully (source/flags/flavor)", () => {
      const original = new FabricRegExp("pcre2", "ab+c", "g");
      const restored = valueFromJson(jsonFromValue(original)) as FabricRegExp;
      expect(restored.source).toBe("ab+c");
      expect(restored.flags).toBe("g");
      expect(restored.flavor).toBe("pcre2");
    });
  });

  describe("shallowFabricFromNativeValue()", () => {
    it("converts a `RegExp` to a `FabricRegExp`", () => {
      const result = shallowFabricFromNativeValue(/abc/gi);
      expect(result).toBeInstanceOf(FabricRegExp);
      expect((result as FabricRegExp).source).toBe("abc");
      expect((result as FabricRegExp).flags).toBe("gi");
    });

    it("rejects a `RegExp` with extra enumerable properties", () => {
      const re = /abc/;
      (re as RegExp & Record<string, unknown>).custom = 1;
      expect(() => shallowFabricFromNativeValue(re)).toThrow(
        "Cannot store RegExp with extra enumerable properties",
      );
    });
  });

  describe("tag functions", () => {
    it("`tagFromNativeValue()` returns the `RegExp` tag for `RegExp` instances", () => {
      expect(tagFromNativeValue(/abc/)).toBe(NATIVE_TAGS.RegExp);
    });

    it("`tagFromNativeClass()` returns the `RegExp` tag for the `RegExp` constructor", () => {
      expect(tagFromNativeClass(RegExp)).toBe(NATIVE_TAGS.RegExp);
    });

    it("`isConvertibleNativeInstance()` returns `true` for `RegExp`", () => {
      expect(isConvertibleNativeInstance(/abc/)).toBe(true);
      expect(isConvertibleNativeInstance(new RegExp("test", "gi"))).toBe(true);
    });
  });

  describe("isFabricCompatible()", () => {
    it("returns `true` for a plain `RegExp`", () => {
      expect(isFabricCompatible(/abc/gi)).toBe(true);
    });

    it("returns `true` for a `RegExp` nested in objects", () => {
      expect(isFabricCompatible({ pattern: /abc/gi })).toBe(true);
    });
  });

  describe("hashOf()", () => {
    it("produces a hash for a `FabricRegExp`", () => {
      const hash = hashOf(new FabricRegExp(/abc/gi));
      expect(hash.bytes).toBeInstanceOf(Uint8Array);
      expect(hash.length).toBe(32); // SHA-256
    });

    it("produces the same hash for the same regex", () => {
      const h1 = hashOf(new FabricRegExp(/abc/gi)).bytes;
      const h2 = hashOf(new FabricRegExp(/abc/gi)).bytes;
      expect(h1).toEqual(h2);
    });

    it("produces a different hash for a different `source`", () => {
      const h1 = hashOf(new FabricRegExp(/abc/)).bytes;
      const h2 = hashOf(new FabricRegExp(/def/)).bytes;
      expect(h1).not.toEqual(h2);
    });

    it("produces a different hash for different `flags`", () => {
      const h1 = hashOf(new FabricRegExp(/abc/g)).bytes;
      const h2 = hashOf(new FabricRegExp(/abc/i)).bytes;
      expect(h1).not.toEqual(h2);
    });

    it("produces a different hash for a different `flavor`", () => {
      const h1 = hashOf(new FabricRegExp("es2025", "abc", "g")).bytes;
      const h2 = hashOf(new FabricRegExp("pcre2", "abc", "g")).bytes;
      expect(h1).not.toEqual(h2);
    });
  });
});
