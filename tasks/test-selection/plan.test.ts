import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { testIdentityKey } from "@commonfabric/test-support/records";

import {
  plan,
  type PlanInput,
  seededOrder,
  type Selection,
  type SelectionReason,
} from "./plan.ts";
import type { Calibration, Manifest, ManifestEntry } from "./manifest.ts";
import { sampleEntry, sampleManifest } from "./testing.ts";
import { LANES, VALUE_FLOOR } from "./policy.ts";

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

    it("does not force one in even when the change touches it", () => {
      const manifest = sampleManifest({
        entries: entries(1, () => ({ cost: 400 })),
      });
      const mandatory = new Map([[
        testIdentityKey(manifest.entries[0]!.test),
        "changed" as const,
      ]]);
      const result = run(manifest, { mandatory, boundSeconds: 300 });
      expect(selected(result)).toEqual([]);
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

describe("an identity the manifest has never heard of", () => {
  const KEY = '["unit","memory","brand new"]';
  const WHERE = new Map([[KEY, {
    suite: "workspace-unit",
    unit: "packages/memory/test/new.test.ts",
  }]]);

  it("runs when the caller names it mandatory and says where it lives", () => {
    const result = run(sampleManifest({ entries: entries(3) }), {
      mandatory: new Map([[KEY, "changed" as const]]),
      unknown: WHERE,
    });
    const taken = selected(result).find((s) =>
      testIdentityKey(s.entry.test) === KEY
    );
    expect(taken).toBeDefined();
    expect(taken!.reason).toBe("changed");
    expect(taken!.repeats).toBe(1);
    expect(taken!.entry.unit).toBe("packages/memory/test/new.test.ts");
    // It has no history, so it stands in at the floor and costs nothing
    // anybody measured.
    expect(taken!.entry.score).toBe(VALUE_FLOOR);
    expect(taken!.entry.cost).toBe(0);
    expect(taken!.entry.inputs).toEqual({
      catches: 0,
      mainCatches: 0,
      sources: 0,
      churn: 0,
    });
  });

  it("carries the configuration when the key names one", () => {
    const key = '["unit","memory","brand new","server"]';
    const result = run(sampleManifest({ entries: entries(3) }), {
      mandatory: new Map([[key, "changed" as const]]),
      unknown: new Map([[key, {
        suite: "workspace-unit",
        unit: "packages/memory/test/new.test.ts",
      }]]),
    });
    const taken = selected(result).find((s) =>
      testIdentityKey(s.entry.test) === key
    );
    expect(taken?.entry.test).toEqual({
      k: "unit",
      s: "memory",
      n: "brand new",
      v: "server",
    });
  });

  it("is left out when nobody said where it lives", () => {
    const result = run(sampleManifest({ entries: entries(3) }), {
      mandatory: new Map([[KEY, "changed" as const]]),
    });
    expect(keysOf(result)).not.toContain(KEY);
  });

  it("is left out when the key is not a key at all", () => {
    for (
      const key of ["not json", "[]", '["unit","memory"]', '["unit",7,"n"]']
    ) {
      const result = run(sampleManifest({ entries: entries(3) }), {
        mandatory: new Map([[key, "changed" as const]]),
        unknown: new Map([[key, {
          suite: "workspace-unit",
          unit: "packages/memory/test/new.test.ts",
        }]]),
      });
      expect(
        selected(result).some((s) => testIdentityKey(s.entry.test) === key),
      )
        .toBe(false);
    }
  });

  it("does not stand in for an identity the manifest does carry", () => {
    const known = testIdentityKey({ k: "unit", s: "memory", n: "case 0" });
    const result = run(sampleManifest({ entries: entries(3) }), {
      mandatory: new Map([[known, "changed" as const]]),
      unknown: new Map([[known, { suite: "elsewhere", unit: "elsewhere.ts" }]]),
    });
    const taken = selected(result).find((s) =>
      testIdentityKey(s.entry.test) === known
    );
    expect(taken?.entry.unit).toBe("packages/memory/test/case-0.test.ts");
  });
});
