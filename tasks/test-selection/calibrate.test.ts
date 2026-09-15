import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { TestRecord } from "@commonfabric/test-support/records";
import {
  type BatchObservation,
  calibrate,
  fitSuite,
  isLaneObservation,
  laneObservations,
  laneObservationsOf,
  observationsOf,
} from "./calibrate.ts";
import {
  batchMeasurementName,
  LANE_MEASUREMENT_PREFIX,
  LANE_MEASUREMENT_SURFACE,
} from "../lane-measurement.ts";
import {
  MIN_CORRECTION_SAMPLES,
  MIN_CORRECTION_SPAN_SECONDS,
} from "./policy.ts";

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

describe("calibrate", () => {
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
      expect(seen.batches.sort((a, b) => a.spent - b.spent)).toEqual([
        { suite: "runner-unit", planned: 10, spent: 30 },
        { suite: "runner-unit", planned: 20, spent: 50 },
      ]);
    });

    it("pairs a batch run with coverage with its own planned figure", () => {
      // Its planned figure is the same as the uninstrumented batch's, so
      // a pairing that ignored the marker could read either batch's
      // spent figure against either's planned one.
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
      expect(seen.batches.sort((a, b) => a.spent - b.spent)).toEqual([
        { suite: "workspace-unit", planned: 40, spent: 92 },
        { suite: "workspace-unit", planned: 40, spent: 150 },
      ]);
    });

    it("takes nothing from a batch that went red", () => {
      // A batch that failed stopped at the first invocation that did,
      // and what it spent says the suite is cheap rather than saying
      // what running it costs.
      const failed = batch("workspace-unit", 460, 3)
        .map((record) => ({ ...record, outcome: "fail" as const }));
      expect(observationsOf([{ run: "a", records: failed }]).batches)
        .toEqual([]);
    });

    it("takes nothing from a capability that failed to open", () => {
      const seen = observationsOf([{
        run: "a",
        records: [{
          ...measured(`${LANE_MEASUREMENT_PREFIX}setup fuse`, 0.4),
          outcome: "fail",
        }],
      }]);
      expect(seen.setup.size).toBe(0);
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
          planned: MIN_CORRECTION_SPAN_SECONDS * (1 + i),
          spent: 10 + 2 * MIN_CORRECTION_SPAN_SECONDS * (1 + i),
        })),
      );
      expect(fitted.correction).toBeCloseTo(2, 6);
      expect(fitted.overhead).toBeCloseTo(10, 6);
    });

    it("fits no slope from too few observations", () => {
      // Two points fit a line exactly, so a line through two of them says
      // whatever they say and nothing about their noise. They are charged
      // far enough apart to clear the span guard, so the count is the
      // only thing that can refuse a slope here.
      const fitted = fitSuite([
        { suite: "s", planned: MIN_CORRECTION_SPAN_SECONDS, spent: 80 },
        { suite: "s", planned: MIN_CORRECTION_SPAN_SECONDS * 3, spent: 100 },
      ]);
      expect(fitted.correction).toBe(1);
      expect(fitted.overhead).toBeCloseTo(80 - MIN_CORRECTION_SPAN_SECONDS, 6);
    });

    it("charges a steep suite on its slope rather than its intercept", () => {
      // Nothing bounds the slope from above. The intercept is what a lane
      // pays to run one test of the suite, so a bound that moved cost
      // there would make the suite dearer to reach, not cheaper.
      const fitted = fitSuite(
        Array.from({ length: MIN_CORRECTION_SAMPLES }, (_, i) => ({
          suite: "s",
          planned: MIN_CORRECTION_SPAN_SECONDS * (1 + i),
          spent: 20 + 50 * MIN_CORRECTION_SPAN_SECONDS * (1 + i),
        })),
      );
      expect(fitted.correction).toBeCloseTo(50, 6);
      expect(fitted.overhead).toBeCloseTo(20, 6);
    });

    it("never predicts a batch costing less than one was seen to", () => {
      // A least-squares line sits in the middle of its observations,
      // which for this quantity is half the lanes running past the
      // budget they were packed against.
      const seen: BatchObservation[] = [
        ...Array.from({ length: MIN_CORRECTION_SAMPLES }, (_, i) => ({
          suite: "s",
          planned: MIN_CORRECTION_SPAN_SECONDS * (1 + i),
          spent: 10 + 2 * MIN_CORRECTION_SPAN_SECONDS * (1 + i),
        })),
        { suite: "s", planned: MIN_CORRECTION_SPAN_SECONDS, spent: 900 },
      ];
      const fitted = fitSuite(seen);
      for (const one of seen) {
        expect(fitted.overhead + fitted.correction * one.planned)
          .toBeGreaterThanOrEqual(one.spent - 1e-9);
      }
    });

    it("believes no slope from a suite nothing has charged much for", () => {
      // A slope is read far outside the range it was fitted over: a
      // suite charged six seconds in every batch anybody has seen may be
      // charged thousands the first time a lane packs it whole. Inside a
      // narrow range the fixed cost dominates and the slope is noise,
      // which is how a lane comes to believe six thousand seconds of
      // tests are free.
      const fitted = fitSuite(
        Array.from({ length: MIN_CORRECTION_SAMPLES + 3 }, (_, i) => ({
          suite: "s",
          planned: 2 + 0.5 * i,
          spent: 41,
        })),
      );
      expect(fitted.correction).toBe(1);
    });

    it("believes no slope from batches charged within a second of each other", () => {
      // A range is narrow wherever it sits. Batches charged 229, 230 and
      // 230 seconds say as little about a slope as batches charged two,
      // three and four, and the slope a line through them carries would
      // be read against a batch charged thousands.
      const most = MIN_CORRECTION_SPAN_SECONDS * 10;
      const fitted = fitSuite(
        Array.from({ length: MIN_CORRECTION_SAMPLES + 1 }, (_, i) => ({
          suite: "s",
          planned: most + i,
          spent: 200 + i / 10,
        })),
      );
      expect(fitted.correction).toBe(1);
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
          planned: MIN_CORRECTION_SPAN_SECONDS * (2 + i),
          spent: MIN_CORRECTION_SPAN_SECONDS * (2 + i) / 3,
        })),
      );
      expect(fitted.correction).toBeCloseTo(1 / 3, 6);
      expect(fitted.overhead).toBeCloseTo(0, 6);
    });

    it("refuses a slope saying a batch gets cheaper with more tests", () => {
      const fitted = fitSuite(
        Array.from({ length: MIN_CORRECTION_SAMPLES }, (_, i) => ({
          suite: "s",
          planned: MIN_CORRECTION_SPAN_SECONDS * (2 + i),
          spent: 500 - 0.5 * MIN_CORRECTION_SPAN_SECONDS * (2 + i),
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
  });

  describe("isLaneObservation()", () => {
    it("returns `true` for either kind of observation", () => {
      expect(isLaneObservation({ day: "d", capability: "fuse", seconds: 14.8 }))
        .toBe(true);
      expect(
        isLaneObservation({ day: "d", suite: "s", planned: 10, spent: 30 }),
      ).toBe(true);
    });

    it("returns `false` for a figure that is not a finite number", () => {
      // A stored `Infinity` or `NaN` arrives as `null`, and one entry
      // read forward as a number that is not one decides what every lane
      // is charged for the suite it names.
      expect(isLaneObservation({ day: "d", capability: "fuse", seconds: null }))
        .toBe(false);
      expect(
        isLaneObservation({ day: "d", suite: "s", planned: 10, spent: "30" }),
      ).toBe(false);
      expect(
        isLaneObservation({
          day: "d",
          suite: "s",
          planned: Infinity,
          spent: 3,
        }),
      ).toBe(false);
    });

    it("returns `false` for anything that is not one", () => {
      expect(isLaneObservation({ capability: "fuse", seconds: 1 })).toBe(false);
      expect(isLaneObservation({ day: "d", seconds: 1 })).toBe(false);
      expect(isLaneObservation({ day: "d", suite: "s", planned: 10 }))
        .toBe(false);
      expect(isLaneObservation("fuse took a while")).toBe(false);
      expect(isLaneObservation(null)).toBe(false);
    });
  });

  describe("what the aggregate kept", () => {
    it("sorts stored observations back into the two kinds", () => {
      const seen = laneObservations([
        { day: "2026-09-12", capability: "fuse", seconds: 14.8 },
        { day: "2026-09-12", suite: "runner-unit", planned: 10, spent: 30 },
        { day: "2026-09-13", capability: "fuse", seconds: 2.1 },
      ]);
      expect(seen.setup.get("fuse")).toEqual([14.8, 2.1]);
      expect(seen.batches).toEqual([
        { suite: "runner-unit", planned: 10, spent: 30 },
      ]);
    });
  });
});
