/**
 * Builds the shared collection context handed to every tile. Its data sources
 * are memoized, so several tiles reading the same source — one repository's CI
 * runs, say — trigger only one fetch between them.
 */

import { github, memo } from "./lib.ts";
import {
  CI_RUNS_MAX,
  CI_RUNS_MAX_AGE_DAYS,
  CI_WORKFLOW,
  REPO,
} from "./config.ts";
import type { Ctx, Run } from "./types.ts";

// Up to CI_RUNS_MAX main-branch runs of one workflow, stopping early once runs
// pass the age cutoff — i.e. min(CI_RUNS_MAX, ~2 months). Each run is tagged with
// the repo it came from so a combined stream (recent-runs) can link each row to
// the right repo. Each tile slices this base to its own window.
// GitHub sends around 18 KB for each run: the repository, the head repository,
// the whole head commit, and both actors ride along with every entry. The
// fields below are around 350 bytes of it, and the snapshot is held between
// collections, so each run is narrowed to them as it arrives.
function tileRun(run: Run, repo: string): Run {
  return {
    repo,
    id: run.id,
    status: run.status,
    conclusion: run.conclusion,
    run_attempt: run.run_attempt,
    event: run.event,
    head_sha: run.head_sha,
    display_title: run.display_title,
    created_at: run.created_at,
    run_started_at: run.run_started_at,
    updated_at: run.updated_at,
    html_url: run.html_url,
    head_commit: run.head_commit && { message: run.head_commit.message },
  };
}

async function fetchRuns(repo: string, workflow: string): Promise<Run[]> {
  const cutoff = Date.now() - CI_RUNS_MAX_AGE_DAYS * 86_400_000;
  const collected = new Map<number, Run>();
  const pages = Math.ceil(CI_RUNS_MAX / 100);
  let previousPageOldest: Run | undefined;
  walk:
  for (let page = 1; page <= pages; page++) {
    const r = await github<{ workflow_runs: Run[] }>(
      `repos/${repo}/actions/workflows/${workflow}/runs?branch=main&per_page=100&page=${page}`,
    );
    const batch = r.workflow_runs ?? [];
    if (!batch.length) break;
    // Each page is the slice of one list that carries on from the page before
    // it. A page that opens on a run newer than the one the previous page ended
    // on, and that the previous page did not carry, was cut from a different
    // moment: joining the two leaves a hole in the window and can put a run from
    // weeks back at the head, where every tile reads the state of the tree.
    const first = batch[0];
    if (
      previousPageOldest && !collected.has(first.id) &&
      Date.parse(first.created_at) >
        Date.parse(previousPageOldest.created_at)
    ) {
      throw new Error(
        `GitHub ${repo} ${workflow} runs page ${page} opens at ${first.created_at}, ` +
          `after page ${page - 1} ended at ${previousPageOldest.created_at}`,
      );
    }
    previousPageOldest = batch[batch.length - 1];
    for (const run of batch) {
      const t = Date.parse(run.run_started_at);
      if (Number.isFinite(t) && t < cutoff) break walk; // newest-first, so the rest are older too
      collected.set(run.id, tileRun(run, repo));
      if (collected.size >= CI_RUNS_MAX) break walk;
    }
  }
  // The walk decides which runs are in the window; the sort decides their order,
  // so a page served out of turn cannot leave an old run at the head.
  return [...collected.values()].sort((a, b) =>
    Date.parse(b.created_at) - Date.parse(a.created_at)
  );
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
