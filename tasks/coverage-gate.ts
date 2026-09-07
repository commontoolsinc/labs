#!/usr/bin/env -S deno run -A

/**
 * The per-package coverage gate, joined and scored where the lanes meet.
 *
 * Each lane converts the coverage it produced into one report per
 * producer and uploads it. This adds the lanes' reports together, scores
 * every covered package the change touched, and fails when a package's
 * own tests leave more of that package untested than they did on the
 * default branch.
 *
 * Both sides of that comparison run the same complete set of tests over
 * the same package, so selection cannot skew it: within a covered package
 * nothing is selected. That is the whole of the argument, and it is why
 * this gate keeps its teeth where the repository-wide one gives them up.
 *
 * Which packages the gate covers is decided here rather than taken from
 * what a lane reported, over the same diff and the same rules, so a lane
 * cannot talk this into gating something or into skipping something.
 */

import * as path from "@std/path";
import { walk } from "@std/fs/walk";
import {
  type Artifact,
  COVERAGE_BASELINE_RESET_MARKER,
  COVERAGE_COMMENT_FILE,
  type CoverageCommentPayload,
  coverageMetricForGroup,
  type CoverageResolvedGroup,
  downloadAndExtractArtifact,
  fetchArtifactsForRun,
  githubGet,
  newestArtifactsByName,
  parseBaselineOverrides,
  parseCoverageBaselineDetailed,
  PERF_METRICS_ARTIFACT_NAME,
  PERF_METRICS_FILE,
  REPO,
  WORKFLOW_FILE,
  type WorkflowRun,
} from "./ci-check-lib.ts";
import {
  collectCoverageDebtMetricsFromLcov,
  COVERAGE_METRIC_PREFIX,
} from "./coverage-metrics.ts";
import {
  coverageGate,
  memberSlug,
  UNIT_SUITES,
} from "./test-selection/coverage.ts";
import { LOCAL_COVERAGE_BASELINE_DAYS } from "./test-selection/policy.ts";
import { readWorkspaceMembers } from "./workspace-tests.ts";

/**
 * The series a covered package's own-tests figure is kept under.
 *
 * Deliberately not the `coverage-debt:` series of the same name. That one
 * sums every job in the repository that loads the package's files, and
 * this one counts what the package's own tests reached; the two are
 * different quantities, and distinct names are what stop anything
 * comparing them.
 */
export const OWN_COVERAGE_METRIC_PREFIX = "coverage-own:";

/** The metric one member's own-tests uncovered lines are counted in. */
export function ownCoverageMetric(member: string): string {
  return `${OWN_COVERAGE_METRIC_PREFIX} ${member} uncovered lines`;
}

/**
 * Every per-producer report a run's lanes uploaded, joined by producer.
 *
 * A member's tests are spread across the lanes like any other mandatory
 * items, so a package's report arrives in pieces. LCOV consumers
 * accumulate records, so joining the pieces is concatenation: a line is
 * covered when any lane's report says it ran.
 */
