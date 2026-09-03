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
      "cubic-spend",
      "github-ci-spend",
      "model-spend",
      "gcp-spend",
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

    expect(views).toEqual(Array(1).fill({
      label: "YOUR METRIC HERE",
      status: "good",
      value: "–",
      sub: "no metric selected for this tile",
    }));
  });

  it("reports cubic spend as a named metric with no value", async () => {
    const cubic = TILES.find((tile) => tile.id === "cubic-spend");

    expect(await cubic?.collect(context)).toEqual({
      label: "cubic spend",
      status: "good",
      value: "—",
      sub: "api does not expose value",
    });
  });
});
