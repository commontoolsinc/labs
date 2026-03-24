import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  DECONSTRUCT,
  FabricInstance,
  type FabricValue,
  RECONSTRUCT,
  type ReconstructionContext,
} from "../interface.ts";
import {
  FabricNativeWrapper,
  FabricRegExp,
  isConvertibleNativeInstance,
} from "../fabric-native-instances.ts";
import {
  canBeStored,
  resetDataModelConfig,
  setDataModelConfig,
  shallowFabricFromNativeValue,
} from "../fabric-value.ts";
import {
  NATIVE_TAGS,
  tagFromNativeClass,
  tagFromNativeValue,
} from "../native-type-tags.ts";
import { hashOfModern } from "../value-hash-modern.ts";

/** Dummy reconstruction context for tests. */
const dummyContext: ReconstructionContext = {
  getCell(_ref) {
    throw new Error("getCell not implemented in test");
  },
};

// ============================================================================
// Tests
// ============================================================================

describe("FabricRegExp", () => {
  // --------------------------------------------------------------------------
  // Basic wrapper behavior
  // --------------------------------------------------------------------------

  describe("wrapper basics", () => {
    it("implements FabricInstance (instanceof check)", () => {
      const sr = new FabricRegExp(/abc/gi);
      expect(sr instanceof FabricInstance).toBe(true);
    });

    it("has typeTag 'RegExp@1'", () => {
      const sr = new FabricRegExp(/abc/);
      expect(sr.typeTag).toBe("RegExp@1");
    });

    it("wraps the original RegExp", () => {
      const re = /test/i;
      const sr = new FabricRegExp(re);
      expect(sr.regex).toBe(re);
    });

    it("is instanceof FabricNativeWrapper", () => {
      const sr = new FabricRegExp(/abc/);
      expect(sr instanceof FabricNativeWrapper).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // DECONSTRUCT
  // --------------------------------------------------------------------------

  describe("[DECONSTRUCT]", () => {
    it("returns source, flags, and flavor", () => {
      const sr = new FabricRegExp(/abc/gi);
      const state = sr[DECONSTRUCT]() as Record<string, FabricValue>;
      expect(state.source).toBe("abc");
      expect(state.flags).toBe("gi");
      expect(state.flavor).toBe("es2025");
    });

    it("returns correct source for complex pattern", () => {
      const sr = new FabricRegExp(/^foo\d+\.bar$/);
      const state = sr[DECONSTRUCT]() as Record<string, FabricValue>;
      expect(state.source).toBe("^foo\\d+\\.bar$");
      expect(state.flags).toBe("");
      expect(state.flavor).toBe("es2025");
    });

    it("returns empty flags for no-flag regexp", () => {
      const sr = new FabricRegExp(/abc/);
      const state = sr[DECONSTRUCT]() as Record<string, FabricValue>;
      expect(state.flags).toBe("");
    });

    it("rejects RegExp with extra enumerable properties", () => {
      const re = /abc/g;
      (re as unknown as Record<string, unknown>).custom = 1;
      const sr = new FabricRegExp(re);
      expect(() => sr[DECONSTRUCT]()).toThrow(
        "Cannot store RegExp with extra enumerable properties",
      );
    });
  });

  // --------------------------------------------------------------------------
  // RECONSTRUCT
  // --------------------------------------------------------------------------

  describe("[RECONSTRUCT]", () => {
    it("creates FabricRegExp from state", () => {
      const state = { source: "abc", flags: "gi" } as FabricValue;
      const result = FabricRegExp[RECONSTRUCT](state, dummyContext);
      expect(result).toBeInstanceOf(FabricRegExp);
      expect(result.regex.source).toBe("abc");
      expect(result.regex.flags).toBe("gi");
      expect(result.flavor).toBe("es2025");
    });

    it("defaults to empty source, flags, and es2025 flavor", () => {
      const state = {} as FabricValue;
      const result = FabricRegExp[RECONSTRUCT](state, dummyContext);
      expect(result.regex.source).toBe("(?:)");
      expect(result.regex.flags).toBe("");
      expect(result.flavor).toBe("es2025");
    });

    it("preserves explicit flavor from state", () => {
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

  // --------------------------------------------------------------------------
  // Round-trip
  // --------------------------------------------------------------------------

  describe("round-trip", () => {
    it("round-trips through DECONSTRUCT/RECONSTRUCT", () => {
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

    it("round-trips with custom flavor", () => {
      const sr = new FabricRegExp(/abc/gi, "pcre2");
      expect(sr.flavor).toBe("pcre2");
      const state = sr[DECONSTRUCT]();
      const restored = FabricRegExp[RECONSTRUCT](state, dummyContext);
      expect(restored.regex.source).toBe("abc");
      expect(restored.regex.flags).toBe("gi");
      expect(restored.flavor).toBe("pcre2");
    });
  });

  // --------------------------------------------------------------------------
  // toNativeValue (frozen/thawed unwrapping)
  // --------------------------------------------------------------------------

  describe("toNativeValue", () => {
    it("toNativeValue(true) returns frozen RegExp (copy of unfrozen)", () => {
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

    it("toNativeValue(true) returns same RegExp if already frozen", () => {
      const re = Object.freeze(/abc/gi);
      const sr = new FabricRegExp(re);
      const result = sr.toNativeValue(true);
      expect(result).toBe(re); // same reference
    });

    it("toNativeValue(false) returns the original unfrozen RegExp", () => {
      const re = /abc/gi;
      const sr = new FabricRegExp(re);
      const result = sr.toNativeValue(false);
      expect(result).toBe(re); // same reference
      expect(Object.isFrozen(result)).toBe(false);
    });

    it("toNativeValue(false) returns unfrozen copy of frozen RegExp", () => {
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

  // --------------------------------------------------------------------------
  // Conversion: shallowFabricFromNativeValueModern
  // --------------------------------------------------------------------------

  describe("shallowFabricFromNativeValue (rich path)", () => {
    it("converts RegExp to FabricRegExp", () => {
      setDataModelConfig({ modernDataModel: true });
      try {
        const result = shallowFabricFromNativeValue(/abc/gi);
        expect(result).toBeInstanceOf(FabricRegExp);
        expect((result as FabricRegExp).regex.source).toBe("abc");
        expect((result as FabricRegExp).regex.flags).toBe("gi");
      } finally {
        resetDataModelConfig();
      }
    });

    it("rejects RegExp with extra enumerable properties", () => {
      setDataModelConfig({ modernDataModel: true });
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

  // --------------------------------------------------------------------------
  // Tag functions
  // --------------------------------------------------------------------------

  describe("tag functions", () => {
    it("tagFromNativeValue returns RegExp tag for RegExp instances", () => {
      expect(tagFromNativeValue(/abc/)).toBe(NATIVE_TAGS.RegExp);
    });

    it("tagFromNativeClass returns RegExp tag for RegExp constructor", () => {
      expect(tagFromNativeClass(RegExp)).toBe(NATIVE_TAGS.RegExp);
    });

    it("isConvertibleNativeInstance returns true for RegExp", () => {
      expect(isConvertibleNativeInstance(/abc/)).toBe(true);
      expect(isConvertibleNativeInstance(new RegExp("test", "gi"))).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // canBeStored
  // --------------------------------------------------------------------------

  describe("canBeStored", () => {
    beforeEach(() => {
      setDataModelConfig({ modernDataModel: true });
    });
    afterEach(() => {
      resetDataModelConfig();
    });

    it("returns true for plain RegExp", () => {
      expect(canBeStored(/abc/gi)).toBe(true);
    });

    it("returns true for RegExp nested in objects", () => {
      expect(canBeStored({ pattern: /abc/gi })).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Canonical hash
  // --------------------------------------------------------------------------

  describe("hashOfModern", () => {
    it("produces a hash for FabricRegExp", () => {
      const sr = new FabricRegExp(/abc/gi);
      const hash = hashOfModern(sr);
      expect(hash.hash).toBeInstanceOf(Uint8Array);
      expect(hash.hash.length).toBe(32); // SHA-256
    });

    it("same regex produces same hash", () => {
      const sr1 = new FabricRegExp(/abc/gi);
      const sr2 = new FabricRegExp(/abc/gi);
      const h1 = Array.from(hashOfModern(sr1).hash);
      const h2 = Array.from(hashOfModern(sr2).hash);
      expect(h1).toEqual(h2);
    });

    it("different source produces different hash", () => {
      const h1 = Array.from(hashOfModern(new FabricRegExp(/abc/)).hash);
      const h2 = Array.from(hashOfModern(new FabricRegExp(/def/)).hash);
      expect(h1).not.toEqual(h2);
    });

    it("different flags produce different hash", () => {
      const h1 = Array.from(hashOfModern(new FabricRegExp(/abc/g)).hash);
      const h2 = Array.from(hashOfModern(new FabricRegExp(/abc/i)).hash);
      expect(h1).not.toEqual(h2);
    });
  });
});
