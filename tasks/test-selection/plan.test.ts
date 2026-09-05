import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { testIdentityKey } from "@commonfabric/test-support/records";

import {
  fullLaneCount,
  plan,
  type PlanInput,
  seededOrder,
  type Selection,
  type SelectionReason,
} from "./plan.ts";
import type { Calibration, Manifest, ManifestEntry } from "./manifest.ts";
import { sampleEntry, sampleManifest } from "./testing.ts";
import {
  FULL_LANE_BUDGET_SECONDS,
  LANE_BUDGET_SECONDS,
  LANES,
} from "./policy.ts";

const NO_CAPABILITIES = new Map<string, readonly string[]>();

/** `count` identities of one suite, each in its own invocation unit. */
function entries(
  count: number,
  fields: (i: number) => Partial<ManifestEntry> = () => ({}),
): ManifestEntry[] {
  return Array.from(
    { length: count },
    (_, i) =>
      sampleEntry({ k: "unit", s: "memory", n: `case ${i}` }, {
        unit: `packages/memory/test/case-${i}.test.ts`,
        ...fields(i),
      }),
  );
}

function run(
  manifest: Manifest,
  overrides: Partial<PlanInput> = {},
) {
  return plan({
    manifest,
    mandatory: new Map(),
    capabilities: NO_CAPABILITIES,
    ...overrides,
  });
}

function selected(result: ReturnType<typeof plan>): Selection[] {
  return result.lanes.flatMap((lane) => lane.selections);
}

function keysOf(result: ReturnType<typeof plan>): string[] {
  return selected(result).map((s) => testIdentityKey(s.entry.test)).sort();
}

/** Every identity of a manifest, mandatory, in the manifest's own order. */
function everything(manifest: Manifest): Map<string, SelectionReason> {
  return new Map(
    manifest.entries.map((entry) => [
      testIdentityKey(entry.test),
      "changed" as const,
    ]),
  );
}

