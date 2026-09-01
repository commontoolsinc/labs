/**
 * Reports how many tests are too noisy to judge a change by: the ones the
 * publisher measured disagreeing with themselves often enough to be held
 * back from pull requests. A flake list derived from measurement rather
 * than from anybody's judgement at one moment, which is what makes it
 * reverse on its own the moment a test is fixed.
 *
 * Following the dashboard's values (README.md): it reports on the system.
 * It names tests, never the people who wrote or touched them, and nothing
 * about it is aggregated per person.
 */

import type { Status, Tile, TileView } from "../types.ts";
import { escapeHtml } from "../lib.ts";
import { newestManifest } from "../test-selection-manifest.ts";

/** How many flaky tests turn the wall amber. */
export const FLAKES_WARN = 1;

/** How many turn it red. */
export const FLAKES_BAD = 10;

/** How many of the worst are named under the count. */
const NAMED = 4;

/** The scope and name of an identity, short enough for a tile line. */
function shortName(test: { s: string; n: string; v?: string }): string {
  const name = test.n.length > 52 ? `${test.n.slice(0, 51)}…` : test.n;
  const variant = test.v === undefined ? "" : ` (${test.v})`;
  return `${test.s}: ${name}${variant}`;
}

/** Builds the tile against a store, so a test can supply its own. */
export function makeTestFlakes(
  options: { fetchImpl?: typeof fetch } = {},
): Tile {
  return {
    id: "test-flakes",
    intervalMs: 15 * 60_000,
    collect: () => flakesView(options),
  };
}

async function flakesView(
  options: { fetchImpl?: typeof fetch },
): Promise<TileView> {
  {
    const manifest = await newestManifest(
      options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl },
    );
    if (manifest === undefined) {
      return {
        label: "flaky tests",
        status: "unknown",
        value: "—",
        sub: "no selection manifest yet",
      };
    }
    const flaky = manifest.entries
      .filter((entry) => entry.flakeRate > 0)
      .sort((a, b) => b.flakeRate - a.flakeRate);
    const held = manifest.withheld.filter((entry) => entry.reason === "flaky");
    const status: Status = held.length >= FLAKES_BAD
      ? "bad"
      : held.length >= FLAKES_WARN
      ? "warn"
      : "good";
    const named = flaky.slice(0, NAMED);
    const listAttributes = named.length > 2
      ? ` aria-label="Flaky test details; scroll for more" title="Scroll for more details"`
      : ` aria-label="Flaky test details"`;
    const worst = named.length === 0
      ? ""
      : `<div class="tile-detail-list" role="region" tabindex="0"${listAttributes}>${
        named.map((entry) => {
          const line = `${(entry.flakeRate * 100).toFixed(1)}% · ${
            shortName(entry.test)
          }`;
          return `<div title="${escapeHtml(line)}">${escapeHtml(line)}</div>`;
        }).join("")
      }</div>`;
    return {
      label: "flaky tests",
      status,
      value: `${held.length}`,
      sub: held.length === 1
        ? "too noisy to judge a change by · 1 test"
        : `too noisy to judge a change by · ${held.length} tests`,
      extra: worst,
    };
  }
}

export const testFlakes = makeTestFlakes();
