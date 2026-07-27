// Historical wall-clock duration for every job in the labs and loom CI
// workflows. The page samples successful main runs, persists each completed
// attempt's jobs, and uses the same trailing-parenthesis grouping as
// scripts/ci-gantt.ts.
import {
  type CachedCiGanttJob,
  type CachedCiRun,
  type CachedCiRunReference,
  CiJobHistoryStore,
} from "./ci-job-cache.ts";
import { CI_WORKFLOW, LOOM_CI_WORKFLOW, LOOM_REPO, REPO } from "./config.ts";
import {
  clampInt,
  durationTag,
  escapeHtml,
  friendlyError,
  github,
  performanceGithub,
  SPARK_FADE,
  sparkline,
} from "./lib.ts";
import { GitHubRateLimitBudgetError } from "./github-rate-limit.ts";
import {
  distinctTrendDays,
  trendPct,
  trendPctLabel,
  trendStatus,
} from "./trend.ts";
import {
  PERFORMANCE_CHECK_MS,
  performanceViewNav,
} from "./performance-views.ts";

export const CI_HISTORY_DAYS = 45;
export const CI_HISTORY_MIN_DAYS = 1;
export const CI_HISTORY_POINT_TARGET = 90;
export const CI_HISTORY_BUCKET_HOURS = CI_HISTORY_DAYS * 24 /
  CI_HISTORY_POINT_TARGET;

const DAY_MS = 86_400_000;
const JOBS_PER_PAGE = 100;
const JOB_FETCH_CONCURRENCY = 8;
const REFRESH_MS = 30 * 60_000;
const GITHUB_SEARCH_LIMIT = 1_000;
export const GANTT_MAX_RUNS = 150;
const SELECTED_WORKFLOW_RUN_CACHE_MAX = GANTT_MAX_RUNS;
const PROGRESS_RECORD_MAX = 256;

type GitHubRequest = <T = unknown>(
  path: string,
  token?: string,
) => Promise<T>;

export interface WorkflowRun {
  id: number;
  status: string;
  conclusion: string | null;
  event: string;
  head_branch?: string | null;
  head_sha?: string;
  path?: string;
  run_attempt: number;
  run_started_at: string;
  html_url: string;
  name?: string;
}

interface ApiStep {
  name: string;
  number: number;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
}

interface ApiJob {
  name: string;
  status?: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  steps?: ApiStep[];
}

export interface CiGanttInputRun {
  run: {
    attempt: number;
    databaseId: number;
    status: string;
    conclusion: string;
    event: string;
    headBranch?: string;
    startedAt: string;
    workflowName?: string;
  };
  jobs: CachedCiGanttJob[];
}

export interface CiGanttInput {
  runs: CiGanttInputRun[];
}

export interface CiGanttOptions {
  limit: number;
  mainOnly: boolean;
  allConclusions?: boolean;
  selectedRuns?: CiGanttRunSelection[];
  headSha?: string;
}

export interface CiGanttRunSelection {
  runId: number;
  runAttempt: number;
}

export interface CiGanttRefresh {
  progress: CiJobFetchProgress;
  result: Promise<CiGanttInput>;
}

export interface CiTimedJob {
  name: string;
  seconds: number;
}

export interface CiHistorySample {
  runId: number;
  runUrl: string;
  at: number;
  overallSeconds?: number;
  jobs: CiTimedJob[];
}

export interface CiJobPoint {
  at: number;
  seconds: number;
  runId: number;
  runUrl: string;
}

export interface CiJobSeries {
  kind: "job" | "group" | "overall";
  name: string;
  base: string;
  points: CiJobPoint[];
}

export interface CiShardGroup {
  base: string;
  maxConcurrent: number;
  aggregate: CiJobSeries;
  shards: CiJobSeries[];
}

export interface CiJobHistorySnapshot {
  runCount: number;
  successfulRunTimes: number[] | null;
  failedRunCount: number;
  failedRunTimes: number[];
  stale: boolean;
  axisStart: number;
  axisEnd: number;
  overall: CiJobSeries | null;
  groups: CiShardGroup[];
  jobs: CiJobSeries[];
}

export type CiJobFetchPhase =
  | "discovering"
  | "fetching"
  | "saving"
  | "complete"
  | "error";

export interface CiJobFetchProgress {
  id: string;
  source: CiHistorySourceKey;
  days: number;
  phase: CiJobFetchPhase;
  discoveryRequestsMade: number;
  discoveryResponsesReceived: number;
  discoveryOutstandingRequests: number;
  totalRuns: number;
  cachedRuns: number;
  requestsMade: number;
  responsesReceived: number;
  sharedRequests: number;
  sharedResponses: number;
  successfulResponses: number;
  failedResponses: number;
  completedRuns: number;
  queuedRuns: number;
  outstandingRequests: number;
  needsReload: boolean;
  updatedAt: number;
  error?: string;
  warning?: string;
}

export interface CiJobRefresh {
  progress: CiJobFetchProgress | null;
  result: Promise<CiJobHistorySnapshot>;
}

type CiJobProgressListener = (progress: CiJobFetchProgress) => void;

interface CiJobProgressRecord {
  state: CiJobFetchProgress;
  listeners: Set<CiJobProgressListener>;
  baselines: Set<string>;
}

interface CiWorkflowDiscovery<Result = WorkflowRun[]> {
  progresses: Set<CiJobProgressRecord>;
  requestsMade: number;
  responsesReceived: number;
  result: Promise<Result>;
}

interface SelectedWorkflowRuns {
  runs: WorkflowRun[];
  failure?: { error: unknown };
}

interface CiGanttRequest {
  progress: CiJobProgressRecord;
  result: Promise<CiGanttInput>;
}

type CiJobFetchOutcome =
  | { run: WorkflowRun; entry: CachedCiRun }
  | { run: WorkflowRun; error: unknown; persistence: boolean };

interface CiJobLoad {
  kind: "cached" | "joined" | "requested";
  result: Promise<CachedCiRun>;
}

class CiJobCacheWriteError extends Error {
  constructor(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    super(`Could not persist CI job history: ${message}`, { cause: error });
    this.name = "CiJobCacheWriteError";
  }
}

export type CiHistorySourceKey = "labs" | "loom";

export interface CiHistorySource {
  key: CiHistorySourceKey;
  label: string;
  repo: string;
  workflow: string;
}

export const CI_HISTORY_SOURCES: Record<CiHistorySourceKey, CiHistorySource> = {
  labs: { key: "labs", label: "labs", repo: REPO, workflow: CI_WORKFLOW },
  loom: {
    key: "loom",
    label: "loom",
    repo: LOOM_REPO,
    workflow: LOOM_CI_WORKFLOW,
  },
};

export function baseJobName(name: string): string {
  return name.replace(/\s*\([^)]*\)\s*$/, "");
}

function shardKey(name: string): string {
  const fraction = name.match(/\((\d+)\/(\d+)\)/);
  if (fraction) return String(Number(fraction[1])).padStart(4, "0");
  const suffix = name.match(/\(([^)]*)\)\s*$/);
  return suffix ? suffix[1] : "";
}

function runTime(run: WorkflowRun): number {
  return Date.parse(run.run_started_at);
}

function validateSelectedWorkflowRun(
  run: WorkflowRun,
  selected: CiGanttRunSelection,
  source: CiHistorySource,
  headSha: string,
): WorkflowRun {
  const workflowPath = run.path?.split("@", 1)[0];
  const expectedWorkflowPath = `.github/workflows/${source.workflow}`;
  if (
    run.id !== selected.runId || run.run_attempt !== selected.runAttempt ||
    run.head_sha?.toLowerCase() !== headSha ||
    workflowPath !== expectedWorkflowPath
  ) {
    throw new Error(
      `Selected CI run ${selected.runId} attempt ${selected.runAttempt} does not match the requested commit and workflow.`,
    );
  }
  return {
    id: run.id,
    status: run.status,
    conclusion: run.conclusion,
    event: run.event,
    head_branch: run.head_branch,
    head_sha: run.head_sha,
    path: run.path,
    run_attempt: run.run_attempt,
    run_started_at: run.run_started_at,
    html_url: run.html_url,
    name: run.name,
  };
}

export function ciHistoryDays(value: string | null): number {
  return clampInt(
    value,
    CI_HISTORY_DAYS,
    CI_HISTORY_MIN_DAYS,
    CI_HISTORY_DAYS,
  );
}

export function ciHistorySource(value: string | null): CiHistorySource {
  return value === "loom" ? CI_HISTORY_SOURCES.loom : CI_HISTORY_SOURCES.labs;
}

export function ciGanttOptions(
  parameters: URLSearchParams,
): CiGanttOptions {
  const selectedRuns = parameters.getAll("run").flatMap((value) => {
    const match = value.match(/^(\d+):(\d+)$/);
    if (!match) return [];
    const runId = Number(match[1]);
    const runAttempt = Number(match[2]);
    return Number.isSafeInteger(runId) && runId > 0 &&
        Number.isSafeInteger(runAttempt) && runAttempt > 0
      ? [{ runId, runAttempt }]
      : [];
  });
  const options: CiGanttOptions = {
    limit: clampInt(parameters.get("limit"), 60, 1, GANTT_MAX_RUNS),
    mainOnly: parameters.get("mainOnly") === "1",
    allConclusions: parameters.get("allConclusions") === "1",
  };
  if (selectedRuns.length) options.selectedRuns = selectedRuns;
  const headSha = parameters.get("sha") ?? "";
  if (selectedRuns.length && /^[0-9a-f]{40}$/i.test(headSha)) {
    options.headSha = headSha.toLowerCase();
  }
  return options;
}

function normalizedGanttOptions(
  options: CiGanttOptions,
): Required<CiGanttOptions> {
  const requestedLimit = Number.isFinite(options.limit)
    ? Math.floor(options.limit)
    : GANTT_MAX_RUNS;
  const selectedRuns = new Map<number, CiGanttRunSelection>();
  for (const selected of options.selectedRuns ?? []) {
    if (
      !Number.isSafeInteger(selected.runId) || selected.runId <= 0 ||
      !Number.isSafeInteger(selected.runAttempt) || selected.runAttempt <= 0
    ) continue;
    const current = selectedRuns.get(selected.runId);
    if (!current || current.runAttempt < selected.runAttempt) {
      selectedRuns.set(selected.runId, { ...selected });
    }
    if (selectedRuns.size >= GANTT_MAX_RUNS) break;
  }
  const headSha = options.headSha?.toLowerCase() ?? "";
  if (selectedRuns.size && !/^[0-9a-f]{40}$/.test(headSha)) {
    throw new Error("Selected CI runs require a commit SHA.");
  }
  return {
    limit: selectedRuns.size ||
      Math.max(1, Math.min(GANTT_MAX_RUNS, requestedLimit)),
    mainOnly: options.mainOnly,
    allConclusions: options.allConclusions === true,
    selectedRuns: [...selectedRuns.values()],
    headSha,
  };
}

export function ciHistoryBucketMs(days: number): number {
  return days * DAY_MS / CI_HISTORY_POINT_TARGET;
}

function sampleNewestPerBucket<T>(
  values: T[],
  at: (value: T) => number,
  cutoff: number,
  bucketMs: number,
): T[] {
  const eligible = values.filter((value) => {
    const time = at(value);
    return Number.isFinite(time) && time >= cutoff;
  });
  if (eligible.length <= CI_HISTORY_POINT_TARGET) {
    return eligible.sort((a, b) => at(a) - at(b));
  }
  const buckets = new Map<number, T>();
  for (const value of eligible) {
    const time = at(value);
    const bucket = Math.floor((time - cutoff) / bucketMs);
    const current = buckets.get(bucket);
    if (!current || time > at(current)) buckets.set(bucket, value);
  }
  return [...buckets.values()].sort((a, b) => at(a) - at(b));
}

export function sampleWorkflowRuns(
  runs: WorkflowRun[],
  now = Date.now(),
  days = CI_HISTORY_DAYS,
): WorkflowRun[] {
  const eligible = successfulMainWorkflowRuns(runs, now, days);
  const cutoff = now - days * DAY_MS;
  return sampleNewestPerBucket(
    eligible,
    runTime,
    cutoff,
    ciHistoryBucketMs(days),
  );
}

