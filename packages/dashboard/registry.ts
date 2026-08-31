/**
 * Names every tile the wall runs, and is the only place any of them is
 * registered. A tile is added by importing it here and listing it below, and
 * removed by deleting its line.
 */

import type { Tile } from "./types.ts";

import { labsCi, loomCi } from "./tiles/main-build.ts";
import { labsCiTrust, loomCiTrust } from "./tiles/ci-trust.ts";
import { labsCiDuration, loomCiDuration } from "./tiles/ci-duration.ts";
import { prodUptime } from "./tiles/prod-uptime.ts";
import { commonToolsUp } from "./tiles/common-tools-up.ts";
import { prodErrors } from "./tiles/prod-errors.ts";
import { gcpSpend } from "./tiles/gcp-spend.ts";
import { githubCiSpend } from "./tiles/github-ci-spend.ts";
import { modelSpend } from "./tiles/model-spend.ts";
import { discordOnline } from "./tiles/discord-online.ts";
import { benchmark } from "./tiles/benchmark.ts";
import { dau } from "./tiles/dau.ts";
import { githubMembers } from "./tiles/github-members.ts";
import { recentRuns } from "./tiles/recent-runs.ts";
import { testFlakes } from "./tiles/test-flakes.ts";
import { testSelection } from "./tiles/test-selection.ts";

// Order controls placement: a normal tile takes the next slot in the grid, and
// a wide tile renders full-width below the grid, in this same order.
export const TILES: Tile[] = [
  // Row 1: labs CI family + benchmark
  labsCi,
  labsCiTrust,
  labsCiDuration,
  benchmark,
  // Row 2: loom CI family + github spend
  loomCi,
  loomCiTrust,
  loomCiDuration,
  githubCiSpend,
  // Row 3: production health
  commonToolsUp,
  prodUptime,
  prodErrors,
  dau,
  // Row 4: what the test suite is doing to itself
  testFlakes,
  testSelection,
  modelSpend,
  gcpSpend,
  // Row 5: the remaining spend and community tiles
  discordOnline,
  githubMembers,
  recentRuns, // wide — renders full-width below the grid
];
