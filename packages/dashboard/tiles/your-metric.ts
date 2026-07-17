// your metric here: a deliberately empty slot for a metric someone hasn't wired
// up yet. It stays gray and carries an explicit "not a real metric" note so it
// can't be mistaken for a live number on the wall.
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
