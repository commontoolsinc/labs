// The shared collection context: memoized data sources handed to every tile so
// several tiles reading the same source (a repo's CI runs) trigger only one fetch.
import { github, memo } from "./lib.ts";
import { CI_RUNS_MAX, CI_RUNS_MAX_AGE_DAYS, CI_WORKFLOW, REPO } from "./config.ts";
import type { Ctx, Run } from "./types.ts";

// Up to CI_RUNS_MAX main-branch runs of one workflow, stopping early once runs
// pass the age cutoff — i.e. min(CI_RUNS_MAX, ~2 months). Each run is tagged with
// the repo it came from so a combined stream (recent-runs) can link each row to
// the right repo. Each tile slices this base to its own window.
async function fetchRuns(repo: string, workflow: string): Promise<Run[]> {
  const cutoff = Date.now() - CI_RUNS_MAX_AGE_DAYS * 86_400_000;
  const out: Run[] = [];
  const pages = Math.ceil(CI_RUNS_MAX / 100);
  for (let page = 1; page <= pages; page++) {
    const r = await github<{ workflow_runs: Run[] }>(
      `repos/${repo}/actions/workflows/${workflow}/runs?branch=main&per_page=100&page=${page}`,
    );
    const batch = r.workflow_runs ?? [];
    if (!batch.length) break;
    for (const run of batch) {
      const t = Date.parse(run.run_started_at);
      if (Number.isFinite(t) && t < cutoff) return out; // newest-first, so the rest are older too
      run.repo = repo;
      out.push(run);
      if (out.length >= CI_RUNS_MAX) return out;
    }
  }
  return out;
}

export function makeCtx(): Ctx {
  // One memoized fetcher per (repo, workflow), created on first use and shared for
  // ~20s across every tile that reads it.
  const fetchers = new Map<string, () => Promise<Run[]>>();
  const runsFor = (repo: string, workflow: string): Promise<Run[]> => {
    const key = `${repo} ${workflow}`;
    let f = fetchers.get(key);
    if (!f) {
      f = memo(20_000, () => fetchRuns(repo, workflow));
      fetchers.set(key, f);
    }
    return f();
  };
  return {
    runs: () => runsFor(REPO, CI_WORKFLOW),
    runsFor,
    env: (k) => Deno.env.get(k),
  };
}
