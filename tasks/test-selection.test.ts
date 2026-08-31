import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  coverageLines,
  dialLines,
  explainLines,
  laneArgument,
  parseIdentityArgument,
  planLines,
  verdictFor,
} from "./test-selection.ts";
import {
  freeCalibration,
  sampleEntry,
  sampleManifest,
} from "./test-selection/testing.ts";
import type { ManifestEntry } from "./test-selection/manifest.ts";
import {
  DIALS,
  EXCLUDED_FROM_COVERAGE_GATE,
  LANES,
} from "./test-selection/policy.ts";

const TEST = { k: "unit", s: "memory", n: "space > writes" };

describe("test-selection", () => {
  describe("parseIdentityArgument()", () => {
    it("takes the three-part key and the four-part one", () => {
      expect(parseIdentityArgument('["unit","memory","a"]')).toEqual({
        k: "unit",
        s: "memory",
        n: "a",
      });
      expect(parseIdentityArgument('["unit","memory","a","on"]')).toEqual({
        k: "unit",
        s: "memory",
        n: "a",
        v: "on",
      });
    });

    it("refuses anything that is not an identity", () => {
      // An empty part is what the manifest validator refuses too, so
      // accepting one here would report a test as unknown and mandatory
      // when the argument was the problem.
      for (
        const argument of [
          "not json",
          "{}",
          '["unit","memory"]',
          '["unit","memory","a","on","extra"]',
          '["","memory","a"]',
          '["unit","","a"]',
          '["unit","memory",""]',
          '["unit","memory","a",""]',
          '["unit","memory",7]',
        ]
      ) {
        expect(parseIdentityArgument(argument)).toBeUndefined();
      }
    });
  });

  describe("explainLines()", () => {
    const manifest = () =>
      sampleManifest({ entries: [sampleEntry(TEST, { cost: 2, score: 0.4 })] });

    it("says an identity with no records is mandatory", () => {
      const lines = explainLines(manifest(), { ...TEST, n: "never seen" });
      expect(lines.join("\n")).toContain("no record of it");
    });

    it("prints the catches behind a score", () => {
      const held = manifest();
      held.entries[0]!.inputs = {
        catches: 3,
        mainCatches: 1,
        sources: 2,
        churn: 0.5,
        lastCatch: "2026-08-20",
      };
      const text = explainLines(held, TEST, { selected: true }).join("\n");
      expect(text).toContain("3.0 weighted catches");
      expect(text).toContain("1 of them on main");
      expect(text).toContain("2026-08-20");
      expect(text).toContain("selects it");
    });

    it("says a test has never caught anything", () => {
      expect(explainLines(manifest(), TEST).join("\n")).toContain(
        "never caught anything",
      );
    });

    it("says why an identity was withheld", () => {
      for (
        const [reason, said] of [
          ["main-red", "failing in the newest run on main"],
          ["flaky", "too flaky to judge a change by"],
        ] as const
      ) {
        const held = manifest();
        held.withheld = [{ test: TEST, suite: "workspace-unit", reason }];
        expect(explainLines(held, TEST).join("\n")).toContain(said);
      }
    });

    it("reports the repeat count the packing settled on", () => {
      const held = manifest();
      held.entries[0]!.repeats = 3;
      const text = explainLines(held, TEST, { selected: true, repeats: 2 })
        .join("\n");
      expect(text).toContain("run 2 times");
    });

    it("separates a test no lane can hold from one the budget missed", () => {
      const held = manifest();
      expect(
        explainLines(held, TEST, { selected: false, unschedulable: true })
          .join("\n"),
      ).toContain("no lane can hold it");
      expect(explainLines(held, TEST, { selected: false }).join("\n"))
        .toContain(
          "does not reach it",
        );
    });
  });

  describe("dialLines()", () => {
    it("prints every dial with its unit and how it is set", () => {
      const text = dialLines().join("\n");
      for (const dial of DIALS) expect(text).toContain(dial.name);
      expect(text).toContain("(chosen)");
      expect(text).toContain("(measured)");
    });

    it("says a dial that is off is off rather than printing nothing", () => {
      expect(dialLines().join("\n")).toContain("off");
    });
  });

  describe("planLines()", () => {
    it("summarizes what each lane would run", () => {
      const manifest = sampleManifest({
        entries: [
          sampleEntry({ k: "unit", s: "memory", n: "one" }, { cost: 1 }),
          sampleEntry({ k: "unit", s: "memory", n: "two" }, { cost: 1 }),
        ],
      });
      const text = planLines(manifest, undefined).join("\n");
      expect(text).toContain("2 known identities");
      expect(text).toContain(`${LANES} lanes`);
      expect(text).toContain("lane 1:");
    });

    it("prints one lane when asked for one", () => {
      const manifest = sampleManifest({
        entries: [sampleEntry({ k: "unit", s: "memory", n: "one" })],
      });
      const text = planLines(manifest, 3).join("\n");
      expect(text).toContain("lane 3:");
      expect(text).not.toContain("lane 1:");
    });

    it("names an identity no lane can hold", () => {
      const manifest = sampleManifest({
        entries: [sampleEntry({ k: "unit", s: "memory", n: "huge" }, {
          cost: 10_000,
        })],
      });
      expect(planLines(manifest, undefined).join("\n")).toContain(
        "unschedulable",
      );
    });
  });
});

