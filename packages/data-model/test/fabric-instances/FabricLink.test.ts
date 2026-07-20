import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { FabricInstance, FabricPrimitive } from "@/interface.ts";
import {
  DEEP_FREEZE,
  IS_DEEP_FROZEN,
} from "@/fabric-instances/BaseFabricInstance.ts";
import { FabricLink } from "@/fabric-instances/FabricLink.ts";
import { deepFreeze, isDeepFrozen } from "@/deep-freeze.ts";
import { subFreeze, subIsDeepFrozen } from "./fixtures.ts";
import { cloneIfNecessary } from "@/value-clone.ts";
import { CODEC } from "@/codec-common/interface.ts";
import { CODEC_TYPE_TAGS } from "@/codec-common/codec-type-tags.ts";
import { EMPTY_RECONSTRUCTION_CONTEXT } from "@/codec-common/EmptyReconstructionContext.ts";
import { ProblematicValue } from "@/fabric-instances/ProblematicValue.ts";
import { jsonFromValue, valueFromJson } from "@/codec-json/index.ts";
import { hashOf } from "@/value-hash.ts";

describe("FabricLink", () => {
  // Pure type-identity / supertype check: cross-cutting carve-out per the
  // rule (doesn't fit a single member, isn't construction mechanics).
  it("extends `FabricInstance` (not `FabricPrimitive`)", () => {
    const link = new FabricLink({ id: "fid1:abc" });
    expect(link instanceof FabricInstance).toBe(true);
    expect(link instanceof FabricPrimitive).toBe(false);
  });

  describe("constructor()", () => {
    it("wraps and exposes the payload", () => {
      const payload = {
        id: "fid1:abc",
        path: ["a", "b"],
        overwrite: "redirect",
      };
      const link = new FabricLink(payload);
      expect(link.payload).toBe(payload);
    });

    it("is mutable until frozen (not born frozen, unlike a primitive)", () => {
      expect(Object.isFrozen(new FabricLink({ id: "fid1:abc" }))).toBe(false);
    });

    it("accepts a payload with a non-string (schema) value — an outgoing ref", () => {
      const link = new FabricLink({
        id: "fid1:abc",
        schema: { type: "object", properties: { x: { type: "string" } } },
      });
      expect(link.payload.schema).toEqual({
        type: "object",
        properties: { x: { type: "string" } },
      });
    });

    it("accepts an empty payload", () => {
      expect(new FabricLink({}).payload).toEqual({});
    });

    describe("validation", () => {
      it("rejects a non-plain-object payload", () => {
        expect(() => new FabricLink([] as unknown as Record<string, never>))
          .toThrow("must be a plain object");
      });

      it("rejects `null`", () => {
        expect(() => new FabricLink(null as unknown as Record<string, never>))
          .toThrow("must be a plain object");
      });

      it("rejects a `__proto__` key", () => {
        const evil = JSON.parse('{ "__proto__": "x" }');
        expect(() => new FabricLink(evil)).toThrow("forbidden key");
      });

      it("rejects a `constructor` key", () => {
        const evil = JSON.parse('{ "constructor": "x" }');
        expect(() => new FabricLink(evil)).toThrow("forbidden key");
      });
    });
  });

  describe("deep-freeze protocol", () => {
    it("`deepFreeze()` freezes the instance, its payload, and nested values", () => {
      const link = new FabricLink({
        id: "fid1:abc",
        schema: { type: "object" },
      });
      const frozen = deepFreeze(link);
      expect(frozen).toBe(link); // frozen in place
      expect(isDeepFrozen(frozen)).toBe(true);
      expect(Object.isFrozen(frozen.payload)).toBe(true);
      expect(Object.isFrozen(frozen.payload.schema)).toBe(true);
    });

    it("`isDeepFrozen()` is false for a mutable instance", () => {
      expect(isDeepFrozen(new FabricLink({ id: "fid1:abc" }))).toBe(false);
    });

    it("`[IS_DEEP_FROZEN]` (direct) is false before, true after `[DEEP_FREEZE]`", () => {
      // Direct member invocation: `isDeepFrozen()` short-circuits via
      // `deepFreeze()`'s cache, so the protocol method only runs when called
      // straight, as here.
      const link = new FabricLink({ id: "fid1:abc", path: ["a"] });
      expect(link[IS_DEEP_FROZEN](subIsDeepFrozen)).toBe(false);
      link[DEEP_FREEZE](subFreeze);
      expect(link[IS_DEEP_FROZEN](subIsDeepFrozen)).toBe(true);
    });
  });

  describe("deepClone()", () => {
    it("frozen clone is deep-frozen with an equal payload", () => {
      const link = new FabricLink({ id: "fid1:abc", path: ["a"] });
      const clone = link.deepClone(true);
      expect(isDeepFrozen(clone)).toBe(true);
      expect(clone.payload).toEqual(link.payload);
    });

    it("identity-returns an already-deep-frozen instance", () => {
      const link = deepFreeze(new FabricLink({ id: "fid1:abc" }));
      expect(link.deepClone(true)).toBe(link);
    });

    it("mutable clone is independent (no shared payload structure)", () => {
      const link = new FabricLink({ id: "fid1:abc" });
      const clone = link.deepClone(false);
      expect(Object.isFrozen(clone)).toBe(false);
      expect(clone.payload).not.toBe(link.payload);
      clone.payload.id = "fid1:xyz";
      expect(link.payload.id).toBe("fid1:abc");
    });
  });

  describe("shallowClone()", () => {
    it("mutable shallow clone shares the payload reference", () => {
      const link = new FabricLink({ id: "fid1:abc" });
      const clone = link.shallowClone(false) as FabricLink;
      expect(clone).not.toBe(link);
      expect(clone.payload).toBe(link.payload);
    });

    it("identity-returns an already-frozen instance when asked for frozen", () => {
      const link = deepFreeze(new FabricLink({ id: "fid1:abc" }));
      expect(link.shallowClone(true)).toBe(link);
    });
  });

  describe("static members", () => {
    describe("[CODEC]", () => {
      const codec = FabricLink[CODEC];
      const expectedTag = CODEC_TYPE_TAGS.Link;
      const context = EMPTY_RECONSTRUCTION_CONTEXT;

      describe("recognizedTypeTag", () => {
        it("is the `Link` wire type tag", () => {
          expect(codec.recognizedTypeTag).toBe(expectedTag);
        });
      });

      describe("canEncode()", () => {
        it("claims a `FabricLink`, rejecting other values", () => {
          expect(codec.canEncode(new FabricLink({ id: "fid1:abc" }))).toBe(
            true,
          );
          expect(codec.canEncode("not a link")).toBe(false);
        });
      });

      describe("encode()", () => {
        it("encodes to the payload object", () => {
          const link = new FabricLink({ id: "fid1:abc", path: ["a", "b"] });
          expect(codec.encode(link)).toEqual({
            id: "fid1:abc",
            path: ["a", "b"],
          });
        });
      });

      describe("decode()", () => {
        it("decodes non-object state to `ProblematicValue`", () => {
          expect(codec.decode(expectedTag, "nope", context))
            .toBeInstanceOf(ProblematicValue);
        });

        it("round-trips a payload with a nested schema value", () => {
          const link = new FabricLink({
            id: "fid1:abc",
            schema: { type: "object" },
          });
          const decoded = codec.decode(
            expectedTag,
            codec.encode(link),
            context,
          ) as FabricLink;
          expect(decoded).toBeInstanceOf(FabricLink);
          expect(decoded.payload).toEqual(link.payload);
        });
      });
    });
  });

  // Free functions exercising `FabricLink` rather than members of the class
  // itself, so they live directly under the class `describe()`.
  describe("round-trip via `jsonFromValue()` / `valueFromJson()`", () => {
    it("round-trips a `FabricLink`, including a nested schema", () => {
      const original = new FabricLink({
        id: "fid1:abc",
        path: ["a", "b"],
        schema: { type: "object", properties: { x: { type: "number" } } },
      });
      const restored = valueFromJson(jsonFromValue(original)) as FabricLink;
      expect(restored).toBeInstanceOf(FabricLink);
      expect(restored.payload).toEqual(original.payload);
    });
  });

  describe("hashOf()", () => {
    it("produces a 32-byte (SHA-256) hash via the generic instance path", () => {
      const hash = hashOf(new FabricLink({ id: "fid1:abc" }));
      expect(hash.bytes).toBeInstanceOf(Uint8Array);
      expect(hash.length).toBe(32);
    });

    it("produces the same hash for equal payloads", () => {
      const h1 = hashOf(new FabricLink({ id: "fid1:abc" })).bytes;
      const h2 = hashOf(new FabricLink({ id: "fid1:abc" })).bytes;
      expect(h1).toEqual(h2);
    });

    it("produces a different hash for a different payload", () => {
      const h1 = hashOf(new FabricLink({ id: "fid1:abc" })).bytes;
      const h2 = hashOf(new FabricLink({ id: "fid1:xyz" })).bytes;
      expect(h1).not.toEqual(h2);
    });
  });

  // A `FabricLink` nested in a container must clone through the generic
  // `FabricInstance` clone path (no dedicated dispatch case anymore).
  describe("generic clone dispatch (nested in a container)", () => {
    it("deep-clones a container holding one without throwing", () => {
      const link = new FabricLink({ id: "fid1:abc" });
      const cloned = cloneIfNecessary({ link }, { frozen: true });
      expect(isDeepFrozen(cloned)).toBe(true);
      expect(cloned.link).toBeInstanceOf(FabricLink);
      expect((cloned.link as FabricLink).payload).toEqual(link.payload);
    });
  });
});