function successfulMainWorkflowRuns(
  runs: WorkflowRun[],
  now: number,
  days: number,
): WorkflowRun[] {
  const cutoff = now - days * DAY_MS;
  const eligible = new Map<number, WorkflowRun>();
  for (const run of runs) {
    const at = runTime(run);
    if (
      run.status !== "completed" || run.conclusion !== "success" ||
      run.event !== "push" ||
      (run.head_branch !== undefined && run.head_branch !== null &&
        run.head_branch !== "main") ||
      !Number.isFinite(at) || at < cutoff || at > now
    ) continue;
    const current = eligible.get(run.id);
    if (!current || run.run_attempt > current.run_attempt) {
      eligible.set(run.id, run);
    }
  }
  return [...eligible.values()];
}

async function fetchWorkflowRuns(
  token: string,
  now: number,
  source: CiHistorySource,
  request: GitHubRequest,
): Promise<WorkflowRun[]> {
  const cutoff = now - CI_HISTORY_DAYS * DAY_MS;
  // GitHub caps every filtered workflow-run search at 1,000 results. Query the
  // complete window first, then divide only a saturated range. The one-day
  // buffer covers runs that were created before the cutoff but started after it.
  const searchRange = async (
    start: number,
    end: number,
  ): Promise<WorkflowRun[]> => {
    const requestPage = (page: number) => {
      const created = `${new Date(start).toISOString()}..${
        new Date(end).toISOString()
      }`;
      const params = new URLSearchParams({
        branch: "main",
        event: "push",
        status: "success",
        created,
        per_page: "100",
        page: String(page),
      });
      return request<{
        total_count?: number;
        workflow_runs?: WorkflowRun[];
      }>(
        `repos/${source.repo}/actions/workflows/${source.workflow}/runs?${params}`,
        token,
      );
    };

    const first = await requestPage(1);
    const firstBatch = first.workflow_runs ?? [];
    if ((first.total_count ?? firstBatch.length) >= GITHUB_SEARCH_LIMIT) {
      if (end - start <= 1_000) {
        throw new Error(
          "GitHub workflow-run search exceeded 1,000 results in one second",
        );
      }
      const midpoint = Math.floor((start + end) / 2);
      return [
        ...await searchRange(start, midpoint),
        ...await searchRange(midpoint, end),
      ];
    }

    const runs = [...firstBatch];
    for (let page = 2; firstBatch.length === 100; page++) {
      if (first.total_count !== undefined && runs.length >= first.total_count) {
        break;
      }
      const response = await requestPage(page);
      const batch = response.workflow_runs ?? [];
      runs.push(...batch);
      if (batch.length < 100) break;
    }
    return runs;
  };

  const runs = await searchRange(cutoff - DAY_MS, now);
  const unique = new Map<number, WorkflowRun>();
  for (const run of runs) {
    const current = unique.get(run.id);
    if (!current || run.run_attempt > current.run_attempt) {
      unique.set(run.id, run);
    }
  }
  return [...unique.values()];
}

async function fetchRecentWorkflowRuns(
  token: string,
  source: CiHistorySource,
  mainOnly: boolean,
  request: GitHubRequest,
): Promise<WorkflowRun[]> {
  const runs: WorkflowRun[] = [];
  for (let page = 1; runs.length < GANTT_MAX_RUNS; page++) {
    const params = new URLSearchParams({
      per_page: "100",
      page: String(page),
    });
    if (mainOnly) {
      params.set("branch", "main");
      params.set("event", "push");
    }
    const response = await request<{ workflow_runs?: WorkflowRun[] }>(
      `repos/${source.repo}/actions/workflows/${source.workflow}/runs?${params}`,
      token,
    );
    const batch = response.workflow_runs ?? [];
    runs.push(...batch);
    if (batch.length < 100) break;
  }
  return runs.slice(0, GANTT_MAX_RUNS);
}

interface TimedApiJob {
  timing: CiTimedJob;
  start: number;
  end: number;
}

interface CiRunTiming {
  jobs: CiTimedJob[];
  overallSeconds: number;
  ganttJobs: CachedCiGanttJob[];
}

function timedJob(job: ApiJob): TimedApiJob | null {
  if (
    job.conclusion !== "success" || !job.started_at || !job.completed_at
  ) {
    return null;
  }
  const start = Date.parse(job.started_at);
  const end = Date.parse(job.completed_at);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return null;
  }
  return {
    timing: { name: job.name, seconds: (end - start) / 1_000 },
    start,
    end,
  };
}

function hasJobTiming(job: ApiJob): boolean {
  if (!job.started_at || !job.completed_at) return false;
  const start = Date.parse(job.started_at);
  const end = Date.parse(job.completed_at);
  return Number.isFinite(start) && Number.isFinite(end) && end > start;
}

function isDrawableGanttJob(job: ApiJob | CachedCiGanttJob): boolean {
  return job.conclusion !== "skipped" && hasJobTiming(job);
}

function ganttJob(job: ApiJob): CachedCiGanttJob {
  return {
    name: job.name,
    status: job.status ?? "completed",
    conclusion: job.conclusion,
    started_at: job.started_at,
    completed_at: job.completed_at,
    steps: (job.steps ?? []).map((step) => ({
      name: step.name,
      number: step.number,
      conclusion: step.conclusion,
      started_at: step.started_at,
      completed_at: step.completed_at,
    })),
  };
}

async function fetchJobPage(
  path: string,
  token: string,
  source: CiHistorySource,
  request: GitHubRequest,
): Promise<ApiJob[]> {
  const jobs: ApiJob[] = [];
  for (let page = 1;; page++) {
    const response = await request<{ jobs?: ApiJob[] }>(
      `repos/${source.repo}/${path}${
        path.includes("?") ? "&" : "?"
      }per_page=${JOBS_PER_PAGE}&page=${page}`,
      token,
    );
    const batch = response.jobs ?? [];
    jobs.push(...batch);
    if (batch.length < JOBS_PER_PAGE) break;
  }
  return jobs;
}

async function fetchRunJobs(
  run: WorkflowRun,
  token: string,
  source: CiHistorySource,
  request: GitHubRequest,
): Promise<CiRunTiming> {
  let jobs: ApiJob[];
  let ganttJobs: ApiJob[];
  if (run.run_attempt > 1) {
    const complete = new Map<string, ApiJob>();
    let firstAttempt: ApiJob[] = [];
    for (let attempt = 1; attempt <= run.run_attempt; attempt++) {
      const attempted = await fetchJobPage(
        `actions/runs/${run.id}/attempts/${attempt}/jobs`,
        token,
        source,
        request,
      );
      if (attempt === 1) firstAttempt = attempted;
      for (const job of attempted) complete.set(job.name, job);
    }
    jobs = [...complete.values()];
    ganttJobs = firstAttempt.map((job) => {
      const latest = complete.get(job.name)!;
      if (!hasJobTiming(job) && hasJobTiming(latest)) return latest;
      return {
        ...job,
        status: latest.status,
        conclusion: latest.conclusion,
      };
    });
  } else {
    jobs = await fetchJobPage(
      `actions/runs/${run.id}/attempts/1/jobs`,
      token,
      source,
      request,
    );
    ganttJobs = jobs;
  }
  if (!ganttJobs.some(isDrawableGanttJob)) {
    throw new Error(
      `No completed CI job timings were returned for run ${run.id} attempt ${run.run_attempt}.`,
    );
  }
  const timed = jobs.flatMap((job) => {
    const value = timedJob(job);
    return value ? [value] : [];
  });
  const start = timed.length ? Math.min(...timed.map((job) => job.start)) : 0;
  const end = timed.length ? Math.max(...timed.map((job) => job.end)) : 0;
  return {
    jobs: timed.map((job) => job.timing),
    overallSeconds: start && end > start ? (end - start) / 1_000 : 0,
    ganttJobs: ganttJobs.map(ganttJob),
  };
}

export function buildCiJobHistory(
  samples: CiHistorySample[],
  failedRunCount = 0,
  axis?: { start: number; end: number },
  failedRunTimes: number[] = [],
  successfulRunTimes: number[] | null = null,
): CiJobHistorySnapshot {
  const jobSeries = new Map<string, CiJobSeries>();
  const groupPoints = new Map<string, CiJobPoint[]>();
  const overallPoints: CiJobPoint[] = [];
  const shardedBases = new Set<string>();
  const maxConcurrent = new Map<string, number>();

  for (const sample of samples) {
    if (
      sample.overallSeconds !== undefined &&
      Number.isFinite(sample.overallSeconds) && sample.overallSeconds > 0
    ) {
      overallPoints.push({
        at: sample.at,
        seconds: sample.overallSeconds,
        runId: sample.runId,
        runUrl: sample.runUrl,
      });
    }
    // A re-run can return two records with the same job name. Keep the longer
    // successful record so one run contributes one point to each series.
    const jobsByName = new Map<string, CiTimedJob>();
    for (const job of sample.jobs) {
      const current = jobsByName.get(job.name);
      if (!current || job.seconds > current.seconds) {
        jobsByName.set(job.name, job);
      }
    }
    const jobsByBase = new Map<string, CiTimedJob[]>();
    for (const job of jobsByName.values()) {
      const base = baseJobName(job.name);
      let series = jobSeries.get(job.name);
      if (!series) {
        series = { kind: "job", name: job.name, base, points: [] };
        jobSeries.set(job.name, series);
      }
      const point = {
        at: sample.at,
        seconds: job.seconds,
        runId: sample.runId,
        runUrl: sample.runUrl,
      };
      series.points.push(point);
      const siblings = jobsByBase.get(base);
      if (siblings) siblings.push(job);
      else jobsByBase.set(base, [job]);
    }
    for (const [base, jobs] of jobsByBase) {
      if (jobs.length > 1) shardedBases.add(base);
      maxConcurrent.set(
        base,
        Math.max(maxConcurrent.get(base) ?? 0, jobs.length),
      );
      const slowest = jobs.reduce((a, b) => a.seconds >= b.seconds ? a : b);
      const points = groupPoints.get(base);
      const point = {
        at: sample.at,
        seconds: slowest.seconds,
        runId: sample.runId,
        runUrl: sample.runUrl,
      };
      if (points) points.push(point);
      else groupPoints.set(base, [point]);
    }
  }

  const groups = [...shardedBases].sort().map((base): CiShardGroup => {
    const shards = [...jobSeries.values()]
      .filter((series) => series.base === base)
      .sort((a, b) =>
        shardKey(a.name).localeCompare(shardKey(b.name)) ||
        a.name.localeCompare(b.name)
      );
    return {
      base,
      maxConcurrent: maxConcurrent.get(base) ?? shards.length,
      aggregate: {
        kind: "group",
        name: base,
        base,
        points: groupPoints.get(base)!,
      },
      shards,
    };
  });
  const jobs = [...jobSeries.values()]
    .filter((series) => !shardedBases.has(series.base))
    .sort((a, b) => a.name.localeCompare(b.name));
  const times = samples.map((sample) => sample.at).filter(Number.isFinite);
  return {
    runCount: samples.length,
    successfulRunTimes,
    failedRunCount,
    failedRunTimes,
    stale: samples.length === 0 && failedRunCount > 0,
    axisStart: axis?.start ?? (times.length ? Math.min(...times) : 0),
    axisEnd: axis?.end ?? (times.length ? Math.max(...times) : 0),
    overall: overallPoints.length
      ? {
        kind: "overall",
        name: "Overall CI",
        base: "Overall CI",
        points: overallPoints,
      }
      : null,
    groups,
    jobs,
  };
}

const snapshotKey = (source: CiHistorySource, days: number): string =>
  `${source.key}:${days}`;

function snapshotFingerprint(
  snapshot: CiJobHistorySnapshot | null,
): string {
  if (!snapshot) return "none";
  return JSON.stringify([
    snapshot.runCount,
    snapshot.successfulRunTimes,
    snapshot.failedRunCount,
    snapshot.failedRunTimes,
    snapshot.stale,
    snapshot.overall,
    snapshot.groups,
    snapshot.jobs,
  ]);
}

