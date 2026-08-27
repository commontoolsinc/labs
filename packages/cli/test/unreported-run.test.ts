/**
 * The process-end guard a run that writes arms over itself: what it reports
 * when the process ends first, what it leaves alone once the run has
 * reported, and the exit code each of those ends with.
 */

import { beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { dirname, fromFileUrl, join } from "@std/path";

import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";

import {
  type ApplyRunProgress,
  describeUnreportedApplyRun,
  guardRunReport,
  resetUnreportedRunGuardsForTest,
  type UnreportedRunDeps,
} from "../lib/unreported-run.ts";
import { guardHarness as harness } from "./unreported-run-helpers.ts";

/** A watched run that has settled `verdicts` so far. */
function progressOf(verdicts: [string, number][]): ApplyRunProgress {
  return { observed: true, verdicts: new Map(verdicts) };
}

/** A run whose engine reports its rows only when it returns. */
function unwatchedProgress(): ApplyRunProgress {
  return { observed: false, verdicts: new Map() };
}

const testDir = dirname(fromFileUrl(import.meta.url));
const repoRoot = join(testDir, "..", "..", "..");
const fixture = join(testDir, "fixtures", "unreported-run-process.ts");
const decoder = new TextDecoder();

/** Run the fixture to completion and report how the process ended. */
async function endedProcess(
  ...args: string[]
): Promise<{ code: number; stderr: string }> {
  const output = await runDenoCommandWithTemporaryLock({
    root: repoRoot,
    args: (lockPath) => ["run", `--lock=${lockPath}`, fixture, ...args],
  });
  return { code: output.code, stderr: decoder.decode(output.stderr) };
}

describe("unreported-run", () => {
  beforeEach(() => resetUnreportedRunGuardsForTest());

  describe("guardRunReport()", () => {
    it("reports the run and raises a zero exit code when the process ends first", () => {
      const process = harness();
      guardRunReport(() => "the run never reported", process.deps);
      expect(process.endProcess()).toBe(1);
      expect(process.errors).toEqual(["the run never reported"]);
    });

    it("prints nothing and leaves the exit code at zero once the run reported", () => {
      const process = harness();
      const guard = guardRunReport(() => "unreachable", process.deps);
      guard.reported();
      expect(process.endProcess()).toBe(0);
      expect(process.errors).toEqual([]);
    });

    it("leaves a nonzero exit code as the process set it", () => {
      // The failure already has a reason of its own, and its report is what
      // the caller is about to read.
      const process = harness(2);
      guardRunReport(() => "the run never reported", process.deps);
      expect(process.endProcess()).toBe(2);
      expect(process.errors).toEqual(["the run never reported"]);
    });

    it("composes its line at the moment the process ends", () => {
      const process = harness();
      let settled = 0;
      guardRunReport(() => `settled ${settled}`, process.deps);
      settled = 7;
      process.endProcess();
      expect(process.errors).toEqual(["settled 7"]);
    });

    it("reports every still-armed run from one process-end hook", () => {
      const process = harness();
      let hooks = 0;
      const deps: UnreportedRunDeps = {
        ...process.deps,
        addUnloadListener: (handler) => {
          hooks += 1;
          process.deps.addUnloadListener!(handler);
        },
      };
      const first = guardRunReport(() => "first", deps);
      guardRunReport(() => "second", deps);
      first.reported();
      expect(process.endProcess()).toBe(1);
      expect(hooks).toBe(1);
      expect(process.errors).toEqual(["second"]);
    });

    it("treats a second stand-down as the first", () => {
      const process = harness();
      const guard = guardRunReport(() => "unreachable", process.deps);
      guard.reported();
      guard.reported();
      expect(process.endProcess()).toBe(0);
      expect(process.errors).toEqual([]);
    });
  });

  describe("describeUnreportedApplyRun()", () => {
    it("names the verb, the rows that settled, and what resumes the run", () => {
      const line = describeUnreportedApplyRun(
        "Retarget",
        progressOf([["applied", 75]]),
      );
      expect(line).toContain(
        "Retarget ended before it reported: the process exited while the " +
          "run was still in flight.",
      );
      expect(line).toContain("75 rows settled — applied: 75.");
      expect(line).toContain("Re-running resumes it");
      // The same command minus `--apply`, not a survey: a survey reads
      // references, which say nothing about the repair's work in documents,
      // and one line serves all three verbs.
      expect(line).toContain("without `--apply` says where every piece now");
      expect(line).not.toContain("survey");
    });

    it("counts one settled row in the singular", () => {
      expect(
        describeUnreportedApplyRun("Rollback", progressOf([["applied", 1]])),
      ).toContain("1 row settled — applied: 1.");
    });

    it("says no row settled when a watched run ended before its first", () => {
      // Zero is a fact here: the run's rows were being watched, and none
      // arrived. A retarget can end this way — inside the preflight, or in
      // the plan decode before a session ever opens.
      expect(
        describeUnreportedApplyRun("Retarget", progressOf([])),
      ).toContain("No row settled before it ended");
    });

    it("says the count is unknown for a run whose rows it never watched", () => {
      // The repair's engine reports its rows only in the report it returns.
      // Its rows really do settle, so "no row settled" would be false of it
      // — and a false line is worse than an unhelpful one, because an
      // operator can act on it.
      const line = describeUnreportedApplyRun("Repair", unwatchedProgress());
      expect(line).toContain("How many rows it settled is not known here");
      expect(line).not.toContain("No row settled");
      expect(line).not.toContain("0 rows");
    });

    it("keeps every verdict it was given on the tally", () => {
      expect(
        describeUnreportedApplyRun(
          "Retarget",
          progressOf([["landed", 25], ["applied", 50]]),
        ),
      ).toContain("75 rows settled — landed: 25 · applied: 50.");
    });
  });

  describe("the process it guards", () => {
    it("ends nonzero, saying so, when the run never reported", async () => {
      // The whole defect in one process: a promise that never settles, an
      // event loop with nothing left on it, and — without the guard — a
      // silent exit at code 0. This is the case the injected effects above
      // cannot reach, because Deno owns both `unload` and `Deno.exitCode`.
      const ended = await endedProcess();
      expect(ended.code).toBe(1);
      expect(ended.stderr).toContain("the run never reported");
    });

    it("ends at zero, silently, once the run reported", async () => {
      const ended = await endedProcess("report");
      expect(ended.code).toBe(0);
      expect(ended.stderr).not.toContain("the run never reported");
    });
  });
});
