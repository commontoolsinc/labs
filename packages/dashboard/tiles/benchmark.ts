// benchmark: trends one runtime benchmark's p99 over ~45 days, from the deno bench
// results the benchmarks.yml job publishes on main. That job runs
// `deno bench --json` and uploads the output as a `bench-results` artifact (90-day
// retention); there is no committed history, so this tile lists recent benchmark
// runs on main, downloads one artifact per 4-hour window, unzips it in-process,
// and reads every benchmark's timings. Results per run are immutable, so they are
// cached and only new runs are fetched after the first fill.
//
// The grid tile shows one benchmark (BENCH_METRIC, default DEFAULT_METRIC; else
// the slowest). Its /bench drill-down shows every benchmark, with a selector for
// which measurement to plot. Colour follows the 45-day trend: green while flat or
// falling, orange past UP_PCT, red past RAPID_PCT ("trending up rapidly").
import type { Route, Status, Tile, TileView } from "../types.ts";
import { escapeHtml, friendlyError, github, humanSpan, SPARK_FADE, sparkline } from "../lib.ts";
import { REPO } from "../config.ts";

const WORKFLOW = "benchmarks.yml";
const ARTIFACT = "bench-results";
const SPARK_DAYS = 45;
const BUCKET_MS = 4 * 3_600_000; // sample one run per 4-hour window
const UP_PCT = 0.05; // 45-day rise past this -> orange (trending up)
const RAPID_PCT = 0.20; // ...past this -> red (trending up rapidly)
const MIN_TREND_DAYS = 7; // fewer distinct days than this -> no trend claim (too little data)
const DEFAULT_METRIC = "scheduler-persistent-state.bench.ts";

// deno bench reports these seven timings per benchmark (all nanoseconds).
interface Stats {
  min: number;
  avg: number;
  max: number;
  p75: number;
  p99: number;
  p995: number;
  p999: number;
}
// Shown as one percentile ladder: min is p0, the average stands in for p50, max is
// p100. (avg is the mean, not a true median, but reads consistently here.)
const STATS: { label: string; field: keyof Stats }[] = [
  { label: "p0", field: "min" },
  { label: "p50", field: "avg" },
  { label: "p75", field: "p75" },
  { label: "p99", field: "p99" },
  { label: "p99.5", field: "p995" },
  { label: "p99.9", field: "p999" },
  { label: "p100", field: "max" },
];
const TILE_STAT: keyof Stats = "p99"; // the grid tile plots p99
const DEFAULT_LABEL = "p99";

interface Run {
  id: number;
  created_at: string;
  conclusion: string | null;
}
interface Artifact {
  id: number;
  name: string;
  expired: boolean;
}
interface Bench {
  origin: string;
  group: string | null;
  name: string;
  results: { ok?: Partial<Stats> }[];
}

// runId -> { benchmark key -> timings }. A completed run's results never change,
// so this is a permanent per-process cache; a run with no usable artifact caches
// an empty map so it isn't retried every refresh.
const cache = new Map<number, Map<string, Stats>>();
// Assembled by collect() for the /bench drill-down: each benchmark key with its
// timings over the covered days (oldest -> newest).
let snapshot: { key: string; points: { at: number; stats: Stats }[] }[] = [];

const benchKey = (b: Bench): string =>
  `${b.origin.replace(/^file:\/\/.*\/packages\//, "packages/")} > ${b.group ? b.group + "/" : ""}${b.name}`;

