/**
 * An immutable byte sequence, and the copying that immutability costs.
 *
 * The constructor cannot simply hold the array it was handed, since the caller
 * still has a reference and could write through it, so the bytes are copied in
 * -- with an opt-in transfer for a caller willing to give up its own access.
 * Reads pay the same way round: a slice hands back a copy rather than a view.
 *
 * The cases that need stating are where a byte count meets an empty or
 * exhausted range. Empty bytes encode to the empty string, and a copy whose
 * offset is at or past the end copies nothing rather than failing.
 */

import { JSON_CODEC } from "@/interface.ts";
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { FabricInstance, FabricPrimitive } from "@/interface.ts";
import { FabricBytes } from "@/fabric-primitives/FabricBytes.ts";
import { CODEC_TYPE_TAGS } from "@/codec-interface/codec-type-tags.ts";
import { EMPTY_RECONSTRUCTION_CONTEXT } from "@/codec-interface/EmptyReconstructionContext.ts";
import { ProblematicValue } from "@/codec-common/ProblematicValue.ts";

describe("FabricBytes", () => {
  // Pure type-identity / supertype check: cross-cutting carve-out per the
  // rule (doesn't fit a single member, isn't construction mechanics).
  it("extends `FabricPrimitive` (not `FabricInstance`)", () => {
    const fb = new FabricBytes(new Uint8Array([1, 2, 3]));
    expect(fb instanceof FabricPrimitive).toBe(true);
    expect(fb instanceof FabricInstance).toBe(false);
  });

  describe("constructor()", () => {
    it("produces an always-frozen instance", () => {
      const fb = new FabricBytes(new Uint8Array([1, 2, 3]));
      expect(Object.isFrozen(fb)).toBe(true);
    });

    it("copies the input bytes", () => {
      const original = new Uint8Array([1, 2, 3]);
      const fb = new FabricBytes(original);
      original[0] = 99; // mutate original
      expect(fb.slice()[0]).toBe(1); // unaffected
    });

    it("leaves the source array readable, by default", () => {
      const original = new Uint8Array([1, 2, 3]);
      new FabricBytes(original);
      expect(original.length).toBe(3);
    });

    it("consumes the source array, given `transfer` as `true`", () => {
      const original = new Uint8Array([1, 2, 3]);
      const fb = new FabricBytes(original, true);

      expect(original.length).toBe(0); // Its buffer was detached.
      expect(fb.slice()).toEqual(new Uint8Array([1, 2, 3]));
      expect(fb.length).toBe(3);
    });
  });

  describe("instance members", () => {
    describe(".length", () => {
      it("returns the byte count", () => {
        expect(new FabricBytes(new Uint8Array([1, 2, 3])).length).toBe(3);
        expect(new FabricBytes(new Uint8Array()).length).toBe(0);
      });
    });

    describe("slice()", () => {
      it("returns a copy of the bytes", () => {
        const original = new Uint8Array([10, 20, 30]);
        const fb = new FabricBytes(original);
        const sliced = fb.slice();
        expect(sliced).toEqual(new Uint8Array([10, 20, 30]));
        // Must be a copy, not the same reference.
        sliced[0] = 99;
        expect(fb.slice()[0]).toBe(10);
      });

      it("returns a sub-range given start and end", () => {
        const fb = new FabricBytes(new Uint8Array([1, 2, 3, 4, 5]));
        expect(fb.slice(1, 3)).toEqual(new Uint8Array([2, 3]));
        expect(fb.slice(3)).toEqual(new Uint8Array([4, 5]));
      });
    });

    describe("copyInto()", () => {
      it("copies bytes into the target", () => {
        const fb = new FabricBytes(new Uint8Array([10, 20, 30, 40]));
        const target = new Uint8Array(4);
        const copied = fb.copyInto(target);
        expect(copied).toBe(4);
        expect(target).toEqual(new Uint8Array([10, 20, 30, 40]));
      });

      it("respects offset and length", () => {
        const fb = new FabricBytes(new Uint8Array([10, 20, 30, 40, 50]));
        const target = new Uint8Array(2);
        const copied = fb.copyInto(target, 1, 2);
        expect(copied).toBe(2);
        expect(target).toEqual(new Uint8Array([20, 30]));
      });

      it("throws on negative offset", () => {
        const fb = new FabricBytes(new Uint8Array([1, 2, 3]));
        const target = new Uint8Array(3);
        expect(() => fb.copyInto(target, -1)).toThrow(RangeError);
      });

      it("throws on negative length", () => {
        const fb = new FabricBytes(new Uint8Array([1, 2, 3]));
        const target = new Uint8Array(3);
        expect(() => fb.copyInto(target, 0, -1)).toThrow(RangeError);
      });

      it("copies nothing when the offset is at or past the end", () => {
        const fb = new FabricBytes(new Uint8Array([1, 2, 3]));
        const target = new Uint8Array([9, 9, 9]);

        expect(fb.copyInto(target, 3)).toBe(0);
        expect(fb.copyInto(target, 4)).toBe(0);
        expect(target).toEqual(new Uint8Array([9, 9, 9]));
      });

      it("copies nothing from an empty source", () => {
        const fb = new FabricBytes(new Uint8Array());
        const target = new Uint8Array([9]);

        expect(fb.copyInto(target)).toBe(0);
        expect(target).toEqual(new Uint8Array([9]));
      });
    });
  });

  describe("static members", () => {
    describe("`[JSON_CODEC]`", () => {
      const codec = FabricBytes[JSON_CODEC];
      const expectedTag = CODEC_TYPE_TAGS.Bytes;
      const context = EMPTY_RECONSTRUCTION_CONTEXT;

      describe("recognizedTypeTag", () => {
        it("is the `Bytes` wire type tag", () => {
          expect(codec.recognizedTypeTag).toBe(expectedTag);
        });
      });

      describe("canEncode()", () => {
        it("claims a `FabricBytes`, rejecting other values", () => {
          expect(codec.canEncode(new FabricBytes(new Uint8Array([1, 2, 3]))))
            .toBe(true);
          expect(codec.canEncode("not bytes")).toBe(false);
        });
      });

      describe("encode()", () => {
        it("encodes to an unpadded base64url string", () => {
          // [1, 2, 3] -> base64url "AQID".
          const fb = new FabricBytes(new Uint8Array([1, 2, 3]));
          expect(codec.encode(fb)).toBe("AQID");
        });

        it("encodes empty bytes to the empty string", () => {
          const fb = new FabricBytes(new Uint8Array());
          expect(codec.encode(fb)).toBe("");
        });
      });

      describe("decode()", () => {
        it("decodes non-string state to a `ProblematicValue`", () => {
          const decoded = codec.decode(expectedTag, 42, context);
          expect(decoded).toBeInstanceOf(ProblematicValue);
        });

        it("decodes malformed base64 to a `ProblematicValue`", () => {
          const decoded = codec.decode(
            expectedTag,
            "not valid base64!!",
            context,
          );
          expect(decoded).toBeInstanceOf(ProblematicValue);
        });
      });

      describe("round trip encode-decode", () => {
        it("round-trips via encode -> decode", () => {
          const fb = new FabricBytes(new Uint8Array([10, 20, 30, 40]));
          const decoded = codec.decode(
            expectedTag,
            codec.encode(fb),
            context,
          ) as unknown as FabricBytes;
          expect(decoded).toBeInstanceOf(FabricBytes);
          expect(decoded.slice()).toEqual(new Uint8Array([10, 20, 30, 40]));
        });

        it("round-trips empty bytes", () => {
          const fb = new FabricBytes(new Uint8Array());
          const decoded = codec.decode(
            expectedTag,
            codec.encode(fb),
            context,
          ) as unknown as FabricBytes;
          expect(decoded).toBeInstanceOf(FabricBytes);
          expect(decoded.length).toBe(0);
        });
      });
    });
  });
});
