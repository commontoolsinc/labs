// recent main runs: every run in the window (newest first, including in-progress
// ones), each row linking to the PR that landed the commit. Full-width. The
// tile's aggregate status is bad if the latest completed run failed, concerning
// if a failure sits within the recent window but the tip recovered, else good.
import type { Status, Tile, TileView } from "../types.ts";
import { concDot, escapeHtml, hhmm, landingHref } from "../lib.ts";
import { RECENT_DISPLAY, RECENT_WINDOW, REPO } from "../config.ts";

export const recentRuns: Tile = {
  id: "recent-runs",
  intervalMs: 30_000,
  async collect(ctx): Promise<TileView> {
    // The shared base can hold up to a few hundred runs (ci-trust's window); this
    // tile shows only the most recent RECENT_DISPLAY of them.
    const runs = (await ctx.runs()).slice(0, RECENT_DISPLAY);
    const completedOutcomes = [...runs].filter((r) => r.status === "completed" && r.conclusion).reverse()
      .map((r) => concDot(r.conclusion, r.run_attempt));
    const status: Status = completedOutcomes.length === 0
      ? "unknown"
      : completedOutcomes[completedOutcomes.length - 1] === "red"
      ? "bad"
      : completedOutcomes.slice(-RECENT_WINDOW).includes("red")
      ? "warn"
      : "good";

    const rows = runs.map((r) => {
      const running = r.status !== "completed";
      const dot = running ? "run" : concDot(r.conclusion, r.run_attempt);
      const label = running
        ? `running${r.run_attempt > 1 ? ` · attempt ${r.run_attempt}` : ""}`
        : r.conclusion === "success"
        ? (r.run_attempt > 1 ? `green on retry #${r.run_attempt}` : "green")
        : (r.conclusion ?? "done");
      const title = (r.head_commit?.message ?? r.display_title).split("\n", 1)[0];
      const href = landingHref(title, r.head_sha, REPO);
      return `<a class="ev" href="${escapeHtml(href)}" target="_blank" rel="noopener"><span class="t">${hhmm(r.run_started_at)}</span><span class="dot ${dot}"></span><span class="evtxt">${escapeHtml(`${label} · ${title}`)}</span><span class="evarrow">↗</span></a>`;
    }).join("") || `<div class="ev"><span class="dot grey"></span><span>waiting for first poll…</span></div>`;

    return {
      label: `recent main runs · ${runs.length} in window`,
      status,
      wide: true,
      extra: `<div class="evscroll">${rows}</div>`,
    };
  },
};
