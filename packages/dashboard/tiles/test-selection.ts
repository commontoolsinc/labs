/**
 * Reports what the newest selection manifest would have a pull request
 * run: what share of the corpus fits five lanes.
 *
 * It goes amber on either of two counts. The manifest has gone stale, and
 * selection quality decays with it. Or the corpus holds a test that costs
 * more on its own than a whole lane's budget, which no packing can place,
 * so a pull request runs it only where its own diff makes it mandatory.
 * It goes red when a lane's projected work is past the bound the whole
 * design rests on.
 *
 * Two of those three want the sub line, and the red one takes it first.
 * Staleness wants the header facet instead, so it competes for neither.
 *
 * The packing itself — every lane, what each holds, and what each is
 * projected to spend — is a page away, along with every test no lane can
 * hold and what each was measured at.
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
  const unplaceable = manifest.unschedulable.length;
  const stale = ageHours > MANIFEST_STALE_HOURS;
  const status: Status = over
    ? "bad"
    : unplaceable > 0 || stale
    ? "warn"
    : "good";
  const badge = `${compactSpan(age)} old`;
  return {
    label: "test selection",
    status,
    value: `${share.toFixed(0)}%`,
    // The condition the tile is colored for takes this line, worst
    // first, and the corpus count holds it while neither has.
    sub: over
      ? `fullest lane ${fullest.toFixed(0)}s of ${budget}s`
      : unplaceable > 0
      ? `${groupDigits(unplaceable)} test${
        unplaceable === 1 ? "" : "s"
      } too long for any lane`
      : `${groupDigits(selected)} of ${groupDigits(known)} tests`,
    aside: stale
      ? `<span class="hfacet" title="${badge}">${badge}</span>`
      : undefined,
    href: TEST_SELECTION_PATH,
    hint: "lanes ↗",
  };
}

export const testSelection = makeTestSelection();
