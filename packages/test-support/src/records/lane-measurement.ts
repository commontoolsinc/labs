/**
 * How a reader knows the lane measuring itself from a test.
 *
 * A lane measures its own setup and its own batches through the record
 * machinery every test uses, so those measurements arrive as ordinary
 * records and travel the same path. They are not test surfaces: nothing
 * enumerates them, nothing scores them, and no lane can be asked to run
 * one. Every reader that asks where a record belongs asks this first,
 * and it is here beside the record schema so that a reader outside the
 * lane's own package can.
 *
 * `tasks/lane-measurement.ts` composes the names this recognizes.
 */

import type { TestIdentity } from "./schema.ts";

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
