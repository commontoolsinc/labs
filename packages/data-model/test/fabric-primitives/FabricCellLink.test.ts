import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { FabricInstance, FabricPrimitive } from "@/interface.ts";
import { FabricCellLink } from "@/fabric-primitives/FabricCellLink.ts";
import { cloneIfNecessary } from "@/value-clone.ts";
import { isDeepFrozenFabricValue } from "@/deep-freeze.ts";

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
    });
  });
});
