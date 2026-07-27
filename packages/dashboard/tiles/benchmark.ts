// benchmark: trends one runtime benchmark's p99 over ~45 days, from the deno bench
// results the benchmarks.yml job publishes on main. That job runs
// `deno bench --json` and uploads the output as a `bench-results` artifact (90-day
// retention); there is no committed history, so this tile lists recent benchmark
// runs on main, keeps one artifact per shortest-view time bucket, unzips it
// in-process, and reads every benchmark's timings. Results per run attempt are
// immutable and persisted, so only new runs and attempts are fetched later.
//
// The grid tile shows one benchmark (BENCH_METRIC, default DEFAULT_METRIC; else
// the slowest). Its /bench drill-down shows every benchmark, with a selector for
// which measurement to plot. Colour follows the 45-day trend: green while flat or
// falling, orange past UP_PCT, red past RAPID_PCT ("trending up rapidly").
import type { Ctx, Route, Status, Tile, TileView } from "../types.ts";
import {
  BenchmarkHistoryStore,
  type BenchmarkRefreshResult,
  type BenchmarkStats,
  type CachedBenchmarkRun,
} from "../benchmark-history-cache.ts";
import {
  CI_HISTORY_DAYS,
  CI_HISTORY_MIN_DAYS,
  CI_HISTORY_POINT_TARGET,
  ciHistoryBucketMs,
  ciHistoryDays,
  ciHistorySource,
  type CiHistorySourceKey,
  ciJobHistoryCheckResponse,
  ciJobHistoryProgressResponse,
  ciJobHistoryResponse,
} from "../ci-job-history.ts";
import {
  durationTag,
  escapeHtml,
  friendlyError,
  github,
  githubDownload,
  performanceGithub,
  performanceGithubDownload,
  SPARK_FADE,
  sparkline,
} from "../lib.ts";
import { REPO } from "../config.ts";
import {
  PERFORMANCE_CHECK_MS,
  performanceViewHref,
  performanceViewNav,
} from "../performance-views.ts";
import {
  distinctTrendDays,
  trendPct,
  trendPctLabel,
  trendStatus,
} from "../trend.ts";
import { ciGanttPage } from "./ci-duration.ts";

export { trendPct, trendStatus } from "../trend.ts";

export function benchmarkTrend(
  times: number[],
  values: number[],
): { pct: number; status: Status; label: string } {
  if (distinctTrendDays(times, values) < 7) {
    return { pct: 0, status: "unknown", label: "new" };
  }
  const pct = trendPct(times, values);
  return { pct, status: trendStatus(pct), label: trendPctLabel(pct) };
}

const WORKFLOW = "benchmarks.yml";
const ARTIFACT = "bench-results";
const SPARK_DAYS = CI_HISTORY_DAYS;
const COLLECTION_BUCKET_MS = ciHistoryBucketMs(CI_HISTORY_MIN_DAYS);
const DEFAULT_METRIC = "scheduler-persistent-state.bench.ts";
const BENCHMARK_REFRESH_MS = 30 * 60_000;
const BENCHMARK_FETCH_CONCURRENCY = 8;

interface BenchmarkGitHub {
  json<T>(path: string, token: string): Promise<T>;
  download(path: string, token: string): Promise<Response>;
}

const ordinaryBenchmarkGitHub: BenchmarkGitHub = {
  json: github,
  download: githubDownload,
};
const performanceBenchmarkGitHub: BenchmarkGitHub = {
  json: performanceGithub,
  download: performanceGithubDownload,
};

// deno bench reports these seven timings per benchmark (all nanoseconds).
type Stats = BenchmarkStats;
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
  run_attempt?: number;
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

const benchmarkStore = new BenchmarkHistoryStore();
// Assembled by collect() for the /bench drill-down: each benchmark key with its
// timings over the covered days (oldest -> newest).
interface BenchmarkSeries {
  key: string;
  points: { at: number; stats: Stats }[];
}

let snapshot: BenchmarkSeries[] = [];
let benchmarkEmptyReason: string | undefined;

export type BenchmarkFetchPhase =
  | "discovering"
  | "fetching"
  | "saving"
  | "complete"
  | "error";

export interface BenchmarkFetchProgress {
  id: string;
  phase: BenchmarkFetchPhase;
  totalRuns: number;
  cachedRuns: number;
  requestsMade: number;
  responsesReceived: number;
  successfulResponses: number;
  failedResponses: number;
  completedRuns: number;
  queuedRuns: number;
  outstandingRequests: number;
  needsReload: boolean;
  updatedAt: number;
  error?: string;
}

interface BenchmarkProgressRecord {
  state: BenchmarkFetchProgress;
  listeners: Set<(progress: BenchmarkFetchProgress) => void>;
  baselines: Set<string>;
}

interface BenchmarkRefresh {
  progress: BenchmarkFetchProgress | null;
  result: Promise<TileView>;
}

type BenchmarkRefreshScope = "bench" | "dashboard";

const activeBenchmarkRefreshes = new Map<BenchmarkRefreshScope, {
  progress: BenchmarkProgressRecord;
  result: Promise<TileView>;
}>();
let benchmarkCollectionTail: Promise<void> = Promise.resolve();
let benchmarkProgressSequence = 0;
let benchmarkRefreshedAt = 0;
let benchmarkRefreshFailedAt = 0;
let benchmarkRefreshError = "";
let benchmarkInitialCollection = true;
const benchmarkProgressById = new Map<string, BenchmarkProgressRecord>();

function benchmarkVersion(value: BenchmarkSeries[]): string {
  const serialized = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < serialized.length; index++) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function benchmarkSnapshotVersion(): string {
  return benchmarkVersion(snapshot);
}

function newBenchmarkProgress(baseline?: string): BenchmarkProgressRecord {
  for (const [id, record] of benchmarkProgressById) {
    if (record.state.phase === "complete" || record.state.phase === "error") {
      benchmarkProgressById.delete(id);
    }
  }
  const now = Date.now();
  const record: BenchmarkProgressRecord = {
    state: {
      id: `runtime-${now.toString(36)}-${++benchmarkProgressSequence}`,
      phase: "discovering",
      totalRuns: 0,
      cachedRuns: 0,
      requestsMade: 0,
      responsesReceived: 0,
      successfulResponses: 0,
      failedResponses: 0,
      completedRuns: 0,
      queuedRuns: 0,
      outstandingRequests: 0,
      needsReload: false,
      updatedAt: now,
    },
    listeners: new Set(),
    baselines: new Set(baseline === undefined ? [] : [baseline]),
  };
  benchmarkProgressById.set(record.state.id, record);
  return record;
}

function updateBenchmarkProgress(
  record: BenchmarkProgressRecord,
  update: Partial<BenchmarkFetchProgress>,
): void {
  Object.assign(record.state, update);
  record.state.completedRuns = Math.min(
    record.state.totalRuns,
    record.state.cachedRuns + record.state.responsesReceived,
  );
  record.state.queuedRuns = Math.max(
    0,
    record.state.totalRuns - record.state.cachedRuns -
      record.state.requestsMade,
  );
  record.state.outstandingRequests = Math.max(
    0,
    record.state.requestsMade - record.state.responsesReceived,
  );
  record.state.updatedAt = Date.now();
  const value = { ...record.state };
  for (const listener of record.listeners) {
    try {
      listener(value);
    } catch {
      record.listeners.delete(listener);
    }
  }
}

