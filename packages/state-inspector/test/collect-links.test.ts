// What the value-collecting link walks in `decode.ts` do today, pinned before
// the traversals behind them are folded together. Every assertion here states
// a behaviour a caller can currently observe, so a fold that changes one shows
// up as a failing test rather than as a rendering someone notices next week.

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { collectLinks, countLinks, linksWithPaths } from "../decode.ts";

/** A link in the legacy at-rest sigil form. */
const linkTo = (id: string) => ({ "/": { "link@1": { id } } });

/** A value nested `depth` objects deep, holding `leaf` at the bottom. */
const nest = (depth: number, leaf: unknown): unknown =>
  depth === 0 ? leaf : { down: nest(depth - 1, leaf) };

/** A class instance carrying an enumerable own property, as a restored
 * `FabricValue` instance does not — its state lives in private fields. */
class Instance {
  held: unknown;
  constructor(held: unknown) {
    this.held = held;
  }
}

describe("the value-collecting link walks", () => {
  describe("collectLinks()", () => {
    it("returns a link that is the whole value", () => {
      expect(collectLinks(linkTo("of:root")).map((l) => l.id)).toEqual([
        "of:root",
      ]);
    });

    it("descends objects and arrays, in the order it meets the links", () => {
      const found = collectLinks({
        a: linkTo("of:first"),
        b: ["skip", { c: linkTo("of:second") }],
      });
      expect(found.map((l) => l.id)).toEqual(["of:first", "of:second"]);
    });

    it("stops at a link, so a link inside a link's payload is not returned", () => {
      const found = collectLinks(
        { "/": { "link@1": { id: "of:outer", schema: linkTo("of:inner") } } },
      );
      expect(found.map((l) => l.id)).toEqual(["of:outer"]);
    });

    it("stops at a stream marker, so a link beside `$stream` is not returned", () => {
      const found = collectLinks({ $stream: true, held: linkTo("of:hidden") });
      expect(found).toEqual([]);
    });

    it("stops at an entity ref, which holds a string and so holds no link", () => {
      expect(collectLinks({ "/": "of:referenced" })).toEqual([]);
    });

    it("does not descend a class instance, so a link on one is not returned", () => {
      expect(collectLinks(new Instance(linkTo("of:private")))).toEqual([]);
    });

    it("reaches a link twelve levels down by default, and not one deeper", () => {
      expect(collectLinks(nest(12, linkTo("of:deep"))).map((l) => l.id))
        .toEqual(["of:deep"]);
      expect(collectLinks(nest(13, linkTo("of:deeper")))).toEqual([]);
    });

    it("reaches exactly the depth the caller supplies", () => {
      expect(collectLinks(nest(2, linkTo("of:at-two")), 2).map((l) => l.id))
        .toEqual(["of:at-two"]);
      expect(collectLinks(nest(3, linkTo("of:at-three")), 2)).toEqual([]);
    });

    it("returns nothing for a value past the bound, saying nothing about why", () => {
      // The whole of the CT-2113 complaint: a link the bound hid and a value
      // that holds no link come back identical.
      expect(collectLinks(nest(13, linkTo("of:hidden"))))
        .toEqual(collectLinks({ nothing: "here" }));
    });
  });

  describe("countLinks()", () => {
    it("counts a link that is the whole value", () => {
      expect(countLinks(linkTo("of:root"))).toBe(1);
    });

    it("counts every link it meets in objects and arrays", () => {
      expect(
        countLinks({
          a: linkTo("of:first"),
          b: ["skip", { c: linkTo("of:second") }],
        }),
      ).toBe(2);
    });

    it("stops at a link, so a link inside a link's payload is not counted", () => {
      expect(
        countLinks(
          { "/": { "link@1": { id: "of:outer", schema: linkTo("of:inner") } } },
        ),
      ).toBe(1);
    });

    it("stops at a stream marker, so a link beside `$stream` is not counted", () => {
      expect(countLinks({ $stream: true, held: linkTo("of:hidden") })).toBe(0);
    });

    it("stops at an entity ref, which holds a string and so holds no link", () => {
      expect(countLinks({ "/": "of:referenced" })).toBe(0);
    });

    it("does not descend a class instance, so a link on one is not counted", () => {
      expect(countLinks(new Instance(linkTo("of:private")))).toBe(0);
    });

    it("reaches a link eight levels down by default, and not one deeper", () => {
      expect(countLinks(nest(8, linkTo("of:deep")))).toBe(1);
      expect(countLinks(nest(9, linkTo("of:deeper")))).toBe(0);
    });

    it("reaches exactly the depth the caller supplies", () => {
      expect(countLinks(nest(2, linkTo("of:at-two")), 2)).toBe(1);
      expect(countLinks(nest(3, linkTo("of:at-three")), 2)).toBe(0);
    });

    it("counts a link the bound hid the same as a value holding none", () => {
      expect(countLinks(nest(9, linkTo("of:hidden")))).toBe(0);
    });
  });

  describe("the pair against `linksWithPaths()`", () => {
    // `linksWithPaths` walks the same structure under a different set of stop
    // conditions. These are the values the three walks answer differently.
    const unbounded = {
      maxDepth: Number.POSITIVE_INFINITY,
      maxNodes: Number.POSITIVE_INFINITY,
    };

    it("agree on a link in plain objects and arrays", () => {
      const value = { a: linkTo("of:one"), b: [{ c: linkTo("of:two") }] };
      expect(linksWithPaths(value, unbounded).links.map((f) => f.link.id))
        .toEqual(collectLinks(value).map((l) => l.id));
    });

    it("disagree about a link beside `$stream`, which only `linksWithPaths` returns", () => {
      const value = { $stream: true, held: linkTo("of:hidden") };
      expect(linksWithPaths(value, unbounded).links.map((f) => f.link.id))
        .toEqual(["of:hidden"]);
      expect(collectLinks(value)).toEqual([]);
    });

    it("disagree about a link on a class instance, which only `linksWithPaths` returns", () => {
      const value = new Instance(linkTo("of:private"));
      expect(linksWithPaths(value, unbounded).links.map((f) => f.link.id))
        .toEqual(["of:private"]);
      expect(collectLinks(value)).toEqual([]);
    });

    it("agree about an entity ref, whose one key holds a string", () => {
      const value = { "/": "of:referenced" };
      expect(linksWithPaths(value, unbounded).links).toEqual([]);
      expect(collectLinks(value)).toEqual([]);
    });
  });

  describe("the two walks against each other", () => {
    it("count the same links at the depth they share", () => {
      const value = { a: linkTo("of:one"), b: { c: linkTo("of:two") } };
      expect(countLinks(value)).toBe(collectLinks(value).length);
    });

    it("disagree past `countLinks`'s shallower default depth", () => {
      // The divergence CT-2113 names: same structure, two answers.
      const value = nest(10, linkTo("of:between-the-bounds"));
      expect(collectLinks(value).length).toBe(1);
      expect(countLinks(value)).toBe(0);
    });
  });
});
