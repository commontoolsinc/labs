// The single registration point. Add a tile by importing it and adding it to
// this array; remove one by deleting its line. Order controls placement (grid
// order for normal tiles; wide tiles render full-width below the grid, in order).
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
import { yourMetric } from "./tiles/your-metric.ts";
import { recentRuns } from "./tiles/recent-runs.ts";

export const TILES: Tile[] = [
  // Row 1: labs CI family + benchmark
  labsCi,
  labsCiTrust,
  labsCiDuration,
  benchmark,
  // Row 2: loom CI family + ci spend
  loomCi,
  loomCiTrust,
  loomCiDuration,
  githubCiSpend,
  // Row 3: production health
  commonToolsUp,
  prodUptime,
  prodErrors,
  dau,
  // Row 4: the remaining spend tiles + product/placeholder
  modelSpend,
  gcpSpend,
  discordOnline,
  yourMetric,
  recentRuns, // wide — renders full-width below the grid
];
