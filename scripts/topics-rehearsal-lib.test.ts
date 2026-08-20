/** Unit coverage for the pure halves of the Topics rehearsal scripts — the
 * export/restore pair and the migration driver's planning; the live halves
 * are exercised by the rehearsal drill
 * (`packages/cli/integration/topics-restore-drill.sh`). */
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  buildRestoreDocument,
  deepEqual,
  findLink,
  type ManifestRow,
  normalizeFid,
  parseManifest,
  planMigration,
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

  describe("parseManifest", () => {
    it("reads the runbook's id/identity/filename rows", () => {
      expect(parseManifest("of:fid1:a\tGENA\ttopic.tsx\n"))
        .toEqual([{
          id: "of:fid1:a",
          identity: "GENA",
          filename: "topic.tsx",
        }]);
    });

    it("keeps an unresolved row, so a broken manifest cannot read as a smaller space", () => {
      const rows = parseManifest(
        "of:fid1:a\tGENA\ttopic.tsx\nof:fid1:b\tunresolved\t-\n",
      );
      expect(rows.length).toBe(2);
      expect(rows[1].identity).toBe("unresolved");
    });

    it("throws on a row that is not tab-separated, rather than inventing a column", () => {
      expect(() => parseManifest("of:fid1:a GENA topic.tsx\n"))
        .toThrow("tab-separated");
    });
  });

  describe("planMigration", () => {
    const rows: ManifestRow[] = [
      { id: "a", identity: "GENA", filename: "topic.tsx" },
      { id: "b", identity: "GENA", filename: "topic.tsx" },
    ];

    it("calls a piece still on its recorded identity pending", () => {
      const plan = planMigration(rows, () => "GENA");
      expect(plan.map((p) => p.disposition)).toEqual(["pending", "pending"]);
    });

    it("returns `moved` for a piece that left its recorded identity, whatever it moved to", () => {
      // The driver never compiles the candidate, so "moved" is decided
      // against the recorded starting point and not against a target: a
      // piece migrated by an earlier interrupted run is skipped without the
      // run needing to know what the new identity is.
      const plan = planMigration(
        rows,
        (id) => id === "a" ? "SOMETHING" : "GENA",
      );
      expect(plan.map((p) => p.disposition)).toEqual(["moved", "pending"]);
    });

    it("returns `missing` for a piece the store cannot describe, not `pending`", () => {
      // Reporting it pending would send the run at a piece that is not there;
      // reporting it moved would count it as migrated. Neither is true.
      const plan = planMigration(rows, (id) => id === "a" ? undefined : "GENA");
      expect(plan[0].disposition).toBe("missing");
      expect(plan[0].current).toBeUndefined();
    });

    it("carries the recorded identity through, so a stop report can name the rollback target", () => {
      const plan = planMigration(rows, () => "MOVED");
      expect(plan.map((p) => p.recorded)).toEqual(["GENA", "GENA"]);
    });
  });
});
