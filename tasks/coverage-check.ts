#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read --allow-run --allow-write

/**
 * PR Coverage Check
 *
 * Runs as a PR CI job after all test jobs complete. Joins the coverage
 * profiles every test job uploaded and gates the PR on coverage debt: for each
 * source group the PR changed, the count of uncovered lines must not rise above
 * the count from the `main` run for the base-branch commit this run merged,
 * unless the PR description accepts the increase. Fails (exit 1) when a changed
 * group regresses.
 *
 * Environment:
 *   GITHUB_TOKEN        - Required.
 *   GITHUB_REPOSITORY   - Optional, defaults to "commontoolsinc/labs".
 *   GITHUB_RUN_ID       - Required. Current workflow run ID.
 *   PR_NUMBER           - Required. Pull request number.
 *   COVERAGE_ARTIFACTS_DIR - Optional. Directory containing downloaded
 *                            coverage artifacts, one subdirectory per name.
 */

import {
  addSample,
  aggregateCacheStates,
  API_CONCURRENCY,
  applyBaselineOverrides,
  type Artifact,
  type BaselineOverrides,
  buildCoverageDebtSuggestionComment,
  CACHE_STATE_ARTIFACT_PREFIX,
  COMPILE_CACHE_FAMILIES,
  type CompileCacheStates,
  COVERAGE_BASELINE_RESET_MARKER,
  COVERAGE_COMMENT_FILE,
  type CoverageBaselineDetailed,
  type CoverageCommentPayload,
  coverageGroupForChangedFile,
  coverageGroupsForChangedFiles,
  coverageMetricGroupName,
  type CoverageResolvedGroup,
  type CoverageSuggestionFileLines,
  type CoverageSuggestionGroup,
  downloadAndExtractArtifact,
  downloadAndParseCoverageBaseline,
  fetchArtifactsForRun,
  fetchCurrentPRBody,
  fetchPRFiles,
  formatOverrideSuggestion,
  githubGet,
  isCoverageDebtMetric,
  latestNonColdSample,
  mapConcurrent,
  type MetricTimeline,
  newestArtifactsByName,
  parseAddedLinesFromPatch,
  parseBaselineOverrides,
  parseCacheStateFiles,
  PERF_METRICS_ARTIFACT_NAME,
  PERF_METRICS_FILE,
  type PRFile,
  type PRInfo,
  readAndParseEvent,
  REPO,
  shouldGateCoverageDebtMetric,
  type TimingSample,
  walkFiles,
  WORKFLOW_FILE,
  type WorkflowRun,
  writeCoverageBaselineFile,
} from "./ci-check-lib.ts";
import {
  fillMissingFamiliesFromFingerprint,
  inferCurrentRunFallbackState,
  recordUnstampedBaselineRunState,
} from "./compile-cache-state.ts";
import * as path from "@std/path";
import {
  collectCoverageDebtMetricsFromLcov,
  collectUncoveredLinesForFiles,
  COVERAGE_PROFILE_ARTIFACT_PREFIX,
  lcovFromCoverageProfile,
} from "./coverage-metrics.ts";

/** How many recent main-branch runs to scan for the coverage baseline. */
const BASELINE_RUNS = 20;

export function currentWorkflowRunFromEvent(
  event: object | undefined,
  runId: number,
): WorkflowRun {
  const payload = event as {
    after?: unknown;
    pull_request?: {
      head?: { sha?: unknown };
    };
  } | undefined;

  const headSha = typeof payload?.pull_request?.head?.sha === "string"
    ? payload.pull_request.head.sha
    : typeof payload?.after === "string"
    ? payload.after
    : Deno.env.get("GITHUB_SHA") ?? "";

  return {
    id: runId,
    html_url: `https://github.com/${REPO}/actions/runs/${runId}`,
    head_sha: headSha,
    created_at: new Date().toISOString(),
    conclusion: "",
    event: Deno.env.get("GITHUB_EVENT_NAME") ?? "",
  };
}

function isGitHubRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(rate limit|rate-limited|ratelimit)\b/i.test(message);
}

export async function githubApiOrSkip<T>(
  description: string,
  operation: () => Promise<T>,
  metricsForArtifact: Map<string, TimingSample>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!isGitHubRateLimitError(error)) throw error;

    console.warn(
      `  Warning: GitHub API rate limit while ${description}: ${error}`,
    );
    await writeCoverageBaselineFile(PERF_METRICS_FILE, metricsForArtifact);
    console.log(
      `Wrote ${PERF_METRICS_FILE} with ${metricsForArtifact.size} metrics.`,
    );
    console.log(
      "Skipping coverage check because GitHub API rate limits prevent collecting the baseline data.",
    );
    Deno.exit(0);
  }
}

export function parseMergedBaselineOverrides(
  pr: Pick<PRInfo, "number" | "body">,
  warn: (message: string) => void = console.warn,
): BaselineOverrides | null {
  try {
    // Merged baseline PRs predating the marker rename accepted coverage debt
    // with NEW_PERF_BASELINE; still honor that so their acceptance truncates
    // the baseline timeline (see parseBaselineOverrides).
    return parseBaselineOverrides(pr.body ?? "", true);
  } catch (error) {
    warn(
      `  Warning: ignoring invalid baseline override in merged PR #${pr.number}: ${error}`,
    );
    return null;
  }
}

export function workflowRunsPathForBaseline(
  perPage: number,
): string {
  const params = new URLSearchParams({
    branch: "main",
    status: "success",
    event: "push",
    per_page: String(perPage),
  });
  return `/repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/runs?${params}`;
}

export interface BaselineMainHeadValidation {
  ok: boolean;
  issues: string[];
}

export function validateBaselineRunsForMainHead(
  runs: Pick<WorkflowRun, "id" | "head_sha" | "created_at">[],
  mainHeadSha: string,
): BaselineMainHeadValidation {
  const issues: string[] = [];

  if (runs.length === 0) {
    issues.push("No successful main-branch runs were returned.");
    return { ok: false, issues };
  }

  if (!/^[0-9a-f]{40}$/i.test(mainHeadSha)) {
    issues.push(`Current main head SHA is invalid: ${mainHeadSha}`);
    return { ok: false, issues };
  }

  const newest = runs[0];
  if (newest.head_sha !== mainHeadSha) {
    issues.push(
      `Newest successful baseline run ${newest.id} (${newest.created_at}) is for ${newest.head_sha}, but current main is ${mainHeadSha}.`,
    );
  }

  return { ok: issues.length === 0, issues };
}

export async function fetchMainHeadSha(): Promise<string> {
  const branch = await githubGet<{ commit: { sha: string } }>(
    `/repos/${REPO}/branches/main`,
  );
  return branch.commit.sha;
}

/**
 * The head SHA of the latest prior baseline run — the run whose compile cache
 * the current main push would have restored. Used to fingerprint-classify a
 * main push that carries no recorded cache state. Undefined when there is no
 * prior baseline run (e.g. an empty run history).
 */
export async function fetchLatestBaselineRunSha(): Promise<string | undefined> {
  const recent = await githubGet<{ workflow_runs: WorkflowRun[] }>(
    workflowRunsPathForBaseline(1),
  );
  return recent.workflow_runs[0]?.head_sha;
}

function pluralize(value: number, unit: string): string {
  return `${value} ${unit}${value === 1 ? "" : "s"}`;
}

export function formatRelativeDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "unknown";

  let remaining = Math.max(0, Math.floor(seconds));
  const parts: string[] = [];
  const units = [
    { seconds: 24 * 60 * 60, unit: "day" },
    { seconds: 60 * 60, unit: "hour" },
    { seconds: 60, unit: "minute" },
    { seconds: 1, unit: "second" },
  ];

  for (const unit of units) {
    const value = Math.floor(remaining / unit.seconds);
    if (value > 0) {
      parts.push(pluralize(value, unit.unit));
      remaining -= value * unit.seconds;
    }
    if (parts.length === 2) break;
  }

  return parts.length > 0 ? parts.join(" ") : "0 seconds";
}

export function formatRelativeAge(fromIso: string, toIso: string): string {
  const fromMs = Date.parse(fromIso);
  const toMs = Date.parse(toIso);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return "unknown";

  return formatRelativeDuration((toMs - fromMs) / 1_000);
}

export function formatCommitDistance(commitsBehindMain: number | null): string {
  return commitsBehindMain === null
    ? "an unknown number of commits"
    : pluralize(commitsBehindMain, "commit");
}

export function formatBaselineSourceRunAge(
  runCreatedAt: string,
  currentCreatedAt: string,
  commitsBehindMain: number | null,
): string {
  const age = formatRelativeAge(runCreatedAt, currentCreatedAt);
  const timePart = age === "unknown" ? "age unknown" : `created ${age} ago`;
  return `${timePart}; ${
    formatCommitDistance(commitsBehindMain)
  } behind current main`;
}

