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
 * opened and two per batch: what it spent, and what the packer charged
 * it. The second is what makes a fit possible at all — the packer's
 * figure cannot be recovered from the records a batch produced, because
 * those records say what the tests took and not what the packer thought
 * they would.
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
import { LANE_PROLOGUE_SECONDS } from "./policy.ts";

/** One thing a lane measured about itself, and the day it measured it. */
export type LaneObservation =
  | { day: string; capability: string; seconds: number }
  | { day: string; suite: string; planned: number; spent: number };

/** One batch, as a lane measured it. */
export interface BatchObservation {
  suite: string;

  /** Seconds the packer charged the lane for this batch. */
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
  kept: Iterable<
    | { capability: string; seconds: number }
    | { suite: string; planned: number; spent: number }
  >,
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
      // apart. Whether coverage was on stays in the key, because a batch
      // run with coverage on is a different measurement of the same
      // suite and the two are fitted apart.
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
 * The value at `share` of the way up a set, which is what a figure that
 * must not under-estimate reads. The ninetieth rather than the largest,
 * because one unlucky runner should not set a cost for good; and not the
 * middle, because half the lanes would then be over their budget.
 */
export function percentile(values: readonly number[], share: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const at = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(share * sorted.length) - 1),
  );
  return sorted[at]!;
}

/**
 * What the share of a batch that is not its tests comes to, as an
 * intercept and a slope.
 *
 * Two observations that disagree about how long the same planned work
 * took give a slope; anything less gives none, and the whole difference
 * goes into the intercept. That is the conservative reading and the
 * honest one: with one sample there is nothing to say about how the cost
 * grows, and an intercept that carries the whole of it charges a lane
 * for what a lane was seen to spend.
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
  let correction = 1;
  if (distinct.size > 1) {
    const n = observations.length;
    const meanX = observations.reduce((t, o) => t + o.planned, 0) / n;
    const meanY = observations.reduce((t, o) => t + o.spent, 0) / n;
    let top = 0;
    let bottom = 0;
    for (const o of observations) {
      top += (o.planned - meanX) * (o.spent - meanY);
      bottom += (o.planned - meanX) ** 2;
    }
    // A slope below one would say a batch runs faster than the tests in
    // it, which is not a thing that happens and is what a set of
    // observations dominated by their intercept fits to.
    if (bottom > 0) correction = Math.max(1, top / bottom);
  }
  const overhead = observations.reduce(
    (most, o) => Math.max(most, o.spent - correction * o.planned),
    0,
  );
  return { overhead, correction };
}

/** What a lane pays beyond its tests, fitted from what lanes have spent. */
export function calibrate(
  observations: Observations,
  prologue: number = LANE_PROLOGUE_SECONDS,
): Calibration {
  const setupCost: Record<string, number> = {};
  for (const [capability, seconds] of observations.setup) {
    setupCost[capability] = percentile(seconds, 0.9);
  }
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
    prologue,
  };
}
