import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { testIdentityKey } from "@commonfabric/test-support/records";

import { plan, type PlanInput, seededOrder, type Selection } from "./plan.ts";
import type { Manifest, ManifestEntry } from "./manifest.ts";
import { sampleEntry, sampleManifest } from "./testing.ts";
import { LANES } from "./policy.ts";

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

describe("plan", () => {
  describe("the partition", () => {
    it("fills exactly the lanes it was asked for", () => {
      const result = run(sampleManifest({ entries: entries(20) }));
      expect(result.lanes.length).toBe(LANES);
      expect(result.lanes.map((lane) => lane.lane)).toEqual([1, 2, 3, 4, 5]);
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
      const mandatory = new Map(
        manifest.entries.map((entry) =>
          [testIdentityKey(entry.test), "changed" as const] as const
        ),
      );
      const result = run(manifest, { mandatory, budgetSeconds: 10 });
      expect(result.overBudgetSeconds).toBeCloseTo(350, 6);
      expect(selected(result).length).toBe(4);
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
