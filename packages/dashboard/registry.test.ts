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
      "key-benchmarks",
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

  it("names both benchmark tiles when credentials are unavailable", async () => {
    for (const [id, label, href] of [
      ["benchmark", "all benchmarks", "/bench?view=runtime&repo=labs"],
      ["key-benchmarks", "key benchmarks", "/bench?view=runtime&repo=labs&key=1"],
    ]) {
      const tile = TILES.find((tile) => tile.id === id);
      expect(await tile?.collect(context)).toMatchObject({
        label,
        status: "unknown",
        value: "—",
        sub: "set GH_TOKEN",
        href,
      });
    }
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
