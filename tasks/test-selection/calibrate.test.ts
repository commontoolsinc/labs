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
  MIN_UNIT_SPAN_UNITS,
} from "./policy.ts";

/** One figure a lane spooled, as the record format carries it. */
function figure(name: string, durationMs: number): TestRecord {
  return {
    line: "record",
    test: {
      k: LANE_MEASUREMENT_SURFACE.kind,
      s: LANE_MEASUREMENT_SURFACE.scope,
      n: name,
    },
    outcome: "pass",
    durationMs: Math.round(durationMs),
  };
}

/** One measurement of a span of time, as a lane spools it. */
function measured(name: string, seconds: number): TestRecord {
  return figure(name, seconds * 1000);
}

/** What a lane writes about one batch: the three figures, together. */
function batch(
  suite: string,
  ran: number,
  spent: number,
  units = 1,
  coverage = false,
): TestRecord[] {
  return [
    measured(batchMeasurementName(suite, coverage), spent),
    measured(batchMeasurementName(suite, coverage, "ran"), ran),
    figure(batchMeasurementName(suite, coverage, "units"), units),
  ];
}

/**
 * Observations that say what each of the two slopes is worth on its own.
 * Every combination of a small and a large reading of each, which is what
 * stops one slope explaining the other's effect, over spans wide enough
 * that both slopes are believed.
 */
