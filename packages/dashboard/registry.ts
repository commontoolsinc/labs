// The single registration point. Add a tile by importing it and adding it to
// this array; remove one by deleting its line. Order controls placement (grid
// order for normal tiles; wide tiles render full-width below the grid, in order).
import type { Tile } from "./types.ts";

import { mainBuild } from "./tiles/main-build.ts";
import { ciTrust } from "./tiles/ci-trust.ts";
import { ciDuration } from "./tiles/ci-duration.ts";
import { prodUptime } from "./tiles/prod-uptime.ts";
import { commonToolsUp } from "./tiles/common-tools-up.ts";
import { prodErrors } from "./tiles/prod-errors.ts";
import { gcpSpend } from "./tiles/gcp-spend.ts";
import { githubCiSpend } from "./tiles/github-ci-spend.ts";
import { modelSpend } from "./tiles/model-spend.ts";
import { discordOnline } from "./tiles/discord-online.ts";
import { benchmark } from "./tiles/benchmark.ts";
import { recentRuns } from "./tiles/recent-runs.ts";

export const TILES: Tile[] = [
  mainBuild,
  prodUptime,
  commonToolsUp,
  ciTrust,
  ciDuration,
  benchmark,
  prodErrors,
  gcpSpend,
  githubCiSpend,
  modelSpend,
  discordOnline,
  recentRuns, // wide — renders full-width below the grid
];
