#!/usr/bin/env -S deno run --allow-net --allow-read --allow-write --allow-env --allow-ffi --allow-sys=cpus,networkInterfaces,hostname

// Resvg's Linux loader calls Node's process report, which reads CPU,
// network-interface, and hostname information.

// Draw a Gantt chart of a typical CI run from the last N workflow runs on GitHub.
//
// For every job (each matrix shard counts as its own job) the chart shows the
// median start-to-finish bar plus the min and max of the observed start and
// finish times as whiskers, and the median duration with its min-max range as
// text. Jobs are grouped into waves ("tiers") inferred from when they start.
// The output is a PNG whose width scales with run length and whose height scales
// with the number of jobs.
//
// Each median bar is split into "setup", "work" and "shutdown" segments so the
// shared scaffolding around a job (checkout, tool install, cache restore,
// coverage upload) is visually separated from the job's own work. For matrix
// shards this shows how much of a shard's wall time is setup duplicated across
// every shard versus the unique work that shard does. A step is placed into a
// phase by the marker emoji its name starts with; the segment widths are the
// median time spent in each phase, scaled to fill the median bar. The marker
// vocabulary lives in docs/development/CI_PERFORMANCE.md ("Step phase markers")
// and is mirrored in PHASE_MARKERS below.
//
// Usage:
//   scripts/ci-gantt.ts [options]
//     --repo OWNER/REPO     default commontoolsinc/labs
//     --workflow FILE       default deno.yml
//     --limit N             runs to fetch, default 100
//     --out PATH            output file, default ci-gantt.png; a .svg path
//                           writes the raw SVG instead of a rasterized PNG
//     --scale N             raster scale factor, default 2
//     --concurrency N       parallel job fetches, default 8
//     --min-runs N          drop jobs seen in fewer than N runs (default: 10% of runs)
//     --main-only           only fetch pushes to main, skipping pre-land PR runs
//     --run-id ID           chart this workflow run ID, repeatable
//     --theme NAME          color palette: "default" (light) or "dark"
//     --colors JSON         override palette keys, e.g. '{"work":"#6ea8fe"}'

const args = Deno.args;
function opt(name: string, def: string): string {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
}
// Parse a numeric option, falling back to the default for missing or invalid
// input and clamping to a minimum (so e.g. --concurrency 0 can't stall the pool).
function numOpt(
  name: string,
  def: number,
  { min = 0, integer = false }: { min?: number; integer?: boolean } = {},
): number {
  const v = Number(opt(name, String(def)));
  const n = Number.isFinite(v) && v >= min ? v : def;
  return integer ? Math.floor(n) : n;
}
if (args.includes("--help") || args.includes("-h")) {
  console.log(
    "Usage: scripts/ci-gantt.ts [--repo OWNER/REPO] [--workflow FILE] [--limit N]\n" +
      "       [--out PATH] [--scale N] [--concurrency N] [--min-runs N] [--main-only]\n" +
      "       [--run-id ID] [--theme default|dark] [--colors '<json>']",
  );
  Deno.exit(0);
}

const REPO = opt("repo", "commontoolsinc/labs");
const WORKFLOW = opt("workflow", "deno.yml");
const LIMIT = numOpt("limit", 100, { min: 1, integer: true });
const OUT = opt("out", "ci-gantt.png");
const SCALE = numOpt("scale", 2, { min: 0.1 });
const CONCURRENCY = numOpt("concurrency", 8, { min: 1, integer: true });
const RUN_IDS = args.flatMap((arg, index) =>
  arg === "--run-id" && args[index + 1] ? [args[index + 1]] : []
);
const MIN_RUNS_OVERRIDE = args.includes("--min-runs")
  ? numOpt("min-runs", 1, { min: 1, integer: true })
  : null;