export function ciJobHistorySnapshotVersion(
  snapshot: CiJobHistorySnapshot | null,
): string {
  const value = snapshotFingerprint(snapshot);
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function inRequestedWindow(
  snapshot: CiJobHistorySnapshot,
  now: number,
  days: number,
): CiJobHistorySnapshot {
  const axisStart = now - days * DAY_MS;
  const samples = new Map<number, CiHistorySample>();
  const sampleFor = (point: CiJobPoint): CiHistorySample | null => {
    if (point.at < axisStart || point.at > now) return null;
    let sample = samples.get(point.runId);
    if (!sample) {
      sample = {
        runId: point.runId,
        runUrl: point.runUrl,
        at: point.at,
        jobs: [],
      };
      samples.set(point.runId, sample);
    }
    return sample;
  };
  for (const point of snapshot.overall?.points ?? []) {
    const sample = sampleFor(point);
    if (sample) sample.overallSeconds = point.seconds;
  }
  const jobs = [
    ...snapshot.jobs,
    ...snapshot.groups.flatMap((group) => group.shards),
  ];
  for (const series of jobs) {
    for (const point of series.points) {
      const sample = sampleFor(point);
      if (sample) {
        sample.jobs.push({ name: series.name, seconds: point.seconds });
      }
    }
  }
  const failedRunTimes = snapshot.failedRunTimes.filter((at) =>
    at >= axisStart && at <= now
  );
  const successfulRunTimes =
    snapshot.successfulRunTimes?.filter((at) => at >= axisStart && at <= now) ??
      null;
  const untimedFailureCount = Math.max(
    0,
    snapshot.failedRunCount - snapshot.failedRunTimes.length,
  );
  const overlapsOriginalWindow = snapshot.axisEnd >= axisStart &&
    snapshot.axisStart <= now;
  const failedRunCount = failedRunTimes.length +
    (overlapsOriginalWindow ? untimedFailureCount : 0);
  const filtered = buildCiJobHistory(
    [...samples.values()].sort((a, b) => a.at - b.at),
    failedRunCount,
    { start: axisStart, end: now },
    failedRunTimes,
    successfulRunTimes,
  );
  return {
    ...filtered,
    stale: filtered.runCount > 0 ? snapshot.stale : filtered.stale,
  };
}

function sampleFromCache(run: CachedCiRun): CiHistorySample {
  return {
    runId: run.runId,
    runUrl: run.runUrl,
    at: run.at,
    overallSeconds: run.overallSeconds,
    jobs: run.jobs,
  };
}

function isSuccessfulMainCachedRun(run: CachedCiRun): boolean {
  return run.gantt.status === "completed" &&
    run.gantt.conclusion === "success" && run.gantt.event === "push" &&
    (run.gantt.headBranch === undefined || run.gantt.headBranch === "main");
}

function isMainCachedRun(run: CachedCiRun): boolean {
  return run.gantt.status === "completed" &&
    run.gantt.event === "push" &&
    (run.gantt.headBranch === undefined || run.gantt.headBranch === "main");
}

function hasDrawableGanttTiming(run: CachedCiRun): boolean {
  return run.gantt.jobs.some(isDrawableGanttJob);
}

function workflowRunFromCache(
  run: CachedCiRun,
  source: CiHistorySource,
): WorkflowRun {
  return {
    id: run.runId,
    status: run.gantt.status,
    conclusion: run.gantt.conclusion,
    event: run.gantt.event,
    head_branch: run.gantt.headBranch,
    head_sha: run.headSha,
    path: `.github/workflows/${source.workflow}`,
    run_attempt: run.runAttempt,
    run_started_at: run.gantt.startedAt,
    html_url: run.runUrl,
    name: run.gantt.workflowName,
  };
}

function ganttInputRun(run: CachedCiRun): CiGanttInputRun {
  return {
    run: {
      attempt: run.runAttempt,
      databaseId: run.runId,
      status: run.gantt.status,
      conclusion: run.gantt.conclusion ?? "",
      event: run.gantt.event,
      headBranch: run.gantt.headBranch,
      startedAt: run.gantt.startedAt,
      workflowName: run.gantt.workflowName,
    },
    jobs: run.gantt.jobs,
  };
}

export class CiJobHistoryCollector {
  #store: CiJobHistoryStore;
  #github: GitHubRequest;
  #cacheSaves = new Map<number, Promise<void>>();
  #jobRequests = new Map<string, Promise<CachedCiRun>>();
  #latest = new Map<string, CiJobHistorySnapshot>();
  #sampledRuns = new Map<string, CachedCiRunReference[]>();
  #snapshotRevisions = new Map<string, number>();
  #progressById = new Map<string, CiJobProgressRecord>();
  #progressByKey = new Map<string, CiJobProgressRecord>();
  #progressSequence = 0;
  #refreshedAt = new Map<string, { at: number; revision: number }>();
  #refreshFailureAt = new Map<CiHistorySourceKey, number>();
  #refreshRequests = new Map<string, Promise<CiJobHistorySnapshot>>();
  #recentWorkflowRuns = new Map<string, { at: number; runs: WorkflowRun[] }>();
  #selectedWorkflowRuns = new Map<
    string,
    { at: number; run: WorkflowRun }
  >();
  #recentWorkflowRequests = new Map<string, CiWorkflowDiscovery>();
  #selectedWorkflowRequests = new Map<
    string,
    CiWorkflowDiscovery<SelectedWorkflowRuns>
  >();
  #workflowRuns = new Map<
    CiHistorySourceKey,
    { at: number; runs: WorkflowRun[] }
  >();
  #workflowRequests = new Map<CiHistorySourceKey, CiWorkflowDiscovery>();
  #ganttRequests = new Map<string, CiGanttRequest>();

  constructor(
    store = new CiJobHistoryStore(),
    request: GitHubRequest = performanceGithub,
  ) {
    this.#store = store;
    this.#github = request;
  }

  #newProgress(
    source: CiHistorySource,
    days: number,
    baseline?: CiJobHistorySnapshot | null,
    key = snapshotKey(source, days),
  ): CiJobProgressRecord {
    const previous = this.#progressByKey.get(key);
    if (previous) {
      this.#progressByKey.delete(key);
      this.#progressById.delete(previous.state.id);
    }
    const now = Date.now();
    const state: CiJobFetchProgress = {
      id: `${source.key}-${days}-${now.toString(36)}-${++this
        .#progressSequence}`,
      source: source.key,
      days,
      phase: "discovering",
      discoveryRequestsMade: 0,
      discoveryResponsesReceived: 0,
      discoveryOutstandingRequests: 0,
      totalRuns: 0,
      cachedRuns: 0,
      requestsMade: 0,
      responsesReceived: 0,
      sharedRequests: 0,
      sharedResponses: 0,
      successfulResponses: 0,
      failedResponses: 0,
      completedRuns: 0,
      queuedRuns: 0,
      outstandingRequests: 0,
      needsReload: false,
      updatedAt: now,
    };
    const record = {
      state,
      listeners: new Set<CiJobProgressListener>(),
      baselines: new Set(
        baseline === undefined ? [] : [snapshotFingerprint(baseline)],
      ),
    };
    this.#progressByKey.set(key, record);
    this.#progressById.set(state.id, record);
    this.#trimProgressRecords(record);
    return record;
  }

  #trimProgressRecords(preserve: CiJobProgressRecord): void {
    if (this.#progressByKey.size <= PROGRESS_RECORD_MAX) return;
    for (const [key, record] of this.#progressByKey) {
      if (this.#progressByKey.size <= PROGRESS_RECORD_MAX) break;
      const terminal = record.state.phase === "complete" ||
        record.state.phase === "error";
      if (record !== preserve && terminal) {
        this.#progressByKey.delete(key);
        this.#progressById.delete(record.state.id);
      }
    }
  }

  #updateProgress(
    record: CiJobProgressRecord,
    update: Partial<CiJobFetchProgress>,
  ): void {
    Object.assign(record.state, update);
    record.state.completedRuns = Math.min(
      record.state.totalRuns,
      record.state.cachedRuns + record.state.responsesReceived +
        record.state.sharedResponses,
    );
    record.state.queuedRuns = Math.max(
      0,
      record.state.totalRuns - record.state.cachedRuns -
        record.state.requestsMade - record.state.sharedRequests,
    );
    record.state.outstandingRequests = Math.max(
      0,
      record.state.requestsMade + record.state.sharedRequests -
        record.state.responsesReceived - record.state.sharedResponses,
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
    if (update.phase === "complete" || update.phase === "error") {
      this.#trimProgressRecords(record);
    }
  }

  #startJobLoadProgress(
    progress: CiJobProgressRecord,
    kind: CiJobLoad["kind"],
  ): void {
    if (kind === "requested") {
      this.#updateProgress(progress, {
        requestsMade: progress.state.requestsMade + 1,
      });
    } else if (kind === "joined") {
      this.#updateProgress(progress, {
        sharedRequests: progress.state.sharedRequests + 1,
      });
    }
  }

  #finishJobLoadProgress(
    progress: CiJobProgressRecord,
    kind: CiJobLoad["kind"],
    succeeded: boolean,
  ): void {
    if (kind === "cached") {
      this.#updateProgress(progress, {
        cachedRuns: progress.state.cachedRuns + 1,
      });
      return;
    }
    this.#updateProgress(progress, {
      responsesReceived: progress.state.responsesReceived +
        (kind === "requested" ? 1 : 0),
      sharedResponses: progress.state.sharedResponses +
        (kind === "joined" ? 1 : 0),
      successfulResponses: progress.state.successfulResponses +
        (succeeded ? 1 : 0),
      failedResponses: progress.state.failedResponses + (succeeded ? 0 : 1),
    });
  }

  progress(id: string): CiJobFetchProgress | null {
    const record = this.#progressById.get(id);
    return record ? { ...record.state } : null;
  }

  subscribeProgress(
    id: string,
    listener: CiJobProgressListener,
  ): (() => void) | null {
    const record = this.#progressById.get(id);
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

  snapshot(
    source = CI_HISTORY_SOURCES.labs,
    days = CI_HISTORY_DAYS,
  ): CiJobHistorySnapshot | null {
    return this.#latest.get(snapshotKey(source, days)) ?? null;
  }

  async cached(
    source = CI_HISTORY_SOURCES.labs,
    days = CI_HISTORY_DAYS,
    now = Date.now(),
  ): Promise<CiJobHistorySnapshot | null> {
    await this.#store.load();
    const key = snapshotKey(source, days);
    if (
      this.#store.quarantineFutureRefresh(
        source.repo,
        source.workflow,
        days,
      )
    ) {
      this.#refreshedAt.delete(key);
      await this.#saveCache(now);
    }
    const refresh = this.#store.refresh(
      source.repo,
      source.workflow,
      days,
    );
    const current = this.snapshot(source, days);
    const sourceRevision = this.#store.revisionFor(
      source.repo,
      source.workflow,
    );
    if (current && this.#snapshotRevisions.get(key) === sourceRevision) {
      return inRequestedWindow(current, now, days);
    }
    const cutoff = now - days * DAY_MS;
    const successfulRunTimes =
      refresh?.successfulRunTimes.filter((at) => at >= cutoff && at <= now) ??
        null;
    const resolvedRefreshRuns = this.#store.refreshedRuns(
      source.repo,
      source.workflow,
      days,
    );
    const refreshedRuns =
      resolvedRefreshRuns?.filter((run) => run.at >= cutoff && run.at <= now) ??
        resolvedRefreshRuns;
    const runs = refreshedRuns ?? sampleNewestPerBucket(
      this.#store.list(source.repo, source.workflow, cutoff).filter(
        isSuccessfulMainCachedRun,
      ),
      (run) => run.at,
      cutoff,
      ciHistoryBucketMs(days),
    );
    if (!runs.length && !refresh) {
      return current ? inRequestedWindow(current, now, days) : null;
    }
    const failedRunTimes =
      refresh?.failedRunTimes.filter((at) => at >= cutoff && at <= now) ?? [];
    const untimedFailureCount = refresh
      ? Math.max(0, refresh.failedRunCount - refresh.failedRunTimes.length)
      : 0;
    const built = buildCiJobHistory(
      runs.map(sampleFromCache),
      failedRunTimes.length + untimedFailureCount,
      { start: cutoff, end: now },
      failedRunTimes,
      successfulRunTimes,
    );
    const value = refresh?.stale && built.runCount
      ? { ...built, stale: true }
      : built;
    this.#sampledRuns.set(
      key,
      runs.map((run) => ({
        runId: run.runId,
        runAttempt: run.runAttempt,
      })),
    );
    this.#latest.set(key, value);
    this.#snapshotRevisions.set(
      key,
      this.#store.revisionFor(source.repo, source.workflow),
    );
    const freshRefresh = this.#store.freshRefresh(
      source.repo,
      source.workflow,
      days,
    );
    if (freshRefresh) {
      this.#refreshedAt.set(key, {
        at: freshRefresh.refreshedAt,
        revision: this.#store.revisionFor(source.repo, source.workflow),
      });
    }
    return value;
  }

  #jobsForRun(
    run: WorkflowRun,
    token: string,
    source: CiHistorySource,
    now: number,
    exactAttempt = false,
    expectedHeadSha = "",
  ): CiJobLoad {
    const pending = this.#pendingJobsForRun(run, source, exactAttempt);
    if (pending) return { kind: "joined", result: pending };
    let cached = exactAttempt
      ? this.#store.get(
        source.repo,
        source.workflow,
        run.id,
        run.run_attempt,
      )
      : this.#store.latest(source.repo, source.workflow, run.id);
    if (exactAttempt && cached && run.head_sha) {
      cached = this.#store.setHeadSha(
        source.repo,
        source.workflow,
        run.id,
        run.run_attempt,
        run.head_sha,
      );
    }
    const repairCachedEntry = exactAttempt && cached !== undefined &&
      !hasDrawableGanttTiming(cached);
    if (
      cached &&
      (exactAttempt
        ? cached.runAttempt === run.run_attempt &&
          cached.headSha === expectedHeadSha &&
          hasDrawableGanttTiming(cached)
        : cached.runAttempt >= run.run_attempt)
    ) {
      return { kind: "cached", result: Promise.resolve(cached) };
    }

    const key =
      `${source.repo}:${source.workflow}:${run.id}:${run.run_attempt}:${
        exactAttempt ? "exact" : "aggregate"
      }`;
    let request = this.#jobRequests.get(key);
    if (!request) {
      request = fetchRunJobs(run, token, source, this.#github)
        .then(async (timing): Promise<CachedCiRun> => {
          const entry = {
            repo: source.repo,
            workflow: source.workflow,
            runId: run.id,
            runAttempt: run.run_attempt,
            headSha: run.head_sha?.toLowerCase(),
            runUrl: run.html_url,
            at: runTime(run),
            overallSeconds: timing.overallSeconds,
            jobs: timing.jobs,
            gantt: {
              status: run.status,
              conclusion: run.conclusion,
              event: run.event,
              headBranch: run.head_branch ?? undefined,
              startedAt: run.run_started_at,
              workflowName: run.name ?? source.workflow,
              jobs: timing.ganttJobs,
            },
          };
          if (repairCachedEntry) this.#store.replace(entry);
          else this.#store.set(entry);
          const cached = exactAttempt
            ? this.#store.get(
              source.repo,
              source.workflow,
              run.id,
              run.run_attempt,
            )!
            : this.#store.latest(source.repo, source.workflow, run.id)!;
          try {
            await this.#saveCache(now);
          } catch (error) {
            throw new CiJobCacheWriteError(error);
          }
          return cached;
        })
        .finally(() => this.#jobRequests.delete(key));
      this.#jobRequests.set(key, request);
    }
    return { kind: "requested", result: request };
  }

  #jobRequestPrefix(run: WorkflowRun, source: CiHistorySource): string {
    return `${source.repo}:${source.workflow}:${run.id}:`;
  }

  #pendingJobsForRun(
    run: WorkflowRun,
    source: CiHistorySource,
    exactAttempt = false,
  ): Promise<CachedCiRun> | null {
    const prefix = this.#jobRequestPrefix(run, source);
    let newestAttempt = -1;
    let pending: Promise<CachedCiRun> | null = null;
    for (const [key, request] of this.#jobRequests) {
      if (!key.startsWith(prefix)) continue;
      const [attemptValue, mode] = key.slice(prefix.length).split(":", 2);
      if (mode !== (exactAttempt ? "exact" : "aggregate")) continue;
      const attempt = Number(attemptValue);
      if (
        (exactAttempt
          ? attempt === run.run_attempt
          : attempt >= run.run_attempt) &&
        attempt > newestAttempt
      ) {
        newestAttempt = attempt;
        pending = request;
      }
    }
    return pending;
  }

  async #saveCache(now: number): Promise<void> {
    if (!this.#store.dirty) return;
    const revision = this.#store.revision;
    let request = this.#cacheSaves.get(revision);
    if (!request) {
      const save = this.#store.save(now);
      const saveRevision = this.#store.revision;
      request = save.finally(() => {
        this.#cacheSaves.delete(revision);
        this.#cacheSaves.delete(saveRevision);
      });
      this.#cacheSaves.set(revision, request);
      this.#cacheSaves.set(saveRevision, request);
    }
    await request;
  }

  async collect(
    token: string,
    now = Date.now(),
    source = CI_HISTORY_SOURCES.labs,
    days = CI_HISTORY_DAYS,
    workflowRuns?: WorkflowRun[],
    progress?: CiJobProgressRecord,
  ): Promise<CiJobHistorySnapshot> {
    await this.#store.load();
    const previous = this.snapshot(source, days) ??
      await this.cached(source, days, now);
    const workflowRunHistory = workflowRuns ??
      await fetchWorkflowRuns(token, now, source, this.#github);
    const successfulRuns = successfulMainWorkflowRuns(
      workflowRunHistory,
      now,
      days,
    );
    const successfulRunTimes = successfulRuns.map(runTime).sort((a, b) =>
      a - b
    );
    const runs = sampleNewestPerBucket(
      successfulRuns,
      runTime,
      now - days * DAY_MS,
      ciHistoryBucketMs(days),
    );
    const priorRefresh = this.#store.refresh(
      source.repo,
      source.workflow,
      days,
    );
    const desiredRuns = runs.map((run) => ({
      runId: run.id,
      runAttempt: run.run_attempt,
    }));
    if (
      priorRefresh &&
      JSON.stringify(priorRefresh.sampledRuns) !== JSON.stringify(desiredRuns)
    ) {
      this.#store.invalidateRefresh(source.repo, source.workflow, days);
      this.#refreshedAt.delete(snapshotKey(source, days));
      await this.#saveCache(now);
    }
    const entries = new Map<number, CachedCiRun>();
    for (const run of runs) {
      const cached = this.#store.latest(source.repo, source.workflow, run.id);
      if (
        cached && cached.runAttempt >= run.run_attempt &&
        !this.#pendingJobsForRun(run, source)
      ) {
        entries.set(run.id, cached);
      }
    }
    const missing = runs.filter((run) => !entries.has(run.id));
    if (progress) {
      this.#updateProgress(progress, {
        phase: "fetching",
        totalRuns: runs.length,
        cachedRuns: entries.size,
        needsReload: missing.length > 0,
      });
    }
    const failed = new Map<number, unknown>();
    for (let i = 0; i < missing.length; i += JOB_FETCH_CONCURRENCY) {
      const batch = missing.slice(i, i + JOB_FETCH_CONCURRENCY);
      const outcomes = await Promise.all(
        batch.map(async (run): Promise<CiJobFetchOutcome> => {
          const load = this.#jobsForRun(run, token, source, now);
          if (progress) this.#startJobLoadProgress(progress, load.kind);
          try {
            const entry = await load.result;
            if (progress) {
              this.#finishJobLoadProgress(progress, load.kind, true);
            }
            return { run, entry };
          } catch (error) {
            if (progress) {
              this.#finishJobLoadProgress(progress, load.kind, false);
            }
            return {
              run,
              error,
              persistence: error instanceof CiJobCacheWriteError,
            };
          }
        }),
      );
      const persistenceFailure = outcomes.find((outcome) =>
        "error" in outcome && outcome.persistence
      );
      if (persistenceFailure && "error" in persistenceFailure) {
        throw persistenceFailure.error;
      }
      for (const outcome of outcomes) {
        if ("entry" in outcome) entries.set(outcome.run.id, outcome.entry);
        else failed.set(outcome.run.id, outcome.error);
      }
    }
    if (progress) this.#updateProgress(progress, { phase: "saving" });
    await this.#saveCache(now);
    const samples = runs.flatMap((run) => {
      const entry = entries.get(run.id);
      return entry ? [sampleFromCache(entry)] : [];
    });
    const failures = runs.flatMap((run) => {
      return failed.has(run.id) ? [{ run, error: failed.get(run.id) }] : [];
    });
    if (failures.length) {
      const first = failures[0];
      const message = first.error instanceof Error
        ? first.error.message
        : String(first.error);
      console.error(
        `CI job history could not read ${failures.length} sampled run(s); ` +
          `first was ${first.run.id} attempt ${first.run.run_attempt}: ${message}`,
      );
    }
    const key = snapshotKey(source, days);
    const failedRunTimes = failures.map(({ run }) => runTime(run)).filter(
      Number.isFinite,
    );
    const previousInWindow = previous
      ? inRequestedWindow(previous, now, days)
      : null;
    const preservePrevious = !samples.length && failures.length &&
      Boolean(previousInWindow?.runCount);
    const value = preservePrevious
      ? {
        ...previousInWindow!,
        successfulRunTimes: [
          ...new Set([
            ...successfulRunTimes,
            ...(previousInWindow!.successfulRunTimes ?? []),
          ]),
        ].sort((a, b) => a - b),
        failedRunCount: failures.length,
        failedRunTimes,
        stale: true,
      }
      : buildCiJobHistory(
        samples,
        failures.length,
        {
          start: now - days * DAY_MS,
          end: now,
        },
        failedRunTimes,
        successfulRunTimes,
      );
    const sampledRuns = preservePrevious
      ? (this.#sampledRuns.get(key) ?? []).filter((reference) => {
        const run = this.#store.get(
          source.repo,
          source.workflow,
          reference.runId,
          reference.runAttempt,
        );
        return Boolean(
          run && run.at >= now - days * DAY_MS && run.at <= now,
        );
      })
      : runs.flatMap((run) => {
        const entry = entries.get(run.id);
        return entry
          ? [{ runId: entry.runId, runAttempt: entry.runAttempt }]
          : [];
      });
    if (preservePrevious && sampledRuns.length !== value.runCount) {
      throw new Error(
        "CI job history could not preserve the exact previous run set.",
      );
    }
    this.#sampledRuns.set(key, sampledRuns);
    this.#latest.set(key, value);
    this.#snapshotRevisions.set(
      key,
      this.#store.revisionFor(source.repo, source.workflow),
    );
    const rateLimitFailure = failures.find(({ error }) =>
      error instanceof GitHubRateLimitBudgetError
    );
    if (rateLimitFailure) throw rateLimitFailure.error;
    return value;
  }

  async #discoverWorkflowRuns<Key, Result>(
    requests: Map<Key, CiWorkflowDiscovery<Result>>,
    key: Key,
    load: (request: GitHubRequest) => Promise<Result>,
    progress?: CiJobProgressRecord,
  ): Promise<Result> {
    let discovery = requests.get(key);
    if (!discovery) {
      const activeDiscovery: CiWorkflowDiscovery<Result> = {
        progresses: new Set(progress ? [progress] : []),
        requestsMade: 0,
        responsesReceived: 0,
        result: Promise.resolve(undefined as Result),
      };
      const updateProgress = () => {
        for (const progress of activeDiscovery.progresses) {
          this.#updateProgress(progress, {
            discoveryRequestsMade: activeDiscovery.requestsMade,
            discoveryResponsesReceived: activeDiscovery.responsesReceived,
            discoveryOutstandingRequests: Math.max(
              0,
              activeDiscovery.requestsMade -
                activeDiscovery.responsesReceived,
            ),
          });
        }
      };
      const request: GitHubRequest = async <T>(
        path: string,
        token?: string,
      ) => {
        activeDiscovery.requestsMade++;
        updateProgress();
        try {
          return await this.#github<T>(path, token);
        } finally {
          activeDiscovery.responsesReceived++;
          updateProgress();
        }
      };
      activeDiscovery.result = Promise.resolve()
        .then(() => load(request))
        .finally(() => {
          if (requests.get(key) === activeDiscovery) {
            requests.delete(key);
          }
        });
      discovery = activeDiscovery;
      requests.set(key, activeDiscovery);
    } else if (progress) {
      discovery.progresses.add(progress);
      this.#updateProgress(progress, {
        discoveryRequestsMade: discovery.requestsMade,
        discoveryResponsesReceived: discovery.responsesReceived,
        discoveryOutstandingRequests: Math.max(
          0,
          discovery.requestsMade - discovery.responsesReceived,
        ),
      });
    }
    return await discovery.result;
  }

  async #runsForRefresh(
    token: string,
    source: CiHistorySource,
    now: number,
    progress?: CiJobProgressRecord,
  ): Promise<WorkflowRun[]> {
    const cached = this.#workflowRuns.get(source.key);
    if (cached && Date.now() - cached.at < REFRESH_MS) return cached.runs;
    return await this.#discoverWorkflowRuns(
      this.#workflowRequests,
      source.key,
      (request) =>
        fetchWorkflowRuns(token, now, source, request).then((runs) => {
          this.#workflowRuns.set(source.key, { at: Date.now(), runs });
          return runs;
        }),
      progress,
    );
  }

  #selectedWorkflowRunKey(
    source: CiHistorySource,
    headSha: string,
    selected: CiGanttRunSelection,
  ): string {
    return `${source.key}:selected:${headSha}:${selected.runId}:${selected.runAttempt}`;
  }

  #cacheSelectedWorkflowRun(key: string, run: WorkflowRun): void {
    this.#selectedWorkflowRuns.delete(key);
    this.#selectedWorkflowRuns.set(key, { at: Date.now(), run });
    if (
      this.#selectedWorkflowRuns.size > SELECTED_WORKFLOW_RUN_CACHE_MAX
    ) {
      const oldest = this.#selectedWorkflowRuns.keys().next();
      if (!oldest.done) this.#selectedWorkflowRuns.delete(oldest.value);
    }
  }

  async #selectedRunsForGantt(
    token: string,
    source: CiHistorySource,
    options: Required<CiGanttOptions>,
    progress?: CiJobProgressRecord,
  ): Promise<SelectedWorkflowRuns> {
    const resolved = new Map<number, WorkflowRun>();
    const missing: CiGanttRunSelection[] = [];
    for (const selected of options.selectedRuns) {
      const persisted = this.#store.get(
        source.repo,
        source.workflow,
        selected.runId,
        selected.runAttempt,
      );
      if (
        persisted?.headSha === options.headSha &&
        hasDrawableGanttTiming(persisted)
      ) {
        resolved.set(selected.runId, workflowRunFromCache(persisted, source));
        continue;
      }
      const key = this.#selectedWorkflowRunKey(
        source,
        options.headSha,
        selected,
      );
      const cached = this.#selectedWorkflowRuns.get(key);
      if (cached && Date.now() - cached.at < REFRESH_MS) {
        resolved.set(selected.runId, cached.run);
      } else {
        missing.push(selected);
      }
    }

    let failure: SelectedWorkflowRuns["failure"];
    if (missing.length) {
      const key = `${source.key}:selected:${options.headSha}:${
        missing.map(({ runId, runAttempt }) => `${runId}:${runAttempt}`).join(
          ",",
        )
      }`;
      const discovered = await this.#discoverWorkflowRuns(
        this.#selectedWorkflowRequests,
        key,
        async (request): Promise<SelectedWorkflowRuns> => {
          const runs: WorkflowRun[] = [];
          let failure: SelectedWorkflowRuns["failure"];
          for (
            let index = 0;
            index < missing.length;
            index += JOB_FETCH_CONCURRENCY
          ) {
            const batch = missing.slice(index, index + JOB_FETCH_CONCURRENCY);
            const outcomes = await Promise.allSettled(
              batch.map(async (selected) =>
                validateSelectedWorkflowRun(
                  await request<WorkflowRun>(
                    `repos/${source.repo}/actions/runs/${selected.runId}/attempts/${selected.runAttempt}`,
                    token,
                  ),
                  selected,
                  source,
                  options.headSha,
                )
              ),
            );
            for (const [outcomeIndex, outcome] of outcomes.entries()) {
              if (outcome.status === "rejected") {
                failure ??= { error: outcome.reason };
                continue;
              }
              const selected = batch[outcomeIndex];
              runs.push(outcome.value);
              this.#cacheSelectedWorkflowRun(
                this.#selectedWorkflowRunKey(
                  source,
                  options.headSha,
                  selected,
                ),
                outcome.value,
              );
            }
            if (failure) break;
          }
          return { runs, failure };
        },
        progress,
      );
      failure = discovered.failure;
      for (const run of discovered.runs) resolved.set(run.id, run);
    }

    return {
      runs: options.selectedRuns.flatMap((selected) => {
        const run = resolved.get(selected.runId);
        return run ? [run] : [];
      }),
      failure,
    };
  }

  async #runsForGantt(
    token: string,
    source: CiHistorySource,
    options: Required<CiGanttOptions>,
    now: number,
    progress?: CiJobProgressRecord,
  ): Promise<SelectedWorkflowRuns> {
    if (options.selectedRuns.length) {
      return await this.#selectedRunsForGantt(
        token,
        source,
        options,
        progress,
      );
    }
    if (options.mainOnly && !options.allConclusions) {
      return {
        runs: successfulMainWorkflowRuns(
          await this.#runsForRefresh(token, source, now, progress),
          now,
          CI_HISTORY_DAYS,
        ),
      };
    }
    const key = `${source.key}:${options.mainOnly ? "main" : "all"}`;
    const cached = this.#recentWorkflowRuns.get(key);
    if (cached && Date.now() - cached.at < REFRESH_MS) {
      return { runs: cached.runs };
    }
    return {
      runs: await this.#discoverWorkflowRuns(
        this.#recentWorkflowRequests,
        key,
        (request) =>
          fetchRecentWorkflowRuns(token, source, options.mainOnly, request)
            .then(
              (runs) => {
                this.#recentWorkflowRuns.set(key, {
                  at: Date.now(),
                  runs,
                });
                return runs;
              },
            ),
        progress,
      ),
    };
  }

  #cachedGanttInput(
    source: CiHistorySource,
    options: CiGanttOptions,
  ): CiGanttInput {
    const selectedRuns = options.selectedRuns ?? [];
    const candidates = selectedRuns.length
      ? selectedRuns.flatMap(({ runId, runAttempt }) => {
        const run = this.#store.get(
          source.repo,
          source.workflow,
          runId,
          runAttempt,
        );
        if (
          !run || run.headSha !== options.headSha ||
          !hasDrawableGanttTiming(run)
        ) return [];
        return [run];
      })
      : this.#store.list(source.repo, source.workflow);
    const runs = candidates
      .filter((run) =>
        !options.mainOnly ||
        (options.allConclusions
          ? isMainCachedRun(run)
          : isSuccessfulMainCachedRun(run))
      )
      .sort((a, b) => b.at - a.at)
      .slice(0, options.limit)
      .map(ganttInputRun);
    return { runs };
  }

  async gantt(
    token: string | undefined,
    source: CiHistorySource,
    options: CiGanttOptions,
    now = Date.now(),
    workflowRuns?: WorkflowRun[],
  ): Promise<CiGanttInput> {
    return await this.#collectGantt(
      token,
      source,
      normalizedGanttOptions(options),
      now,
      workflowRuns,
    );
  }

  async #collectGantt(
    token: string | undefined,
    source: CiHistorySource,
    normalized: Required<CiGanttOptions>,
    now: number,
    workflowRuns?: WorkflowRun[],
    progress?: CiJobProgressRecord,
  ): Promise<CiGanttInput> {
    await this.#store.load();
    await this.#saveCache(now);
    const cached = this.#cachedGanttInput(source, normalized);
    const exactSelection = normalized.selectedRuns.length > 0;
    const hasEverySelectedRun = exactSelection &&
      normalized.selectedRuns.every(({ runId, runAttempt }) =>
        cached.runs.some((entry) =>
          entry.run.databaseId === runId &&
          (entry.run.attempt ?? 1) === runAttempt
        )
      );
    if (hasEverySelectedRun) return cached;
    if (!token) {
      if (!exactSelection && cached.runs.length) {
        if (progress) {
          this.#updateProgress(progress, {
            warning:
              "Showing cached runs; set GH_TOKEN to check for newer attempts.",
          });
        }
        return cached;
      }
      throw new Error("Set GH_TOKEN to collect CI Gantt data.");
    }

    let discovery: SelectedWorkflowRuns;
    try {
      discovery = workflowRuns
        ? { runs: workflowRuns }
        : await this.#runsForGantt(
          token,
          source,
          normalized,
          now,
          progress,
        );
    } catch (error) {
      if (!exactSelection && cached.runs.length) {
        if (progress) {
          const message = error instanceof Error
            ? error.message
            : String(error);
          this.#updateProgress(progress, {
            warning: `Showing cached runs because workflow discovery reported ${
              friendlyError(message)
            }.`,
          });
        }
        return cached;
      }
      throw error;
    }
    const history = discovery.runs;
    const selectionFailure = discovery.failure;
    const latest = new Map<number, WorkflowRun>();
    for (const run of history) {
      const current = latest.get(run.id);
      if (!current || run.run_attempt > current.run_attempt) {
        latest.set(run.id, run);
      }
    }
    const requestedRuns = new Map(
      normalized.selectedRuns.map((run) => [run.runId, run.runAttempt]),
    );
    const selected = [...latest.values()]
      .filter((run) =>
        (!requestedRuns.size ||
          (requestedRuns.has(run.id) &&
            run.run_attempt === requestedRuns.get(run.id)!)) &&
        (!normalized.mainOnly ||
          (run.event === "push" &&
            (run.head_branch === undefined || run.head_branch === null ||
              run.head_branch === "main") &&
            (normalized.allConclusions ||
              (run.status === "completed" && run.conclusion === "success"))))
      )
      .sort((a, b) => runTime(b) - runTime(a))
      .slice(0, normalized.limit)
      .filter((run) => run.status === "completed");
    const missing = selected.filter((run) => {
      const entry = exactSelection
        ? this.#store.get(
          source.repo,
          source.workflow,
          run.id,
          run.run_attempt,
        )
        : this.#store.latest(source.repo, source.workflow, run.id);
      return !entry ||
        (exactSelection
          ? entry.headSha !== normalized.headSha ||
            !hasDrawableGanttTiming(entry)
          : entry.runAttempt < run.run_attempt) ||
        Boolean(this.#pendingJobsForRun(run, source, exactSelection));
    });
    if (progress) {
      this.#updateProgress(progress, {
        phase: "fetching",
        totalRuns: exactSelection
          ? normalized.selectedRuns.length
          : selected.length,
        cachedRuns: selected.length - missing.length,
      });
    }
    const failures: { run: WorkflowRun; error: unknown }[] = [];
    for (let i = 0; i < missing.length; i += JOB_FETCH_CONCURRENCY) {
      const batch = missing.slice(i, i + JOB_FETCH_CONCURRENCY);
      const outcomes = await Promise.all(
        batch.map(async (run): Promise<
          | { run: WorkflowRun; entry: CachedCiRun }
          | { run: WorkflowRun; error: unknown }
        > => {
          const load = this.#jobsForRun(
            run,
            token,
            source,
            now,
            exactSelection,
            normalized.headSha,
          );
          if (progress) this.#startJobLoadProgress(progress, load.kind);
          try {
            const outcome = {
              run,
              entry: await load.result,
            };
            if (progress) {
              this.#finishJobLoadProgress(progress, load.kind, true);
            }
            return outcome;
          } catch (error) {
            if (progress) {
              this.#finishJobLoadProgress(progress, load.kind, false);
            }
            return { run, error };
          }
        }),
      );
      for (const outcome of outcomes) {
        if ("error" in outcome) failures.push(outcome);
      }
    }
    const persistenceFailure = failures.find(({ error }) =>
      error instanceof CiJobCacheWriteError
    );
    if (persistenceFailure) throw persistenceFailure.error;
    const quotaFailure = failures.find(({ error }) =>
      error instanceof GitHubRateLimitBudgetError
    );
    const reportedFailure = quotaFailure ?? failures[0];
    if (progress) this.#updateProgress(progress, { phase: "saving" });
    await this.#saveCache(now);
    if (reportedFailure) {
      const message = reportedFailure.error instanceof Error
        ? reportedFailure.error.message
        : String(reportedFailure.error);
      console.error(
        `CI Gantt could not read ${failures.length} run(s); ` +
          `reported run ${reportedFailure.run.id} attempt ${reportedFailure.run.run_attempt}: ${message}`,
      );
    }
    const runs = selected.flatMap((run) => {
      const entry = exactSelection
        ? this.#store.get(
          source.repo,
          source.workflow,
          run.id,
          run.run_attempt,
        )
        : this.#store.latest(source.repo, source.workflow, run.id);
      if (
        !entry ||
        (exactSelection
          ? entry.headSha !== normalized.headSha ||
            !hasDrawableGanttTiming(entry)
          : entry.runAttempt < run.run_attempt)
      ) return [];
      return [ganttInputRun(entry)];
    });
    if (exactSelection) {
      if (selectionFailure) {
        throw selectionFailure.error instanceof Error
          ? selectionFailure.error
          : new Error(String(selectionFailure.error));
      }
      if (reportedFailure) {
        throw reportedFailure.error instanceof Error
          ? reportedFailure.error
          : new Error(String(reportedFailure.error));
      }
      if (selected.length !== normalized.selectedRuns.length) {
        throw new Error(
          "Every selected CI run must be a completed successful main push.",
        );
      }
      if (runs.length !== selected.length) {
        throw new Error("Not every selected CI run has cached job timings.");
      }
    }
    const available = runs.length
      ? { runs }
      : cached.runs.length
      ? cached
      : null;
    if (!available) {
      if (reportedFailure) {
        throw reportedFailure.error instanceof Error
          ? reportedFailure.error
          : new Error(String(reportedFailure.error));
      }
      throw new Error(
        "No completed CI runs with cached job timings were available.",
      );
    }
    if (progress && reportedFailure) {
      const message = reportedFailure.error instanceof Error
        ? reportedFailure.error.message
        : String(reportedFailure.error);
      this.#updateProgress(progress, {
        warning: `${failures.length} run check${
          failures.length === 1 ? "" : "s"
        } reported ${
          friendlyError(message)
        }; the chart uses available cached responses.`,
      });
    }
    return available;
  }

  startGantt(
    token: string | undefined,
    source: CiHistorySource,
    options: CiGanttOptions,
    now = Date.now(),
  ): CiGanttRefresh {
    const normalized = normalizedGanttOptions(options);
    const key = `gantt:${source.key}:${normalized.limit}:${
      normalized.mainOnly ? "main" : "all"
    }:${
      normalized.allConclusions ? "all-conclusions" : "successful"
    }:${normalized.headSha}:${
      normalized.selectedRuns.map(({ runId, runAttempt }) =>
        `${runId}:${runAttempt}`
      ).join(",")
    }`;
    const active = this.#ganttRequests.get(key);
    if (active) {
      return {
        progress: { ...active.progress.state },
        result: active.result,
      };
    }

    const progress = this.#newProgress(
      source,
      CI_HISTORY_DAYS,
      undefined,
      key,
    );
    const request: CiGanttRequest = {
      progress,
      result: Promise.resolve({ runs: [] }),
    };
    request.result = Promise.resolve()
      .then(() =>
        this.#collectGantt(
          token,
          source,
          normalized,
          now,
          undefined,
          progress,
        )
      )
      .then((result) => {
        this.#updateProgress(progress, { phase: "complete" });
        return result;
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.#updateProgress(progress, {
          phase: "error",
          error: friendlyError(message),
        });
        throw error;
      })
      .finally(() => {
        if (this.#ganttRequests.get(key) === request) {
          this.#ganttRequests.delete(key);
        }
      });
    this.#ganttRequests.set(key, request);
    return { progress: { ...progress.state }, result: request.result };
  }

  startRefresh(
    token: string,
    source = CI_HISTORY_SOURCES.labs,
    days = CI_HISTORY_DAYS,
    baseline?: CiJobHistorySnapshot | null,
  ): CiJobRefresh {
    const key = snapshotKey(source, days);
    const latest = this.snapshot(source, days);
    const persistedRefresh = this.#store.freshRefresh(
      source.repo,
      source.workflow,
      days,
    );
    const refreshed = this.#refreshedAt.get(key) ??
      (persistedRefresh
        ? {
          at: persistedRefresh.refreshedAt,
          revision: this.#store.revisionFor(
            source.repo,
            source.workflow,
          ),
        }
        : undefined);
    const sourceRefreshActive = [...this.#refreshRequests.keys()].some(
      (refreshKey) => refreshKey.startsWith(`${source.key}:`),
    );
    if (
      latest && refreshed && !sourceRefreshActive &&
      refreshed.revision === this.#store.revisionFor(
          source.repo,
          source.workflow,
        ) &&
      Date.now() - refreshed.at >= 0 &&
      Date.now() - refreshed.at < REFRESH_MS
    ) {
      return {
        progress: null,
        result: Promise.resolve(inRequestedWindow(latest, Date.now(), days)),
      };
    }
    let request = this.#refreshRequests.get(key);
    if (request) {
      const progress = this.#progressByKey.get(key);
      if (progress && baseline !== undefined) {
        progress.baselines.add(snapshotFingerprint(baseline));
      }
      return {
        progress: progress ? { ...progress.state } : null,
        result: request,
      };
    }
    const now = Date.now();
    const progress = this.#newProgress(source, days, baseline);
    request = this.#runsForRefresh(token, source, now, progress)
      .then((runs) => this.collect(token, now, source, days, runs, progress))
      .then(async (collectedValue) => {
        let value = collectedValue;
        this.#refreshFailureAt.delete(source.key);
        const refreshedAt = Date.now();
        const previousRefresh = this.#store.refresh(
          source.repo,
          source.workflow,
          days,
        );
        const expectedRefresh = {
          repo: source.repo,
          workflow: source.workflow,
          days,
          refreshedAt,
          successfulRunTimes: [...(value.successfulRunTimes ?? [])].filter(
            Number.isFinite,
          ).sort((a, b) => a - b),
          sampledRuns: (this.#sampledRuns.get(key) ?? []).map((run) => ({
            ...run,
          })),
          failedRunCount: value.failedRunCount,
          failedRunTimes: [...value.failedRunTimes].filter(Number.isFinite)
            .sort((a, b) => a - b),
          stale: value.stale,
        };
        this.#store.markRefreshed(
          source.repo,
          source.workflow,
          days,
          refreshedAt,
          value.successfulRunTimes ?? [],
          this.#sampledRuns.get(key) ?? [],
          value.failedRunCount,
          value.failedRunTimes,
          value.stale,
        );
        try {
          await this.#saveCache(now);
        } catch (error) {
          this.#store.restoreRefresh(
            source.repo,
            source.workflow,
            days,
            previousRefresh,
          );
          throw error;
        }
        const persistedRefresh = this.#store.refresh(
          source.repo,
          source.workflow,
          days,
        );
        if (!persistedRefresh) {
          throw new Error("CI job history refresh manifest was not persisted.");
        }
        if (
          JSON.stringify(persistedRefresh) !== JSON.stringify(expectedRefresh)
        ) {
          this.#snapshotRevisions.delete(key);
          value = await this.cached(source, days, Date.now()) ?? value;
        }
        const persistedFreshRefresh = this.#store.freshRefresh(
          source.repo,
          source.workflow,
          days,
        );
        if (persistedFreshRefresh) {
          this.#refreshedAt.set(key, {
            at: persistedFreshRefresh.refreshedAt,
            revision: this.#store.revisionFor(source.repo, source.workflow),
          });
        } else this.#refreshedAt.delete(key);
        const fingerprint = snapshotFingerprint(value);
        this.#updateProgress(progress, {
          phase: "complete",
          needsReload: [...progress.baselines].some((value) =>
            value !== fingerprint
          ),
        });
        return value;
      })
      .catch(async (error) => {
        let reportedError = error;
        if (error instanceof GitHubRateLimitBudgetError) {
          this.#store.invalidateRefresh(
            source.repo,
            source.workflow,
            days,
          );
          this.#refreshedAt.delete(key);
          try {
            await this.#saveCache(Date.now());
          } catch (persistenceError) {
            reportedError = persistenceError;
          }
        }
        this.#refreshFailureAt.set(source.key, Date.now());
        const message = reportedError instanceof Error
          ? reportedError.message
          : String(reportedError);
        console.error(
          `CI job history refresh failed for ${source.repo}:`,
          message,
        );
        this.#updateProgress(progress, {
          phase: "error",
          error: friendlyError(message),
        });
        throw reportedError;
      })
      .finally(() => this.#refreshRequests.delete(key));
    this.#refreshRequests.set(key, request);
    return { progress: { ...progress.state }, result: request };
  }

  startRefreshForCheck(
    token: string,
    source = CI_HISTORY_SOURCES.labs,
    days = CI_HISTORY_DAYS,
    baseline?: CiJobHistorySnapshot | null,
  ): CiJobRefresh | null {
    const failedAt = this.#refreshFailureAt.get(source.key);
    if (failedAt && Date.now() - failedAt < REFRESH_MS) return null;
    return this.startRefresh(token, source, days, baseline);
  }

  async refresh(
    token: string,
    source = CI_HISTORY_SOURCES.labs,
    days = CI_HISTORY_DAYS,
  ): Promise<CiJobHistorySnapshot> {
    return await this.startRefresh(token, source, days).result;
  }
}

