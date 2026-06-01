import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { FabricInstance, FabricPrimitive } from "../../src/interface.ts";
import { FabricRegExp } from "../../src/fabric-primitives/FabricRegExp.ts";
import { isConvertibleNativeInstance } from "../../src/native-instance-utils.ts";
import {
  isFabricCompatible,
  resetDataModelConfig,
  setDataModelConfig,
  shallowFabricFromNativeValue,
} from "../../src/fabric-value.ts";
import {
  NATIVE_TAGS,
  tagFromNativeClass,
  tagFromNativeValue,
} from "../../src/native-type-tags.ts";
import { jsonFromValue, valueFromJson } from "../../src/json-wire/index.ts";
import { hashOf } from "../../src/value-hash.ts";

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
      const re = new FabricRegExp(/abc/);
      expect(Object.isFrozen(re)).toBe(true);
    });

    it("retains the `source` and `flags` of the original `RegExp`", () => {
      const re = new FabricRegExp(/test/i);
      expect(re.source).toBe("test");
      expect(re.flags).toBe("i");
    });

    it("does not alias the input `RegExp`", () => {
      const original = /abc/gi;
      const re = new FabricRegExp(original);
      // Advancing the original's `lastIndex` does not affect the value.
      original.lastIndex = 5;
      expect(re.value.lastIndex).toBe(0);
    });

    it("rejects a `RegExp` with extra enumerable properties", () => {
      const original = /abc/g;
      (original as unknown as Record<string, unknown>).custom = 1;
      expect(() => new FabricRegExp(original)).toThrow(
        "Cannot store RegExp with extra enumerable properties",
      );
    });

    it("defaults `flavor` to `es2025`", () => {
      expect(new FabricRegExp(/abc/).flavor).toBe("es2025");
    });

    it("retains an explicit `flavor`", () => {
      expect(new FabricRegExp(/abc/, "pcre2").flavor).toBe("pcre2");
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
      it("returns the flavor identifier", () => {
        expect(new FabricRegExp(/abc/, "pcre2").flavor).toBe("pcre2");
      });
    });

    describe(".typeTag", () => {
      it("is `RegExp@1`", () => {
        expect(new FabricRegExp(/abc/).typeTag).toBe("RegExp@1");
      });
    });

    describe(".value", () => {
      it("returns an equivalent native `RegExp`", () => {
        const re = new FabricRegExp(/abc/gi);
        const value = re.value;
        expect(value).toBeInstanceOf(RegExp);
        expect(value.source).toBe("abc");
        expect(value.flags).toBe("gi");
      });

      it("returns a fresh clone on each call (not the stored object)", () => {
        const re = new FabricRegExp(/abc/g);
        const first = re.value;
        const second = re.value;
        expect(first).not.toBe(second);
      });

      it("returns a `RegExp` whose mutation does not affect the value", () => {
        const re = new FabricRegExp(/abc/g);
        const value = re.value;
        value.lastIndex = 5;
        // A subsequent read is unaffected by the prior caller's mutation.
        expect(re.value.lastIndex).toBe(0);
      });
    });
  });

  describe("static members", () => {
    describe("fromState()", () => {
      it("creates a `FabricRegExp` from state", () => {
        const re = FabricRegExp.fromState({ source: "abc", flags: "gi" });
        expect(re).toBeInstanceOf(FabricRegExp);
        expect(re.source).toBe("abc");
        expect(re.flags).toBe("gi");
        expect(re.flavor).toBe("es2025");
      });

      it("defaults to empty `source`, `flags`, and `es2025` flavor", () => {
        const re = FabricRegExp.fromState({});
        expect(re.source).toBe("(?:)");
        expect(re.flags).toBe("");
        expect(re.flavor).toBe("es2025");
      });

      it("preserves an explicit `flavor` from state", () => {
        const re = FabricRegExp.fromState({
          source: "abc",
          flags: "g",
          flavor: "pcre2",
        });
        expect(re.source).toBe("abc");
        expect(re.flags).toBe("g");
        expect(re.flavor).toBe("pcre2");
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

    it("round-trips a custom `flavor`", () => {
      const original = new FabricRegExp(/abc/gi, "pcre2");
      const restored = valueFromJson(jsonFromValue(original)) as FabricRegExp;
      expect(restored.source).toBe("abc");
      expect(restored.flags).toBe("gi");
      expect(restored.flavor).toBe("pcre2");
    });
  });

  describe("shallowFabricFromNativeValue() (modern path)", () => {
    it("converts a `RegExp` to a `FabricRegExp`", () => {
      setDataModelConfig(true);
      try {
        const result = shallowFabricFromNativeValue(/abc/gi);
        expect(result).toBeInstanceOf(FabricRegExp);
        expect((result as FabricRegExp).source).toBe("abc");
        expect((result as FabricRegExp).flags).toBe("gi");
      } finally {
        resetDataModelConfig();
      }
    });

    it("rejects a `RegExp` with extra enumerable properties", () => {
      setDataModelConfig(true);
      try {
        const re = /abc/;
        (re as unknown as Record<string, unknown>).custom = 1;
        expect(() => shallowFabricFromNativeValue(re)).toThrow(
          "Cannot store RegExp with extra enumerable properties",
        );
      } finally {
        resetDataModelConfig();
      }
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
    beforeEach(() => {
      setDataModelConfig(true);
    });
    afterEach(() => {
      resetDataModelConfig();
    });

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
  });
});
