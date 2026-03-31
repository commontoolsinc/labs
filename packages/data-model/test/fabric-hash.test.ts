import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import * as Reference from "merkle-reference";
import { FabricHash } from "../fabric-hash.ts";
import {
  hashObjectFromJson,
  hashObjectFromString,
  hashOf,
  isHashObject,
  resetModernHashConfig,
  setModernHashConfig,
} from "../value-hash.ts";

/** A fixed 32-byte hash for deterministic tests. */
const SAMPLE_HASH = new Uint8Array(32);
for (let i = 0; i < 32; i++) SAMPLE_HASH[i] = i;

/** A fixed 17-byte hash for deterministic tests. */
const SAMPLE_HASH_17 = new Uint8Array(17);
for (let i = 0; i < 17; i++) SAMPLE_HASH_17[i] = ((i * 17) + 177) & 0xff;

// -----------------------------------------------------------------
// FabricHash extensions
// -----------------------------------------------------------------

describe("FabricHash", () => {
  it("toString() produces fid1:<base64> format", () => {
    const cid = new FabricHash(SAMPLE_HASH, "fid1");
    const str = cid.toString();
    expect(str.startsWith("fid1:")).toBe(true);
  });

  it("toJSON() produces { '/': 'fid1:<base64>' }", () => {
    const cid = new FabricHash(SAMPLE_HASH, "fid1");
    const json = cid.toJSON();
    expect(typeof json["/"]).toBe("string");
    expect(json["/"].startsWith("fid1:")).toBe(true);
    expect(json["/"]).toBe(cid.toString());
  });

  it(".bytes returns a defensive copy", () => {
    const cid = new FabricHash(SAMPLE_HASH, "fid1");
    const bytes = cid.bytes;
    // Contents match.
    expect(bytes).toEqual(SAMPLE_HASH);
    // Each call returns a fresh copy.
    expect(bytes).not.toBe(cid.bytes);
    // Mutating the copy must not affect the original.
    bytes[0] = 0xff;
    expect(cid.bytes[0]).toBe(0);
  });

  it(".length returns the byte length of .bytes", () => {
    const cid1 = new FabricHash(SAMPLE_HASH, "fid1");
    expect(cid1.length).toEqual(cid1.bytes.length);

    const cid2 = new FabricHash(SAMPLE_HASH_17, "fake17");
    expect(cid2.length).toEqual(17);
    expect(cid2.length).toEqual(cid2.bytes.length);
  });

  it("copyInto copies hash bytes into target buffer", () => {
    const cid = new FabricHash(SAMPLE_HASH, "sha3");
    const target = new Uint8Array(32);
    const returned = cid.copyInto(target);
    // Returns the same target buffer.
    expect(returned).toBe(target);
    expect(target).toEqual(cid.bytes);
    expect(cid.tag).toBe("sha3");
  });

  it('["/"] getter returns a copy of the raw hash bytes', () => {
    const cid = new FabricHash(SAMPLE_HASH, "test2");
    const slash = cid["/"];
    expect(slash).toEqual(SAMPLE_HASH);
    // Each call returns a fresh copy.
    expect(slash).not.toBe(cid["/"]);
    expect(cid.tag).toBe("test2");
  });

  it(".hashString returns base64url without algorithm tag", () => {
    const cid = new FabricHash(SAMPLE_HASH, "fid1");
    const hs = cid.hashString;
    // Must be a string, not contain the algorithm tag prefix.
    expect(typeof hs).toBe("string");
    expect(hs.includes("fid1")).toBe(false);
    expect(hs.includes(":")).toBe(false);
    // toString() should be tag + ":" + hashString.
    expect(cid.toString()).toBe(`fid1:${hs}`);
  });

  it(".hashString is stable across calls", () => {
    const cid = new FabricHash(SAMPLE_HASH, "fid1");
    expect(cid.hashString).toBe(cid.hashString);
  });

  it(".hashString differs for different hashes", () => {
    const hash2 = new Uint8Array(32);
    hash2.fill(0xff);
    const cid1 = new FabricHash(SAMPLE_HASH, "fid1");
    const cid2 = new FabricHash(hash2, "fid1");
    expect(cid1.hashString).not.toBe(cid2.hashString);
  });
});

// -----------------------------------------------------------------
// Flag-conditional dispatch
// -----------------------------------------------------------------

