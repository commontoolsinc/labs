import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  DECONSTRUCT,
  DEEP_FREEZE,
  FabricInstance,
  type FabricValue,
  IS_DEEP_FROZEN,
  RECONSTRUCT,
} from "../../src/interface.ts";
import { BaseReconstructionContext } from "../../src/BaseReconstructionContext.ts";
import { FabricNativeWrapper } from "../../src/fabric-instances/FabricNativeWrapper.ts";
import { FabricRegExp } from "../../src/fabric-instances/FabricRegExp.ts";
import { isConvertibleNativeInstance } from "../../src/native-instance-utils.ts";
import { deepFreeze, isDeepFrozenFabricValue } from "../../src/deep-freeze.ts";
import { subFreeze, subIsDeepFrozen } from "./fixtures.ts";
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
import { hashOf } from "../../src/value-hash.ts";

/** Dummy reconstruction context for tests. */
class DummyReconstructionContext extends BaseReconstructionContext {
  override getCell(): never {
    throw new Error("getCell not implemented in test");
  }
}
const dummyContext = new DummyReconstructionContext();

describe("FabricRegExp", () => {
  // Pure type-identity / supertype checks: cross-cutting carve-out per the
  // rule (don't fit a single member, aren't construction mechanics).
  it("implements `FabricInstance`", () => {
    const sr = new FabricRegExp(/abc/gi);
    expect(sr instanceof FabricInstance).toBe(true);
  });

  it("has typeTag `RegExp@1`", () => {
    const sr = new FabricRegExp(/abc/);
    expect(sr.typeTag).toBe("RegExp@1");
  });

  it("is an instance of `FabricNativeWrapper`", () => {
    const sr = new FabricRegExp(/abc/);
    expect(sr instanceof FabricNativeWrapper).toBe(true);
  });

  describe("constructor()", () => {
    it("wraps the original `RegExp`", () => {
      const re = /test/i;
      const sr = new FabricRegExp(re);
      expect(sr.regex).toBe(re);
    });
  });

  describe("instance members", () => {
    describe("[DECONSTRUCT]", () => {
      it("returns `source`, `flags`, and `flavor`", () => {
        const sr = new FabricRegExp(/abc/gi);
        const state = sr[DECONSTRUCT]() as Record<string, FabricValue>;
        expect(state.source).toBe("abc");
        expect(state.flags).toBe("gi");
        expect(state.flavor).toBe("es2025");
      });

      it("returns correct `source` for a complex pattern", () => {
        const sr = new FabricRegExp(/^foo\d+\.bar$/);
        const state = sr[DECONSTRUCT]() as Record<string, FabricValue>;
        expect(state.source).toBe("^foo\\d+\\.bar$");
        expect(state.flags).toBe("");
        expect(state.flavor).toBe("es2025");
      });

      it("returns empty `flags` for a no-flag regexp", () => {
        const sr = new FabricRegExp(/abc/);
        const state = sr[DECONSTRUCT]() as Record<string, FabricValue>;
        expect(state.flags).toBe("");
      });

      it("rejects a `RegExp` with extra enumerable properties", () => {
        const re = /abc/g;
        (re as unknown as Record<string, unknown>).custom = 1;
        const sr = new FabricRegExp(re);
        expect(() => sr[DECONSTRUCT]()).toThrow(
          "Cannot store RegExp with extra enumerable properties",
        );
      });
    });

    describe("round-trip", () => {
      it("round-trips through `[DECONSTRUCT]`/`[RECONSTRUCT]`", () => {
        const original = /hello\s+world/gim;
        const sr = new FabricRegExp(original);
        const state = sr[DECONSTRUCT]();
        const restored = FabricRegExp[RECONSTRUCT](state, dummyContext);
        expect(restored.regex.source).toBe(original.source);
        expect(restored.regex.flags).toBe(original.flags);
        expect(restored.flavor).toBe("es2025");
      });

      it("round-trips with various flag combinations", () => {
        const flagSets = ["", "g", "i", "m", "s", "u", "y", "d", "gi", "gims"];
        for (const flags of flagSets) {
          const re = new RegExp("test", flags);
          const sr = new FabricRegExp(re);
          const state = sr[DECONSTRUCT]();
          const restored = FabricRegExp[RECONSTRUCT](state, dummyContext);
          expect(restored.regex.flags).toBe(re.flags);
          expect(restored.flavor).toBe("es2025");
        }
      });

      it("round-trips with a custom `flavor`", () => {
        const sr = new FabricRegExp(/abc/gi, "pcre2");
        expect(sr.flavor).toBe("pcre2");
        const state = sr[DECONSTRUCT]();
        const restored = FabricRegExp[RECONSTRUCT](state, dummyContext);
        expect(restored.regex.source).toBe("abc");
        expect(restored.regex.flags).toBe("gi");
        expect(restored.flavor).toBe("pcre2");
      });
    });

    describe("toNativeValue()", () => {
      it("returns a frozen `RegExp` (copy of unfrozen) when `frozen` is `true`", () => {
        const re = /abc/gi;
        const sr = new FabricRegExp(re);
        const result = sr.toNativeValue(true);
        expect(result).toBeInstanceOf(RegExp);
        expect(result.source).toBe("abc");
        expect(result.flags).toBe("gi");
        expect(Object.isFrozen(result)).toBe(true);
        // Original should NOT be mutated.
        expect(Object.isFrozen(re)).toBe(false);
      });

      it("returns the same `RegExp` if already frozen (`frozen=true`)", () => {
        const re = Object.freeze(/abc/gi);
        const sr = new FabricRegExp(re);
        const result = sr.toNativeValue(true);
        expect(result).toBe(re); // same reference
      });

      it("returns the original unfrozen `RegExp` when `frozen` is `false`", () => {
        const re = /abc/gi;
        const sr = new FabricRegExp(re);
        const result = sr.toNativeValue(false);
        expect(result).toBe(re); // same reference
        expect(Object.isFrozen(result)).toBe(false);
      });

      it("returns an unfrozen copy of a frozen `RegExp` when `frozen` is `false`", () => {
        const re = Object.freeze(/abc/gi);
        const sr = new FabricRegExp(re);
        const result = sr.toNativeValue(false);
        expect(result).not.toBe(re);
        expect(result).toBeInstanceOf(RegExp);
        expect(result.source).toBe("abc");
        expect(result.flags).toBe("gi");
        expect(Object.isFrozen(result)).toBe(false);
      });
    });

    describe("`[DEEP_FREEZE]` / `[IS_DEEP_FROZEN]`", () => {
      it("via dispatch: `[DEEP_FREEZE]` freezes the wrapped `RegExp` in place", () => {
        const fr = new FabricRegExp(/abc/g);
        expect(Object.isFrozen(fr.regex)).toBe(false);
        const result = deepFreeze(fr);
        expect(result).toBe(fr);
        expect(Object.isFrozen(fr)).toBe(true);
        expect(Object.isFrozen(fr.regex)).toBe(true);
      });

      it("via dispatch: `[IS_DEEP_FROZEN]` is `true` only when wrapper + `RegExp` frozen", () => {
        const fr = new FabricRegExp(/abc/g);
        expect(isDeepFrozenFabricValue(fr)).toBe(false);
        deepFreeze(fr);
        expect(isDeepFrozenFabricValue(fr)).toBe(true);
      });

      it("via direct member invocation: `[DEEP_FREEZE]` freezes the wrapped `RegExp` in place", () => {
        const fr = new FabricRegExp(/abc/g);
        expect(Object.isFrozen(fr.regex)).toBe(false);
        const result = fr[DEEP_FREEZE](subFreeze);
        expect(result).toBe(fr);
        expect(Object.isFrozen(fr)).toBe(true);
        expect(Object.isFrozen(fr.regex)).toBe(true);
      });

      it("via direct member invocation: `[IS_DEEP_FROZEN]` is `true` only when wrapper + `RegExp` frozen", () => {
        const fr = new FabricRegExp(/abc/g);
        expect(fr[IS_DEEP_FROZEN](subIsDeepFrozen)).toBe(false);
        fr[DEEP_FREEZE](subFreeze);
        expect(fr[IS_DEEP_FROZEN](subIsDeepFrozen)).toBe(true);
      });
    });
  });

  describe("static members", () => {
    describe("[RECONSTRUCT]", () => {
      it("creates a `FabricRegExp` from state", () => {
        const state = { source: "abc", flags: "gi" } as FabricValue;
        const result = FabricRegExp[RECONSTRUCT](state, dummyContext);
        expect(result).toBeInstanceOf(FabricRegExp);
        expect(result.regex.source).toBe("abc");
        expect(result.regex.flags).toBe("gi");
        expect(result.flavor).toBe("es2025");
      });

      it("defaults to empty `source`, `flags`, and `es2025` flavor", () => {
        const state = {} as FabricValue;
        const result = FabricRegExp[RECONSTRUCT](state, dummyContext);
        expect(result.regex.source).toBe("(?:)");
        expect(result.regex.flags).toBe("");
        expect(result.flavor).toBe("es2025");
      });

      it("preserves an explicit `flavor` from state", () => {
        const state = {
          source: "abc",
          flags: "g",
          flavor: "pcre2",
        } as FabricValue;
        const result = FabricRegExp[RECONSTRUCT](state, dummyContext);
        expect(result.regex.source).toBe("abc");
        expect(result.regex.flags).toBe("g");
        expect(result.flavor).toBe("pcre2");
      });
    });
  });

  // The following exercise free functions' handling of `FabricRegExp` /
  // `RegExp` rather than members of the class itself, so they live directly
  // under the class `describe()` (the cross-cutting carve-out).
  describe("shallowFabricFromNativeValue() (modern path)", () => {
    it("converts a `RegExp` to a `FabricRegExp`", () => {
      setDataModelConfig(true);
      try {
        const result = shallowFabricFromNativeValue(/abc/gi);
        expect(result).toBeInstanceOf(FabricRegExp);
        expect((result as FabricRegExp).regex.source).toBe("abc");
        expect((result as FabricRegExp).regex.flags).toBe("gi");
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
      const sr = new FabricRegExp(/abc/gi);
      const hash = hashOf(sr);
      expect(hash.bytes).toBeInstanceOf(Uint8Array);
      expect(hash.length).toBe(32); // SHA-256
    });

    it("produces the same hash for the same regex", () => {
      const sr1 = new FabricRegExp(/abc/gi);
      const sr2 = new FabricRegExp(/abc/gi);
      const h1 = hashOf(sr1).bytes;
      const h2 = hashOf(sr2).bytes;
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