function benchmarkProgress(id: string): BenchmarkFetchProgress | null {
  const record = benchmarkProgressById.get(id);
  return record ? { ...record.state } : null;
}

export function subscribeBenchmarkProgress(
  id: string,
  listener: (progress: BenchmarkFetchProgress) => void,
): (() => void) | null {
  const record = benchmarkProgressById.get(id);
  if (!record) return null;
  record.listeners.add(listener);
  try {
    listener({ ...record.state });
  } catch {
    record.listeners.delete(listener);
    return null;
  }
  return () => record.listeners.delete(listener);
}

const benchKey = (b: Bench): string =>
  `${b.origin.replace(/^file:\/\/.*\/packages\//, "packages/")} > ${
    b.group ? b.group + "/" : ""
  }${b.name}`;

function pickKey(stats: Map<string, Stats>, want: string): string | undefined {
  const has = (needle: string) =>
    [...stats.keys()].find((key) =>
      key.toLowerCase().includes(needle.toLowerCase())
    );
  const match = has(want) ?? has(DEFAULT_METRIC);
  if (match) return match;
  let best: string | undefined;
  let bestValue = -Infinity;
  for (const [key, value] of stats) {
    if (value.p99 > bestValue) {
      best = key;
      bestValue = value.p99;
    }
  }
  return best;
}

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

