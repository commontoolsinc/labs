import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { PathPrefixIndex } from "../../src/cfc/path-prefix-index.ts";

/**
 * The predicate the index replaces, copied from `prepare.ts` so the two can be
 * compared directly. A divergence between them is the whole risk of the
 * change: the index is only correct if it admits exactly what this admits.
 */
const isPrefix = (
  prefix: readonly string[],
  path: readonly string[],
): boolean =>
  prefix.length <= path.length &&
  prefix.every((segment, index) =>
    segment === path[index] || segment === "*" || path[index] === "*"
  );

function scan(sources: readonly string[][], path: readonly string[]): boolean {
  return sources.some((source) => isPrefix(source, path));
}

function indexOf(sources: readonly string[][]): PathPrefixIndex {
  const index = new PathPrefixIndex();
  for (const source of sources) index.add(source);
  return index;
}

describe("path-prefix-index", () => {
  it("finds an exact path", () => {
    expect(indexOf([["a", "b"]]).hasPrefixOf(["a", "b"])).toBe(true);
  });

  it("finds a shorter path that prefixes the query", () => {
    expect(indexOf([["a"]]).hasPrefixOf(["a", "b", "c"])).toBe(true);
  });

  it("rejects a longer path, which cannot be a prefix", () => {
    expect(indexOf([["a", "b", "c"]]).hasPrefixOf(["a", "b"])).toBe(false);
  });

  it("rejects a path that diverges", () => {
    expect(indexOf([["a", "x"]]).hasPrefixOf(["a", "b", "c"])).toBe(false);
  });

  it("matches an empty source against anything, including an empty query", () => {
    expect(indexOf([[]]).hasPrefixOf(["a"])).toBe(true);
    expect(indexOf([[]]).hasPrefixOf([])).toBe(true);
  });

  it("finds nothing in an empty index", () => {
    expect(indexOf([]).hasPrefixOf(["a"])).toBe(false);
    expect(indexOf([]).hasPrefixOf([])).toBe(false);
  });

  it("takes a wildcard in the source as matching any segment", () => {
    expect(indexOf([["a", "*"]]).hasPrefixOf(["a", "zzz", "c"])).toBe(true);
  });

  it("takes a wildcard in the query as matched by any segment", () => {
    expect(indexOf([["a", "b"]]).hasPrefixOf(["a", "*", "c"])).toBe(true);
  });

  it("follows a literal branch when a wildcard branch dead-ends", () => {
    // The wildcard child matches "b" at depth 1 and then stops; the literal
    // branch is the one that reaches a terminal. A walk that committed to the
    // wildcard would miss it.
    expect(indexOf([["*", "q"], ["b", "c"]]).hasPrefixOf(["b", "c"]))
      .toBe(true);
  });

  it("agrees with a linear scan across a generated corpus", () => {
    const segments = ["a", "b", "c", "*"];
    const paths: string[][] = [[]];
    for (const one of segments) {
      paths.push([one]);
      for (const two of segments) {
        paths.push([one, two]);
        for (const three of segments) paths.push([one, two, three]);
      }
    }
    // Every source set of a manageable size, against every query path.
    let compared = 0;
    for (let i = 0; i < paths.length; i += 3) {
      const sources = [
        paths[i],
        paths[(i + 11) % paths.length],
        paths[(i + 29) % paths.length],
      ];
      const index = indexOf(sources);
      for (const path of paths) {
        expect(index.hasPrefixOf(path)).toBe(scan(sources, path));
        compared++;
      }
    }
    // Guard the guard: a loop that compared nothing would pass silently.
    expect(compared).toBeGreaterThan(2000);
  });
});