const productionStore = new CiJobHistoryStore();
const productionCollector = new CiJobHistoryCollector(
  productionStore,
  performanceGithub,
);
const commitGanttCollector = new CiJobHistoryCollector(
  productionStore,
  github,
);

export function collectCiGanttInput(
  source: CiHistorySource,
  options: CiGanttOptions,
  token = Deno.env.get("GH_TOKEN") ?? Deno.env.get("GITHUB_TOKEN"),
): Promise<CiGanttInput> {
  return productionCollector.startGantt(token, source, options).result;
}

export function collectCommitCiGanttInput(
  source: CiHistorySource,
  options: CiGanttOptions,
  token = Deno.env.get("GH_TOKEN") ?? Deno.env.get("GITHUB_TOKEN"),
): Promise<CiGanttInput> {
  return commitGanttCollector.startGantt(token, source, options).result;
}

function formatDuration(seconds: number): string {
  const rounded = Math.round(seconds);
  if (rounded < 60) return `${rounded}s`;
  const minutes = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  if (minutes < 60) {
    return `${minutes}m ${String(remainder).padStart(2, "0")}s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function shortShardName(series: CiJobSeries): string {
  const prefix = `${series.base} (`;
  return series.name.startsWith(prefix) && series.name.endsWith(")")
    ? series.name.slice(prefix.length, -1)
    : series.name;
}

interface RenderedSeries {
  series: CiJobSeries;
  pct: number;
  status: ReturnType<typeof trendStatus>;
  spark: string;
  span: string;
  latest: CiJobPoint;
  trend: string;
}

function renderSeries(
  series: CiJobSeries,
  axisStart: number,
  axisEnd: number,
): RenderedSeries {
  const times = series.points.map((point) => point.at);
  const values = series.points.map((point) => point.seconds);
  const pct = trendPct(times, values);
  const trendDays = distinctTrendDays(times, values);
  const status = trendDays >= 7 ? trendStatus(pct) : "unknown";
  const axisSpan = axisEnd - axisStart || 1;
  const xs = times.map((at) => (at - axisStart) / axisSpan);
  const spark = sparkline(
    values,
    "#727882",
    undefined,
    SPARK_FADE[status],
    xs,
  );
  const pointSpan = times.length > 1 ? times[times.length - 1] - times[0] : 0;
  return {
    series,
    pct,
    status,
    spark,
    span: pointSpan > 0 ? durationTag(pointSpan) : "",
    latest: series.points[series.points.length - 1],
    trend: trendDays >= 7 ? trendPctLabel(pct) : "new",
  };
}

function rowHtml(
  row: RenderedSeries,
  label: string,
  detail: string,
): string {
  const latest = row.latest;
  const summary = `${label}: ${formatDuration(latest.seconds)} in its latest ` +
    `available sample on ${dateLabel(latest.at)}, ${row.trend} over ` +
    `${row.series.points.length} sampled runs.`;
  return `<div class="crow ${row.status}${
    row.series.kind === "group"
      ? " aggregate"
      : row.series.kind === "overall"
      ? " overall"
      : ""
  }" data-kind="${row.series.kind}">` +
    `<div class="cspark">${row.spark}${row.span}</div>` +
    `<div class="cmeta"><span class="cname">${escapeHtml(label)}</span>` +
    `<span class="cdetail">${escapeHtml(detail)} · last seen ${
      escapeHtml(dateLabel(latest.at))
    }</span></div>` +
    `<a class="cval" href="${escapeHtml(latest.runUrl)}" target="_blank" ` +
    `rel="noopener">${formatDuration(latest.seconds)}` +
    `<span class="ctrend">${
      escapeHtml(row.trend)
    } · ${row.series.points.length} runs</span></a>` +
    `<span class="sr-only">${escapeHtml(summary)}</span></div>`;
}

const dateLabel = (at: number): string =>
  new Date(at).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });

