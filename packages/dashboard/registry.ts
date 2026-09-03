/**
 * Names every tile the wall runs, and is the only place any of them is
 * registered. A tile is added by importing it here and listing it below, and
 * removed by deleting its line.
 */

import type { Tile } from "./types.ts";

import { benchmark } from "./tiles/benchmark.ts";
import { labsCiDuration, loomCiDuration } from "./tiles/ci-duration.ts";
import { labsCiTrust, loomCiTrust } from "./tiles/ci-trust.ts";
import { coverageDebt } from "./tiles/coverage-debt.ts";
import { cubicSpend } from "./tiles/cubic-spend.ts";
import { dau } from "./tiles/dau.ts";
import { discordOnline } from "./tiles/discord-online.ts";
import { gcpSpend } from "./tiles/gcp-spend.ts";
import { githubCiSpend } from "./tiles/github-ci-spend.ts";
import { githubMembers } from "./tiles/github-members.ts";
import { labsCi, loomCi } from "./tiles/main-build.ts";
import { makeMetricPlaceholder } from "./tiles/metric-placeholder.ts";
import { modelSpend } from "./tiles/model-spend.ts";
import { prodErrors } from "./tiles/prod-errors.ts";
import { prodUptime } from "./tiles/prod-uptime.ts";
import { recentRuns } from "./tiles/recent-runs.ts";
import { testFlakes } from "./tiles/test-flakes.ts";
import { testSelection } from "./tiles/test-selection.ts";

/** Tiles in grid order, followed by full-width tiles in display order. */
export const TILES: Tile[] = [
  labsCi,
  labsCiTrust,
  labsCiDuration,
  benchmark,

  loomCi,
  loomCiTrust,
  loomCiDuration,
  makeMetricPlaceholder("loom-metric-placeholder"),

  testFlakes,
  testSelection,
  coverageDebt,
  prodErrors,

  dau,
  discordOnline,
  githubMembers,
  prodUptime,

  cubicSpend,
  githubCiSpend,
  modelSpend,
  gcpSpend,

  recentRuns,
];
