#!/usr/bin/env -S deno run -A

/**
 * What the full run publishes about coverage.
 *
 * Two quantities come out of the same reports the lanes wrote. The
 * repository-wide uncovered-line count is the merge of every report,
 * scored over every tracked source file, and it is a trend: the dashboard
 * shows it and nothing gates on it. Each measured set's count is one
 * suite's units over one workspace member's lines, and it is the baseline
 * the coverage gate compares a pull request against.
 *
 * Nothing here fails a run. A rise in the repository-wide figure reaches
 * the change that caused it through the run report on its pull request,
 * and a rise in a measured set reaches it through the gate before it
 * lands.
 *
 *   deno run -A tasks/coverage-report.ts --reports coverage-artifacts
 */

import * as path from "@std/path";
import { walk } from "@std/fs/walk";
import {
  measuredSetCoverageMetric,
  PERF_METRICS_FILE,
  writeCoverageBaselineFile,
} from "./ci-check-lib.ts";
import {
  collectCoverageDebtMetricsFromLcov,
  collectMeasuredSetDebt,
  COVERAGE_METRIC_PREFIX,
} from "./coverage-metrics.ts";
import { collectSetReports } from "./coverage-gate.ts";
import { readWorkspaceMembers } from "./workspace-tests.ts";
import { loadTopology } from "./test-topology.ts";
import {
  measuredSetDirectory,
  measuredSets,
} from "./test-selection/coverage.ts";
import { COVERAGE_FAILURE_MARKER } from "./ci-lane.ts";

/** What the command line asked for. */
export interface ReportOptions {
  /** Where the lanes' coverage reports were downloaded to. */
  reports: string;

  /** Where the metrics go. */
  out: string;

  /** The run these metrics are stamped with. */
  runId: number;
  sha: string;
  createdAt: string;

  root: string;
}

/** Reads the command line, or returns undefined for a malformed one. */
export function parseReportArgs(
  args: readonly string[],
  root: string = Deno.cwd(),
): ReportOptions | undefined {
  const options: ReportOptions = {
    reports: "coverage-artifacts",
    out: PERF_METRICS_FILE,
    runId: 0,
    sha: "",
    createdAt: new Date(0).toISOString(),
    root,
  };
  const rest = [...args];
  while (rest.length > 0) {
    const flag = rest.shift()!;
    const value = rest.shift();
    if (value === undefined) return undefined;
    switch (flag) {
      case "--reports":
        options.reports = value;
        break;
      case "--out":
        options.out = value;
        break;
      case "--run-id":
        options.runId = Number(value);
        break;
      case "--sha":
        options.sha = value;
        break;
      case "--created-at":
        options.createdAt = value;
        break;
      default:
        return undefined;
    }
  }
  if (!Number.isFinite(options.runId)) return undefined;
  return options;
}