interface GitHubCompareResponse {
  ahead_by?: unknown;
}

export async function readHeadCommitObject(
  cwd?: string,
): Promise<string | null> {
  try {
    const result = await new Deno.Command("git", {
      args: ["cat-file", "commit", "HEAD"],
      cwd,
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!result.success) {
      console.warn(
        `  Warning: could not read the \`HEAD\` commit object: ${
          new TextDecoder().decode(result.stderr).trim()
        }`,
      );
      return null;
    }
    return new TextDecoder().decode(result.stdout);
  } catch (error) {
    console.warn(
      `  Warning: could not run \`git\` to read the \`HEAD\` commit object: ${
        formatErrorForLog(error)
      }`,
    );
    return null;
  }
}

/**
 * Reads the base-branch commit the checked-out tree merges this pull request
 * into.
 *
 * A `pull_request` run checks out `refs/pull/<number>/merge`, a merge commit
 * whose first parent is the base-branch commit and whose second parent is the
 * pull request head. GitHub rebuilds that merge ref whenever the base branch
 * moves and does not rewrite the base recorded in the triggering event, so the
 * event can name an older commit than the one the checkout merged. The commit
 * object names the commit whose code the test jobs ran.
 *
 * The parents come from the raw commit object, because `actions/checkout`
 * clones to depth one and git treats a shallow boundary commit as having no
 * parents. `git cat-file` prints the stored object, which still lists them.
 *
 * Returns null when `HEAD` has fewer than two parents, and when `git` cannot
 * be run.
 */
export async function readBaseBranchSha(
  readCommitObject: () => Promise<string | null> = readHeadCommitObject,
): Promise<string | null> {
  const commit = await readCommitObject();
  if (commit === null) return null;

  const parents: string[] = [];
  for (const line of commit.split("\n")) {
    // The header ends at the first blank line; the commit message that follows
    // it can contain a line that reads like a parent.
    if (line === "") break;
    const match = /^parent ([0-9a-f]{40,64})$/.exec(line);
    if (match) parents.push(match[1]);
  }

  return parents.length >= 2 ? parents[0] : null;
}

/** How far back from the base-branch commit a baseline may sit. */
const BASELINE_ANCESTRY_DEPTH = 100;

/** The compare endpoint returns at most this many files. */
const COMPARE_FILE_LIMIT = 300;

/**
 * Reads how far back each recent commit sits from the base-branch commit this
 * run merged, newest first, so that `0` is that commit itself.
 *
 * Listing commits from the base-branch commit walks its ancestry, so a commit
 * absent from the result is not an ancestor. That is what keeps a `main` run
 * that landed after this run started from becoming the baseline: it measured
 * base-branch code this run does not contain.
 */
export async function fetchAncestorRanks(
  baseSha: string,
  depth = BASELINE_ANCESTRY_DEPTH,
): Promise<Map<string, number>> {
  const commits = await githubGet<{ sha: string }[]>(
    `/repos/${REPO}/commits?sha=${
      encodeURIComponent(baseSha)
    }&per_page=${depth}`,
  );
  return new Map(commits.map((commit, index) => [commit.sha, index]));
}

/**
 * Returns the ratchet baseline for one metric: the run for the nearest
 * ancestor of the base-branch commit this run merged.
 *
 * The base-branch commit's own run is the ideal baseline, because it measured
 * exactly the base-branch code this run merged, leaving the pull request as the
 * only difference between the two numbers. It is often available, but a run
 * still going or one that failed leaves the nearest ancestor with a usable run
 * standing in for it. Whatever the base branch changed in between is then in
 * this run and not in the baseline, so `isComparableBaseline()` withholds
 * gating from the groups it touched.
 *
 * Prefers a non-cold run: a cold run covers cold-compile-only branches, and its
 * lower debt would hold a warm pull request to an unreachable bar. Takes the
 * nearest ancestor regardless when every ancestor is cold, which keeps the
 * reset semantics of an override-truncated timeline.
 *
 * Falls back to the latest non-cold run when there is no ancestry to work from
 * — a `main` push run, a checkout that is not a merge, or a commit listing that
 * could not be fetched.
 */
export function nearestUsableBaseline(
  samples: TimingSample[],
  isRunCold: (runId: number) => boolean,
  ancestorRank: Map<string, number> | null,
): TimingSample | undefined {
  if (ancestorRank === null) return latestNonColdSample(samples, isRunCold);

  let nearest: TimingSample | undefined;
  let nearestRank = Infinity;
  let nearestCold: TimingSample | undefined;
  let nearestColdRank = Infinity;

  for (const sample of samples) {
    const rank = ancestorRank.get(sample.sha);
    if (rank === undefined) continue;

    if (isRunCold(sample.runId)) {
      if (rank < nearestColdRank) {
        nearestCold = sample;
        nearestColdRank = rank;
      }
      continue;
    }
    if (rank < nearestRank) {
      nearest = sample;
      nearestRank = rank;
    }
  }

  return nearest ?? nearestCold;
}

/**
 * Reads the coverage source groups the base branch changed between the baseline
 * run's commit and the base-branch commit this run merged.
 *
 * A group's uncovered-line count is a total over its files, so a group the base
 * branch touched in between has a baseline counting different code from this
 * run. Those groups are the ones the ratchet cannot speak to. Every other
 * group's total stays comparable, which is what lets a pull request still be
 * gated when the base-branch commit has no run of its own.
 */
export async function fetchGroupsChangedOnBase(
  baselineSha: string,
  baseSha: string,
  warn: (message: string) => void = console.warn,
): Promise<Set<string>> {
  if (baselineSha === baseSha) return new Set();

  const comparison = await githubGet<{ files?: { filename: string }[] }>(
    `/repos/${REPO}/compare/${encodeURIComponent(baselineSha)}...${
      encodeURIComponent(baseSha)
    }`,
  );
  const files = comparison.files ?? [];
  if (files.length >= COMPARE_FILE_LIMIT) {
    warn(
      `  Warning: comparing ${baselineSha.slice(0, 8)} against ${
        baseSha.slice(0, 8)
      } hit the ${COMPARE_FILE_LIMIT}-file response cap, so a group the base ` +
        "branch changed may still be gated.",
    );
  }
  return coverageGroupsForChangedFiles(files.map((file) => file.filename));
}

/**
 * Returns whether a metric's baseline can be held against this run.
 *
 * The two numbers must count the same base-branch code, or the difference
 * between them is not the pull request's. Three things break that, and each
 * leaves the metric reported and not gated:
 *
 * - No base-branch commit. Without one there is no ancestry to select against,
 *   so the baseline is whatever ran most recently and counts unrelated code.
 * - No baseline at all for the metric.
 * - A group the base branch changed between this metric's own baseline commit
 *   and the base-branch commit. The lookup is keyed by that commit, so a metric
 *   whose baseline is the base-branch commit itself stays gated even when
 *   another metric fell back to an older one.
 *
 * A `main` push run has no base-branch commit and is informational, so it
 * reports against whatever baseline it has.
 */
export function isComparableBaseline(
  options: {
    sample: TimingSample | undefined;
    metric: string;
    baseSha: string | null;
    groupsChangedByBaseline: Map<string, Set<string>>;
    isPullRequest: boolean;
  },
): boolean {
  if (!options.isPullRequest) return true;
  if (options.baseSha === null || options.sample === undefined) return false;

  const group = coverageMetricGroupName(options.metric);
  if (group === null) return true;

  const moved = options.groupsChangedByBaseline.get(options.sample.sha);
  return !moved?.has(group);
}

export interface MetricBaseline {
  sample?: TimingSample;
  /** Whether the ratchet may fail this metric against that sample. */
  comparable: boolean;
}

export interface ResolveMetricBaselinesOptions {
  metrics: Iterable<string>;
  timelines: Map<string, MetricTimeline>;
  isRunCold: (runId: number) => boolean;
  ancestorRank: Map<string, number> | null;
  groupsChangedByBaseline: Map<string, Set<string>>;
  baseSha: string | null;
  isPullRequest: boolean;
}

export interface SelectBaselinesOptions {
  metrics: Iterable<string>;
  timelines: Map<string, MetricTimeline>;
  isRunCold: (runId: number) => boolean;
  isPullRequest: boolean;
  readBaseSha?: () => Promise<string | null>;
  fetchRanks?: (baseSha: string) => Promise<Map<string, number>>;
  fetchChangedGroups?: (
    baselineSha: string,
    baseSha: string,
  ) => Promise<Set<string>>;
  /** Wraps each GitHub call so a rate limit skips the check (see main). */
  guard?: <T>(description: string, operation: () => Promise<T>) => Promise<T>;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

/**
 * Chooses every metric's ratchet baseline against the base-branch commit this
 * run merged, and reports what it chose.
 *
 * Reads the base-branch commit, ranks its ancestry, asks which coverage groups
 * the base branch moved since each baseline the metrics would take, and hands
 * the answers to `resolveMetricBaselines()`.
 */
export async function selectBaselines(
  options: SelectBaselinesOptions,
): Promise<Map<string, MetricBaseline>> {
  const log = options.log ?? console.log;
  const warn = options.warn ?? console.warn;
  const readBaseSha = options.readBaseSha ?? readBaseBranchSha;
  const fetchRanks = options.fetchRanks ?? fetchAncestorRanks;
  const fetchChangedGroups = options.fetchChangedGroups ??
    fetchGroupsChangedOnBase;
  const guard = options.guard ?? ((_description, operation) => operation());

  const baseSha = options.isPullRequest ? await readBaseSha() : null;
  if (options.isPullRequest && baseSha === null) {
    warn(
      "  Warning: could not read the base-branch commit this run merges " +
        "into; coverage debt metrics will be reported but not gated.",
    );
  } else if (baseSha !== null) {
    log(
      `This run merges the pull request into base-branch commit ${
        baseSha.slice(0, 8)
      }.`,
    );
  }

  const ancestorRank = baseSha === null ? null : await guard(
    "listing the base-branch commit's ancestry",
    () => fetchRanks(baseSha),
  );

  // Which baseline each metric would take, before asking what moved since.
  const candidateShas = new Set<string>();
  for (const metric of options.metrics) {
    const timeline = options.timelines.get(metric);
    const sample = timeline
      ? nearestUsableBaseline(timeline.samples, options.isRunCold, ancestorRank)
      : undefined;
    if (sample) candidateShas.add(sample.sha);
  }

  const groupsChangedByBaseline = new Map<string, Set<string>>();
  if (baseSha !== null) {
    for (const sha of candidateShas) {
      groupsChangedByBaseline.set(
        sha,
        await guard(
          "comparing the baseline commit against the base-branch commit",
          () => fetchChangedGroups(sha, baseSha),
        ),
      );
    }
    reportBaselineDistance(candidateShas, baseSha, ancestorRank, log);
  }

  return resolveMetricBaselines({
    metrics: options.metrics,
    timelines: options.timelines,
    isRunCold: options.isRunCold,
    ancestorRank,
    groupsChangedByBaseline,
    baseSha,
    isPullRequest: options.isPullRequest,
  });
}

/** Picks each metric's baseline and says whether the ratchet may act on it. */
export function resolveMetricBaselines(
  options: ResolveMetricBaselinesOptions,
): Map<string, MetricBaseline> {
  const resolved = new Map<string, MetricBaseline>();

  for (const metric of options.metrics) {
    const timeline = options.timelines.get(metric);
    const sample = timeline
      ? nearestUsableBaseline(
        timeline.samples,
        options.isRunCold,
        options.ancestorRank,
      )
      : undefined;

    resolved.set(metric, {
      sample,
      comparable: isComparableBaseline({
        sample,
        metric,
        baseSha: options.baseSha,
        groupsChangedByBaseline: options.groupsChangedByBaseline,
        isPullRequest: options.isPullRequest,
      }),
    });
  }

  return resolved;
}

/** Names the groups no baseline could speak to, and why they are not gated. */
export function reportUngatedGroups(
  groups: Set<string>,
  log: (message: string) => void = console.log,
): void {
  if (groups.size === 0) return;

  log(
    "\nNot gated, because no baseline counts the same base-branch code as " +
      `this run does: ${[...groups].sort().join(", ")}. A later run of this ` +
      "pull request gates them, once a `main` run has measured the commit it " +
      "merges.",
  );
}

/**
 * Reports which commit each baseline was measured at, and how far back from the
 * base-branch commit that sits.
 */
export function reportBaselineDistance(
  baselineShas: Set<string>,
  baseSha: string,
  ancestorRank: Map<string, number> | null,
  log: (message: string) => void = console.log,
): void {
  if (baselineShas.size === 0) {
    log(
      `No \`main\` run has measured base-branch commit ${
        baseSha.slice(0, 8)
      } or any of its ancestors.`,
    );
    return;
  }

  for (const sha of [...baselineShas].sort()) {
    const rank = ancestorRank?.get(sha);
    const distance = rank === undefined
      ? "at an unknown distance from"
      : rank === 0
      ? "at"
      : `${pluralize(rank, "commit")} before`;
    log(
      `Ratchet baseline measured ${distance} the base-branch commit: ${
        sha.slice(0, 8)
      }.`,
    );
  }
}

export async function fetchCommitsBehindMain(
  baselineSha: string,
  mainHeadSha: string,
): Promise<number | null> {
  if (baselineSha === mainHeadSha) return 0;

  try {
    const comparison = await githubGet<GitHubCompareResponse>(
      `/repos/${REPO}/compare/${encodeURIComponent(baselineSha)}...${
        encodeURIComponent(mainHeadSha)
      }`,
    );
    return typeof comparison.ahead_by === "number" ? comparison.ahead_by : null;
  } catch (error) {
    console.warn(
      `  Warning: could not compare baseline ${baselineSha.slice(0, 8)} ` +
        `to current main ${mainHeadSha.slice(0, 8)}: ${
          formatErrorForLog(error)
        }`,
    );
    return null;
  }
}

export function selectMergedPRForCommit(prs: PRInfo[]): PRInfo | null {
  return prs.find((pr) => pr.merged_at !== null) ?? prs[0] ?? null;
}

export interface PRLookupResult {
  pr: PRInfo | null;
  error: unknown | null;
}

export interface BaselineRunContext {
  run: WorkflowRun;
  artifacts: Artifact[];
  pr: PRInfo | null;
  prLookupError: unknown | null;
  commitsBehindMain: number | null;
}

export async function fetchPRForCommitWithError(
  sha: string,
): Promise<PRLookupResult> {
  try {
    const prs = await githubGet<PRInfo[]>(
      `/repos/${REPO}/commits/${sha}/pulls`,
    );
    return { pr: selectMergedPRForCommit(prs), error: null };
  } catch (error) {
    return { pr: null, error };
  }
}

export function newestArtifactNamed(
  artifacts: Artifact[],
  name: string,
): Artifact | null {
  return newestArtifactsByName(
    artifacts.filter((artifact) => artifact.name === name && !artifact.expired),
  )[0] ?? null;
}

export function formatErrorForLog(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0];
}

export function logBaselineSourceRuns(
  contexts: BaselineRunContext[],
  currentRunCreatedAt: string,
): void {
  console.log("\n::group::Baseline source runs:\n");
  for (
    const { run, artifacts, pr, prLookupError, commitsBehindMain } of contexts
  ) {
    const baselineArtifact = newestArtifactNamed(
      artifacts,
      PERF_METRICS_ARTIFACT_NAME,
    );
    const prLabel = pr
      ? `PR #${pr.number}`
      : prLookupError
      ? "PR lookup failed"
      : "no PR found";
    const artifactLabel = baselineArtifact
      ? `perf-metrics artifact ${baselineArtifact.id}`
      : "no perf-metrics artifact";
    const ageLabel = formatBaselineSourceRunAge(
      run.created_at,
      currentRunCreatedAt,
      commitsBehindMain,
    );
    console.log(
      `  ${run.created_at} run ${run.id} ${run.head_sha.slice(0, 8)} ` +
        `${ageLabel}; ${prLabel}; ${artifactLabel}`,
    );
  }
  console.log("\n::endgroup::\n");
}

export interface BaselinePRLookupSummary {
  found: number;
  noPR: number;
  failed: number;
}

export function summarizeBaselinePRLookups(
  contexts: { pr: PRInfo | null; prLookupError: unknown | null }[],
): BaselinePRLookupSummary {
  const failed = contexts.filter((context) => context.prLookupError).length;
  const found = contexts.filter((context) => context.pr).length;
  return {
    found,
    noPR: contexts.length - found - failed,
    failed,
  };
}

export function reportPRLookupResults(
  contexts: BaselineRunContext[],
): number {
  const summary = summarizeBaselinePRLookups(contexts);
  const failures = contexts.filter((context) => context.prLookupError);

  console.log(
    `Baseline PR lookup: found ${summary.found}/${contexts.length}; ` +
      `${summary.noPR} had no associated PR; ${summary.failed} failed.`,
  );

  if (summary.failed === 0) return 0;

  console.warn(
    `  Warning: failed to fetch PR metadata for ${summary.failed} baseline run(s).`,
  );
  for (const { run, prLookupError } of failures) {
    console.warn(
      `  Warning: run ${run.id} (${
        run.head_sha.slice(0, 8)
      }) PR lookup failed: ${formatErrorForLog(prLookupError)}`,
    );
  }

  return summary.failed;
}

export async function fetchArtifactsForRunBestEffort(
  run: WorkflowRun,
  fetchArtifacts: (runId: number) => Promise<Artifact[]> = fetchArtifactsForRun,
  warn: (message: string) => void = console.warn,
): Promise<Artifact[]> {
  try {
    return await fetchArtifacts(run.id);
  } catch (error) {
    warn(`  Warning: could not fetch artifacts for run ${run.id}: ${error}`);
    return [];
  }
}

export async function fetchBaselineRunsForCheck(
  metricsForArtifact: Map<string, TimingSample>,
  baselineRunCount = BASELINE_RUNS,
  log: (message: string) => void = console.log,
): Promise<{ mainHeadSha: string; baselineRuns: WorkflowRun[] }> {
  log("Fetching current main branch head...");
  const mainHeadSha = await githubApiOrSkip(
    "fetching current main branch head",
    () => fetchMainHeadSha(),
    metricsForArtifact,
  );
  log(`Current main head is ${mainHeadSha}.`);
  log("Fetching recent main-branch runs for baseline...");
  const baselineData = await githubApiOrSkip(
    "fetching recent main-branch runs for baseline",
    () =>
      githubGet<{ workflow_runs: WorkflowRun[] }>(
        workflowRunsPathForBaseline(baselineRunCount),
      ),
    metricsForArtifact,
  );
  return { mainHeadSha, baselineRuns: baselineData.workflow_runs };
}

export function reportBaselineRunAvailability(
  baselineRuns: WorkflowRun[],
  mainHeadSha: string,
  warn: (message: string) => void = console.warn,
): BaselineMainHeadValidation {
  const baselineMainHead = validateBaselineRunsForMainHead(
    baselineRuns,
    mainHeadSha,
  );
  if (!baselineMainHead.ok) {
    warn(
      "Warning: newest successful baseline run is not for the current main head.",
    );
    for (const issue of baselineMainHead.issues) {
      warn(`  Warning: ${issue}`);
    }
  }

  if (baselineRuns.length === 0) {
    warn(
      "  Warning: no baseline runs available; coverage debt will bootstrap from this run.",
    );
  }

  return baselineMainHead;
}

export interface BuildBaselineRunContextsOptions {
  baselineRuns: WorkflowRun[];
  mainHeadSha: string;
  fetchArtifactsForRun?: (run: WorkflowRun) => Promise<Artifact[]>;
  fetchPRForCommit?: (sha: string) => Promise<PRLookupResult>;
  fetchCommitsBehindMain?: (
    baselineSha: string,
    mainHeadSha: string,
  ) => Promise<number | null>;
  concurrency?: number;
}

export async function buildBaselineRunContexts(
  options: BuildBaselineRunContextsOptions,
): Promise<BaselineRunContext[]> {
  const fetchArtifacts = options.fetchArtifactsForRun ??
    fetchArtifactsForRunBestEffort;
  const fetchPR = options.fetchPRForCommit ?? fetchPRForCommitWithError;
  const fetchCommitDistance = options.fetchCommitsBehindMain ??
    fetchCommitsBehindMain;

  return await mapConcurrent(
    options.baselineRuns,
    options.concurrency ?? API_CONCURRENCY,
    async (run): Promise<BaselineRunContext> => {
      const [artifacts, prLookup, commitsBehindMain] = await Promise.all([
        fetchArtifacts(run),
        fetchPR(run.head_sha),
        fetchCommitDistance(run.head_sha, options.mainHeadSha),
      ]);
      return {
        run,
        artifacts,
        pr: prLookup.pr,
        prLookupError: prLookup.error,
        commitsBehindMain,
      };
    },
  );
}

export function reportBaselineContextResults(
  contexts: BaselineRunContext[],
  currentRunCreatedAt: string,
): number {
  logBaselineSourceRuns(contexts, currentRunCreatedAt);
  const prLookupFailures = reportPRLookupResults(contexts);
  if (prLookupFailures > 0) {
    console.warn(
      "  Warning: running the coverage check with incomplete PR metadata. Some merged baseline overrides may be missing.",
    );
  }
  return prLookupFailures;
}

export async function parseCoverageBaselineFromArtifacts(
  artifacts: Artifact[],
  parseMetrics: (
    artifactId: number,
  ) => Promise<CoverageBaselineDetailed | null> =
    downloadAndParseCoverageBaseline,
): Promise<CoverageBaselineDetailed | null> {
  const artifact = newestArtifactNamed(
    artifacts,
    PERF_METRICS_ARTIFACT_NAME,
  );
  if (!artifact) return null;

  return await parseMetrics(artifact.id);
}

export interface AddCoverageBaselineResult {
  added: boolean;
  /** Null when the run has no perf-metrics artifact or an untagged one. */
  compileCacheStates: CompileCacheStates | null;
}

export async function addCoverageBaselineFromArtifacts(
  timelines: Map<string, MetricTimeline>,
  artifacts: Artifact[],
  parseMetrics: (
    artifacts: Artifact[],
  ) => Promise<CoverageBaselineDetailed | null> =
    parseCoverageBaselineFromArtifacts,
): Promise<AddCoverageBaselineResult> {
  const detailed = await parseMetrics(artifacts);
  if (!detailed) return { added: false, compileCacheStates: null };

  for (const [name, sample] of detailed.metrics) {
    addSample(timelines, name, sample);
  }
  return { added: true, compileCacheStates: detailed.compileCacheStates };
}

/**
 * Download the JSON file(s) inside one cache-state artifact. Returns null
 * when the download or extraction fails.
 */
async function downloadCacheStateFiles(
  artifactId: number,
): Promise<string[] | null> {
  const tmpDir = await downloadAndExtractArtifact(artifactId, "cache-state-");
  if (!tmpDir) return null;
  try {
    const contents: string[] = [];
    for await (const file of walkFiles(tmpDir)) {
      if (file.endsWith(".json")) {
        contents.push(await Deno.readTextFile(file));
      }
    }
    return contents;
  } finally {
    try {
      await Deno.remove(tmpDir, { recursive: true });
    } catch { /* ignore cleanup errors */ }
  }
}

/** `family=state` pairs for every cache family, absent shown as unknown. */
export function formatCompileCacheStates(states: CompileCacheStates): string {
  return COMPILE_CACHE_FAMILIES
    .map((family) => `${family}=${states[family] ?? "unknown"}`)
    .join(", ");
}

/**
 * Aggregate the current run's per-shard cache-state artifacts into per-family
 * compile cache states. Re-run duplicates are deduped newest-first — a re-run
 * restores the cache the first (cold) attempt saved, so it is genuinely warm.
 * Best-effort: any failure degrades to `{}` (all unknown) with a warning, so
 * a broken tag behaves like a pre-rollout run instead of failing the gate.
 */
export async function collectCurrentCacheStates(
  artifacts: Artifact[],
  download: (artifactId: number) => Promise<string[] | null> =
    downloadCacheStateFiles,
): Promise<CompileCacheStates> {
  try {
    const cacheStateArtifacts = newestArtifactsByName(artifacts.filter(
      (artifact) =>
        artifact.name.startsWith(CACHE_STATE_ARTIFACT_PREFIX) &&
        !artifact.expired,
    ));

    const contents: string[] = [];
    for (const artifact of cacheStateArtifacts) {
      const files = await download(artifact.id);
      if (!files) {
        throw new Error(
          `could not download cache-state artifact ${artifact.name} (${artifact.id})`,
        );
      }
      contents.push(...files);
    }
    const records = parseCacheStateFiles(contents);
    if (!records) {
      throw new Error(
        "one or more cache-state records failed to parse; a missing shard " +
          "could mislabel its family warm",
      );
    }
    return aggregateCacheStates(records);
  } catch (error) {
    console.warn(
      `  Warning: could not collect compile cache states; treating them as unknown: ${error}`,
    );
    return {};
  }
}

export const EXPECTED_COVERAGE_ARTIFACT_NAMES = [
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((shard) =>
    `coverage-profile-workspace-${shard}`
  ),
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((shard) =>
    `coverage-profile-runner-${shard}`
  ),
  ...[1, 2, 3, 4].map((shard) =>
    `coverage-profile-generated-patterns-${shard}`
  ),
  "coverage-profile-package-runner",
  "coverage-profile-package-runtime-client",
  "coverage-profile-package-shell",
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((shard) =>
    `coverage-profile-pattern-integration-${shard}`
  ),
  "coverage-profile-pattern-reload",
  ...[1, 2, 3, 4, 5].map((chunk) => `coverage-profile-pattern-unit-${chunk}`),
];

function sampleForRun(run: WorkflowRun, value: number): TimingSample {
  return {
    runId: run.id,
    runUrl: run.html_url,
    sha: run.head_sha,
    createdAt: run.created_at,
    durationSeconds: value,
  };
}

export async function copyCoverageArtifactFiles(
  artifact: Artifact,
  profileDir: string,
  lcovDir: string,
  coverageArtifactsDir?: string,
): Promise<{ profileFiles: number; lcovFiles: number }> {
  let sourceDir: string;
  let removeSourceDir = false;
  if (coverageArtifactsDir) {
    sourceDir = path.join(coverageArtifactsDir, artifact.name);
    let sourceStat: Deno.FileInfo;
    try {
      sourceStat = await Deno.stat(sourceDir);
    } catch (error) {
      const problem = error instanceof Deno.errors.NotFound
        ? "was not found"
        : "could not be read";
      throw new Error(
        `Pre-downloaded coverage profile artifact ${artifact.name} (${artifact.id}) ${problem} at ${sourceDir}.`,
        { cause: error },
      );
    }
    if (!sourceStat.isDirectory) {
      throw new Error(
        `Pre-downloaded coverage profile artifact ${artifact.name} (${artifact.id}) is not a directory: ${sourceDir}.`,
      );
    }
  } else {
    const extractedDir = await downloadAndExtractArtifact(
      artifact.id,
      "coverage-profile-",
    );
    if (!extractedDir) {
      throw new Error(
        `Failed to download or extract coverage profile artifact ${artifact.name} (${artifact.id}).`,
      );
    }
    sourceDir = extractedDir;
    removeSourceDir = true;
  }

  let profileFiles = 0;
  let lcovFiles = 0;
  try {
    for await (const file of walkFiles(sourceDir)) {
      const isProfile = file.endsWith(".json");
      const isLcov = file.endsWith(".lcov");
      if (!isProfile && !isLcov) continue;
      const count = isLcov ? lcovFiles : profileFiles;
      const destDir = isLcov ? lcovDir : profileDir;
      const dest = path.join(
        destDir,
        `${artifact.id}-${count}-${path.basename(file)}`,
      );
      await Deno.copyFile(file, dest);
      if (isLcov) lcovFiles++;
      else profileFiles++;
    }

    if (profileFiles === 0 && lcovFiles === 0) {
      throw new Error(
        `Coverage profile artifact ${artifact.name} (${artifact.id}) contained no profile or LCOV files.`,
      );
    }
  } finally {
    if (removeSourceDir) {
      try {
        await Deno.remove(sourceDir, { recursive: true });
      } catch { /* ignore cleanup errors */ }
    }
  }

  return { profileFiles, lcovFiles };
}

async function readCombinedLcov(lcovDir: string): Promise<string> {
  const chunks: string[] = [];
  for await (const file of walkFiles(lcovDir)) {
    if (!file.endsWith(".lcov")) continue;
    chunks.push(await Deno.readTextFile(file));
  }
  return chunks.join("\n");
}

type TableAlign = "left" | "right";
export type Status =
  | "OVER"
  | "OK"
  | "ovrd"
  | "excl"
  | "n/a";

function printTextTable(
  headers: string[],
  rows: string[][],
  align: TableAlign[] = [],
): void {
  const widths = headers.map((header, column) =>
    Math.max(
      header.length,
      ...rows.map((row) => row[column]?.length ?? 0),
    )
  );

  const formatCell = (cell: string, column: number) =>
    align[column] === "right"
      ? cell.padStart(widths[column])
      : cell.padEnd(widths[column]);
  const formatRow = (cells: string[]) =>
    cells.map((cell, column) => formatCell(cell, column)).join("  ");

  console.log(formatRow(headers));
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of rows) {
    console.log(formatRow(row));
  }
}

