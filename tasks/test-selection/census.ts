/**
 * Reading a working tree against a manifest.
 *
 * The tree decides which tests exist and the manifest decides what each
 * of them is worth and costs. Everything that chooses tests reads the
 * result of this rather than the manifest the store gave, so a unit the
 * manifest still names and the tree no longer has cannot be run, and a
 * unit the tree has and no manifest has seen cannot be missed. Both
 * mistakes were reachable while the full run read the tree and the
 * pull-request run read the manifest.
 */

import { testIdentityKey } from "@commonfabric/test-support/records";
import type { TestIdentity } from "@commonfabric/test-support/records";
import {
  type Suite,
  unavailableUnits,
  type Unit,
} from "../test-topology/suite.ts";
import {
  emptyManifest,
  type Manifest,
  type ManifestEntry,
} from "./manifest.ts";
import type { SelectionReason } from "./plan.ts";
import { UNMEASURED_COST_SECONDS, VALUE_FLOOR } from "./policy.ts";

/**
 * A stand-in identity for a unit no manifest has ever seen. Records exist
 * only for tests that ran, so a unit with none is either brand new or
 * renamed, and both must run. The packer needs something to place, and
 * this is the least it can be given: the suite's own record surface and
 * the unit's path, which no real record will ever collide with because a
 * real record is named for a test rather than for a file.
 */
export function unknownIdentity(suite: Suite, unit: string): TestIdentity {
  const surface = suite.recordSurfaces[0];
  const test: TestIdentity = {
    k: surface?.kind ?? "unit",
    s: surface?.scope ?? "repo",
    n: `unrecorded ${unit}`,
  };
  if (suite.variant !== undefined) test.v = suite.variant;
  return test;
}

/**
 * The middle value of a set of numbers, or nothing where the set is
 * empty. The middle rather than the mean because measured test costs are
 * extremely skewed: a tenth of them hold nine tenths of the time, so a
 * mean says what the slowest few cost rather than what a test costs.
 */
function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * The entry a unit no manifest has ever seen is carried on. Records exist
 * only for tests that ran, so a unit with none is new or renamed, and
 * both have to run.
 *
 * It is charged what the middle unit of its own suite costs. The suites
 * are orders of magnitude apart — a unit test is milliseconds and a
 * pattern integration test is tens of seconds — so one figure for all of
 * them would misjudge most of them, and a suite's own units are the best
 * guess there is at what a new one will take. Charging nothing, which is
 * what a stand-in used to cost, made the packer treat every new test as
 * free and put the whole of a new suite in the first lane it offered.
 */
export function standIn(
  suite: Suite,
  unit: Unit,
  suiteCosts: readonly number[],
): ManifestEntry {
  return {
    test: unknownIdentity(suite, unit),
    suite: suite.id,
    unit,
    cost: median(suiteCosts) ?? UNMEASURED_COST_SECONDS,
    score: VALUE_FLOOR,
    inputs: { catches: 0, mainCatches: 0, sources: 0, churn: 0 },
    flakeRate: 0,
    repeats: 1,
  };
}

/** What this working tree holds, and what has to run whatever it is worth. */
export interface Census {
  /**
   * The manifest as this working tree sees it. The tree decides what
   * exists and the manifest decides what each of those things is worth,
   * so a unit the manifest still names and the tree no longer has drops
   * out, and a unit the tree has and the manifest has never seen gets a
   * stand-in. Everything downstream reads this rather than the manifest
   * the store gave, which is what stops the run on `main` and the run on
   * a pull request disagreeing about which tests exist.
   */
  manifest: Manifest;

  /** Identities that run whatever they are worth, against the reason. */
  mandatory: Map<string, SelectionReason>;

  /**
   * How many of the entries are stand-ins, which is how much of what
   * this tree would run rests on a guess at the cost rather than on a
   * measurement. Counted here because this is where the stand-ins are
   * made; asking the manifest whether it arrived answers a different
   * question, since one published before most of this tree existed
   * arrives and still knows almost none of it.
   */
  unmeasured: number;
}

