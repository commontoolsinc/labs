// ci trust: share of recent completed runs that passed on the first attempt (a
// flakiness signal), with a per-run pass/fail history strip. One factory builds
// both the labs and loom instances against their own repo + workflow.
import type { Status, Tile, TileView } from "../types.ts";
import { concDot, strip } from "../lib.ts";
import { CI_WORKFLOW, LOOM_CI_WORKFLOW, LOOM_REPO, REPO, TRUST_COLS, TRUST_GOOD, TRUST_STRIP, TRUST_WARN } from "../config.ts";

function makeCiTrust(opts: { id: string; label: string; repo: string; workflow: string }): Tile {
  return {
    id: opts.id,
    intervalMs: 30_000,
    async collect(ctx): Promise<TileView> {
      const runs = await ctx.runsFor(opts.repo, opts.workflow);
      const completed = runs.filter((r) => r.status === "completed" && r.conclusion);
      const firstTryGreen = completed.filter((r) => r.conclusion === "success" && r.run_attempt === 1).length;
      const pct = completed.length ? (firstTryGreen / completed.length) * 100 : 0;
      const s: Status = completed.length === 0
        ? "unknown"
        : pct >= TRUST_GOOD ? "good" : pct >= TRUST_WARN ? "warn" : "bad";
      // Round the cell count down to a whole number of rows so the grid is always
      // complete; only show a single short row when that's all the data there is.
      const cap = Math.min(TRUST_STRIP, completed.length);
      const n = cap < TRUST_COLS ? cap : Math.floor(cap / TRUST_COLS) * TRUST_COLS;
      const cells = [...completed].reverse().slice(-n).map((r) => ({
        outcome: concDot(r.conclusion, r.run_attempt),
        href: r.html_url,
      }));
      return {
        label: opts.label,
        status: s,
        value: `${pct.toFixed(1)}%`,
        sub: `first-try green · last ${completed.length} runs`,
        extra: strip(cells, TRUST_COLS),
      };
    },
  };
}

export const labsCiTrust = makeCiTrust({ id: "ci-trust", label: "labs ci trust", repo: REPO, workflow: CI_WORKFLOW });
export const loomCiTrust = makeCiTrust({ id: "loom-ci-trust", label: "loom ci trust", repo: LOOM_REPO, workflow: LOOM_CI_WORKFLOW });
