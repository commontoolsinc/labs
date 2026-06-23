import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { FabricInstance, FabricPrimitive } from "@/interface.ts";
import { FabricCellLink } from "@/fabric-primitives/FabricCellLink.ts";
import { cloneIfNecessary } from "@/value-clone.ts";
import { isDeepFrozenFabricValue } from "@/deep-freeze.ts";
import { CODEC } from "@/codec-common/interface.ts";
import { CODEC_TYPE_TAGS } from "@/codec-common/codec-type-tags.ts";
import { EMPTY_RECONSTRUCTION_CONTEXT } from "@/codec-common/EmptyReconstructionContext.ts";
import { ProblematicValue } from "@/fabric-instances/ProblematicValue.ts";
import { jsonFromValue, valueFromJson } from "@/codec-json/index.ts";
import { hashOf } from "@/value-hash.ts";
import { shallowFabricFromNativeValue } from "@/fabric-value.ts";

describe("FabricCellLink", () => {
  // Pure type-identity / supertype check: cross-cutting carve-out per the
  // rule (doesn't fit a single member, isn't construction mechanics).
  it("extends `FabricPrimitive` (not `FabricInstance`)", () => {
    const link = new FabricCellLink({ id: "fid1:abc" });
    expect(link instanceof FabricPrimitive).toBe(true);
    expect(link instanceof FabricInstance).toBe(false);
  });

  describe("constructor()", () => {
    it("produces a deep-frozen instance", () => {
      // A `string[]` value makes the deep check meaningful: it confirms the
      // payload object _and_ its nested array are frozen, not just the top.
      const link = new FabricCellLink({ id: "fid1:abc", path: ["a", "b"] });
      expect(Object.isFrozen(link)).toBe(true);
      expect(isDeepFrozenFabricValue(link.payload)).toBe(true);
    });

    it("retains string and string-array payload fields", () => {
      const link = new FabricCellLink({
        id: "fid1:abc",
        path: ["a", "b", "c"],
        overwrite: "redirect",
      });
      expect(link.payload.id).toBe("fid1:abc");
      expect(link.payload.path).toEqual(["a", "b", "c"]);
      expect(link.payload.overwrite).toBe("redirect");
    });

    it("does not alias a mutable input object", () => {
      const input: Record<string, string | string[]> = { id: "fid1:abc" };
      const link = new FabricCellLink(input);
      input.id = "fid1:xyz";
      input.extra = "added";
      expect(link.payload.id).toBe("fid1:abc");
      expect("extra" in link.payload).toBe(false);
    });

    it("does not alias a mutable input array value", () => {
      const path = ["a", "b"];
      const link = new FabricCellLink({ path });
      path.push("c");
      expect(link.payload.path).toEqual(["a", "b"]);
    });

    it("identity-passes an already-deep-frozen payload (no needless copy)", () => {
      const frozen = cloneIfNecessary({ id: "fid1:abc", path: ["a", "b"] });
      const link = new FabricCellLink(frozen);
      expect(link.payload).toBe(frozen);
    });

    it("accepts an empty payload", () => {
      const link = new FabricCellLink({});
      expect(link.payload).toEqual({});
    });

    describe("validation", () => {
      it("rejects a non-plain-object payload", () => {
        expect(() =>
          new FabricCellLink([] as unknown as Record<string, string>)
        )
          .toThrow("must be a plain object");
      });

      it("rejects a prototype-pollution key", () => {
        const evil = JSON.parse('{ "__proto__": "x" }');
        expect(() => new FabricCellLink(evil)).toThrow("forbidden key");
      });

      it("rejects a non-string, non-string-array value", () => {
        expect(() => new FabricCellLink({ n: 42 as unknown as string }))
          .toThrow('field "n" must be');
      });

      it("rejects an array holding a non-string element", () => {
        expect(() => new FabricCellLink({ path: [1] as unknown as string[] }))
          .toThrow('field "path" must be');
      });

      it("rejects `null` as the payload", () => {
        expect(() =>
          new FabricCellLink(null as unknown as Record<string, string>)
        ).toThrow("must be a plain object");
      });

      it("rejects a primitive (non-object) payload", () => {
        expect(() => new FabricCellLink(7 as unknown as Record<string, string>))
          .toThrow("must be a plain object");
      });

      it("rejects a `constructor` key", () => {
        const evil = JSON.parse('{ "constructor": "x" }');
        expect(() => new FabricCellLink(evil)).toThrow("forbidden key");
      });

      it("rejects an object-valued field", () => {
        expect(() => new FabricCellLink({ id: {} as unknown as string }))
          .toThrow('field "id" must be');
      });

      it("rejects a nested array as an array element", () => {
        expect(() =>
          new FabricCellLink({ path: [["a"]] as unknown as string[] })
        ).toThrow('field "path" must be');
      });

      it("rejects a `null` field value", () => {
        expect(() => new FabricCellLink({ id: null as unknown as string }))
          .toThrow('field "id" must be');
      });
    });
  });

  describe("static members", () => {
    describe("[CODEC]", () => {
      const codec = FabricCellLink[CODEC];
      const expectedTag = CODEC_TYPE_TAGS.CellLink;
      const context = EMPTY_RECONSTRUCTION_CONTEXT;

      describe("recognizedTypeTag", () => {
        it("is the `CellLink` wire type tag", () => {
          expect(codec.recognizedTypeTag).toBe(expectedTag);
        });
      });

      describe("canEncode()", () => {
        it("claims a `FabricCellLink`, rejecting other values", () => {
          expect(codec.canEncode(new FabricCellLink({ id: "fid1:abc" })))
            .toBe(true);
          expect(codec.canEncode("not a cell link")).toBe(false);
        });
      });

      describe("encode()", () => {
        it("encodes to the plain addressing payload object", () => {
          const link = new FabricCellLink({
            id: "fid1:abc",
            path: ["a", "b"],
            overwrite: "redirect",
          });
          expect(codec.encode(link)).toEqual({
            id: "fid1:abc",
            path: ["a", "b"],
            overwrite: "redirect",
          });
        });
      });

      describe("decode()", () => {
        it("decodes non-object state to `ProblematicValue`", () => {
          expect(codec.decode(expectedTag, "nope", context))
            .toBeInstanceOf(ProblematicValue);
        });

        it("decodes a malformed payload value to `ProblematicValue`", () => {
          const decoded = codec.decode(expectedTag, { n: 42 }, context);
          expect(decoded).toBeInstanceOf(ProblematicValue);
        });
      });

      describe("round trip encode-decode", () => {
        it("round-trips strings and string arrays", () => {
          const link = new FabricCellLink({
            id: "fid1:abc",
            space: "did:key:z6Mk",
            path: ["x", "y", "z"],
          });
          const decoded = codec.decode(
            expectedTag,
            codec.encode(link),
            context,
          ) as FabricCellLink;
          expect(decoded).toBeInstanceOf(FabricCellLink);
          expect(decoded.payload).toEqual(link.payload);
        });
      });
    });
  });

  // Free functions exercising `FabricCellLink` rather than members of the class
  // itself, so they live directly under the class `describe()` (the
  // cross-cutting carve-out).
  describe("round-trip via `jsonFromValue()` / `valueFromJson()`", () => {
    it("round-trips a `FabricCellLink`", () => {
      const original = new FabricCellLink({
        id: "fid1:abc",
        path: ["a", "b"],
        overwrite: "this",
      });
      const restored = valueFromJson(jsonFromValue(original)) as FabricCellLink;
      expect(restored).toBeInstanceOf(FabricCellLink);
      expect(restored.payload).toEqual(original.payload);
    });
  });

  // `FabricCellLink` is inherently immutable (born deep-frozen), so it must be
  // passed through as-is by the dispatch sites that enumerate the special
  // primitives -- not fall into a "cannot handle this type" default.
  describe("inherently-immutable pass-through", () => {
    it("deep-clones a container holding one without throwing, passing it through", () => {
      const link = new FabricCellLink({ id: "fid1:abc", path: ["a", "b"] });
      // A mutable container forces an actual deep clone of the outer object,
      // which recurses into the nested `FabricCellLink`.
      const cloned = cloneIfNecessary({ link }, { frozen: true });
      expect(cloned.link).toBe(link);
    });

    it("passes through a forced mutable deep clone", () => {
      const link = new FabricCellLink({ id: "fid1:abc" });
      const cloned = cloneIfNecessary({ link }, { frozen: false });
      expect(cloned.link).toBe(link);
    });

    it("`shallowFabricFromNativeValue()` returns it as-is", () => {
      const link = new FabricCellLink({ id: "fid1:abc" });
      expect(shallowFabricFromNativeValue(link)).toBe(link);
    });
  });

  describe("hashOf()", () => {
    it("produces a 32-byte (SHA-256) hash for a `FabricCellLink`", () => {
      const hash = hashOf(new FabricCellLink({ id: "fid1:abc" }));
      expect(hash.bytes).toBeInstanceOf(Uint8Array);
      expect(hash.length).toBe(32);
    });

    it("produces the same hash for equal payloads", () => {
      const h1 = hashOf(new FabricCellLink({ id: "fid1:abc" })).bytes;
      const h2 = hashOf(new FabricCellLink({ id: "fid1:abc" })).bytes;
      expect(h1).toEqual(h2);
    });

    it("produces a different hash for a different payload", () => {
      const h1 = hashOf(new FabricCellLink({ id: "fid1:abc" })).bytes;
      const h2 = hashOf(new FabricCellLink({ id: "fid1:xyz" })).bytes;
      expect(h1).not.toEqual(h2);
    });
  });
});