/**
 * Reads the working tree against a manifest.
 *
 * Three rules make a unit mandatory: its suite is marked `always`, the
 * change touched what it covers, or no manifest has ever seen it. The
 * last of those is the rule the test-record spec requires of any consumer
 * that selects which tests run. A selector that never runs the unselected
 * starves its own data, and a renamed test is an unknown identity until
 * an alias lands.
 */
export function census(
  suites: readonly Suite[],
  manifest: Manifest | undefined,
  changed: ReadonlySet<string>,
): Census {
  // Everything below writes into the manifest this returns. What it does
  // not touch is what a manifest says about its own publication rather
  // than about a corpus: when it was generated, from which commit and
  // how many runs, the dials it was built with, the exploration seed,
  // the fitted costs, and `known`, which counts what the store has seen
  // and is deliberately the store's figure rather than this tree's.
  const inUnit = new Map<string, ManifestEntry[]>();
  // What each known unit costs in total, which is what a stand-in stands
  // for. A stand-in is a whole unit rather than one test in it, and a
  // unit holds several tests — around seven on average across this
  // repository — so charging it what one test costs would charge a new
  // file a fraction of what running it takes.
  const unitTotal = new Map<string, number>();
  for (const entry of manifest?.entries ?? []) {
    const key = `${entry.suite}\t${entry.unit}`;
    inUnit.set(key, [...inUnit.get(key) ?? [], entry]);
    unitTotal.set(key, (unitTotal.get(key) ?? 0) + entry.cost);
  }
  const costs = new Map<string, number[]>();
  for (const [key, total] of unitTotal) {
    const suite = key.slice(0, key.indexOf("\t"));
    costs.set(suite, [...costs.get(suite) ?? [], total]);
  }
  const entries: ManifestEntry[] = [];
  const mandatory = new Map<string, SelectionReason>();
  let unmeasured = 0;
  for (const suite of suites) {
    const unavailable = unavailableUnits(suite);
    // A unit that is a path is made mandatory by the diff naming it. A
    // unit that is not — a type-check group, a binary — is one the suite
    // has to map the diff onto itself, because only it knows what its
    // unit covers.
    const touched = new Set<string>(
      suite.unitsForChange !== undefined
        ? suite.unitsForChange(changed)
        : suite.units.filter((unit) => changed.has(unit)),
    );
    for (const unit of suite.units) {
      if (unavailable.has(unit)) continue;
      const reason: SelectionReason | undefined = suite.mandatory === "always"
        ? "always"
        : touched.has(unit)
        ? "changed"
        : undefined;
      const recorded = inUnit.get(`${suite.id}\t${unit}`);
      if (recorded === undefined) {
        const entry = standIn(suite, unit, costs.get(suite.id) ?? []);
        entries.push(entry);
        unmeasured += 1;
        // Nothing in the manifest runs this unit, so it is unknown
        // whatever else made it mandatory.
        mandatory.set(testIdentityKey(entry.test), reason ?? "unknown");
        continue;
      }
      entries.push(...recorded);
      if (reason === undefined) continue;
      for (const entry of recorded) {
        mandatory.set(testIdentityKey(entry.test), reason);
      }
    }
  }
  const present = new Set(entries.map((entry) => testIdentityKey(entry.test)));
  return {
    manifest: {
      ...(manifest ?? emptyManifest()),
      entries,
      // An identity held back that this tree cannot run is not something
      // a lane has anything to say about.
      withheld: (manifest?.withheld ?? []).filter((held) =>
        present.has(testIdentityKey(held.test))
      ),
      // What this tree declares unavailable, in place of what the tree
      // the publisher read declared.
      unavailable: suites.flatMap((suite) =>
        suite.unavailable.map((entry) => ({
          suite: suite.id,
          ...(suite.variant === undefined ? {} : { variant: suite.variant }),
          unit: entry.unit,
          ...(entry.leafName === undefined ? {} : { leafName: entry.leafName }),
          ...(entry.phase === undefined ? {} : { phase: entry.phase }),
          reason: entry.reason,
        }))
      ),
      // The publisher's reference packing and its list of what would not
      // fit are over the corpus it read, which is not this one. A plan
      // over these entries works both out again, so carrying the
      // publisher's would be offering an answer to a different question.
      lanes: [],
      unschedulable: [],
    },
    mandatory,
    unmeasured,
  };
}
