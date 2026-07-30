import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  armVerdictGuard,
  AUTO,
  collectVintages,
  coveredPatternKeys,
  describeError,
  isClean,
  parseVintagePath,
  PINNED,
  relativeToRepo,
  reportFailures,
  reportNothingReplayed,
  reportNoVerdict,
  reportReplaySummary,
  reportUncovered,
  reportUnmappedUrls,
  requiredPatternKeys,
  stampFor,
  uncoveredRequiredPatterns,
  unmappedPatternUrls,
  vintageDir,
  vintageFileName,
  VINTAGES_DIR,
} from "./pattern-vintage-lib.ts";
import {
  companionFileName,
  companionSpace,
  vintageCompanionDir,
} from "../packages/piece/test/vintage-layout.ts";

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
        `${VINTAGES_DIR}/system/home.tsx/pinned/no-identity.sqlite`,
        `${VINTAGES_DIR}/loose.sqlite`,
        "packages/patterns/system/home.tsx",
        `${VINTAGES_DIR}/system/home.tsx/pinned/-${ID_A}.sqlite`,
      ]
    ) {
      expect(parseVintagePath(path), `should decline: ${path}`).toBeUndefined();
    }
  });

  it("declines a companion store — it is part of a fixture, not one", () => {
    // A multi-space fixture keeps its other spaces beside the primary file, and
    // each is a raw `.sqlite` under a `.sqlite.spaces/` directory. Enumerating
    // one as a vintage in its own right would replay another space's store
    // against a pattern key it never belonged to.
    const fixture = `${vintageDir("system/home.tsx", PINNED)}/${
      vintageFileName("2026-01-01T00-00-00.000Z", ID_A)
    }`;
    const companions = vintageCompanionDir(fixture);

    expect(parseVintagePath(fixture)).toBeDefined();
    expect(
      parseVintagePath(
        `${companions}/${encodeURIComponent("did:key:zChild")}.sqlite`,
      ),
    ).toBeUndefined();
    // Not merely because a DID does not parse as `<stamp>-<identity>`: a
    // companion whose name DOES look like one is still declined.
    expect(
      parseVintagePath(
        `${companions}/${vintageFileName("2026-01-01T00-00-00.000Z", ID_B)}`,
      ),
    ).toBeUndefined();
  });

  it("names a companion by its space, and declines one it could not have written", () => {
    // Round-trip first: a DID is full of `:` and survives the encoding intact.
    const did = "did:key:z6MkheCA7HT1DG4B4SvCi8eKiRt9r14iYzQowFLgwC8k7UR8";
    expect(companionSpace(companionFileName(did))).toBe(did);

    // And the guard. A bare `decodeURIComponent` THROWS on a malformed escape,
    // so one stray file in a companion directory would take down every fixture
    // in the run rather than its own — the failure mode this gate exists to not
    // have. `spaceFromStoreFilename` guards the store layout the same way.
    expect(() => decodeURIComponent("%zz")).toThrow();
    expect(companionSpace("%zz.sqlite")).toBeUndefined();
    expect(companionSpace("README.md")).toBeUndefined();
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

  it("names a URL the derivation could not map, rather than dropping it", () => {
    // The dangerous shape: reroute the patterns endpoint and every required
    // key derives to nothing, leaving a gate that insists on nothing while
    // still exiting 0. The caller refuses to run on this, so the drift is
    // loud rather than a silently empty requirement.
    expect(unmappedPatternUrls([
      "/api/patterns/system/home.tsx",
      "/api/pattern/system/default-app.tsx",
    ])).toEqual(["/api/pattern/system/default-app.tsx"]);
    expect(unmappedPatternUrls(["/api/patterns/system/home.tsx"])).toEqual([]);
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
        `${dir}/2026-07-29T16-33-28.000Z-${ID_A}.sqlite`,
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

describe("reporting", () => {
  const failure = {
    patternKey: "system/home.tsx",
    path: `${VINTAGES_DIR}/system/home.tsx/pinned/x.sqlite`,
    detail: "materializing today's source over this vintage was REFUSED",
  };

  it("names every uncovered pattern and the command that fixes it", () => {
    // The report is the gate's entire interface to whoever trips it. A gate
    // that fails with an unclear message costs more than one that fails late.
    const report = reportUncovered([
      "system/home.tsx",
      "system/default-app.tsx",
    ]);

    expect(report).toContain("system/home.tsx");
    expect(report).toContain("system/default-app.tsx");
    expect(report).toContain("deno task pattern-vintage --update");
    // Says WHY it matters, not just what is missing — the reader is usually
    // someone who has never heard of this gate.
    expect(report).toContain("bricks that piece");
  });

  it("names the pattern, the fixture, and the rejection for each failure", () => {
    const report = reportFailures([failure]);

    expect(report).toContain("system/home.tsx");
    expect(report).toContain(failure.path);
    expect(report).toContain("REFUSED");
    // The stakes, because a red gate on a test fixture reads as ignorable and
    // this one is not.
    expect(report).toContain("deployed piece is holding RIGHT NOW");
  });

  it("reports every failure, not just the first", () => {
    const report = reportFailures([
      failure,
      { ...failure, patternKey: "system/default-app.tsx" },
    ]);

    expect(report).toContain("2 vintage(s)");
    expect(report).toContain("system/default-app.tsx");
  });

  it("passes only when there is nothing to report", () => {
    // Stated once and tested, rather than an `if` at the bottom of main that a
    // later edit can quietly invert. A gate that exits 0 on failure is worse
    // than no gate at all.
    const counts = { replayed: 2, candidates: 5, targets: 5 };
    expect(isClean([], [], counts)).toBe(true);
    expect(isClean([failure], [], counts)).toBe(false);
    expect(isClean([], ["system/home.tsx"], counts)).toBe(false);
    expect(isClean([failure], ["system/home.tsx"], counts)).toBe(false);
  });

  it("states what a PASS actually covered, targets included", () => {
    // The success line is the whole of what a green run tells its reader, and
    // `targets` is the number that keeps it honest: 12 recorded instantiations
    // of which only 5 could be applied is very different coverage from 12 of 12.
    const summary = reportReplaySummary({
      replayed: 2,
      candidates: 12,
      targets: 5,
      changed: 3,
      updated: 3,
    });

    expect(summary).toBe(
      "Replayed 2 vintage(s): 12 recorded instantiation(s), all mappable to " +
        "a file; 5 upgrade target(s), 3 changed since capture, 3 updated " +
        "cleanly.",
    );
  });

  it("FAILS a run that replayed nothing, however clean it looks", () => {
    // The catastrophic shape: no failures, nothing uncovered, and no evidence
    // whatsoever. A run that replays nothing proves nothing, so it cannot be
    // the same answer as a run that replayed everything and found it readable.
    expect(isClean([], [], { replayed: 0, candidates: 0, targets: 0 })).toBe(
      false,
    );
    // The same shape one level in: fixtures replayed, but between them they
    // recorded no instantiation, so no update target was examined. "Replayed 2
    // vintage(s)" would read as success while proving nothing.
    expect(isClean([], [], { replayed: 2, candidates: 0, targets: 0 })).toBe(
      false,
    );
    // And one further in still: instantiations were recorded, but not one of
    // them is something today's source can be applied to — every candidate a
    // test pattern or a keyless session pointer. Nothing was updated and nothing
    // could have been, so this is not a pass either.
    expect(isClean([], [], { replayed: 2, candidates: 7, targets: 0 })).toBe(
      false,
    );
    expect(reportNothingReplayed()).toContain("covered NOTHING");
    expect(reportNothingReplayed()).toContain(
      "deno task pattern-vintage --update",
    );
  });

  it("names the URLs that stopped deriving a required pattern", () => {
    const report = reportUnmappedUrls(["/api/pattern/system/home.tsx"]);

    expect(report).toContain("/api/pattern/system/home.tsx");
    expect(report).toContain("requiredPatternKeys");
  });

  it("fails the run when the process ends without a verdict", () => {
    // The wiring, not just the message. This guard is the one piece of the
    // gate whose failure mode is SILENCE — before it, a `home.tsx` that did
    // not compile exited 0 with no output at all — so the listeners being
    // attached to the right events, in the right order, is the assertion.
    const target = new EventTarget();
    const exits: number[] = [];
    const logs: string[] = [];
    armVerdictGuard(target, (code) => exits.push(code), (m) => logs.push(m));

    const rejection = Object.assign(new Event("unhandledrejection"), {
      reason: new Error("database disk image is malformed"),
    });
    target.dispatchEvent(rejection);
    target.dispatchEvent(new Event("beforeunload"));

    expect(exits).toEqual([1]);
    // The rejection has to survive to the message: "something went wrong
    // somewhere" would send the reader looking in the wrong place.
    expect(logs[0]).toContain("database disk image is malformed");
  });

  it("still fails when no rejection was ever observed", () => {
    // A promise that simply never settles leaves nothing to report, and that
    // must still be a red rather than a pass for lack of evidence.
    const target = new EventTarget();
    const exits: number[] = [];
    armVerdictGuard(target, (code) => exits.push(code), () => {});

    target.dispatchEvent(new Event("beforeunload"));

    expect(exits).toEqual([1]);
  });

  it("explains an end with no verdict, and carries the rejection", () => {
    // Measured twice — a pattern that does not compile, and a truncated
    // fixture — both leave the replay's promise pending forever while the real
    // error surfaces as a rejection nobody awaits. The reader needs the
    // rejection, or the message is "something went wrong somewhere".
    const report = reportNoVerdict(
      new Error("database disk image is malformed"),
    );

    expect(report).toContain("without reaching a verdict");
    expect(report).toContain("database disk image is malformed");
    // And it still says something useful when nothing was observed.
    expect(reportNoVerdict(undefined)).toContain("unresolved await");
  });
});

describe("path and error helpers", () => {
  it("strips the repo root and leaves an outside path alone", () => {
    expect(relativeToRepo("/repo/packages/x.gz", "/repo")).toBe(
      "packages/x.gz",
    );
    expect(relativeToRepo("/elsewhere/x.gz", "/repo")).toBe("/elsewhere/x.gz");
  });

  it("describes a non-Error throw without rendering it useless", () => {
    // `String({})` is "[object Object]", which satisfies a truthiness check
    // while destroying the reason — the class of bug that made an earlier
    // rejection assertion pass for nothing.
    expect(describeError(new Error("boom"))).toBe("boom");
    expect(describeError("plain string")).toBe("plain string");
  });
});