export function formatMetricValueForTable(
  value: number | undefined,
): string {
  if (value === undefined) return "-";
  return `${Math.round(value)}`;
}

export function formatMetricDelta(row: Row): string {
  if (row.median === undefined || row.pctIncrease === undefined) return "-";

  const delta = row.current - row.median;
  const sign = delta >= 0 ? "+" : "-";
  const formattedAbsolute = `${Math.round(Math.abs(delta))}`;
  const pctSign = row.pctIncrease >= 0 ? "+" : "";
  const pctDigits = row.pctIncrease !== 0 && Math.abs(row.pctIncrease) < 1
    ? 1
    : 0;
  return `${sign}${formattedAbsolute} (${pctSign}${
    row.pctIncrease.toFixed(pctDigits)
  }%)`;
}

export function metricDisplayParts(
  metric: string,
): { task: string; metric: string } {
  const colon = metric.indexOf(":");
  if (colon < 0) return { task: "other", metric };

  const kind = metric.slice(0, colon);
  const rest = metric.slice(colon + 1).trim();

  if (kind === "coverage-debt") {
    return {
      task: kind,
      metric: coverageMetricGroupName(metric) ?? rest,
    };
  }

  return { task: kind, metric: rest };
}

export interface Row {
  metric: string;
  status: Status;
  current: number;
  /** Latest non-cold `main` ratchet baseline (uncovered lines). */
  median?: number;
  /** Head SHA of the run that baseline came from. */
  baselineSha?: string;
  n: number;
  pctIncrease?: number;
}