export async function memberReports(
  artifactsDir: string,
): Promise<Map<string, string>> {
  const joined = new Map<string, string>();
  try {
    for await (
      const entry of walk(artifactsDir, {
        includeDirs: false,
        exts: [".lcov"],
      })
    ) {
      const suite = path.basename(path.dirname(entry.path));
      if (!UNIT_SUITES.includes(suite)) continue;
      const slug = path.basename(entry.path, ".lcov");
      const text = await Deno.readTextFile(entry.path);
      joined.set(slug, `${joined.get(slug) ?? ""}${text}`);
    }
  } catch (error) {
    // A run that measured nothing downloaded nothing, so there is no
    // directory to walk. That is a run with no figures rather than an
    // error, and the gate reports every package it could not score.
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return joined;
}

/** What one covered package's own tests left untested. */
export async function ownUncoveredLines(
  root: string,
  member: string,
  lcov: string,
): Promise<number> {
  const metrics = await collectCoverageDebtMetricsFromLcov({
    rootDir: root,
    lcov,
    within: member,
  });
  // The whole of what `within` left is this member's own figure; the
  // per-group rows underneath it are the same lines counted again. It is
  // named rather than taken by position, so a row added ahead of it does
  // not silently become the number this gates on.
  const whole = `${COVERAGE_METRIC_PREFIX} workspace uncovered lines`;
  const total = metrics.find((metric) => metric.name === whole);
  if (total === undefined) {
    throw new Error(
      `scoring ${member} produced no total, so there is nothing to gate on`,
    );
  }
  return total.uncoveredLines;
}

/** Each covered member's own-tests figure, from a run's uploaded reports. */
export async function ownCoverageMetrics(
  root: string,
  artifactsDir: string,
  members: readonly string[],
): Promise<Map<string, number>> {
  const reports = await memberReports(artifactsDir);
  const figures = new Map<string, number>();
  for (const member of members) {
    const lcov = reports.get(memberSlug(member));
    // A member with no report measured nothing, which is a different
    // thing from measuring zero uncovered lines, so it gets no figure
    // rather than a figure of none.
    if (lcov === undefined) continue;
    figures.set(member, await ownUncoveredLines(root, member, lcov));
  }
  return figures;
}

/** Whether `sha` is an ancestor of the commit the checkout holds. */
export async function isAncestor(root: string, sha: string): Promise<boolean> {
  const result = await new Deno.Command("git", {
    args: ["merge-base", "--is-ancestor", sha, "HEAD"],
    cwd: root,
    stdout: "null",
    stderr: "null",
  }).output();
  return result.success;
}

/** The runs on the default branch a baseline may come from, newest first. */
export async function baselineRuns(
  days: number = LOCAL_COVERAGE_BASELINE_DAYS,
): Promise<WorkflowRun[]> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const runs = await githubGet<{ workflow_runs: WorkflowRun[] }>(
    `/repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/runs` +
      `?branch=main&event=push&status=success&per_page=50`,
  );
  return runs.workflow_runs
    .filter((run) => run.created_at >= since)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/** One covered package's baseline: what it left untested, and where. */
export interface Baseline {
  uncoveredLines: number;
  sha: string;
  runId: number;
}

/**
 * The nearest ancestor run that measured each member.
 *
 * An ancestor rather than the newest run, because a rise measured against
 * a tree the branch does not contain is not the branch's rise. A member
 * with no ancestor run that measured it has no baseline, and the gate
 * reports it rather than charging the branch for the whole of a package
 * nobody has measured yet.
 */
export async function baselinesFor(
  root: string,
  members: readonly string[],
  runs: readonly WorkflowRun[],
  read: (run: WorkflowRun) => Promise<Map<string, number>> = readOwnMetrics,
  ancestor: (sha: string) => Promise<boolean> = (sha) => isAncestor(root, sha),
): Promise<Map<string, Baseline>> {
  const found = new Map<string, Baseline>();
  for (const run of runs) {
    if (found.size === members.length) break;
    if (!await ancestor(run.head_sha)) continue;
    const metrics = await read(run);
    for (const member of members) {
      if (found.has(member)) continue;
      const uncovered = metrics.get(ownCoverageMetric(member));
      if (uncovered === undefined) continue;
      found.set(member, {
        uncoveredLines: uncovered,
        sha: run.head_sha,
        runId: run.id,
      });
    }
  }
  return found;
}

/**
 * The own-coverage figures one run recorded, from its baseline artifact.
 *
 * A run this cannot read is a run with no figures, which is the same
 * answer as a run that measured none. The two are not the same thing, so
 * the reason is said: a rate limit part way up the ancestors leaves every
 * package reported rather than gated, and "no ancestor measured this" and
 * "I could not read the ancestors" call for different responses.
 */
async function readOwnMetrics(run: WorkflowRun): Promise<Map<string, number>> {
  const unread = (why: unknown): Map<string, number> => {
    console.warn(`  Warning: could not read run ${run.id}: ${why}`);
    return new Map();
  };
  let artifacts: Artifact[];
  try {
    artifacts = newestArtifactsByName(await fetchArtifactsForRun(run.id));
  } catch (error) {
    return unread(error);
  }
  const artifact = artifacts.find((one) =>
    one.name === PERF_METRICS_ARTIFACT_NAME
  );
  // A run with no baseline artifact measured nothing this reads, which is
  // an answer rather than a failure to get one.
  if (artifact === undefined) return new Map();
  const dir = await downloadAndExtractArtifact(artifact.id, "coverage-gate-");
  if (dir === null) return unread(`artifact ${artifact.id} did not download`);
  try {
    const parsed = parseCoverageBaselineDetailed(
      await Deno.readTextFile(path.join(dir, PERF_METRICS_FILE)),
    );
    return new Map(
      [...parsed.metrics].map(([name, sample]) => [
        name,
        sample.uncoveredLines,
      ]),
    );
  } catch (error) {
    return unread(error);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

/** What the gate decided about one covered package. */
export interface Verdict {
  member: string;
  uncoveredLines: number;
  baseline?: Baseline;
  accepted?: number;

  /** Set where the package is reported rather than gated, and why. */
  reported?: string;
}

/** Whether a verdict fails the gate. */
export function failed(verdict: Verdict): boolean {
  if (verdict.reported !== undefined || verdict.baseline === undefined) {
    return false;
  }
  const rise = verdict.uncoveredLines - verdict.baseline.uncoveredLines;
  return rise > (verdict.accepted ?? 0);
}

/** Scores each covered package against its baseline. */
export function score(
  members: readonly string[],
  figures: ReadonlyMap<string, number>,
  baselines: ReadonlyMap<string, Baseline>,
  accepted: ReadonlyMap<string, number>,
  reset: boolean,
): Verdict[] {
  return members.map((member) => {
    const uncovered = figures.get(member);
    if (uncovered === undefined) {
      return {
        member,
        uncoveredLines: 0,
        reported: "this run measured no coverage for it",
      };
    }
    const verdict: Verdict = { member, uncoveredLines: uncovered };
    const baseline = baselines.get(member);
    if (baseline !== undefined && !reset) verdict.baseline = baseline;
    const allowed = accepted.get(coverageMetricForGroup(member));
    if (allowed !== undefined) verdict.accepted = allowed;
    return verdict;
  });
}

/** The gate's report, as the job summary prints it. */
export function report(verdicts: readonly Verdict[]): string[] {
  const lines = ["## Per-package coverage", ""];
  lines.push("| Package | Own tests leave untested | Against | Verdict |");
  lines.push("| --- | --- | --- | --- |");
  for (const verdict of verdicts) {
    const against = verdict.reported !== undefined
      ? verdict.reported
      : verdict.baseline === undefined
      ? "no baseline yet"
      : `${verdict.baseline.uncoveredLines} at ${
        verdict.baseline.sha.slice(0, 9)
      }`;
    const outcome = failed(verdict)
      ? "coverage failure: more of this package is untested than before"
      : verdict.reported !== undefined || verdict.baseline === undefined
      ? "reported, not gated"
      : "within the ratchet";
    lines.push(
      `| ${verdict.member} | ${verdict.uncoveredLines} | ${against} | ` +
        `${outcome} |`,
    );
  }
  const failures = verdicts.filter(failed);
  if (failures.length > 0) {
    lines.push("");
    lines.push(
      "This is a coverage failure rather than a test failure. To accept a " +
        "rise, add a line to the pull request description, flush against " +
        "the left margin:",
    );
    lines.push("");
    lines.push("```text");
    for (const failure of failures) {
      const rise = failure.uncoveredLines -
        (failure.baseline?.uncoveredLines ?? 0);
      lines.push(`ACCEPT_COVERAGE_DEBT: ${failure.member} +${rise} lines`);
    }
    lines.push("```");
  }
  return lines;
}

/**
 * Hands the pull request its own copy of what the gate decided.
 *
 * The gate runs on the `pull_request` event, where a fork's token is
 * read-only, so it cannot comment. It writes the comment here and the
 * reporter workflow posts it from the base-repository context, which is
 * the path the coverage comment has always taken.
 *
 * A run that passed writes the resolved form, so that a comment left by
 * an earlier attempt collapses into a summary rather than standing as a
 * failure the branch has since fixed.
 */
export function commentFor(
  prNumber: number,
  verdicts: readonly Verdict[],
): CoverageCommentPayload | undefined {
  const scored = verdicts.filter((verdict) => verdict.baseline !== undefined);
  if (scored.length === 0) return undefined;
  if (verdicts.some(failed)) {
    return { prNumber, state: "regressed", body: report(verdicts).join("\n") };
  }
  const groups: CoverageResolvedGroup[] = [];
  for (const verdict of verdicts) {
    // `scored` is the verdicts with a baseline, and this is the same
    // filter written so that the baseline is a value rather than a claim
    // about one.
    const baseline = verdict.baseline;
    if (baseline === undefined) continue;
    groups.push({
      group: verdict.member,
      baseline: baseline.uncoveredLines,
      current: verdict.uncoveredLines,
    });
  }
  const improved = groups.reduce(
    (total, group) => total + (group.baseline - group.current),
    0,
  );
  return {
    prNumber,
    state: "resolved",
    improvedLines: improved,
    groups,
    ...(scored.some((verdict) => verdict.accepted !== undefined)
      ? { overridden: true }
      : {}),
  };
}

/** Says something on the job's output and in its summary. */
function say(lines: readonly string[]): void {
  const text = `${lines.join("\n")}\n`;
  console.log(text);
  const summary = Deno.env.get("GITHUB_STEP_SUMMARY");
  if (summary !== undefined && summary.length > 0) {
    Deno.writeTextFileSync(summary, text, { append: true });
  }
}

/** The files this change touched, against the branch it is merging into. */
async function changedFiles(root: string, base: string): Promise<Set<string>> {
  const result = await new Deno.Command("git", {
    args: ["diff", "--name-only", `${base}...HEAD`],
    cwd: root,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    throw new Error(
      `cannot diff against ${base}: ` +
        new TextDecoder().decode(result.stderr).trim(),
    );
  }
  return new Set(
    new TextDecoder().decode(result.stdout).split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
}

/**
 * Runs the gate the way `Status` runs it, and answers with the status it
 * would exit with.
 *
 * A run whose lanes did not all pass reports rather than gates: coverage
 * measured through a failing suite says nothing about whether the change
 * was tested, and the failure is the thing to fix.
 */
export async function main(root: string = Deno.cwd()): Promise<number> {
  const base = Deno.env.get("BASE_REF");
  if (base === undefined || base.length === 0) {
    console.error("BASE_REF is required.");
    return 1;
  }
  const members = await readWorkspaceMembers(path.join(root, "deno.jsonc"));
  const gate = coverageGate(members, await changedFiles(root, base));
  if (gate.off !== undefined) {
    say([`The per-package coverage gate did not run: ${gate.off}.`]);
    return 0;
  }
  if (gate.members.length === 0) {
    say([
      "The change touches no covered package, so there is nothing to " +
      "score.",
    ]);
    return 0;
  }
  if (Deno.env.get("LANES_PASSED") !== "true") {
    say([
      `The per-package coverage gate reports rather than gates ` +
      `${gate.members.join(", ")}: a test in this run failed, and coverage ` +
      `measured through a failing suite says nothing about whether the ` +
      `change was tested.`,
    ]);
    return 0;
  }

  const artifactsDir = Deno.env.get("COVERAGE_ARTIFACTS_DIR") ??
    "coverage-artifacts";
  const figures = await ownCoverageMetrics(root, artifactsDir, gate.members);
  // An acceptance nobody can read is a line whose author meant something,
  // so it fails here rather than being passed over as though it were not
  // there. The message says what form to write instead.
  let overrides;
  try {
    overrides = parseBaselineOverrides(Deno.env.get("PR_BODY") ?? "");
  } catch (error) {
    say([`${error}`]);
    return 1;
  }
  const baselines = await baselinesFor(
    root,
    gate.members,
    await baselineRuns(),
  );
  const verdicts = score(
    gate.members,
    figures,
    baselines,
    overrides.metrics,
    overrides.coverageBaselineReset,
  );
  say(report(verdicts));
  if (overrides.coverageBaselineReset) {
    say([`${COVERAGE_BASELINE_RESET_MARKER} is set, so nothing is gated.`]);
  }

  const prNumber = Number(Deno.env.get("PR_NUMBER"));
  if (Number.isInteger(prNumber) && prNumber > 0) {
    const comment = commentFor(prNumber, verdicts);
    if (comment !== undefined) {
      await Deno.writeTextFile(
        COVERAGE_COMMENT_FILE,
        JSON.stringify(comment, null, 2),
      );
    }
  }
  return verdicts.some(failed) ? 1 : 0;
}

if (import.meta.main) Deno.exitCode = await main();
