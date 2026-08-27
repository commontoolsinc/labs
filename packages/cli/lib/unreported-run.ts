/**
 * The exit discipline for a run that writes: a `cf` invocation that ENDS
 * while its run has not reported must not look like a success.
 *
 * A Deno process whose main promise is still pending, with no work left on
 * the event loop, does not hang — it drains and exits, silently, with code
 * 0. Every await in a bulk apply sits under that rule: the engine can stop
 * settling anywhere between opening a session and returning its report, and
 * the process then ends having written part of a migration, printed no
 * summary, and told its caller everything went well. A script cannot see the
 * difference, and neither can an operator reading a log whose last line is a
 * row that applied normally.
 *
 * So the report is not the only thing that decides how the process ends. A
 * run arms a guard for the whole of its life and stands it down the moment
 * it has reported; if the process ends first, the guard says so on stderr
 * and raises the exit code. It is armed on the real event — the process
 * ending — rather than on a clock, so it costs a run that finishes nothing
 * and cannot cut one short.
 *
 * Scoped to the runs that write. A command whose whole job is to stay up
 * until interrupted (`cf piece render --watch`) ends exactly this way on
 * purpose, so this is never installed process-wide.
 */

/** Injectable effects, for tests. */
export interface UnreportedRunDeps {
  /** Registers the process-end hook the guard reports from. */
  addUnloadListener?: (handler: () => void) => void;

  /** Where the guard's report goes. */
  printError?: (message: string) => void;

  /** The code the process is ending with, read inside the hook. */
  readExitCode?: () => number;

  /** Raise the code the process is ending with. */
  setExitCode?: (code: number) => void;
}

/** A run's handle on its own guard. */
export interface RunReportGuard {
  /**
   * This run has reported; the guard stands down. Idempotent, and safe to
   * call on the failure path too — a run that ended by throwing reports
   * through the error it threw.
   */
  reported(): void;
}

interface ArmedRun {
  describe: () => string;
}

// Module-level rather than per-instance so a process running two guarded
// runs still installs at most one hook, from at most one registration.
const armed = new Set<ArmedRun>();
let unloadHookInstalled = false;

/** Test-only: clears the armed runs and the hook guard between cases. */
export function resetUnreportedRunGuardsForTest(): void {
  armed.clear();
  unloadHookInstalled = false;
}

/** The production hook registration; a test injects its own. */
export function addProcessUnloadListener(handler: () => void): void {
  globalThis.addEventListener("unload", handler);
}

/** The production reading of the code the process is ending with. */
export function processExitCode(): number {
  return Deno.exitCode;
}

/** The production write of the code the process is ending with. */
export function setProcessExitCode(code: number): void {
  Deno.exitCode = code;
}

/**
 * Arm a guard over one run. `describe` composes the line the guard reports
 * if the process ends first — called at that moment, so it can name what the
 * run had settled by then rather than what it knew when it started.
 *
 * The hook is installed once per process, by the first run to arm one, and
 * every later run joins it. A test that injects effects therefore resets
 * through {@link resetUnreportedRunGuardsForTest} between cases, the same way
 * the deferred version-skew note does.
 */
export function guardRunReport(
  describe: () => string,
  deps: UnreportedRunDeps = {},
): RunReportGuard {
  const printError = deps.printError ?? console.error;
  const readExitCode = deps.readExitCode ?? processExitCode;
  const setExitCode = deps.setExitCode ?? setProcessExitCode;
  const addUnloadListener = deps.addUnloadListener ?? addProcessUnloadListener;
  const run: ArmedRun = { describe };
  armed.add(run);
  if (!unloadHookInstalled) {
    unloadHookInstalled = true;
    addUnloadListener(() => {
      if (armed.size === 0) return;
      for (const pending of armed) printError(pending.describe());
      // Raise a success into a failure and leave a failure alone: a process
      // already ending nonzero has a reason of its own, and overwriting it
      // would replace the report the caller is about to read.
      if (readExitCode() === 0) setExitCode(1);
      armed.clear();
    });
  }
  return {
    reported: () => {
      armed.delete(run);
    },
  };
}

/** What one guarded apply run has settled by the time it is asked. */
export interface ApplyRunProgress {
  /** Rows the run reported, by verdict, in the order first seen. */
  verdicts: Map<string, number>;
}

/**
 * What an apply run reports when the process ends before it does. It names
 * the verb, what had settled, and what the operator does next — everything
 * the missing summary would have carried, minus the claims only a returned
 * report can support.
 *
 * The counts come from the rows the run streamed, so a mode that streams
 * none says only that the run ended, which is the honest whole of what such
 * a run knows about itself. Nothing here asserts that the rows it does not
 * name were left alone: a run that stopped settling stopped somewhere this
 * process cannot see, and a survey is what settles that.
 */
export function describeUnreportedApplyRun(
  verb: string,
  progress: ApplyRunProgress,
): string {
  const settled = [...progress.verdicts.values()].reduce(
    (total, count) => total + count,
    0,
  );
  const tally = [...progress.verdicts.entries()]
    .map(([verdict, count]) => `${verdict}: ${count}`)
    .join(" · ");
  return [
    `${verb} ended before it reported: the process exited while the run was ` +
    `still in flight.`,
    settled === 0
      ? `  No row settled, so this run accounts for nothing it may have ` +
        `written.`
      : `  ${settled} ${settled === 1 ? "row" : "rows"} settled — ${tally}. ` +
        `Whether anything after them was written is not known here.`,
    `  Re-running resumes from what landed, and a fresh survey says what ` +
    `that is.`,
  ].join("\n");
}
