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
  | "phase-7"
  | "phase-2-followup";

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
 * The lists themselves. Kept to what stage F's live ON-arm runs actually
 * surfaced: with the serving loop landed the ON arm genuinely SERVES, and
 * the plan's documented two-deriver interim (server and clients both
 * deriving until Phase 2 removes the client path) is a real posture, not
 * a hypothesis. Entries name their unskipping phase — never silent
 * filtering anywhere else.
 *
 * Stage-G re-justification (2026-08-06, per the phase-completing pass):
 * the ONE entry below was re-examined and STANDS on its original
 * Phase-2 reason — a two-browser CAS-storm bring-up failure of the
 * two-deriver interim, unrelated to effect serving. Stage G landed the
 * effect channel and added NO skips: the effectful builtins served in
 * the ON arm are exercised by the runner suite's serving-loop tests,
 * and the ON-arm integration suites run unfiltered but for this entry.
 */
export const SERVER_EXECUTION_ON_SKIPS: Record<
  ServerExecutionSuite,
  ServerExecutionOnSkip[]
> = {
  // Phase 2 retired the entry this file held since stage F (the
  // two-browsers CFC gate): the client derivation-commit path is
  // removed by construction, the two-deriver interim's CAS storm with
  // it — the exact unskipping condition the entry named. That gate now
  // runs (and passes) ON.
  patterns: [
    {
      file: "integration/sx2-serving-loop.test.ts",
      phase: "phase-2-followup",
      reason: "deterministic reproducer of the ESCALATED demand-cycle " +
        "starvation fork: the SpaceServer's cycle runs " +
        "#loadDemandedStructure BEFORE the settle race with no " +
        "deadline, and the never-loadable piece-registry root (the " +
        "structureLoadDeferred churn) is re-attempted every cycle " +
        "since the ensure-retry fix — post-activation input sits " +
        "unconsumed while cycles crawl (ledger: the Phase-2 PR's " +
        "Flags; store evidence: authored seqs land, zero derived " +
        "commits follow, wavesBudgetExhausted stays 0). The " +
        "sx2-speculation gate runs unskipped; this entry lifts with " +
        "the fork's resolution.",
    },
  ],
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
  skipLists: Record<
    ServerExecutionSuite,
    ServerExecutionOnSkip[]
  > = SERVER_EXECUTION_ON_SKIPS,
): Promise<string[]> => {
  const problems: string[] = [];
  for (
    const [suite, skips] of Object.entries(skipLists) as [
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

/**
 * CLI body, split from the `import.meta.main` wrapper so tests can drive it
 * in-process (the same coverage-driven split as `tasks/test.ts`). The skip
 * report goes to `io.error` (stderr) so an `$( )` capture in a CI step picks
 * up only the `--ignore` flag from `io.log` (stdout); the step shows both.
 */
export const main = async (
  args: string[],
  io: { log: (line: string) => void; error: (line: string) => void } = {
    log: console.log,
    error: console.error,
  },
  repoRoot: URL = new URL("../", import.meta.url),
): Promise<number> => {
  const suite = args[0] ?? "";
  if (!isServerExecutionSuite(suite)) {
    io.error(
      `Unknown suite ${JSON.stringify(suite)}; expected one of: ${
        Object.keys(SUITE_PACKAGE_DIR).join(", ")
      }`,
    );
    return 1;
  }
  const problems = await validateServerExecutionOnSkips(repoRoot);
  if (problems.length > 0) {
    io.error(problems.join("\n"));
    return 1;
  }
  io.error(serverExecutionOnSkipReport(suite));
  const arg = serverExecutionOnIgnoreArg(suite);
  if (arg !== "") io.log(arg);
  return 0;
};

if (import.meta.main) {
  Deno.exit(await main(Deno.args));
}
