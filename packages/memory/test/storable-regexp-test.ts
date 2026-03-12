import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  DECONSTRUCT,
  isStorableInstance,
  RECONSTRUCT,
} from "../storable-protocol.ts";
import type { ReconstructionContext } from "../storable-protocol.ts";
import type { StorableValue } from "../interface.ts";
import {
  isConvertibleNativeInstance,
  nativeValueFromStorableValue,
  StorableNativeWrapper,
  StorableRegExp,
} from "../storable-native-instances.ts";
import {
  canBeStored,
  resetStorableValueConfig,
  setStorableValueConfig,
  shallowStorableFromNativeValue,
} from "../storable-value.ts";
import {
  NATIVE_TAGS,
  tagFromNativeClass,
  tagFromNativeValue,
} from "../type-tags.ts";
import { canonicalHash } from "../canonical-hash.ts";

/** Dummy reconstruction context for tests. */
const dummyContext: ReconstructionContext = {
  getCell(_ref) {
    throw new Error("getCell not implemented in test");
  },
};

// ============================================================================
// Tests
// ============================================================================

describe("StorableRegExp", () => {
  // --------------------------------------------------------------------------
  // Basic wrapper behavior
  // --------------------------------------------------------------------------

  describe("wrapper basics", () => {
    it("implements StorableInstance (isStorableInstance returns true)", () => {
      const sr = new StorableRegExp(/abc/gi);
      expect(isStorableInstance(sr)).toBe(true);
    });

    it("has typeTag 'RegExp@1'", () => {
      const sr = new StorableRegExp(/abc/);
      expect(sr.typeTag).toBe("RegExp@1");
    });

    it("wraps the original RegExp", () => {
      const re = /test/i;
      const sr = new StorableRegExp(re);
      expect(sr.regex).toBe(re);
    });

    it("is instanceof StorableNativeWrapper", () => {
      const sr = new StorableRegExp(/abc/);
      expect(sr instanceof StorableNativeWrapper).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // DECONSTRUCT
  // --------------------------------------------------------------------------

  describe("[DECONSTRUCT]", () => {
    it("returns source, flags, and flavor", () => {
      const sr = new StorableRegExp(/abc/gi);
      const state = sr[DECONSTRUCT]() as Record<string, StorableValue>;
      expect(state.source).toBe("abc");
      expect(state.flags).toBe("gi");
      expect(state.flavor).toBe("es2025");
    });

    it("returns correct source for complex pattern", () => {
      const sr = new StorableRegExp(/^foo\d+\.bar$/);
      const state = sr[DECONSTRUCT]() as Record<string, StorableValue>;
      expect(state.source).toBe("^foo\\d+\\.bar$");
      expect(state.flags).toBe("");
      expect(state.flavor).toBe("es2025");
    });

    it("returns empty flags for no-flag regexp", () => {
      const sr = new StorableRegExp(/abc/);
      const state = sr[DECONSTRUCT]() as Record<string, StorableValue>;
      expect(state.flags).toBe("");
    });

    it("rejects RegExp with extra enumerable properties", () => {
      const re = /abc/g;
      (re as unknown as Record<string, unknown>).custom = 1;
      const sr = new StorableRegExp(re);
      expect(() => sr[DECONSTRUCT]()).toThrow(
        "Cannot store RegExp with extra enumerable properties",
      );
    });
  });

  // --------------------------------------------------------------------------
  // RECONSTRUCT
  // --------------------------------------------------------------------------

  describe("[RECONSTRUCT]", () => {
    it("creates StorableRegExp from state", () => {
      const state = { source: "abc", flags: "gi" } as StorableValue;
      const result = StorableRegExp[RECONSTRUCT](state, dummyContext);
      expect(result).toBeInstanceOf(StorableRegExp);
      expect(result.regex.source).toBe("abc");
      expect(result.regex.flags).toBe("gi");
      expect(result.flavor).toBe("es2025");
    });

    it("defaults to empty source, flags, and es2025 flavor", () => {
      const state = {} as StorableValue;
      const result = StorableRegExp[RECONSTRUCT](state, dummyContext);
      expect(result.regex.source).toBe("(?:)");
      expect(result.regex.flags).toBe("");
      expect(result.flavor).toBe("es2025");
    });

    it("preserves explicit flavor from state", () => {
      const state = {
        source: "abc",
        flags: "g",
        flavor: "pcre2",
      } as StorableValue;
      const result = StorableRegExp[RECONSTRUCT](state, dummyContext);
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
      const sr = new StorableRegExp(original);
      const state = sr[DECONSTRUCT]();
      const restored = StorableRegExp[RECONSTRUCT](state, dummyContext);
      expect(restored.regex.source).toBe(original.source);
      expect(restored.regex.flags).toBe(original.flags);
      expect(restored.flavor).toBe("es2025");
    });

    it("round-trips with various flag combinations", () => {
      const flagSets = ["", "g", "i", "m", "s", "u", "y", "d", "gi", "gims"];
      for (const flags of flagSets) {
        const re = new RegExp("test", flags);
        const sr = new StorableRegExp(re);
        const state = sr[DECONSTRUCT]();
        const restored = StorableRegExp[RECONSTRUCT](state, dummyContext);
        expect(restored.regex.flags).toBe(re.flags);
        expect(restored.flavor).toBe("es2025");
      }
    });

    it("round-trips with custom flavor", () => {
      const sr = new StorableRegExp(/abc/gi, "pcre2");
      expect(sr.flavor).toBe("pcre2");
      const state = sr[DECONSTRUCT]();
      const restored = StorableRegExp[RECONSTRUCT](state, dummyContext);
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
      const sr = new StorableRegExp(re);
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
      const sr = new StorableRegExp(re);
      const result = sr.toNativeValue(true);
      expect(result).toBe(re); // same reference
    });

    it("toNativeValue(false) returns the original unfrozen RegExp", () => {
      const re = /abc/gi;
      const sr = new StorableRegExp(re);
      const result = sr.toNativeValue(false);
      expect(result).toBe(re); // same reference
      expect(Object.isFrozen(result)).toBe(false);
    });

    it("toNativeValue(false) returns unfrozen copy of frozen RegExp", () => {
      const re = Object.freeze(/abc/gi);
      const sr = new StorableRegExp(re);
      const result = sr.toNativeValue(false);
      expect(result).not.toBe(re);
      expect(result).toBeInstanceOf(RegExp);
      expect(result.source).toBe("abc");
      expect(result.flags).toBe("gi");
      expect(Object.isFrozen(result)).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Conversion: shallowStorableFromNativeValueRich
  // --------------------------------------------------------------------------

  describe("shallowStorableFromNativeValue (rich path)", () => {
    it("converts RegExp to StorableRegExp", () => {
      setStorableValueConfig({ richStorableValues: true });
      try {
        const result = shallowStorableFromNativeValue(/abc/gi);
        expect(result).toBeInstanceOf(StorableRegExp);
        expect((result as StorableRegExp).regex.source).toBe("abc");
        expect((result as StorableRegExp).regex.flags).toBe("gi");
      } finally {
        resetStorableValueConfig();
      }
    });

    it("rejects RegExp with extra enumerable properties", () => {
      setStorableValueConfig({ richStorableValues: true });
      try {
        const re = /abc/;
        (re as unknown as Record<string, unknown>).custom = 1;
        expect(() => shallowStorableFromNativeValue(re)).toThrow(
          "Cannot store RegExp with extra enumerable properties",
        );
      } finally {
        resetStorableValueConfig();
      }
    });
  });

  // --------------------------------------------------------------------------
  // Unwrapping: nativeValueFromStorableValue
  // --------------------------------------------------------------------------

  describe("nativeValueFromStorableValue", () => {
    it("unwraps StorableRegExp to frozen RegExp (default)", () => {
      const sr = new StorableRegExp(/abc/gi);
      const result = nativeValueFromStorableValue(sr as StorableValue);
      expect(result).toBeInstanceOf(RegExp);
      expect((result as RegExp).source).toBe("abc");
      expect((result as RegExp).flags).toBe("gi");
      expect(Object.isFrozen(result)).toBe(true);
    });

    it("unwraps StorableRegExp to unfrozen RegExp when frozen=false", () => {
      const sr = new StorableRegExp(/abc/gi);
      const result = nativeValueFromStorableValue(
        sr as StorableValue,
        false,
      );
      expect(result).toBeInstanceOf(RegExp);
      expect(Object.isFrozen(result)).toBe(false);
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
      setStorableValueConfig({ richStorableValues: true });
    });
    afterEach(() => {
      resetStorableValueConfig();
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

  describe("canonicalHash", () => {
    it("produces a hash for StorableRegExp", () => {
      const sr = new StorableRegExp(/abc/gi);
      const hash = canonicalHash(sr);
      expect(hash.hash).toBeInstanceOf(Uint8Array);
      expect(hash.hash.length).toBe(32); // SHA-256
    });

    it("same regex produces same hash", () => {
      const sr1 = new StorableRegExp(/abc/gi);
      const sr2 = new StorableRegExp(/abc/gi);
      const h1 = Array.from(canonicalHash(sr1).hash);
      const h2 = Array.from(canonicalHash(sr2).hash);
      expect(h1).toEqual(h2);
    });

    it("different source produces different hash", () => {
      const h1 = Array.from(canonicalHash(new StorableRegExp(/abc/)).hash);
      const h2 = Array.from(canonicalHash(new StorableRegExp(/def/)).hash);
      expect(h1).not.toEqual(h2);
    });

    it("different flags produce different hash", () => {
      const h1 = Array.from(canonicalHash(new StorableRegExp(/abc/g)).hash);
      const h2 = Array.from(canonicalHash(new StorableRegExp(/abc/i)).hash);
      expect(h1).not.toEqual(h2);
    });
  });
});
