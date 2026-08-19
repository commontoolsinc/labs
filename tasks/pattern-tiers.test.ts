import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  declaredTier,
  hasMarkerLine,
  stripMarker,
  tableTierOf,
  TIER_MARKERS,
  tierOf,
  withMarker,
} from "./pattern-tiers.ts";
import {
  isWritable,
  problemWith,
  staleTableEntries,
} from "./check-pattern-tiers.ts";

const LEGACY = TIER_MARKERS.legacy;
const FIXTURE = TIER_MARKERS.fixture;

describe("tierOf", () => {
  it("tiers a file by the directory holding it", () => {
    expect(tierOf("factory-outputs/lot-watch/main.tsx")).toBe("legacy");
    expect(tierOf("google/WIP/google-docs-importer.tsx")).toBe("legacy");
    expect(tierOf("gideon-tests/test-cell-equals.tsx")).toBe("fixture");
    expect(tierOf("test/non-idempotent/shuffle.tsx")).toBe("fixture");
  });

  it("tiers a loose file by name", () => {
    expect(tierOf("vehicles.ts")).toBe("legacy");
    expect(tierOf("render-test.tsx")).toBe("fixture");
  });

  it("leaves the copyable tiers unmarked", () => {
    expect(tierOf("counter/counter.tsx")).toBe(undefined);
    expect(tierOf("system/home.tsx")).toBe(undefined);
    expect(tierOf("notes/note.tsx")).toBe(undefined);
  });

  it("exempts the shared helper inside a tiered directory", () => {
    // Marking the helper pattern tests are meant to call "do not copy" would
    // say the opposite of what it is for.
    expect(tierOf("test/vnode-helpers.ts")).toBe(undefined);
  });

  it("reports through tableTierOf what the exemption is hiding", () => {
    // `tierOf` alone cannot check an exemption: it honours it, so every
    // exempted file looks untiered and there is nothing left to test against.
    expect(tableTierOf("test/vnode-helpers.ts")).toBe("fixture");
    expect(tableTierOf("counter/counter.tsx")).toBe(undefined);
  });

  it("does not let a directory prefix spill into a sibling", () => {
    // "test/" must not tier "test-import.tsx" or a "tests-support/" sibling.
    expect(tierOf("test-import.tsx")).toBe(undefined);
    expect(tierOf("tests-support/helper.ts")).toBe(undefined);
  });
});

describe("declaredTier", () => {
  it("reads the tier a file's opening lines declare", () => {
    expect(declaredTier(`${LEGACY}\nimport x from "y";\n`)).toBe("legacy");
    expect(declaredTier(`${FIXTURE}\nimport x from "y";\n`)).toBe("fixture");
  });

  it("declares nothing for a file that opens with ordinary code", () => {
    expect(declaredTier('import x from "y";\n')).toBe(undefined);
    expect(declaredTier("/** A pattern. */\n")).toBe(undefined);
  });

  it("declares nothing for a marker whose wording has drifted", () => {
    const drifted = "// PATTERN TIER: fixture — do not copy\n";
    expect(declaredTier(drifted)).toBe(undefined);
    expect(hasMarkerLine(drifted)).toBe(true);
  });

  it("declares nothing for a marker that is not at the very top", () => {
    // A marker below the imports is one a reader scrolls past, so it does not
    // count as declared.
    expect(declaredTier(`import x from "y";\n${FIXTURE}\n`)).toBe(undefined);
  });
});

describe("withMarker", () => {
  it("puts the marker ahead of everything else in the file", () => {
    const source = '/** A fixture. */\nimport x from "y";\n';
    expect(withMarker(source, "fixture")).toBe(`${FIXTURE}\n${source}`);
  });

  it("replaces a marker of the other tier rather than stacking one on it", () => {
    const source = `${LEGACY}\nimport x from "y";\n`;
    expect(withMarker(source, "fixture")).toBe(
      `${FIXTURE}\nimport x from "y";\n`,
    );
  });

  it("is idempotent, so a re-run does not double the marker", () => {
    const once = withMarker('import x from "y";\n', "legacy");
    expect(withMarker(once, "legacy")).toBe(once);
  });
});

