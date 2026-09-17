/**
 * What a lane costs beyond the tests it runs, fitted from what lanes
 * have spent.
 *
 * A test's own cost is what the runner measured for it. A lane pays
 * more: it opens the capabilities its batches need, it starts a runner
 * per batch, and it loads a module per file. None of that is in any
 * test's duration, and all of it is in the five minutes a lane has.
 *
 * The packer already charges each of those — `setupCost` the first time
 * a lane opens a capability, a suite's `overhead` the first time a lane
 * holds that suite, its `unitOverhead` the first time a lane opens one of
 * its units, and its `correction` against every identity's own cost. What
 * it charges them from is this.
 *
 * The inputs are the lane's own measurements of itself, which travel to
 * the store as ordinary records. A lane writes one per capability it
 * opened and three per batch: what it spent, what it was packed to
 * spend, and how many units it opened. The second and third are what
 * make a fit possible at all — neither can be recovered from the records
 * the batch produced, because those say what the tests took rather than
 * what the packer thought they would, and a unit whose tests all recorded
 * nothing leaves no trace of having been opened.
 *
 * Every figure here errs high. A cost model that under-estimates puts a
 * lane past the bound it is killed at, where one that over-estimates
 * leaves a lane finishing early.
 */

import type { TestRecord } from "@commonfabric/test-support/records";
import { isObjectOrArray } from "@commonfabric/utils/types";
import type { Calibration } from "./manifest.ts";
import {
  batchMeasurement,
  isLaneMeasurement,
  setupMeasurement,
} from "../lane-measurement.ts";
import {
  LANE_PROLOGUE_SECONDS,
  MIN_CORRECTION_SAMPLES,
  MIN_CORRECTION_SPAN_SECONDS,
  MIN_UNIT_SPAN_UNITS,
} from "./policy.ts";

/** One thing a lane measured about itself, and the day it measured it. */
export type LaneObservation =
  | { day: string; capability: string; seconds: number }
  | {
    day: string;
    suite: string;
    planned: number;
    spent: number;
    units: number;
  };

