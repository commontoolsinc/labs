import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  batchMeasurement,
  batchMeasurementName,
  LANE_MEASUREMENT_PREFIX,
  setupMeasurement,
} from "./lane-measurement.ts";

describe("lane-measurement", () => {
  describe("batchMeasurementName()", () => {
    it("names what a lane spent on a batch", () => {
      expect(batchMeasurementName("workspace-unit", false))
        .toBe("ci-lane batch workspace-unit");
    });

    it("names what a batch's own tests took", () => {
      expect(batchMeasurementName("workspace-unit", false, "ran"))
        .toBe("ci-lane ran batch workspace-unit");
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

    it("returns the suite a tests-took measurement names", () => {
      expect(batchMeasurement("ci-lane ran batch workspace-unit")).toEqual({
        suite: "workspace-unit",
        measured: false,
        kind: "ran",
      });
    });

    it("returns every name `batchMeasurementName()` composes", () => {
      for (const measured of [false, true]) {
        for (const kind of ["spent", "ran", "units"] as const) {
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
      expect(batchMeasurement(batchMeasurementName("", false, "ran")))
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
});