export function metricTableRows(
  rows: Row[],
  includeStatus: boolean,
): string[][] {
  return rows.map((row) => {
    const display = metricDisplayParts(row.metric);
    const cells = [
      formatMetricValueForTable(row.median),
      formatMetricValueForTable(row.current),
      formatMetricDelta(row),
      display.task,
      display.metric,
    ];
    return includeStatus ? [row.status, ...cells] : cells;
  });
}

export interface BuildCoverageRowsOptions {
  currentMetrics: Map<string, TimingSample>;
  timelines: Map<string, MetricTimeline>;
  baselineByMetric: Map<string, MetricBaseline>;
  overrides: BaselineOverrides;
  /** Undefined when the PR's changed files could not be read. */
  changedCoverageGroups: Set<string> | undefined;
}

export interface CoverageRows {
  rows: Row[];
  /** The subset of `rows` that fails the gate. */
  failures: Row[];
  /** Groups whose baseline could not be held against this run. */
  ungatedGroups: Set<string>;
}

/**
 * Scores every metric against its baseline and says which ones fail.
 *
 * A metric is failed only when it is gated and its count rose above the
 * baseline. It is not gated when the pull request left its group alone, when
 * the description accepts its level, or when no baseline counts the same
 * base-branch code as this run.
 */
export function buildCoverageRows(
  options: BuildCoverageRowsOptions,
): CoverageRows {
  const rows: Row[] = [];
  const failures: Row[] = [];
  const ungatedGroups = new Set<string>();

  for (const [metric, currentSample] of options.currentMetrics) {
    const current = currentSample.durationSeconds;
    const n = options.timelines.get(metric)?.samples.length ?? 0;
    const resolvedBaseline = options.baselineByMetric.get(metric);
    const baselineSample = resolvedBaseline?.sample;
    const latestBaseline = baselineSample?.durationSeconds;
    const override = options.overrides.metrics.get(metric);
    const coverageReset = options.overrides.coverageBaselineReset;
    const comparable = resolvedBaseline?.comparable ?? false;
    if (!comparable) {
      const group = coverageMetricGroupName(metric);
      if (group !== null) ungatedGroups.add(group);
    }
    const shouldGateCoverage = comparable &&
      shouldGateCoverageDebtMetric(metric, options.changedCoverageGroups);

    if (latestBaseline === undefined) {
      if (
        coverageReset || (override !== undefined && current <= override)
      ) {
        rows.push({ metric, status: "ovrd", current, n });
      } else if (!shouldGateCoverage) {
        rows.push({ metric, status: "excl", current, n });
      } else if (current > 0) {
        const row: Row = {
          metric,
          status: "OVER",
          current,
          median: 0,
          n,
          pctIncrease: 100,
        };
        rows.push(row);
        failures.push(row);
      } else {
        rows.push({ metric, status: "n/a", current, n });
      }
      continue;
    }

    const pctIncrease = latestBaseline === 0
      ? current > 0 ? 100 : 0
      : ((current - latestBaseline) / latestBaseline) * 100;
    const stats = {
      median: latestBaseline,
      baselineSha: baselineSample?.sha,
      pctIncrease,
    };

    if (coverageReset) {
      rows.push({ metric, status: "ovrd", current, n, ...stats });
      continue;
    }

    if (override !== undefined && current <= override) {
      rows.push({ metric, status: "ovrd", current, n, ...stats });
      continue;
    }

    if (!shouldGateCoverage) {
      rows.push({ metric, status: "excl", current, n, ...stats });
      continue;
    }

    if (current > latestBaseline) {
      const row: Row = { metric, status: "OVER", current, n, ...stats };
      rows.push(row);
      failures.push(row);
    } else {
      rows.push({ metric, status: "OK", current, n, ...stats });
    }
  }

  return { rows, failures, ungatedGroups };
}