function separable(
  spent: (ran: number, units: number) => number,
): BatchObservation[] {
  const observations: BatchObservation[] = [];
  for (
    const ran of [
      MIN_CORRECTION_SPAN_SECONDS,
      MIN_CORRECTION_SPAN_SECONDS * 3,
    ]
  ) {
    for (const units of [MIN_UNIT_SPAN_UNITS, MIN_UNIT_SPAN_UNITS * 3]) {
      observations.push({
        suite: "s",
        ran,
        units,
        spent: spent(ran, units),
      });
    }
  }
  return observations;
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

    it("joins what a batch cost, what it took, and what it opened", () => {
      const seen = observationsOf([
        { run: "a", records: batch("workspace-unit", 40, 92, 17) },
      ]);
      expect(seen.batches).toEqual([
        { suite: "workspace-unit", ran: 40, spent: 92, units: 17 },
      ]);
    });

    it("reads a unit count as a count rather than as a span of time", () => {
      // The record format carries one number and calls it a duration, so
      // a count read the way a duration is would arrive a thousand times
      // too small.
      const seen = observationsOf([
        { run: "a", records: batch("workspace-unit", 40, 92, 250) },
      ]);
      expect(seen.batches[0]!.units).toBe(250);
    });

    it("takes nothing from a batch missing one of the three", () => {
      // A lane writes all three together, so two alone are records that
      // arrived without the third rather than a batch to fit from.
      for (let left = 0; left < 3; left++) {
        const records = batch("workspace-unit", 40, 92, 17)
          .filter((_, at) => at !== left);
        expect(observationsOf([{ run: "a", records }]).batches).toEqual([]);
      }
    });

    it("keeps two lanes of one run apart", () => {
      // Five lanes of a run may each hold the same suite, and adding two
      // lanes' figures would describe a batch neither of them ran.
      const seen = observationsOf([
        { run: "run-1-lane-1", records: batch("runner-unit", 10, 30, 4) },
        { run: "run-1-lane-2", records: batch("runner-unit", 20, 50, 9) },
      ]);
      expect(seen.batches.sort((a, b) => a.spent - b.spent)).toEqual([
        { suite: "runner-unit", ran: 10, spent: 30, units: 4 },
        { suite: "runner-unit", ran: 20, spent: 50, units: 9 },
      ]);
    });

    it("joins a batch run with coverage to its own figures", () => {
      // Its tests took the same time as the uninstrumented batch's, so
      // a join that ignored the marker could read either batch's spent
      // figure against either's.
      const seen = observationsOf([{
        run: "a",
        records: [
          ...batch("workspace-unit", 40, 92, 17),
          ...batch("workspace-unit", 40, 150, 17, true),
        ],
      }]);
      expect(seen.batches.sort((a, b) => a.spent - b.spent)).toEqual([
        { suite: "workspace-unit", ran: 40, spent: 92, units: 17 },
        { suite: "workspace-unit", ran: 40, spent: 150, units: 17 },
      ]);
    });

    it("takes nothing from a batch that went red", () => {
      // A batch that failed stopped at the first invocation that did,
      // and what it spent says the suite is cheap rather than saying
      // what running it costs.
      const failed = batch("workspace-unit", 460, 3, 12)
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

    it("passes over a lane measurement of something else entirely", () => {
      // Everything a lane writes about itself carries the same prefix, so
      // a kind of measurement this does not read arrives here rather than
      // anywhere else. Skipping it is what lets a lane record something
      // new without the fit reading it as a batch.
      const seen = observationsOf([{
        run: "a",
        records: [measured(`${LANE_MEASUREMENT_PREFIX}prologue`, 41.2)],
      }]);
      expect(seen.setup.size).toBe(0);
      expect(seen.batches).toEqual([]);
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
          ...batch("runner-unit", 10, 30, 4),
          measured(`${LANE_MEASUREMENT_PREFIX}setup fuse`, 14.8),
        ],
        "2026-09-12",
      );
      expect(kept).toEqual([
        { day: "2026-09-12", capability: "fuse", seconds: 14.8 },
        {
          day: "2026-09-12",
          suite: "runner-unit",
          ran: 10,
          spent: 30,
          units: 4,
        },
      ]);
    });
  });

  describe("fitting one suite", () => {
    it("puts the whole of one observation into the intercept", () => {
      // With one sample there is nothing to say about how the cost grows,
      // so the intercept carries what the lane was seen to spend.
      expect(fitSuite([{ suite: "s", ran: 40, spent: 92, units: 6 }]))
        .toEqual({ overhead: 52, correction: 1, unitOverhead: 0 });
    });

    it("tells what the tests cost from what the units cost", () => {
      // The whole point of measuring the unit count: a suite that opens a
      // runner and loads a module per unit pays for that whatever its
      // tests take, and nothing in a test's own duration holds it.
      const fitted = fitSuite(
        separable((ran, units) => 10 + 2 * ran + 0.5 * units),
      );
      expect(fitted.correction).toBeCloseTo(2, 6);
      expect(fitted.unitOverhead).toBeCloseTo(0.5, 6);
      expect(fitted.overhead).toBeCloseTo(10, 6);
    });

    it("finds the slope enough disagreeing observations carry", () => {
      const fitted = fitSuite(
        Array.from({ length: MIN_CORRECTION_SAMPLES }, (_, i) => ({
          suite: "s",
          units: 1,
          ran: MIN_CORRECTION_SPAN_SECONDS * (1 + i),
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
        {
          suite: "s",
          units: 1,
          ran: MIN_CORRECTION_SPAN_SECONDS,
          spent: 80,
        },
        {
          suite: "s",
          units: MIN_UNIT_SPAN_UNITS * 4,
          ran: MIN_CORRECTION_SPAN_SECONDS * 3,
          spent: 100,
        },
      ]);
      expect(fitted.correction).toBe(1);
      expect(fitted.unitOverhead).toBe(0);
      expect(fitted.overhead).toBeCloseTo(80 - MIN_CORRECTION_SPAN_SECONDS, 6);
    });

    it("charges a steep suite on its slope rather than its intercept", () => {
      // Nothing bounds the slope from above. The intercept is what a lane
      // pays to run one test of the suite, so a bound that moved cost
      // there would make the suite dearer to reach, not cheaper.
      const fitted = fitSuite(
        Array.from({ length: MIN_CORRECTION_SAMPLES }, (_, i) => ({
          suite: "s",
          units: 1,
          ran: MIN_CORRECTION_SPAN_SECONDS * (1 + i),
          spent: 20 + 50 * MIN_CORRECTION_SPAN_SECONDS * (1 + i),
        })),
      );
      expect(fitted.correction).toBeCloseTo(50, 6);
      expect(fitted.overhead).toBeCloseTo(20, 6);
    });

    it("never predicts a batch costing less than one was seen to", () => {
      // A least-squares plane sits in the middle of its observations,
      // which for this quantity is half the lanes running past the
      // budget they were packed against.
      const seen: BatchObservation[] = [
        ...separable((ran, units) => 10 + 2 * ran + 0.5 * units),
        {
          suite: "s",
          units: MIN_UNIT_SPAN_UNITS,
          ran: MIN_CORRECTION_SPAN_SECONDS,
          spent: 900,
        },
      ];
      const fitted = fitSuite(seen);
      for (const one of seen) {
        expect(
          fitted.overhead + fitted.correction * one.ran +
            fitted.unitOverhead * one.units,
        ).toBeGreaterThanOrEqual(one.spent - 1e-9);
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
          units: 1,
          ran: 2 + 0.5 * i,
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
          units: 1,
          ran: most + i,
          spent: 200 + i / 10,
        })),
      );
      expect(fitted.correction).toBe(1);
    });

    it("charges a suite per unit where its tests say too little", () => {
      // The shape a workspace unit suite arrives in: every batch charged
      // about the same seconds of tests, and batches of wildly different
      // sizes. There is no correction to fit, and the whole of what
      // separates one batch from another is how many units it opened.
      const fitted = fitSuite(
        Array.from({ length: MIN_CORRECTION_SAMPLES }, (_, i) => ({
          suite: "s",
          units: MIN_UNIT_SPAN_UNITS * (1 + i),
          ran: MIN_CORRECTION_SPAN_SECONDS,
          spent: MIN_CORRECTION_SPAN_SECONDS + 8 +
            3 * MIN_UNIT_SPAN_UNITS * (1 + i),
        })),
      );
      expect(fitted.correction).toBe(1);
      expect(fitted.unitOverhead).toBeCloseTo(3, 6);
      expect(fitted.overhead).toBeCloseTo(8, 6);
    });

    it("believes no correction where the tests track the units", () => {
      // The mirror of the reading below: a correction fitted beside a
      // unit count it moves in lockstep with is as much a choice as a
      // per-unit cost fitted beside the tests would be. The suite keeps
      // the slope it has always been fitted, which is the one on its
      // tests, and that slope carries both readings together.
      const fitted = fitSuite(
        Array.from({ length: MIN_CORRECTION_SAMPLES }, (_, i) => ({
          suite: "s",
          units: MIN_UNIT_SPAN_UNITS * (1 + i),
          ran: MIN_CORRECTION_SPAN_SECONDS * (1 + i),
          spent: 10 + 2 * MIN_CORRECTION_SPAN_SECONDS * (1 + i),
        })),
      );
      expect(fitted.correction).toBeCloseTo(2, 6);
      expect(fitted.unitOverhead).toBe(0);
    });

    it("believes no per-unit cost from batches of about one size", () => {
      // The same reasoning in the units the regressor counts. These
      // batches differ from each other by three units where fifty is
      // what a per-unit cost has to be spread over before it is
      // believed, so what separates them is the runner rather than the
      // suite, and a slope fitted across them would be read out at the
      // nine hundredth unit.
      const fitted = fitSuite(
        Array.from({ length: MIN_CORRECTION_SAMPLES + 1 }, (_, i) => ({
          suite: "s",
          units: MIN_UNIT_SPAN_UNITS + i,
          ran: MIN_CORRECTION_SPAN_SECONDS * (2 + i),
          spent: 100 + 40 * i,
        })),
      );
      expect(fitted.unitOverhead).toBe(0);
    });

    it("believes no per-unit cost where the units track the tests", () => {
      // Nothing separates the two where every batch held about the same
      // seconds of tests per unit, however wide a range of sizes those
      // batches covered. Splitting what they cost between them would be
      // a choice rather than a reading, so the suite keeps the one slope
      // it has always been fitted. The second reading bends off the line,
      // by a quarter of what a unit count has to vary by before it is
      // believed. That is the case the widest gap between two batches'
      // sizes passes several times over, and the gap left after the
      // tests are accounted for does not.
      const bends = Math.round(MIN_UNIT_SPAN_UNITS / 4);
      for (const bend of [0, bends]) {
        const fitted = fitSuite(
          Array.from({ length: MIN_CORRECTION_SAMPLES }, (_, i) => ({
            suite: "s",
            units: MIN_UNIT_SPAN_UNITS * (1 + i) + bend * i * i,
            ran: MIN_CORRECTION_SPAN_SECONDS * (1 + i),
            spent: 10 + 2 * MIN_CORRECTION_SPAN_SECONDS * (1 + i),
          })),
        );
        expect(fitted.correction).toBeCloseTo(2, 6);
        expect(fitted.unitOverhead).toBe(0);
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
          units: 1,
          ran: MIN_CORRECTION_SPAN_SECONDS * (2 + i),
          spent: MIN_CORRECTION_SPAN_SECONDS * (2 + i) / 3,
        })),
      );
      expect(fitted.correction).toBeCloseTo(1 / 3, 6);
      expect(fitted.overhead).toBeCloseTo(0, 6);
    });

    it("refuses a slope saying a batch gets cheaper with more tests", () => {
      // Such a slope would let a lane pack the suite without limit
      // against a flat charge. A correction of zero is worse still: a
      // manifest carrying one is refused whole, so a single suite whose
      // batches trend downward would leave every lane with no manifest.
      const fitted = fitSuite(
        Array.from({ length: MIN_CORRECTION_SAMPLES }, (_, i) => ({
          suite: "s",
          units: 1,
          ran: MIN_CORRECTION_SPAN_SECONDS * (2 + i),
          spent: 500 - 0.5 * MIN_CORRECTION_SPAN_SECONDS * (2 + i),
        })),
      );
      expect(fitted.correction).toBe(1);
    });

    it("keeps the per-unit cost when the correction comes out negative", () => {
      // The two are fitted together, so a reading refused takes the other
      // one's figure with it: what a unit costs beside a correction of
      // minus a half is not what it costs beside a correction of one.
      const fitted = fitSuite(
        separable((ran, units) => units - 0.5 * ran),
      );
      expect(fitted.correction).toBe(1);
      expect(fitted.unitOverhead).toBeGreaterThan(0);
    });

    it("keeps the correction when the per-unit cost comes out negative", () => {
      const fitted = fitSuite(
        separable((ran, units) => 2 * ran - units),
      );
      expect(fitted.correction).toBeCloseTo(2, 6);
      expect(fitted.unitOverhead).toBe(0);
    });

    it("fits every suite figures a manifest will carry", () => {
      // `parseCalibration` refuses a correction at or below zero and a
      // per-unit cost below zero, and it refuses the whole manifest with
      // either, so what this returns has to survive being published.
      for (const perSecond of [-3, -0.5, 0, 0.25, 4, 50]) {
        for (const perUnit of [-2, 0, 0.5, 9]) {
          const fitted = fitSuite(
            separable((ran, units) => 500 + perSecond * ran + perUnit * units),
          );
          expect(fitted.correction).toBeGreaterThan(0);
          expect(fitted.unitOverhead).toBeGreaterThanOrEqual(0);
          expect(fitted.overhead).toBeGreaterThanOrEqual(0);
        }
      }
    });

    it("charges nothing for a suite nothing has measured", () => {
      expect(fitSuite([])).toEqual({
        overhead: 0,
        correction: 1,
        unitOverhead: 0,
      });
    });
  });

  describe("calibrate()", () => {
    it("names every capability and every suite it was given", () => {
      const fitted = calibrate({
        setup: new Map([["fuse", [14.8, 2.1]], ["browser", [0]]]),
        batches: [
          { suite: "workspace-unit", ran: 40, spent: 92, units: 3 },
          { suite: "runner-unit", ran: 10, spent: 20, units: 2 },
        ],
      });
      expect(Object.keys(fitted.setupCost).sort()).toEqual(["browser", "fuse"]);
      expect(Object.keys(fitted.suites).sort()).toEqual([
        "runner-unit",
        "workspace-unit",
      ]);
      expect(fitted.suites["workspace-unit"].overhead).toBe(52);
    });
  });

  describe("isLaneObservation()", () => {
    it("returns `true` for either kind of observation", () => {
      expect(isLaneObservation({ day: "d", capability: "fuse", seconds: 14.8 }))
        .toBe(true);
      expect(
        isLaneObservation({
          day: "d",
          suite: "s",
          ran: 10,
          spent: 30,
          units: 4,
        }),
      ).toBe(true);
    });

    it("returns `false` for a figure that is not a finite number", () => {
      // A stored `Infinity` or `NaN` arrives as `null`, and one entry
      // read forward as a number that is not one decides what every lane
      // is charged for the suite it names.
      expect(isLaneObservation({ day: "d", capability: "fuse", seconds: null }))
        .toBe(false);
      expect(
        isLaneObservation({
          day: "d",
          suite: "s",
          ran: 10,
          spent: "30",
          units: 4,
        }),
      ).toBe(false);
      expect(
        isLaneObservation({
          day: "d",
          suite: "s",
          ran: Infinity,
          spent: 3,
          units: 4,
        }),
      ).toBe(false);
    });

    it("returns `false` for anything that is not one", () => {
      expect(isLaneObservation({ capability: "fuse", seconds: 1 })).toBe(false);
      expect(isLaneObservation({ day: "d", seconds: 1 })).toBe(false);
      expect(isLaneObservation({ day: "d", suite: "s", ran: 10 }))
        .toBe(false);
      expect(
        isLaneObservation({ day: "d", suite: "s", ran: 10, spent: 30 }),
      ).toBe(false);
      expect(isLaneObservation("fuse took a while")).toBe(false);
      expect(isLaneObservation(null)).toBe(false);
    });
  });

  describe("what the aggregate kept", () => {
    it("sorts stored observations back into the two kinds", () => {
      const seen = laneObservations([
        { day: "2026-09-12", capability: "fuse", seconds: 14.8 },
        {
          day: "2026-09-12",
          suite: "runner-unit",
          ran: 10,
          spent: 30,
          units: 4,
        },
        { day: "2026-09-13", capability: "fuse", seconds: 2.1 },
      ]);
      expect(seen.setup.get("fuse")).toEqual([14.8, 2.1]);
      expect(seen.batches).toEqual([
        { suite: "runner-unit", ran: 10, spent: 30, units: 4 },
      ]);
    });
  });
});