/** Whether a stored figure is one the fit can use. */
function finite(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Whether a stored value is one observation, which is what a stored
 * aggregate is read back through. A figure that will not read as a
 * finite number reaches the fit as one all the same, and a single such
 * entry decides what every lane is charged for the suite it names.
 */
export function isLaneObservation(value: unknown): value is LaneObservation {
  if (!isObjectOrArray(value)) return false;
  const one = value as Record<string, unknown>;
  if (typeof one.day !== "string") return false;
  if (typeof one.capability === "string") return finite(one.seconds);
  return typeof one.suite === "string" && finite(one.planned) &&
    finite(one.spent) && finite(one.units);
}

/** One batch, as a lane measured it. */
export interface BatchObservation {
  /** The suite the batch ran. */
  suite: string;

  /**
   * Seconds the batch's own tests were expected to take: the sum over
   * its identities of the cost the manifest gives each, times the times
   * each is repeated. The suite's overhead and correction are not in it,
   * because they are what is fitted from it.
   */
  planned: number;

  /** Seconds the batch took. */
  spent: number;

  /**
   * Units the batch was asked to run. A unit's own tests are in
   * `planned`; what this counts is the runner started and the modules
   * loaded to reach them, which no test's duration holds.
   */
  units: number;
}

/** Every lane measurement a set of records holds, sorted into its kind. */
export interface Observations {
  /** Seconds each capability's setup took, every time one was opened. */
  setup: Map<string, number[]>;

  /** Each batch a lane both charged for and ran. */
  batches: BatchObservation[];
}

/**
 * What the aggregate has kept, in the shape the fit reads. The fold
 * pairs a batch's three measurements as it reads them, so what is stored
 * is already paired and this only sorts it.
 */
export function laneObservations(
  kept: Iterable<LaneObservation>,
): Observations {
  const setup = new Map<string, number[]>();
  const batches: BatchObservation[] = [];
  for (const one of kept) {
    if ("capability" in one) {
      setup.set(one.capability, [
        ...setup.get(one.capability) ?? [],
        one.seconds,
      ]);
    } else {
      batches.push({
        suite: one.suite,
        planned: one.planned,
        spent: one.spent,
        units: one.units,
      });
    }
  }
  return { setup, batches };
}

/**
 * Reads a run's records for what the lanes in it measured about
 * themselves.
 *
 * A batch is read only where all three of its measurements are present.
 * Two of them without the third say nothing a fit can use, and a lane
 * killed at its bound part way through a batch leaves exactly that — the
 * three are written together, so a batch that never finished contributes
 * none of them.
 *
 * They are keyed by the run, the suite, and whether coverage was on,
 * because five lanes of one run may each run the same suite and adding
 * two lanes' figures would describe a batch neither of them ran. Not by
 * the measurement's name, which is what tells the three apart and would
 * therefore keep them apart.
 */
export function observationsOf(
  runs: Iterable<{ run: string; records: Iterable<TestRecord> }>,
): Observations {
  const setup = new Map<string, number[]>();
  const planned = new Map<string, number>();
  const spent = new Map<string, number>();
  const units = new Map<string, number>();
  const suiteOf = new Map<string, string>();
  for (const { run, records } of runs) {
    for (const record of records) {
      if (!isLaneMeasurement(record.test)) continue;
      // Only a passing measurement says what the work costs. A batch
      // that went red stopped at the first invocation that failed, and
      // a capability that failed to open stopped part way through
      // opening; either reads as the work being cheap. The fold draws
      // the same line for a test's own duration and for the same reason.
      if (record.outcome !== "pass") continue;
      const seconds = record.durationMs / 1000;
      const capability = setupMeasurement(record.test.n);
      if (capability !== undefined) {
        setup.set(capability, [...setup.get(capability) ?? [], seconds]);
        continue;
      }
      const batch = batchMeasurement(record.test.n);
      if (batch === undefined) continue;
      // The suite and the coverage marker, not the name: a batch's three
      // measurements are named differently, and that is what tells them
      // apart. The marker is in the key so that a batch run with
      // coverage on pairs with its own planned figure rather than with
      // an uninstrumented batch's.
      const key = `${run}\t${batch.suite}\t${batch.measured}`;
      suiteOf.set(key, batch.suite);
      // A count is not a duration. The record format carries one number
      // and calls it a duration, and the name is what says which of the
      // three this is, so the count is read back as it was written.
      if (batch.kind === "units") units.set(key, record.durationMs);
      else (batch.kind === "planned" ? planned : spent).set(key, seconds);
    }
  }
  const batches: BatchObservation[] = [];
  for (const [key, took] of spent) {
    const charged = planned.get(key);
    const opened = units.get(key);
    if (charged === undefined || opened === undefined) continue;
    batches.push({
      suite: suiteOf.get(key)!,
      planned: charged,
      spent: took,
      units: opened,
    });
  }
  return { setup, batches };
}

/**
 * What one group of records says, in the shape an aggregate stores. The
 * day travels with each observation so that a stored one can be aged the
 * way every other window is.
 */
export function laneObservationsOf(
  run: string,
  records: Iterable<TestRecord>,
  day: string,
): LaneObservation[] {
  const seen = observationsOf([{ run, records }]);
  return [
    ...[...seen.setup].flatMap(([capability, samples]) =>
      samples.map((seconds) => ({ day, capability, seconds }))
    ),
    ...seen.batches.map((batch) => ({
      day,
      suite: batch.suite,
      planned: batch.planned,
      spent: batch.spent,
      units: batch.units,
    })),
  ];
}

/** The two slopes a suite's cost is fitted with. */
interface Slopes {
  /** What one second of the batch's own planned test time costs. */
  correction: number;

  /** What one more unit costs a batch that already runs others. */
  unitOverhead: number;
}

/** What a suite carries where neither slope has been fitted. */
const UNFITTED: Slopes = { correction: 1, unitOverhead: 0 };

/** The widest gap between two observations' readings of `of`. */
function span(
  observations: readonly BatchObservation[],
  of: (observation: BatchObservation) => number,
): number {
  const read = observations.map(of);
  return Math.max(...read) - Math.min(...read);
}

/**
 * The least-squares slope of `y` on `x` through the observations. The
 * caller has established that the observations disagree about `x`, so
 * they cannot all sit on one vertical line and the divisor is positive.
 */
function slopeOf(
  observations: readonly BatchObservation[],
  x: (observation: BatchObservation) => number,
  y: (observation: BatchObservation) => number,
): number {
  const n = observations.length;
  const meanX = observations.reduce((t, o) => t + x(o), 0) / n;
  const meanY = observations.reduce((t, o) => t + y(o), 0) / n;
  let top = 0;
  let bottom = 0;
  for (const o of observations) {
    top += (x(o) - meanX) * (y(o) - meanY);
    bottom += (x(o) - meanX) ** 2;
  }
  return top / bottom;
}

/**
 * How far apart the observations are in their readings of `of` once
 * whatever `other` explains of that is taken out. The caller has
 * established that the observations disagree about `other`, so the slope
 * this takes out is one it can fit.
 *
 * This is what says whether each reading carries evidence of its own. A
 * suite whose batches all held the same seconds of tests per unit has one
 * reading written two ways, and what a batch cost could be split between
 * the two however you liked; the split would be a choice rather than a
 * measurement, and read out at a batch holding a different mix it would
 * be wrong in either direction.
 */
function independentSpan(
  observations: readonly BatchObservation[],
  of: (observation: BatchObservation) => number,
  other: (observation: BatchObservation) => number,
): number {
  const tracking = slopeOf(observations, other, of);
  return span(observations, (o) => of(o) - tracking * other(o));
}

/**
 * Both slopes at once. The caller has established that each reading says
 * something the other does not, so the two are separable and the divisor
 * is positive.
 */
function bothSlopes(observations: readonly BatchObservation[]): Slopes {
  const n = observations.length;
  const meanP = observations.reduce((t, o) => t + o.planned, 0) / n;
  const meanU = observations.reduce((t, o) => t + o.units, 0) / n;
  const meanY = observations.reduce((t, o) => t + o.spent, 0) / n;
  let pp = 0, uu = 0, pu = 0, py = 0, uy = 0;
  for (const o of observations) {
    const dp = o.planned - meanP;
    const du = o.units - meanU;
    const dy = o.spent - meanY;
    pp += dp * dp;
    uu += du * du;
    pu += dp * du;
    py += dp * dy;
    uy += du * dy;
  }
  const separable = pp * uu - pu * pu;
  return {
    correction: (uu * py - pu * uy) / separable,
    unitOverhead: (pp * uy - pu * py) / separable,
  };
}

/** The correction alone, with a unit costing the nothing it starts at. */
function correctionAlone(observations: readonly BatchObservation[]): Slopes {
  const correction = slopeOf(observations, (o) => o.planned, (o) => o.spent);
  return correction > 0 ? { ...UNFITTED, correction } : UNFITTED;
}

/**
 * The per-unit cost alone, fitted against what the batch spent beyond
 * its tests, since the tests are charged at the reading this leaves the
 * correction at.
 */
function unitsAlone(observations: readonly BatchObservation[]): Slopes {
  const unitOverhead = slopeOf(
    observations,
    (o) => o.units,
    (o) => o.spent - o.planned,
  );
  return unitOverhead > 0 ? { ...UNFITTED, unitOverhead } : UNFITTED;
}

/**
 * What a batch costs in proportion to what it holds: a slope on the
 * seconds its tests were planned to take, and a slope on the units it
 * opened.
 *
 * A slope is read far outside the range it was fitted over: a suite
 * charged six seconds in every batch anybody has seen may be charged
 * thousands the first time a lane packs it whole, and one that has never
 * held more than five units may be asked to hold nine hundred. So each is
 * fitted only where the suite's batches have disagreed enough about that
 * reading for a slope to mean anything, and otherwise stays at the
 * reading that needs no evidence.
 *
 * Neither is believed where it comes out at or below zero. A correction
 * below one is ordinary — a batch runs its files in parallel, so the wall
 * time of one is routinely a fraction of the sum of its tests' own
 * durations, and the pattern unit suite takes about a third — but at or
 * below zero either slope says a batch grows no dearer, or grows cheaper,
 * the more of the suite it holds, which would let a lane pack the suite
 * without limit against a flat charge. A manifest carrying a correction
 * of zero is refused whole, so publishing one would leave every lane with
 * no manifest at all.
 *
 * Nothing bounds either above. The intercept absorbs whatever a bound
 * would have moved, and the intercept is charged once for holding the
 * suite where these are charged in proportion, so bounding a slope makes
 * a suite dearer to reach rather than cheaper.
 */
function slopes(observations: readonly BatchObservation[]): Slopes {
  if (observations.length < MIN_CORRECTION_SAMPLES) return UNFITTED;
  const planned = (o: BatchObservation) => o.planned;
  const units = (o: BatchObservation) => o.units;
  const plannedWide = span(observations, planned) >=
    MIN_CORRECTION_SPAN_SECONDS;
  // The width the unit count has to clear is in the part of it the
  // planned seconds do not account for. The two are asked different
  // questions because their readings without evidence differ: a
  // correction of one says a second of test time costs a second, which
  // is a claim about the machine, where a per-unit cost of zero says
  // opening a unit is free, which is a claim about nothing. So the
  // correction is fitted from the suite's batches as it always has been,
  // and the unit count is believed only where it says something the
  // correction does not. Asking the correction for evidence independent
  // of the units as well would refuse the pair wherever the two move
  // together, which for a unit suite is the ordinary case — more units
  // usually means more tests — and leave the suite charged as though
  // opening a unit were free.
  const unitsWide = span(observations, units) >= MIN_UNIT_SPAN_UNITS &&
    (!plannedWide ||
      independentSpan(observations, units, planned) >= MIN_UNIT_SPAN_UNITS);
  if (!plannedWide) return unitsWide ? unitsAlone(observations) : UNFITTED;
  if (!unitsWide) return correctionAlone(observations);
  const both = bothSlopes(observations);
  if (both.correction > 0 && both.unitOverhead > 0) return both;
  if (both.correction <= 0 && both.unitOverhead <= 0) return UNFITTED;
  // What one slope comes to beside the other is not what it comes to
  // without it, so the one that is believed is fitted again on its own
  // rather than kept at the figure the pair gave it.
  return both.correction > 0
    ? correctionAlone(observations)
    : unitsAlone(observations);
}

/**
 * What the share of a batch that is not its tests comes to, as an
 * intercept and two slopes.
 *
 * The intercept is raised until no observation is under-predicted,
 * whatever the slopes came to. A least-squares plane sits in the middle
 * of its observations by construction, which for this quantity means half
 * the lanes running past the budget they were packed against.
 */
export function fitSuite(
  observations: readonly BatchObservation[],
): { overhead: number; correction: number; unitOverhead: number } {
  if (observations.length === 0) return { overhead: 0, ...UNFITTED };
  const fitted = slopes(observations);
  const overhead = observations.reduce(
    (most, o) =>
      Math.max(
        most,
        o.spent - fitted.correction * o.planned - fitted.unitOverhead * o.units,
      ),
    0,
  );
  return { overhead, ...fitted };
}

/** What a lane pays beyond its tests, fitted from what lanes have spent. */
export function calibrate(observations: Observations): Calibration {
  const setupCost: Record<string, number> = {};
  // The worst opening anybody has seen, which is the same reading the
  // intercept takes and errs the same way.
  for (const [capability, seconds] of observations.setup) {
    setupCost[capability] = Math.max(...seconds);
  }
  // Keyed by suite alone, which is how a calibration is keyed and how
  // the packer looks one up. A suite's instrumented and uninstrumented
  // batches are therefore fitted together, and the intercept is the
  // largest residual of either, so an uninstrumented batch is charged
  // what an instrumented one cost. That is the direction this errs in
  // everywhere else.
  const bySuite = new Map<string, BatchObservation[]>();
  for (const batch of observations.batches) {
    bySuite.set(batch.suite, [...bySuite.get(batch.suite) ?? [], batch]);
  }
  const suites: Calibration["suites"] = {};
  for (const [suite, batches] of bySuite) suites[suite] = fitSuite(batches);
  return { setupCost, suites, prologue: LANE_PROLOGUE_SECONDS };
}
