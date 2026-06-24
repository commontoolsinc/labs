#!/usr/bin/env -S deno run --allow-run --allow-net --allow-read --allow-write --allow-env --allow-ffi

// Draw a Gantt chart of a typical CI run from the last N workflow runs on GitHub.
//
// For every job (each matrix shard counts as its own job) the chart shows the
// median start-to-finish bar plus the min and max of the observed start and
// finish times as whiskers, and the median duration with its min-max range as
// text. Jobs are grouped into waves ("tiers") inferred from when they start.
// The output is a PNG whose width scales with run length and whose height scales
// with the number of jobs.
//
// Usage:
//   scripts/ci-gantt.ts [options]
//     --repo OWNER/REPO     default commontoolsinc/labs
//     --workflow FILE       default deno.yml
//     --limit N             runs to fetch, default 100
//     --out PATH            output PNG, default ci-gantt.png
//     --scale N             raster scale factor, default 2
//     --concurrency N       parallel job fetches, default 8
//     --min-runs N          drop jobs seen in fewer than N runs (default: 10% of runs)
//     --main-only           only fetch pushes to main, skipping pre-land PR runs

const args = Deno.args;
function opt(name: string, def: string): string {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
}
if (args.includes("--help") || args.includes("-h")) {
  console.log(
    "Usage: scripts/ci-gantt.ts [--repo OWNER/REPO] [--workflow FILE] [--limit N]\n" +
      "       [--out PATH] [--scale N] [--concurrency N] [--min-runs N] [--main-only]",
  );
  Deno.exit(0);
}

const REPO = opt("repo", "commontoolsinc/labs");
const WORKFLOW = opt("workflow", "deno.yml");
const LIMIT = Number(opt("limit", "100"));
const OUT = opt("out", "ci-gantt.png");
const SCALE = Number(opt("scale", "2"));
const CONCURRENCY = Number(opt("concurrency", "8"));
const MIN_RUNS_OVERRIDE = args.includes("--min-runs")
  ? Number(opt("min-runs", "0"))
  : null;
// By default only successful job executions feed the timings, so failed or
// cancelled runs don't skew the min/max. Pass --all-conclusions to include them.
const SUCCESS_ONLY = !args.includes("--all-conclusions");
// Restrict to pushes to main (post-land), excluding pre-land pull_request runs.
const MAIN_ONLY = args.includes("--main-only");

// ---------------------------------------------------------------------------
// Data fetching (shells out to the gh CLI, which carries the user's auth)
// ---------------------------------------------------------------------------

async function gh(ghArgs: string[]): Promise<string> {
  const cmd = new Deno.Command("gh", {
    args: ghArgs,
    stdout: "piped",
    stderr: "piped",
  });
  const { success, stdout, stderr } = await cmd.output();
  if (!success) {
    throw new Error(
      `gh ${ghArgs.join(" ")} failed:\n${new TextDecoder().decode(stderr)}`,
    );
  }
  return new TextDecoder().decode(stdout);
}

async function pool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) break;
        out[i] = await fn(items[i], i);
      }
    },
  );
  await Promise.all(workers);
  return out;
}

interface Run {
  databaseId: number;
  status: string;
  conclusion: string;
  event: string;
  startedAt: string;
}

