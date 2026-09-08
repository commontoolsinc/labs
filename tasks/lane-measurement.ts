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

/** Whether an identity is the lane measuring itself rather than a test. */
export function isLaneMeasurement(test: TestIdentity): boolean {
  return test.k === LANE_MEASUREMENT_SURFACE.kind &&
    test.s === LANE_MEASUREMENT_SURFACE.scope &&
    test.n.startsWith(LANE_MEASUREMENT_PREFIX);
}
