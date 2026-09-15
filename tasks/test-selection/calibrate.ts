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
 * holds that suite, and `correction` against every identity's own cost.
 * What it charges them from is this.
 *
 * The inputs are the lane's own measurements of itself, which travel to
 * the store as ordinary records. A lane writes one per capability it
 * opened and two per batch: what it spent, and what it was packed to
 * spend. The second is what makes a fit possible at all — what the
 * packer expected the batch's tests to take cannot be recovered from the
 * records the batch produced, because those records say what the tests
 * took and not what the packer thought they would.
 *
 * Every figure here errs high. A cost model that under-estimates puts a
 * lane past the bound it is killed at, where one that over-estimates
 * leaves a lane finishing early.
 */

import type { TestRecord } from "@commonfabric/test-support/records";
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
} from "./policy.ts";

/** One thing a lane measured about itself, and the day it measured it. */
export type LaneObservation =
  | { day: string; capability: string; seconds: number }
  | { day: string; suite: string; planned: number; spent: number };

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
  if (typeof value !== "object" || value === null) return false;
  const one = value as Record<string, unknown>;
  if (typeof one.day !== "string") return false;
  if (typeof one.capability === "string") return finite(one.seconds);
  return typeof one.suite === "string" && finite(one.planned) &&
    finite(one.spent);
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
 * pairs a batch's two halves as it reads them, so what is stored is
 * already paired and this only sorts it.
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
      });
    }
  }
  return { setup, batches };
}

/**
 * Reads a run's records for what the lanes in it measured about
 * themselves.
 *
 * A batch is read only where both halves of its pair are present. One
 * without the other says nothing a fit can use, and a lane killed at its
 * bound part way through a batch leaves exactly that — the planned
 * figure is written beside the spent one, so a batch that never finished
 * contributes neither.
 *
 * The pair is keyed by the run and the measurement's name together,
 * because one lane runs a suite once but five lanes of one run may each
 * run the same suite, and adding two lanes' figures would describe a
 * batch neither of them ran.
 */
export function observationsOf(
  runs: Iterable<{ run: string; records: Iterable<TestRecord> }>,
): Observations {
  const setup = new Map<string, number[]>();
  const planned = new Map<string, number>();
  const spent = new Map<string, number>();
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
      // The suite and the coverage marker, not the name: the two halves
      // of a pair are named differently, and that is what tells them
      // apart. The marker is in the key so that a batch run with
      // coverage on pairs with its own planned figure rather than with
      // an uninstrumented batch's.
      const key = `${run}\t${batch.suite}\t${batch.measured}`;
      suiteOf.set(key, batch.suite);
      (batch.kind === "planned" ? planned : spent).set(key, seconds);
    }
  }
  const batches: BatchObservation[] = [];
  for (const [key, took] of spent) {
    const charged = planned.get(key);
    if (charged === undefined) continue;
    batches.push({ suite: suiteOf.get(key)!, planned: charged, spent: took });
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
    })),
  ];
}

/**
 * What the share of a batch that is not its tests comes to, as an
 * intercept and a slope.
 *
 * A slope is fitted from `MIN_CORRECTION_SAMPLES` observations that
 * disagree about how long the same planned work took. With fewer there
 * is no slope, and the whole difference goes into the intercept.
 *
 * The intercept is then raised until no observation is under-predicted,
 * whatever the slope came to. A least-squares line sits in the middle of
 * its observations by construction, which for this quantity means half
 * the lanes running past the budget they were packed against.
 */
export function fitSuite(
  observations: readonly BatchObservation[],
): { overhead: number; correction: number } {
  if (observations.length === 0) return { overhead: 0, correction: 1 };
  const distinct = new Set(observations.map((o) => o.planned));
  const charged = observations.map((o) => o.planned);
  const span = Math.max(...charged) - Math.min(...charged);
  let correction = 1;
  // A slope is read far outside the range it was fitted over: a suite
  // charged six seconds in every batch anybody has seen may be charged
  // thousands the first time a lane packs it whole. So one is fitted
  // only where the suite has been charged enough for a slope to mean
  // anything, and otherwise stays at the reading that needs no evidence.
  if (
    distinct.size > 1 && observations.length >= MIN_CORRECTION_SAMPLES &&
    span >= MIN_CORRECTION_SPAN_SECONDS
  ) {
    const n = observations.length;
    const meanX = observations.reduce((t, o) => t + o.planned, 0) / n;
    const meanY = observations.reduce((t, o) => t + o.spent, 0) / n;
    let top = 0;
    let bottom = 0;
    for (const o of observations) {
      top += (o.planned - meanX) * (o.spent - meanY);
      bottom += (o.planned - meanX) ** 2;
    }
    // Bounded below and not above. A batch runs its files in parallel,
    // so the wall time of one is routinely a fraction of the sum of its
    // tests' own durations: the pattern unit suite takes about a third.
    // A slope held at one would push that difference into the intercept,
    // which is charged whatever the batch holds, and a lane would then be
    // priced out of running the suite at all. Only a negative slope is
    // meaningless. Above one the intercept absorbs whatever a bound would
    // have moved, and the intercept is charged for one test of the suite
    // where the slope is charged in proportion, so bounding the slope
    // makes a suite dearer to reach rather than cheaper.
    if (bottom > 0) correction = Math.max(0, top / bottom);
  }
  const overhead = observations.reduce(
    (most, o) => Math.max(most, o.spent - correction * o.planned),
    0,
  );
  return { overhead, correction };
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
  return {
    setupCost,
    suites,
    // Nothing measures what one more file costs a batch that already
    // runs others: a lane times its batches and not the units inside
    // them. A suite's intercept carries it, which charges a batch of one
    // file what a batch of many was seen to cost. That is the direction
    // this errs in everywhere else.
    unitOverhead: {},
    prologue: LANE_PROLOGUE_SECONDS,
  };
}
