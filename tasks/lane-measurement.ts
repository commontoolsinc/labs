/**
 * The records a lane writes about itself, and how everything else knows
 * one when it sees it.
 *
 * A lane measures its own setup and its own batches through the record
 * machinery every test uses, so those measurements arrive as ordinary
 * records and travel the same path. They are not test surfaces: nothing
 * enumerates them, nothing scores them, and no lane can be asked to run
 * one. Every reader that asks the topology where a record belongs asks
 * this first.
 *
 * The surface and the name prefix a measurement is written from are here
 * beside the predicate that recognizes one, so the lane and its readers
 * name the same thing.
 */

import type { TestIdentity } from "@commonfabric/test-support/records";

/** The record surface the lane measures itself on. */
export const LANE_MEASUREMENT_SURFACE = { kind: "gate", scope: "ci" };

/** What the lane's own measurements are named for. */
export const LANE_MEASUREMENT_PREFIX = "ci-lane ";

/**
 * How a batch run with coverage on is named apart from one run without.
 *
 * Instrumenting a run costs it time, and how much is a property of the
 * suite rather than a constant. The two are separate measurements for
 * that reason: fitting one correction over both would charge every
 * unmeasured run part of what an instrumented one costs, and charge a
 * measured one less than it takes.
 */
export const MEASURED_BATCH_SUFFIX = " with coverage";

/** What a lane's measurement of one batch is called. */
export function batchMeasurementName(
  suite: string,
  measured: boolean,
): string {
  return `${LANE_MEASUREMENT_PREFIX}batch ${suite}` +
    (measured ? MEASURED_BATCH_SUFFIX : "");
}

/**
 * The suite one batch measurement names, and whether coverage was on for
 * it. Nothing else for the name: a reader that took it apart itself
 * would be a second answer to how it is composed, and the two would
 * part company the first time either moved.
 */
export function batchMeasurement(
  name: string,
): { suite: string; measured: boolean } | undefined {
  const prefix = `${LANE_MEASUREMENT_PREFIX}batch `;
  if (!name.startsWith(prefix)) return undefined;
  const rest = name.slice(prefix.length);
  const measured = rest.endsWith(MEASURED_BATCH_SUFFIX);
  const suite = measured ? rest.slice(0, -MEASURED_BATCH_SUFFIX.length) : rest;
  return suite.length === 0 ? undefined : { suite, measured };
}

/** Whether an identity is the lane measuring itself rather than a test. */
export function isLaneMeasurement(test: TestIdentity): boolean {
  return test.k === LANE_MEASUREMENT_SURFACE.kind &&
    test.s === LANE_MEASUREMENT_SURFACE.scope &&
    test.n.startsWith(LANE_MEASUREMENT_PREFIX);
}
