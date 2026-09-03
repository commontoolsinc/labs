/** Verifies the dashboard's registered tile sequence and reserved slots. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { TILES } from "./registry.ts";
import type { Ctx } from "./types.ts";

const context: Ctx = {
  runs: () => Promise.resolve([]),
  runsFor: () => Promise.resolve([]),
  env: () => undefined,
};

describe("registry", () => {
  it("registers tiles in dashboard display order", () => {
    expect(TILES.map((tile) => tile.id)).toEqual([
      "labs-ci",
      "ci-trust",
      "ci-duration",
      "benchmark",
      "loom-ci",
      "loom-ci-trust",
      "loom-ci-duration",
      "loom-metric-placeholder",
      "test-flakes",
      "test-selection",
      "coverage-debt",
      "prod-errors",
      "dau",
      "discord-online",
      "github-members",
      "prod-uptime",
      "gcp-spend",
      "github-ci-spend",
      "model-spend",
      "spend-metric-placeholder",
      "recent-runs",
    ]);
  });

  it("returns the empty metric view for each reserved slot", async () => {
    const placeholders = TILES.filter((tile) =>
      tile.id.endsWith("metric-placeholder")
    );
    const views = await Promise.all(
      placeholders.map((tile) => tile.collect(context)),
    );

    expect(views).toEqual(Array(2).fill({
      label: "YOUR METRIC HERE",
      status: "good",
      value: "–",
      sub: "no metric selected for this tile",
    }));
  });
});
