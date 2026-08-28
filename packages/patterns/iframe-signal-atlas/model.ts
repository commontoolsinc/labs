import type { SignalBand, SignalObservation, SignalRoute } from "./contract.ts";

export type SignalBandFilter = SignalBand | "all";

export function visibleObservations(
  observations: readonly SignalObservation[],
  timeCursor: number,
  band: SignalBandFilter,
): SignalObservation[] {
  return observations.filter((observation) =>
    observation.observedAt <= timeCursor &&
    (band === "all" || observation.band === band)
  );
}

export function visibleRoutes(
  routes: readonly SignalRoute[],
  observationsById: ReadonlyMap<string, SignalObservation>,
  timeCursor: number,
  band: SignalBandFilter,
): SignalRoute[] {
  return routes.filter((route) =>
    route.departedAt <= timeCursor &&
    (band === "all" || route.band === band) &&
    observationsById.has(route.fromObservationId) &&
    observationsById.has(route.toObservationId)
  );
}

export function propagationValues(
  observations: readonly SignalObservation[],
  timeCursor: number,
  width: number,
  height: number,
): number[] {
  const values: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let field = 0;
      for (const observation of observations) {
        const dx = x - observation.x;
        const dy = y - observation.y;
        const distanceSquared = dx * dx + dy * dy;
        const age = Math.max(0, timeCursor - observation.observedAt);
        const ageFalloff = Math.exp(-age / 42);
        field += observation.strength * ageFalloff *
          Math.exp(-distanceSquared / 185);
      }
      values.push(Math.min(1, Math.max(0, field)));
    }
  }
  return values;
}

export function routePoints(
  from: readonly [number, number],
  to: readonly [number, number],
): [number, number][] {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const length = Math.hypot(dx, dy) || 1;
  const bend = Math.min(72, length * 0.25);
  const midpoint: [number, number] = [
    (from[0] + to[0]) / 2 - dy / length * bend,
    (from[1] + to[1]) / 2 + dx / length * bend,
  ];
  return [[...from], midpoint, [...to]];
}
