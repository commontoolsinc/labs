import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { FabricHash } from "@/fabric-primitives/FabricHash.ts";
import { CODEC } from "@/codec-common/interface.ts";
import { CODEC_TYPE_TAGS } from "@/codec-common/codec-type-tags.ts";
import { EMPTY_RECONSTRUCTION_CONTEXT } from "@/codec-common/EmptyReconstructionContext.ts";
import { ProblematicValue } from "@/fabric-instances/ProblematicValue.ts";

/** A fixed 32-byte hash for deterministic tests. */
const SAMPLE_HASH = new Uint8Array(32);
for (let i = 0; i < 32; i++) SAMPLE_HASH[i] = i;

/** A fixed 17-byte hash for deterministic tests. */
const SAMPLE_HASH_17 = new Uint8Array(17);
for (let i = 0; i < 17; i++) SAMPLE_HASH_17[i] = ((i * 17) + 177) & 0xff;

describe("FabricHash", () => {
  describe("instance members", () => {
    describe("toString()", () => {
      it("produces `fid1:<base64>` format", () => {
        const cid = new FabricHash(SAMPLE_HASH, "fid1");
        const str = cid.toString();
        expect(str.startsWith("fid1:")).toBe(true);
      });
    });

    describe(".taggedHashString", () => {
      it("produces `fid1:<base64>` format", () => {
        const cid = new FabricHash(SAMPLE_HASH, "fid1");
        const str = cid.taggedHashString;
        expect(str.startsWith("fid1:")).toBe(true);
      });
    });

    describe("toJSON()", () => {
      it("produces `{ '/': 'fid1:<base64>' }`", () => {
        const cid = new FabricHash(SAMPLE_HASH, "fid1");
        const json = cid.toJSON();
        expect(typeof json["/"]).toBe("string");
        expect(json["/"].startsWith("fid1:")).toBe(true);
        expect(json["/"]).toBe(cid.toString());
      });
    });

    describe(".bytes", () => {
      it("returns a defensive copy", () => {
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
    });

    describe(".length", () => {
      it("returns the byte length of `.bytes`", () => {
        const cid1 = new FabricHash(SAMPLE_HASH, "fid1");
        expect(cid1.length).toEqual(cid1.bytes.length);

        const cid2 = new FabricHash(SAMPLE_HASH_17, "fake17");
        expect(cid2.length).toEqual(17);
        expect(cid2.length).toEqual(cid2.bytes.length);
      });
    });

    describe("copyInto()", () => {
      it("copies hash bytes into the target buffer", () => {
        const cid = new FabricHash(SAMPLE_HASH, "sha3");
        const target = new Uint8Array(32);
        const returned = cid.copyInto(target);
        // Returns the same target buffer.
        expect(returned).toBe(target);
        expect(target).toEqual(cid.bytes);
        expect(cid.tag).toBe("sha3");
      });
    });

    describe(".hashString", () => {
      it("returns base64url without the algorithm tag", () => {
        const cid = new FabricHash(SAMPLE_HASH, "fid1");
        const hs = cid.hashString;
        // Must be a string, not contain the algorithm tag prefix.
        expect(typeof hs).toBe("string");
        expect(hs.includes("fid1")).toBe(false);
        expect(hs.includes(":")).toBe(false);
        // toString() should be tag + ":" + hashString.
        expect(cid.toString()).toBe(`fid1:${hs}`);
      });

      it("is stable across calls", () => {
        const cid = new FabricHash(SAMPLE_HASH, "fid1");
        expect(cid.hashString).toBe(cid.hashString);
      });

      it("differs for different hashes", () => {
        const hash2 = new Uint8Array(32);
        hash2.fill(0xff);
        const cid1 = new FabricHash(SAMPLE_HASH, "fid1");
        const cid2 = new FabricHash(hash2, "fid1");
        expect(cid1.hashString).not.toBe(cid2.hashString);
      });
    });
  });

  describe("static members", () => {
    describe("fromJson()", () => {
      it("works on the result of the instance method `toJSON()`", () => {
        const original = new FabricHash(SAMPLE_HASH, "fid1");
        const json = original.toJSON();
        const reconstructed = FabricHash.fromJson(json);

        expect(reconstructed).toBeInstanceOf(FabricHash);
        expect(reconstructed.toString()).toBe(original.toString());
        expect(reconstructed.bytes).toEqual(original.bytes);
      });
    });

    describe("fromString()", () => {
      it("works on the result of the instance method `toString()`", () => {
        // Use a non-fid1 tag to verify the parser doesn't hardcode it.
        const original = new FabricHash(SAMPLE_HASH, "sha3");
        const str = original.toString();
        const reconstructed = FabricHash.fromString(str);

        expect(reconstructed).toBeInstanceOf(FabricHash);
        expect(reconstructed.toString()).toBe(original.toString());
        expect(reconstructed.bytes).toEqual(original.bytes);
        expect(reconstructed.tag).toBe("sha3");
      });

      it("throws on invalid format (no colon)", () => {
        expect(() => FabricHash.fromString("nocolonhere")).toThrow(
          "Invalid content hash string",
        );
      });
    });

    describe("[CODEC]", () => {
      const codec = FabricHash[CODEC];
      const expectedTag = CODEC_TYPE_TAGS.Hash;
      const context = EMPTY_RECONSTRUCTION_CONTEXT;

      describe("recognizedTypeTag", () => {
        it("is the `Hash` wire type tag", () => {
          expect(codec.recognizedTypeTag).toBe(expectedTag);
        });
      });

      describe("canEncode()", () => {
        it("claims a `FabricHash`, rejecting other values", () => {
          expect(codec.canEncode(new FabricHash(SAMPLE_HASH, "fid1"))).toBe(
            true,
          );
          expect(codec.canEncode("not a hash")).toBe(false);
        });
      });

      describe("encode()", () => {
        it("encodes to a `{ tag, hash }` object", () => {
          const cid = new FabricHash(SAMPLE_HASH, "fid1");
          expect(codec.encode(cid)).toEqual({
            tag: "fid1",
            hash: cid.hashString,
          });
        });
      });

      describe("decode()", () => {
        it("decodes a `{ tag, hash }` object back to a `FabricHash`", () => {
          const cid = new FabricHash(SAMPLE_HASH, "fid1");
          const decoded = codec.decode(
            expectedTag,
            { tag: "fid1", hash: cid.hashString },
            context,
          );
          expect(decoded).toBeInstanceOf(FabricHash);
          expect((decoded as FabricHash).taggedHashString).toBe(
            cid.taggedHashString,
          );
        });

        it("decodes non-object state to a `ProblematicValue`", () => {
          const decoded = codec.decode(expectedTag, 123, context);
          expect(decoded).toBeInstanceOf(ProblematicValue);
        });

        it("decodes missing/non-string fields to a `ProblematicValue`", () => {
          const decoded = codec.decode(
            expectedTag,
            { tag: "fid1" },
            context,
          );
          expect(decoded).toBeInstanceOf(ProblematicValue);
        });

        it("decodes a malformed base64 `hash` to a `ProblematicValue`", () => {
          const decoded = codec.decode(
            expectedTag,
            { tag: "fid1", hash: "not valid base64!!" },
            context,
          );
          expect(decoded).toBeInstanceOf(ProblematicValue);
        });
      });

      describe("round trip encode-decode", () => {
        it("round-trips via encode -> decode (non-`fid1` tag)", () => {
          const cid = new FabricHash(SAMPLE_HASH_17, "sha3");
          const decoded = codec.decode(
            expectedTag,
            codec.encode(cid),
            context,
          );
          expect(decoded).toBeInstanceOf(FabricHash);
          expect((decoded as FabricHash).tag).toBe("sha3");
          expect((decoded as FabricHash).bytes).toEqual(cid.bytes);
        });
      });
    });
  });
});
