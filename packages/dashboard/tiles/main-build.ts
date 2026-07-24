// ci build: the last COMPLETED run on main drives the status (good/bad), or
// unknown before the first completed run is known. A newer in-flight run is a
// minor secondary facet. Drills through to the main commit history. One factory
// builds both the labs and loom instances against their own repo + workflow.
import { runSource, type Status, type Tile, type TileView } from "../types.ts";
import { escapeHtml, humanDur } from "../lib.ts";
import { CI_WORKFLOW, LOOM_CI_WORKFLOW, LOOM_REPO, REPO } from "../config.ts";

function makeBuildTile(opts: { id: string; label: string; repo: string; workflow: string }): Tile {
  const commitsUrl = `https://github.com/${opts.repo}/commits/main`;
  return {
    id: opts.id,
    intervalMs: 30_000,
    runSources: [runSource(opts.repo, opts.workflow)],
    async collect(ctx): Promise<TileView> {
      const runs = await ctx.runsFor(opts.repo, opts.workflow);
      const completed = runs.filter((r) => r.status === "completed" && r.conclusion);
      const lastDone = completed[0];
      const conclusion = lastDone?.conclusion ?? "";
      const s: Status = conclusion === "" ? "unknown" : conclusion === "success" ? "good" : "bad";

      let streak = "";
      if (lastDone) {
        const head = lastDone.conclusion;
        let flipAt = completed[completed.length - 1].run_started_at;
        for (const r of completed) {
          if (r.conclusion !== head) break;
          flipAt = r.run_started_at;
        }
        streak = `${head === "success" ? "green" : head} for ${humanDur(Date.now() - Date.parse(flipAt))}`;
      }

      const latest = runs[0];
      const running = latest && latest.status !== "completed"
        ? `<span class="running" title="${escapeHtml((latest.display_title ?? "").slice(0, 90))}"><span class="rdot"></span>next build running</span>`
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
