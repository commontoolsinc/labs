// recent main runs: every run in the window (newest first, including in-progress
// ones), across both the labs and loom repos interleaved chronologically, each
// row linking to the PR that landed the commit and tagged with its repo.
// Full-width. The tile's aggregate status is bad if the latest completed run
// failed, concerning if a failure sits within the recent window but the tip
// recovered, else good.
import type { Run, Status, Tile, TileView } from "../types.ts";
import { concDot, escapeHtml, landingHref } from "../lib.ts";
import { CI_WORKFLOW, LOOM_CI_WORKFLOW, LOOM_REPO, RECENT_DISPLAY, RECENT_WINDOW, REPO } from "../config.ts";

const utcFallback = (iso: string): string => {
  const at = Date.parse(iso);
  return Number.isFinite(at) ? `${new Date(at).toISOString().slice(11, 16)} UTC` : iso;
};

export const recentRuns: Tile = {
  id: "recent-runs",
  intervalMs: 30_000,
  wide: true,
  async collect(ctx): Promise<TileView> {
    // Two shared bases (labs + loom), merged newest-first and cut to the most
    // recent RECENT_DISPLAY across both.
    const [labs, loom] = await Promise.all([
      ctx.runsFor(REPO, CI_WORKFLOW),
      ctx.runsFor(LOOM_REPO, LOOM_CI_WORKFLOW),
    ]);
    const runs = [...labs, ...loom]
      .sort((a, b) => Date.parse(b.run_started_at) - Date.parse(a.run_started_at))
      .slice(0, RECENT_DISPLAY);

    const completedOutcomes = [...runs].filter((r) => r.status === "completed" && r.conclusion).reverse()
      .map((r) => concDot(r.conclusion, r.run_attempt));
    const status: Status = completedOutcomes.length === 0
      ? "unknown"
      : completedOutcomes[completedOutcomes.length - 1] === "red"
      ? "bad"
      : completedOutcomes.slice(-RECENT_WINDOW).includes("red")
      ? "warn"
      : "good";

    const repoOf = (r: Run) => r.repo ?? REPO;
    const shortRepo = (r: Run) => repoOf(r).split("/")[1] ?? repoOf(r);
    const rows = runs.map((r) => {
      const running = r.status !== "completed";
      const dot = running ? "run" : concDot(r.conclusion, r.run_attempt);
      const label = running
        ? `running${r.run_attempt > 1 ? ` · attempt ${r.run_attempt}` : ""}`
        : r.conclusion === "success"
        ? (r.run_attempt > 1 ? `green on retry #${r.run_attempt}` : "green")
        : (r.conclusion ?? "done");
      const title = (r.head_commit?.message ?? r.display_title).split("\n", 1)[0];
      const href = landingHref(title, r.head_sha, repoOf(r));
      const startedAt = escapeHtml(r.run_started_at);
      const fallback = escapeHtml(utcFallback(r.run_started_at));
      return `<a class="ev" href="${escapeHtml(href)}" target="_blank" rel="noopener"><time class="t" datetime="${startedAt}" data-viewer-time>${fallback}</time><span class="dot ${dot}"></span><span class="evtxt">${escapeHtml(`${shortRepo(r)} · ${label} · ${title}`)}</span><span class="evarrow">↗</span></a>`;
    }).join("") || `<div class="ev"><span class="dot grey"></span><span>waiting for first poll…</span></div>`;

    return {
      label: `recent main runs · ${runs.length} in window`,
      status,
      extra: `<div class="evscroll">${rows}</div>`,
    };
  },
};