interface CiHistoryPageOptions {
  source?: CiHistorySource;
  days?: number;
  runtimeStat?: string;
  progress?: CiJobFetchProgress;
  fragment?: boolean;
}

export const CI_FETCH_PROGRESS_STYLES = `
  .fetch-progress{background:#16181d;border:1px solid #2f333c;border-radius:10px;padding:10px 12px;margin:0 0 12px}
  .fetch-progress.error,.fetch-progress.warning{border-color:rgba(224,168,82,.42)}
  .fetch-head{display:flex;justify-content:space-between;gap:12px;align-items:baseline;font-size:12px;color:#c7ccd4}
  .fetch-head strong{font-weight:600}.fetch-head span,#fetch-detail{font-variant-numeric:tabular-nums;color:#878d97}
  .fetch-progress progress{display:block;width:100%;height:7px;margin:7px 0 6px;accent-color:#6ea8fe}
  #fetch-detail{font-size:11px;margin:0}`;

interface CiFetchProgressPanelOptions {
  ariaLabel?: string;
  checkUrl?: string;
  snapshotVersion?: string;
  refreshOnComplete?: boolean;
  progressUrl?: string;
}

export function ciFetchProgressPanel(
  progress?: CiJobFetchProgress | null,
  options: CiFetchProgressPanelOptions = {},
): string {
  const progressIdle = !progress || progress.phase === "complete" ||
    progress.phase === "error";
  const progressTitle = progressIdle
    ? "Idle"
    : progress.phase === "discovering"
    ? "Finding workflow runs…"
    : `${progress.completedRuns} of ${progress.totalRuns} run checks complete`;
  const progressTotal = progressIdle
    ? "0 outstanding"
    : progress.phase === "discovering"
    ? `${progress.discoveryOutstandingRequests} outstanding`
    : `${progress.completedRuns} / ${progress.totalRuns || "?"}`;
  const progressDetail = progress?.phase === "error"
    ? `Last collection stopped: ${
      escapeHtml(progress.error ?? "unknown error")
    }`
    : progressIdle && progress?.warning
    ? escapeHtml(progress.warning)
    : !progressIdle && progress?.phase === "discovering"
    ? `${progress.discoveryRequestsMade} workflow requests made · ${progress.discoveryResponsesReceived} responded · ${progress.discoveryOutstandingRequests} outstanding`
    : !progressIdle && progress
    ? `${progress.cachedRuns} cached · ${progress.requestsMade} run requests made · ${progress.sharedRequests} shared · ${
      progress.responsesReceived + progress.sharedResponses
    } responded · ${progress.outstandingRequests} outstanding · ${progress.queuedRuns} queued`
    : "No requests in progress.";
  const attributes = [
    options.checkUrl ? `data-check-url="${escapeHtml(options.checkUrl)}"` : "",
    options.snapshotVersion !== undefined
      ? `data-snapshot-version="${escapeHtml(options.snapshotVersion)}"`
      : "",
    options.refreshOnComplete !== undefined
      ? `data-refresh-on-complete="${options.refreshOnComplete ? "1" : "0"}"`
      : "",
    options.progressUrl
      ? `data-progress-url="${escapeHtml(options.progressUrl)}"`
      : "",
  ].filter(Boolean).join(" ");
  return `<section class="fetch-progress${
    progressIdle && progress?.warning ? " warning" : ""
  }" id="fetch-progress" aria-live="polite"${
    attributes ? ` ${attributes}` : ""
  }><div class="fetch-head"><strong id="fetch-title">${progressTitle}</strong><span id="fetch-total">${progressTotal}</span></div><progress id="fetch-bar" max="${
    progressIdle ? 1 : Math.max(1, progress?.totalRuns ?? 1)
  }"${
    !progressIdle && progress && !progress.totalRuns
      ? ""
      : ` value="${progressIdle ? 0 : progress?.completedRuns ?? 0}"`
  } aria-label="${
    escapeHtml(options.ariaLabel ?? "CI history fetch progress")
  }"></progress><p id="fetch-detail">${progressDetail}</p></section>`;
}

