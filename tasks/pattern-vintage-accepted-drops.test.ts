import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  acceptedDropsFor,
  type AcceptedStateDrop,
  withoutAcceptedDrops,
} from "./pattern-vintage-accepted-drops.ts";
import { isReduction } from "../packages/piece/test/state-continuity-harness.ts";

describe("pattern-vintage-accepted-drops", () => {
  const drops: AcceptedStateDrop[] = [
    {
      pattern: "topics/main.tsx",
      paths: ["crossrefs", "topics[].crossrefs"],
      reason: "removed",
    },
  ];

  describe("acceptedDropsFor", () => {
    it("returns the paths for a repo-relative path ending in the key", () => {
      expect(
        acceptedDropsFor("/packages/patterns/topics/main.tsx", drops)?.paths,
      ).toEqual(new Set(["crossrefs", "topics[].crossrefs"]));
    });

    it("returns the entry for the bare key", () => {
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
    const paths = new Set(["crossrefs", "topics[].crossrefs"]);
    const strip = (state: unknown, only = paths) =>
      withoutAcceptedDrops(state, only, isReduction);

    it("removes a root key the entry names", () => {
      expect(strip({ title: "a", crossrefs: { refsOut: [1] } })).toEqual({
        value: { title: "a" },
        applied: new Set(["crossrefs"]),
      });
    });

    it("removes a named path from every element of its list", () => {
      expect(
        strip({ topics: [{ title: "a", crossrefs: 1 }, { title: "b" }] }),
      ).toEqual({
        value: { topics: [{ title: "a" }, { title: "b" }] },
        applied: new Set(["topics[].crossrefs"]),
      });
    });

    it("keeps a same-named field the entry did not anchor to that path", () => {
      // The bound that stops a name-only entry blanking an unrelated object:
      // `notes[].crossrefs` is not a path any entry names.
      expect(strip({ notes: [{ crossrefs: "kept" }] }).value).toEqual({
        notes: [{ crossrefs: "kept" }],
      });
    });

    it("keeps a named field nested deeper than the path it names", () => {
      expect(strip({ topics: [{ meta: { crossrefs: "kept" } }] }).value)
        .toEqual({ topics: [{ meta: { crossrefs: "kept" } }] });
    });

    it("reports the paths it used, not the ones it did not", () => {
      expect(strip({ topics: [{ crossrefs: 1 }] }).applied).toEqual(
        new Set(["topics[].crossrefs"]),
      );
    });

    it("returns a subtree that lost nothing as itself, not a copy", () => {
      // The comparison must see the state it was handed. Anything off the path
      // to a drop is shared by reference rather than rebuilt.
      const untouched = { deeply: { nested: "value" } };
      const state = { untouched, crossrefs: 1 };
      const result = strip(state);
      expect((result.value as typeof state).untouched).toBe(untouched);
    });

    it("returns the state itself when nothing was dropped", () => {
      const state = { title: "a" };
      const result = strip(state);
      expect(result.value).toBe(state);
      expect(result.applied).toEqual(new Set());
    });

    it("returns the state itself when the entry names no paths", () => {
      const state = { crossrefs: 1 };
      const result = strip(state, new Set<string>());
      expect(result.value).toBe(state);
    });

    it("never opens a reduction, which is compared whole", () => {
      // `comparableState` reduces a cell to `{"[cell]": …}`. Descending into
      // one would compare its innards instead of the document it stands for.
      const cell = { "[cell]": { space: "did:x", id: "y", path: [] } };
      const state = { topics: [cell] };
      const result = strip(state);
      expect((result.value as typeof state).topics[0]).toBe(cell);
    });

    it("leaves the caller's own value unmodified", () => {
      const before = { title: "a", crossrefs: {} };
      strip(before);
      expect(before).toEqual({ title: "a", crossrefs: {} });
    });
  });
});
