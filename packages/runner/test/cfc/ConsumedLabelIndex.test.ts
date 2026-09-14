import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { canonicalizeLogicalPath } from "../../src/cfc/canonical.ts";
import { ConsumedLabelIndex } from "../../src/cfc/consumed-label-index.ts";
import { isPrefix } from "../../src/cfc/path-prefix-index.ts";
import type { LabelMapEntry } from "../../src/cfc/types.ts";

const entry = (path: string[], ordinal: number): LabelMapEntry => ({
  path,
  label: { confidentiality: [String(ordinal)] },
});

describe("ConsumedLabelIndex", () => {
  it("retains label-map order across ancestors, descendants, and duplicate paths", () => {
    const entries = [
      ["a", "b", "child"],
      [],
      ["other"],
      ["a", "b"],
      ["a"],
      ["value", "a", "b"],
    ].map(entry);
    const index = new ConsumedLabelIndex(entries);

    expect(index.overlapping(["a", "b"]).map((item) => item.entry)).toEqual([
      entries[0],
      entries[1],
      entries[3],
      entries[4],
      entries[5],
    ]);
    expect(index.overlapping([]).map((item) => item.entry)).toEqual(entries);
    expect(index.overlapping(["missing"]).map((item) => item.entry)).toEqual([
      entries[1],
    ]);
    expect(new ConsumedLabelIndex([]).overlapping(["a"])).toEqual([]);
  });

  it("agrees with the prefix predicate across concrete and wildcard paths", () => {
    const paths: string[][] = [[], ["a/b"], ["a", "b"], ["~1"], ["value", "a"]];
    let level: string[][] = [[]];
    for (let depth = 1; depth <= 3; depth++) {
      level = level.flatMap((path) =>
        ["a", "b", "", "*"].map((part) => [
          ...path,
          part,
        ])
      );
      paths.push(...level);
    }
    for (const withWildcards of [false, true]) {
      const entries = paths.filter((path) =>
        withWildcards || !path.includes("*")
      ).reverse().map(entry);
      const index = new ConsumedLabelIndex(entries);
      for (const query of paths) {
        const path = canonicalizeLogicalPath(query);
        const expected = entries.filter((item) => {
          const source = canonicalizeLogicalPath(item.path);
          return isPrefix(source, path) || isPrefix(path, source);
        });
        expect(index.overlapping(path).map((item) => item.entry)).toEqual(
          expected,
        );
      }
    }
  });

  it("keeps a payload field named value after the storage prefix is removed", () => {
    const wanted = entry(["value", "value", "field"], 0);
    const unrelated = entry(["field"], 1);
    const index = new ConsumedLabelIndex([wanted, unrelated]);
    const logicalPath = canonicalizeLogicalPath(["value", "value", "field"]);

    expect(index.overlapping(logicalPath).map((item) => item.entry)).toEqual([
      wanted,
    ]);
  });
});
