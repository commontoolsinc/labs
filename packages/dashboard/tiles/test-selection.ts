/**
 * Reports what the newest selection manifest would have a pull request
 * run: what share of the corpus fits five lanes. It goes amber when the
 * manifest has gone stale, because selection quality decays with it, and
 * red when a lane's projected work is past the bound the whole design
 * rests on, which is the one condition the sub line gives up its share
 * for.
 *
 * The packing itself — every lane, what each holds, and what each is
 * projected to spend — is a page away.
 *
 * Following the dashboard's values (README.md): it reports on the system.
 */

import type { Status, Tile, TileView } from "../types.ts";
import { compactSpan, groupDigits } from "../lib.ts";
import {
  laneBudgetOf,
  MANIFEST_SHARE_MS,
  type ManifestReader,
  selectedCount,
  sharedManifest,
} from "../test-selection-manifest.ts";
import {
  TEST_SELECTION_PATH,
  testSelectionResponse,
} from "../test-selection-page.ts";

/** Hours before a manifest is stale enough to say so. */
export const MANIFEST_STALE_HOURS = 8;

/** Builds the tile against a reader and a clock, so a test can supply both. */
export function makeTestSelection(
  options: { read?: ManifestReader; now?: () => number } = {},
): Tile {
  const read = options.read ?? sharedManifest;
  return {
    id: "test-selection",
    intervalMs: MANIFEST_SHARE_MS,
    routes: [{
      path: TEST_SELECTION_PATH,
      handler: () => testSelectionResponse(read, options.now),
    }],
    collect: () => selectionView(read, options.now),
  };
}

async function selectionView(
  read: ManifestReader,
  clock?: () => number,
): Promise<TileView> {
  const manifest = await read();
  if (manifest === undefined) {
    return {
      label: "test selection",
      status: "unknown",
      value: "—",
      sub: "no selection manifest yet",
    };
  }
  const selected = selectedCount(manifest);
  const known = manifest.entries.length;
  const share = known === 0 ? 0 : (selected / known) * 100;
  const age = (clock?.() ?? Date.now()) - Date.parse(manifest.generatedAt);
  const ageHours = age / 3_600_000;
  const budget = laneBudgetOf(manifest.dials);
  const fullest = manifest.lanes.length === 0
    ? 0
    : Math.max(...manifest.lanes.map((lane) => lane.projectedSeconds));
  const over = fullest > budget;
  const stale = ageHours > MANIFEST_STALE_HOURS;
  const status: Status = over ? "bad" : stale ? "warn" : "good";
  const badge = `${compactSpan(age)} old`;
  return {
    label: "test selection",
    status,
    value: `${share.toFixed(0)}%`,
    // A lane past its budget is what the tile turned red for, so it takes
    // the line the corpus share otherwise holds.
    sub: over
      ? `fullest lane ${fullest.toFixed(0)}s of ${budget}s`
      : `${groupDigits(selected)} of ${groupDigits(known)} tests`,
    aside: stale
      ? `<span class="hmtd" title="${badge}">${badge}</span>`
      : undefined,
    href: TEST_SELECTION_PATH,
    hint: "lanes ↗",
  };
}

export const testSelection = makeTestSelection();
