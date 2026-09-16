import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  batchMeasurement,
  batchMeasurementName,
  isLaneMeasurement,
  LANE_MEASUREMENT_PREFIX,
  LANE_MEASUREMENT_SURFACE,
  setupMeasurement,
} from "./lane-measurement.ts";

describe("lane-measurement", () => {
  describe("batchMeasurementName()", () => {
    it("names what a lane spent on a batch", () => {
      expect(batchMeasurementName("workspace-unit", false))
        .toBe("ci-lane batch workspace-unit");
    });

    it("names what the packer charged for a batch", () => {
      expect(batchMeasurementName("workspace-unit", false, "planned"))
        .toBe("ci-lane planned batch workspace-unit");
    });

    it("names a batch run with coverage apart from one run without", () => {
      expect(batchMeasurementName("workspace-unit", true))
        .toBe("ci-lane batch workspace-unit with coverage");
    });
  });

  describe("batchMeasurement()", () => {
    it("returns the suite a spent measurement names", () => {
      expect(batchMeasurement("ci-lane batch workspace-unit")).toEqual({
        suite: "workspace-unit",
        measured: false,
        kind: "spent",
      });
    });

    it("returns the suite a planned measurement names", () => {
      expect(batchMeasurement("ci-lane planned batch workspace-unit")).toEqual({
        suite: "workspace-unit",
        measured: false,
        kind: "planned",
      });
    });

    it("returns every name `batchMeasurementName()` composes", () => {
      for (const measured of [false, true]) {
        for (const kind of ["spent", "planned"] as const) {
          const name = batchMeasurementName("runner-unit", measured, kind);
          expect(batchMeasurement(name))
            .toEqual({ suite: "runner-unit", measured, kind });
        }
      }
    });

    it("returns `undefined` for a batch measurement naming no suite", () => {
      expect(batchMeasurement(batchMeasurementName("", false)))
        .toBeUndefined();
      expect(batchMeasurement(batchMeasurementName("", true)))
        .toBeUndefined();
      expect(batchMeasurement(batchMeasurementName("", false, "planned")))
        .toBeUndefined();
    });

    it("returns `undefined` for a name that is not a batch measurement", () => {
      expect(batchMeasurement("ci-lane setup fuse")).toBeUndefined();
      expect(batchMeasurement("space > writes a fact")).toBeUndefined();
    });
  });

  describe("setupMeasurement()", () => {
    it("returns the capability a setup measurement names", () => {
      expect(setupMeasurement(`${LANE_MEASUREMENT_PREFIX}setup fuse`))
        .toBe("fuse");
    });

    it("returns `undefined` for a setup measurement naming no capability", () => {
      expect(setupMeasurement("ci-lane setup ")).toBeUndefined();
    });

    it("returns `undefined` for a name that is not a setup measurement", () => {
      expect(setupMeasurement("ci-lane batch workspace-unit")).toBeUndefined();
    });
  });

  describe("isLaneMeasurement()", () => {
    it("returns `true` for every name a lane writes about itself", () => {
      for (
        const name of [
          batchMeasurementName("runner-unit", false),
          batchMeasurementName("runner-unit", true, "planned"),
          `${LANE_MEASUREMENT_PREFIX}setup fuse`,
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
        n: batchMeasurementName("runner-unit", false),
      })).toBe(false);
    });
  });
});
