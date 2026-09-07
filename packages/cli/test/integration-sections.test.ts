/**
 * The `case "$SECTION"` table at the end of integration/integration.sh decides
 * which steps a run executes. An arm running one step is what the `cli-core`
 * suite turns into a unit, and a unit is what a lane can be asked for; a run
 * with no section argument dispatches `all`.
 *
 * A step no arm runs alone runs nowhere: it is maintained and it passes when
 * someone runs it by hand, and no run of the repository reports on it. These
 * hold the table to reaching every step from both directions, and hold each
 * recorded step name to naming a function the script actually defines.
 *
 * What they read is the text of the table, so they see which steps are
 * reachable and nothing about what a step does once it runs. The group arms
 * are free to hold any subset: `piece-basics` and `all` exist for hand runs,
 * and no lane is pointed at either.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { loadCliSuites } from "../../../tasks/test-topology/cli.ts";

/** The integration script, whose tail holds the dispatch table. */
const SCRIPT = await Deno.readTextFile(
  new URL("../integration/integration.sh", import.meta.url),
);

/**
 * The steps of this script the `cli-core` suite gives a lane something to
 * ask for. The suite also holds the standalone scripts beside it, which
 * carry no step name and are left out here.
 */
const UNITS = new Set(
  (await loadCliSuites(new URL("../../..", import.meta.url).pathname))
    .find((suite) => suite.id === "cli-core")!.units
    .filter((unit) => unit.startsWith("integration.sh "))
    .map((unit) => unit.slice("integration.sh ".length)),
);

/** The shell function that runs a step, by the table's naming rule. */
function stepFunction(step: string): string {
  return `run_${step.replaceAll("-", "_")}`;
}

/** One section of the dispatch table and the steps it runs. */
interface Arm {
  /** The section name, as `CF_CLI_INTEGRATION_SECTION` names it. */
  section: string;

  /** The steps the arm runs, in the order it runs them. */
  steps: string[];
}

/** What one reading of the dispatch table found. */
interface DispatchTable {
  /** Every arm of the table, in the order they are written. */
  arms: Arm[];

  /** Body lines that are not a recorded step name paired with its call. */
  malformed: string[];
}

/**
 * Reads the dispatch table. An arm's body is pairs of a
 * `cf_test_step_begin <step>` line and the call that runs that step; anything
 * else is reported through `malformed` rather than dropped, so a step written
 * in an unexpected form cannot slip past the coverage checks below. A step the
 * table reaches through anything other than a literal call on its own line —
 * a variable, a helper, a loop — is one of those unexpected forms, and is
 * reported rather than counted.
 */
function parseDispatchTable(script: string): DispatchTable {
  const lines = script.split("\n");
  const open = lines.indexOf('case "$SECTION" in');
  if (open < 0) {
    throw new Error('integration.sh has no `case "$SECTION" in` table');
  }
  const arms: Arm[] = [];
  const malformed: string[] = [];
  let arm: Arm | undefined;
  let pending: string | undefined;
  const unpaired = (step: string) =>
    `${arm?.section}: ${step} is not followed by ${stepFunction(step)}`;
  for (const line of lines.slice(open + 1)) {
    if (line === "esac") break;
    const opened = line.match(/^ {2}(\S+)\)$/);
    if (opened) {
      if (pending !== undefined) malformed.push(unpaired(pending));
      pending = undefined;
      // `*)` is the unknown-section error, not a list of steps.
      arm = opened[1] === "*" ? undefined : { section: opened[1], steps: [] };
      if (arm !== undefined) arms.push(arm);
      continue;
    }
    if (arm === undefined) continue;
    if (line === "    ;;") {
      if (pending !== undefined) malformed.push(unpaired(pending));
      pending = undefined;
      arm = undefined;
      continue;
    }
    const begins = line.match(/^ {4}cf_test_step_begin (\S+)$/);
    if (begins) {
      if (pending !== undefined) malformed.push(unpaired(pending));
      pending = begins[1];
      continue;
    }
    if (pending === undefined) {
      malformed.push(`${arm.section}: ${line.trim()} runs outside a step`);
      continue;
    }
    if (line === `    ${stepFunction(pending)}`) {
      arm.steps.push(pending);
    } else {
      malformed.push(unpaired(pending));
    }
    pending = undefined;
  }
  return { arms, malformed };
}

/** Every step runner the script defines. */
function definedFunctions(script: string): string[] {
  return [...script.matchAll(/^(run_[a-z_]+)\(\) \{$/gm)].map((m) => m[1]);
}

const { arms, malformed } = parseDispatchTable(SCRIPT);
const bySection = new Map(arms.map((arm) => [arm.section, arm.steps]));
const everyStep = [...new Set(arms.flatMap((arm) => arm.steps))].sort();
const defined = new Set(definedFunctions(SCRIPT));

describe("integration-sections", () => {
  it("pairs every recorded step name with the function that runs it", () => {
    expect(malformed).toEqual([]);
  });

  it("dispatches every step runner the script defines", () => {
    const dispatched = new Set(everyStep.map(stepFunction));
    const orphans = [...defined].filter((fn) => !dispatched.has(fn));
    expect(orphans).toEqual([]);
  });

  it("defines a runner for every step it dispatches", () => {
    // The other direction. Deleting a runner and leaving its call behind is
    // valid shell that the pairing check reads as well-formed, because the
    // pairing is between two names; `bash -n` accepts it too, and the script
    // reaches `command not found` only once CI has a server up.
    const missing = everyStep.filter((step) => !defined.has(stepFunction(step)))
      .map(stepFunction);
    expect(missing).toEqual([]);
  });

  it("runs every step under `all`", () => {
    const all = new Set(bySection.get("all") ?? []);
    expect(everyStep.filter((step) => !all.has(step))).toEqual([]);
  });

  it("gives every step a unit a lane can be pointed at", () => {
    // The two readings meet here. This file reads the table its own way,
    // the topology reads it another, and a step present in one and absent
    // from the other is a step nothing runs.
    expect(everyStep.filter((step) => !UNITS.has(step))).toEqual([]);
    expect([...UNITS].filter((unit) => !everyStep.includes(unit))).toEqual([]);
  });

  it("gives every step an arm that runs it alone", () => {
    // What makes a step schedulable on its own. A step reachable only
    // inside a group can only be asked for as the whole group, and a
    // group is one thing that takes as long as everything in it. This
    // says nothing about which arms CI dispatches, which is the check
    // above: an arm may exist for a step nothing schedules by itself.
    const alone = new Set(
      arms.filter((arm) => arm.steps.length === 1).map((arm) => arm.steps[0]),
    );
    expect(everyStep.filter((step) => !alone.has(step))).toEqual([]);
  });
});
