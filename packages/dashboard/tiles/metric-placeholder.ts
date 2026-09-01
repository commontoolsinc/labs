import type { Tile } from "../types.ts";

/** Builds a green slot for a dashboard metric that has not been selected. */
export function makeMetricPlaceholder(id: string): Tile {
  return {
    id,
    intervalMs: 24 * 60 * 60_000,
    // This static tile implements the asynchronous collector contract.
    // deno-lint-ignore require-await
    collect: async () => ({
      label: "YOUR METRIC HERE",
      status: "good",
      value: "–",
      sub: "no metric selected for this tile",
    }),
  };
}
