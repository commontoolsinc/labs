import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  isLaneMeasurement,
  LANE_MEASUREMENT_PREFIX,
  LANE_MEASUREMENT_SURFACE,
} from "./lane-measurement.ts";

describe("lane-measurement", () => {
  describe("isLaneMeasurement()", () => {
    it("returns `true` for every name a lane writes about itself", () => {
      // Spelled out rather than composed, so that what a reader recognizes
      // is pinned against the names themselves. `tasks/lane-measurement.ts`
      // composes them, and its own test holds it to these.

      for (
        const name of [
          "ci-lane batch runner-unit",
          "ci-lane batch workspace-unit with coverage",
          "ci-lane planned batch runner-unit",
          "ci-lane setup fuse",
        ]
      ) {
        expect(isLaneMeasurement({
          k: LANE_MEASUREMENT_SURFACE.kind,
          s: LANE_MEASUREMENT_SURFACE.scope,
          n: name,
        })).toBe(true);
      }
    });

    it("returns `false` for a test on the same surface", () => {
      expect(isLaneMeasurement({
        k: LANE_MEASUREMENT_SURFACE.kind,
        s: LANE_MEASUREMENT_SURFACE.scope,
        n: "repo gates > deno fmt",
      })).toBe(false);
    });

    it("returns `false` for the same name on another surface", () => {
      expect(isLaneMeasurement({
        k: "unit",
        s: "memory",
        n: `${LANE_MEASUREMENT_PREFIX}batch runner-unit`,
      })).toBe(false);
    });
  });
});
