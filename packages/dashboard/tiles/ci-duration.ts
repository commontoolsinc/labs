// ci duration: median wall-clock of recent completed runs, with a trend
// sparkline. Drills down to /ci, an interactive view of the real
// scripts/ci-gantt.ts with its arguments exposed as controls.
import { fromFileUrl } from "@std/path";
import type { Route, Run, Status, Tile, TileView } from "../types.ts";
import { clampInt, humanSpan, sparkline, SPARK_FADE } from "../lib.ts";
import { CI_WORKFLOW, DUR_GOOD, DUR_MAX_AGE_HOURS, DUR_MIN_RUNS, DUR_WARN, REPO } from "../config.ts";

const CIGANTT = fromFileUrl(new URL("../../../scripts/ci-gantt.ts", import.meta.url));

async function renderGantt(p: URLSearchParams): Promise<Response> {
  const limit = clampInt(p.get("limit"), 60, 1, 150);
  const mainOnly = p.get("mainOnly") === "1";
  const minRunsRaw = p.get("minRuns");
  const hasMin = !!(minRunsRaw && /^\d+$/.test(minRunsRaw));
  const out = await Deno.makeTempFile({ prefix: "ci-gantt-", suffix: ".png" });
  const args = [
    "run", "--allow-net", "--allow-read", "--allow-write", "--allow-env", "--allow-ffi",
    CIGANTT, "--repo", REPO, "--workflow", CI_WORKFLOW, "--limit", String(limit), "--scale", "2", "--theme", "dark", "--out", out,
  ];
  if (mainOnly) args.push("--main-only");
  if (p.get("allConclusions") === "1") args.push("--all-conclusions");
  // A user value wins; else a low floor, capped at the run count, so a thin
  // main-only window — down to a single run — still draws (ci-gantt exits
  // non-zero when its default threshold drops every job).
  if (hasMin) args.push("--min-runs", minRunsRaw!);
  else if (mainOnly) args.push("--min-runs", String(Math.min(2, limit)));
  try {
    const { success, stderr } = await new Deno.Command("deno", {
      args,
      stdout: "piped",
      stderr: "piped",
      signal: AbortSignal.timeout(120_000),
    }).output();
    if (!success) {
      console.error("ci-gantt failed:", new TextDecoder().decode(stderr));
      return new Response("ci-gantt failed (see server log)", { status: 500 });
    }
    return new Response(await Deno.readFile(out), { headers: { "content-type": "image/png", "cache-control": "no-store" } });
  } catch (e) {
    console.error("ci-gantt render error:", e instanceof Error ? e.message : e);
    return new Response("ci-gantt render error (see server log)", { status: 500 });
  } finally {
    await Deno.remove(out).catch(() => {});
  }
}

function ciGanttPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>CI Gantt — configurable</title>
<style>
  body{margin:0;background:#0d0e11;color:#e7e9ee;font-family:-apple-system,Segoe UI,Roboto,sans-serif;padding:18px 20px 26px;max-width:1100px;margin:0 auto}
  .top{display:flex;align-items:baseline;gap:10px;margin-bottom:16px}
  .top b{font-size:16px;font-weight:600}.top span{font-size:12px;color:#6f757f}
  a.back{color:#6ea8fe;text-decoration:none;font-size:13px}
  .controls{display:flex;flex-wrap:wrap;gap:20px;align-items:center;background:#16181d;border:1px solid #23262d;border-radius:12px;padding:14px 16px;margin-bottom:14px}
  .controls label{font-size:13px;color:#c7ccd4;display:flex;align-items:center;gap:8px}
  .controls input[type=range]{width:200px}
  .controls input[type=number]{width:64px;background:#0d0e11;color:#e7e9ee;border:1px solid #2f333c;border-radius:6px;padding:3px 6px}
  .statusrow{display:flex;align-items:center;font-size:12px;color:#8a93a5;margin:0 0 12px;min-height:18px}
  .statusrow.busy{color:#6ea8fe}.statusrow.err{color:#f0726c}
  .spinner{width:15px;height:15px;border:2px solid #2f333c;border-top-color:#6ea8fe;border-radius:50%;animation:spin .8s linear infinite;display:none;margin-right:8px;flex:none}
  .spinner.on{display:inline-block}
  @keyframes spin{to{transform:rotate(360deg)}}
  .imgwrap{background:#0c0d11;border:1px solid #23262d;border-radius:12px;padding:10px;overflow:auto;min-height:60px}
  #g{width:100%;height:auto;display:none}
  .hint{font-size:11px;color:#666c76;margin-top:12px}
</style></head><body>
  <div class="top"><a class="back" href="/">← dashboard</a><b>CI Gantt</b><span>${REPO} · ${CI_WORKFLOW} · live from scripts/ci-gantt.ts</span></div>
  <div class="controls">
    <label>runs to include <input type="range" id="limit" min="1" max="150" step="1" value="60"><b id="limitv">60</b></label>
    <label><input type="checkbox" id="mainOnly" checked> main pushes only</label>
    <label><input type="checkbox" id="allConcl"> include failed/cancelled in timing</label>
    <label>min runs per job <input type="number" id="minRuns" min="1" placeholder="auto"></label>
  </div>
  <div class="statusrow"><span class="spinner" id="spin"></span><span id="status"></span></div>
  <div class="imgwrap"><img id="g" alt="CI Gantt chart"></div>
  <p class="hint">Each change re-runs scripts/ci-gantt.ts against GitHub, so regeneration takes a few seconds (longer for larger run counts). Changes are debounced; the last setting wins.</p>
<script>
  const $ = (id) => document.getElementById(id);
  const status = $('status'), g = $('g'), spin = $('spin'), row = document.querySelector('.statusrow');
  function query(){
    const p = new URLSearchParams();
    p.set('limit', $('limit').value);
    if ($('mainOnly').checked) p.set('mainOnly', '1');
    if ($('allConcl').checked) p.set('allConclusions', '1');
    if ($('minRuns').value) p.set('minRuns', $('minRuns').value);
    p.set('t', Date.now());
    return '/ci-gantt.png?' + p.toString();
  }
  let seq = 0;
  function regen(){
    const mine = ++seq;
    spin.classList.add('on');
    row.className = 'statusrow busy';
    status.textContent = 'regenerating… fetching ' + $('limit').value + ' runs from GitHub';
    const img = new Image();
    const done = (kind, text, src) => {
      if (mine !== seq) return;
      clearTimeout(to);
      spin.classList.remove('on');
      if (kind === 'ok') { g.src = src; g.style.display = 'block'; row.className = 'statusrow'; }
      else { row.className = 'statusrow err'; }
      status.textContent = text;
    };
    const to = setTimeout(() => done('err', 'timed out generating (check the server log)'), 135000);
    img.onload = () => done('ok', 'updated · ' + $('limit').value + ' runs', img.src);
    img.onerror = () => done('err', 'failed to generate (check the server log)');
    img.src = query();
  }
  let timer;
  const debounced = () => { clearTimeout(timer); timer = setTimeout(regen, 500); };
  $('limit').addEventListener('input', () => { $('limitv').textContent = $('limit').value; debounced(); });
  ['mainOnly','allConcl','minRuns'].forEach((id) => $(id).addEventListener('change', debounced));
  regen();
</script></body></html>`;
}

const routes: Route[] = [
  { path: "/ci", handler: () => new Response(ciGanttPage(), { headers: { "content-type": "text/html; charset=utf-8" } }) },
  { path: "/ci-gantt.png", handler: (_req, url) => renderGantt(url.searchParams) },
];

export const ciDuration: Tile = {
  id: "ci-duration",
  intervalMs: 30_000,
  routes,
  async collect(ctx): Promise<TileView> {
    const runs = await ctx.runs();
    // Only runs that passed end to end: a failed/cancelled/timed-out run's
    // wall-clock time isn't a representative CI duration.
    const passed = runs.filter((r) => r.status === "completed" && r.conclusion === "success");
    const durMins = (r: Run) => (Date.parse(r.updated_at) - Date.parse(r.run_started_at)) / 60000;
    // Median window = the successful runs in the last DUR_MAX_AGE_HOURS, or the
    // most recent DUR_MIN_RUNS — whichever has more runs.
    const cutoff = Date.now() - DUR_MAX_AGE_HOURS * 3_600_000;
    const timeWindow = passed.filter((r) => Date.parse(r.run_started_at) >= cutoff);
    const usingTime = timeWindow.length >= DUR_MIN_RUNS; // time window wins when it has enough runs
    const window = usingTime ? timeWindow : passed.slice(0, DUR_MIN_RUNS);
    const durs = window.map(durMins).sort((a, b) => a - b);
    const mid = durs.length >> 1;
    const medianMins = durs.length ? Math.round(durs.length % 2 ? durs[mid] : (durs[mid - 1] + durs[mid]) / 2) : 0;
    // A filtered time window can be non-contiguous in created order when a run
    // starts late or is rerun. Plot that exact set so every highlighted point
    // feeds the median; the count-based fallback still shows the longer trend.
    const plottedRuns = usingTime ? window : passed;
    const series = [...plottedRuns].reverse().map(durMins);
    const highlightCount = window.length;
    // Tiny caption: how long the sparkline spans (oldest to newest run).
    const times = plottedRuns.map((r) => Date.parse(r.run_started_at)).filter((t) => !Number.isNaN(t));
    const spanLabel = humanSpan(times.length >= 2 ? Math.max(...times) - Math.min(...times) : 0);
    const s: Status = window.length === 0
      ? "unknown"
      : medianMins <= DUR_GOOD ? "good" : medianMins <= DUR_WARN ? "warn" : "bad";
    return {
      label: "ci duration",
      status: s,
      value: window.length === 0 ? "—" : `${medianMins}m`,
      sub: usingTime
        ? `median · ${window.length} passing runs in the last ${DUR_MAX_AGE_HOURS}h`
        : `median · last ${window.length} passing runs`,
      extra: sparkline(series, "#727882", { count: highlightCount, color: "#c7ccd4" }, spanLabel, SPARK_FADE[s]),
      href: "/ci",
      hint: "gantt ↗",
    };
  },
};
