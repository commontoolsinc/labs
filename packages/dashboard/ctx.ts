// The shared collection context: memoized data sources handed to every tile so
// several tiles reading the same source (the CI runs) trigger only one fetch.
import { github, memo } from "./lib.ts";
import { CI_RUNS_MAX, CI_RUNS_MAX_AGE_DAYS, CI_WORKFLOW, REPO } from "./config.ts";
import type { Ctx, Run } from "./types.ts";

export function makeCtx(): Ctx {
  // One GitHub fetch shared by every CI tile for ~20s: up to CI_RUNS_MAX runs,
  // stopping early once runs pass the age cutoff — i.e. min(400, 2 months). Each
  // tile slices this base to its own window.
  const runs = memo(20_000, async () => {
    const cutoff = Date.now() - CI_RUNS_MAX_AGE_DAYS * 86_400_000;
    const out: Run[] = [];
    const pages = Math.ceil(CI_RUNS_MAX / 100);
    for (let page = 1; page <= pages; page++) {
      const r = await github<{ workflow_runs: Run[] }>(
        `repos/${REPO}/actions/workflows/${CI_WORKFLOW}/runs?branch=main&per_page=100&page=${page}`,
      );
      const batch = r.workflow_runs ?? [];
      if (!batch.length) break;
      for (const run of batch) {
        const t = Date.parse(run.run_started_at);
        if (Number.isFinite(t) && t < cutoff) return out; // newest-first, so the rest are older too
        out.push(run);
        if (out.length >= CI_RUNS_MAX) return out;
      }
    }
    return out;
  });
  return { runs, env: (k) => Deno.env.get(k) };
}
