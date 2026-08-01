import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  armVerdictGuard,
  AUTO,
  collectVintages,
  describeError,
  isClean,
  parseVintagePath,
  patternKeyFromMain,
  PINNED,
  relativeToRepo,
  reportFailures,
  reportNothingReplayed,
  reportNoVerdict,
  reportReplaySummary,
  reportUncovered,
  reportUnmappedUrls,
  reportUpdateNeedsATestKey,
  requiredPatternKeys,
  stampFor,
  uncoveredRequiredPatterns,
  unmappedPatternUrls,
  vintageDir,
  vintageFileName,
  VINTAGES_DIR,
} from "./pattern-vintage-lib.ts";
import {
  schemaRelaxedForComparison,
  strandedKeys,
} from "../packages/piece/test/state-continuity-harness.ts";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import {
  companionFileName,
  companionSpace,
  vintageCompanionDir,
} from "../packages/piece/test/vintage-layout.ts";

const ID_A = "bafyaaaa";
const ID_B = "bafybbbb";

/**
 * Just the keys. Most comparison cases below are about WHICH keys are findings;
 * how each one GRADES is its own describe block at the end of that section.
 */
const findingKeys = (
  before: Record<string, unknown>,
  after: unknown,
): string[] => strandedKeys(before, after).map((finding) => finding.key);

