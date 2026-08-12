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
  acceptsCoverageDebt,
  aggregateCacheStates,
  type Artifact,
  type BaselineOverrides,
  type BaselineSample,
  buildCoverageDebtSuggestionComment,
  buildCoverageDebtUnattributedComment,
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
  type CoverageUnattributedFile,
  downloadAndExtractArtifact,
  downloadAndParseCoverageBaseline,
  fetchArtifactsForRun,
  fetchCurrentPRBody,
  fetchPRFiles,
  formatOverrideSuggestion,
  githubGet,
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
  WORKFLOW_FILE,
  type WorkflowRun,
  writeCoverageBaselineFile,
} from "./ci-check-lib.ts";
import {
  fillMissingFamiliesFromFingerprint,
  inferCurrentRunFallbackState,
} from "./compile-cache-state.ts";
import { walk } from "@std/fs/walk";
import * as path from "@std/path";
import {
  collectCoverageDebtMetricsFromLcov,
  collectRegressedLines,
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

/**
 * The perf-metrics artifact this run publishes: its coverage metrics, and the
 * compile cache states that stamp them. A later run reads the stamp to decide
 * whether this run was cold, so every path that writes the artifact writes
 * both halves.
 */
export interface PerfMetricsArtifact {
  metrics: Map<string, BaselineSample>;
  compileCacheStates?: CompileCacheStates;
}

/** Writes the artifact to {@link PERF_METRICS_FILE}, and says so. */
async function writePerfMetricsArtifact(
  artifact: PerfMetricsArtifact,
): Promise<void> {
  await writeCoverageBaselineFile(
    PERF_METRICS_FILE,
    artifact.metrics,
    artifact.compileCacheStates,
  );
  console.log(
    `Wrote ${PERF_METRICS_FILE} with ${artifact.metrics.size} metrics.`,
  );
}

export async function githubApiOrSkip<T>(
  description: string,
  operation: () => Promise<T>,
  artifact: PerfMetricsArtifact,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!isGitHubRateLimitError(error)) throw error;

    console.warn(
      `  Warning: GitHub API rate limit while ${description}: ${error}`,
    );
    await writePerfMetricsArtifact(artifact);
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

/** One baseline run, as much of it as choosing a baseline needs. */
export interface BaselineRunReading {
  /** The run's uncovered-line count per metric, from its baseline artifact. */
  samples: Map<string, BaselineSample>;
  /** What the run's merged pull request accepted, when it has one. */
  overrides: BaselineOverrides | null;
  /** True when the run compiled patterns from scratch. */
  cold: boolean;
}

export interface WalkBaselineRunsOptions {
  /**
   * The metrics to find a baseline for. An array rather than any iterable,
   * because a one-shot iterator would leave a second pass over it empty.
   */
  metrics: readonly string[];
  /** Recent `main` runs, newest first. */
  runs: WorkflowRun[];
  /** Reads one run. Called only for the runs the walk reaches. */
  readRun: (run: WorkflowRun) => Promise<BaselineRunReading>;
  /**
   * How far back from the base-branch commit this run merged each recent commit
   * sits, or null when there is no base-branch commit to measure against.
   */
  ancestorRank: Map<string, number> | null;
}

/**
 * Chooses every metric's ratchet baseline: the `main` run for the nearest
 * ancestor of the base-branch commit this run merged.
 *
 * The base-branch commit's own run is the ideal baseline, because it measured
 * exactly the base-branch code this run merged, leaving the pull request as the
 * only difference between the two numbers. It is often available, but a run
 * still going or one that failed leaves the nearest ancestor with a usable run
 * standing in for it. Whatever the base branch changed in between is then in
 * this run and not in the baseline, so `isComparableBaseline()` withholds
 * gating from the groups it touched. A run for a commit that is not an ancestor
 * is never a baseline: it landed after this run started, so it measured code
 * this run does not contain.
 *
 * A non-cold run wins: a cold run covers cold-compile-only branches, and its
 * lower debt would hold a warm pull request to an unreachable bar. When every
 * ancestor is cold the nearest one stands, so a metric never loses its baseline
 * to coldness alone.
 *
 * A merged pull request that accepted a metric's debt, with a per-metric
 * acceptance or the whole-coverage reset marker, sets the floor: its own run is
 * the oldest baseline the ratchet may reach for that metric, so the accepted
 * level is what later runs are held to and nothing older undoes it. Only a run
 * that both carries the acceptance and measured the metric stops the walk —
 * an acceptance whose run uploaded no baseline artifact leaves the search to
 * continue past it. An acceptance that merged onto a commit this run does not
 * contain sets no floor here, for the same reason such a run is no baseline.
 *
 * Runs are read one at a time in the order `baselineWalkOrder()` gives, and the
 * walk stops as soon as every metric has its baseline, so a run that measured
 * every metric is the only one read.
 */
export async function walkBaselineRuns(
  options: WalkBaselineRunsOptions,
): Promise<Map<string, BaselineSample>> {
  const pending = new Set(options.metrics);
  const chosen = new Map<string, BaselineSample>();
  const coldFallback = new Map<string, BaselineSample>();

  for (const run of baselineWalkOrder(options.runs, options.ancestorRank)) {
    if (pending.size === 0) break;

    const reading = await options.readRun(run);

    for (const metric of [...pending]) {
      const sample = reading.samples.get(metric);
      if (sample === undefined) continue;

      if (!reading.cold) {
        chosen.set(metric, sample);
        pending.delete(metric);
        continue;
      }
      if (!coldFallback.has(metric)) coldFallback.set(metric, sample);

      if (reading.overrides && acceptsCoverageDebt(reading.overrides, metric)) {
        pending.delete(metric);
      }
    }
  }

  for (const [metric, sample] of coldFallback) {
    if (!chosen.has(metric)) chosen.set(metric, sample);
  }
  return chosen;
}

/**
 * The order the walk reads runs in: the run for the base-branch commit itself
 * first, then its ancestors from nearest to furthest, and runs whose commit is
 * not an ancestor left out entirely. Two runs for one commit read oldest first,
 * matching how a ranked search settles that tie.
 *
 * Ranking rather than trusting the order the runs arrive in matters because the
 * walk takes the first answer it finds and stops. Run creation follows the push
 * order that ancestry describes, but not through a history rewrite, and not
 * across two pushes that land in the same second.
 *
 * Without an ancestry to rank against — a `main` push run, a checkout that is
 * not a merge, or a commit listing that could not be fetched — the runs stand
 * as given, newest first, and the newest usable one wins.
 */
function baselineWalkOrder(
  runs: WorkflowRun[],
  ancestorRank: Map<string, number> | null,
): WorkflowRun[] {
  if (ancestorRank === null) return runs;

  return runs
    .filter((run) => ancestorRank.has(run.head_sha))
    .sort((a, b) =>
      ancestorRank.get(a.head_sha)! - ancestorRank.get(b.head_sha)! ||
      a.created_at.localeCompare(b.created_at) ||
      a.id - b.id
    );
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
    sample: BaselineSample | undefined;
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
  sample?: BaselineSample;
  /** Whether the ratchet may fail this metric against that sample. */
  comparable: boolean;
}

export interface SelectBaselinesOptions {
  /** The metrics to gate; an array, as in {@link WalkBaselineRunsOptions}. */
  metrics: readonly string[];
  /** Recent `main` runs, newest first. */
  runs: WorkflowRun[];
  /** Reads one baseline run; called only for the runs the walk reaches. */
  readRun: (run: WorkflowRun) => Promise<BaselineRunReading>;
  isPullRequest: boolean;
  readBaseSha?: () => Promise<string | null>;
  fetchRanks?: (baseSha: string) => Promise<Map<string, number>>;
  fetchChangedGroups?: (
    baselineSha: string,
    baseSha: string,
  ) => Promise<Set<string>>;
  /** Wraps the GitHub calls made here so a rate limit skips the check. */
  guard?: <T>(description: string, operation: () => Promise<T>) => Promise<T>;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

/**
 * Chooses every metric's ratchet baseline against the base-branch commit this
 * run merged, and reports what it chose.
 *
 * Reads the base-branch commit, ranks its ancestry, walks the recent `main`
 * runs for each metric's baseline, and asks which coverage groups the base
 * branch moved since each baseline the walk picked.
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

  const baselines = await walkBaselineRuns({
    metrics: options.metrics,
    runs: options.runs,
    readRun: options.readRun,
    ancestorRank,
  });

  const groupsChangedByBaseline = new Map<string, Set<string>>();
  if (baseSha !== null) {
    const baselineShas = new Set(
      [...baselines.values()].map((sample) => sample.sha),
    );
    for (const sha of baselineShas) {
      groupsChangedByBaseline.set(
        sha,
        await guard(
          "comparing the baseline commit against the base-branch commit",
          () => fetchChangedGroups(sha, baseSha),
        ),
      );
    }
    reportBaselineDistance(baselineShas, baseSha, ancestorRank, log);
  }

  const resolved = new Map<string, MetricBaseline>();
  for (const metric of options.metrics) {
    const sample = baselines.get(metric);
    resolved.set(metric, {
      sample,
      comparable: isComparableBaseline({
        sample,
        metric,
        baseSha,
        groupsChangedByBaseline,
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
  artifact: PerfMetricsArtifact,
  baselineRunCount = BASELINE_RUNS,
  log: (message: string) => void = console.log,
): Promise<{ mainHeadSha: string; baselineRuns: WorkflowRun[] }> {
  log("Fetching current main branch head...");
  const mainHeadSha = await githubApiOrSkip(
    "fetching current main branch head",
    () => fetchMainHeadSha(),
    artifact,
  );
  log(`Current main head is ${mainHeadSha}.`);
  log("Fetching recent main-branch runs for baseline...");
  const baselineData = await githubApiOrSkip(
    "fetching recent main-branch runs for baseline",
    () =>
      githubGet<{ workflow_runs: WorkflowRun[] }>(
        workflowRunsPathForBaseline(baselineRunCount),
      ),
    artifact,
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

export interface BuildBaselineRunContextOptions {
  run: WorkflowRun;
  fetchArtifactsForRun?: (run: WorkflowRun) => Promise<Artifact[]>;
  fetchPRForCommit?: (sha: string) => Promise<PRLookupResult>;
}

/** Reads everything one baseline run contributes: its artifacts and its PR. */
export async function buildBaselineRunContext(
  options: BuildBaselineRunContextOptions,
): Promise<BaselineRunContext> {
  const fetchArtifacts = options.fetchArtifactsForRun ??
    fetchArtifactsForRunBestEffort;
  const fetchPR = options.fetchPRForCommit ?? fetchPRForCommitWithError;

  const [artifacts, prLookup] = await Promise.all([
    fetchArtifacts(options.run),
    fetchPR(options.run.head_sha),
  ]);
  return {
    run: options.run,
    artifacts,
    pr: prLookup.pr,
    prLookupError: prLookup.error,
  };
}

/**
 * Logs one line per baseline run: when it ran, the commit it measured, the
 * pull request that merged that commit, and whether it carries a perf-metrics
 * artifact. Names each run whose pull-request lookup failed a second time
 * after the group, with the error.
 */
export function reportBaselineContextResults(
  contexts: BaselineRunContext[],
): void {
  console.log("\n::group::Baseline source runs:\n");
  for (const { run, artifacts, pr, prLookupError } of contexts) {
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
    console.log(
      `  ${run.created_at} run ${run.id} ${run.head_sha.slice(0, 8)} ` +
        `${prLabel}; ${artifactLabel}`,
    );
  }
  console.log("\n::endgroup::\n");

  // The gate reads accepted coverage debt out of the merged pull request body,
  // so a run whose lookup failed contributes no overrides.
  for (const { run, prLookupError } of contexts) {
    if (!prLookupError) continue;
    console.warn(
      `  Warning: run ${run.id} (${
        run.head_sha.slice(0, 8)
      }) PR lookup failed: ${formatErrorForLog(prLookupError)}`,
    );
  }
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
    for await (
      const entry of walk(tmpDir, { includeDirs: false, exts: [".json"] })
    ) {
      contents.push(await Deno.readTextFile(entry.path));
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
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((shard) =>
    `coverage-profile-workspace-${shard}`
  ),
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((shard) =>
    `coverage-profile-runner-${shard}`
  ),
  ...[1, 2, 3].map((shard) => `coverage-profile-generated-patterns-${shard}`),
  "coverage-profile-package-runner",
  "coverage-profile-package-runtime-client",
  "coverage-profile-package-shell",
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((shard) =>
    `coverage-profile-pattern-integration-${shard}`
  ),
  "coverage-profile-pattern-reload",
  ...[1, 2, 3, 4, 5].map((chunk) => `coverage-profile-pattern-unit-${chunk}`),
];

function sampleForRun(
  run: WorkflowRun,
  uncoveredLines: number,
): BaselineSample {
  return {
    runId: run.id,
    sha: run.head_sha,
    createdAt: run.created_at,
    uncoveredLines,
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
    for await (
      const entry of walk(sourceDir, {
        includeDirs: false,
        exts: [".json", ".lcov"],
      })
    ) {
      const isLcov = entry.path.endsWith(".lcov");
      const count = isLcov ? lcovFiles : profileFiles;
      const destDir = isLcov ? lcovDir : profileDir;
      const dest = path.join(
        destDir,
        `${artifact.id}-${count}-${path.basename(entry.path)}`,
      );
      await Deno.copyFile(entry.path, dest);
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
  for await (
    const entry of walk(lcovDir, { includeDirs: false, exts: [".lcov"] })
  ) {
    chunks.push(await Deno.readTextFile(entry.path));
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
  if (row.baseline === undefined || row.pctIncrease === undefined) return "-";

  const delta = row.current - row.baseline;
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

export interface Row {
  metric: string;
  status: Status;
  current: number;
  /** Uncovered lines the chosen `main` run measured for this metric. */
  baseline?: number;
  /** Head SHA of the run that baseline came from. */
  baselineSha?: string;
  /** Id of the run that baseline came from. */
  baselineRunId?: number;
  pctIncrease?: number;
}

export function metricTableRows(
  rows: Row[],
  includeStatus: boolean,
): string[][] {
  return rows.map((row) => {
    const cells = [
      formatMetricValueForTable(row.baseline),
      formatMetricValueForTable(row.current),
      formatMetricDelta(row),
      coverageMetricGroupName(row.metric) ?? row.metric,
    ];
    return includeStatus ? [row.status, ...cells] : cells;
  });
}

export interface BuildCoverageRowsOptions {
  currentMetrics: Map<string, BaselineSample>;
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
    const current = currentSample.uncoveredLines;
    const resolvedBaseline = options.baselineByMetric.get(metric);
    const baselineSample = resolvedBaseline?.sample;
    const latestBaseline = baselineSample?.uncoveredLines;
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
        rows.push({ metric, status: "ovrd", current });
      } else if (!shouldGateCoverage) {
        rows.push({ metric, status: "excl", current });
      } else if (current > 0) {
        const row: Row = {
          metric,
          status: "OVER",
          current,
          baseline: 0,
          pctIncrease: 100,
        };
        rows.push(row);
        failures.push(row);
      } else {
        rows.push({ metric, status: "n/a", current });
      }
      continue;
    }

    const pctIncrease = latestBaseline === 0
      ? current > 0 ? 100 : 0
      : ((current - latestBaseline) / latestBaseline) * 100;
    const stats = {
      baseline: latestBaseline,
      baselineSha: baselineSample?.sha,
      baselineRunId: baselineSample?.runId,
      pctIncrease,
    };

    if (coverageReset) {
      rows.push({ metric, status: "ovrd", current, ...stats });
      continue;
    }

    if (override !== undefined && current <= override) {
      rows.push({ metric, status: "ovrd", current, ...stats });
      continue;
    }

    if (!shouldGateCoverage) {
      rows.push({ metric, status: "excl", current, ...stats });
      continue;
    }

    if (current > latestBaseline) {
      const row: Row = { metric, status: "OVER", current, ...stats };
      rows.push(row);
      failures.push(row);
    } else {
      rows.push({ metric, status: "OK", current, ...stats });
    }
  }

  return { rows, failures, ungatedGroups };
}

export function printMetricTable(rows: Row[], includeStatus = false): void {
  const headers = includeStatus
    ? ["Status", "Baseline", "Current", "Change", "Group"]
    : ["Baseline", "Current", "Change", "Group"];
  const align = includeStatus
    ? ["left", "right", "right", "right", "left"] as TableAlign[]
    : ["right", "right", "right", "left"] as TableAlign[];
  printTextTable(headers, metricTableRows(rows, includeStatus), align);
}

/** The coverage-profile artifacts of one run, one per artifact name. */
function coverageProfileArtifacts(artifacts: Artifact[]): Artifact[] {
  return newestArtifactsByName(artifacts.filter(
    (artifact) =>
      artifact.name.startsWith(COVERAGE_PROFILE_ARTIFACT_PREFIX) &&
      !artifact.expired,
  ));
}

/**
 * Join one run's coverage-profile artifacts into a single LCOV report. A job
 * uploads its own LCOV; the profile-file branch reads the raw V8 profiles a
 * run predating that upload carries.
 */
export async function combinedLcovFromArtifacts(
  coverageArtifacts: Artifact[],
  coverageArtifactsDir?: string,
): Promise<{ lcov: string; sourceDescription: string }> {
  const profileDir = await Deno.makeTempDir({ prefix: "coverage-profiles-" });
  const lcovDir = await Deno.makeTempDir({ prefix: "coverage-lcov-" });
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

    return {
      lcov: lcovFileCount > 0
        ? await readCombinedLcov(lcovDir)
        : await lcovFromCoverageProfile(profileDir),
      sourceDescription: lcovFileCount > 0
        ? `${lcovFileCount} LCOV report files`
        : `${profileFileCount} coverage profile files`,
    };
  } finally {
    try {
      await Deno.remove(profileDir, { recursive: true });
    } catch { /* ignore cleanup errors */ }
    try {
      await Deno.remove(lcovDir, { recursive: true });
    } catch { /* ignore cleanup errors */ }
  }
}

async function extractCoverageDebtSamples(
  run: WorkflowRun,
  artifacts: Artifact[],
  coverageArtifactsDir?: string,
): Promise<{ samples: Map<string, BaselineSample>; lcov: string }> {
  const metrics = new Map<string, BaselineSample>();
  const coverageArtifacts = coverageProfileArtifacts(artifacts);
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

  const { lcov, sourceDescription } = await combinedLcovFromArtifacts(
    coverageArtifacts,
    coverageArtifactsDir,
  );

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
    `Extracted ${coverageMetrics.length} coverage debt metrics from ${sourceDescription}.`,
  );

  return { samples: metrics, lcov };
}

/**
 * Join the coverage-profile artifacts of a `main` run into one LCOV report.
 * Returns null when the run has none, or when the download fails: the comment
 * this feeds is best-effort, and a regression is reported either way.
 */
export async function baselineLcovForRun(
  runId: number,
  fetchArtifacts: (runId: number) => Promise<Artifact[]> = fetchArtifactsForRun,
): Promise<string | null> {
  try {
    const artifacts = coverageProfileArtifacts(await fetchArtifacts(runId));
    if (artifacts.length === 0) {
      console.warn(
        `  Warning: baseline run ${runId} has no coverage profile artifacts.`,
      );
      return null;
    }
    const { lcov } = await combinedLcovFromArtifacts(artifacts);
    return lcov;
  } catch (error) {
    console.warn(
      `  Warning: could not read coverage from baseline run ${runId}: ${error}`,
    );
    return null;
  }
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
 * Build the body naming the lines a regression the pull request did not cause
 * is charged for: lines this run leaves uncovered in files the pull request
 * never touched, which the baseline run covered.
 *
 * Returns null when there is nothing to say — no baseline run to compare
 * against, its coverage cannot be read, or every affected line is in a file the
 * pull request changed — and the caller falls back to the ordinary comment.
 */
export interface UnattributedRegressionOptions {
  rootDir: string;
  groups: CoverageSuggestionGroup[];
  coverageFailures: Row[];
  prFiles: PRFile[];
  /** LCOV from this run. */
  lcov: string;
  readBaselineLcov: (runId: number) => Promise<string | null>;
}

export async function buildUnattributedRegressionBody(
  options: UnattributedRegressionOptions,
): Promise<string | null> {
  const baselineRunIds = new Set(
    options.coverageFailures
      .map((failure) => failure.baselineRunId)
      .filter((runId): runId is number => runId !== undefined),
  );
  if (baselineRunIds.size === 0) return null;

  const changedFiles = new Set(
    options.prFiles.map((prFile) => prFile.filename.replaceAll("\\", "/")),
  );
  const failingGroups = new Set(options.groups.map((group) => group.group));

  // One regressed group is the common case, and every group then shares a
  // baseline run. Several groups can resolve to different runs, so each run's
  // report is compared and the results joined.
  const files: CoverageUnattributedFile[] = [];
  for (const runId of baselineRunIds) {
    const baselineLcov = await options.readBaselineLcov(runId);
    if (baselineLcov === null) continue;
    const regressed = await collectRegressedLines({
      rootDir: options.rootDir,
      lcov: options.lcov,
      baselineLcov,
      groups: failingGroups,
      changedFiles,
    });
    for (const file of regressed) {
      files.push({ relativePath: file.relativePath, lines: file.lines });
    }
  }

  if (files.length === 0) return null;

  const total = files.reduce((sum, file) => sum + file.lines.length, 0);
  console.log(
    `Regression not attributable to this PR's added lines: ${total} line(s) ` +
      `across ${files.length} unchanged file(s) that the baseline run covered.`,
  );
  return buildCoverageDebtUnattributedComment({
    groups: options.groups,
    files,
  });
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
  readBaselineLcov: (runId: number) => Promise<string | null> =
    baselineLcovForRun,
): Promise<void> {
  const groups = coverageFailures
    .map((failure) => ({
      group: coverageMetricGroupName(failure.metric),
      target: Math.round(failure.baseline ?? 0),
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
    // Nothing the pull request added accounts for the regression, so the lines
    // it is charged for are somewhere it did not touch. Say which ones by
    // comparing this run against the baseline run line by line.
    const unattributed = files.length === 0
      ? await buildUnattributedRegressionBody({
        rootDir: Deno.cwd(),
        groups,
        coverageFailures,
        prFiles,
        lcov,
        readBaselineLcov,
      })
      : null;
    const body = unattributed ??
      buildCoverageDebtSuggestionComment({ groups, files });
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
    if (row.status !== "OK" || row.baseline === undefined) return sum;
    return sum + Math.max(0, Math.round(row.baseline - row.current));
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
      baseline: Math.round(row.baseline ?? 0),
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
  const currentMetrics = new Map<string, BaselineSample>();

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

  // Both halves of the artifact travel together from here on: every GitHub
  // call is wrapped so a rate limit writes this same stamped payload before
  // skipping the check. `metrics` and `compileCacheStates` are the live
  // objects, so later additions to either are picked up.
  const perfArtifact: PerfMetricsArtifact = {
    metrics: currentMetrics,
    compileCacheStates: currentCacheStates,
  };

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

  await writePerfMetricsArtifact(perfArtifact);

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
    perfArtifact,
  );
  reportBaselineRunAvailability(baselineRuns, mainHeadSha);

  console.log(
    `Scanning up to ${baselineRuns.length} main-branch runs for the baseline.`,
  );

  // 4. Read recent main runs, newest first, until every metric has a ratchet
  // baseline. A run's artifacts, compile cache state and merged-PR acceptances
  // are fetched only when the walk reaches it, so a run whose newest baseline
  // serves every metric reads one run rather than all of them.
  const runsNewestFirst = [...baselineRuns].sort((a, b) =>
    b.created_at.localeCompare(a.created_at) || b.id - a.id
  );

  // Compile cache states per baseline run, from tagged perf-metrics
  // artifacts. A run whose artifact is missing or carries no stamp stays
  // absent, which the ratchet reads as not-cold.
  const cacheStatesByRunId = new Map<number, CompileCacheStates>();
  const isRunCold = (runId: number): boolean => {
    const states = cacheStatesByRunId.get(runId);
    return states !== undefined && Object.values(states).includes("cold");
  };

  // What the walk read, for the diagnostics below.
  const visitedContexts: BaselineRunContext[] = [];
  let acceptingRuns = 0;

  const readBaselineRun = (run: WorkflowRun): Promise<BaselineRunReading> =>
    githubApiOrSkip("reading a baseline run", async () => {
      const context = await buildBaselineRunContext({ run });
      visitedContexts.push(context);

      const baseline = await parseCoverageBaselineFromArtifacts(
        context.artifacts,
      );
      if (baseline?.compileCacheStates) {
        cacheStatesByRunId.set(run.id, baseline.compileCacheStates);
      }

      const overrides = context.pr
        ? parseMergedBaselineOverrides(context.pr)
        : null;
      if (
        overrides &&
        (overrides.metrics.size > 0 || overrides.coverageBaselineReset)
      ) {
        acceptingRuns++;
      }

      return {
        samples: baseline?.metrics ?? new Map(),
        overrides,
        cold: isRunCold(run.id),
      };
    }, perfArtifact);

  // 5. Compare the current run's coverage debt against the ratchet baseline.

  // Reported in `finally` so a baseline run that could not be read still says
  // which runs it got to before it gave up.
  const baselineByMetric = await selectBaselines({
    metrics: [...currentMetrics.keys()],
    runs: runsNewestFirst,
    readRun: readBaselineRun,
    isPullRequest: prNumber !== null,
    guard: (description, operation) =>
      githubApiOrSkip(description, operation, perfArtifact),
  }).finally(() => reportBaselineContextResults(visitedContexts));

  if (acceptingRuns > 0) {
    console.log(
      `Found ${acceptingRuns} coverage baseline override(s) from merged PRs.`,
    );
  }

  const coverageBaselineAvailable = [...baselineByMetric.values()].some(
    (baseline) => baseline.sample !== undefined,
  );

  const { rows, failures, ungatedGroups } = buildCoverageRows({
    currentMetrics,
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
