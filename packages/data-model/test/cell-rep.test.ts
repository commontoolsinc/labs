import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { FabricHash } from "@/fabric-primitives/FabricHash.ts";
import {
  type EntityRef,
  entityRefFrom,
  entityRefFromString,
  entityRefToString,
  isEntityRef,
  resetModernCellRepConfig,
  setModernCellRepConfig,
} from "@/cell-rep.ts";

/** A fixed 32-byte hash for deterministic tests. */
const SAMPLE_HASH = new Uint8Array(32);
for (let i = 0; i < 32; i++) SAMPLE_HASH[i] = i;

const HASH = new FabricHash(SAMPLE_HASH, "fid1");
const TAGGED = HASH.taggedHashString; // "fid1:…"

describe("cell-rep entity-id reference", () => {
  afterEach(() => {
    resetModernCellRepConfig();
  });

  describe("with the flag OFF (legacy plain-object form)", () => {
    it('produces a `{ "/": string }` object from a string', () => {
      const ref = entityRefFromString(TAGGED);
      expect(ref).toEqual({ "/": TAGGED });
      expect(ref).not.toBeInstanceOf(FabricHash);
    });

    it('produces a `{ "/": string }` object from a FabricHash', () => {
      expect(entityRefFrom(HASH)).toEqual({ "/": TAGGED });
    });

    it("recognizes the plain-object form, not a FabricHash", () => {
      expect(isEntityRef({ "/": TAGGED })).toBe(true);
      expect(isEntityRef(HASH)).toBe(false);
      expect(isEntityRef(undefined)).toBe(false);
      expect(isEntityRef("plain string")).toBe(false);
    });

    it("extracts the tagged hash string from the plain-object form", () => {
      expect(entityRefToString({ "/": TAGGED })).toBe(TAGGED);
    });

    it("throws extracting from a FabricHash (wrong regime)", () => {
      expect(() => entityRefToString(HASH as EntityRef)).toThrow();
    });
  });

  describe("with the flag ON (modern FabricHash form)", () => {
    it("produces a FabricHash from a string", () => {
      setModernCellRepConfig(true);
      const ref = entityRefFromString(TAGGED);
      expect(ref).toBeInstanceOf(FabricHash);
      expect((ref as FabricHash).taggedHashString).toBe(TAGGED);
    });

    it("returns the FabricHash unchanged from a FabricHash", () => {
      setModernCellRepConfig(true);
      expect(entityRefFrom(HASH)).toBe(HASH);
    });

    it("recognizes a FabricHash, not the plain-object form", () => {
      setModernCellRepConfig(true);
      expect(isEntityRef(HASH)).toBe(true);
      expect(isEntityRef({ "/": TAGGED })).toBe(false);
    });

    it("extracts the tagged hash string from a FabricHash", () => {
      setModernCellRepConfig(true);
      expect(entityRefToString(HASH)).toBe(TAGGED);
    });

    it("throws extracting from the plain-object form (wrong regime)", () => {
      setModernCellRepConfig(true);
      expect(() => entityRefToString({ "/": TAGGED } as EntityRef)).toThrow();
    });
  });

  it("round-trips a string through both forms in each regime", () => {
    for (const enabled of [false, true]) {
      setModernCellRepConfig(enabled);
      expect(entityRefToString(entityRefFromString(TAGGED))).toBe(TAGGED);
      expect(entityRefToString(entityRefFrom(HASH))).toBe(TAGGED);
      resetModernCellRepConfig();
    }
  });
});
