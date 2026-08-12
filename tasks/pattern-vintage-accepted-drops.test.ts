import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  acceptedDropsFor,
  type AcceptedStateDrop,
  withoutAcceptedDrops,
} from "./pattern-vintage-accepted-drops.ts";

describe("pattern-vintage-accepted-drops", () => {
  const drops: AcceptedStateDrop[] = [
    { pattern: "topics/main.tsx", fields: ["crossrefs"], reason: "removed" },
  ];

  describe("acceptedDropsFor", () => {
    it("returns the fields for a repo-relative path ending in the key", () => {
      expect(
        acceptedDropsFor("/packages/patterns/topics/main.tsx", drops)?.fields,
      ).toEqual(new Set(["crossrefs"]));
    });

    it("returns the fields for the bare key", () => {
      expect(acceptedDropsFor("topics/main.tsx", drops)?.pattern).toBe(
        "topics/main.tsx",
      );
    });

    it("returns undefined for a path that only ends with the same text", () => {
      // A bare `endsWith` would claim this one, which no entry mentions.
      expect(acceptedDropsFor("/packages/patterns/subtopics/main.tsx", drops))
        .toBeUndefined();
    });

    it("returns undefined for a pattern with no entry", () => {
      expect(acceptedDropsFor("/packages/patterns/notes/main.tsx", drops))
        .toBeUndefined();
    });
  });

  describe("withoutAcceptedDrops", () => {
    const fields = new Set(["crossrefs"]);

    it("removes a named field from the root", () => {
      expect(withoutAcceptedDrops({ title: "a", crossrefs: {} }, fields))
        .toEqual({ value: { title: "a" }, applied: true });
    });

    it("removes a named field from every element of a nested list", () => {
      // Where the field actually sits: a board's `topics` is a list of
      // children, each of which carried the removed path.
      expect(
        withoutAcceptedDrops(
          { topics: [{ title: "a", crossrefs: 1 }, { title: "b" }] },
          fields,
        ),
      ).toEqual({
        value: { topics: [{ title: "a" }, { title: "b" }] },
        applied: true,
      });
    });

    it("reports applied false when no named field is present", () => {
      expect(withoutAcceptedDrops({ title: "a" }, fields))
        .toEqual({ value: { title: "a" }, applied: false });
    });

    it("keeps every field the entry does not name", () => {
      expect(
        withoutAcceptedDrops({ crossrefs: 1, body: "", comments: [] }, fields)
          .value,
      ).toEqual({ body: "", comments: [] });
    });

    it("leaves the caller's own value unmodified", () => {
      // The vintage's snapshot is compared against more than once, so the
      // strip rebuilds rather than mutating.
      const before = { title: "a", crossrefs: {} };
      withoutAcceptedDrops(before, fields);
      expect(before).toEqual({ title: "a", crossrefs: {} });
    });

    it("returns the value itself when the entry names no fields", () => {
      const before = { title: "a" };
      const result = withoutAcceptedDrops(before, new Set<string>());
      expect(result.value).toBe(before);
      expect(result.applied).toBe(false);
    });
  });
});