describe("plan", () => {
  describe("the partition", () => {
    it("fills exactly the lanes it was asked for", () => {
      const result = run(sampleManifest({ entries: entries(20) }));
      expect(result.lanes.length).toBe(LANES);
      expect(result.lanes.map((lane) => lane.lane)).toEqual([1, 2, 3, 4, 5]);
    });

    it("refuses to pack into no lanes at all", () => {
      const manifest = sampleManifest({ entries: entries(3) });
      expect(() => run(manifest, { lanes: 0 })).toThrow(RangeError);
    });

    it("puts no identity in two lanes", () => {
      const result = run(sampleManifest({ entries: entries(200) }));
      const keys = keysOf(result);
      expect(new Set(keys).size).toBe(keys.length);
    });

    it("gives the same answer every time from the same inputs", () => {
      const manifest = sampleManifest({ entries: entries(200) });
      expect(keysOf(run(manifest))).toEqual(keysOf(run(manifest)));
    });

    it("keeps one lane's selections in a stable order", () => {
      // Determinism of the set is checked above; this is the order within
      // a lane, which is what a lane runs its batches in and what a job
      // summary lists.
      const manifest = sampleManifest({ entries: entries(200) });
      expect(run(manifest).lanes[2]!.selections.map((s) => s.entry.test.n))
        .toEqual(run(manifest).lanes[2]!.selections.map((s) => s.entry.test.n));
    });
  });

  describe("what must run", () => {
    it("takes every mandatory identity before anything else", () => {
      const manifest = sampleManifest({ entries: entries(50) });
      const mandatory = new Map([[
        testIdentityKey(manifest.entries[7]!.test),
        "changed" as const,
      ]]);
      const result = run(manifest, { mandatory });
      const taken = selected(result).find((s) => s.entry.test.n === "case 7");
      expect(taken?.reason).toBe("changed");
    });

    it("runs a mandatory identity once, whatever its repeat count", () => {
      const manifest = sampleManifest({
        entries: entries(3, () => ({ repeats: 3 })),
      });
      const mandatory = new Map([[
        testIdentityKey(manifest.entries[0]!.test),
        "coverage-gate" as const,
      ]]);
      const result = run(manifest, { mandatory });
      const taken = selected(result).find((s) => s.entry.test.n === "case 0");
      expect(taken?.repeats).toBe(1);
    });

    it("says by how much the mandatory set alone overran", () => {
      const manifest = sampleManifest({
        entries: entries(4, () => ({ cost: 100 })),
      });
      const result = run(manifest, {
        mandatory: everything(manifest),
        budgetSeconds: 10,
      });
      expect(result.overBudgetSeconds).toBeCloseTo(90, 6);
      expect(selected(result).length).toBe(4);
    });

    it("says a lane is past its budget where the run's total fits", () => {
      // Six identities at 120 seconds, in five lanes of 230. The six fit
      // the run's 1,150 seconds between them, and the sixth still fits no
      // lane: five of them are carrying 120 seconds each already.
      const manifest = sampleManifest({
        entries: entries(6, () => ({ cost: 120 })),
      });
      const result = run(manifest, {
        mandatory: everything(manifest),
        budgetSeconds: 230,
      });
      expect(result.overBudgetSeconds).toBeCloseTo(10, 6);
    });
  });

  describe("what must not run", () => {
    it("leaves out an identity failing in the newest run on main", () => {
      const manifest = sampleManifest({ entries: entries(5) });
      const held = manifest.entries[2]!;
      manifest.withheld = [{
        test: held.test,
        suite: held.suite,
        reason: "main-red",
      }];
      const result = run(manifest);
      expect(selected(result).some((s) => s.entry.test.n === "case 2")).toBe(
        false,
      );
    });

    it("leaves out an identity too flaky to judge a change by", () => {
      const manifest = sampleManifest({
        entries: entries(5, (i) => (i === 3 ? { flakeRate: 0.5 } : {})),
      });
      const result = run(manifest);
      expect(selected(result).some((s) => s.entry.test.n === "case 3")).toBe(
        false,
      );
    });

    it("lets a withheld identity back in when the change touches it", () => {
      const manifest = sampleManifest({
        entries: entries(5, (i) => (i === 3 ? { flakeRate: 0.5 } : {})),
      });
      const held = manifest.entries[2]!;
      manifest.withheld = [{
        test: held.test,
        suite: held.suite,
        reason: "main-red",
      }];
      const mandatory = new Map([
        [testIdentityKey(held.test), "changed" as const],
        [
          testIdentityKey(manifest.entries[3]!.test),
          "covers-changed" as const,
        ],
      ]);
      const names = selected(run(manifest, { mandatory })).map((s) =>
        s.entry.test.n
      );
      expect(names).toContain("case 2");
      expect(names).toContain("case 3");
    });

    it("hands the withheld set on, so a lane can say what is absent", () => {
      const manifest = sampleManifest({ entries: entries(5) });
      manifest.withheld = [{
        test: manifest.entries[1]!.test,
        suite: "workspace-unit",
        reason: "main-red",
      }];
      expect(run(manifest).withheld).toEqual(manifest.withheld);
    });
  });

  describe("the budget", () => {
    it("stops before the budget when the corpus is larger than it", () => {
      const manifest = sampleManifest({
        entries: entries(500, () => ({ cost: 1 })),
      });
      const result = run(manifest, { budgetSeconds: 20 });
      const total = result.lanes.reduce(
        (sum, lane) => sum + lane.projectedSeconds,
        0,
      );
      expect(total).toBeLessThanOrEqual(20 * LANES);
      expect(selected(result).length).toBeLessThan(500);
    });

    it("runs everything when the corpus fits", () => {
      const manifest = sampleManifest({
        entries: entries(10, () => ({ cost: 0.01 })),
      });
      expect(selected(run(manifest)).length).toBe(10);
    });

    it("drops repeats before it drops the identity", () => {
      // Three identities wanting three runs each, in a budget that holds
      // four runs. One observation of each beats three of one.
      const manifest = sampleManifest({
        entries: entries(3, () => ({ cost: 1, repeats: 3 })),
      });
      const result = run(manifest, { lanes: 1, budgetSeconds: 4 });
      expect(selected(result).length).toBe(3);
      expect(selected(result).every((s) => s.repeats >= 1)).toBe(true);
    });
  });

  describe("the lane budget", () => {
    // A suite charging an overhead every lane that opens it pays. That is
    // what makes the lane which has already paid it the cheapest place
    // for the rest of the suite, and so what a per-lane budget has to
    // overrule.
    const grouped: Calibration = {
      setupCost: {},
      suites: { "workspace-unit": { overhead: 10, correction: 1 } },
      unitOverhead: {},
      prologue: 0,
    };

    it("gives no lane more work than one lane's budget", () => {
      const manifest = sampleManifest({
        entries: entries(500, () => ({ cost: 1 })),
        calibration: grouped,
      });
      for (const lane of run(manifest, { budgetSeconds: 20 }).lanes) {
        expect(lane.projectedSeconds).toBeLessThanOrEqual(20);
      }
    });

    it("fills every lane rather than one lane five times over", () => {
      const manifest = sampleManifest({
        entries: entries(500, () => ({ cost: 1 })),
        calibration: grouped,
      });
      for (const lane of run(manifest, { budgetSeconds: 40 }).lanes) {
        expect(lane.projectedSeconds).toBeCloseTo(40, 6);
      }
    });

    it("gives an identity larger than a lane's budget a lane to itself", () => {
      const manifest = sampleManifest({
        entries: entries(60, (i) => (i === 0 ? { cost: 250 } : { cost: 1 })),
        calibration: grouped,
      });
      const result = run(manifest, { budgetSeconds: 230, boundSeconds: 300 });
      const alone = result.lanes.find((lane) =>
        lane.selections.some((s) => s.entry.test.n === "case 0")
      )!;
      expect(alone.selections.length).toBe(1);
      expect(alone.projectedSeconds).toBeCloseTo(260, 6);
    });

    it("holds a repeated identity to the budget rather than the bound", () => {
      // The lane to itself is for an identity that cannot be split. Three
      // runs of a hundred seconds do not fit a lane's budget and two do,
      // so the identity gives up a run rather than the lane its budget.
      const manifest = sampleManifest({
        entries: entries(1, () => ({ cost: 100, repeats: 3 })),
      });
      const result = run(manifest, { budgetSeconds: 230, boundSeconds: 300 });
      expect(selected(result)[0]!.repeats).toBe(2);
      expect(result.lanes[0]!.projectedSeconds).toBeCloseTo(200, 6);
    });

    it("takes the largest mandatory identity before the small ones", () => {
      // Nine identities that between them fill most of the lanes, and one
      // costing most of a lane on its own. Taken in the order the caller
      // listed them, the nine leave the tenth no lane it fits inside;
      // taken largest first, all ten fit.
      const manifest = sampleManifest({
        entries: entries(10, (i) => (i === 9 ? { cost: 90 } : { cost: 18 })),
      });
      const result = run(manifest, {
        mandatory: everything(manifest),
        budgetSeconds: 100,
      });
      expect(selected(result).length).toBe(10);
      for (const lane of result.lanes) {
        expect(lane.projectedSeconds).toBeLessThanOrEqual(100);
      }
    });

    it("spreads a mandatory set no lane can hold over all of them", () => {
      // Twenty identities that must run, costing between them nearly
      // twice what the five lanes hold. Each lane carries four of them,
      // rather than one lane carrying the whole overrun.
      const manifest = sampleManifest({
        entries: entries(20, () => ({ cost: 30 })),
        calibration: grouped,
      });
      const result = run(manifest, {
        mandatory: everything(manifest),
        budgetSeconds: 70,
      });
      for (const lane of result.lanes) {
        expect(lane.selections.length).toBe(4);
        expect(lane.projectedSeconds).toBeCloseTo(130, 6);
      }
      expect(result.overBudgetSeconds).toBeCloseTo(60, 6);
    });
  });

  describe("the filling order", () => {
    it("takes the highest-scoring identity even when it is expensive", () => {
      const manifest = sampleManifest({
        entries: entries(
          30,
          (i) =>
            i === 17 ? { cost: 40, score: 0.9 } : { cost: 0.1, score: 0.05 },
        ),
      });
      const result = run(manifest, { budgetSeconds: 20 });
      const taken = selected(result).find((s) => s.entry.test.n === "case 17");
      expect(taken?.reason).toBe("value");
    });

    it("sweeps the cheap tail up under the density pass", () => {
      // Expensive proven tests take the value pass's whole share. The
      // tail is worth a hundred times more per second, so the density
      // pass is where it comes in.
      const manifest = sampleManifest({
        entries: entries(
          220,
          (i) => i < 20 ? { cost: 5, score: 0.9 } : { cost: 0.01, score: 0.05 },
        ),
      });
      const result = run(manifest, { budgetSeconds: 20 });
      const byReason = new Map<string, number>();
      for (const selection of selected(result)) {
        byReason.set(
          selection.reason,
          (byReason.get(selection.reason) ?? 0) + 1,
        );
      }
      expect(byReason.get("value")).toBeGreaterThan(0);
      expect(byReason.get("density")).toBeGreaterThan(100);
    });

    it("spends its last share on what the value ordering passed over", () => {
      const manifest = sampleManifest({
        entries: entries(400, (i) => ({
          cost: 0.5,
          score: i < 20 ? 0.9 : 0.05,
        })),
      });
      const result = run(manifest, { budgetSeconds: 20 });
      const reasons = new Set(selected(result).map((s) => s.reason));
      expect(reasons.has("exploration")).toBe(true);
    });

    it("draws the longest-unrun first", () => {
      // What makes the draw a sweep of the corpus rather than a sample
      // of it: everything ran yesterday except one that has not run for
      // a year, and that one is what the draw reaches for.
      const manifest = sampleManifest({
        entries: entries(60, (i) => ({
          cost: 1,
          score: 0.05,
          lastRun: i === 41 ? "2025-09-01" : "2026-08-31",
        })),
      });
      const result = run(manifest, { budgetSeconds: 2, lanes: 1 });
      const drawn = selected(result).filter((s) => s.reason === "exploration");
      expect(drawn.length).toBeGreaterThan(0);
      expect(testIdentityKey(drawn[0]!.entry.test)).toBe(
        testIdentityKey({ k: "unit", s: "memory", n: "case 41" }),
      );
    });

    it("draws an identity nothing has run ahead of every day there is", () => {
      const manifest = sampleManifest({
        entries: entries(60, (i) => ({
          cost: 1,
          score: 0.05,
          ...(i === 17 ? {} : { lastRun: "2020-01-01" }),
        })),
      });
      const result = run(manifest, { budgetSeconds: 2, lanes: 1 });
      const drawn = selected(result).filter((s) => s.reason === "exploration");
      expect(testIdentityKey(drawn[0]!.entry.test)).toBe(
        testIdentityKey({ k: "unit", s: "memory", n: "case 17" }),
      );
    });
  });

  describe("capabilities", () => {
    it("charges a lane for setup it has not opened yet", () => {
      const manifest = sampleManifest({
        entries: [
          sampleEntry({ k: "integration", s: "patterns", n: "one" }, {
            suite: "pattern-integration",
            unit: "packages/patterns/integration/one.test.ts",
            cost: 1,
          }),
        ],
        calibration: {
          setupCost: { toolshed: 40 },
          suites: {},
          unitOverhead: {},
          prologue: 0,
        },
      });
      const result = run(manifest, {
        capabilities: new Map([["pattern-integration", ["toolshed"]]]),
      });
      const lane = result.lanes.find((l) => l.selections.length > 0)!;
      expect(lane.capabilities).toEqual(["toolshed"]);
      expect(lane.projectedSeconds).toBeCloseTo(41, 6);
    });

    it("groups a suite's identities where its setup is already paid", () => {
      const manifest = sampleManifest({
        entries: entries(4, (i) => ({
          suite: "pattern-integration",
          unit: `packages/patterns/integration/case-${i}.test.ts`,
          cost: 1,
        })),
        calibration: {
          setupCost: { toolshed: 40 },
          suites: {},
          unitOverhead: {},
          prologue: 0,
        },
      });
      const result = run(manifest, {
        capabilities: new Map([["pattern-integration", ["toolshed"]]]),
      });
      const opened = result.lanes.filter((lane) =>
        lane.capabilities.includes("toolshed")
      );
      expect(opened.length).toBe(1);
    });
  });

  describe("the hard bound", () => {
    it("reports an identity no lane could hold, and runs it nowhere", () => {
      const manifest = sampleManifest({
        entries: entries(3, (i) => (i === 1 ? { cost: 400 } : { cost: 1 })),
      });
      const result = run(manifest, { boundSeconds: 300 });
      expect(result.unschedulable.map((e) => e.test.n)).toEqual(["case 1"]);
      expect(selected(result).some((s) => s.entry.test.n === "case 1")).toBe(
        false,
      );
    });

    it("counts the overheads a lane would pay for it", () => {
      // A test inside the bound whose suite, unit and capability setup
      // put the lane past it is still one no lane can hold.
      const manifest = sampleManifest({
        entries: entries(
          1,
          () => ({ cost: 200, suite: "pattern-integration" }),
        ),
        calibration: {
          setupCost: { toolshed: 60 },
          suites: { "pattern-integration": { overhead: 50, correction: 1 } },
          unitOverhead: {},
          prologue: 0,
        },
      });
      const result = run(manifest, {
        boundSeconds: 300,
        capabilities: new Map([["pattern-integration", ["toolshed"]]]),
      });
      expect(result.unschedulable.length).toBe(1);
    });

    it("reports the cost the bound was compared against", () => {
      // 200 seconds of test, a suite that costs 50 to open and doubles
      // what runs inside it, a unit that costs 10, and a capability whose
      // setup costs 60. What a lane pays is 520, and that is the number
      // to report: reporting the entry's own 200 would say a test inside
      // a 300-second bound is past it.
      const manifest = sampleManifest({
        entries: entries(1, () => ({
          cost: 200,
          suite: "pattern-integration",
          unit: "packages/patterns/one.test.ts",
        })),
        calibration: {
          setupCost: { toolshed: 60 },
          suites: { "pattern-integration": { overhead: 50, correction: 2 } },
          unitOverhead: { "packages/patterns/one.test.ts": 10 },
          prologue: 0,
        },
      });
      const result = run(manifest, {
        boundSeconds: 300,
        capabilities: new Map([["pattern-integration", ["toolshed"]]]),
      });
      expect(result.unschedulable.length).toBe(1);
      expect(result.unschedulable[0]!.cost).toBeCloseTo(520, 5);
      expect(result.unschedulable[0]!.suite).toBe("pattern-integration");
    });

    it("runs one anyway when the change touches it", () => {
      // Mandatory says the change is not tested without it. A lane that
      // runs long reports that it ran long; dropping the test reports a
      // pass over something that never ran, which is the worse answer.
      const manifest = sampleManifest({
        entries: entries(1, () => ({ cost: 400 })),
      });
      const key = testIdentityKey(manifest.entries[0]!.test);
      const mandatory = new Map([[key, "changed" as const]]);
      const result = run(manifest, { mandatory, boundSeconds: 300 });
      expect(selected(result).map((s) => testIdentityKey(s.entry.test)))
        .toEqual([key]);
      // It is placed, so it is not among the ones nothing can run.
      expect(result.unschedulable).toEqual([]);
    });

    it("says how far past its budget forcing one put a lane", () => {
      // The lane running long is the whole signal that the bound may need
      // raising, so the figure has to come out even though nothing failed.
      const manifest = sampleManifest({
        entries: entries(1, () => ({ cost: 400 })),
      });
      const mandatory = new Map([[
        testIdentityKey(manifest.entries[0]!.test),
        "changed" as const,
      ]]);
      const result = run(manifest, { mandatory, boundSeconds: 300 });
      expect(result.overBudgetSeconds).toBeGreaterThan(0);
    });
  });

  describe("the cost model", () => {
    it("charges a suite's overhead once per lane", () => {
      const manifest = sampleManifest({
        entries: entries(3, () => ({ cost: 1 })),
        calibration: {
          setupCost: {},
          suites: { "workspace-unit": { overhead: 10, correction: 1 } },
          unitOverhead: {},
          prologue: 0,
        },
      });
      const result = run(manifest, { lanes: 1 });
      expect(result.lanes[0]!.projectedSeconds).toBeCloseTo(13, 6);
    });

    it("charges an invocation unit's overhead once per lane", () => {
      const manifest = sampleManifest({
        entries: entries(3, () => ({
          cost: 1,
          unit: "packages/memory/test/one.test.ts",
        })),
        calibration: {
          setupCost: {},
          suites: {},
          unitOverhead: { "packages/memory/test/one.test.ts": 5 },
          prologue: 0,
        },
      });
      const result = run(manifest, { lanes: 1 });
      expect(result.lanes[0]!.projectedSeconds).toBeCloseTo(8, 6);
    });

    it("applies the suite's fitted correction to a measured cost", () => {
      const manifest = sampleManifest({
        entries: entries(1, () => ({ cost: 2 })),
        calibration: {
          setupCost: {},
          suites: { "workspace-unit": { overhead: 0, correction: 1.5 } },
          unitOverhead: {},
          prologue: 0,
        },
      });
      expect(run(manifest, { lanes: 1 }).lanes[0]!.projectedSeconds)
        .toBeCloseTo(3, 6);
    });
  });

  describe("seededOrder()", () => {
    it("permutes every index exactly once", () => {
      const order = seededOrder("seed", 50);
      expect([...order].sort((a, b) => a - b)).toEqual(
        Array.from({ length: 50 }, (_, i) => i),
      );
    });

    it("gives the same order from the same seed", () => {
      expect(seededOrder("one", 30)).toEqual(seededOrder("one", 30));
    });

    it("gives a different order from a different seed", () => {
      expect(seededOrder("one", 30)).not.toEqual(seededOrder("two", 30));
    });

    it("handles a corpus of nothing", () => {
      expect(seededOrder("seed", 0)).toEqual([]);
    });
  });
});

