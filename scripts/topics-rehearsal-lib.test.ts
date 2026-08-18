/** Unit coverage for the pure halves of the Topics export/restore pair; the
 * live halves are exercised by the rehearsal drill
 * (`packages/cli/integration/topics-restore-drill.sh`). */
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  buildRestoreDocument,
  deepEqual,
  findLink,
  normalizeFid,
} from "./topics-rehearsal-lib.ts";

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

  describe("buildRestoreDocument", () => {
    const link = { $link: { id: "of:fid1:board" } };
    const resolved = {
      comments: [{ body: "c", sentAt: 1 }],
      links: [{ url: "https://x", addedAt: 2 }],
    };

    it("carries a plain field no list names, so a grown schema survives", () => {
      const { doc } = buildRestoreDocument(
        { title: "t", titleUpdatedAt: 5, mentionable: link },
        resolved,
      );
      expect(doc.titleUpdatedAt).toBe(5);
    });

    it("substitutes resolved values for the linked arrays", () => {
      const { doc } = buildRestoreDocument(
        { comments: [link], links: [link] },
        resolved,
      );
      expect(doc.comments).toEqual(resolved.comments);
      expect(doc.links).toEqual(resolved.links);
    });

    it("routes known link fields aside instead of into the document", () => {
      const { doc, structural, legacy } = buildRestoreDocument(
        { title: "t", mentionable: link, myName: link },
        resolved,
      );
      expect(structural).toEqual(["mentionable"]);
      expect(legacy).toEqual(["myName"]);
      expect(doc.mentionable).toBeUndefined();
      expect(doc.myName).toBeUndefined();
    });

    it("throws on a link-valued field it does not understand", () => {
      expect(() => buildRestoreDocument({ attachments: [link] }, resolved))
        .toThrow("attachments");
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