// Sampled charts use successful jobs by default. Exact-run charts include every
// non-skipped job.
const SUCCESS_ONLY = !RUN_IDS.length && !args.includes("--all-conclusions");
// Restrict to pushes to main (post-land), excluding pre-land pull_request runs.
const MAIN_ONLY = args.includes("--main-only");

// ---------------------------------------------------------------------------
// Data fetching: calls the GitHub REST API directly, authenticated with
// GH_TOKEN or GITHUB_TOKEN. One of those must be set.
// ---------------------------------------------------------------------------

const TOKEN = Deno.env.get("GH_TOKEN") ?? Deno.env.get("GITHUB_TOKEN");
if (!TOKEN) {
  console.error(
    "Set GH_TOKEN or GITHUB_TOKEN (a GitHub token with repo read).",
  );
  Deno.exit(1);
}

// The workflow-run fields the REST API returns that this chart uses.
interface RestRun {
  id: number;
  run_attempt: number;
  status: string;
  conclusion: string | null;
  event: string;
  head_branch: string | null;
  run_started_at: string;
  name: string;
}

function toRun(r: RestRun): Run {
  return {
    attempt: r.run_attempt,
    databaseId: r.id,
    status: r.status,
    conclusion: r.conclusion ?? "",
    event: r.event,
    headBranch: r.head_branch ?? undefined,
    startedAt: r.run_started_at,
    workflowName: r.name,
  };
}

