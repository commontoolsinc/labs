import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { FabricHash } from "../FabricHash.ts";

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

  it("`.taggedHashString` produces fid1:<base64> format", () => {
    const cid = new FabricHash(SAMPLE_HASH, "fid1");
    const str = cid.taggedHashString;
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

describe("static methods", () => {
  it("FabricHash.fromJson() works on the result of instance method FabricHash.toJSON()", () => {
    const original = new FabricHash(SAMPLE_HASH, "fid1");
    const json = original.toJSON();
    const reconstructed = FabricHash.fromJson(json);

    expect(reconstructed).toBeInstanceOf(FabricHash);
    expect(reconstructed.toString()).toBe(original.toString());
    expect(reconstructed.bytes).toEqual(original.bytes);
  });

  it("FabricHash.fromString() works on the result of instance method FabricHash.toString()", () => {
    // Use a non-fid1 tag to verify the parser doesn't hardcode it.
    const original = new FabricHash(SAMPLE_HASH, "sha3");
    const str = original.toString();
    const reconstructed = FabricHash.fromString(str);

    expect(reconstructed).toBeInstanceOf(FabricHash);
    expect(reconstructed.toString()).toBe(original.toString());
    expect(reconstructed.bytes).toEqual(original.bytes);
    expect(reconstructed.tag).toBe("sha3");
  });

  it("FabricHash.fromString() throws on invalid format (no colon)", () => {
    expect(() => FabricHash.fromString("nocolonhere")).toThrow(
      "Invalid content hash string",
    );
  });
});