describe("vintage paths", () => {
  it("round-trips a path it built itself", () => {
    const stamp = stampFor(new Date("2026-07-29T16:33:28.000Z"));
    const path = `${vintageDir("system/home.test.tsx", PINNED)}/${
      vintageFileName(stamp, ID_A)
    }`;
    const parsed = parseVintagePath(path);

    expect(parsed).toEqual({
      testKey: "system/home.test.tsx",
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
      `${vintageDir("system/home.test.tsx", PINNED)}/${
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
      `${vintageDir("system/home.test.tsx", PINNED)}/${
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
    const path = `${
      vintageDir("google/core/imported-calendar.test.tsx", AUTO)
    }/${vintageFileName("2026-01-01T00-00-00.000Z", ID_A)}`;
    const parsed = parseVintagePath(path);

    expect(parsed?.testKey).toBe("google/core/imported-calendar.test.tsx");
    expect(parsed?.tier).toBe(AUTO);
  });

  it("declines anything that is not a fixture", () => {
    // Returning undefined rather than throwing is what lets the enumerator
    // walk a directory holding a README without the gate dying on it.
    for (
      const path of [
        `${VINTAGES_DIR}/system/home.test.tsx/pinned/README.md`,
        `${VINTAGES_DIR}/system/home.test.tsx/pinned/no-identity.sqlite`,
        `${VINTAGES_DIR}/loose.sqlite`,
        "packages/patterns/system/home.tsx",
        `${VINTAGES_DIR}/system/home.test.tsx/pinned/-${ID_A}.sqlite`,
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
    const fixture = `${vintageDir("system/home.test.tsx", PINNED)}/${
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
  it("reports a required pattern with no vintage", () => {
    // Coverage is what the replay actually REPLAYED, not what the fixture tree
    // looks like: a fixture is named after the test that made it and covers
    // several patterns, so a directory name is no longer the evidence.
    const uncovered = uncoveredRequiredPatterns(
      ["system/home.tsx", "system/default-app.tsx"],
      new Set(["system/home.tsx"]),
    );

    expect(uncovered).toEqual(["system/default-app.tsx"]);
  });

  it("does not require a vintage for a pattern nobody auto-updates", () => {
    // A vintage that EXISTS is always replayed; this list only governs what is
    // REQUIRED. Requiring everything under system/ would wedge the gate on the
    // files there that are not patterns at all.
    expect(uncoveredRequiredPatterns(
      ["system/home.tsx"],
      new Set(["system/home.tsx"]),
    )).toEqual([]);
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

  it("derives keys from the `system:` refs the runtime actually holds", () => {
    expect(requiredPatternKeys([
      "system:system/home.tsx",
      "system:system/default-app.tsx",
    ])).toEqual(["system/default-app.tsx", "system/home.tsx"]);
    // A source naming no route is not silently dropped from the required set:
    // it stays unmapped, and the caller refuses to run on it.
    expect(unmappedPatternUrls(["system:system/home.tsx"])).toEqual([]);
    expect(unmappedPatternUrls(["system:", "cf:published"]))
      .toEqual(["system:", "cf:published"]);
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

  it("ignores covered keys nothing required", () => {
    // Coverage is asked per REQUIRED key, so a fixture covering extra patterns
    // neither helps nor hurts. (Deduplication is not tested here and cannot be:
    // the argument is a Set, so `new Set([x, x])` collapses before the call —
    // an earlier version of this case asserted exactly that and could not fail.
    // What builds the set is `replayVintage`, covered by
    // "credits coverage only for a PINNED fixture" in
    // `pattern-vintage-run.test.ts`.)
    expect(uncoveredRequiredPatterns(
      ["system/home.tsx"],
      new Set(["system/home.tsx", "topics/main.tsx", "lunch-poll/main.tsx"]),
    )).toEqual([]);
    // ...and a near-miss is still uncovered: matching is by exact key.
    expect(uncoveredRequiredPatterns(
      ["system/home.tsx"],
      new Set(["system/home.test.tsx"]),
    )).toEqual(["system/home.tsx"]);
  });
});

describe("collectVintages", () => {
  it("finds fixtures at any depth and ignores non-fixtures", async () => {
    const root = await Deno.makeTempDir({ prefix: "vintage-collect-" });
    try {
      const dir = `${root}/system/home.test.tsx/pinned`;
      await Deno.mkdir(dir, { recursive: true });
      await Deno.writeTextFile(
        `${dir}/2026-07-29T16-33-28.000Z-${ID_A}.sqlite`,
        "",
      );
      await Deno.writeTextFile(`${dir}/README.md`, "not a fixture");

      const found = await collectVintages(root);
      expect(found.map((v) => ({
        testKey: v.testKey,
        tier: v.tier,
        identity: v.identity,
      }))).toEqual([
        { testKey: "system/home.test.tsx", tier: PINNED, identity: ID_A },
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
    testKey: "system/home.test.tsx",
    path: `${VINTAGES_DIR}/system/home.test.tsx/pinned/x.sqlite`,
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

    // The fixture is named after the TEST that produced it, so that is what a
    // failure line points at — the manifest says which patterns it covers.
    expect(report).toContain("system/home.test.tsx");
    expect(report).toContain(failure.path);
    expect(report).toContain("REFUSED");
    // The stakes, because a red gate on a test fixture reads as ignorable and
    // this one is not.
    expect(report).toContain("deployed piece is holding RIGHT NOW");
  });

  it("reports every failure, not just the first", () => {
    const report = reportFailures([
      failure,
      { ...failure, testKey: "system/default-app.tsx" },
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
      servedRoute: 0,
    });

    expect(summary).toBe(
      "Replayed 2 vintage(s): 12 recorded instantiation(s), all mappable to " +
        "a file; 5 upgrade target(s), 3 changed since capture, 3 updated " +
        "cleanly with no state stranded.",
    );
  });

  it("says when targets went unexamined as SERVED ROUTES", () => {
    // A served route is a target the run deliberately did not identity-compare
    // — the same file compiles to a different identity served than from the
    // repo, so comparing would report it changed forever. The count existed to
    // stop a mostly-served-route fixture reading as thorough coverage, and
    // nothing displayed it, so it stopped one from nothing at all.
    expect(reportReplaySummary({
      replayed: 1,
      candidates: 12,
      targets: 5,
      changed: 3,
      updated: 3,
      servedRoute: 2,
    })).toContain(
      "2 target(s) were served routes and not identity-compared.",
    );
  });

  it("refuses --update with no test named, and says what to name", () => {
    // There is deliberately no default set. The only moment one would help is
    // when a fixture is MISSING — precisely when nothing on disk can say which
    // test covers the pattern, since a test need not be named after what it
    // drives. The hand-kept list that used to stand in for that answer was a
    // seam: the required PATTERNS derive from the runtime's URL constants, so
    // adding one no listed test instantiated left the gate red while --update
    // reported everything fine and exited 0.
    const message = reportUpdateNeedsATestKey();

    expect(message).toContain("--update <test path>");
    // A concrete example, because "test path" alone is the thing people get
    // wrong — a pattern path names no test and captures nothing.
    expect(message).toContain("topics/topics.test.tsx");
    expect(message).toContain("not a pattern");
    // And the fact that removes the recurring confusion: nothing lists what
    // CI replays, so committing a fixture is the whole of adding one.
    expect(message).toContain("no list anywhere");
  });

  it("tells an uncovered pattern apart from one that was merely not credited", () => {
    // Two different problems with two different remedies. A pattern some
    // fixture DID replay was excluded after the fact — a served route, or a
    // fixture that no longer holds the root — and recapturing it fixes
    // nothing. A pattern no fixture records has nothing to replay at all.
    const both = reportUncovered(
      ["system/home.tsx", "system/newcomer.tsx"],
      new Map([["system/home.tsx", "system/home.test.tsx"]]),
    );

    // The known one is named WITH the test that covers it, so the reader can
    // go look at that fixture rather than guessing.
    expect(both).toContain(
      "system/home.tsx  (covered by system/home.test.tsx)",
    );
    expect(both).toContain("replayed and");
    // ...and the unknown one gets the capture instruction.
    expect(both).toContain("--update <test path>");

    // With everything already covered by some fixture, the capture advice must
    // NOT appear — it would send a reader to recapture a fixture that exists.
    const knownOnly = reportUncovered(
      ["system/home.tsx"],
      new Map([["system/home.tsx", "system/home.test.tsx"]]),
    );
    expect(knownOnly).not.toContain("--update <test path>");

    // With none known, no fixture is named and the advice is the whole of it.
    const unknownOnly = reportUncovered(["system/newcomer.tsx"], new Map());
    expect(unknownOnly).not.toContain("covered by");
    expect(unknownOnly).toContain("--update <test path>");
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

describe("stranded-state comparison", () => {
  it("reports a key whose value the update stopped preserving", () => {
    // The class the gate exists for. A moved storage key leaves the contract
    // untouched and the data unreachable, so the value is the only witness.
    expect(findingKeys(
      { journal: [{ event: "created" }], items: ["a"] },
      { journal: [], items: ["a"] },
    )).toEqual(["journal"]);
  });

  it("does not report a key the update ADDED", () => {
    // Adding a field is what `Default<>` is for. Only keys present BEFORE are
    // compared; treating a new key as loss would fail every additive change.
    expect(findingKeys({ items: ["a"] }, { items: ["a"], favorites: [] }))
      .toEqual([]);
  });

  it("reports a key that disappeared entirely", () => {
    expect(findingKeys({ items: ["a"] }, {})).toEqual(["items"]);
  });

  it("treats a missing after-state as everything stranded", () => {
    // A materialize that produced no readable root lost all of it; saying
    // "nothing changed" there would be the quietest possible false green.
    expect(findingKeys({ a: 1, b: 2 }, undefined)).toEqual(["a", "b"]);
  });

  it("compares by value, not identity", () => {
    expect(findingKeys({ a: [1, 2] }, { a: [1, 2] })).toEqual([]);
    expect(findingKeys({ a: [1, 2] }, { a: [2, 1] })).toEqual(["a"]);
  });

  it("does not treat an empty before-state as a finding", () => {
    // A vintage whose root held nothing has nothing to strand. The "did it
    // restore" control is what catches an empty fixture; this must not
    // double-report it as data loss.
    expect(findingKeys({}, { items: ["a"] })).toEqual([]);
  });

  it("does not compare the RENDERINGS", () => {
    // `$UI` and its variants are recomputed by the setup, and the stored
    // rendering and a fresh one are not the same artifact — measured on the
    // committed `default-app.tsx` fixture, a COMMENT-only edit to
    // `piece-grid.tsx` reports `$UI` as stranded. Comparing them says nothing
    // about data and reds every pattern edit.
    expect(findingKeys(
      { $UI: { children: [null] }, $TILE_UI: { a: 1 }, $CHIP_UI: 1, items: [] },
      { $UI: { children: [[]] }, $TILE_UI: { a: 2 }, $CHIP_UI: 2, items: [] },
    )).toEqual([]);
  });

  it("does not compare a RENDERING that sits under no `$UI` key", () => {
    // The name list cannot reach this one. A transformer hoist
    // (`__cfPattern_N`, the body of a `map`) is a recorded instantiation in its
    // own right, and its whole result is a vnode — keys `type`/`name`/`props`/
    // `children`, no `$UI` anywhere. Measured on the committed
    // `default-app.tsx` fixture, which records two of them: a UI-only edit
    // inside that map body reported `children` stranded on both and took the
    // gate to exit 1, for a change that stores nothing.
    const row = (label: string) => ({
      type: "vnode",
      name: "tr",
      props: {},
      children: [{ type: "vnode", name: "td", props: {}, children: [label] }],
    });
    expect(findingKeys(row("🗑️"), row("✕"))).toEqual([]);
    // ...and nested inside state, where the name list cannot reach it either.
    expect(findingKeys(
      { items: [{ label: "a", view: row("🗑️") }] },
      { items: [{ label: "a", view: row("✕") }] },
    )).toEqual([]);
  });

  it("still reports a key whose RENDERING became data, or data a rendering", () => {
    // The reduction is not a blanket skip of anything vnode-shaped: it says
    // "two renderings are the same artifact", not "this key is exempt".
    const view = { type: "vnode", name: "tr", props: {}, children: [] };
    expect(findingKeys({ preview: view }, { preview: ["a"] }))
      .toEqual(["preview"]);
    expect(findingKeys({ preview: ["a"] }, { preview: view }))
      .toEqual(["preview"]);
  });

  it("still compares $NAME, which is derived but stable", () => {
    // The exclusion is the renderings, NOT derived values in general: `$NAME`
    // stayed equal across both measured UI-only edits, and it is a cheap tell
    // that the data behind it went missing.
    expect(findingKeys({ $NAME: "Home (2)" }, { $NAME: "Home (0)" }))
      .toEqual(["$NAME"]);
  });

  it("compares a fabric value by its CONTENTS", () => {
    // The quietest failure this comparison could have. A fabric special object
    // keeps its state in private fields, so a structural comparison sees two
    // objects with no properties and calls them equal whatever they hold —
    // `deepEqual` documents exactly that. Reduced to a tagged content hash
    // first, so a changed one is a finding and an unchanged one is not.
    const held = new FabricBytes(new Uint8Array([1, 2, 3]));
    const identical = new FabricBytes(new Uint8Array([1, 2, 3]));
    const different = new FabricBytes(new Uint8Array([9, 9, 9]));
    expect(findingKeys({ blob: held }, { blob: identical })).toEqual([]);
    expect(findingKeys({ blob: held }, { blob: different })).toEqual(["blob"]);
  });

  it("grades a value that went EMPTY as lost, and one that merely changed as not", () => {
    // The grading the gate keys its verdict on: `lost` fails, a bare change
    // only warns. All three of these are real measurements from the committed
    // fixtures, and none of them is data going missing — each is the new
    // version resolving something the old one had left unresolved, because a
    // replay recomputes as well as reads.
    const changed = [
      // `topic.tsx` backfilling from its own `createdByName` shadow.
      [{ createdBy: { kind: "person", name: "" } }, {
        createdBy: { kind: "person", name: "t" },
      }],
      [{ $NAME: "Topics (2)" }, { $NAME: "Topics (3)" }],
      [{ artSyncState: "" }, { artSyncState: "generated" }],
    ] as const;
    for (const [before, after] of changed) {
      const findings = strandedKeys(before, after);
      expect(findings.length, `${JSON.stringify(before)}`).toBe(1);
      expect(findings[0].lost, `${JSON.stringify(before)} should only warn`)
        .toBe(false);
    }

    // ...and the shape that still stops the gate: something became nothing.
    for (
      const [before, after] of [
        [{ journal: [{ event: "created" }] }, { journal: [] }],
        [{ items: ["a"] }, {}],
        [{ title: "captured" }, { title: "" }],
        [{ count: 7 }, { count: 0 }],
        [{ enabled: true }, { enabled: false }],
        [{ child: { note: "captured" } }, { child: {} }],
      ] as const
    ) {
      const findings = strandedKeys(before, after);
      expect(findings.length, `${JSON.stringify(before)}`).toBe(1);
      expect(findings[0].lost, `${JSON.stringify(before)} should FAIL`)
        .toBe(true);
    }
  });

  it("grades PARTIAL loss as lost, not merely changed", () => {
    // The class whole-value grading missed. `isEmptyValue` is shallow, so
    // judging emptiness only at the top means a key fails only when it empties
    // ENTIRELY — and a `.for()` list, the commonest durable shape here, almost
    // never does. Every row below was measured WARNING before the emptiness
    // test recursed, which is the gate reporting "state changed" for state that
    // is gone.
    for (
      const [label, before, after] of [
        ["rows unreadable", { items: ["a", "b", "c"] }, {
          items: [undefined, undefined, undefined],
        }],
        ["array truncated", { items: ["a", "b", "c"] }, { items: ["a"] }],
        ["sibling survives", { profile: { name: "ada", id: 1 } }, {
          profile: { id: 1 },
        }],
        ["row body emptied", { items: [{ t: "x", body: "real" }] }, {
          items: [{ t: "x", body: "" }],
        }],
        ["array became an object", { items: ["a"] }, { items: { 0: "a" } }],
      ] as const
    ) {
      const findings = strandedKeys(before, after);
      expect(findings.length, label).toBe(1);
      expect(findings[0].lost, `${label} should FAIL, not warn`).toBe(true);
    }

    // ...and the recursion costs none of the warnings it was added alongside:
    // a leaf that was ALREADY empty had nothing to lose, and two non-empty
    // scalars differing is a change.
    for (
      const [label, before, after] of [
        ["nested gain", { createdBy: { kind: "person", name: "" } }, {
          createdBy: { kind: "person", name: "t" },
        }],
        ["row gained a field", { items: [{ t: "x" }] }, {
          items: [{ t: "x", extra: "new" }],
        }],
        ["scalar replaced", { note: "written" }, { note: "captured" }],
      ] as const
    ) {
      const findings = strandedKeys(before, after);
      if (findings.length === 0) continue; // an addition is not a finding
      expect(findings[0].lost, `${label} should only warn`).toBe(false);
    }
  });

  it("does not call a value lost when it was already empty", () => {
    // Nothing to lose. An empty-to-different transition is the ordinary
    // additive case a replay produces constantly, and grading it as loss would
    // fail the gate on every field a new version starts filling in.
    const findings = strandedKeys({ note: "" }, { note: "written" });
    expect(findings.map((finding) => finding.lost)).toEqual([false]);
  });

  it("grades a REPOINTED cell as changed, and a vanished one as lost", () => {
    // `{"[cell]": {...}}` is an identity, not a container: a cell that looks
    // empty still names a document. So a cell pointing somewhere ELSE is a
    // change, not an emptying, and only WARNS.
    //
    // That is a real limit and it is deliberate, not an oversight: a pattern
    // update rotates compiler-generated internal cell identities on purpose,
    // so failing on a moved reduction would red every legitimate edit. The
    // consequence is that a genuinely repointed `of:` document is warned about
    // rather than failed on — the `of:`-versus-`computed:` weighting noted on
    // `StateFinding` is what would separate the two, and the reduction carries
    // the id that would answer it.
    const cell = (id: string) => ({ "[cell]": { space: "s", id, path: [] } });
    const findings = strandedKeys({ ref: cell("a") }, { ref: cell("b") });
    expect(findings.map((finding) => finding.key)).toEqual(["ref"]);
    expect(findings[0].lost).toBe(false);
    // A cell that became NOTHING is lost — the emptiness test runs before the
    // identity comparison, so this is not covered by the warn above.
    expect(strandedKeys({ ref: cell("a") }, {})[0].lost).toBe(true);
    // ...including one nested inside a container that survives, which is the
    // shape whole-value grading used to miss.
    expect(
      strandedKeys({ box: { ref: cell("a"), keep: 1 } }, {
        box: { keep: 1 },
      })[0].lost,
    ).toBe(true);
  });

  it("survives a value that points back at itself", () => {
    // A materialized root can be cyclic — the live cell at every stream
    // position reaches the runtime, which reaches itself. Left in, the
    // comparison recurses until the stack ends and takes every remaining
    // fixture down with it.
    const before: Record<string, unknown> = { items: ["a"] };
    before.self = before;
    const after: Record<string, unknown> = { items: ["a"] };
    after.self = after;
    expect(findingKeys(before, after)).toEqual([]);
  });
});

describe("stranded-state comparison is a SUBSET check", () => {
  it("does not report a nested object that gained a field", () => {
    // The false positive the cross-space case surfaced. An update may ADD, and
    // additions are not only top-level: a nested pattern gaining a defaulted
    // field turns {note, owner} into {note, owner, addedLater: []} several
    // levels down. Comparing for equality reds a perfectly compatible change.
    expect(findingKeys(
      { child: { note: "captured", owner: "v" } },
      { child: { owner: "v", note: "captured", addedLater: [] } },
    )).toEqual([]);
  });

  it("still reports a nested value that CHANGED", () => {
    expect(findingKeys(
      { child: { note: "captured" } },
      { child: { note: "different" } },
    )).toEqual(["child"]);
  });

  it("still reports a nested key that DISAPPEARED", () => {
    expect(findingKeys({ child: { note: "captured" } }, { child: {} }))
      .toEqual(["child"]);
  });

  it("allows an array to grow but not to lose or reorder", () => {
    // Appending is an addition. Truncating loses data, and reordering moves an
    // element out from under a reader that knew its index.
    expect(findingKeys({ xs: [1, 2] }, { xs: [1, 2, 3] })).toEqual([]);
    expect(findingKeys({ xs: [1, 2] }, { xs: [1] })).toEqual(["xs"]);
    expect(findingKeys({ xs: [1, 2] }, { xs: [2, 1] })).toEqual(["xs"]);
  });

  it("does NOT subset a reduction — a cell is an identity, not a shape", () => {
    // `{"[cell]": {space, id, path}}` is what a cell- or stream-valued key
    // reduces to, and its `path` is an array. Left to the subset rule, a
    // longer path is a superset and so "preserved": a stream that moved from
    // the document root to `["value"]` in the SAME document would read clean,
    // which is the moved-storage class this whole comparison exists for.
    const at = (path: string[]) => ({
      "[cell]": { space: "did:key:zA", id: "of:fid1:one", path },
    });
    expect(findingKeys({ touch: at([]) }, { touch: at([]) })).toEqual([]);
    expect(findingKeys({ touch: at([]) }, { touch: at(["value"]) }))
      .toEqual(["touch"]);
    expect(findingKeys({ touch: at(["a"]) }, { touch: at(["b"]) }))
      .toEqual(["touch"]);
  });

  it("treats a before-value of `undefined` as nothing to strand", () => {
    // The before state is read under the root's stored schema, and a
    // schema-driven read enumerates the keys the schema DECLARES whether or not
    // the document holds them — measured on the committed `home.tsx` fixture,
    // `defaultProfile` reads as `undefined` because that root predates any
    // profile being created. An update that starts filling one in — a
    // `Default<>` added to a field already declared — added data rather than
    // stranding it.
    expect(findingKeys({ defaultProfile: undefined }, { defaultProfile: "v" }))
      .toEqual([]);
    // The other direction is still loss: something was there, and is not now.
    expect(findingKeys({ defaultProfile: "v" }, { defaultProfile: undefined }))
      .toEqual(["defaultProfile"]);
  });
});

/**
 * The read the comparison rests on, and the one place it could go silently
 * blind: a value the schema does not resolve arrives here as `undefined`, which
 * the rule above then reads as "held nothing".
 */
describe("relaxing the stored schema for reading", () => {
  it("drops an `unknown` type wherever it sits", () => {
    // Both spellings, because a pattern reaches them differently: a DECLARED
    // `unknown` field lowers to the first, and an index signature
    // (`[key: string]: unknown`, which `system/default-app.tsx` declares) to
    // the second. Measured on the committed `default-app.tsx` fixture, the
    // second is what hid `recentPieces`, `summaryIndex` and `trackRecent`.
    expect(schemaRelaxedForComparison({
      type: "object",
      properties: { note: { type: "unknown" } },
      additionalProperties: { type: "unknown" },
    })).toEqual({
      type: "object",
      properties: { note: {} },
      additionalProperties: {},
    });
  });

  it("drops a union that INCLUDES `unknown`, which constrains nothing", () => {
    expect(schemaRelaxedForComparison({ type: ["string", "unknown"] }))
      .toEqual({});
    // ...and leaves a union that does not.
    expect(schemaRelaxedForComparison({ type: ["string", "null"] }))
      .toEqual({ type: ["string", "null"] });
  });

  it("keeps every other keyword, so a stream still reduces to its document", () => {
    // What makes this a RELAXATION rather than a different read. Reading under
    // a bare `{}` would resolve the same keys, but without `asCell` a stream
    // comes back as its VALUE instead of the document it points at — and a
    // field that moved to a different doc is the class this comparison exists
    // for.
    expect(schemaRelaxedForComparison({
      asCell: ["stream"],
      type: "unknown",
      ifc: { classification: ["secret"] },
    })).toEqual({ asCell: ["stream"], ifc: { classification: ["secret"] } });
  });

  it("relaxes inside `$defs`, which is where a `$ref` lands", () => {
    expect(schemaRelaxedForComparison({
      $ref: "#/$defs/Row",
      $defs: {
        Row: { type: "object", properties: { v: { type: "unknown" } } },
      },
    })).toEqual({
      $ref: "#/$defs/Row",
      $defs: { Row: { type: "object", properties: { v: {} } } },
    });
  });

  it("keeps a property that is NAMED `type`", () => {
    // The keyword and a property name are the same string. Dropping on the key
    // alone would delete the property, which is a schema the document no longer
    // matches rather than a relaxed one.
    expect(schemaRelaxedForComparison({
      type: "object",
      properties: { type: { type: "unknown" } },
    })).toEqual({
      type: "object",
      properties: { type: {} },
    });
  });

  it("drops `required` at every depth", () => {
    // A schema-driven read answers `undefined` for the WHOLE object when a
    // required property does not resolve. Patterns mark session-local drafts
    // required — `topic.tsx` requires `bodyDraft`, `editingBody` and three
    // more — and those are links to per-session cells a fresh replay runtime
    // holds nothing for. Enforcing it hid all 28 keys of real state behind one
    // absent draft, which is the opposite of what a comparison wants: it turns
    // the moved key the gate is hunting into an unreadable root.
    expect(schemaRelaxedForComparison({
      type: "object",
      properties: {
        row: {
          type: "object",
          properties: { v: { type: "string" } },
          required: ["v"],
        },
      },
      required: ["row"],
    })).toEqual({
      type: "object",
      properties: {
        row: { type: "object", properties: { v: { type: "string" } } },
      },
    });
  });

  it("keeps a property that is NAMED `required`", () => {
    // Same collision as `type`: the keyword's value is an ARRAY of names, a
    // property of that name holds a schema object. Matching on the key alone
    // would delete the property.
    expect(schemaRelaxedForComparison({
      type: "object",
      properties: { required: { type: "boolean" } },
      required: ["required"],
    })).toEqual({
      type: "object",
      properties: { required: { type: "boolean" } },
    });
  });

  it("leaves a schema with neither `unknown` nor `required` alone", () => {
    const schema = {
      type: "object",
      properties: { items: { type: "array", items: { type: "string" } } },
    };
    expect(schemaRelaxedForComparison(schema)).toEqual(schema);
    // Booleans are schemas too, and neither is an object to walk.
    expect(schemaRelaxedForComparison(true)).toBe(true);
    expect(schemaRelaxedForComparison(false)).toBe(false);
  });
});

describe("a recorded `main` maps back to a pattern key", () => {
  it("takes a repo path", () => {
    expect(
      patternKeyFromMain(
        "/packages/patterns/system/home.tsx",
        "/packages/patterns/",
      ),
    )
      .toBe("system/home.tsx");
  });

  it("takes the ROUTE the toolshed serves a pattern at", () => {
    // Not hypothetical: `lunch-poll/main.tsx` loads `profile-create` by URL, so
    // its manifest records `/api/patterns/...`. Resolved against the repo root
    // that is `<repo>/api/patterns/...`, which does not exist — the replay
    // reported a pattern sitting right there as unresolvable.
    expect(
      patternKeyFromMain(
        "/api/patterns/system/profile-create.tsx",
        "/packages/patterns/",
      ),
    )
      .toBe("system/profile-create.tsx");
  });

  it("declines an /api path whose `/patterns/` is not the mount", () => {
    // Matching "/api" plus the marker ANYWHERE resolved
    // `/api/anything/at/all/patterns/x.tsx` to the repo key `x.tsx`, so an
    // unrelated served path would name a real source file and be replayed as
    // though it were that pattern. A wrong answer, not a refused one — which
    // is the one thing this gate must never produce.
    for (
      const main of [
        "/api/v2/patterns/system/home.tsx",
        "/api/pieces/x/patterns/system/home.tsx",
        "/apifoo/patterns/system/home.tsx",
        "/patterns/system/home.tsx",
      ]
    ) {
      expect(patternKeyFromMain(main, "/packages/patterns/"), main)
        .toBeUndefined();
    }
  });

  it("declines anything that is neither", () => {
    expect(patternKeyFromMain(undefined, "/packages/patterns/"))
      .toBeUndefined();
    expect(patternKeyFromMain("cfc.ts", "/packages/patterns/")).toBeUndefined();
    // A path merely CONTAINING the marker is not a served route: the mount is
    // what makes it one, so the prefix has to be there.
    expect(
      patternKeyFromMain("/elsewhere/patterns/x.tsx", "/packages/patterns/"),
    ).toBeUndefined();
  });
});