export function printMetricTable(rows: Row[], includeStatus = false): void {
  const headers = includeStatus
    ? ["Status", "Baseline", "Current", "Change", "Task", "Metric"]
    : ["Baseline", "Current", "Change", "Task", "Metric"];
  const align = includeStatus
    ? ["left", "right", "right", "right", "left", "left"] as TableAlign[]
    : ["right", "right", "right", "left", "left"] as TableAlign[];
  printTextTable(headers, metricTableRows(rows, includeStatus), align);
}

async function extractCoverageDebtSamples(
  run: WorkflowRun,
  artifacts: Artifact[],
  coverageArtifactsDir?: string,
): Promise<{ samples: Map<string, TimingSample>; lcov: string }> {
  const metrics = new Map<string, TimingSample>();
  const coverageArtifacts = newestArtifactsByName(artifacts.filter(
    (artifact) =>
      artifact.name.startsWith(COVERAGE_PROFILE_ARTIFACT_PREFIX) &&
      !artifact.expired,
  ));
  const coverageArtifactNames = new Set(
    coverageArtifacts.map((artifact) => artifact.name),
  );
  const missingArtifacts = EXPECTED_COVERAGE_ARTIFACT_NAMES.filter((name) =>
    !coverageArtifactNames.has(name)
  );

  if (missingArtifacts.length > 0) {
    throw new Error(
      `Missing coverage profile artifact(s): ${missingArtifacts.join(", ")}`,
    );
  }

  const profileDir = await Deno.makeTempDir({ prefix: "coverage-profiles-" });
  const lcovDir = await Deno.makeTempDir({ prefix: "coverage-lcov-" });
  let lcov = "";
  try {
    let profileFileCount = 0;
    let lcovFileCount = 0;
    for (const artifact of coverageArtifacts) {
      const copied = await copyCoverageArtifactFiles(
        artifact,
        profileDir,
        lcovDir,
        coverageArtifactsDir,
      );
      profileFileCount += copied.profileFiles;
      lcovFileCount += copied.lcovFiles;
    }

    if (profileFileCount === 0 && lcovFileCount === 0) {
      throw new Error(
        "Coverage profile artifacts contained no profile or LCOV files.",
      );
    }

    lcov = lcovFileCount > 0
      ? await readCombinedLcov(lcovDir)
      : await lcovFromCoverageProfile(profileDir);

    // Every coverage stream feeds the gate: V8 runtime coverage, unit pattern
    // coverage (TN:pattern-runtime), and integration pattern coverage
    // (TN:pattern-runtime-integration) all join here, and a line covered by any
    // of them counts covered. So a pattern line an end-to-end flow exercises
    // that the unit suite does not lowers the gated debt.
    const coverageMetrics = await collectCoverageDebtMetricsFromLcov({
      rootDir: Deno.cwd(),
      lcov,
    });
    for (const metric of coverageMetrics) {
      metrics.set(metric.name, sampleForRun(run, metric.uncoveredLines));
    }

    console.log(
      `Extracted ${coverageMetrics.length} coverage debt metrics from ${
        lcovFileCount > 0
          ? `${lcovFileCount} LCOV report files`
          : `${profileFileCount} coverage profile files`
      }.`,
    );
  } finally {
    try {
      await Deno.remove(profileDir, { recursive: true });
    } catch { /* ignore cleanup errors */ }
    try {
      await Deno.remove(lcovDir, { recursive: true });
    } catch { /* ignore cleanup errors */ }
  }

  return { samples: metrics, lcov };
}

