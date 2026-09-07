/**
 * The one coverage gate a run of part of the corpus can still hold.
 *
 * Gating on the repository's whole coverage number cannot survive
 * selection: a pull request that runs a fifth of the test time measures a
 * fifth of the coverage, and there is no threshold that rescues that
 * comparison. Take a package that owns its own unit tests, score only
 * that package's source, and count as covered only what those tests
 * reached, and the comparison is honest again. Run every one of those
 * tests and the measurement is complete, whatever selection did anywhere
 * else in the run.
 *
 * This module decides which packages a change puts under that gate. What
 * the lanes then measure and what `Status` does with the totals rest on
 * the answer, and both ask this rather than each other.
 */

import { BROWSER_SUFFIX } from "../test-topology/unit.ts";
import {
  EXCLUDED_FROM_COVERAGE_GATE,
  LOCAL_COVERAGE_MAX_PACKAGES,
} from "./policy.ts";

/** The suites whose units are a member's own tests. */
export const UNIT_SUITES: readonly string[] = ["workspace-unit", "runner-unit"];

/** How a member's coverage report is named, from the member's path. */
export function memberSlug(member: string): string {
  return member.replace(/^\.\//, "").replace(/^packages\//, "")
    .replaceAll("/", "__");
}

/**
 * The workspace members the gate covers: every member under `packages/`
 * that the exclusion list does not name.
 *
 * Membership follows the workspace rather than a path depth, so a package
 * nested three deep is covered on the same terms as one nested one, and a
 * new package is covered from the moment it is a member.
 */
export function coveredMembers(members: readonly string[]): string[] {
  return members
    .map((member) => member.replace(/^\.\//, ""))
    .filter((member) => member.startsWith("packages/"))
    .filter((member) => !EXCLUDED_FROM_COVERAGE_GATE.has(member))
    .sort();
}

/**
 * The covered members a change reaches, by the files it touched.
 *
 * A file belongs to the deepest member that contains it, so a change to
 * `packages/connectors/github/src/x.ts` reaches
 * `packages/connectors/github` rather than a `packages/connectors` that
 * happens to be a member too.
 */
export function membersTouched(
  members: readonly string[],
  changed: ReadonlySet<string>,
): string[] {
  const covered = coveredMembers(members);
  const touched = new Set<string>();
  for (const file of changed) {
    let deepest: string | undefined;
    for (const member of covered) {
      if (!file.startsWith(`${member}/`)) continue;
      if (deepest === undefined || member.length > deepest.length) {
        deepest = member;
      }
    }
    if (deepest !== undefined) touched.add(deepest);
  }
  return [...touched].sort();
}

/** What the gate has to say about one change. */
export interface CoverageGate {
  /** The members whose whole measured set runs, and which are gated. */
  members: string[];

  /** Why the gate did not run, where it did not. */
  off?: string;
}

/**
 * Which members a change puts under the gate.
 *
 * A change touching more than `LOCAL_COVERAGE_MAX_PACKAGES` covered
 * packages turns the gate off entirely rather than gating some of them.
 * The mandatory set a covered package adds is its whole measured test
 * set, so a sweeping change would spend most of a run re-running suites
 * it barely touched; and "did this leave more untested" stops being a
 * question about one thing somebody can look at once it spans four
 * packages. Gating two of the four would mean quietly ignoring the other
 * two, and a cliff is at least predictable: an author can tell from the
 * diff whether the gate applies.
 */
export function coverageGate(
  members: readonly string[],
  changed: ReadonlySet<string>,
  cap: number = LOCAL_COVERAGE_MAX_PACKAGES,
): CoverageGate {
  const touched = membersTouched(members, changed);
  if (touched.length > cap) {
    return {
      members: [],
      off: `the change touches ${touched.length} covered packages, more ` +
        `than the ${cap} a gated change may touch: ${touched.join(", ")}`,
    };
  }
  return { members: touched };
}

/**
 * The units that make up the measured set of the members under the gate.
 *
 * Only a member's own Deno-only tests measure it, so the browser half is
 * left out: it produces no coverage of the source the gate scores, and
 * making it mandatory would run a browser for a figure it cannot move.
 */
export function measuredUnits(
  suiteId: string,
  units: readonly string[],
  members: ReadonlySet<string>,
): string[] {
  if (!UNIT_SUITES.includes(suiteId) || members.size === 0) return [];
  return units.filter((unit) => {
    if (unit.endsWith(BROWSER_SUFFIX)) return false;
    for (const member of members) {
      if (unit === member || unit.startsWith(`${member}/`)) return true;
    }
    return false;
  });
}