describe("an identity a manifest carries twice", () => {
  it("runs it once, rather than placing it in two lanes", () => {
    // A duplicated entry is one identity however many rows describe it,
    // and running it twice would charge a lane for work it did not do.
    const twice = sampleEntry({ k: "unit", s: "memory", n: "case 0" }, {
      unit: "packages/memory/test/case-0.test.ts",
    });
    const manifest = sampleManifest({
      entries: [...entries(3), twice],
    });
    const key = testIdentityKey(twice.test);
    const placed = keysOf(run(manifest)).filter((k) => k === key);
    expect(placed.length).toBe(1);
  });
});

describe("an identity the manifest does not carry", () => {
  it("refuses to plan, rather than dropping a test that must run", () => {
    // Whoever read the tree carries a stand-in for every unit it holds,
    // so this is the caller naming something mandatory and handing over
    // a corpus without it. Leaving it out would report a pass over a
    // test that never ran, which is the failure with no trace.
    const key = '["unit","memory","brand new"]';
    expect(() =>
      run(sampleManifest({ entries: entries(3) }), {
        mandatory: new Map([[key, "changed" as const]]),
      })
    ).toThrow("must run");
  });
});

describe("running everything", () => {
  /** A manifest whose entries differ in every way selection reads. */
  function corpus(): Manifest {
    return sampleManifest({
      entries: [
        ...entries(6, (i) => ({ cost: 1 + i, score: 0.9 - i / 10 })),
        sampleEntry({ k: "unit", s: "memory", n: "flaky" }, {
          unit: "packages/memory/test/flaky.test.ts",
          flakeRate: 0.9,
          cost: 2,
        }),
        sampleEntry({ k: "unit", s: "memory", n: "worthless" }, {
          unit: "packages/memory/test/worthless.test.ts",
          score: 0,
          cost: 2,
        }),
      ],
      withheld: [{
        test: { k: "unit", s: "memory", n: "worthless" },
        suite: "workspace-unit",
        reason: "main-red",
      }],
    });
  }

  it("runs every identity once, whatever it is worth", () => {
    const result = run(corpus(), { policy: "everything" });
    expect(keysOf(result)).toEqual(
      corpus().entries.map((entry) => testIdentityKey(entry.test)).sort(),
    );
    expect(selected(result).every((s) => s.repeats === 1)).toBe(true);
    expect(selected(result).every((s) => s.reason === "full")).toBe(true);
  });

  it("says it withheld nothing, because it ran everything", () => {
    expect(run(corpus()).withheld.length).toBe(1);
    expect(run(corpus(), { policy: "everything" }).withheld).toEqual([]);
  });

  it("runs what a budgeted plan withholds and excludes", () => {
    const budgeted = keysOf(run(corpus()));
    const flaky = testIdentityKey({ k: "unit", s: "memory", n: "flaky" });
    const red = testIdentityKey({ k: "unit", s: "memory", n: "worthless" });
    expect(budgeted).not.toContain(flaky);
    expect(budgeted).not.toContain(red);
    const full = keysOf(run(corpus(), { policy: "everything" }));
    expect(full).toContain(flaky);
    expect(full).toContain(red);
  });

  it("reports nothing unschedulable, since it places everything", () => {
    const manifest = sampleManifest({
      entries: entries(2, () => ({ cost: 5_000 })),
    });
    expect(run(manifest).unschedulable.length).toBe(2);
    const full = run(manifest, { policy: "everything" });
    expect(full.unschedulable).toEqual([]);
    expect(keysOf(full).length).toBe(2);
  });

  it("takes the full run's budget rather than a pull request's", () => {
    // Work that fits one lane of the full run and does not fit one of a
    // pull request's, which is the whole gap between the two dials.
    const manifest = sampleManifest({
      entries: entries(FULL_LANE_BUDGET_SECONDS, () => ({ cost: 1 })),
    });
    const full = run(manifest, { policy: "everything", lanes: 1 });
    expect(full.budgetSeconds).toBe(FULL_LANE_BUDGET_SECONDS);
    expect(full.overBudgetSeconds).toBe(0);
    const budgeted = run(manifest, {
      policy: "everything",
      lanes: 1,
      budgetSeconds: LANE_BUDGET_SECONDS,
    });
    expect(budgeted.overBudgetSeconds).toBeGreaterThan(0);
  });

  it("places every identity, however awkward the corpus", () => {
    // A corpus mixing tests that fit easily, tests larger than a lane,
    // and tests a budgeted plan would exclude. None of it may go
    // missing: what `main` does not run, nothing runs.
    const manifest = sampleManifest({
      entries: [
        ...entries(40, (i) => ({ cost: i % 7 === 0 ? 5_000 : i / 10 })),
        sampleEntry({ k: "unit", s: "memory", n: "flaky" }, {
          unit: "packages/memory/test/flaky.test.ts",
          flakeRate: 1,
        }),
      ],
    });
    for (const lanes of [1, 2, 5, 13]) {
      const result = run(manifest, { policy: "everything", lanes });
      expect(keysOf(result).length).toBe(manifest.entries.length);
      expect(new Set(keysOf(result)).size).toBe(manifest.entries.length);
    }
  });

  it("gives the same answer every time it is asked", () => {
    const once = run(corpus(), { policy: "everything" });
    const twice = run(corpus(), { policy: "everything" });
    expect(JSON.stringify(once)).toBe(JSON.stringify(twice));
  });
});

