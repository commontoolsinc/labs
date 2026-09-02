/**
 * Reports what the newest selection manifest would have a pull request
 * run: how much of the corpus fits five lanes, and how close the fullest
 * lane is to its budget. It goes amber when the manifest has gone stale,
 * because selection quality decays with it, and red when a lane's
 * projected work is past the bound the whole design rests on.
 *
 * Following the dashboard's values (README.md): it reports on the system.
 */

import type { Status, Tile, TileView } from "../types.ts";
import { newestManifest } from "../test-selection-manifest.ts";

/** Hours before a manifest is stale enough to say so. */
export const MANIFEST_STALE_HOURS = 8;

/**
 * Seconds of planned work a lane may hold, when the manifest does not say.
 * Every manifest records the dials it was built with, so the tile reads
 * the budget from the manifest in front of it rather than from a number
 * here that would quietly start lying the day the dial moved.
 */
export const LANE_BUDGET_FALLBACK_SECONDS = 230;

/** The budget a manifest was built with, or the fallback. */
export function laneBudgetOf(dials: Record<string, unknown>): number {
  const budget = dials.LANE_BUDGET_SECONDS;
  return typeof budget === "number" && Number.isFinite(budget) && budget > 0
    ? budget
    : LANE_BUDGET_FALLBACK_SECONDS;
}

/** Builds the tile against a store and a clock, so a test can supply both. */
export function makeTestSelection(
  options: { fetchImpl?: typeof fetch; now?: () => number } = {},
): Tile {
  return {
    id: "test-selection",
    intervalMs: 15 * 60_000,
    collect: () => selectionView(options),
  };
}

async function selectionView(
  options: { fetchImpl?: typeof fetch; now?: () => number },
): Promise<TileView> {
  {
    const manifest = await newestManifest(
      options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl },
    );
    if (manifest === undefined) {
      return {
        label: "test selection",
        status: "unknown",
        value: "—",
        sub: "no selection manifest yet",
      };
    }
    const selected = manifest.lanes.reduce(
      (total, lane) =>
        total +
        lane.batches.reduce((sum, batch) => sum + batch.identities.length, 0),
      0,
    );
    const known = manifest.entries.length;
    const share = known === 0 ? 0 : (selected / known) * 100;
    const now = options.now?.() ?? Date.now();
    const ageHours = (now - Date.parse(manifest.generatedAt)) / 3_600_000;
    const budget = laneBudgetOf(manifest.dials);
    const fullest = manifest.lanes.length === 0
      ? 0
      : Math.max(...manifest.lanes.map((lane) => lane.projectedSeconds));
    const status: Status = fullest > budget
      ? "bad"
      : ageHours > MANIFEST_STALE_HOURS
      ? "warn"
      : "good";
    return {
      label: "test selection",
      status,
      value: `${share.toFixed(0)}%`,
      sub: `${selected} of ${known} tests · fullest lane ` +
        `${fullest.toFixed(0)}s of ${budget}s`,
      aside: ageHours > MANIFEST_STALE_HOURS
        ? `${ageHours.toFixed(0)}h old`
        : undefined,
    };
  }
}

export const testSelection = makeTestSelection();
