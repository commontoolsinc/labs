import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { TestRecord } from "@commonfabric/test-support/records";
import {
  type BatchObservation,
  calibrate,
  fitSuite,
  laneObservations,
  laneObservationsOf,
  observationsOf,
  percentile,
} from "./calibrate.ts";
import {
  batchMeasurementName,
  LANE_MEASUREMENT_PREFIX,
  LANE_MEASUREMENT_SURFACE,
} from "../lane-measurement.ts";
import { MAX_SUITE_CORRECTION, MIN_CORRECTION_SAMPLES } from "./policy.ts";

/** One measurement, as a lane spools it. */
function measured(name: string, seconds: number): TestRecord {
  return {
    line: "record",
    test: {
      k: LANE_MEASUREMENT_SURFACE.kind,
      s: LANE_MEASUREMENT_SURFACE.scope,
      n: name,
    },
    outcome: "pass",
    durationMs: Math.round(seconds * 1000),
  };
}

/** What a lane writes about one batch: what it cost, and what it took. */
function batch(suite: string, planned: number, spent: number): TestRecord[] {
  return [
    measured(batchMeasurementName(suite, false), spent),
    measured(batchMeasurementName(suite, false, "planned"), planned),
  ];
}

describe("what a lane costs beyond the tests it runs", () => {
  describe("reading a run's own measurements", () => {
    it("takes each capability's setup, every time one was opened", () => {
      const seen = observationsOf([
        {
          run: "a",
          records: [
            measured(`${LANE_MEASUREMENT_PREFIX}setup fuse`, 14.8),
            measured(`${LANE_MEASUREMENT_PREFIX}setup toolshed`, 2.8),
          ],
        },
        {
          run: "b",
          records: [measured(`${LANE_MEASUREMENT_PREFIX}setup fuse`, 2.1)],
        },
      ]);
      expect(seen.setup.get("fuse")).toEqual([14.8, 2.1]);
      expect(seen.setup.get("toolshed")).toEqual([2.8]);
    });

    it("pairs what a batch cost with what it took", () => {
      const seen = observationsOf([
        { run: "a", records: batch("workspace-unit", 40, 92) },
      ]);
      expect(seen.batches).toEqual([
        { suite: "workspace-unit", planned: 40, spent: 92 },
      ]);
    });

    it("takes nothing from a batch with only one half", () => {
      // A lane writes both together, so one alone is a record that
      // arrived without its partner rather than a batch to fit from.
      const seen = observationsOf([{
        run: "a",
        records: [measured(batchMeasurementName("workspace-unit", false), 92)],
      }]);
      expect(seen.batches).toEqual([]);
    });

    it("keeps two lanes of one run apart", () => {
      // Five lanes of a run may each hold the same suite, and adding two
      // lanes' figures would describe a batch neither of them ran.
      const seen = observationsOf([
        { run: "run-1-lane-1", records: batch("runner-unit", 10, 30) },
        { run: "run-1-lane-2", records: batch("runner-unit", 20, 50) },
      ]);
      expect(seen.batches.map((b) => b.spent).sort()).toEqual([30, 50]);
    });

    it("fits a measured batch apart from an unmeasured one", () => {
      // Instrumenting a run costs it time, and the two are separate
      // measurements of the same suite.
      const seen = observationsOf([{
        run: "a",
        records: [
          ...batch("workspace-unit", 40, 92),
          measured(batchMeasurementName("workspace-unit", true), 150),
          measured(
            batchMeasurementName("workspace-unit", true, "planned"),
            40,
          ),
        ],
      }]);
      expect(seen.batches.length).toBe(2);
      expect(seen.batches.map((b) => b.spent).sort((a, b) => a - b))
        .toEqual([92, 150]);
    });

    it("passes over a record that is not a lane measuring itself", () => {
      const seen = observationsOf([{
        run: "a",
        records: [{
          line: "record",
          test: { k: "unit", s: "memory", n: "space > writes a fact" },
          outcome: "pass",
          durationMs: 40,
        }],
      }]);
      expect(seen.setup.size).toBe(0);
      expect(seen.batches).toEqual([]);
    });
  });

  describe("what one group says, as an aggregate stores it", () => {
    it("carries the day, so a stored observation can be aged", () => {
      const kept = laneObservationsOf(
        "object-1",
        [
          ...batch("runner-unit", 10, 30),
          measured(`${LANE_MEASUREMENT_PREFIX}setup fuse`, 14.8),
        ],
        "2026-09-12",
      );
      expect(kept).toEqual([
        { day: "2026-09-12", capability: "fuse", seconds: 14.8 },
        { day: "2026-09-12", suite: "runner-unit", planned: 10, spent: 30 },
      ]);
    });
  });

  describe("percentile()", () => {
    it("reads the ninetieth rather than the largest", () => {
      // One unlucky runner must not set a cost for good.
      const values = [1, 1, 1, 1, 1, 1, 1, 1, 1, 99];
      expect(percentile(values, 0.9)).toBe(1);
    });

    it("reads the only value there is", () => {
      expect(percentile([7], 0.9)).toBe(7);
    });

    it("reads nothing from nothing", () => {
      expect(percentile([], 0.9)).toBe(0);
    });
  });

  describe("fitting one suite", () => {
    it("puts the whole of one observation into the intercept", () => {
      // With one sample there is nothing to say about how the cost grows,
      // so the intercept carries what the lane was seen to spend.
      expect(fitSuite([{ suite: "s", planned: 40, spent: 92 }])).toEqual({
        overhead: 52,
        correction: 1,
      });
    });

    it("finds the slope enough disagreeing observations carry", () => {
      const fitted = fitSuite(
        Array.from({ length: MIN_CORRECTION_SAMPLES }, (_, i) => ({
          suite: "s",
          planned: 10 + i,
          spent: 10 + 2 * (10 + i),
        })),
      );
      expect(fitted.correction).toBeCloseTo(2, 6);
      expect(fitted.overhead).toBeCloseTo(10, 6);
    });

    it("fits no slope from too few observations", () => {
      // Two points fit a line exactly, and a line through two points a
      // second apart says nothing about the second after them.
      const fitted = fitSuite([
        { suite: "s", planned: 0.0, spent: 12.2 },
        { suite: "s", planned: 0.7, spent: 16.6 },
      ]);
      expect(fitted.correction).toBe(1);
      expect(fitted.overhead).toBeCloseTo(15.9, 6);
    });

    it("never lets a slope price a suite out of every lane", () => {
      // A slope far above one is the fit reading a fixed cost as a
      // marginal one, and it is charged against every identity of the
      // suite rather than once per lane.
      const fitted = fitSuite(
        Array.from({ length: MIN_CORRECTION_SAMPLES }, (_, i) => ({
          suite: "s",
          planned: 0.1 * i,
          spent: 20 + 50 * (0.1 * i),
        })),
      );
      expect(fitted.correction).toBe(MAX_SUITE_CORRECTION);
      // What the cap moved off the slope is on the intercept, so no
      // observation is under-predicted.
      for (let i = 0; i < MIN_CORRECTION_SAMPLES; i++) {
        const planned = 0.1 * i;
        expect(fitted.overhead + fitted.correction * planned)
          .toBeGreaterThanOrEqual(20 + 50 * planned - 1e-9);
      }
    });

    it("never predicts a batch costing less than one was seen to", () => {
      // A least-squares line sits in the middle of its observations,
      // which for this quantity is half the lanes running past the
      // budget they were packed against.
      const seen: BatchObservation[] = [
        ...Array.from({ length: MIN_CORRECTION_SAMPLES }, (_, i) => ({
          suite: "s",
          planned: 10 + i,
          spent: 10 + 2 * (10 + i),
        })),
        { suite: "s", planned: 15, spent: 90 },
      ];
      const fitted = fitSuite(seen);
      for (const one of seen) {
        expect(fitted.overhead + fitted.correction * one.planned)
          .toBeGreaterThanOrEqual(one.spent - 1e-9);
      }
    });

    it("fits a suite whose batch runs faster than the sum of its tests", () => {
      // A batch runs its files in parallel, so its wall time is
      // routinely a fraction of the sum of its tests' own durations —
      // the pattern unit suite takes about a third. Holding the slope at
      // one would push that difference into the intercept, which is
      // charged whatever the batch holds.
      const fitted = fitSuite(
        Array.from({ length: MIN_CORRECTION_SAMPLES }, (_, i) => ({
          suite: "s",
          planned: 50 + 10 * i,
          spent: (50 + 10 * i) / 3,
        })),
      );
      expect(fitted.correction).toBeCloseTo(1 / 3, 6);
      expect(fitted.overhead).toBeCloseTo(0, 6);
    });

    it("refuses a slope saying a batch gets cheaper with more tests", () => {
      const fitted = fitSuite(
        Array.from({ length: MIN_CORRECTION_SAMPLES }, (_, i) => ({
          suite: "s",
          planned: 10 + 10 * i,
          spent: 60 - 0.5 * (10 + 10 * i),
        })),
      );
      expect(fitted.correction).toBe(0);
    });

    it("charges nothing for a suite nothing has measured", () => {
      expect(fitSuite([])).toEqual({ overhead: 0, correction: 1 });
    });
  });

  describe("calibrate()", () => {
    it("names every capability and every suite it was given", () => {
      const fitted = calibrate({
        setup: new Map([["fuse", [14.8, 2.1]], ["browser", [0]]]),
        batches: [
          { suite: "workspace-unit", planned: 40, spent: 92 },
          { suite: "runner-unit", planned: 10, spent: 20 },
        ],
      });
      expect(Object.keys(fitted.setupCost).sort()).toEqual(["browser", "fuse"]);
      expect(Object.keys(fitted.suites).sort()).toEqual([
        "runner-unit",
        "workspace-unit",
      ]);
      expect(fitted.suites["workspace-unit"].overhead).toBe(52);
    });

    it("charges nothing per unit, because nothing measures one", () => {
      // A lane times its batches and not the units inside them, so a
      // suite's intercept carries what one more file costs.
      expect(calibrate({ setup: new Map(), batches: [] }).unitOverhead)
        .toEqual({});
    });

    it("carries the prologue it was given", () => {
      expect(calibrate({ setup: new Map(), batches: [] }, 12).prologue)
        .toBe(12);
    });
  });

  describe("what the aggregate kept", () => {
    it("sorts stored observations back into the two kinds", () => {
      const seen = laneObservations([
        { capability: "fuse", seconds: 14.8 },
        { suite: "runner-unit", planned: 10, spent: 30 },
        { capability: "fuse", seconds: 2.1 },
      ]);
      expect(seen.setup.get("fuse")).toEqual([14.8, 2.1]);
      expect(seen.batches).toEqual([
        { suite: "runner-unit", planned: 10, spent: 30 },
      ]);
    });
  });
});