describe("how many lanes the full run needs", () => {
  const capabilities = NO_CAPABILITIES;

  function count(manifest: Manifest, overrides: Partial<PlanInput> = {}) {
    return fullLaneCount({ manifest, capabilities, ...overrides });
  }

  it("takes one lane for work that fits in one", () => {
    expect(count(sampleManifest({ entries: entries(5, () => ({ cost: 1 })) })))
      .toBe(1);
  });

  it("takes enough lanes that none of them runs long", () => {
    // Three lanes' worth of work, in tests small enough that the packer
    // can divide them evenly.
    const manifest = sampleManifest({
      entries: entries(FULL_LANE_BUDGET_SECONDS * 3, () => ({ cost: 1 })),
    });
    const lanes = count(manifest);
    expect(lanes).toBe(3);
    const packed = plan({
      manifest,
      mandatory: new Map(),
      capabilities,
      policy: "everything",
      lanes,
    });
    expect(packed.overBudgetSeconds).toBe(0);
  });

  it("honors a budget it was handed", () => {
    const manifest = sampleManifest({
      entries: entries(600, () => ({ cost: 1 })),
    });
    expect(count(manifest, { budgetSeconds: 100 })).toBe(6);
  });

  it("adds lanes while each one still buys something", () => {
    // The fewest lanes the raw work could fit in is not enough lanes,
    // because a lane loses part of its budget to the overhead of the
    // suite it opens. The search has to climb past that starting point,
    // and this is the case that makes it: three lanes hold 1,440
    // seconds of tests only if their overheads are free, and they are
    // not.
    const manifest = sampleManifest({
      entries: entries(24, () => ({ cost: 60 })),
      calibration: {
        setupCost: {},
        suites: { "workspace-unit": { overhead: 150, correction: 1 } },
        unitOverhead: {},
        prologue: 0,
      },
    });
    const work = manifest.entries.reduce((total, e) => total + e.cost, 0);
    const floor = Math.ceil(work / FULL_LANE_BUDGET_SECONDS);
    const lanes = count(manifest);
    expect(lanes).toBeGreaterThan(floor);
    const packed = plan({
      manifest,
      mandatory: new Map(),
      capabilities,
      policy: "everything",
      lanes,
    });
    expect(packed.overBudgetSeconds).toBe(0);
  });

  it("stops rather than chasing work no number of lanes can fit", () => {
    // The search has to reach its stopping rule to be tested by this, so
    // the corpus has to be one where lanes are still worth adding for a
    // while and then stop being. A single oversized identity would cap
    // the search at one lane before the loop ran at all, and the case
    // would pass with the rule deleted.
    const manifest = sampleManifest({
      entries: [
        ...entries(20, () => ({ cost: 100 })),
        sampleEntry({ k: "unit", s: "memory", n: "vast" }, {
          unit: "packages/memory/test/vast.test.ts",
          cost: FULL_LANE_BUDGET_SECONDS * 3,
        }),
      ],
    });
    const lanes = count(manifest);
    // Adding lanes past this buys nothing, because what is left over
    // budget is one identity no lane can hold.
    const at = (n: number) =>
      plan({
        manifest,
        mandatory: new Map(),
        capabilities,
        policy: "everything",
        lanes: n,
      });
    const overrun = (result: ReturnType<typeof plan>) =>
      result.lanes.reduce(
        (total, lane) =>
          total + Math.max(0, lane.projectedSeconds - result.budgetSeconds),
        0,
      );
    expect(overrun(at(lanes))).toBeGreaterThan(0);
    expect(overrun(at(lanes + 1))).toBeGreaterThan(overrun(at(lanes)) - 1);
    // And it did reach the rule rather than stopping at the cap.
    expect(lanes).toBeGreaterThan(1);
    expect(lanes).toBeLessThan(manifest.entries.length);
  });

  it("keeps adding lanes for work one oversized test would hide", () => {
    // The oversized test pins the worst lane's overrun at every count,
    // so a search reading the worst lane alone would stop at once and
    // leave every other lane crowded. What the rest of the corpus needs
    // is what decides the count.
    const manifest = sampleManifest({
      entries: [
        ...entries(40, () => ({ cost: 100 })),
        sampleEntry({ k: "unit", s: "memory", n: "vast" }, {
          unit: "packages/memory/test/vast.test.ts",
          cost: 900,
        }),
      ],
    });
    const lanes = count(manifest);
    const packed = plan({
      manifest,
      mandatory: new Map(),
      capabilities,
      policy: "everything",
      lanes,
    });
    // Every lane but the one carrying the oversized test fits its
    // budget, and that one carries nothing else.
    const over = packed.lanes.filter((lane) =>
      lane.projectedSeconds > packed.budgetSeconds
    );
    expect(over.length).toBe(1);
    expect(over[0]!.selections.length).toBe(1);
  });

  it("takes one lane for a corpus of nothing", () => {
    expect(count(sampleManifest({ entries: [] }))).toBe(1);
  });
});
