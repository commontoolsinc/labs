import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { SignalObservation, SignalRoute } from "./contract.ts";
import {
  propagationValues,
  routePoints,
  visibleObservations,
  visibleRoutes,
} from "./model.ts";

const observations: SignalObservation[] = [
  {
    id: "early-pulse",
    label: "Early pulse",
    x: 0,
    y: 0,
    observedAt: 10,
    strength: 0.8,
    band: "pulse",
  },
  {
    id: "boundary-drift",
    label: "Boundary drift",
    x: 10,
    y: 0,
    observedAt: 20,
    strength: 0.6,
    band: "drift",
  },
  {
    id: "future-pulse",
    label: "Future pulse",
    x: 20,
    y: 0,
    observedAt: 21,
    strength: 0.7,
    band: "pulse",
  },
];

describe("model", () => {
  describe("visibleObservations()", () => {
    it("includes the temporal boundary and applies the selected band", () => {
      expect(visibleObservations(observations, 20, "all").map(({ id }) => id))
        .toEqual(["early-pulse", "boundary-drift"]);
      expect(visibleObservations(observations, 20, "pulse").map(({ id }) => id))
        .toEqual(["early-pulse"]);
    });
  });

  describe("visibleRoutes()", () => {
    it("requires an arrived route, the selected band, and both visible endpoints", () => {
      const routes: SignalRoute[] = [
        {
          id: "visible",
          fromObservationId: "early-pulse",
          toObservationId: "boundary-drift",
          departedAt: 20,
          duration: 10,
          band: "pulse",
        },
        {
          id: "future",
          fromObservationId: "early-pulse",
          toObservationId: "boundary-drift",
          departedAt: 21,
          duration: 10,
          band: "pulse",
        },
        {
          id: "hidden-endpoint",
          fromObservationId: "early-pulse",
          toObservationId: "future-pulse",
          departedAt: 15,
          duration: 10,
          band: "pulse",
        },
        {
          id: "wrong-band",
          fromObservationId: "early-pulse",
          toObservationId: "boundary-drift",
          departedAt: 15,
          duration: 10,
          band: "drift",
        },
      ];
      const visible = observations.slice(0, 2);
      const visibleById = new Map(visible.map((item) => [item.id, item]));

      expect(
        visibleRoutes(routes, visibleById, 20, "pulse").map(({ id }) => id),
      ).toEqual(["visible"]);
    });
  });

  describe("propagationValues()", () => {
    it("decays signal strength across time and distance", () => {
      const signal: SignalObservation = {
        ...observations[0],
        strength: 1,
        observedAt: 0,
      };

      expect(propagationValues([signal], 0, 2, 1)[0]).toBe(1);
      expect(propagationValues([signal], 42, 1, 1)[0]).toBeCloseTo(
        Math.exp(-1),
      );
      expect(propagationValues([signal], 0, 2, 1)[1]).toBeCloseTo(
        Math.exp(-1 / 185),
      );
    });

    it("clamps overlapping signals to the field maximum", () => {
      expect(propagationValues([observations[0], observations[0]], 10, 1, 1))
        .toEqual([1]);
    });
  });

  describe("routePoints()", () => {
    it("bows a route perpendicular to its span", () => {
      expect(routePoints([0, 0], [100, 0])).toEqual([
        [0, 0],
        [50, 25],
        [100, 0],
      ]);
    });

    it("caps the bend of a long route", () => {
      expect(routePoints([0, 0], [400, 0])[1]).toEqual([200, 72]);
    });
  });
});
