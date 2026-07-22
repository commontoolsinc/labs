// ci trust: share of recent completed runs that passed on the first attempt (a
// flakiness signal), with a history strip for every run in the fetched window.
// One factory builds both the labs and loom instances against their own repo +
// workflow.
import type { Run, Status, Tile, TileView } from "../types.ts";
import { strip } from "../lib.ts";
import { CI_RUNS_MAX, CI_WORKFLOW, LOOM_CI_WORKFLOW, LOOM_REPO, REPO, TRUST_COLS, TRUST_GOOD, TRUST_WARN } from "../config.ts";

type TrustOutcome = "green" | "red" | "run" | "grey";

function trustOutcome(run: Run): TrustOutcome {
  if (run.status === "in_progress") return "run";
  if (run.status !== "completed" || !run.conclusion) return "grey";
  return run.conclusion === "success" && run.run_attempt === 1 ? "green" : "red";
}

function makeCiTrust(opts: { id: string; label: string; repo: string; workflow: string }): Tile {
  return {
    id: opts.id,
    intervalMs: 30_000,
    async collect(ctx): Promise<TileView> {
      const runs = await ctx.runsFor(opts.repo, opts.workflow);
      const scored = runs.slice(0, CI_RUNS_MAX).map((run) => ({
        run,
        outcome: trustOutcome(run),
      }));
      const counted = scored.filter(({ outcome }) => outcome === "green" || outcome === "red");
      const firstTryGreen = counted.filter(({ outcome }) => outcome === "green").length;
      const pct = counted.length ? (firstTryGreen / counted.length) * 100 : 0;
      const s: Status = counted.length === 0
        ? "unknown"
        : pct >= TRUST_GOOD ? "good" : pct >= TRUST_WARN ? "warn" : "bad";
      const runSummary = counted.length === scored.length
        ? `last ${scored.length} runs`
        : `${counted.length} counted of last ${scored.length} runs`;
      const cells = [...scored].reverse().map(({ run, outcome }) => ({
        outcome,
        href: run.html_url,
      }));
      return {
        label: opts.label,
        status: s,
        value: `${pct.toFixed(1)}%`,
        sub: `first-try green · ${runSummary}`,
        extra: strip(cells, TRUST_COLS),
      };
    },
  };
}

export const labsCiTrust = makeCiTrust({ id: "ci-trust", label: "labs ci trust", repo: REPO, workflow: CI_WORKFLOW });
export const loomCiTrust = makeCiTrust({ id: "loom-ci-trust", label: "loom ci trust", repo: LOOM_REPO, workflow: LOOM_CI_WORKFLOW });