/** File the coverage-comment payload is written to; tests override via env. */
function coverageCommentOutputPath(): string {
  return Deno.env.get("COVERAGE_COMMENT_FILE") ?? COVERAGE_COMMENT_FILE;
}

/**
 * Decide and write the coverage-debt comment payload for a PR. A coverage
 * regression writes a "regressed" body; an acceptable run writes a "resolved"
 * payload so the poster can collapse any earlier comment. Done for every real PR
 * run, pass or fail, so a fixed regression is reflected even when the run still
 * fails for other reasons.
 */
export async function writeCoverageComment(
  prNumber: number,
  coverageFailures: Row[],
  coverageRows: Row[],
  prFiles: PRFile[],
  lcov: string,
): Promise<void> {
  if (coverageFailures.length > 0) {
    await writeCoverageDebtSuggestion(
      prNumber,
      coverageFailures,
      prFiles,
      lcov,
    );
  } else {
    await writeCoverageResolved(prNumber, coverageRows, prFiles);
  }
}

/**
 * Write the coverage-debt regression comment to a file for a later workflow to
 * post. The gate runs on `pull_request`, where fork PRs get a read-only token
 * and cannot comment, so the `coverage-comment` workflow_run job posts this from
 * the base-repo context instead. Never throws — this is best-effort so it cannot
 * mask the regression failure itself.
 */
export async function writeCoverageDebtSuggestion(
  prNumber: number,
  coverageFailures: Row[],
  prFiles: PRFile[],
  lcov: string,
): Promise<void> {
  const groups = coverageFailures
    .map((failure) => ({
      group: coverageMetricGroupName(failure.metric),
      target: Math.round(failure.median ?? 0),
      current: Math.round(failure.current),
    }))
    .filter((group): group is CoverageSuggestionGroup => group.group !== null);

  if (groups.length === 0) return;

  const failingGroups = new Set(groups.map((group) => group.group));

  // Resolve uncovered line numbers only for changed files in the regressed
  // groups, so we never materialize per-line data for the whole workspace.
  const changedInFailingGroups = prFiles
    .map((prFile) => prFile.filename.replaceAll("\\", "/"))
    .filter((relativePath) => {
      const group = coverageGroupForChangedFile(relativePath);
      return group !== null && failingGroups.has(group);
    });
  const uncoveredByPath = await collectUncoveredLinesForFiles({
    rootDir: Deno.cwd(),
    lcov,
    files: changedInFailingGroups,
  });

  // Count, per changed file, the lines this PR added that coverage marks
  // uncovered.
  const files: CoverageSuggestionFileLines[] = [];
  for (const prFile of prFiles) {
    const relativePath = prFile.filename.replaceAll("\\", "/");
    const group = coverageGroupForChangedFile(relativePath);
    if (!group || !failingGroups.has(group)) continue;

    const uncoveredLines = uncoveredByPath.get(relativePath);
    if (!uncoveredLines || !prFile.patch) continue;

    const addedLines = parseAddedLinesFromPatch(prFile.patch);
    const uncoveredCount = uncoveredLines.filter((line) =>
      addedLines.has(line)
    ).length;
    if (uncoveredCount > 0) files.push({ relativePath, group, uncoveredCount });
  }

  try {
    const body = buildCoverageDebtSuggestionComment({ groups, files });
    const payload: CoverageCommentPayload = {
      prNumber,
      state: "regressed",
      body,
    };
    const outputFile = coverageCommentOutputPath();
    await Deno.writeTextFile(outputFile, JSON.stringify(payload, null, 2));
    console.log(
      `Wrote ${outputFile} for PR #${prNumber}; the coverage-comment workflow will post or update it.`,
    );
  } catch (error) {
    console.warn(
      `  Warning: could not write coverage suggestion comment for PR #${prNumber}: ${error}`,
    );
  }
}

/**
 * Write a "resolved" coverage-comment payload so the coverage-comment workflow
 * can collapse and rewrite an earlier regression comment on the PR. The payload
 * is always written when coverage is acceptable: a run cannot tell whether a
 * comment exists, nor what files earlier commits on the PR changed, so it defers
 * that to the poster, which no-ops when there is nothing to update.
 *
 * `improvedLines` is the reduction this PR makes to the coverage debt it is
 * gated on: summed across the per-package groups whose files it changed, how far
 * each now sits below its `main` ratchet baseline. A passing gated group has
 * status "OK"; the workspace aggregate and untouched groups are "excl" and
 * overridden groups are "ovrd", so leaving everything but "OK" out keeps the
 * number to the debt this PR removed in the code it actually touched — not the
 * whole-workspace drift the gate never attributes to the PR. `groups` is the
 * per-group baseline-versus-this-PR breakdown for the source groups this PR
 * changed, the same groups the gate ratchets, so the collapsed comment can show
 * where the PR left coverage. Never throws —
 * best-effort, like the regression path.
 */
