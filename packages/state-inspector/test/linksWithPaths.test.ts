// The generic link traversal: what it finds, where it says the link sat, and
// where the caller's bounds stop it.

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { linksWithPaths } from "../decode.ts";

/** A link in the legacy at-rest sigil form. */
const linkTo = (id: string) => ({ "/": { "link@1": { id } } });

/** Bounds that reach every value in these fixtures, so a test that pins a
 * bound sets only the one it is about. */
const unbounded = {
  maxDepth: Number.POSITIVE_INFINITY,
  maxNodes: Number.POSITIVE_INFINITY,
};

describe("linksWithPaths()", () => {
  it("returns the empty path for a link that is the whole value", () => {
    expect(linksWithPaths(linkTo("of:root"), unbounded)).toEqual([
      { link: { id: "of:root" }, at: [] },
    ]);
  });

  it("returns one segment per key for a link nested in objects", () => {
    const found = linksWithPaths(
      { outer: { inner: linkTo("of:nested") } },
      unbounded,
    );
    expect(found.map(({ link, at }) => [link.id, at])).toEqual([
      ["of:nested", ["outer", "inner"]],
    ]);
  });

  it("returns the index as a segment for a link nested in an array", () => {
    const found = linksWithPaths(
      { items: ["first", linkTo("of:second"), { deep: linkTo("of:third") }] },
      unbounded,
    );
    expect(found.map(({ link, at }) => [link.id, at])).toEqual([
      ["of:second", ["items", "1"]],
      ["of:third", ["items", "2", "deep"]],
    ]);
  });

  it("returns a key containing `/` and `~` as a single segment", () => {
    const key = "a/b~c";
    const found = linksWithPaths({ [key]: linkTo("of:awkward") }, unbounded);
    expect(found).toEqual([{ link: { id: "of:awkward" }, at: [key] }]);
    // The whole point of segment arrays: joined, this key is indistinguishable
    // from the two-segment path `["a", "b~c"]`.
    expect(found[0].at.length).toBe(1);
  });

  it("stops at `maxDepth`, so a link deeper than it is not returned", () => {
    const value = {
      a: { b: linkTo("of:at-two"), c: { d: linkTo("of:at-three") } },
    };
    const found = linksWithPaths(value, { ...unbounded, maxDepth: 2 });
    expect(found.map(({ link }) => link.id)).toEqual(["of:at-two"]);
  });

  it("stops at `maxNodes`, so a link past the budget is not returned", () => {
    const value = { a: linkTo("of:first"), b: linkTo("of:second") };
    // The root object is one node, and each of its two children is another.
    expect(
      linksWithPaths(value, { ...unbounded, maxNodes: 2 }).map((f) =>
        f.link.id
      ),
    ).toEqual(["of:first"]);
    expect(
      linksWithPaths(value, { ...unbounded, maxNodes: 3 }).map((f) =>
        f.link.id
      ),
    ).toEqual(["of:first", "of:second"]);
  });

  it("stops at each link, so a link-shaped value inside a link is not walked", () => {
    const found = linksWithPaths(
      { "/": { "link@1": { id: "of:outer", schema: linkTo("of:inner") } } },
      unbounded,
    );
    expect(found.map(({ link }) => link.id)).toEqual(["of:outer"]);
  });
});