describe("FabricHash flag dispatch", () => {
  it("hashObjectFromJson round-trips through FabricHash when canonical hashing is on", () => {
    setModernHashConfig(true);
    try {
      const original = new FabricHash(SAMPLE_HASH, "fid1");
      const json = original.toJSON();
      const reconstructed = hashObjectFromJson(json);

      expect(reconstructed).toBeInstanceOf(FabricHash);
      const cid = reconstructed as unknown as FabricHash;
      expect(cid.toString()).toBe(original.toString());
      expect(cid.bytes).toEqual(original.bytes);
    } finally {
      resetModernHashConfig();
    }
  });

  it("hashObjectFromString round-trips through FabricHash when modern hashing is on", () => {
    setModernHashConfig(true);
    try {
      // Use a non-fid1 tag to verify the parser doesn't hardcode it.
      const original = new FabricHash(SAMPLE_HASH, "sha3");
      const str = original.toString();
      const reconstructed = hashObjectFromString(str);

      expect(reconstructed).toBeInstanceOf(FabricHash);
      const cid = reconstructed as unknown as FabricHash;
      expect(cid.toString()).toBe(original.toString());
      expect(cid.bytes).toEqual(original.bytes);
      expect(cid.tag).toBe("sha3");
    } finally {
      resetModernHashConfig();
    }
  });

  it("hashObjectFromString throws on invalid format (no colon) when modern hashing is on", () => {
    setModernHashConfig(true);
    try {
      expect(() => hashObjectFromString("nocolonhere")).toThrow(
        "Invalid content hash string",
      );
    } finally {
      resetModernHashConfig();
    }
  });

  it("isHashObject returns true for FabricHash when modern hashing is on", () => {
    setModernHashConfig(true);
    try {
      const cid = new FabricHash(SAMPLE_HASH, "fid1");
      expect(isHashObject(cid)).toBe(true);
    } finally {
      resetModernHashConfig();
    }
  });

  it("isHashObject returns false for FabricHash when modern hashing is off", () => {
    setModernHashConfig(false);
    try {
      const cid = new FabricHash(SAMPLE_HASH, "fid1");
      expect(isHashObject(cid)).toBe(false);
    } finally {
      resetModernHashConfig();
    }
  });

  it("isHashObject returns true for Reference.View when legacy hashing is on", () => {
    setModernHashConfig(false);
    try {
      const ref = hashOf({ hello: "world" });
      expect(Reference.is(ref)).toBe(true);
      expect(isHashObject(ref)).toBe(true);
    } finally {
      resetModernHashConfig();
    }
  });

  it("isHashObject returns false for Reference.View when modern hashing is on", () => {
    setModernHashConfig(true);
    try {
      // Create a legacy ref while legacy mode is temporarily active.
      setModernHashConfig(false);
      const ref = hashOf({ hello: "world" });
      expect(Reference.is(ref)).toBe(true);

      // Switch to modern mode — legacy refs should not be recognized.
      setModernHashConfig(true);
      expect(isHashObject(ref)).toBe(false);
    } finally {
      resetModernHashConfig();
    }
  });

  it("hashOf() returns FabricHash when canonical hashing is on", () => {
    setModernHashConfig(true);
    try {
      const result = hashOf({ hello: "world" });
      expect(result).toBeInstanceOf(FabricHash);
    } finally {
      resetModernHashConfig();
    }
  });

  it("nested hashOf() works when canonical hashing is on (no throw on FabricHash in value tree)", () => {
    setModernHashConfig(true);
    try {
      // First hashOf produces a FabricHash.
      const innerRef = hashOf({ the: "text/plain", of: "entity:123" });
      expect(innerRef).toBeInstanceOf(FabricHash);

      // Wrap it in a fact-like structure and hashOf again. hashOfModern
      // handles FabricHash via TAG_CONTENT_ID, so this must not throw.
      const outerSource = {
        cause: innerRef,
        the: "text/plain",
        of: "entity:456",
        is: { value: 42 },
      };
      const outerRef = hashOf(outerSource);
      expect(outerRef).toBeInstanceOf(FabricHash);
    } finally {
      resetModernHashConfig();
    }
  });

  it("hashOf() returns Reference.View when canonical hashing is off", () => {
    // Explicitly pin canonical hashing off rather than relying on ambient
    // default, so this step exercises the legacy path even if the default
    // changes.
    setModernHashConfig(false);
    try {
      const result = hashOf({ test: true });
      expect(Reference.is(result)).toBe(true);
      expect(result).not.toBeInstanceOf(FabricHash);
    } finally {
      resetModernHashConfig();
    }
  });
});
