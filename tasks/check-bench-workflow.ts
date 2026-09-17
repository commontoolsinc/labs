/**
 * Holds the Benchmarks workflow to what the dashboard reads it for: running
 * every benchmark file the dashboard names, and checking the report it
 * uploads.
 *
 * Two of the dashboard's numbers rest on a benchmark named outright -- the
 * machine factor it divides out of every trend, and the two series the key
 * benchmarks tile is -- and what catches a name that has stopped reaching one
 * is the check over the report. A workflow that runs neither the benchmark
 * nor the check says nothing at all, and the run that would have said it is
 * four hours away, so both are worth settling at review time.
 *
 * This is the half a diff can settle. What a file's benchmarks are called is
 * decided when they run, which is where `packages/dashboard/bench-report.ts`
 * reads it.
 */

import {
  CALIBRATION_FILE,
  KEY_BENCHMARKS,
} from "../packages/dashboard/bench-report.ts";

const WORKFLOW = ".github/workflows/benchmarks.yml";

/** The command the workflow runs over the report before uploading it. */
const REPORT_CHECK = "deno run --allow-read tasks/check-bench-report.ts\n" +
  "          bench-results/results.json\n";

const repoRoot = (): string => new URL("../", import.meta.url).pathname;

/** The files the dashboard names, each once, in the order it names them. */
export function namedBenchmarkFiles(): readonly string[] {
  const files = [
    CALIBRATION_FILE,
    ...KEY_BENCHMARKS.map((key) => key.slice(0, key.indexOf(" > "))),
  ];
  return [...new Set(files)];
}

/**
 * What the workflow and the tree fail to hold up, one line each, or nothing
 * when they hold it all.
 */
export function benchWorkflowProblems(
  workflow: string,
  exists: (file: string) => boolean,
): readonly string[] {
  const problems: string[] = [];
  for (const file of namedBenchmarkFiles()) {
    if (!exists(file)) {
      problems.push(`${file}: named by the dashboard, absent from the tree`);
    }
    // The list continues each file onto the next line, so a file named
    // anywhere else in the workflow -- in a comment, or in another step --
    // is not this.
    if (!workflow.includes(`\n            ${file} \\\n`)) {
      problems.push(`${file}: named by the dashboard, not in the deno bench`);
    }
  }
  if (!workflow.includes(REPORT_CHECK)) {
    problems.push(
      "tasks/check-bench-report.ts: no step runs it over bench-results",
    );
  }
  return problems;
}

/** Runs the check over `root`, reports, and returns a process code. */
export function main(root: string = repoRoot()): number {
  const workflow = Deno.readTextFileSync(`${root}${WORKFLOW}`);
  const exists = (file: string): boolean => {
    try {
      return Deno.statSync(`${root}${file}`).isFile;
    } catch {
      return false;
    }
  };
  const problems = benchWorkflowProblems(workflow, exists);
  if (problems.length > 0) {
    console.error(
      [
        "",
        `What ${WORKFLOW} does not do that the dashboard reads it for:`,
        "",
        ...problems.map((problem) => `  ${problem}`),
        "",
        "The names are CALIBRATION_FILE and KEY_BENCHMARKS in",
        "packages/dashboard/bench-report.ts. A benchmark that moved takes its",
        "dashboard history with it, so move the name with the file or leave",
        "the file where it is. See docs/development/BENCHMARKS.md.",
        "",
      ].join("\n"),
    );
    return 1;
  }
  console.log(
    `${WORKFLOW} runs the report check and every benchmark the dashboard ` +
      `names (${namedBenchmarkFiles().length} files).`,
  );
  return 0;
}

if (import.meta.main) Deno.exit(main());
