/**
 * Reports how many tests are too noisy to judge a change by: the ones the
 * publisher measured disagreeing with themselves often enough to be held
 * back from pull requests. A flake list derived from measurement rather
 * than from anybody's judgement at one moment, which is what makes it
 * reverse on its own the moment a test is fixed.
 *
 * The count is the whole of the tile, and the line under it says what the
 * count was drawn from: how much history the publisher measured over, and
 * how long ago it measured. Which tests they are, and what each was
 * measured at, is a page away.
 *
 * Following the dashboard's values (README.md): it reports on the system.
 * Neither the count nor the page behind it is aggregated per person, and
 * that page names tests, never the people who wrote or touched them.
 */

import type { Status, Tile, TileView } from "../types.ts";
import { compactSpan, groupDigits } from "../lib.ts";
import {
  FLAKE_WINDOW_FALLBACK_DAYS,
  flakyCount,
  MANIFEST_SHARE_MS,
  type ManifestReader,
  numberDial,
  sharedManifest,
} from "../test-selection-manifest.ts";
import {
  FLAKY_SECTION_ID,
  TEST_SELECTION_PATH,
} from "../test-selection-page.ts";

/** How many flaky tests turn the wall amber. */
export const FLAKES_WARN = 1;

/** How many turn it red. */
export const FLAKES_BAD = 10;

/** Builds the tile against a reader and a clock, so a test can supply both. */
export function makeTestFlakes(
  options: { read?: ManifestReader; now?: () => number } = {},
): Tile {
  const read = options.read ?? sharedManifest;
  return {
    id: "test-flakes",
    intervalMs: MANIFEST_SHARE_MS,
    collect: () => flakesView(read, options.now),
  };
}

async function flakesView(
  read: ManifestReader,
  clock?: () => number,
): Promise<TileView> {
  const manifest = await read();
  if (manifest === undefined) {
    return {
      label: "flaky tests",
      status: "unknown",
      value: "—",
      sub: "no selection manifest yet",
    };
  }
  const held = flakyCount(manifest);
  const status: Status = held >= FLAKES_BAD
    ? "bad"
    : held >= FLAKES_WARN
    ? "warn"
    : "good";
  // The headline names what it counts, so the figure still means
  // something to somebody who read it before the label above it.
  const headline = held === 0
    ? "no flaky tests"
    : `${groupDigits(held)} flaky test${held === 1 ? "" : "s"}`;
  const days = numberDial(
    manifest.dials,
    "FLAKE_WINDOW_DAYS",
    FLAKE_WINDOW_FALLBACK_DAYS,
  );
  const age = compactSpan(
    (clock?.() ?? Date.now()) - Date.parse(manifest.generatedAt),
  );
  return {
    label: "flaky tests",
    status,
    value: headline,
    valueLabel: headline,
    // What the count was drawn from: the span of history a flake share is
    // measured over, and how long ago the publisher measured it.
    sub: `${days} days of runs · ${age} old`,
    href: `${TEST_SELECTION_PATH}#${FLAKY_SECTION_ID}`,
    hint: "flakes ↗",
  };
}

export const testFlakes = makeTestFlakes();