async function githubApi<T>(path: string): Promise<T> {
  const res = await fetch(`https://api.github.com/${path.replace(/^\//, "")}`, {
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`GitHub API ${path} failed: HTTP ${res.status}`);
  return await res.json() as T;
}

// The last LIMIT workflow runs. Pages by a constant 100-run size — so GitHub's
// (page-1)*per_page offset stays consistent across pages — then over-fetches and
// slices to LIMIT.
async function fetchRuns(): Promise<Run[]> {
  const runs: Run[] = [];
  const per = Math.min(100, LIMIT);
  for (let page = 1; runs.length < LIMIT; page++) {
    const params = new URLSearchParams({
      per_page: String(per),
      page: String(page),
    });
    if (MAIN_ONLY) {
      params.set("branch", "main");
      params.set("event", "push");
    }
    const data = await githubApi<{ workflow_runs: RestRun[] }>(
      `/repos/${REPO}/actions/workflows/${
        encodeURIComponent(WORKFLOW)
      }/runs?${params}`,
    );
    const batch = data.workflow_runs ?? [];
    for (const r of batch) runs.push(toRun(r));
    if (batch.length < per) break; // reached the end of the runs
  }
  return runs.slice(0, LIMIT);
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
  attempt?: number;
  databaseId: number;
  status: string;
  conclusion: string;
  event: string;
  headBranch?: string;
  startedAt: string;
  workflowName?: string;
}

interface Step {
  name: string;
  number: number;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
}

interface Job {
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  steps?: Step[];
}

function hasTiming(job: Job): boolean {
  if (!job.started_at || !job.completed_at) return false;
  const st = Date.parse(job.started_at);
  const en = Date.parse(job.completed_at);
  return Number.isFinite(st) && Number.isFinite(en) && en > st;
}

// ---------------------------------------------------------------------------
// Step phases
//
// Every step is placed into a phase from the marker emoji its name begins with.
// The emoji is load-bearing: workflow and composite-action authors pick one from
// the vocabulary below, and the chart splits each job bar into these phases
// without having to recognise step wording. The authoritative table is
// docs/development/CI_PERFORMANCE.md ("Step phase markers"); keep them in sync.
// A step whose name carries no known marker lands in "other" and is reported to
// stderr so a missing marker is easy to spot. In a normal run the only unmarked
// steps are the ones GitHub injects ("Set up job", "Post …", "Complete job"),
// which are classified below by name because their wording is not ours to set.
// ---------------------------------------------------------------------------

type Phase = "setup" | "work" | "shutdown" | "other";

// Chart order, left to right (matches the order steps run in). "other" trails so
// an unmarked step stands out at the end of the bar.
const PHASE_ORDER: Phase[] = ["setup", "work", "shutdown", "other"];

// Marker emoji -> phase. Each emoji maps to exactly one phase; when a step's
// natural emoji would land it in the wrong phase, the step name is changed to a
// marker that fits (see docs/development/CI_PERFORMANCE.md). Matching ignores a
// trailing variation selector, so the base emoji covers both the plain and the
// selector-suffixed form of a glyph.
const PHASE_MARKERS: [string, Phase][] = [
  // setup: fetch code, install tools and dependencies, restore caches,
  // authenticate, and bring test servers and devices up before the real work.
  ["📥", "setup"], // checkout / download inputs
  ["🦕", "setup"], // set up Deno
  ["🔍", "setup"], // verify lock file & install, resolve refs
  ["📦", "setup"], // install packages, cache dependencies
  ["♻️", "setup"], // restore/save build caches
  ["🛡️", "setup"], // relax sandbox for browser tests
  ["🔧", "setup"], // enable devices
  ["⚙️", "setup"], // set up external SDKs
  ["🔑", "setup"], // authenticate to a cloud
  ["🔌", "setup"], // start a local server for tests
  ["⏳", "setup"], // wait for a service to be ready
  ["💾", "setup"], // restore/save caches
  ["🧮", "setup"], // compute a cache identity
  // work: the job's actual purpose.
  ["🔎", "work"], // checks (format, type, patterns, attestations)
  ["🚧", "work"], // guard that fails the build on a banned pattern
  ["🧪", "work"], // run tests
  ["🧩", "work"], // run integration tests
  ["🧹", "work"], // lint
  ["🧭", "work"], // check skill facts
  ["📄", "work"], // type-check docs
  ["🏗️", "work"], // build binaries/assets
  ["🏋️", "work"], // run benchmarks
  ["📊", "work"], // produce performance metrics / status reports
  ["🧬", "work"], // combine coverage
  ["📝", "work"], // generate attestations
  ["🔐", "work"], // sign binaries
  ["🚀", "work"], // deploy
  ["💬", "work"], // post a PR comment
  // shutdown: post-work reports, artifact uploads, log capture, teardown.
  ["🧾", "shutdown"], // write coverage report
  ["📤", "shutdown"], // upload artifacts
  ["📋", "shutdown"], // capture logs on failure
];

const stripVS = (s: string) => s.replace(/\uFE0F/g, "");

function phaseOf(stepName: string): Phase {
  const name = stepName.trim();
  // A leading marker wins, so a step named "💬 Post …" is classified by its
  // marker rather than the "Post " rule below.
  const norm = stripVS(name);
  for (const [emoji, phase] of PHASE_MARKERS) {
    if (norm.startsWith(stripVS(emoji))) return phase;
  }
  // Steps GitHub injects carry no marker; their wording is not ours to set.
  if (name.startsWith("Post ")) return "shutdown";
  if (name === "Set up job") return "setup";
  if (name === "Complete job") return "shutdown";
  return "other";
}

const JOBS_PER_PAGE = 100;
async function fetchJobs(path: string): Promise<Job[]> {
  const jobs: Job[] = [];
  for (let page = 1;; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const url = `${path}${sep}per_page=${JOBS_PER_PAGE}&page=${page}`;
    const pageJobs = (await githubApi<{ jobs?: Job[] }>(url)).jobs ?? [];
    jobs.push(...pageJobs);
    if (pageJobs.length < JOBS_PER_PAGE) {
      break;
    }
  }
  return jobs;
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
  phase: Record<Phase, number>; // median seconds spent in each phase
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
  RUN_IDS.length
    ? `Fetching ${RUN_IDS.length} selected run(s) on ${REPO} ...`
    : `Fetching last ${LIMIT} ${WORKFLOW} runs on ${REPO}${
      MAIN_ONLY ? " (main pushes only)" : ""
    } ...`,
);
const runs: Run[] = RUN_IDS.length
  ? await pool(
    RUN_IDS,
    CONCURRENCY,
    async (runId) =>
      toRun(await githubApi<RestRun>(`/repos/${REPO}/actions/runs/${runId}`)),
  )
  : await fetchRuns();

const completed = runs.filter((r) => r.status === "completed");
console.error(
  `Got ${runs.length} runs (${completed.length} completed); fetching jobs ...`,
);

const jobsPerRun = await pool(completed, CONCURRENCY, async (run, i) => {
  if ((i + 1) % 10 === 0) console.error(`  ${i + 1}/${completed.length}`);
  let jobs = await fetchJobs(
    `/repos/${REPO}/actions/runs/${run.databaseId}/attempts/1/jobs`,
  );
  if ((run.attempt ?? 1) > 1) {
    const latestJobs = await fetchJobs(
      `/repos/${REPO}/actions/runs/${run.databaseId}/jobs`,
    );
    const latestByName = new Map(
      latestJobs.map((job) => [job.name, job]),
    );
    jobs = jobs.map((job) => {
      const latest = latestByName.get(job.name);
      if (latest && !hasTiming(job) && hasTiming(latest)) return latest;
      return latest
        ? { ...job, status: latest.status, conclusion: latest.conclusion }
        : job;
    });
  }
  return { run, jobs };
});

// Accumulate timings keyed by exact job name (each shard is its own key).
const acc = new Map<
  string,
  {
    start: number[];
    end: number[];
    dur: number[];
    events: Set<string>;
    phase: Record<Phase, number[]>; // per-run seconds in each phase
  }
>();
// Step names that carried no known marker, surfaced at the end so a missing
// marker can be fixed.
const unmarkedSteps = new Set<string>();

for (const { run, jobs } of jobsPerRun) {
  const startCandidates = [
    run.startedAt,
    ...jobs.map((job) => job.started_at),
  ]
    .map((value) => value ? Date.parse(value) : NaN)
    .filter((value) => Number.isFinite(value));
  const t0 = Math.min(...startCandidates);
  if (!Number.isFinite(t0)) continue;
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
      acc.set(
        j.name,
        e = {
          start: [],
          end: [],
          dur: [],
          events: new Set(),
          phase: { setup: [], work: [], shutdown: [], other: [] },
        },
      );
    }
    e.start.push(startOff);
    e.end.push(endOff);
    e.dur.push(dur);
    e.events.add(run.event);
    // Sum this run's step durations by phase, keyed off each step's marker.
    const perPhase: Record<Phase, number> = {
      setup: 0,
      work: 0,
      shutdown: 0,
      other: 0,
    };
    for (const step of j.steps ?? []) {
      if (!step.started_at || !step.completed_at) continue;
      const ss = Date.parse(step.started_at);
      const se = Date.parse(step.completed_at);
      if (!(se > ss)) continue;
      const p = phaseOf(step.name);
      perPhase[p] += (se - ss) / 1000;
      if (p === "other") unmarkedSteps.add(step.name);
    }
    // Only record a phase row when this run had step timing, so a run whose job
    // came back without steps doesn't drag the medians toward zero.
    if (PHASE_ORDER.some((p) => perPhase[p] > 0)) {
      for (const p of PHASE_ORDER) e.phase[p].push(perPhase[p]);
    }
  }
}