function ciPageHref(
  source: CiHistorySource,
  days: number,
  sort: string,
  runtimeStat?: string,
): string {
  const params = new URLSearchParams({
    view: "ci",
    repo: source.key,
    days: String(days),
    sort,
  });
  if (runtimeStat) params.set("stat", runtimeStat);
  return `/bench?${escapeHtml(params.toString())}`;
}

export function ciJobHistoryPage(
  snapshot: CiJobHistorySnapshot | null,
  sortMode: string,
  refreshError?: string,
  options: CiHistoryPageOptions = {},
): string {
  const source = options.source ?? CI_HISTORY_SOURCES.labs;
  const days = options.days ?? CI_HISTORY_DAYS;
  const runtimeStat = options.runtimeStat;
  const progress = options.progress;
  const progressActive = progress && progress.phase !== "complete" &&
    progress.phase !== "error";
  const sort = sortMode === "trend" || sortMode === "duration"
    ? sortMode
    : "job";
  let body: string;
  const hasSeries = snapshot &&
    (snapshot.overall || snapshot.groups.length > 0 ||
      snapshot.jobs.length > 0);
  if (!snapshot || snapshot.runCount === 0 || !hasSeries) {
    if (progressActive) {
      body = "";
    } else {
      const message = refreshError ??
        (snapshot?.failedRunCount
          ? `CI job timings could not be read for ${snapshot.failedRunCount} sampled run${
            snapshot.failedRunCount === 1 ? "" : "s"
          }.`
          : "No completed CI job timings were found in the history window.");
      body = `<p class="empty">${escapeHtml(message)}</p>`;
    }
  } else {
    const rendered = new Map<CiJobSeries, RenderedSeries>();
    const get = (series: CiJobSeries) => {
      let row = rendered.get(series);
      if (!row) {
        row = renderSeries(series, snapshot.axisStart, snapshot.axisEnd);
        rendered.set(series, row);
      }
      return row;
    };
    const axis = `<div class="axisrow"><div class="timeaxis"><span>${
      dateLabel(snapshot.axisStart)
    }</span><span>${dateLabel(snapshot.axisEnd)}</span></div></div>`;
    if (sort === "trend" || sort === "duration") {
      const rows = [
        ...(snapshot.overall ? [get(snapshot.overall)] : []),
        ...snapshot.groups.flatMap((group) => [
          get(group.aggregate),
          ...group.shards.map(get),
        ]),
        ...snapshot.jobs.map(get),
      ].sort((a, b) => {
        const difference = sort === "duration"
          ? b.latest.seconds - a.latest.seconds
          : b.pct - a.pct;
        return difference || a.series.name.localeCompare(b.series.name);
      });
      body = `${axis}<div class="clist">${
        rows.map((row) => {
          const group = snapshot.groups.find((item) =>
            item.base === row.series.base
          );
          const label = row.series.kind === "overall"
            ? "Overall CI"
            : row.series.kind === "group"
            ? `${row.series.base} — slowest of up to ${
              group?.maxConcurrent ?? 0
            } shards`
            : row.series.name;
          return rowHtml(
            row,
            label,
            row.series.kind === "overall"
              ? "First job start to last job completion"
              : row.series.kind === "group"
              ? "Slowest shard duration"
              : "Individual job",
          );
        }).join("")
      }</div>`;
    } else {
      const overall = snapshot.overall
        ? `<section class="overall-section"><h2>Workflow <span>end-to-end wall time</span></h2><div class="clist">${
          rowHtml(
            get(snapshot.overall),
            "Overall CI",
            "First job start to last job completion",
          )
        }</div></section>`
        : "";
      const sections = snapshot.groups.map((group) =>
        `<section><h2>${
          escapeHtml(group.base)
        } <span>up to ${group.maxConcurrent} concurrent${
          group.shards.length === group.maxConcurrent
            ? ""
            : ` · ${group.shards.length} historical variants`
        }</span></h2>` +
        `<div class="clist">${
          rowHtml(
            get(group.aggregate),
            "longest-running shard",
            "Slowest shard duration",
          )
        }${
          group.shards.map((series) =>
            rowHtml(get(series), shortShardName(series), "Individual shard")
          ).join("")
        }</div></section>`
      ).join("");
      const jobs = snapshot.jobs.length
        ? `<section><h2>Unsharded jobs <span>${snapshot.jobs.length} jobs</span></h2>` +
          `<div class="clist">${
            snapshot.jobs.map((series) =>
              rowHtml(get(series), series.name, "Individual job")
            ).join("")
          }</div></section>`
        : "";
      body = `${axis}${overall}${sections}${jobs}`;
    }
  }

  const notices: string[] = [];
  if (refreshError && snapshot?.runCount) {
    notices.push(`Showing the last collected data. ${refreshError}`);
  }
  if (snapshot?.failedRunCount && snapshot.runCount) {
    notices.push(
      `${
        snapshot.stale
          ? "Showing the last collected data"
          : "Showing partial data"
      }. ` +
        `${snapshot.failedRunCount} sampled run${
          snapshot.failedRunCount === 1 ? "" : "s"
        } could not be read.`,
    );
  }
  const refreshNotice = notices.map((notice) =>
    `<p class="refresh-error">${escapeHtml(notice)}</p>`
  ).join("");
  const bucketHours = ciHistoryBucketMs(days) / 3_600_000;
  const bucketLabel = bucketHours >= 10
    ? String(Math.round(bucketHours))
    : bucketHours.toFixed(1).replace(/\.0$/, "");
  const viewNav = performanceViewNav("ci", {
    repo: source.key,
    days,
    sort,
    stat: runtimeStat ?? "p99",
  });
  const workflowUrl =
    `https://github.com/${source.repo}/actions/workflows/${source.workflow}?query=branch%3Amain`;
  const version = ciJobHistorySnapshotVersion(snapshot);
  const checkParams = new URLSearchParams({
    view: "ci",
    repo: source.key,
    days: String(days),
  });
  const checkUrl = `/bench/check?${checkParams.toString()}`;
  const progressUrl = progress
    ? `/bench/ci-progress?id=${encodeURIComponent(progress.id)}`
    : "";
  const progressHtml = ciFetchProgressPanel(progress, {
    checkUrl,
    snapshotVersion: version,
    refreshOnComplete: Boolean(
      progressActive && (!snapshot || snapshot.runCount === 0 || !hasSeries),
    ),
    progressUrl,
  });
  const coverageHtml = snapshot
    ? `<p class="coverage">Coverage: ${snapshot.runCount} sampled build${
      snapshot.runCount === 1 ? "" : "s"
    } shown${
      snapshot.successfulRunTimes === null
        ? ""
        : ` out of ${snapshot.successfulRunTimes.length} successful main build${
          snapshot.successfulRunTimes.length === 1 ? "" : "s"
        }`
    }.</p>`
    : "";
  const rangeContent = `<div id="range-content">
    ${progressHtml}${coverageHtml}
    <p class="legend">Job start-to-finish duration. Overall CI runs from the first job start to the last job completion. A shard group's line is the longest-running shard in each run. Lower is faster; colour follows the selected ${days}-day trend. Duration sort uses the latest sample.</p>
    ${refreshNotice}${body}
    <p class="note">Every successful main run is sampled when the selected window contains at most ${CI_HISTORY_POINT_TARGET}. Larger sets keep the newest run per ${bucketLabel}-hour bucket from <a href="${
    escapeHtml(workflowUrl)
  }" target="_blank" rel="noopener">${
    escapeHtml(source.workflow)
  } runs ↗</a>. The window adjusts its sampling interval to keep about ${CI_HISTORY_POINT_TARGET} points. Values come from GitHub's job start and completion times. The detailed Gantt uses the same cached runs.</p>
  </div>`;
  if (options.fragment) return rangeContent;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>CI job history</title>
<style>
  body{box-sizing:border-box;width:100%;margin:0;background:#0d0e11;color:#e7e9ee;font-family:-apple-system,Segoe UI,Roboto,sans-serif;padding:18px 20px 26px;max-width:1100px;margin:0 auto}
  .top{display:flex;align-items:baseline;gap:10px;margin-bottom:12px;flex-wrap:wrap}
  .top b{font-size:16px;font-weight:600}.top span{font-size:12px;color:#6f757f}
  a.back,.note a{color:#6ea8fe;text-decoration:none;font-size:13px}
  .views{display:flex;gap:6px;margin:0 0 14px}
  .views a,.controls a{font-size:13px;color:#c7ccd4;text-decoration:none;border:1px solid #2f333c;border-radius:6px;padding:4px 10px}
  .views a.on,.controls a.on{background:#6ea8fe;border-color:#6ea8fe;color:#0d0e11}
  .controls{display:flex;flex-wrap:wrap;align-items:center;gap:6px;background:#16181d;border:1px solid #23262d;border-radius:12px;padding:12px 14px;margin-bottom:8px}
  .controls .lbl{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#878d97;margin-right:6px}
  .controls .field{display:flex;align-items:center;gap:7px;font-size:12px;color:#9aa0ab;margin-right:8px}
  .controls .choice-group{display:flex;align-items:center;gap:6px}
  .controls select{background:#0d0e11;color:#c7ccd4;border:1px solid #2f333c;border-radius:6px;padding:4px 7px}
  .controls input[type=range]{width:150px}.controls output{color:#c7ccd4;min-width:46px;font-variant-numeric:tabular-nums}
  .legend{font-size:11px;color:#777d87;margin:0 0 12px}.coverage{font-size:11px;color:#c7ccd4;font-variant-numeric:tabular-nums;margin:0 0 12px}
  ${CI_FETCH_PROGRESS_STYLES}
  .axisrow{display:flex;gap:18px;margin:0 14px 4px}.timeaxis{flex:0 0 42%;display:flex;justify-content:space-between;color:#666c76;font-size:10px}
  h2{font-size:12px;letter-spacing:.04em;color:#878d97;font-weight:600;margin:20px 0 8px;font-family:ui-monospace,Menlo,monospace}
  h2 span{font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-weight:400;color:#666c76;margin-left:6px}
  .clist{display:flex;flex-direction:column;gap:7px}
  .crow{display:flex;align-items:center;gap:18px;background:#16181d;border:1px solid #23262d;border-radius:10px;padding:8px 14px}
  .crow.good{border-color:rgba(67,197,116,.34);background:rgba(67,197,116,.06)}
  .crow.warn{border-color:rgba(224,168,82,.42);background:rgba(224,168,82,.07)}
  .crow.bad{border-color:rgba(226,80,74,.5);background:rgba(226,80,74,.09)}
  .crow.aggregate{border-left-width:4px}
  .crow.overall{border-left:4px solid #6ea8fe}.overall-section{margin-bottom:20px}
  .cspark{flex:0 0 42%;min-width:0;position:relative}.cspark>div,.cspark>svg{margin-top:0!important}
  .cmeta{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px}
  .cname{font-size:13px;color:#c7ccd4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .cdetail{font-size:11px;color:#777d87}
  .cval{flex:none;display:flex;flex-direction:column;align-items:flex-end;color:#e7e9ee;text-decoration:none;font-size:18px;font-weight:600;font-variant-numeric:tabular-nums}
  .ctrend{font-size:11px;font-weight:400;color:#9aa0ab}
  .empty,.refresh-error{color:#9aa0ab;font-size:14px}.refresh-error{color:#e0a852}
  .note{font-size:11px;color:#666c76;margin-top:22px}.note a{font-size:11px}
  label.chk{font-size:13px;color:#c7ccd4;display:inline-flex;align-items:center;gap:6px;margin-left:auto;cursor:pointer;user-select:none}
  body.hide-green .crow.good{display:none}body.hide-green section:has(.clist):not(:has(.crow:not(.good))){display:none}
  .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
  @media(max-width:640px){.timeaxis{flex:1}.crow{align-items:stretch;gap:7px;flex-wrap:wrap}.cspark{flex:1 0 100%}.cmeta{flex:1 1 55%}.cval{font-size:16px}.controls label.chk{margin-left:0}.controls .field{flex:1 1 100%}.controls input[type=range]{flex:1;width:auto}}
</style></head><body>
  <div class="top"><a class="back" href="/">← dashboard</a><b>Performance history</b><span>${
    escapeHtml(source.repo)
  } · ${escapeHtml(source.workflow)}</span></div>
  ${viewNav}
  <form class="controls" method="get" action="/bench"><input type="hidden" name="view" value="ci"><input type="hidden" name="sort" value="${sort}">${
    runtimeStat
      ? `<input type="hidden" name="stat" value="${escapeHtml(runtimeStat)}">`
      : ""
  }<label class="field">repository <select id="repo" name="repo"><option value="labs"${
    source.key === "labs" ? " selected" : ""
  }>labs</option><option value="loom"${
    source.key === "loom" ? " selected" : ""
  }>loom</option></select></label><label class="field" for="days">window <output id="daysv" for="days">${days} day${
    days === 1 ? "" : "s"
  }</output><input type="range" id="days" name="days" min="${CI_HISTORY_MIN_DAYS}" max="${CI_HISTORY_DAYS}" step="1" value="${days}"></label><nav class="choice-group" aria-label="Sort CI history"><span class="lbl">sort</span><a class="${
    sort === "job" ? "on" : ""
  }" href="${ciPageHref(source, days, "job", runtimeStat)}"${
    sort === "job" ? ' aria-current="true"' : ""
  }>job</a><a class="${sort === "duration" ? "on" : ""}" href="${
    ciPageHref(source, days, "duration", runtimeStat)
  }"${
    sort === "duration" ? ' aria-current="true"' : ""
  }>duration</a><a class="${sort === "trend" ? "on" : ""}" href="${
    ciPageHref(source, days, "trend", runtimeStat)
  }"${
    sort === "trend" ? ' aria-current="true"' : ""
  }>trend</a></nav><label class="chk"><input type="checkbox" id="hg"> hide green</label></form>
  ${rangeContent}
<script>
  const hg = document.getElementById("hg"), days = document.getElementById("days"), daysv = document.getElementById("daysv"), repo = document.getElementById("repo"), controls = days.form, KEY = "ciJobsHideGreen", DEFAULT_DAYS = days.value;
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
  repo.addEventListener("change", () => repo.form.requestSubmit());

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
      title.textContent = "Finding workflow runs…";
      total.textContent = state.discoveryOutstandingRequests + " outstanding";
      bar.removeAttribute("value");
      detail.textContent = state.discoveryRequestsMade + " workflow requests made · " +
        state.discoveryResponsesReceived + " responded · " +
        state.discoveryOutstandingRequests + " outstanding";
    } else {
      title.textContent = state.phase === "saving"
        ? "Saving completed responses…"
        : state.completedRuns + " of " + state.totalRuns + " run checks complete";
      total.textContent = state.completedRuns + " / " + state.totalRuns;
      bar.max = Math.max(1, state.totalRuns);
      bar.value = state.completedRuns;
      detail.textContent = state.cachedRuns + " cached · " +
        state.requestsMade + " run requests made · " +
        state.sharedRequests + " shared · " +
        (state.responsesReceived + state.sharedResponses) + " responded · " +
        state.outstandingRequests + " outstanding · " +
        state.queuedRuns + " queued" +
        (state.failedResponses ? " · " + state.failedResponses + " failed" : "");
    }
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
        connectProgress("/bench/ci-progress?id=" + encodeURIComponent(state.progress.id));
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
    detail.textContent = "Reading cached history and checking for new CI data.";
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
</script></body></html>`;
}

export function ciJobHistoryProgressResponse(
  url: URL,
  collector = productionCollector,
): Response {
  const id = url.searchParams.get("id");
  if (!id) return new Response("missing progress id", { status: 400 });
  if (!collector.progress(id)) {
    return new Response("unknown progress id", { status: 404 });
  }
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | undefined;
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (progress: CiJobFetchProgress) => {
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
      unsubscribe = collector.subscribeProgress(id, send) ??
        undefined;
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

function ganttProgressResponse(
  _request: Request,
  url: URL,
  collector: CiJobHistoryCollector,
  token: string | undefined,
): Response {
  const refresh = collector.startGantt(
    token,
    ciHistorySource(url.searchParams.get("repo")),
    ciGanttOptions(url.searchParams),
  );
  void refresh.result.catch(() => {});
  const progressUrl = new URL("http://dashboard/bench/ci-progress");
  progressUrl.searchParams.set("id", refresh.progress.id);
  return ciJobHistoryProgressResponse(progressUrl, collector);
}

export function ciGanttProgressResponse(
  request: Request,
  url: URL,
  collector = productionCollector,
  token = Deno.env.get("GH_TOKEN") ?? Deno.env.get("GITHUB_TOKEN"),
): Response {
  return ganttProgressResponse(request, url, collector, token);
}

export function ciCommitGanttProgressResponse(
  request: Request,
  url: URL,
  collector = commitGanttCollector,
  token = Deno.env.get("GH_TOKEN") ?? Deno.env.get("GITHUB_TOKEN"),
): Response {
  return ganttProgressResponse(request, url, collector, token);
}

type CiJobHistoryProvider =
  & Pick<
    CiJobHistoryCollector,
    "cached" | "startRefresh"
  >
  & Partial<Pick<CiJobHistoryCollector, "startRefreshForCheck">>;

export async function ciJobHistoryCheckResponse(
  url: URL,
  collector: CiJobHistoryProvider = productionCollector,
  token = Deno.env.get("GH_TOKEN") ?? Deno.env.get("GITHUB_TOKEN"),
): Promise<Response> {
  const source = ciHistorySource(url.searchParams.get("repo"));
  const days = ciHistoryDays(url.searchParams.get("days"));
  let snapshot = await collector.cached(source, days);
  let progress: CiJobFetchProgress | null = null;
  if (token) {
    const refresh = collector.startRefreshForCheck
      ? collector.startRefreshForCheck(token, source, days, snapshot)
      : collector.startRefresh(token, source, days, snapshot);
    if (refresh) {
      progress = refresh.progress;
      if (progress) void refresh.result.catch(() => {});
      else snapshot = await refresh.result;
    }
  }
  return Response.json(
    { version: ciJobHistorySnapshotVersion(snapshot), progress },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function ciJobHistoryResponse(
  url: URL,
  collector: CiJobHistoryProvider = productionCollector,
  token = Deno.env.get("GH_TOKEN") ?? Deno.env.get("GITHUB_TOKEN"),
): Promise<Response> {
  const source = ciHistorySource(url.searchParams.get("repo"));
  const days = ciHistoryDays(url.searchParams.get("days"));
  let snapshot = await collector.cached(source, days);
  let refreshError: string | undefined;
  let progress: CiJobFetchProgress | undefined;
  if (!token) {
    refreshError = snapshot?.runCount
      ? "Set GH_TOKEN to refresh CI job history."
      : "Set GH_TOKEN to collect CI job history.";
  } else {
    const refresh = collector.startRefresh(token, source, days, snapshot);
    progress = refresh.progress ?? undefined;
    if (progress) void refresh.result.catch(() => {});
    else snapshot = await refresh.result;
  }
  return new Response(
    ciJobHistoryPage(
      snapshot,
      url.searchParams.get("sort") ?? "job",
      refreshError,
      {
        source,
        days,
        runtimeStat: url.searchParams.get("stat") ?? undefined,
        progress,
        fragment: url.searchParams.get("fragment") === "range",
      },
    ),
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}
