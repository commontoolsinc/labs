import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { JSONValue } from "@commontools/api";
import {
  confidentialityDominates,
  confidentialitySatisfiesMax,
  joinConfidentialityLabels,
  normalizeConfidentialityLabel,
} from "../src/cfc/label-algebra.ts";

describe("CFC label algebra", () => {
  it("normalizes legacy single-clause classification arrays into CNF", () => {
    expect(
      normalizeConfidentialityLabel([
        "secret",
        "confidential",
      ]),
    ).toEqual([[
      "confidential",
      "secret",
    ]]);
  });

  it("preserves multi-clause CNF and compares structured atoms canonically", () => {
    const left = [
      [
        {
          type: "https://commonfabric.org/cfc/atom/User",
          subject: "did:key:alice",
          extra: { b: 2, a: 1 },
        },
      ],
      ["https://commonfabric.org/cfc/atom/EmailSecret"],
    ] as const satisfies JSONValue;
    const right = [
      [
        {
          extra: { a: 1, b: 2 },
          subject: "did:key:alice",
          type: "https://commonfabric.org/cfc/atom/User",
        },
      ],
      ["https://commonfabric.org/cfc/atom/EmailSecret"],
    ] as const satisfies JSONValue;

    expect(normalizeConfidentialityLabel(left)).toEqual(
      normalizeConfidentialityLabel(right),
    );
  });

  it("joins confidentiality by concatenating clauses", () => {
    const joined = joinConfidentialityLabels(
      normalizeConfidentialityLabel([
        ["https://commonfabric.org/cfc/atom/User:alice"],
      ])!,
      normalizeConfidentialityLabel([
        ["https://commonfabric.org/cfc/atom/EmailSecret"],
      ])!,
    );

    expect(joined).toEqual([
      ["https://commonfabric.org/cfc/atom/User:alice"],
      ["https://commonfabric.org/cfc/atom/EmailSecret"],
    ]);
  });

  it("treats clause supersets as more restrictive", () => {
    const lessRestrictive = normalizeConfidentialityLabel([
      ["https://commonfabric.org/cfc/atom/User:alice"],
    ])!;
    const moreRestrictive = normalizeConfidentialityLabel([
      ["https://commonfabric.org/cfc/atom/User:alice"],
      ["https://commonfabric.org/cfc/atom/EmailSecret"],
    ])!;

    expect(confidentialityDominates(moreRestrictive, lessRestrictive)).toBe(
      true,
    );
    expect(confidentialityDominates(lessRestrictive, moreRestrictive)).toBe(
      false,
    );
  });

  it("checks maxConfidentiality as an upper bound under CNF subset semantics", () => {
    const actual = normalizeConfidentialityLabel([
      ["https://commonfabric.org/cfc/atom/User:alice"],
    ])!;
    const max = normalizeConfidentialityLabel([
      ["https://commonfabric.org/cfc/atom/User:alice"],
      ["https://commonfabric.org/cfc/atom/EmailSecret"],
    ])!;

    expect(confidentialitySatisfiesMax(actual, max)).toBe(true);
    expect(confidentialitySatisfiesMax(max, actual)).toBe(false);
  });
});
