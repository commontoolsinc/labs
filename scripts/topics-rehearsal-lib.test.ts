import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { deepEqual, findLink, normalizeFid } from "./topics-rehearsal-lib.ts";

describe("topics-rehearsal-lib", () => {
  describe("findLink", () => {
    it("returns null for plain scalars and objects", () => {
      expect(findLink("body text")).toBe(null);
      expect(findLink({ author: { kind: "agent", name: "Fable" } })).toBe(
        null,
      );
      expect(findLink(null)).toBe(null);
    });

    it("returns the path of a top-level link marker", () => {
      expect(findLink({ $link: { id: "of:fid1:x" } })).toBe("$");
    });

    it("returns the path of a nested link marker", () => {
      const doc = {
        comments: [{ body: "plain" }, { $link: { id: "of:fid1:x" } }],
      };
      expect(findLink(doc)).toBe("$.comments.1");
    });
  });

  describe("deepEqual", () => {
    it("treats an undefined property as an absent one", () => {
      expect(deepEqual({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    });

    it("returns false for a changed nested value", () => {
      expect(
        deepEqual({ a: { b: [1, 2] } }, { a: { b: [1, 3] } }),
      ).toBe(false);
    });

    it("returns false when an array meets an object", () => {
      expect(deepEqual([], {})).toBe(false);
    });

    it("returns true for equal arrays of records", () => {
      const comments = [{ body: "x", sentAt: 5 }, { body: "y", sentAt: 6 }];
      expect(deepEqual(comments, structuredClone(comments))).toBe(true);
    });
  });

  describe("normalizeFid", () => {
    it("returns a bare of-prefixed id for every accepted spelling", () => {
      expect(normalizeFid("of:fid1:abc")).toBe("of:fid1:abc");
      expect(normalizeFid("fid1:abc")).toBe("of:fid1:abc");
      expect(normalizeFid("/of:fid1:abc")).toBe("of:fid1:abc");
      expect(normalizeFid("/of:fid1:abc#argument")).toBe("of:fid1:abc");
    });
  });
});