// deno bench --json -> { benchmark key -> timings }. A benchmark's own console
// output can precede the JSON report on stdout, so parse from the report object.
function benchMetrics(json: string): Map<string, Stats> {
  const at = json.match(/\{\s*"version"\s*:/);
  const data = JSON.parse(at ? json.slice(at.index) : json) as {
    benches?: Bench[];
  };
  const m = new Map<string, Stats>();
  for (const b of data.benches ?? []) {
    const ok = b.results?.[0]?.ok;
    if (!ok || typeof ok.avg !== "number") continue;
    const n = (v: number | undefined, d: number) =>
      typeof v === "number" ? v : d;
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
export async function jsonFromZip(
  buf: Uint8Array<ArrayBuffer>,
): Promise<string | null> {
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
    const nameLen = u16(p + 28),
      extraLen = u16(p + 30),
      commentLen = u16(p + 32);
    const lho = u32(p + 42); // local header offset
    const name = new TextDecoder().decode(
      buf.subarray(p + 46, p + 46 + nameLen),
    );
    p += 46 + nameLen + extraLen + commentLen;
    if (!name.endsWith(".json")) continue;
    if (u32(lho) !== 0x04034b50) return null; // local file header signature
    const dataStart = lho + 30 + u16(lho + 26) + u16(lho + 28);
    const comp = buf.subarray(dataStart, dataStart + compSize);
    const bytes = method === 0
      ? comp
      : method === 8
      ? await inflateRaw(comp)
      : null;
    return bytes ? new TextDecoder().decode(bytes) : null;
  }
  return null;
}

async function fetchZip(
  artifactId: number,
  token: string,
  github: BenchmarkGitHub,
): Promise<Uint8Array<ArrayBuffer>> {
  // GitHub 302s to a pre-signed blob URL; fetch follows it and drops the
  // Authorization header on the cross-origin hop, which the signed URL expects.
  const res = await github.download(
    `repos/${REPO}/actions/artifacts/${artifactId}/zip`,
    token,
  );
  if (!res.ok) throw new Error(`artifact ${artifactId}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

// Populate and persist one run. A response that establishes there is no usable
// artifact is cached as an empty map. A failed read remains unknown.
async function loadRun(
  run: Run,
  token: string,
  github: BenchmarkGitHub,
): Promise<{ cached: boolean; error?: unknown }> {
  let metrics = new Map<string, Stats>();
  try {
    const arts = await github.json<{ artifacts?: Artifact[] }>(
      `repos/${REPO}/actions/runs/${run.id}/artifacts`,
      token,
    );
    const art = (arts.artifacts ?? []).find((a) =>
      a.name === ARTIFACT && !a.expired
    );
    if (art) {
      const json = await jsonFromZip(await fetchZip(art.id, token, github));
      if (json) metrics = benchMetrics(json);
    }
  } catch (error) {
    // The read failed, so whether this run has usable results is still unknown.
    // Caching the empty map here would answer that question with "no" and never ask
    // again: the run is only ever fetched once, so a single blip would drop the run
    // from the trend for the life of the process. Record nothing and retry on the
    // next refresh.
    return { cached: false, error };
  }
  benchmarkStore.set({
    runId: run.id,
    runAttempt: run.run_attempt ?? 1,
    at: Date.parse(run.created_at),
    metrics,
  });
  await benchmarkStore.save();
  return { cached: true };
}

// The stats series (oldest -> newest) for one benchmark key across the given runs.
function seriesFor(key: string, runs: Run[]): { at: number; stats: Stats }[] {
  const out: { at: number; stats: Stats }[] = [];
  for (const r of runs) {
    const s = currentRunMetrics(r)?.get(key);
    if (s) out.push({ at: Date.parse(r.created_at), stats: s });
  }
  return out;
}

function currentRunMetrics(run: Run): Map<string, Stats> | undefined {
  const cached = benchmarkStore.get(run.id);
  return cached && cached.runAttempt >= (run.run_attempt ?? 1)
    ? cached.metrics
    : undefined;
}

function assembleBenchmarkSnapshot(runs: Run[]): BenchmarkSeries[] {
  const withData = runs.filter((run) =>
    (currentRunMetrics(run)?.size ?? 0) > 0
  );
  const keys = new Set<string>();
  for (const run of withData) {
    for (const key of currentRunMetrics(run)!.keys()) keys.add(key);
  }
  return [...keys]
    .map((key) => ({ key, points: seriesFor(key, withData) }))
    .filter((series) => series.points.length >= 2)
    .sort((a, b) => a.key.localeCompare(b.key));
}

function assembleCachedBenchmarkSnapshot(
  runs: CachedBenchmarkRun[],
): BenchmarkSeries[] {
  const keys = new Set(runs.flatMap((run) => [...run.metrics.keys()]));
  return [...keys]
    .map((key) => ({
      key,
      points: runs.flatMap((run) => {
        const stats = run.metrics.get(key);
        return stats ? [{ at: run.at, stats }] : [];
      }),
    }))
    .filter((series) => series.points.length >= 2)
    .sort((a, b) => a.key.localeCompare(b.key));
}

async function loadCachedBenchmarkSnapshot(now = Date.now()): Promise<void> {
  await benchmarkStore.load();
  if (benchmarkStore.quarantineFuture(now)) {
    await benchmarkStore.save(now);
  }
  benchmarkRefreshedAt = benchmarkStore.refreshedAt;
  const refresh = benchmarkStore.refresh;
  benchmarkEmptyReason = refresh?.result === "no-runs"
    ? "no benchmark runs"
    : refresh?.result === "data-unavailable"
    ? "benchmark data unavailable"
    : refresh?.result === "no-metric"
    ? "no metric"
    : undefined;
  const cutoff = now - SPARK_DAYS * 86_400_000;
  const refreshedRuns = benchmarkStore.refreshedRuns();
  const cachedRuns = refreshedRuns ?? benchmarkStore.list(cutoff);
  if (refreshedRuns === null) {
    const available = cachedRuns.map((run) => ({
      id: run.runId,
      run_attempt: run.runAttempt,
      created_at: new Date(run.at).toISOString(),
      conclusion: "success",
    }));
    snapshot = assembleBenchmarkSnapshot(
      sampleBenchmarkRuns(available, cutoff),
    );
  } else {
    snapshot = assembleCachedBenchmarkSnapshot(refreshedRuns);
  }
}

async function markBenchmarkRefreshed(
  runs: Run[],
  result: BenchmarkRefreshResult,
): Promise<void> {
  const cachedRuns = runs.map((run) => benchmarkStore.get(run.id)!);
  const previous = benchmarkStore.markRefreshed(
    Date.now(),
    cachedRuns,
    result,
  );
  await benchmarkStore.save().catch((error) => {
    benchmarkStore.restoreRefresh(previous);
    throw error;
  });
  const refreshedRuns = benchmarkStore.refreshedRuns();
  if (refreshedRuns !== null) {
    snapshot = assembleCachedBenchmarkSnapshot(refreshedRuns);
  }
  const refresh = benchmarkStore.refresh;
  benchmarkEmptyReason = refresh?.result === "no-runs"
    ? "no benchmark runs"
    : refresh?.result === "data-unavailable"
    ? "benchmark data unavailable"
    : refresh?.result === "no-metric"
    ? "no metric"
    : undefined;
  benchmarkRefreshedAt = benchmarkStore.refreshedAt;
}

export function sampleBenchmarkRuns<
  T extends { created_at: string; conclusion: string | null },
>(runs: T[], cutoff: number): T[] {
  const perBucket = new Map<number, T>();
  for (const run of runs) {
    const at = Date.parse(run.created_at);
    if (run.conclusion !== "success" || at < cutoff) continue;
    const bucket = Math.floor(at / COLLECTION_BUCKET_MS);
    const current = perBucket.get(bucket);
    if (!current || at > Date.parse(current.created_at)) {
      perBucket.set(bucket, run);
    }
  }
  return [...perBucket.values()].sort((a, b) =>
    Date.parse(a.created_at) - Date.parse(b.created_at)
  );
}

const benchmarkDrill = {
  href: "/bench?view=runtime&repo=labs",
  hint: "all metrics ↗",
};

function benchmarkUnavailable(sub: string): TileView {
  return {
    ...benchmarkDrill,
    label: "benchmark",
    status: "unknown",
    value: "—",
    sub,
  };
}

function benchmarkTileView(
  ctx: Ctx,
  currentMetrics?: Map<string, Stats>,
): TileView {
  const pinned = ctx.env("BENCH_METRIC");
  let series: BenchmarkSeries | undefined;
  if (pinned) {
    const latest = currentMetrics ?? benchmarkStore.refreshedRuns()
      ?.findLast((run) => run.metrics.size > 0)?.metrics;
    const key = latest ? pickKey(latest, pinned) : undefined;
    series = snapshot.find((item) => item.key === key) ?? snapshot[0];
  } else {
    series = snapshot[
      hashInt(Math.floor(Date.now() / 3_600_000)) % snapshot.length
    ];
  }
  if (!series) return benchmarkUnavailable(benchmarkEmptyReason ?? "no metric");

  const points = series.points.map((point) => point.stats[TILE_STAT]);
  const trend = benchmarkTrend(
    series.points.map((point) => point.at),
    points,
  );
  const name = series.key.split(" > ").slice(1).join(" > ") || series.key;
  const line =
    `<div style="display:flex;align-items:baseline;gap:6px;font-size:13px;margin:5px 0 0">` +
    `<span style="flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#9aa0ab">${
      escapeHtml(name)
    }</span>` +
    `<span style="flex:none;color:#c7ccd4">${DEFAULT_LABEL} ${
      escapeHtml(trend.label)
    }</span></div>`;
  return {
    ...benchmarkDrill,
    label: "benchmark",
    status: trend.status,
    value: formatNs(points[points.length - 1]),
    extra: `${line}${
      sparkline(points, "#727882", undefined, SPARK_FADE[trend.status])
    }`,
    duration: spanMs(series.points),
  };
}

interface BenchmarkCollectionOutcome {
  view: TileView;
  error?: unknown;
}

async function collectBenchmark(
  ctx: Ctx,
  token: string,
  progress: BenchmarkProgressRecord,
  github: BenchmarkGitHub,
): Promise<BenchmarkCollectionOutcome> {
  const now = Date.now();
  const cutoff = now - SPARK_DAYS * 86_400_000;

  try {
    await benchmarkStore.load();
    const runs: Run[] = [];
    for (let page = 1; page <= 12; page++) {
      const response = await github.json<{ workflow_runs?: Run[] }>(
        `repos/${REPO}/actions/workflows/${WORKFLOW}/runs?branch=main&per_page=100&page=${page}`,
        token,
      );
      const batch = response.workflow_runs ?? [];
      if (!batch.length) break;
      runs.push(...batch);
      if (
        batch.length < 100 ||
        Date.parse(batch[batch.length - 1].created_at) < cutoff
      ) break;
    }

    const chosen = sampleBenchmarkRuns(runs, cutoff);
    const priorRefresh = benchmarkStore.refresh;
    const chosenReferences = chosen.map((run) => ({
      runId: run.id,
      runAttempt: run.run_attempt ?? 1,
    }));
    if (
      priorRefresh &&
      JSON.stringify(priorRefresh.runs) !== JSON.stringify(chosenReferences)
    ) {
      benchmarkStore.invalidateRefresh(now);
      await benchmarkStore.save(now);
      benchmarkRefreshedAt = benchmarkStore.refreshedAt;
    }
    const isCached = (run: Run) => currentRunMetrics(run) !== undefined;
    const cachedRuns = chosen.filter(isCached);
    const missing = chosen.filter((run) => !isCached(run));
    updateBenchmarkProgress(progress, {
      phase: "fetching",
      totalRuns: chosen.length,
      cachedRuns: cachedRuns.length,
      needsReload: missing.length > 0,
    });
    if (!chosen.length) {
      snapshot = [];
      await markBenchmarkRefreshed([], "no-runs");
      return { view: benchmarkTileView(ctx) };
    }

    let firstReadError: unknown;
    for (
      let index = 0;
      index < missing.length;
      index += BENCHMARK_FETCH_CONCURRENCY
    ) {
      const batch = missing.slice(index, index + BENCHMARK_FETCH_CONCURRENCY);
      const outcomes = await Promise.all(batch.map(async (run) => {
        updateBenchmarkProgress(progress, {
          requestsMade: progress.state.requestsMade + 1,
        });
        let cached = false;
        try {
          const outcome = await loadRun(run, token, github);
          cached = outcome.cached;
          return outcome.error === undefined
            ? null
            : { readError: outcome.error };
        } catch (error) {
          return { persistenceError: error };
        } finally {
          updateBenchmarkProgress(progress, {
            responsesReceived: progress.state.responsesReceived + 1,
            successfulResponses: progress.state.successfulResponses +
              (cached ? 1 : 0),
            failedResponses: progress.state.failedResponses +
              (cached ? 0 : 1),
          });
        }
      }));
      const persistenceFailure = outcomes.find((outcome) =>
        outcome && "persistenceError" in outcome
      );
      if (persistenceFailure && "persistenceError" in persistenceFailure) {
        throw persistenceFailure.persistenceError;
      }
      const readFailure = outcomes.find((outcome) =>
        outcome && "readError" in outcome
      );
      if (
        firstReadError === undefined && readFailure &&
        "readError" in readFailure
      ) firstReadError = readFailure.readError;
    }

    updateBenchmarkProgress(progress, { phase: "saving" });
    await benchmarkStore.save(now);
    const withData = chosen.filter((run) =>
      (currentRunMetrics(run)?.size ?? 0) > 0
    );
    if (!withData.length) {
      if (firstReadError === undefined) snapshot = [];
      if (firstReadError === undefined) {
        await markBenchmarkRefreshed(chosen, "data-unavailable");
      }
      return {
        view: firstReadError === undefined
          ? benchmarkTileView(ctx)
          : benchmarkUnavailable("benchmark data unavailable"),
        error: firstReadError,
      };
    }
    const collectedSnapshot = assembleBenchmarkSnapshot(withData);
    if (collectedSnapshot.length || firstReadError === undefined) {
      snapshot = collectedSnapshot;
    }
    if (firstReadError === undefined) {
      await markBenchmarkRefreshed(
        chosen,
        collectedSnapshot.length ? "data" : "no-metric",
      );
    }
    return {
      view: benchmarkTileView(
        ctx,
        firstReadError === undefined
          ? undefined
          : currentRunMetrics(withData[withData.length - 1]),
      ),
      error: firstReadError,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      view: benchmarkUnavailable(friendlyError(message)),
      error,
    };
  }
}

function startBenchmarkRefresh(
  ctx: Ctx,
  baseline?: string,
  snapshotIsFresh = false,
  scope: BenchmarkRefreshScope = "bench",
): BenchmarkRefresh {
  const github = scope === "bench"
    ? performanceBenchmarkGitHub
    : ordinaryBenchmarkGitHub;
  const token = (ctx.env("GH_TOKEN") ?? ctx.env("GITHUB_TOKEN"))!;
  const activeBenchmarkRefresh = activeBenchmarkRefreshes.get(scope);
  if (activeBenchmarkRefresh) {
    if (baseline !== undefined) {
      activeBenchmarkRefresh.progress.baselines.add(baseline);
    }
    return {
      progress: { ...activeBenchmarkRefresh.progress.state },
      result: activeBenchmarkRefresh.result,
    };
  }
  if (snapshotIsFresh) {
    return {
      progress: null,
      result: Promise.resolve(benchmarkTileView(ctx)),
    };
  }

  const progress = newBenchmarkProgress(baseline);
  const queuedBehindOtherScope = activeBenchmarkRefreshes.size > 0;
  const previousCollection = benchmarkCollectionTail;
  let finishCollection!: () => void;
  benchmarkCollectionTail = new Promise<void>((resolve) => {
    finishCollection = resolve;
  });
  const collection = async (): Promise<BenchmarkCollectionOutcome> => {
    await previousCollection;
    if (
      queuedBehindOtherScope && benchmarkRefreshedAt &&
      Date.now() - benchmarkRefreshedAt >= 0 &&
      Date.now() - benchmarkRefreshedAt < BENCHMARK_REFRESH_MS
    ) {
      return { view: benchmarkTileView(ctx) };
    }
    return await collectBenchmark(ctx, token, progress, github);
  };
  let refreshFinished = false;
  const finishRefresh = () => {
    if (refreshFinished) return;
    refreshFinished = true;
    finishCollection();
    if (activeBenchmarkRefreshes.get(scope)?.progress === progress) {
      activeBenchmarkRefreshes.delete(scope);
    }
  };
  const result = collection().then((outcome) => {
    finishRefresh();
    if (outcome.error) {
      const message = outcome.error instanceof Error
        ? outcome.error.message
        : String(outcome.error);
      if (scope === "bench") {
        benchmarkRefreshFailedAt = Date.now();
        benchmarkRefreshError = friendlyError(message);
      }
      const version = benchmarkSnapshotVersion();
      updateBenchmarkProgress(progress, {
        phase: "error",
        error: friendlyError(message),
        needsReload: [...progress.baselines].some((value) => value !== version),
      });
    } else {
      if (scope === "bench") {
        benchmarkRefreshFailedAt = 0;
        benchmarkRefreshError = "";
      }
      benchmarkRefreshedAt = benchmarkStore.refreshedAt;
      const version = benchmarkSnapshotVersion();
      updateBenchmarkProgress(progress, {
        phase: "complete",
        needsReload: [...progress.baselines].some((value) => value !== version),
      });
    }
    return outcome.view;
  }).finally(finishRefresh);
  activeBenchmarkRefreshes.set(scope, { progress, result });
  return { progress: { ...progress.state }, result };
}

function benchmarkSnapshotIsFresh(now = Date.now()): boolean {
  const age = now - benchmarkRefreshedAt;
  return Boolean(
    benchmarkRefreshedAt && age >= 0 && age < BENCHMARK_REFRESH_MS,
  );
}

function benchmarkRefreshRecentlyFailed(now = Date.now()): boolean {
  const age = now - benchmarkRefreshFailedAt;
  return Boolean(
    benchmarkRefreshFailedAt && !activeBenchmarkRefreshes.has("bench") &&
      age >= 0 && age < BENCHMARK_REFRESH_MS,
  );
}

function benchmarkServerContext(): Ctx {
  return {
    runs: () => Promise.resolve([]),
    runsFor: () => Promise.resolve([]),
    env: (key) => Deno.env.get(key),
  };
}

export const benchmark: Tile = {
  id: "benchmark",
  intervalMs: 3_600_000,
  routes: [
    {
      path: "/bench",
      handler: (_req, url) => {
        const view = url.searchParams.get("view");
        if (view === "ci") {
          return ciJobHistoryResponse(url);
        }
        if (view === "gantt") {
          return new Response(ciGanttPage(url), {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        if (view !== "runtime") {
          return new Response("unknown performance view", { status: 400 });
        }
        return benchmarkHistoryResponse(url);
      },
    },
    {
      path: "/bench/check",
      handler: (_req, url) => {
        const view = url.searchParams.get("view");
        if (view === "ci") {
          return ciJobHistoryCheckResponse(url);
        }
        if (view === "runtime") return benchmarkHistoryCheckResponse();
        return new Response("unknown performance view", { status: 400 });
      },
    },
    {
      path: "/bench/ci-progress",
      handler: (_req, url) => ciJobHistoryProgressResponse(url),
    },
    {
      path: "/bench/runtime-progress",
      handler: (_req, url) => benchmarkHistoryProgressResponse(url),
    },
  ] satisfies Route[],
  async collect(ctx, publish): Promise<TileView> {
    const token = ctx.env("GH_TOKEN") ?? ctx.env("GITHUB_TOKEN");
    if (!token) return benchmarkUnavailable("set GH_TOKEN");
    await loadCachedBenchmarkSnapshot();
    const initialCollection = benchmarkInitialCollection;
    benchmarkInitialCollection = false;
    const snapshotIsFresh = initialCollection && benchmarkSnapshotIsFresh();
    if (
      publish && initialCollection &&
      (snapshot.length > 0 || benchmarkEmptyReason !== undefined) &&
      !snapshotIsFresh
    ) {
      publish(benchmarkTileView(ctx));
    }
    return await startBenchmarkRefresh(
      ctx,
      undefined,
      snapshotIsFresh,
      "dashboard",
    ).result;
  },
};

export async function benchmarkHistoryResponse(
  url: URL,
  ctx = benchmarkServerContext(),
): Promise<Response> {
  await loadCachedBenchmarkSnapshot();
  const token = ctx.env("GH_TOKEN") ?? ctx.env("GITHUB_TOKEN");
  const baseline = benchmarkSnapshotVersion();
  let progress: BenchmarkFetchProgress | undefined;
  let refreshError: string | undefined;
  if (!token) {
    refreshError = snapshot.length
      ? "Set GH_TOKEN to refresh runtime benchmark history."
      : "Set GH_TOKEN to collect runtime benchmark history.";
  }
  if (token && benchmarkRefreshRecentlyFailed()) {
    refreshError = `Last collection stopped: ${benchmarkRefreshError}`;
  }
  if (token && !refreshError) {
    const refresh = startBenchmarkRefresh(
      ctx,
      baseline,
      benchmarkSnapshotIsFresh(),
    );
    progress = refresh.progress ?? undefined;
    if (progress) void refresh.result;
    else await refresh.result;
  }
  return new Response(
    benchPage(
      url.searchParams.get("stat") ?? DEFAULT_LABEL,
      url.searchParams.get("sort") ?? "file",
      ciHistoryDays(url.searchParams.get("days")),
      Date.now(),
      ciHistorySource(url.searchParams.get("repo")).key,
      {
        progress,
        refreshError,
        fragment: url.searchParams.get("fragment") === "range",
      },
    ),
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

export async function benchmarkHistoryCheckResponse(
  ctx = benchmarkServerContext(),
): Promise<Response> {
  await loadCachedBenchmarkSnapshot();
  const token = ctx.env("GH_TOKEN") ?? ctx.env("GITHUB_TOKEN");
  let progress: BenchmarkFetchProgress | null = null;
  if (
    token &&
    (!benchmarkRefreshFailedAt || activeBenchmarkRefreshes.has("bench") ||
      Date.now() - benchmarkRefreshFailedAt >= BENCHMARK_REFRESH_MS)
  ) {
    const refresh = startBenchmarkRefresh(
      ctx,
      benchmarkSnapshotVersion(),
      benchmarkSnapshotIsFresh(),
    );
    progress = refresh.progress;
    if (progress) void refresh.result;
    else await refresh.result;
  }
  return Response.json(
    { version: benchmarkSnapshotVersion(), progress },
    { headers: { "cache-control": "no-store" } },
  );
}

interface BenchmarkProgressProvider {
  progress(id: string): BenchmarkFetchProgress | null;
  subscribe(
    id: string,
    listener: (progress: BenchmarkFetchProgress) => void,
  ): (() => void) | null;
}

const defaultBenchmarkProgressProvider: BenchmarkProgressProvider = {
  progress: benchmarkProgress,
  subscribe: subscribeBenchmarkProgress,
};

export function benchmarkHistoryProgressResponse(
  url: URL,
  provider = defaultBenchmarkProgressProvider,
): Response {
  const id = url.searchParams.get("id");
  if (!id) return new Response("missing progress id", { status: 400 });
  if (!provider.progress(id)) {
    return new Response("unknown progress id", { status: 404 });
  }
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | undefined;
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (progress: BenchmarkFetchProgress) => {
        if (closed) return;
        controller.enqueue(encoder.encode(
          `event: progress\ndata: ${JSON.stringify(progress)}\n\n`,
        ));
        if (progress.phase === "complete" || progress.phase === "error") {
          closed = true;
          controller.close();
          unsubscribe?.();
        }
      };
      unsubscribe = provider.subscribe(id, send) ?? undefined;
      if (closed) unsubscribe?.();
    },
    cancel() {
      closed = true;
      unsubscribe?.();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    },
  });
}

export function pointsForWindow<T extends { at: number }>(
  points: T[],
  axisStart: number,
  bucketMs: number,
  axisEnd = Infinity,
): T[] {
  const buckets = new Map<number, T>();
  for (const point of points) {
    if (point.at < axisStart || point.at > axisEnd) continue;
    const bucket = Math.floor(point.at / bucketMs);
    const current = buckets.get(bucket);
    if (!current || point.at > current.at) buckets.set(bucket, point);
  }
  return [...buckets.values()].sort((a, b) => a.at - b.at);
}

const dateLabel = (at: number): string =>
  new Date(at).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });

// The /bench drill-down: every benchmark's sparkline for the chosen measurement,
// grouped by source file, each coloured by its own trend.
interface BenchmarkPageOptions {
  progress?: BenchmarkFetchProgress;
  refreshError?: string;
  fragment?: boolean;
}

export function benchPage(
  statLabel: string,
  sortMode: string,
  days: number,
  now = Date.now(),
  repo: CiHistorySourceKey = "labs",
  options: BenchmarkPageOptions = {},
): string {
  const stat = STATS.find((s) => s.label === statLabel) ??
    STATS.find((s) => s.label === DEFAULT_LABEL)!;
  const sort = sortMode === "trend" || sortMode === "duration"
    ? sortMode
    : "file";
  const href = (st: string, so: string) =>
    performanceViewHref("runtime", {
      repo,
      days,
      sort: so,
      stat: st,
    });
  const statSel = STATS.map((s) =>
    `<a class="stat${s.label === stat.label ? " on" : ""}" href="${
      href(s.label, sort)
    }"${s.label === stat.label ? ' aria-current="true"' : ""}>${s.label}</a>`
  ).join("");
  const sortSel = (["file", "duration", "trend"] as const).map((so) =>
    `<a class="stat${sort === so ? " on" : ""}" href="${href(stat.label, so)}"${
      sort === so ? ' aria-current="true"' : ""
    }>${so}</a>`
  ).join("");
  const viewNav = performanceViewNav("runtime", {
    repo,
    days,
    sort,
    stat: stat.label,
  });
  const version = benchmarkSnapshotVersion();
  const progress = options.progress;
  const progressIdle = !progress || progress.phase === "complete" ||
    progress.phase === "error";
  const progressTitle = progressIdle
    ? "Idle"
    : progress.phase === "discovering"
    ? "Finding benchmark runs…"
    : `${progress.completedRuns} of ${progress.totalRuns} artifact checks complete`;
  const progressTotal = progressIdle
    ? "0 outstanding"
    : `${progress.completedRuns} / ${progress.totalRuns || "?"}`;
  const progressDetail = progress?.phase === "error"
    ? `Last collection stopped: ${
      escapeHtml(progress.error ?? "unknown error")
    }`
    : !progressIdle && progress
    ? `${progress.cachedRuns} cached · ${progress.requestsMade} artifact checks made · ${progress.responsesReceived} responded · ${progress.outstandingRequests} outstanding · ${progress.queuedRuns} queued`
    : "No requests in progress.";
  const progressUrl = progress
    ? `/bench/runtime-progress?id=${
      escapeHtml(encodeURIComponent(progress.id))
    }`
    : "";
  const progressHtml =
    `<section class="fetch-progress" id="fetch-progress" aria-live="polite" data-check-url="/bench/check?view=runtime" data-snapshot-version="${
      escapeHtml(version)
    }" data-refresh-on-complete="${
      progress && !progressIdle && !snapshot.length ? "1" : "0"
    }"${
      progressUrl ? ` data-progress-url="${progressUrl}"` : ""
    }><div class="fetch-head"><strong id="fetch-title">${progressTitle}</strong><span id="fetch-total">${progressTotal}</span></div><progress id="fetch-bar" max="${
      progressIdle ? 1 : Math.max(1, progress?.totalRuns ?? 1)
    }"${
      !progressIdle && progress && !progress.totalRuns
        ? ""
        : ` value="${progressIdle ? 0 : progress?.completedRuns ?? 0}"`
    } aria-label="Runtime benchmark fetch progress"></progress><p id="fetch-detail">${progressDetail}</p></section>`;
  const refreshNotice = options.refreshError && snapshot.length
    ? `<p class="refresh-error">${escapeHtml(options.refreshError)}</p>`
    : "";

  let body: string;
  if (!snapshot.length) {
    body = progress && !progressIdle ? "" : `<p class="empty">${
      escapeHtml(
        options.refreshError ??
          "No runtime benchmark samples were found in the history window.",
      )
    }</p>`;
  } else {
    const axisEnd = now;
    const axisStart = axisEnd - days * 86_400_000;
    const axisSpan = axisEnd - axisStart || 1;
    const bucketMs = ciHistoryBucketMs(days);
    const rows = snapshot.flatMap((s) => {
      const points = pointsForWindow(s.points, axisStart, bucketMs, axisEnd);
      if (points.length < 2) return [];
      const pts = points.map((p) => p.stats[stat.field]);
      const trend = benchmarkTrend(points.map((p) => p.at), pts);
      const xs = points.map((p) => (p.at - axisStart) / axisSpan);
      const spark = sparkline(
        pts,
        "#727882",
        undefined,
        SPARK_FADE[trend.status],
        xs,
      );
      return [{
        key: s.key,
        file: s.key.split(" > ")[0],
        pct: trend.pct,
        st: trend.status,
        trend: trend.label,
        spark,
        dur: durationTag(spanMs(points)),
        latest: pts[pts.length - 1],
      }];
    });
    const rowHtml = (r: (typeof rows)[number], label: string) =>
      `<div class="brow ${r.st}"><div class="bspark">${r.spark}${r.dur}</div><div class="bmeta">` +
      `<span class="bname">${escapeHtml(label)}</span>` +
      `<span class="bval">${formatNs(r.latest)}<span class="btrend">${
        escapeHtml(r.trend)
      }</span></span>` +
      `</div></div>`;
    const axis = `<div class="axisrow"><div class="timeaxis"><span>${
      dateLabel(axisStart)
    }</span><span>${dateLabel(axisEnd)}</span></div></div>`;
    if (!rows.length) {
      body =
        `<p class="empty">No benchmark samples were found in the selected window.</p>`;
    } else if (sort === "trend" || sort === "duration") {
      const sorted = [...rows].sort((a, b) => {
        const difference = sort === "duration"
          ? b.latest - a.latest
          : b.pct - a.pct;
        return difference || a.key.localeCompare(b.key);
      });
      body = `${axis}<div class="blist">${
        sorted.map((r) => rowHtml(r, r.key)).join("")
      }</div>`;
    } else {
      // Grouped by source file, in the snapshot's alphabetical order.
      const groups = new Map<string, typeof rows>();
      for (const r of rows) {
        const arr = groups.get(r.file);
        if (arr) arr.push(r);
        else groups.set(r.file, [r]);
      }
      body = axis +
        [...groups.entries()].map(([file, rs]) =>
          `<section><h2>${escapeHtml(file)}</h2><div class="blist">${
            rs.map((r) =>
              rowHtml(r, r.key.split(" > ").slice(1).join(" > ") || r.key)
            ).join("")
          }</div></section>`
        ).join("");
    }
  }

  const rangeContent = `<div id="range-content">
    ${progressHtml}${refreshNotice}
    <p class="legend">Percentile of per-op time across a run's samples — p0 = min, p50 = mean, p100 = max. Lower is faster; the grid tile tracks p99. Coloured by the selected ${days}-day trend; fewer than seven distinct days are marked new. Duration sort uses the latest sample.</p>
    ${body}
    <p class="note">Successful main runs come from the <a href="https://github.com/${REPO}/actions/workflows/${WORKFLOW}" target="_blank" rel="noopener">${WORKFLOW} runs ↗</a> (deno bench artifacts). Collection keeps enough samples for the shortest window, and charts reduce longer windows to about ${CI_HISTORY_POINT_TARGET} evenly spaced points.</p>
  </div>`;
  if (options.fragment) return rangeContent;

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Benchmarks — ${
    escapeHtml(stat.label)
  }</title>
<style>
  body{box-sizing:border-box;width:100%;margin:0;background:#0d0e11;color:#e7e9ee;font-family:-apple-system,Segoe UI,Roboto,sans-serif;padding:18px 20px 26px;max-width:1100px;margin:0 auto}
  .top{display:flex;align-items:baseline;gap:10px;margin-bottom:14px;flex-wrap:wrap}
  .top b{font-size:16px;font-weight:600}.top span{font-size:12px;color:#6f757f}
  a.back{color:#6ea8fe;text-decoration:none;font-size:13px}
  .views{display:flex;gap:6px;margin:0 0 14px}
  .views a{font-size:13px;color:#c7ccd4;text-decoration:none;border:1px solid #2f333c;border-radius:6px;padding:4px 10px}
  .views a.on{background:#6ea8fe;border-color:#6ea8fe;color:#0d0e11}
  .controls{display:flex;flex-wrap:wrap;align-items:center;gap:6px;background:#16181d;border:1px solid #23262d;border-radius:12px;padding:12px 14px;margin-bottom:8px}
  .controls .lbl{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#878d97;margin-right:6px}
  .controls .field{display:flex;align-items:center;gap:7px;font-size:12px;color:#9aa0ab;margin-right:8px}
  .controls .choice-group{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
  .controls input[type=range]{width:150px}.controls output{color:#c7ccd4;min-width:46px;font-variant-numeric:tabular-nums}
  a.stat{font-size:13px;color:#c7ccd4;text-decoration:none;border:1px solid #2f333c;border-radius:6px;padding:3px 9px;font-variant-numeric:tabular-nums}
  a.stat:hover{border-color:#3a4150}
  a.stat.on{background:#6ea8fe;border-color:#6ea8fe;color:#0d0e11}
  .legend{font-size:11px;color:#666c76;margin:0 0 16px}
  .fetch-progress{background:#16181d;border:1px solid #2f333c;border-radius:10px;padding:10px 12px;margin:0 0 12px}
  .fetch-progress.error{border-color:rgba(224,168,82,.42)}
  .fetch-head{display:flex;justify-content:space-between;gap:12px;align-items:baseline;font-size:12px;color:#c7ccd4}
  .fetch-head strong{font-weight:600}.fetch-head span,#fetch-detail{font-variant-numeric:tabular-nums;color:#878d97}
  .fetch-progress progress{display:block;width:100%;height:7px;margin:7px 0 6px;accent-color:#6ea8fe}
  #fetch-detail{font-size:11px;margin:0}
  .axisrow{display:flex;gap:18px;margin:0 14px 4px}.timeaxis{flex:0 0 42%;display:flex;justify-content:space-between;color:#666c76;font-size:10px}
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
  .bspark{flex:0 0 42%;min-width:0;position:relative}
  .bspark>div,.bspark>svg{margin-top:0!important}
  .empty,.refresh-error{color:#9aa0ab;font-size:14px}.refresh-error{color:#e0a852}
  .note{font-size:11px;color:#666c76;margin-top:22px}
  .note a{color:#6ea8fe;text-decoration:none}
  label.chk{font-size:13px;color:#c7ccd4;display:inline-flex;align-items:center;gap:6px;margin-left:auto;cursor:pointer;user-select:none}
  body.hide-green .brow.good{display:none}
  body.hide-green section:not(:has(.brow:not(.good))){display:none}
  @media(max-width:640px){.timeaxis{flex:1}.brow{align-items:stretch;gap:7px;flex-wrap:wrap}.bspark{flex:1 0 100%}.controls .field,.controls .choice-group{flex:1 1 100%}.controls input[type=range]{flex:1;width:auto}.controls label.chk{margin-left:0}}
</style></head><body data-snapshot-version="${escapeHtml(version)}">
  <div class="top"><a class="back" href="/">← dashboard</a><b>Performance history</b><span>${
    escapeHtml(REPO)
  } · ${WORKFLOW}</span></div>
  ${viewNav}
  <form class="controls" method="get" action="/bench"><input type="hidden" name="view" value="runtime"><input type="hidden" name="repo" value="${repo}"><input type="hidden" name="stat" value="${
    escapeHtml(stat.label)
  }"><input type="hidden" name="sort" value="${sort}"><label class="field" for="days">window <output id="daysv" for="days">${days} day${
    days === 1 ? "" : "s"
  }</output><input type="range" id="days" name="days" min="${CI_HISTORY_MIN_DAYS}" max="${CI_HISTORY_DAYS}" step="1" value="${days}"></label><nav class="choice-group" aria-label="Benchmark metric"><span class="lbl">metric</span>${statSel}</nav><nav class="choice-group" aria-label="Sort benchmarks"><span class="lbl">sort</span>${sortSel}</nav><label class="chk"><input type="checkbox" id="hg"> hide green</label></form>
  ${rangeContent}
<script>
  const hg = document.getElementById("hg"), days = document.getElementById("days"), daysv = document.getElementById("daysv"), controls = days.form, KEY = "benchHideGreen", DEFAULT_DAYS = days.value;
  let rangeContent = document.getElementById("range-content"), fetchProgress = document.getElementById("fetch-progress"), title = document.getElementById("fetch-title"), total = document.getElementById("fetch-total"), detail = document.getElementById("fetch-detail"), bar = document.getElementById("fetch-bar"), pageVersion = fetchProgress.dataset.snapshotVersion, appliedDays = days.value;
  let navigating = false, pendingRefresh = false, checking = false, eventStream = null, connectedProgressUrl = "", serverVersionChanged = false, collectionFailed = false, transportFailed = false, rangeRequest = null, rangeRequestDays = "", rangeSequence = 0, viewRevision = 0;
  const apply = () => document.body.classList.toggle("hide-green", hg.checked);
  hg.checked = sessionStorage.getItem(KEY) === "1";
  apply();
  hg.addEventListener("change", () => {
    sessionStorage.setItem(KEY, hg.checked ? "1" : "0");
    apply();
  });
  const syncDayLinks = () => {
    for (const link of document.querySelectorAll('a[href^="/bench?"]')) {
      const target = new URL(link.href);
      target.searchParams.set("days", days.value);
      link.href = target.pathname + "?" + target.searchParams.toString();
    }
  };
  days.addEventListener("input", () => {
    daysv.value = days.value + (days.value === "1" ? " day" : " days");
    syncDayLinks();
  });
  const applyDays = () => {
    if (days.value !== appliedDays) {
      if (!rangeRequest || rangeRequestDays !== days.value) void loadRange("push");
    } else if (rangeRequest && rangeRequestDays !== days.value) {
      void loadRange("restore");
    } else if (pendingRefresh && !rangeRequest) {
      pendingRefresh = false;
      void loadRange("refresh");
    }
  };
  days.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      applyDays();
    }
  });
  days.addEventListener("change", applyDays);
  const isSameTabLink = (event, link) =>
    link.target !== "_blank" && event.button === 0 && !event.metaKey &&
    !event.ctrlKey && !event.shiftKey && !event.altKey;
  document.addEventListener("click", (event) => {
    const link = event.target.closest?.("a[href]");
    if (link && isSameTabLink(event, link)) navigating = true;
  }, true);
  controls.addEventListener("submit", () => navigating = true);
  window.addEventListener("pagehide", () => {
    navigating = true;
    rangeRequest?.abort();
    eventStream?.close();
  });
  const renderIdle = () => {
    collectionFailed = false;
    transportFailed = false;
    fetchProgress.classList.remove("error");
    title.textContent = "Idle";
    total.textContent = "0 outstanding";
    bar.max = 1;
    bar.value = 0;
    detail.textContent = "No requests in progress.";
  };
  const refreshRangeWhenIdle = () => {
    if (navigating) return;
    if (
      days.value !== appliedDays || rangeContent.contains(document.activeElement) ||
      rangeRequest
    ) {
      pendingRefresh = true;
      return;
    }
    void loadRange("refresh");
  };
  document.addEventListener("focusout", () => {
    requestAnimationFrame(() => {
      if (
        pendingRefresh && !navigating && !rangeRequest &&
        !rangeContent.contains(document.activeElement)
      ) {
        pendingRefresh = false;
        refreshRangeWhenIdle();
      }
    });
  });
  const renderProgress = (state) => {
    collectionFailed = state.phase === "error";
    transportFailed = false;
    fetchProgress.classList.remove("error");
    if (state.phase === "discovering") {
      title.textContent = "Finding benchmark runs…";
      total.textContent = "starting";
      bar.removeAttribute("value");
    } else {
      title.textContent = state.phase === "saving"
        ? "Saving completed responses…"
        : state.completedRuns + " of " + state.totalRuns + " artifact checks complete";
      total.textContent = state.completedRuns + " / " + state.totalRuns;
      bar.max = Math.max(1, state.totalRuns);
      bar.value = state.completedRuns;
    }
    detail.textContent = state.cachedRuns + " cached · " +
      state.requestsMade + " artifact checks made · " +
      state.responsesReceived + " responded · " +
      state.outstandingRequests + " outstanding · " +
      state.queuedRuns + " queued" +
      (state.failedResponses ? " · " + state.failedResponses + " failed" : "");
    if (state.phase === "error") {
      fetchProgress.classList.add("error");
      title.textContent = "Idle";
      total.textContent = "0 outstanding";
      bar.max = 1;
      bar.value = 0;
      detail.textContent = "Last collection stopped: " + (state.error || "unknown error");
      eventStream?.close();
      eventStream = null;
      connectedProgressUrl = "";
    } else if (state.phase === "complete") {
      eventStream?.close();
      eventStream = null;
      connectedProgressUrl = "";
      if (state.needsReload || serverVersionChanged || fetchProgress.dataset.refreshOnComplete === "1") refreshRangeWhenIdle();
      else renderIdle();
    }
  };
  const connectProgress = (url) => {
    if (!url || connectedProgressUrl === url) return;
    eventStream?.close();
    connectedProgressUrl = url;
    const stream = new EventSource(url);
    eventStream = stream;
    stream.addEventListener("progress", (event) => {
      if (eventStream !== stream) return;
      try {
        renderProgress(JSON.parse(event.data));
      } catch {
        stream.close();
        eventStream = null;
        connectedProgressUrl = "";
        transportFailed = true;
        fetchProgress.classList.add("error");
        title.textContent = "Could not read collection progress";
      }
    });
    stream.onerror = () => {
      if (eventStream !== stream) return;
      stream.close();
      eventStream = null;
      connectedProgressUrl = "";
      transportFailed = true;
      fetchProgress.classList.add("error");
      title.textContent = "Progress connection closed; collection continues on the server";
    };
  };
  const checkForUpdates = async () => {
    if (checking || navigating || document.visibilityState === "hidden") return;
    checking = true;
    const revision = viewRevision;
    try {
      const response = await fetch(fetchProgress.dataset.checkUrl, { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const state = await response.json();
      if (revision !== viewRevision) return;
      serverVersionChanged ||= state.version !== pageVersion;
      if (state.progress) {
        connectProgress("/bench/runtime-progress?id=" + encodeURIComponent(state.progress.id));
        renderProgress(state.progress);
      } else if (serverVersionChanged) refreshRangeWhenIdle();
      else if (!collectionFailed) renderIdle();
    } catch {
      if (!eventStream && !collectionFailed && !transportFailed) renderIdle();
    } finally {
      checking = false;
    }
  };
  const bindRangeContent = () => {
    viewRevision++;
    fetchProgress = rangeContent.querySelector("#fetch-progress");
    title = rangeContent.querySelector("#fetch-title");
    total = rangeContent.querySelector("#fetch-total");
    detail = rangeContent.querySelector("#fetch-detail");
    bar = rangeContent.querySelector("#fetch-bar");
    pageVersion = fetchProgress.dataset.snapshotVersion;
    document.body.dataset.snapshotVersion = pageVersion;
    serverVersionChanged = false;
    collectionFailed = false;
    transportFailed = false;
    connectedProgressUrl = "";
    if (fetchProgress.dataset.progressUrl) connectProgress(fetchProgress.dataset.progressUrl);
    else renderIdle();
  };
  const showRangeLoading = (requestedDays) => {
    rangeContent.setAttribute("aria-busy", "true");
    fetchProgress.classList.remove("error");
    title.textContent = "Loading " + requestedDays + "-day view…";
    total.textContent = "updating";
    bar.removeAttribute("value");
    detail.textContent = "Reading cached history and checking for new benchmark data.";
  };
  const loadRange = async (mode) => {
    if (navigating) return;
    if (rangeRequest) {
      if (mode === "refresh") {
        pendingRefresh = true;
        return;
      }
      rangeRequest.abort();
    }
    const requestedDays = days.value;
    const url = new URL(location.href);
    url.searchParams.set("days", requestedDays);
    const sequence = ++rangeSequence;
    const controller = new AbortController();
    rangeRequest = controller;
    rangeRequestDays = requestedDays;
    let loaded = false;
    showRangeLoading(requestedDays);
    try {
      const requestUrl = new URL(url);
      requestUrl.searchParams.set("fragment", "range");
      const response = await fetch(requestUrl.pathname + requestUrl.search, {
        cache: "no-store",
        headers: { accept: "text/html" },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const page = new DOMParser().parseFromString(await response.text(), "text/html");
      const replacement = page.getElementById("range-content");
      if (!replacement) throw new Error("Range content was missing from the response.");
      if (sequence !== rangeSequence || navigating) return;
      eventStream?.close();
      eventStream = null;
      connectedProgressUrl = "";
      rangeContent.replaceWith(replacement);
      rangeContent = replacement;
      appliedDays = requestedDays;
      const target = url.pathname + url.search;
      if (mode === "push" && target !== location.pathname + location.search) {
        history.pushState(null, "", target);
      }
      bindRangeContent();
      syncDayLinks();
      loaded = true;
    } catch (error) {
      if (controller.signal.aborted || sequence !== rangeSequence) return;
      pendingRefresh = false;
      rangeContent.removeAttribute("aria-busy");
      fetchProgress.classList.add("error");
      title.textContent = "Could not update the history window";
      total.textContent = "0 outstanding";
      bar.max = 1;
      bar.value = 0;
      detail.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      if (sequence === rangeSequence) {
        rangeRequest = null;
        rangeRequestDays = "";
        if (loaded && pendingRefresh) {
          pendingRefresh = false;
          refreshRangeWhenIdle();
        }
      }
    }
  };
  const daysFromLocation = () => {
    const parameter = new URL(location.href).searchParams.get("days");
    if (parameter === null || parameter.trim() === "") return DEFAULT_DAYS;
    const value = Number(parameter);
    if (!Number.isFinite(value)) return DEFAULT_DAYS;
    return String(Math.max(Number(days.min), Math.min(Number(days.max), Math.floor(value))));
  };
  window.addEventListener("popstate", () => {
    days.value = daysFromLocation();
    daysv.value = days.value + (days.value === "1" ? " day" : " days");
    syncDayLinks();
    void loadRange("pop");
  });
  bindRangeContent();
  setInterval(checkForUpdates, ${PERFORMANCE_CHECK_MS});
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void checkForUpdates();
  });
</script>
</body></html>`;
}
