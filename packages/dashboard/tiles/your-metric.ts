// your metric here: a static gray placeholder for a metric that has not been
// wired up yet.
import type { Tile, TileView } from "../types.ts";

export const yourMetric: Tile = {
  id: "your-metric",
  intervalMs: 3_600_000,
  collect(): Promise<TileView> {
    return Promise.resolve({
      label: "your metric here",
      status: "unknown",
      value: "42",
      sub: "life, the universe, and everything",
    });
  },
};