describe("coverageLines()", () => {
  it("names the baseline a member is gated against", () => {
    const manifest = sampleManifest({
      coverageBaselines: [{
        member: "packages/memory",
        commit: "abcdef0",
        day: "2026-08-20",
        uncoveredLines: 41,
      }],
    });
    expect(coverageLines(manifest, ["packages/memory"])).toEqual([
      "packages/memory  gated, against 41 uncovered lines at abcdef0",
    ]);
  });

  it("says so when a member has no baseline yet", () => {
    const lines = coverageLines(sampleManifest(), ["packages/memory"]);
    expect(lines).toEqual(["packages/memory  gated, against no baseline yet"]);
  });

  it("gives the reason for a member the gate leaves alone", () => {
    const member = [...EXCLUDED_FROM_COVERAGE_GATE.keys()][0]!;
    const lines = coverageLines(sampleManifest(), [member]);
    expect(lines[0]).toContain("not gated: ");
    expect(lines[0]).toContain(EXCLUDED_FROM_COVERAGE_GATE.get(member)!);
  });

  it("reads a manifest that is missing the same as one with no baselines", () => {
    const members = ["packages/memory", "packages/runner"];
    expect(coverageLines(undefined, members))
      .toEqual(coverageLines(sampleManifest(), members));
  });

  it("pads every member to one width, so the column lines up", () => {
    const lines = coverageLines(undefined, ["packages/a", "packages/longer"]);
    const at = lines.map((line) => line.indexOf("gated"));
    expect(at[0]).toBe(at[1]);
  });
});

describe("laneArgument()", () => {
  it("is nothing at all when the flag is absent", () => {
    expect(laneArgument(["plan", "--dry-run"])).toBeUndefined();
  });

  it("takes a lane inside the range", () => {
    expect(laneArgument(["plan", "--lane", "1"])).toBe(1);
    expect(laneArgument(["plan", "--lane", String(LANES)])).toBe(LANES);
  });

  it("rejects a lane outside the range, at either end", () => {
    expect(laneArgument(["plan", "--lane", "0"])).toBe("invalid");
    expect(laneArgument(["plan", "--lane", String(LANES + 1)])).toBe("invalid");
  });

  it("rejects what is not a whole number, including a missing value", () => {
    for (const value of ["1.5", "two", "", "-1"]) {
      expect(laneArgument(["plan", "--lane", value])).toBe("invalid");
    }
    expect(laneArgument(["plan", "--lane"])).toBe("invalid");
  });
});

describe("verdictFor()", () => {
  const entry = (name: string, seconds: number) =>
    sampleEntry({ k: "unit", s: "memory", n: name }, { cost: seconds });
  const manifestOf = (...entries: ManifestEntry[]) =>
    sampleManifest({ entries, calibration: freeCalibration() });

  it("reports a test the packer takes, and how often it takes it", () => {
    const manifest = sampleManifest({ entries: [entry("cheap", 0.1)] });
    const verdict = verdictFor(manifest, {
      k: "unit",
      s: "memory",
      n: "cheap",
    });
    expect(verdict.selected).toBe(true);
    expect(verdict.repeats).toBeGreaterThanOrEqual(1);
    expect(verdict.unschedulable).toBeUndefined();
  });

  it("reports a test no lane could hold as unschedulable, not selected", () => {
    const verdict = verdictFor(manifestOf(entry("enormous", 100_000)), {
      k: "unit",
      s: "memory",
      n: "enormous",
    });
    expect(verdict.selected).toBe(false);
    expect(verdict.unschedulable).toBe(true);
  });

  it("reports a test the manifest has never heard of as unselected", () => {
    const manifest = manifestOf(entry("cheap", 0.1));
    expect(verdictFor(manifest, { k: "unit", s: "memory", n: "absent" }))
      .toEqual({ selected: false });
  });

  it("tells two configurations of one name apart", () => {
    const manifest = manifestOf(
      sampleEntry({ k: "unit", s: "memory", n: "both", v: "on" }, {
        cost: 0.1,
      }),
    );
    expect(
      verdictFor(manifest, { k: "unit", s: "memory", n: "both", v: "on" })
        .selected,
    ).toBe(true);
    expect(
      verdictFor(manifest, { k: "unit", s: "memory", n: "both" }).selected,
    ).toBe(false);
  });
});
