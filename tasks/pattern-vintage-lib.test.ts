import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  AUTO,
  collectVintages,
  coveredPatternKeys,
  parseVintagePath,
  PINNED,
  requiredPatternKeys,
  stampFor,
  uncoveredRequiredPatterns,
  vintageDir,
  vintageFileName,
  VINTAGES_DIR,
} from "./pattern-vintage-lib.ts";

const ID_A = "bafyaaaa";
const ID_B = "bafybbbb";

describe("vintage paths", () => {
  it("round-trips a path it built itself", () => {
    const stamp = stampFor(new Date("2026-07-29T16:33:28.000Z"));
    const path = `${vintageDir("system/home.tsx", PINNED)}/${
      vintageFileName(stamp, ID_A)
    }`;
    const parsed = parseVintagePath(path);

    expect(parsed).toEqual({
      patternKey: "system/home.tsx",
      tier: PINNED,
      stamp,
      identity: ID_A,
      path,
    });
  });

  it("keeps the stamp whole even though it contains dashes", () => {
    // Splitting on the FIRST dash would cut "2026-07-29..." in half and hand
    // back a truncated stamp with a date fragment as the identity — sorting
    // and provenance both silently wrong, and nothing would throw. (The next
    // case covers the opposite error, which is the one that actually shipped.)
    const stamp = stampFor(new Date("2026-07-29T16:33:28.000Z"));
    expect(stamp).toContain("-");
    const parsed = parseVintagePath(
      `${vintageDir("system/home.tsx", PINNED)}/${
        vintageFileName(stamp, ID_A)
      }`,
    );

    expect(parsed?.stamp).toBe(stamp);
    expect(parsed?.identity).toBe(ID_A);
  });

  it("keeps an identity that itself contains dashes whole", () => {
    // Not hypothetical: identities are base64url, and home.tsx's real one is
    // `xaLUAd13811rdYUEzKt7vaXYy-P8PAkhRcvqRshiNW4`. An earlier parse cut at
    // the LAST dash, so the gate failed to recognise a fixture it had just
    // written and reported the pattern as uncovered with the file sitting
    // right there. Both fields contain dashes; only the stamp's fixed shape
    // separates them.
    const stamp = stampFor(new Date("2026-07-29T16:40:22.484Z"));
    const dashed = "xaLUAd13811rdYUEzKt7vaXYy-P8PAkhRcvqRshiNW4";
    const parsed = parseVintagePath(
      `${vintageDir("system/home.tsx", PINNED)}/${
        vintageFileName(stamp, dashed)
      }`,
    );

    expect(parsed?.stamp).toBe(stamp);
    expect(parsed?.identity).toBe(dashed);
  });

  it("substitutes the colons an ISO stamp carries", () => {
    // Legal on POSIX, illegal on Windows. Sortability is the only property
    // retention needs, and substitution preserves it.
    const stamp = stampFor(new Date("2026-07-29T16:33:28.000Z"));
    expect(stamp).not.toContain(":");
    expect(stamp).toBe("2026-07-29T16-33-28.000Z");
  });

  it("sorts lexically in capture order", () => {
    // Stage 4 retention drops the oldest AUTO captures by name alone, so the
    // stamp has to sort chronologically as a string.
    const early = stampFor(new Date("2026-07-29T09:00:00.000Z"));
    const late = stampFor(new Date("2026-07-29T16:33:28.000Z"));
    expect([late, early].sort()).toEqual([early, late]);
  });

  it("keeps a pattern key with directories intact", () => {
    const path = `${vintageDir("google/core/imported-calendar.tsx", AUTO)}/${
      vintageFileName("2026-01-01T00-00-00.000Z", ID_A)
    }`;
    const parsed = parseVintagePath(path);

    expect(parsed?.patternKey).toBe("google/core/imported-calendar.tsx");
    expect(parsed?.tier).toBe(AUTO);
  });

  it("declines anything that is not a fixture", () => {
    // Returning undefined rather than throwing is what lets the enumerator
    // walk a directory holding a README without the gate dying on it.
    for (
      const path of [
        `${VINTAGES_DIR}/system/home.tsx/pinned/README.md`,
        `${VINTAGES_DIR}/system/home.tsx/pinned/no-identity.sqlite.gz`,
        `${VINTAGES_DIR}/loose.sqlite.gz`,
        "packages/patterns/system/home.tsx",
        `${VINTAGES_DIR}/system/home.tsx/pinned/-${ID_A}.sqlite.gz`,
      ]
    ) {
      expect(parseVintagePath(path), `should decline: ${path}`).toBeUndefined();
    }
  });
});