/** Every LCOV report under a directory, joined into one. */
export async function joinReports(at: string): Promise<string> {
  const parts: string[] = [];
  try {
    for await (
      const entry of walk(at, { includeDirs: false, exts: [".lcov"] })
    ) {
      parts.push(await Deno.readTextFile(entry.path));
    }
  } catch (error) {
    // Nothing was downloaded. What follows scores an empty report, which
    // charges every tracked line as uncovered and is the honest reading
    // of a run whose lanes reported nothing.
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return parts.join("\n");
}

/** One metric this run publishes. */
export interface Figure {
  name: string;
  uncoveredLines: number;
}

/**
 * The repository-wide figures: every metric group's uncovered lines and
 * the workspace total, scored over the merge of every report.
 *
 * Every report merges rather than only the ones a measured set names,
 * because this is the figure for the whole repository and every lane's
 * work contributes to it.
 */
export async function repositoryFigures(
  options: ReportOptions,
): Promise<Figure[]> {
  const lcov = await joinReports(options.reports);
  const metrics = await collectCoverageDebtMetricsFromLcov({
    rootDir: options.root,
    lcov,
  });
  return metrics.map((metric) => ({
    name: metric.name,
    uncoveredLines: metric.uncoveredLines,
  }));
}

/**
 * Each measured set's figure: its member's lines measured by that
 * suite's units alone.
 *
 * A set with no report is left out rather than published as a complete
 * measurement of nothing. The gate reads the newest baseline the branch
 * contains, so a run that lost a set's report leaves the previous run's
 * figure standing, where a zero-coverage figure would tell every later
 * pull request that the member's whole source had gone uncovered.
 *
 * So is a set a lane marked as measured through a failing test. The run
 * stayed green because a flake rate excused that failure, and the number
 * is short by whatever the failing test would have reached; publishing it
 * would hold every later pull request to a bar this run did not clear
 * either.
 */
export async function measuredSetFigures(
  options: ReportOptions,
): Promise<Figure[]> {
  const suites = await loadTopology(options.root);
  const members = (await readWorkspaceMembers(
    path.join(options.root, "deno.jsonc"),
  )).map((member) => member.replace(/^\.\//, ""));
  const reports = await collectSetReports(options.reports);
  const figures: Figure[] = [];
  for (const ref of measuredSets(suites)) {
    const found = reports.get(measuredSetDirectory(ref));
    if (found === undefined || found.length === 0) continue;
    if (await measuredThroughAFailure(found)) continue;
    const lcov = (await Promise.all(found.map((at) => Deno.readTextFile(at))))
      .join("\n");
    const debt = await collectMeasuredSetDebt({
      rootDir: options.root,
      lcov,
      member: ref.set.member,
      members,
    });
    // A report with a record for none of the member's files measured
    // nothing, whatever it says about the lines. Publishing it would
    // hand the gate a baseline no run of the set stands behind.
    if (debt.files === 0) continue;
    figures.push({
      name: measuredSetCoverageMetric(`${ref.suite}/${ref.set.member}`),
      uncoveredLines: debt.uncoveredLines,
    });
  }
  return figures;
}

/**
 * Whether any lane marked this set as measured through a failing test.
 * The marker sits beside the report in the set's own directory, which is
 * why a lane gives each set a directory rather than a file.
 */
async function measuredThroughAFailure(
  reports: readonly string[],
): Promise<boolean> {
  for (const report of reports) {
    const at = path.join(path.dirname(report), COVERAGE_FAILURE_MARKER);
    try {
      await Deno.stat(at);
      return true;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  return false;
}

/** Says what this run measured, in the job summary. */
export function describe(figures: readonly Figure[]): string {
  const workspace = figures.find((figure) =>
    figure.name === `${COVERAGE_METRIC_PREFIX} workspace uncovered lines`
  );
  const lines = ["## Coverage", ""];
  lines.push(
    workspace === undefined
      ? "No report covered the workspace."
      : `The workspace holds ${workspace.uncoveredLines} uncovered lines.`,
    "",
    `${figures.length} figures published.`,
  );
  return `${lines.join("\n")}\n`;
}

/** Writes what this run measured, and says what it published. */
export async function report(options: ReportOptions): Promise<string> {
  const figures = [
    ...await repositoryFigures(options),
    ...await measuredSetFigures(options),
  ];
  await writeCoverageBaselineFile(
    options.out,
    new Map(figures.map((figure) => [figure.name, {
      runId: options.runId,
      sha: options.sha,
      createdAt: options.createdAt,
      uncoveredLines: figure.uncoveredLines,
    }])),
  );
  return describe(figures);
}

/**
 * Runs the report the way the job runs it, and answers with the status it
 * would exit with: two for a command line this cannot read, zero
 * otherwise.
 *
 * Zero whatever the figures came to. Coverage is a trend on the default
 * branch, and a landed change that added an uncovered line must not turn
 * anything red for it.
 */
export async function main(
  args: readonly string[] = Deno.args,
  root: string = Deno.cwd(),
): Promise<number> {
  const options = parseReportArgs(args, root);
  if (options === undefined) {
    console.error(
      "usage: coverage-report.ts [--reports <dir>] [--out <file>] " +
        "[--run-id <n>] [--sha <commit>] [--created-at <iso>]",
    );
    return 2;
  }
  const summary = await report(options);
  console.log(summary);
  const at = Deno.env.get("GITHUB_STEP_SUMMARY");
  if (at !== undefined) await Deno.writeTextFile(at, summary, { append: true });
  return 0;
}

if (import.meta.main) Deno.exitCode = await main();