// Deterministic, well-spread hash of a small integer. Used to rotate the grid
// tile's benchmark by clock-hour: the same hour yields the same index on any
// machine (no Math.random, no stored state), so a fresh dashboard elsewhere picks
// the same benchmark for the same hour.
function hashInt(n: number): number {
  let x = n >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

const median = (a: number[]): number => {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Overall trend as the fractional change of a robust fit across the displayed
// range (+0.2 ≈ the fit ends 20% higher than it starts; negative when improving).
//
// Collapse the sub-daily samples to one median value per calendar day, then take
// the Theil–Sen slope (median of pairwise log-slopes per day) across days, and
// project it over the day span. Three robustness layers: the daily median absorbs
// within-day spikes; the median-of-slopes tolerates ~29% outlier days (versus 0%
// for least squares, which one point can swing); and working per day — not per
// sample or per millisecond — makes it time-aware without letting two noisy points
// a few hours apart blow up the slope (a big Δlog over a tiny Δt), which naive
// per-millisecond weighting does. `times` must be ascending. Exported for tests.
export function trendPct(times: number[], values: number[]): number {
  const byDay = new Map<number, number[]>();
  for (let i = 0; i < values.length; i++) {
    if (values[i] <= 0) continue;
    const d = Math.floor(times[i] / 86_400_000);
    const arr = byDay.get(d);
    if (arr) arr.push(values[i]);
    else byDay.set(d, [values[i]]);
  }
  const days = [...byDay.keys()].sort((a, b) => a - b);
  if (days.length < MIN_TREND_DAYS) return 0; // too few days to claim a trend
  const daily = days.map((d) => median(byDay.get(d)!));
  const slopes: number[] = [];
  for (let i = 0; i < days.length; i++) {
    for (let j = i + 1; j < days.length; j++) {
      slopes.push((Math.log(daily[j]) - Math.log(daily[i])) / (days[j] - days[i]));
    }
  }
  return Math.expm1(median(slopes) * (days[days.length - 1] - days[0]));
}

export function trendStatus(pct: number): Status {
  return pct <= UP_PCT ? "good" : pct <= RAPID_PCT ? "warn" : "bad";
}

// A percent for modest moves; a fold multiplier once it passes 4x either way, so a
// real step-change regression reads "▲44×" rather than "▲4297%".
const trendPctLabel = (pct: number): string => {
  const up = pct + 1; // end / start
  const fold = (f: number) => f >= 10 ? f.toFixed(0) : f.toFixed(1);
  if (up >= 4) return `▲${fold(up)}×`;
  if (up > 0 && 1 / up >= 4) return `▼${fold(1 / up)}×`;
  const p = Math.round(pct * 100);
  return p > 0 ? `▲${p}%` : p < 0 ? `▼${-p}%` : "flat";
};

// Wall-clock span of a series (first to last point), in milliseconds.
const spanMs = (points: { at: number }[]): number =>
  points.length < 2 ? 0 : points[points.length - 1].at - points[0].at;

// Nanoseconds to a short human string.
export function formatNs(ns: number): string {
  if (!Number.isFinite(ns)) return "—";
  if (ns < 1e3) return `${Math.round(ns)}ns`;
  if (ns < 1e6) return `${(ns / 1e3).toFixed(ns < 1e4 ? 1 : 0)}µs`;
  if (ns < 1e9) return `${(ns / 1e6).toFixed(ns < 1e7 ? 1 : 0)}ms`;
  return `${(ns / 1e9).toFixed(2)}s`;
}

// Pick the key to plot on the grid tile: first containing `want`, else containing
// DEFAULT_METRIC, else the slowest single benchmark (by p99).
function pickKey(stats: Map<string, Stats>, want: string): string | undefined {
  const has = (needle: string) => [...stats.keys()].find((k) => k.toLowerCase().includes(needle.toLowerCase()));
  const match = has(want) ?? has(DEFAULT_METRIC);
  if (match) return match;
  let best: string | undefined, bestV = -Infinity;
  for (const [k, s] of stats) if (s.p99 > bestV) [best, bestV] = [k, s.p99];
  return best;
}

// deno bench --json -> { benchmark key -> timings }. A benchmark's own console
// output can precede the JSON report on stdout, so parse from the report object.
function benchMetrics(json: string): Map<string, Stats> {
  const at = json.match(/\{\s*"version"\s*:/);
  const data = JSON.parse(at ? json.slice(at.index) : json) as { benches?: Bench[] };
  const m = new Map<string, Stats>();
  for (const b of data.benches ?? []) {
    const ok = b.results?.[0]?.ok;
    if (!ok || typeof ok.avg !== "number") continue;
    const n = (v: number | undefined, d: number) => typeof v === "number" ? v : d;
    m.set(benchKey(b), {
      min: n(ok.min, ok.avg),
      avg: ok.avg,
      max: n(ok.max, ok.avg),
      p75: n(ok.p75, ok.avg),
      p99: n(ok.p99, ok.avg),
      p995: n(ok.p995, ok.avg),
      p999: n(ok.p999, ok.avg),
    });
  }
  return m;
}

// Inflate raw-deflate bytes (the compression zip uses) to their decompressed form.
async function inflateRaw(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate-raw");
  const collected = new Response(ds.readable).arrayBuffer(); // read as we write
  const writer = ds.writable.getWriter();
  await writer.write(data);
  await writer.close();
  return new Uint8Array(await collected);
}

// Extract the first *.json file from a zip via its central directory (which holds
// the true sizes even when a streamed zip leaves them out of the local headers).
export async function jsonFromZip(buf: Uint8Array<ArrayBuffer>): Promise<string | null> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const u16 = (o: number) => dv.getUint16(o, true);
  const u32 = (o: number) => dv.getUint32(o, true);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 0x10000; i--) {
    if (u32(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  let p = u32(eocd + 16); // central directory offset
  const count = u16(eocd + 10);
  for (let n = 0; n < count; n++) {
    if (u32(p) !== 0x02014b50) break; // central-directory file header signature
    const method = u16(p + 10);
    const compSize = u32(p + 20);
    const nameLen = u16(p + 28), extraLen = u16(p + 30), commentLen = u16(p + 32);
    const lho = u32(p + 42); // local header offset
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (!name.endsWith(".json")) continue;
    if (u32(lho) !== 0x04034b50) return null; // local file header signature
    const dataStart = lho + 30 + u16(lho + 26) + u16(lho + 28);
    const comp = buf.subarray(dataStart, dataStart + compSize);
    const bytes = method === 0 ? comp : method === 8 ? await inflateRaw(comp) : null;
    return bytes ? new TextDecoder().decode(bytes) : null;
  }
  return null;
}

async function fetchZip(artifactId: number, token: string): Promise<Uint8Array<ArrayBuffer>> {
  // GitHub 302s to a pre-signed blob URL; fetch follows it and drops the
  // Authorization header on the cross-origin hop, which the signed URL expects.
  const res = await fetch(`https://api.github.com/repos/${REPO}/actions/artifacts/${artifactId}/zip`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`artifact ${artifactId}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

// Populate the cache for one run (best-effort; caches empty on any failure so an
// expired or missing artifact isn't retried every refresh).
async function loadRun(runId: number, token: string): Promise<void> {
  let metrics = new Map<string, Stats>();
  try {
    const arts = await github<{ artifacts?: Artifact[] }>(`repos/${REPO}/actions/runs/${runId}/artifacts`, token);
    const art = (arts.artifacts ?? []).find((a) => a.name === ARTIFACT && !a.expired);
    if (art) {
      const json = await jsonFromZip(await fetchZip(art.id, token));
      if (json) metrics = benchMetrics(json);
    }
  } catch { /* leave empty; the run is immutable so caching avoids refetching */ }
  cache.set(runId, metrics);
}

// The stats series (oldest -> newest) for one benchmark key across the given runs.
function seriesFor(key: string, runs: Run[]): { at: number; stats: Stats }[] {
  const out: { at: number; stats: Stats }[] = [];
  for (const r of runs) {
    const s = cache.get(r.id)?.get(key);
    if (s) out.push({ at: Date.parse(r.created_at), stats: s });
  }
  return out;
}

export const benchmark: Tile = {
  id: "benchmark",
  intervalMs: 3_600_000,
  routes: [
    {
      path: "/bench",
      handler: (_req, url) =>
        new Response(
          benchPage(url.searchParams.get("stat") ?? DEFAULT_LABEL, url.searchParams.get("sort") ?? "file"),
          { headers: { "content-type": "text/html; charset=utf-8" } },
        ),
    },
  ] satisfies Route[],
  async collect(ctx): Promise<TileView> {
    const label = "benchmark";
    const token = ctx.env("GH_TOKEN") ?? ctx.env("GITHUB_TOKEN");
    if (!token) return { label, status: "unknown", value: "—", sub: "set GH_TOKEN" };
    const drill = { href: "/bench", hint: "all metrics ↗" };
    const cutoff = Date.now() - SPARK_DAYS * 86_400_000;

    try {
      // Recent benchmark runs on main, paging back until past the window. The job
      // runs on both pushes to main and a 4-hourly schedule, which carry different
      // event types (push vs schedule) but the same bench-results artifact, so this
      // is not filtered by event — a push-only filter misses every scheduled run.
      // Enough pages to reach ~45 days back; the 4-hour bucketing below still caps
      // artifact downloads at one per bucket.
      const runs: Run[] = [];
      for (let page = 1; page <= 12; page++) {
        const r = await github<{ workflow_runs?: Run[] }>(
          `repos/${REPO}/actions/workflows/${WORKFLOW}/runs?branch=main&per_page=100&page=${page}`,
          token,
        );
        const batch = r.workflow_runs ?? [];
        if (!batch.length) break;
        runs.push(...batch);
        if (batch.length < 100 || Date.parse(batch[batch.length - 1].created_at) < cutoff) break;
      }

      // Newest successful run per 4-hour window within the range, oldest -> newest.
      const perBucket = new Map<number, Run>();
      for (const run of runs) {
        const t = Date.parse(run.created_at);
        if (run.conclusion !== "success" || t < cutoff) continue;
        const bucket = Math.floor(t / BUCKET_MS);
        const cur = perBucket.get(bucket);
        if (!cur || t > Date.parse(cur.created_at)) perBucket.set(bucket, run);
      }
      const chosen = [...perBucket.values()].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
      if (!chosen.length) return { ...drill, label, status: "unknown", value: "—", sub: "no benchmark runs" };

      // Fill the cache for any new runs, a few artifacts at a time. 4-hour
      // sampling means more buckets, so the first fill downloads more.
      const missing = chosen.filter((r) => !cache.has(r.id));
      for (let i = 0; i < missing.length; i += 8) {
        await Promise.all(missing.slice(i, i + 8).map((r) => loadRun(r.id, token)));
      }

      const withData = chosen.filter((r) => (cache.get(r.id)?.size ?? 0) > 0);
      if (!withData.length) return { ...drill, label, status: "unknown", value: "—", sub: "benchmark data unavailable" };

      // Assemble every benchmark's series for the drill-down page.
      const keys = new Set<string>();
      for (const r of withData) for (const k of cache.get(r.id)!.keys()) keys.add(k);
      snapshot = [...keys]
        .map((key) => ({ key, points: seriesFor(key, withData) }))
        .filter((s) => s.points.length >= 2)
        .sort((a, b) => (a.key < b.key ? -1 : 1));

      // The grid tile plots one benchmark's p99. BENCH_METRIC pins it to a
      // specific benchmark; otherwise it rotates — one benchmark per clock-hour,
      // chosen deterministically so a fresh dashboard on another machine shows the
      // same one for the same hour.
      const pinned = ctx.env("BENCH_METRIC");
      const series = pinned
        ? (snapshot.find((s) => s.key === pickKey(cache.get(withData[withData.length - 1].id)!, pinned)) ??
          snapshot[0])
        : snapshot[hashInt(Math.floor(Date.now() / 3_600_000)) % snapshot.length];
      if (!series) return { ...drill, label, status: "unknown", value: "—", sub: "no metric" };
      const pts = series.points.map((p) => p.stats[TILE_STAT]);
      const pct = trendPct(series.points.map((p) => p.at), pts);
      const status = trendStatus(pct);
      // Test name and its p99 trend on one line, the name ellipsized when long.
      const name = series.key.split(" > ").slice(1).join(" > ") || series.key;
      const line = `<div style="display:flex;align-items:baseline;gap:6px;font-size:13px;margin:5px 0 0">` +
        `<span style="flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#9aa0ab">${escapeHtml(name)}</span>` +
        `<span style="flex:none;color:#c7ccd4">${DEFAULT_LABEL} ${escapeHtml(trendPctLabel(pct))}</span></div>`;
      return {
        ...drill,
        label,
        status,
        value: formatNs(pts[pts.length - 1]),
        extra: `${line}${sparkline(pts, "#727882", undefined, humanSpan(spanMs(series.points)), SPARK_FADE[status])}`,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ...drill, label, status: "unknown", value: "—", sub: friendlyError(msg) };
    }
  },
};

// The /bench drill-down: every benchmark's sparkline for the chosen measurement,
// grouped by source file, each coloured by its own trend.
function benchPage(statLabel: string, sortMode: string): string {
  const stat = STATS.find((s) => s.label === statLabel) ?? STATS.find((s) => s.label === DEFAULT_LABEL)!;
  const sort = sortMode === "trend" ? "trend" : "file";
  const href = (st: string, so: string) => `/bench?stat=${encodeURIComponent(st)}&sort=${so}`;
  const statSel = STATS.map((s) =>
    `<a class="stat${s.label === stat.label ? " on" : ""}" href="${href(s.label, sort)}">${s.label}</a>`
  ).join("");
  const sortSel = (["file", "trend"] as const).map((so) =>
    `<a class="stat${sort === so ? " on" : ""}" href="${href(stat.label, so)}">${so}</a>`
  ).join("");

  let body: string;
  if (!snapshot.length) {
    body = `<p class="empty">Collecting benchmark data from CI artifacts — reload in a moment.</p>`;
  } else {
    // A shared calendar-time axis for every graph: points sit at their real time,
    // so a late-starting benchmark sits at the right and a stale one visibly ends
    // short of it. (A benchmark with no data in the range never reaches snapshot —
    // it requires >= 2 in-window points — so nothing empty is drawn.)
    let axisStart = Infinity, axisEnd = -Infinity;
    for (const s of snapshot) {
      for (const p of s.points) {
        if (p.at < axisStart) axisStart = p.at;
        if (p.at > axisEnd) axisEnd = p.at;
      }
    }
    const axisSpan = axisEnd - axisStart || 1;
    // Per-benchmark render data; the trend is computed once, for the colour, the
    // label, and the trend sort.
    const rows = snapshot.map((s) => {
      const pts = s.points.map((p) => p.stats[stat.field]);
      const pct = trendPct(s.points.map((p) => p.at), pts);
      const st = trendStatus(pct);
      const xs = s.points.map((p) => (p.at - axisStart) / axisSpan);
      const spark = sparkline(pts, "#727882", undefined, humanSpan(spanMs(s.points)), SPARK_FADE[st], xs);
      return { key: s.key, file: s.key.split(" > ")[0], pct, st, spark, latest: pts[pts.length - 1] };
    });
    const rowHtml = (r: (typeof rows)[number], label: string) =>
      `<div class="brow ${r.st}"><div class="bspark">${r.spark}</div><div class="bmeta">` +
      `<span class="bname">${escapeHtml(label)}</span>` +
      `<span class="bval">${formatNs(r.latest)}<span class="btrend">${escapeHtml(trendPctLabel(r.pct))}</span></span>` +
      `</div></div>`;
    if (sort === "trend") {
      // Flat list, biggest rise first; show the full key since there's no heading.
      body = `<div class="blist">${
        [...rows].sort((a, b) => b.pct - a.pct).map((r) => rowHtml(r, r.key)).join("")
      }</div>`;
    } else {
      // Grouped by source file, in the snapshot's alphabetical order.
      const groups = new Map<string, typeof rows>();
      for (const r of rows) {
        const arr = groups.get(r.file);
        if (arr) arr.push(r);
        else groups.set(r.file, [r]);
      }
      body = [...groups.entries()].map(([file, rs]) =>
        `<section><h2>${escapeHtml(file)}</h2><div class="blist">${
          rs.map((r) => rowHtml(r, r.key.split(" > ").slice(1).join(" > ") || r.key)).join("")
        }</div></section>`
      ).join("");
    }
  }

  return `<!doctype html><html><head><meta charset="utf-8"><title>Benchmarks — ${escapeHtml(stat.label)}</title>
<style>
  body{margin:0;background:#0d0e11;color:#e7e9ee;font-family:-apple-system,Segoe UI,Roboto,sans-serif;padding:18px 20px 26px;max-width:1100px;margin:0 auto}
  .top{display:flex;align-items:baseline;gap:10px;margin-bottom:14px}
  .top b{font-size:16px;font-weight:600}.top span{font-size:12px;color:#6f757f}
  a.back{color:#6ea8fe;text-decoration:none;font-size:13px}
  .controls{display:flex;flex-wrap:wrap;align-items:center;gap:6px;background:#16181d;border:1px solid #23262d;border-radius:12px;padding:12px 14px;margin-bottom:8px}
  .controls .lbl{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#878d97;margin-right:6px}
  a.stat{font-size:13px;color:#c7ccd4;text-decoration:none;border:1px solid #2f333c;border-radius:6px;padding:3px 9px;font-variant-numeric:tabular-nums}
  a.stat:hover{border-color:#3a4150}
  a.stat.on{background:#6ea8fe;border-color:#6ea8fe;color:#0d0e11;font-weight:600}
  .legend{font-size:11px;color:#666c76;margin:0 0 16px}
  h2{font-size:12px;letter-spacing:.04em;color:#878d97;font-weight:600;margin:20px 0 8px;font-family:ui-monospace,Menlo,monospace}
  .blist{display:flex;flex-direction:column;gap:7px}
  .brow{display:flex;align-items:center;gap:18px;background:#16181d;border:1px solid #23262d;border-radius:10px;padding:8px 14px}
  .brow.good{border-color:rgba(67,197,116,.34);background:rgba(67,197,116,.06)}
  .brow.warn{border-color:rgba(224,168,82,.42);background:rgba(224,168,82,.07)}
  .brow.bad{border-color:rgba(226,80,74,.5);background:rgba(226,80,74,.09)}
  .bmeta{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px}
  .bname{font-size:13px;color:#c7ccd4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .bval{font-size:18px;font-weight:600;font-variant-numeric:tabular-nums}
  .btrend{font-size:12px;font-weight:400;color:#9aa0ab;margin-left:8px}
  .bspark{flex:0 0 42%;min-width:0}
  .bspark>div,.bspark>svg{margin-top:0!important}
  .empty{color:#9aa0ab;font-size:14px}
  .note{font-size:11px;color:#666c76;margin-top:22px}
  .note a{color:#6ea8fe;text-decoration:none}
  label.chk{font-size:13px;color:#c7ccd4;display:inline-flex;align-items:center;gap:6px;margin-left:auto;cursor:pointer;user-select:none}
  body.hide-green .brow.good{display:none}
  body.hide-green section:not(:has(.brow:not(.good))){display:none}
</style></head><body>
  <div class="top"><a class="back" href="/">← dashboard</a><b>Benchmarks</b><span>${escapeHtml(REPO)} · ${WORKFLOW}</span></div>
  <div class="controls"><span class="lbl">metric</span>${statSel}<span class="lbl">sort</span>${sortSel}<label class="chk"><input type="checkbox" id="hg"> hide green</label></div>
  <p class="legend">Percentile of per-op time across a run's samples — p0 = min, p50 = mean, p100 = max. Lower is faster; the grid tile tracks p99. Coloured by the ~45-day trend.</p>
  ${body}
  <p class="note">One CI run sampled per 4-hour window on main, from the <a href="https://github.com/${REPO}/actions/workflows/${WORKFLOW}" target="_blank" rel="noopener">${WORKFLOW} runs ↗</a> (deno bench artifacts).</p>
<script>
  const hg = document.getElementById("hg"), KEY = "benchHideGreen";
  const apply = () => document.body.classList.toggle("hide-green", hg.checked);
  hg.checked = sessionStorage.getItem(KEY) === "1";
  apply();
  hg.addEventListener("change", () => {
    sessionStorage.setItem(KEY, hg.checked ? "1" : "0");
    apply();
  });
</script>
</body></html>`;
}
