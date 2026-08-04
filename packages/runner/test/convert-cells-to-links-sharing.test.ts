// A value reachable twice by different paths is SHARED, not circular. The
// conversion answers an ancestor with a back-link -- that is what makes a cycle
// representable -- and must not answer a sibling the same way, which would
// rewrite one of the two positions into a pointer at the other.

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { convertCellsToLinks } from "../src/cell.ts";

describe("convert-cells-to-links-sharing", () => {
  it("converts a twice-reachable object at both of its positions", () => {
    const shared = { n: 1 };
    const result = convertCellsToLinks({ a: shared, b: shared }) as {
      a: unknown;
      b: unknown;
    };

    expect(result.a).toEqual({ n: 1 });
    expect(result.b).toEqual({ n: 1 });
  });

  it("converts a twice-reachable EMPTY array at both of its positions", () => {
    // The shape that makes this matter. A serialized pattern graph aliases one
    // empty `path: []` from every alias in it, so a walk that reads sharing as
    // circularity rewrites all but the first into back-links.
    const path: string[] = [];
    const result = convertCellsToLinks({
      result: { $alias: { path } },
      outputs: { $alias: { path } },
    }) as Record<string, { $alias: { path: unknown } }>;

    expect(result.result.$alias.path).toEqual([]);
    expect(result.outputs.$alias.path).toEqual([]);
  });

  it("converts a value shared between two array elements at both", () => {
    const shared = { n: 1 };
    const result = convertCellsToLinks([shared, shared]) as unknown[];

    expect(result[0]).toEqual({ n: 1 });
    expect(result[1]).toEqual({ n: 1 });
  });

  it("answers an ancestor with a back-link, so a cycle stays representable", () => {
    const cyclic: Record<string, unknown> = { n: 1 };
    cyclic.self = cyclic;
    const result = convertCellsToLinks(cyclic) as Record<string, unknown>;

    expect(result.n).toBe(1);
    // The self-edge is a reference rather than an endless expansion.
    expect(result.self).not.toEqual(cyclic);
    expect(typeof result.self).toBe("object");
  });
});
