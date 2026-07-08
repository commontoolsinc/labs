// main build: the last COMPLETED run on main drives the status (good/bad), or
// unknown before the first completed run is known. A newer in-flight run is a
// minor secondary facet. Drills through to the main commit history.
import type { Status, Tile, TileView } from "../types.ts";
import { escapeHtml, humanDur } from "../lib.ts";
import { REPO } from "../config.ts";

const COMMITS_URL = `https://github.com/${REPO}/commits/main`;

export const mainBuild: Tile = {
  id: "main-build",
  intervalMs: 30_000,
  async collect(ctx): Promise<TileView> {
    const runs = await ctx.runs();
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
      label: "main build",
      status: s,
      value: s === "unknown" ? "—" : s === "good" ? "passing" : escapeHtml(conclusion),
      sub: streak || "no completed runs in window",
      href: COMMITS_URL,
      hint: "commits ↗",
      aside: running,
    };
  },
};
