#!/usr/bin/env -S deno run --allow-read

// The EXPLICIT per-phase skip lists of the server-execution v2 ON arm
// (docs/specs/server-side-execution/testing.md §2): in CI the integration
// suites run twice — EXPERIMENTAL_SERVER_EXECUTION off (byte-identical to
// today) and on — and the ON arm may skip a test only by listing it here,
// with the plan phase whose not-yet-landed surface it exercises and a
// reason. Never by silent filtering: the CI step prints every skip from
// this file, and an empty list means the ON arm runs the full suite.
//
// An entry retires when its phase lands (docs/plans/server-execution-v2.md);
// a file listed here that no longer exists fails the run, so the lists
// cannot go stale unnoticed.

/** The integration suites that run an ON arm (testing.md §1–§2). */
export type ServerExecutionSuite =
  | "patterns"
  | "runner"
  | "runtime-client"
  | "shell";

/** The plan milestone whose landing retires the skip (never "phase-1": the
 * ON arm exists from Phase 1 stage A, so nothing can be waiting on it). */
export type ServerExecutionPhase =
  | "phase-2"
  | "phase-3"
  | "phase-4"
  | "phase-5"
  | "phase-6"
  | "phase-7";

export type ServerExecutionOnSkip = {
  /** Test file, relative to the suite's package root (the directory the
   * suite's `deno test` runs from), e.g. "integration/counter.test.ts". */
  file: string;
  /** The plan phase that, once landed, unskips this file. */
  phase: ServerExecutionPhase;
  /** Why the ON arm cannot run this file before that phase. */
  reason: string;
};

const SUITE_PACKAGE_DIR: Record<ServerExecutionSuite, string> = {
  patterns: "packages/patterns",
  runner: "packages/runner",
  "runtime-client": "packages/runtime-client",
  shell: "packages/shell",
};

/**
 * The lists themselves. Empty on purpose as of Phase 1 stage A: every stage
 * of Phase 1 lands dark, so the ON arm's only behavioral delta is the
 * `stream-data` disable (builtins.md §5), which no integration test
 * exercises. Later phases add entries here — one per test, with phase and
 * reason — instead of filtering anywhere else.
 */
export const SERVER_EXECUTION_ON_SKIPS: Record<
  ServerExecutionSuite,
  ServerExecutionOnSkip[]
> = {
  patterns: [],
  runner: [],
  "runtime-client": [],
  shell: [],
};

export const isServerExecutionSuite = (
  value: string,
): value is ServerExecutionSuite => value in SUITE_PACKAGE_DIR;

/** The `--ignore=` flag for a suite's `deno test`, or "" with no skips. */
export const serverExecutionOnIgnoreArg = (
  suite: ServerExecutionSuite,
): string => {
  const skips = SERVER_EXECUTION_ON_SKIPS[suite];
  if (skips.length === 0) return "";
  return `--ignore=${skips.map((skip) => skip.file).join(",")}`;
};

/** Human-readable report of a suite's skips, one line per entry. */
export const serverExecutionOnSkipReport = (
  suite: ServerExecutionSuite,
): string => {
  const skips = SERVER_EXECUTION_ON_SKIPS[suite];
  if (skips.length === 0) {
    return `[server-execution ON arm] ${suite}: no skips — full suite runs.`;
  }
  const lines = skips.map((skip) =>
    `[server-execution ON arm] ${suite}: SKIP ${skip.file} (until ${skip.phase}) — ${skip.reason}`
  );
  return lines.join("\n");
};

/** Every listed file must exist; a vanished file is a stale entry. */
export const validateServerExecutionOnSkips = async (
  repoRoot: URL,
): Promise<string[]> => {
  const problems: string[] = [];
  for (
    const [suite, skips] of Object.entries(SERVER_EXECUTION_ON_SKIPS) as [
      ServerExecutionSuite,
      ServerExecutionOnSkip[],
    ][]
  ) {
    const seen = new Set<string>();
    for (const skip of skips) {
      if (seen.has(skip.file)) {
        problems.push(`${suite}: duplicate skip entry for ${skip.file}`);
      }
      seen.add(skip.file);
      const path = new URL(
        `${SUITE_PACKAGE_DIR[suite]}/${skip.file}`,
        repoRoot,
      );
      try {
        await Deno.stat(path);
      } catch {
        problems.push(
          `${suite}: skip entry names a missing file: ${skip.file}`,
        );
      }
    }
  }
  return problems;
};

if (import.meta.main) {
  const suite = Deno.args[0] ?? "";
  if (!isServerExecutionSuite(suite)) {
    console.error(
      `Unknown suite ${JSON.stringify(suite)}; expected one of: ${
        Object.keys(SUITE_PACKAGE_DIR).join(", ")
      }`,
    );
    Deno.exit(1);
  }
  const repoRoot = new URL("../", import.meta.url);
  const problems = await validateServerExecutionOnSkips(repoRoot);
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    Deno.exit(1);
  }
  // The report goes to stderr so the flag on stdout is the only thing a
  // `$( )` capture picks up; the CI step shows both.
  console.error(serverExecutionOnSkipReport(suite));
  const arg = serverExecutionOnIgnoreArg(suite);
  if (arg !== "") console.log(arg);
}