describe("coverage", () => {
  const pinned = (patternKey: string, identity: string) => ({
    patternKey,
    tier: PINNED,
    stamp: "2026-07-29T00-00-00.000Z",
    identity,
    path: `${vintageDir(patternKey, PINNED)}/x`,
  });

  it("counts only PINNED vintages as coverage", () => {
    // An auto capture is regenerable and pruned by count; it cannot be what
    // keeps a system pattern covered, or retention would silently delete the
    // gate's only evidence.
    const covered = coveredPatternKeys([
      pinned("system/home.tsx", ID_A),
      {
        patternKey: "system/journal.tsx",
        tier: AUTO,
        stamp: "2026-07-29T00-00-00.000Z",
        identity: ID_B,
        path: "x",
      },
    ]);

    expect([...covered]).toEqual(["system/home.tsx"]);
  });

  it("reports a required pattern with no vintage", () => {
    const uncovered = uncoveredRequiredPatterns(
      ["system/home.tsx", "system/default-app.tsx"],
      [pinned("system/home.tsx", ID_A)],
    );

    expect(uncovered).toEqual(["system/default-app.tsx"]);
  });

  it("does not require a vintage for a pattern nobody auto-updates", () => {
    // A vintage that EXISTS is always replayed; this list only governs what is
    // REQUIRED. Requiring everything under system/ would wedge the gate on the
    // files there that are not patterns at all.
    expect(uncoveredRequiredPatterns(["system/home.tsx"], [
      pinned("system/home.tsx", ID_A),
    ])).toEqual([]);
  });

  it("derives the required set from the runtime's own URL constants", () => {
    // Hand-listing them would let the gate drift from what actually
    // auto-updates — silently covering nothing the day a third root is added.
    expect(requiredPatternKeys([
      "/api/patterns/system/home.tsx",
      "/api/patterns/system/default-app.tsx",
    ])).toEqual(["system/default-app.tsx", "system/home.tsx"]);
  });

  it("ignores a URL that is not a pattern route", () => {
    expect(requiredPatternKeys(["/api/meta", ""])).toEqual([]);
  });

  it("treats several vintages of one pattern as one covered pattern", () => {
    const uncovered = uncoveredRequiredPatterns(
      ["system/home.tsx"],
      [pinned("system/home.tsx", ID_A), pinned("system/home.tsx", ID_B)],
    );

    expect(uncovered).toEqual([]);
  });
});

describe("collectVintages", () => {
  it("finds fixtures at any depth and ignores non-fixtures", async () => {
    const root = await Deno.makeTempDir({ prefix: "vintage-collect-" });
    try {
      const dir = `${root}/system/home.tsx/pinned`;
      await Deno.mkdir(dir, { recursive: true });
      await Deno.writeTextFile(
        `${dir}/2026-07-29T16-33-28.000Z-${ID_A}.sqlite.gz`,
        "",
      );
      await Deno.writeTextFile(`${dir}/README.md`, "not a fixture");

      const found = await collectVintages(root);
      expect(found.map((v) => ({
        patternKey: v.patternKey,
        tier: v.tier,
        identity: v.identity,
      }))).toEqual([
        { patternKey: "system/home.tsx", tier: PINNED, identity: ID_A },
      ]);
    } finally {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
  });

  it("returns empty rather than throwing when the tree does not exist", async () => {
    // "No fixtures yet" must report as uncovered patterns — the actionable
    // message — not as an ENOENT from the gate.
    expect(await collectVintages("/nonexistent/vintages/root")).toEqual([]);
  });
});