export async function writeCoverageResolved(
  prNumber: number,
  coverageRows: Row[],
  prFiles: PRFile[],
): Promise<void> {
  const improvedLines = coverageRows.reduce((sum, row) => {
    if (row.status !== "OK" || row.median === undefined) return sum;
    return sum + Math.max(0, Math.round(row.median - row.current));
  }, 0);

  // Summarize the source groups this PR changed — the per-group ratchet the
  // gate evaluates. Workspace is the aggregate behind `improvedLines`, so it
  // stays out of the per-group breakdown.
  const changedGroups = coverageGroupsForChangedFiles(
    prFiles.map((prFile) => prFile.filename),
  );
  const groups: CoverageResolvedGroup[] = coverageRows
    .map((row) => ({
      group: coverageMetricGroupName(row.metric),
      baseline: Math.round(row.median ?? 0),
      current: Math.round(row.current),
    }))
    .filter((group): group is CoverageResolvedGroup =>
      group.group !== null &&
      group.group !== "workspace" &&
      changedGroups.has(group.group)
    );

  // The gate passed because a changed group's debt was accepted with a
  // per-metric override or the reset marker (status "ovrd"), not because the
  // new code is covered.
  const overridden = coverageRows.some((row) => {
    if (row.status !== "ovrd") return false;
    const group = coverageMetricGroupName(row.metric);
    return group !== null && group !== "workspace" && changedGroups.has(group);
  });

  try {
    const payload: CoverageCommentPayload = {
      prNumber,
      state: "resolved",
      improvedLines,
      groups,
      overridden,
    };
    const outputFile = coverageCommentOutputPath();
    await Deno.writeTextFile(outputFile, JSON.stringify(payload, null, 2));
    console.log(
      `Wrote ${outputFile} (resolved, net ${improvedLines} line(s) covered) for PR #${prNumber}; the coverage-comment workflow will update any existing comment.`,
    );
  } catch (error) {
    console.warn(
      `  Warning: could not write resolved coverage comment for PR #${prNumber}: ${error}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main() {
  const runId = Deno.env.get("GITHUB_RUN_ID");
  const rawPrNumber = Deno.env.get("PR_NUMBER");
  const prNumber = (rawPrNumber === "") ? null : rawPrNumber;
  const informationalOnly = prNumber === null;

  if (!Deno.env.get("GITHUB_TOKEN")) {
    console.error("GITHUB_TOKEN is required.");
    Deno.exit(1);
  }
  if (!runId) {
    console.error("GITHUB_RUN_ID is required.");
    Deno.exit(1);
  }

  const event = await readAndParseEvent();
  console.log("::group::Triggered by event:\n%o\n::endgroup::", event);

  // 1. Check PR description for overrides, if there's a PR to check.
  let prOverrides;
  if (prNumber) {
    console.log(`Fetching live PR #${prNumber} description...`);
    const prBody = await fetchCurrentPRBody(parseInt(prNumber), event);
    if (prBody.source === "live") {
      console.log("Using live PR description from GitHub API.");
    } else if (prBody.source === "event-fallback") {
      console.warn(
        `  Warning: could not fetch live PR body; using pull_request event payload: ${prBody.errorMessage}`,
      );
    } else {
      console.warn(
        `  Warning: could not fetch live PR body and no pull_request event body was available: ${prBody.errorMessage}`,
      );
    }
    try {
      prOverrides = parseBaselineOverrides(prBody.body);
    } catch (error) {
      console.error(
        `Invalid performance baseline override in PR description: ${error}`,
      );
      Deno.exit(1);
    }
  } else {
    prOverrides = { metrics: new Map(), coverageBaselineReset: false };
  }

  if (prOverrides.metrics.size > 0) {
    console.log(
      `PR description contains ${prOverrides.metrics.size} ACCEPT_COVERAGE_DEBT override(s).`,
    );
  }
  if (prOverrides.coverageBaselineReset) {
    console.log(
      `PR description contains ${COVERAGE_BASELINE_RESET_MARKER}; coverage debt ratchet failures will be treated as an intentional baseline reset.`,
    );
  }

  // 2. Extract the current run's coverage.
  const runIdNum = parseInt(runId);
  const currentMetrics = new Map<string, TimingSample>();

  // The event payload has the metadata needed for samples, so avoid spending
  // an API request on the current workflow run.
  const currentRunInfo = currentWorkflowRunFromEvent(event, runIdNum);
  let changedCoverageGroups: Set<string> | undefined;
  let prFiles: PRFile[] = [];

  if (prNumber) {
    try {
      prFiles = await fetchPRFiles(parseInt(prNumber));
      changedCoverageGroups = coverageGroupsForChangedFiles(
        prFiles.map((file) => file.filename),
      );
      const groups = [...changedCoverageGroups].sort();
      if (groups.length > 0) {
        console.log(
          `Coverage debt gating applies to changed source group(s): ${
            groups.join(", ")
          }.`,
        );
      } else {
        console.log(
          "PR changes no coverage source groups; coverage debt metrics will be reported but not blocking.",
        );
      }
    } catch (error) {
      console.warn(
        `  Warning: could not fetch PR changed files; coverage debt metrics will use strict gating: ${error}`,
      );
    }
  }

  let currentArtifacts: Artifact[] = [];
  let currentArtifactsError: unknown;

  try {
    currentArtifacts = await fetchArtifactsForRun(runIdNum);
    console.log(
      `Fetched ${currentArtifacts.length} artifacts for current run.`,
    );
  } catch (e) {
    currentArtifactsError = e;
    console.warn(`  Warning: could not fetch artifacts for current run: ${e}`);
  }

  // Aggregate the current run's compile cache states so this run's
  // perf-metrics artifact is tagged (main-push runs included — a later
  // PR's coverage ratchet must know whether this run was cold).
  const currentCacheStates = await collectCurrentCacheStates(currentArtifacts);
  console.log(
    `Compile cache states: ${formatCompileCacheStates(currentCacheStates)}`,
  );

  // Fallback for families with no recorded state (artifact missing, upload or
  // download failed): infer the run-level state from the compile fingerprint —
  // the PR's changed files, or the compare against the previous main run — and
  // fill only the families with no recorded state. Recorded states are ground
  // truth and win (see inferCurrentRunFallbackState /
  // fillMissingFamiliesFromFingerprint).
  const inferredRunState = await inferCurrentRunFallbackState({
    isPullRequestRun: !!prNumber,
    prFiles,
    headSha: currentRunInfo.head_sha,
    fetchLatestBaselineSha: fetchLatestBaselineRunSha,
  });
  fillMissingFamiliesFromFingerprint(currentCacheStates, inferredRunState);

  // Extract coverage debt metrics from coverage profile artifacts.
  let coverageDataError: unknown;
  let coverageLcov = "";
  try {
    if (currentArtifactsError) {
      throw new Error(
        `Could not fetch current run artifacts: ${currentArtifactsError}`,
      );
    }
    const coverage = await extractCoverageDebtSamples(
      currentRunInfo,
      currentArtifacts,
      Deno.env.get("COVERAGE_ARTIFACTS_DIR"),
    );
    for (const [name, sample] of coverage.samples) {
      currentMetrics.set(name, sample);
    }
    coverageLcov = coverage.lcov;
  } catch (e) {
    coverageDataError = e;
    console.error(
      `  Error: could not extract coverage debt metrics for current run: ${e}`,
    );
  }

  await writeCoverageBaselineFile(
    PERF_METRICS_FILE,
    currentMetrics,
    currentCacheStates,
  );
  console.log(
    `Wrote ${PERF_METRICS_FILE} with ${currentMetrics.size} metrics.`,
  );

  if (coverageDataError && !informationalOnly) {
    console.error(
      "Failing because coverage debt data is required for pull request checks.",
    );
    Deno.exit(1);
  }

  if (currentMetrics.size === 0) {
    console.log(
      "No coverage metrics extracted from current run. Nothing to check.",
    );
    Deno.exit(0);
  }

  console.log(
    `Extracted ${currentMetrics.size} coverage metrics from current run.`,
  );

  // 3. Fetch recent main-branch push runs for baseline
  const { mainHeadSha, baselineRuns } = await fetchBaselineRunsForCheck(
    currentMetrics,
  );
  reportBaselineRunAvailability(baselineRuns, mainHeadSha);

  console.log(`Using ${baselineRuns.length} main-branch runs as baseline.`);

  // 4. Read each recent main run's coverage metrics and compile cache states
  // as the ratchet baseline, and pick up any coverage ratchet resets or
  // per-metric acceptances from the merged PRs.
  const timelines = new Map<string, MetricTimeline>();
  const overridesBySha = new Map<string, BaselineOverrides>();
  const prInfoBySha = new Map<string, PRInfo>();
  // Compile cache states per baseline run, from tagged perf-metrics
  // artifacts. Runs with no artifact stay absent (unknown).
  const cacheStatesByRunId = new Map<number, CompileCacheStates>();

  const baselineContexts = await githubApiOrSkip(
    "fetching baseline run context",
    () => buildBaselineRunContexts({ baselineRuns, mainHeadSha }),
    currentMetrics,
  );

  reportBaselineContextResults(baselineContexts, currentRunInfo.created_at);

  // For each baseline run, its predecessor in the (newest-first) baseline
  // list — the run whose saved compile cache it would have restored. Fuels
  // retro-classification of a run whose perf-metrics artifact carries no
  // recorded cache state.
  const runsNewestFirst = [...baselineRuns].sort((a, b) =>
    b.created_at.localeCompare(a.created_at) || b.id - a.id
  );
  const predecessorShaByRunId = new Map<number, string>();
  for (let i = 0; i < runsNewestFirst.length - 1; i++) {
    predecessorShaByRunId.set(
      runsNewestFirst[i].id,
      runsNewestFirst[i + 1].head_sha,
    );
  }

  await githubApiOrSkip(
    "building baseline timelines",
    () =>
      mapConcurrent(baselineContexts, API_CONCURRENCY, async (context) => {
        const { run, artifacts, pr } = context;

        if (pr) {
          prInfoBySha.set(run.head_sha, pr);
          const overrides = parseMergedBaselineOverrides(pr);
          if (
            overrides &&
            (overrides.metrics.size > 0 || overrides.coverageBaselineReset)
          ) {
            overridesBySha.set(run.head_sha, overrides);
          }
        }

        const artifactResult = await addCoverageBaselineFromArtifacts(
          timelines,
          artifacts,
        );
        if (artifactResult.added && artifactResult.compileCacheStates) {
          cacheStatesByRunId.set(run.id, artifactResult.compileCacheStates);
        } else {
          // A run whose perf-metrics artifact is missing or carries no
          // recorded cache state: retro-classify it from the compile
          // fingerprint against its predecessor, so a cold main run is not
          // picked as the coverage ratchet baseline (see
          // recordUnstampedBaselineRunState).
          await recordUnstampedBaselineRunState(
            cacheStatesByRunId,
            run,
            predecessorShaByRunId.get(run.id),
            pr ? `PR #${pr.number}` : run.head_sha.slice(0, 8),
          );
        }
      }),
    currentMetrics,
  );

  // Sort timelines chronologically
  for (const timeline of timelines.values()) {
    timeline.samples.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  const isRunCold = (runId: number): boolean => {
    const states = cacheStatesByRunId.get(runId);
    return states !== undefined && Object.values(states).includes("cold");
  };

  const coverageBaselineAvailable = [...timelines.keys()].some(
    isCoverageDebtMetric,
  );

  // Apply baseline overrides from merged PRs
  if (overridesBySha.size > 0) {
    console.log(
      `Found ${overridesBySha.size} coverage baseline override(s) from merged PRs.`,
    );
    applyBaselineOverrides(timelines, overridesBySha);
  }

  // 5. Compare the current run's coverage debt against the ratchet baseline.

  const baselineByMetric = await selectBaselines({
    metrics: currentMetrics.keys(),
    timelines,
    isRunCold,
    isPullRequest: prNumber !== null,
    guard: (description, operation) =>
      githubApiOrSkip(description, operation, currentMetrics),
  });

  const { rows, failures, ungatedGroups } = buildCoverageRows({
    currentMetrics,
    timelines,
    baselineByMetric,
    overrides: prOverrides,
    changedCoverageGroups,
  });

  reportUngatedGroups(ungatedGroups);

  // 6. Report results

  // 6a. Prominent failure callout up top, so it's unmissable.
  if (failures.length > 0) {
    console.log(
      "\n!!!" +
        `\n!!! COVERAGE DEBT REGRESSION in ${failures.length} source group(s) !!!` +
        "\n!!!",
    );
  }

  // 6b. Cold compile cache note. A cold run covers cold-compile-only branches,
  // so it is recorded cold and a later PR's coverage ratchet skips it as a
  // baseline in favour of the nearest warm ancestor of its base-branch commit.
  const coldFamilies = COMPILE_CACHE_FAMILIES.filter(
    (family) => currentCacheStates[family] === "cold",
  );
  if (coldFamilies.length > 0) {
    console.log("\n## Cold compile cache");
    console.log(
      `The pattern compile byte cache missed for: ${coldFamilies.join(", ")}.`,
    );
    console.log(
      "This run is recorded cold. A cold run covers cold-compile-only branches,",
    );
    console.log(
      "so a later PR's coverage ratchet skips it for the nearest warm ancestor",
    );
    console.log(
      "instead — otherwise warm PRs would be held to a stricter, unreachable bar.",
    );
  }

  // 6c. Full coverage-debt table.
  console.log(
    "\n::group::All coverage debt metrics:\n" +
      "Ratchet: for a source group the PR changed, uncovered lines must not rise\n" +
      "above the count from the main run for the base-branch commit this run\n" +
      "merged, or the nearest ancestor of it that has one.\n" +
      "Status key: OVER = above baseline (fails); OK = at or below baseline;\n" +
      "  ovrd = accepted by a PR override/reset; excl = not gated for this PR;\n" +
      "  n/a = no baseline yet and no new uncovered lines.",
  );
  // Sort order: most at-risk of failing first. `ovrd` sits below `OK` because
  // an override-protected metric is at strictly lower risk than an unguarded OK
  // metric — the author has already authorized its current level.
  const STATUS_ORDER: Record<Status, number> = {
    OVER: 4,
    OK: 3,
    ovrd: 2,
    excl: 1,
    "n/a": 0,
  };

  const counts = {
    OVER: 0,
    OK: 0,
    ovrd: 0,
    excl: 0,
    "n/a": 0,
  } as Record<Status, number>;
  for (const r of rows) counts[r.status]++;

  console.log(
    `\n## Coverage debt metrics  (${rows.length} total — OVER: ${counts.OVER}, OK: ${counts.OK}, ovrd: ${counts.ovrd}, excl: ${counts.excl}, n/a: ${
      counts["n/a"]
    })`,
  );

  const sortedRows = [...rows].sort((a, b) => {
    const s = STATUS_ORDER[b.status] - STATUS_ORDER[a.status];
    if (s !== 0) return s;
    return (b.pctIncrease ?? -Infinity) - (a.pctIncrease ?? -Infinity);
  });
  printMetricTable(sortedRows, true);

  console.log("::endgroup::");

  // 6d. Failure detail.
  if (failures.length > 0) {
    failures.sort((a, b) => (b.pctIncrease ?? 0) - (a.pctIncrease ?? 0));

    console.log("\n## Coverage debt regression details:\n");
    printMetricTable(failures);
  }

  // 6e. Pass/fail outcome + acceptance copy-paste block pinned at the bottom.
  if (informationalOnly) {
    console.log("\nInformational Only:");
  }

  // Coverage-debt PR comment, written for the coverage-comment workflow to post
  // (fork PRs get a read-only token on pull_request and cannot comment here).
  // Done before the exit branches so it runs whether the run passes or fails for
  // other reasons.
  if (prNumber) {
    await writeCoverageComment(
      parseInt(prNumber),
      failures,
      rows,
      prFiles,
      coverageLcov,
    );
  }

  if (failures.length === 0) {
    console.log("\nCoverage debt within the ratchet for every changed group.");
    Deno.exit(0);
  } else if (informationalOnly) {
    console.log("\nOne or more changed groups regressed coverage debt.");
    console.log("This build would fail if it were a PR.");
    Deno.exit(0);
  }

  const verb = coverageBaselineAvailable ? "reset" : "bootstrap";
  console.log(
    `\nTo ${verb} the coverage ratchet for one cycle, add ${COVERAGE_BASELINE_RESET_MARKER} to your PR description.`,
  );
  console.log(
    "\nTo accept these coverage regressions one metric at a time, add the following to your PR description:\n",
  );
  console.log("---BEGIN COPY-PASTE---");
  for (const f of failures) {
    const suggested = formatOverrideSuggestion(f.current);
    console.log(`ACCEPT_COVERAGE_DEBT: ${f.metric} = ${suggested}`);
  }
  console.log("---END COPY-PASTE---");

  Deno.exit(1);
}

if (import.meta.main) {
  main();
}
