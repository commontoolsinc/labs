// ci build: the last completed attempt on main drives the status (good/bad), or
// unknown before the first completed attempt is known. A newer in-flight run is
// a minor secondary facet. Drills through to the main commit history. One factory
// builds both the labs and loom instances against their own repo + workflow.
import {
  runSource,
  type Run,
  type Status,
  type Tile,
  type TileView,
} from "../types.ts";
import { escapeHtml, github, humanDur } from "../lib.ts";
import { CI_WORKFLOW, LOOM_CI_WORKFLOW, LOOM_REPO, REPO } from "../config.ts";

function makeBuildTile(opts: { id: string; label: string; repo: string; workflow: string }): Tile {
  const commitsUrl = `https://github.com/${opts.repo}/commits/main`;
  const completedAttemptCache = new Map<number, Map<number, Run>>();

  function attemptsFor(run: Run): Map<number, Run> {
    let attempts = completedAttemptCache.get(run.id);
    if (!attempts) {
      attempts = new Map();
      completedAttemptCache.set(run.id, attempts);
    }
    return attempts;
  }

  async function completedAttempt(run: Run, attempt: number): Promise<Run> {
    const attempts = attemptsFor(run);
    const cached = attempts.get(attempt);
    if (cached) return cached;
    const completed = await github<Run>(
      `repos/${opts.repo}/actions/runs/${run.id}/attempts/${attempt}`,
    );
    if (
      completed.id !== run.id ||
      completed.run_attempt !== attempt ||
      completed.status !== "completed" ||
      !completed.conclusion
    ) {
      throw new Error(
        `GitHub run ${run.id} attempt ${attempt} did not include a completed conclusion`,
      );
    }
    attempts.set(attempt, completed);
    return completed;
  }

  async function completedHistory(runs: Run[]): Promise<Run[]> {
    const visibleRunIds = new Set(runs.map((run) => run.id));
    for (const runId of completedAttemptCache.keys()) {
      if (!visibleRunIds.has(runId)) completedAttemptCache.delete(runId);
    }
    for (const run of runs) {
      if (run.status === "completed" && run.conclusion) {
        attemptsFor(run).set(run.run_attempt, run);
      }
    }

    const completed: Run[] = [];
    let headConclusion: string | undefined;
    history:
    for (const run of runs) {
      let attempt = run.status === "completed" && run.conclusion
        ? run.run_attempt
        : run.run_attempt - 1;
      while (attempt >= 1) {
        let prior: Run;
        try {
          prior = await completedAttempt(run, attempt);
        } catch (error) {
          if (completed.length === 0) throw error;
          break history;
        }
        completed.push(prior);
        if (headConclusion === undefined) {
          headConclusion = prior.conclusion!;
        } else if (prior.conclusion !== headConclusion) {
          break history;
        }
        attempt--;
      }
    }
    return completed;
  }

  return {
    id: opts.id,
    intervalMs: 30_000,
    runSources: [runSource(opts.repo, opts.workflow)],
    async collect(ctx): Promise<TileView> {
      const runs = await ctx.runsFor(opts.repo, opts.workflow);
      const latest = runs[0];
      const completed = await completedHistory(runs);
      const lastDone = completed[0];
      const conclusion = lastDone?.conclusion ?? "";
      const s: Status = conclusion === "" ? "unknown" : conclusion === "success" ? "good" : "bad";

      let streak = "";
      if (lastDone) {
        const head = lastDone.conclusion;
        let flipAt = lastDone.run_started_at;
        for (const r of completed) {
          if (r.conclusion !== head) break;
          flipAt = r.run_started_at;
        }
        streak = `${head === "success" ? "green" : head} for ${humanDur(Date.now() - Date.parse(flipAt))}`;
      }

      const runningLabel = latest?.run_attempt > 1
        ? "build rerunning"
        : "next build running";
      const running = latest && latest.status !== "completed"
        ? `<span class="running" title="${escapeHtml((latest.display_title ?? "").slice(0, 90))}"><span class="rdot"></span>${runningLabel}</span>`
        : "";

      return {
        label: opts.label,
        status: s,
        value: s === "unknown" ? "—" : s === "good" ? "passing" : escapeHtml(conclusion),
        sub: streak || "no completed runs in window",
        href: commitsUrl,
        hint: "commits ↗",
        extra: running, // a build in flight — shown at the bottom, where there's room
      };
    },
  };
}

export const labsCi = makeBuildTile({ id: "labs-ci", label: "labs ci", repo: REPO, workflow: CI_WORKFLOW });
export const loomCi = makeBuildTile({ id: "loom-ci", label: "loom ci", repo: LOOM_REPO, workflow: LOOM_CI_WORKFLOW });