describe("stripMarker", () => {
  it("removes a marker it recognizes, by its own line count", () => {
    expect(stripMarker(`${FIXTURE}\nimport x from "y";\n`)).toBe(
      'import x from "y";\n',
    );
  });

  it("leaves a mangled marker in place rather than guessing its extent", () => {
    // Guessing how far a broken marker runs is how a rewrite eats the comment
    // underneath it.
    const mangled = "// PATTERN TIER: fixture\n// A real comment.\ncode;\n";
    expect(stripMarker(mangled)).toBe(mangled);
  });

  it("leaves an unmarked file alone", () => {
    expect(stripMarker("code;\n")).toBe("code;\n");
  });
});

describe("problemWith", () => {
  it("passes a marked file whose marker matches its tier", () => {
    expect(problemWith(`${LEGACY}\ncode;\n`, "legacy")).toBe(undefined);
    expect(problemWith(`${FIXTURE}\ncode;\n`, "fixture")).toBe(undefined);
  });

  it("passes an unmarked file in a copyable tier", () => {
    expect(problemWith("code;\n", undefined)).toBe(undefined);
  });

  it("reports a file that should be marked and is not", () => {
    expect(problemWith("code;\n", "fixture")).toContain(
      "should open with the fixture marker",
    );
  });

  it("reports a marker naming the wrong tier", () => {
    expect(problemWith(`${LEGACY}\ncode;\n`, "fixture")).toContain(
      "is marked legacy but the tables place it in fixture",
    );
  });

  it("reports a marker on a file no table places", () => {
    expect(problemWith(`${FIXTURE}\ncode;\n`, undefined)).toContain(
      "no table places it in a marked tier",
    );
  });

  it("reports marker-shaped text nothing would maintain", () => {
    const drifted = "// PATTERN TIER: whatever\ncode;\n";
    expect(problemWith(drifted, undefined)).toContain(
      "a tier marker the tables do not place",
    );
    expect(problemWith(drifted, "legacy")).toContain(
      "its opening lines are not it",
    );
  });
});

describe("isWritable", () => {
  it("writes a marker onto a file that has none", () => {
    expect(isWritable("code;\n", "fixture")).toBe(true);
  });

  it("corrects a recognized marker naming the other tier", () => {
    // Moving a directory between tiers in the tables is a mechanical edit,
    // because the marker being replaced has a known line count.
    expect(isWritable(`${LEGACY}\ncode;\n`, "fixture")).toBe(true);
  });

  it("refuses a file whose marker text matches nothing", () => {
    // Where the mangled text ends and the file's own comments begin is not
    // knowable, so a person fixes it rather than a rewrite guessing.
    expect(isWritable("// PATTERN TIER: bogus\n// A real comment.\n", "legacy"))
      .toBe(false);
  });

  it("never writes to a file no table places in a marked tier", () => {
    expect(isWritable("code;\n", undefined)).toBe(false);
    expect(isWritable(`${FIXTURE}\ncode;\n`, undefined)).toBe(false);
  });
});

describe("staleTableEntries", () => {
  it("accepts tables whose every entry matches something", () => {
    expect(
      staleTableEntries([
        "factory-outputs/lot-watch/main.tsx",
        "google/WIP/a.tsx",
        "gideon-tests/a.tsx",
        "plain-array-callback-locals/main.tsx",
        "scope-bug-computed-vnode-blank/main.tsx",
        "scope-bug-ct1597-forward/MINIMAL-REPRO.tsx",
        "scope-bug-ct1597-reduce/main.tsx",
        "test/a.tsx",
        "test/vnode-helpers.ts",
        "cell-link.tsx",
        "nested-map-ifelse-test.tsx",
        "render-test.tsx",
        "self-reference-test.tsx",
        "vehicles.ts",
      ]),
    ).toEqual([]);
  });

  it("reports a directory entry that matches no pattern source", () => {
    // What catches a tiered directory renamed out from under the tables.
    const stale = staleTableEntries(["counter/counter.tsx"]);
    expect(stale.some((entry) => entry.includes("gideon-tests/"))).toBe(true);
  });

  it("reports a file entry that is no longer a pattern source", () => {
    const stale = staleTableEntries(["counter/counter.tsx"]);
    expect(stale.some((entry) => entry.includes("vehicles.ts"))).toBe(true);
  });

  it("reports an exemption whose file is gone", () => {
    const stale = staleTableEntries(["counter/counter.tsx"]);
    expect(
      stale.some((entry) =>
        entry.includes('exempts "test/vnode-helpers.ts"') &&
        entry.includes("not a pattern source")
      ),
    ).toBe(true);
  });
});