interface Job {
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

interface Stat {
  min: number;
  med: number;
  max: number;
}

function stat(values: number[]): Stat {
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  const med = n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  return { min: s[0], med, max: s[n - 1] };
}

interface JobAgg {
  name: string;
  base: string; // job name with the trailing "(...)" stripped
  shardKey: string; // sorts shards within a group
  start: Stat; // seconds from run start
  end: Stat; // seconds from run start
  dur: Stat; // seconds
  count: number;
  mainOnly: boolean; // never observed on a pull_request
}

function shardKeyOf(name: string): string {
  const frac = name.match(/\((\d+)\/(\d+)\)/);
  if (frac) return String(Number(frac[1])).padStart(4, "0");
  const suite = name.match(/\(([^)]*)\)\s*$/);
  return suite ? suite[1] : "";
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function clock(sec: number): string {
  sec = Math.round(sec);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.error(
  `Fetching last ${LIMIT} ${WORKFLOW} runs on ${REPO}${
    MAIN_ONLY ? " (main pushes only)" : ""
  } ...`,
);
const runs: Run[] = JSON.parse(
  await gh([
    "run",
    "list",
    "--repo",
    REPO,
    "--workflow",
    WORKFLOW,
    "--limit",
    String(LIMIT),
    ...(MAIN_ONLY ? ["--branch", "main", "--event", "push"] : []),
    "--json",
    "databaseId,status,conclusion,event,startedAt",
  ]),
);

const completed = runs.filter((r) => r.status === "completed");
console.error(
  `Got ${runs.length} runs (${completed.length} completed); fetching jobs ...`,
);

const jobsPerRun = await pool(completed, CONCURRENCY, async (run, i) => {
  if ((i + 1) % 10 === 0) console.error(`  ${i + 1}/${completed.length}`);
  const body = await gh([
    "api",
    `/repos/${REPO}/actions/runs/${run.databaseId}/jobs?per_page=100`,
  ]);
  return { run, jobs: (JSON.parse(body).jobs ?? []) as Job[] };
});

// Accumulate timings keyed by exact job name (each shard is its own key).
const acc = new Map<
  string,
  { start: number[]; end: number[]; dur: number[]; events: Set<string> }
>();

for (const { run, jobs } of jobsPerRun) {
  const t0 = Date.parse(run.startedAt);
  if (Number.isNaN(t0)) continue;
  for (const j of jobs) {
    if (
      SUCCESS_ONLY ? j.conclusion !== "success" : j.conclusion === "skipped"
    ) {
      continue;
    }
    if (!j.started_at || !j.completed_at) continue;
    const st = Date.parse(j.started_at);
    const en = Date.parse(j.completed_at);
    const dur = (en - st) / 1000;
    if (!(dur > 0)) continue;
    const startOff = (st - t0) / 1000;
    const endOff = (en - t0) / 1000;
    if (startOff < -5) continue;
    let e = acc.get(j.name);
    if (!e) {
      acc.set(j.name, e = { start: [], end: [], dur: [], events: new Set() });
    }
    e.start.push(startOff);
    e.end.push(endOff);
    e.dur.push(dur);
    e.events.add(run.event);
  }
}

const minRuns = MIN_RUNS_OVERRIDE ??
  Math.max(5, Math.round(0.1 * completed.length));

const aggregates: JobAgg[] = [];
for (const [name, e] of acc) {
  if (e.start.length < minRuns) continue;
  aggregates.push({
    name,
    base: name.replace(/\s*\([^)]*\)\s*$/, ""),
    shardKey: shardKeyOf(name),
    start: stat(e.start),
    end: stat(e.end),
    dur: stat(e.dur),
    count: e.start.length,
    // The deploy/attest tail is "main only" relative to PR runs. When the data
    // is already all main pushes, that distinction is moot — nothing is hatched
    // off and every job just lands in its own start-time tier.
    mainOnly: MAIN_ONLY ? false : !e.events.has("pull_request"),
  });
}
if (aggregates.length === 0) {
  console.error("No jobs met the minimum run threshold; nothing to draw.");
  Deno.exit(1);
}

// Order jobs: pull-request jobs grouped into start-time waves, then the
// main-branch-only tail. Within a wave, keep a job's shards together.
function orderSection(jobs: JobAgg[]): { tier: number; jobs: JobAgg[] }[] {
  const sorted = [...jobs].sort((a, b) =>
    a.start.med - b.start.med || a.base.localeCompare(b.base) ||
    a.shardKey.localeCompare(b.shardKey)
  );
  const tiers: JobAgg[][] = [];
  let prevStart = -Infinity;
  for (const j of sorted) {
    if (j.start.med - prevStart > 20 || tiers.length === 0) tiers.push([]);
    tiers[tiers.length - 1].push(j);
    prevStart = j.start.med;
  }
  // Re-group each tier by base job so shards sit next to each other, ordered by
  // the base's earliest start.
  return tiers.map((tier, idx) => {
    const order = new Map<string, number>();
    for (const j of tier) {
      order.set(j.base, Math.min(order.get(j.base) ?? Infinity, j.start.med));
    }
    tier.sort((a, b) =>
      (order.get(a.base)! - order.get(b.base)!) ||
      a.base.localeCompare(b.base) || a.shardKey.localeCompare(b.shardKey)
    );
    return { tier: idx, jobs: tier };
  });
}

const prJobs = aggregates.filter((j) => !j.mainOnly);
const mainJobs = aggregates.filter((j) => j.mainOnly);
const prTiers = orderSection(prJobs);

// The pull-request run finishes when its latest-finishing job ends.
const prFinish = Math.max(...prJobs.map((j) => j.end.med));

// ---------------------------------------------------------------------------
// SVG layout
// ---------------------------------------------------------------------------

const maxEnd = Math.max(...aggregates.map((j) => j.end.max));
const PAD = 22;
const TITLE_H = 48;
const AXIS_H = 20;
const ROW_H = 20;
const BAR_H = 9;
const HEADER_H = 22;
const SECTION_GAP = 10;
const RIGHT_PAD = 150;

const longestName = Math.max(...aggregates.map((j) => j.name.length), 16);
const COUNT_COL = 44; // far-left column showing how many runs the job ran in
const NAME_X = PAD + COUNT_COL;
const LEFT_COL = Math.min(300, Math.round(longestName * 6.4) + 16);
const TARGET_CHART_W = 840;
const pxPerSec = Math.min(8, TARGET_CHART_W / maxEnd);
const chartX0 = NAME_X + LEFT_COL;
const chartW = maxEnd * pxPerSec;
const totalW = Math.round(chartX0 + chartW + RIGHT_PAD);
const x = (sec: number) => chartX0 + sec * pxPerSec;

const C = {
  bg: "#ffffff",
  text: "#1f2328",
  sub: "#57606a",
  grid: "#e7e7e7",
  axis: "#8a8a8a",
  bar: "#3f7fb8",
  main: "#8a897f",
  whisker: "#2a2a2a",
};

const body: string[] = [];
const ticks: string[] = [];

// Time axis ticks: pick a round interval that keeps labels ~70px apart.
const intervals = [15, 30, 60, 120, 300, 600, 900, 1800];
const interval = intervals.find((c) => c * pxPerSec >= 70) ?? 1800;

let y = PAD + TITLE_H + AXIS_H;
const gridTop = PAD + TITLE_H + AXIS_H - 8;

function drawSection(title: string, jobs: JobAgg[]) {
  body.push(
    `<text x="${NAME_X}" y="${
      y + 12
    }" font-size="12" font-weight="600" fill="${C.sub}">${esc(title)}</text>`,
  );
  y += HEADER_H;
  for (const j of jobs) {
    const top = y;
    const cy = top + BAR_H / 2;
    const fill = j.mainOnly ? C.main : C.bar;
    const xs = x(j.start.min), xe = x(j.end.max);

    // envelope: full min-start to max-end extent
    body.push(
      `<rect x="${xs.toFixed(1)}" y="${top}" width="${
        Math.max(1, xe - xs).toFixed(1)
      }" height="${BAR_H}" rx="2" fill="${fill}" fill-opacity="0.18"/>`,
    );
    // median bar
    const mb = x(j.start.med), me = x(j.end.med);
    body.push(
      `<rect x="${mb.toFixed(1)}" y="${top}" width="${
        Math.max(2, me - mb).toFixed(1)
      }" height="${BAR_H}" rx="2" fill="${fill}"/>`,
    );
    if (j.mainOnly) {
      body.push(
        `<rect x="${xs.toFixed(1)}" y="${top}" width="${
          Math.max(1, xe - xs).toFixed(1)
        }" height="${BAR_H}" rx="2" fill="url(#hatch)"/>`,
      );
    }
    // whiskers for start and finish ranges: a "<" at the min, a ">" at the max
    const whisker = (lo: number, hi: number, w: number) => {
      const a = x(lo), b = x(hi);
      if (b - a < 1.5) return;
      const h = 3;
      const d = Math.min(3, (b - a) / 2);
      const f = (n: number) => n.toFixed(1);
      const stroke =
        `fill="none" stroke="${C.whisker}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"`;
      body.push(
        `<line x1="${f(a)}" y1="${f(cy)}" x2="${f(b)}" y2="${
          f(cy)
        }" stroke="${C.whisker}" stroke-width="${w}"/>` +
          `<polyline points="${f(a + d)},${f(cy - h)} ${f(a)},${f(cy)} ${
            f(a + d)
          },${f(cy + h)}" ${stroke}/>` +
          `<polyline points="${f(b - d)},${f(cy - h)} ${f(b)},${f(cy)} ${
            f(b - d)
          },${f(cy + h)}" ${stroke}/>`,
      );
    };
    whisker(j.start.min, j.start.max, 0.8);
    whisker(j.end.min, j.end.max, 1.4);

    // labels: run count and job name on the left, median (min-max) duration right
    body.push(
      `<text x="${PAD + COUNT_COL - 10}" y="${
        (top + BAR_H).toFixed(1)
      }" font-size="10" fill="${C.sub}" text-anchor="end">${j.count}</text>`,
    );
    body.push(
      `<text x="${NAME_X}" y="${
        (top + BAR_H).toFixed(1)
      }" font-size="11" fill="${C.text}">${esc(j.name)}</text>`,
    );
    body.push(
      `<text x="${(xe + 8).toFixed(1)}" y="${
        (top + BAR_H).toFixed(1)
      }" font-size="11" fill="${C.text}">${clock(j.dur.med)}` +
        `<tspan dx="6" fill="${C.sub}" font-size="10">${clock(j.dur.min)}–${
          clock(j.dur.max)
        }</tspan></text>`,
    );
    y += ROW_H;
  }
  y += SECTION_GAP;
}

prTiers.forEach((t) =>
  drawSection(`Tier ${t.tier} · starts ~${clock(t.jobs[0].start.med)}`, t.jobs)
);
if (mainJobs.length) {
  const ordered = orderSection(mainJobs).flatMap((t) => t.jobs);
  drawSection("Main branch only (push to main)", ordered);
}

const gridBottom = y - SECTION_GAP + 4;

// header for the run-count column
ticks.push(
  `<text x="${PAD + COUNT_COL - 10}" y="${
    gridTop - 6
  }" font-size="10" fill="${C.axis}" text-anchor="end">runs</text>`,
);

// gridlines + axis labels
for (let t = 0; t <= maxEnd + 1; t += interval) {
  const gx = x(t);
  ticks.push(
    `<line x1="${gx.toFixed(1)}" y1="${gridTop}" x2="${
      gx.toFixed(1)
    }" y2="${gridBottom}" stroke="${C.grid}" stroke-width="1"/>`,
  );
  const label = interval % 60 === 0 ? `${t / 60}m` : clock(t);
  ticks.push(
    `<text x="${gx.toFixed(1)}" y="${
      gridTop - 6
    }" font-size="10" fill="${C.axis}" text-anchor="middle">${
      t === 0 ? "0" : label
    }</text>`,
  );
}

// legend
const legendY = gridBottom + 22;
const legend: string[] = [];
let lx = PAD;
function legendBox(color: string, hatch: boolean, label: string) {
  legend.push(
    `<rect x="${lx}" y="${
      legendY - 9
    }" width="12" height="10" rx="2" fill="${color}"/>`,
  );
  if (hatch) {
    legend.push(
      `<rect x="${lx}" y="${
        legendY - 9
      }" width="12" height="10" rx="2" fill="url(#hatch)"/>`,
    );
  }
  legend.push(
    `<text x="${lx + 18}" y="${legendY}" font-size="11" fill="${C.sub}">${
      esc(label)
    }</text>`,
  );
  lx += 30 + label.length * 6.2;
}
legendBox(C.bar, false, "median bar");
if (mainJobs.length) legendBox(C.main, true, "main branch only");
{
  const cyl = legendY - 4, a = lx, b = lx + 22;
  const stroke =
    `fill="none" stroke="${C.whisker}" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"`;
  legend.push(
    `<line x1="${a}" y1="${cyl}" x2="${b}" y2="${cyl}" stroke="${C.whisker}" stroke-width="1.1"/>` +
      `<polyline points="${a + 3},${cyl - 3} ${a},${cyl} ${a + 3},${
        cyl + 3
      }" ${stroke}/>` +
      `<polyline points="${b - 3},${cyl - 3} ${b},${cyl} ${b - 3},${
        cyl + 3
      }" ${stroke}/>`,
  );
  lx = b;
}
legend.push(
  `<text x="${
    lx + 6
  }" y="${legendY}" font-size="11" fill="${C.sub}">&lt; min … max &gt; of start &amp; finish</text>`,
);

const totalH = Math.round(legendY + 16);

// title
const date = new Date().toISOString().slice(0, 10);
const runKind = MAIN_ONLY ? "main push" : "run";
const title =
  `${REPO} · ${WORKFLOW} — typical ${runKind} (median of ${completed.length} completed ${
    MAIN_ONLY ? "main pushes" : "runs"
  })`;
const subtitle =
  `Bars = median start to finish; whiskers = min/max; text = median (min–max) duration; ` +
  `${
    SUCCESS_ONLY ? "successful jobs only" : "all conclusions"
  }; ${runKind} finishes ~${clock(prFinish)} · generated ${date}`;

const svg = [
  `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="${totalH}" viewBox="0 0 ${totalW} ${totalH}" font-family="Helvetica, Arial, sans-serif">`,
  `<defs><pattern id="hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="5" stroke="#ffffff" stroke-width="1.1" stroke-opacity="0.7"/></pattern></defs>`,
  `<rect width="${totalW}" height="${totalH}" fill="${C.bg}"/>`,
  `<text x="${PAD}" y="${
    PAD + 6
  }" font-size="16" font-weight="700" fill="${C.text}">${esc(title)}</text>`,
  `<text x="${PAD}" y="${PAD + 24}" font-size="11" fill="${C.sub}">${
    esc(subtitle)
  }</text>`,
  ...ticks,
  ...body,
  ...legend,
  `</svg>`,
].join("\n");

// ---------------------------------------------------------------------------
// Rasterize to PNG
// ---------------------------------------------------------------------------

const { Resvg } = await import("npm:@resvg/resvg-js@2.6.2");
const resvg = new Resvg(svg, {
  fitTo: { mode: "zoom", value: SCALE },
  font: { loadSystemFonts: true, defaultFontFamily: "Helvetica" },
  background: "white",
});
const png = resvg.render().asPng();
await Deno.writeFile(OUT, png);
console.error(
  `Wrote ${OUT} (${totalW}×${totalH} @ ${SCALE}x = ${
    Math.round(totalW * SCALE)
  }×${
    Math.round(totalH * SCALE)
  } px, ${png.length} bytes, ${aggregates.length} jobs)`,
);