const minRuns = MIN_RUNS_OVERRIDE ??
  (RUN_IDS.length ? 1 : Math.max(5, Math.round(0.1 * completed.length)));

const aggregates: JobAgg[] = [];
for (const [name, e] of acc) {
  if (e.start.length < minRuns) continue;
  const phase = { setup: 0, work: 0, shutdown: 0, other: 0 } as Record<
    Phase,
    number
  >;
  for (const p of PHASE_ORDER) {
    phase[p] = e.phase[p].length ? stat(e.phase[p]).med : 0;
  }
  aggregates.push({
    name,
    base: name.replace(/\s*\([^)]*\)\s*$/, ""),
    shardKey: shardKeyOf(name),
    start: stat(e.start),
    end: stat(e.end),
    dur: stat(e.dur),
    count: e.start.length,
    // The deploy/attest tail is "main only" relative to PR runs. Exact-run and
    // main-only charts put every job into start-time tiers.
    mainOnly: RUN_IDS.length || MAIN_ONLY
      ? false
      : !e.events.has("pull_request"),
    phase,
  });
}
if (unmarkedSteps.size) {
  console.error(
    `${unmarkedSteps.size} step name(s) had no phase marker and were counted ` +
      `as "other" (see docs/development/CI_PERFORMANCE.md "Step phase markers"):`,
  );
  for (const n of unmarkedSteps) console.error(`  - ${n}`);
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

// The run finishes when its latest-finishing job ends. Fall back to the full
// job set when no pull-request jobs are present (e.g. a push-only workflow), so
// the subtitle never shows an -Infinity/NaN time. (aggregates is non-empty here.)
const prFinish = Math.max(
  ...(prJobs.length ? prJobs : aggregates).map((j) => j.end.med),
);

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

interface Palette {
  bg: string;
  text: string;
  sub: string;
  grid: string;
  axis: string;
  main: string; // main-branch-only bars
  whisker: string;
  envelope: string; // neutral fill for the min-start..max-end range
  // Phase segment colors. Work is the deep, saturated blue so the job's own work
  // reads as the focus; the shared scaffolding around it — setup and shutdown
  // — share one subtle teal so they recede together, leaving the work standing
  // out between them. "other" marks a step whose name carried no phase marker.
  setup: string;
  work: string;
  shutdown: string;
  other: string;
}
const THEMES: Record<string, Palette> = {
  default: {
    bg: "#ffffff",
    text: "#1f2328",
    sub: "#57606a",
    grid: "#e7e7e7",
    axis: "#8a8a8a",
    main: "#8a897f",
    whisker: "#2a2a2a",
    envelope: "#aab2bd",
    setup: "#6ba7bd",
    work: "#2f6fa8",
    shutdown: "#6ba7bd",
    other: "#c2c8cf",
  },
  dark: {
    bg: "#0d0e11",
    text: "#e7e9ee",
    sub: "#9aa0ab",
    grid: "#23262d",
    axis: "#6a7079",
    main: "#7c828c",
    whisker: "#8a93a5",
    envelope: "#454b54",
    setup: "#345f92",
    work: "#5f9ae6",
    shutdown: "#345f92",
    other: "#5a616b",
  },
};
// --theme picks a base palette; --colors '<json>' then overrides individual keys.
const C: Palette = { ...(THEMES[opt("theme", "default")] ?? THEMES.default) };
const colorsArg = opt("colors", "");
if (colorsArg) {
  // Accept only well-formed hex, rgb() and rgba() values for known palette keys,
  // so an override can't inject markup into the SVG or set a nonsense fill. The
  // rgb/rgba branches require three numeric components (plus an alpha for rgba)
  // so a malformed body like "rgb(,,,)" is rejected and reported, not written
  // into a fill as a color the renderer silently falls back from.
  const COLOR_RE =
    /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$|^rgb\(\s*\d{1,3}%?(?:\s*,\s*\d{1,3}%?){2}\s*\)$|^rgba\(\s*\d{1,3}%?(?:\s*,\s*\d{1,3}%?){2}\s*,\s*\d*\.?\d+%?\s*\)$/;
  try {
    const overrides = JSON.parse(colorsArg) as Record<string, unknown>;
    for (const k of Object.keys(C) as (keyof Palette)[]) {
      const v = overrides[k];
      if (typeof v === "string" && COLOR_RE.test(v)) C[k] = v;
      else if (v !== undefined) {
        console.error(
          `Ignoring invalid --colors value for "${k}": ${JSON.stringify(v)}`,
        );
      }
    }
  } catch {
    console.error("Ignoring invalid --colors JSON.");
  }
}

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
    const xs = x(j.start.min), xe = x(j.end.max);

    // envelope: full min-start to max-end extent
    body.push(
      `<rect x="${xs.toFixed(1)}" y="${top}" width="${
        Math.max(1, xe - xs).toFixed(1)
      }" height="${BAR_H}" rx="2" fill="${C.envelope}" fill-opacity="0.25"/>`,
    );
    // median bar, split into phase segments. Segment widths are the median time
    // in each phase, scaled so they fill the median start-to-finish span.
    const mb = x(j.start.med), me = x(j.end.med);
    const barW = Math.max(2, me - mb);
    const segs = PHASE_ORDER
      .map((p) => ({ p, sec: j.phase[p] }))
      .filter((s) => s.sec > 0);
    const phaseTotal = segs.reduce((sum, s) => sum + s.sec, 0);
    if (phaseTotal > 0) {
      let cum = 0;
      let prevX = mb;
      for (const s of segs) {
        cum += s.sec;
        const nextX = mb + (cum / phaseTotal) * barW;
        body.push(
          `<rect x="${prevX.toFixed(1)}" y="${top}" width="${
            Math.max(0.5, nextX - prevX).toFixed(1)
          }" height="${BAR_H}" fill="${C[s.p]}"/>`,
        );
        prevX = nextX;
      }
    } else {
      // No step timing for this job: fall back to a plain work-colored bar.
      body.push(
        `<rect x="${mb.toFixed(1)}" y="${top}" width="${
          barW.toFixed(1)
        }" height="${BAR_H}" rx="2" fill="${C.work}"/>`,
      );
    }
    if (j.mainOnly) {
      body.push(
        `<rect x="${mb.toFixed(1)}" y="${top}" width="${
          barW.toFixed(1)
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
legendBox(C.setup, false, "setup / shutdown");
legendBox(C.work, false, "work");
if (aggregates.some((j) => j.phase.other > 0)) {
  legendBox(C.other, false, "other (unmarked)");
}
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
const workflowNames = new Set(
  completed.map((run) => run.workflowName).filter((name) => !!name),
);
const workflowLabel = RUN_IDS.length
  ? workflowNames.size === 1 ? [...workflowNames][0] : "selected workflows"
  : WORKFLOW;
const exactRun = RUN_IDS.length === 1 ? completed[0] : null;
const exactBranch = exactRun?.headBranch ? `, ${exactRun.headBranch}` : "";
const titleScope = exactRun
  ? `run ${exactRun.databaseId} (${exactRun.event}${exactBranch})`
  : RUN_IDS.length
  ? `${completed.length} selected runs`
  : `typical ${runKind}`;
const titleCount = RUN_IDS.length
  ? `${completed.length} completed ${completed.length === 1 ? "run" : "runs"}`
  : `median of ${completed.length} completed ${
    MAIN_ONLY ? "main pushes" : "runs"
  }`;
const title = `${REPO} · ${workflowLabel} — ${titleScope} (${titleCount})`;
const subtitle =
  `Bars = median start to finish, split into setup/work/shutdown by step; ` +
  `whiskers = min/max; text = median (min–max) duration; ` +
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
// Write output: the raw SVG when --out ends in .svg, otherwise a rasterized PNG.
// ---------------------------------------------------------------------------

if (OUT.toLowerCase().endsWith(".svg")) {
  await Deno.writeTextFile(OUT, svg);
  console.error(
    `Wrote ${OUT} (${totalW}×${totalH} SVG, ${aggregates.length} jobs)`,
  );
} else {
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
}
