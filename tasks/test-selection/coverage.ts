/**
 * Which measured sets a change reaches, and what each of them is called
 * on disk.
 *
 * A measured set is one suite's units over one workspace member's lines.
 * Everything about the coverage gate starts here: the lanes read this to
 * decide what to run whole and what to turn coverage on for, and the job
 * that joins the lanes reads the same function over the same diff rather
 * than trusting what a lane reported.
 */

import {
  coverageMemberDirectory,
  type MeasuredSet,
  reachedByChange,
  type Suite,
  unavailableUnits,
} from "../test-topology/suite.ts";
import { LOCAL_COVERAGE_MAX_SETS } from "./policy.ts";

/** One measured set, and the suite that declared it. */
export interface MeasuredSetRef {
  suite: string;
  set: MeasuredSet;
}

/**
 * Every measured set the topology declares that this configuration can
 * run, in a stable order.
 *
 * A set every one of whose units the suite declares unavailable is left
 * out. Keeping it would mean scoring a set nothing was required to run,
 * so the count would be whatever some other lane happened to leave in
 * the directory.
 */
export function measuredSets(
  suites: readonly Suite[],
): MeasuredSetRef[] {
  const sets: MeasuredSetRef[] = [];
  for (const suite of suites) {
    const unavailable = unavailableUnits(suite);
    for (const set of suite.measured ?? []) {
      if (set.units.every((unit) => unavailable.has(unit))) continue;
      sets.push({ suite: suite.id, set });
    }
  }
  return sets.sort((a, b) =>
    a.suite.localeCompare(b.suite) || a.set.member.localeCompare(b.set.member)
  );
}

/** Where one measured set's coverage profiles and report live. */
export function measuredSetDirectory(ref: MeasuredSetRef): string {
  return `${ref.suite}/${coverageMemberDirectory(ref.set.member)}`;
}

/** How a measured set is named in a summary or a metric. */
export function measuredSetName(ref: MeasuredSetRef): string {
  return `${ref.suite}/${ref.set.member}`;
}

/** What the coverage gate decided about one change. */
export interface CoverageGateSelection {
  /** The sets the gate runs and scores. Empty where it does not run. */
  sets: MeasuredSetRef[];

  /**
   * Every set the change reached, whether or not the gate runs. The cap
   * below turns the gate off without changing what the change reached,
   * and a summary that could not say what it reached would leave nobody
   * able to tell a capped change from an untouched one.
   */
  reached: MeasuredSetRef[];

  /** Why the gate did not run, where it did not. */
  off?: string;
}

/**
 * Which measured sets a change reaches, and whether the gate runs.
 *
 * The gate is off entirely past the cap rather than off for some of the
 * sets: gating two of the four a change reached would mean quietly
 * ignoring the other two. A cliff is also predictable, so an author can
 * tell from the diff whether the gate applies without knowing what any
 * set's tests cost.
 */
export function coverageGateFor(
  suites: readonly Suite[],
  changed: ReadonlySet<string>,
): CoverageGateSelection {
  const reached = measuredSets(suites)
    .filter((ref) => reachedByChange(ref.set.reachedBy, changed));
  if (reached.length > LOCAL_COVERAGE_MAX_SETS) {
    return {
      sets: [],
      reached,
      off: `the change reaches ${reached.length} measured sets, more than ` +
        `the ${LOCAL_COVERAGE_MAX_SETS} a gated change may reach`,
    };
  }
  return { sets: reached, reached };
}

/**
 * The units one selection makes mandatory, as `suite\tunit` keys.
 *
 * A unit the suite declares unavailable is left out: it does not run, so
 * requiring it would place an identity no invocation would execute.
 */
export function measuredUnitKeys(
  suites: readonly Suite[],
  selection: CoverageGateSelection,
): Set<string> {
  const bySuite = new Map(suites.map((suite) => [suite.id, suite]));
  const keys = new Set<string>();
  for (const ref of selection.sets) {
    const suite = bySuite.get(ref.suite);
    if (suite === undefined) continue;
    const unavailable = unavailableUnits(suite);
    for (const unit of ref.set.units) {
      if (unavailable.has(unit)) continue;
      keys.add(`${ref.suite}\t${unit}`);
    }
  }
  return keys;
}

/** The members one suite measures under a selection. */
export function measuredMembersOf(
  selection: CoverageGateSelection,
  suiteId: string,
): Set<string> {
  return new Set(
    selection.sets
      .filter((ref) => ref.suite === suiteId)
      .map((ref) => ref.set.member),
  );
}
