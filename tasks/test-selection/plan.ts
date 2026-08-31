/**
 * What a pull request runs, worked out from the manifest, the diff, and
 * nothing else.
 *
 * Every lane calls this over the same inputs and takes its own share of
 * the answer, so the five agree by construction and no job sits ahead of
 * them deciding. That only holds while this is a pure function: no clock,
 * no unseeded randomness, no dependence on anything but its arguments.
 * The exploration draw's seed comes from the manifest.
 */

import {
  type TestIdentity,
  testIdentityKey,
} from "@commonfabric/test-support/records";
import {
  FILL_DENSITY_SHARE,
  FILL_EXPLORATION_SHARE,
  FILL_VALUE_SHARE,
  FLAKE_EXCLUSION_RATE,
  LANE_BOUND_SECONDS,
  LANE_BUDGET_SECONDS,
  LANES,
  VALUE_FLOOR,
} from "./policy.ts";
import type {
  Manifest,
  ManifestEntry,
  UnschedulableEntry,
} from "./manifest.ts";

/** Why one identity is in the run. */
export type SelectionReason =
  | "always"
  | "changed"
  | "covers-changed"
  | "unknown"
  | "coverage-gate"
  | "value"
  | "density"
  | "exploration";

/** One identity the plan runs, and what put it there. */
export interface Selection {
  entry: ManifestEntry;
  reason: SelectionReason;

  /** How many times it runs. Every one of them must pass. */
  repeats: number;
}

/** What a lane was asked to do. */
export interface LaneAssignment {
  lane: number;
  selections: Selection[];

  /** Seconds of work this lane is expected to take, setup included. */
  projectedSeconds: number;

  /** The capabilities its batches need, in a stable order. */
  capabilities: string[];
}

/** The whole plan, and what it declined to run. */
export interface Plan {
  lanes: LaneAssignment[];

  /** Identities the manifest withheld, so a lane can say why. */
  withheld: Manifest["withheld"];

  /** Set when the mandatory pass alone did not fit. */
  overBudgetSeconds: number;

  /**
   * Identities no lane can hold. One costing more than a lane's planned
   * budget is given a lane to itself and allowed to run up to the hard
   * bound; one costing more than the hard bound cannot run at all, and
   * scheduling it would only time the lane out. It is reported instead,
   * and the sixty-second rule is where such a test gets split.
   */
  unschedulable: UnschedulableEntry[];
}

/** What the packer needs beyond the manifest. */
export interface PlanInput {
  manifest: Manifest;

  /**
   * Identities this change makes mandatory, against the reason. The lane
   * runner fills this from the diff, from the topology's enumeration, and
   * from the coverage attribution map.
   */
  mandatory: Map<string, SelectionReason>;

  /** Which capabilities each suite needs. */
  capabilities: ReadonlyMap<string, readonly string[]>;

  /**
   * Where an identity the manifest does not carry runs, by identity key.
   * An identity with no records is mandatory, and the manifest cannot say
   * where it runs precisely because it has never seen it, so whoever
   * enumerated the tree says instead.
   */
  unknown?: ReadonlyMap<string, { suite: string; unit: string }>;

  /** How many lanes to fill. Defaults to the dial. */
  lanes?: number;

  /** Seconds each lane may fill. Defaults to the dial. */
  budgetSeconds?: number;

  /** The hard bound on a lane's work step. Defaults to the dial. */
  boundSeconds?: number;
}

/**
 * A deterministic pseudo-random sequence from a string seed. The
 * exploration draw needs tie-breaking that every lane agrees on and that
 * changes between manifests, which is exactly what a seeded generator is
 * and exactly what `Math.random` is not.
 */
export function seededOrder(seed: string, count: number): number[] {
  let state = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    state ^= seed.charCodeAt(i);
    state = Math.imul(state, 16777619);
  }
  const order = Array.from({ length: count }, (_, i) => i);
  for (let i = count - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    const swap = order[i]!;
    order[i] = order[j]!;
    order[j] = swap;
  }
  return order;
}

/** A lane as it fills up. */
interface Filling {
  lane: number;
  selections: Selection[];
  capabilities: Set<string>;

  /** The suites and invocation units whose overheads this lane has paid. */
  suites: Set<string>;
  units: Set<string>;
  load: number;
}

/** What one identity costs a lane that is running nothing else. */
function loneCost(
  manifest: Manifest,
  input: PlanInput,
  entry: ManifestEntry,
): number {
  return marginalCost(
    manifest,
    input,
    {
      lane: 0,
      selections: [],
      capabilities: new Set(),
      suites: new Set(),
      units: new Set(),
      load: 0,
    },
    entry,
    1,
  );
}

function capabilityCost(manifest: Manifest, capability: string): number {
  return manifest.calibration.setupCost[capability] ?? 0;
}

/**
 * What adding this identity to this lane would cost: its own time times
 * its suite's correction, plus its suite's overhead and its unit's
 * overhead where the lane is not paying those already, plus any
 * capability setup this lane has not opened yet.
 */
function marginalCost(
  manifest: Manifest,
  input: PlanInput,
  lane: Filling,
  entry: ManifestEntry,
  repeats: number,
): number {
  const fitted = manifest.calibration.suites[entry.suite];
  const correction = fitted?.correction ?? 1;
  let cost = entry.cost * correction * repeats;
  if (!lane.suites.has(entry.suite)) cost += fitted?.overhead ?? 0;
  if (!lane.units.has(entry.unit)) {
    cost += manifest.calibration.unitOverhead[entry.unit] ?? 0;
  }
  for (const capability of input.capabilities.get(entry.suite) ?? []) {
    if (!lane.capabilities.has(capability)) {
      cost += capabilityCost(manifest, capability);
    }
  }
  return cost;
}

function place(
  input: PlanInput,
  lanes: Filling[],
  entry: ManifestEntry,
  reason: SelectionReason,
  repeats: number,
): number {
  // Longest-processing-time scheduling: the cheapest lane to add this to
  // wins, which is what makes tests needing the same environment group
  // together rather than being a special case in the packer.
  let best = lanes[0]!;
  let bestCost = marginalCost(input.manifest, input, best, entry, repeats);
  for (const lane of lanes.slice(1)) {
    const cost = marginalCost(input.manifest, input, lane, entry, repeats);
    if (cost < bestCost || (cost === bestCost && lane.load < best.load)) {
      best = lane;
      bestCost = cost;
    }
  }
  best.selections.push({ entry, reason, repeats });
  best.load += bestCost;
  best.suites.add(entry.suite);
  best.units.add(entry.unit);
  for (const capability of input.capabilities.get(entry.suite) ?? []) {
    best.capabilities.add(capability);
  }
  return bestCost;
}

/**
 * Whether a lane could take this identity without going past the share of
 * the total budget this pass is allowed. The passes are bounded by shares
 * of the whole rather than per lane, so an expensive test can have a lane
 * to itself while the others carry the tail.
 */
function fits(
  input: PlanInput,
  lanes: Filling[],
  entry: ManifestEntry,
  repeats: number,
  ceiling: number,
): boolean {
  const cheapest = Math.min(
    ...lanes.map((lane) =>
      marginalCost(input.manifest, input, lane, entry, repeats)
    ),
  );
  const spent = lanes.reduce((total, lane) => total + lane.load, 0);
  return spent + cheapest <= ceiling;
}

/**
 * Works out what runs, and where.
 *
 * Four passes in order. Mandatory first, which can in principle exceed
 * the budget and says so when it does rather than silently dropping work.
 * Then value, ignoring cost, which is what gets the expensive genuinely
 * broken integration test into the run. Then density, which sweeps up the
 * cheap tail the value floor puts at the top of the value-per-second
 * ordering. Then exploration, so the unselected corpus keeps producing
 * data.
 */
export function plan(input: PlanInput): Plan {
  const manifest = input.manifest;
  const laneCount = input.lanes ?? LANES;
  const budget = (input.budgetSeconds ?? LANE_BUDGET_SECONDS) * laneCount;
  const lanes: Filling[] = Array.from({ length: laneCount }, (_, i) => ({
    lane: i + 1,
    selections: [],
    capabilities: new Set<string>(),
    suites: new Set<string>(),
    units: new Set<string>(),
    load: 0,
  }));

  const bound = input.boundSeconds ?? LANE_BOUND_SECONDS;
  const byKey = new Map<string, ManifestEntry>();
  for (const entry of manifest.entries) {
    byKey.set(testIdentityKey(entry.test), entry);
  }

  // An identity whose own measured time is past the hard bound cannot run
  // in any lane, so it is reported rather than placed in one that would
  // then be killed at its bound. Its suite's correction is applied first,
  // because that is what the time will actually be.
  const unschedulable: UnschedulableEntry[] = [];
  const beyondBound = new Set<string>();
  for (const entry of manifest.entries) {
    // What an empty lane would pay for it: its own corrected time plus
    // every overhead and setup that lane would open. Charging only the
    // test's own time would schedule an identity whose suite, unit, and
    // capabilities together put the lane past the bound it is killed at.
    const cost = loneCost(manifest, input, entry);
    if (cost <= bound) continue;
    // That whole figure is what is reported, so whoever reads it is told
    // the number the bound was compared against.
    unschedulable.push({ test: entry.test, suite: entry.suite, cost });
    beyondBound.add(testIdentityKey(entry.test));
  }

  // What must not run, unless the change touches what it covers, in which
  // case it is very likely a fix and must be allowed to prove itself.
  const excluded = new Set<string>(beyondBound);
  for (const held of manifest.withheld) {
    const key = testIdentityKey(held.test);
    if (!input.mandatory.has(key)) excluded.add(key);
  }
  for (const entry of manifest.entries) {
    const key = testIdentityKey(entry.test);
    if (entry.flakeRate > FLAKE_EXCLUSION_RATE && !input.mandatory.has(key)) {
      excluded.add(key);
    }
  }

  const taken = new Set<string>();
  const remaining = (): ManifestEntry[] =>
    manifest.entries.filter((entry) => {
      const key = testIdentityKey(entry.test);
      return !taken.has(key) && !excluded.has(key);
    });

  // An identity the manifest has never heard of still has to run, and the
  // caller says so by naming it mandatory. It has no entry, so one is
  // made for it at the floor, costing nothing anybody measured.
  for (const [key, reason] of input.mandatory) {
    // Not even a mandatory identity is placed past the hard bound: the
    // lane would be killed and the run would report a timeout rather than
    // the test.
    if (beyondBound.has(key)) continue;
    // An identity the manifest has never heard of is exactly the one that
    // must run: records exist only for tests that ran, and a renamed test
    // is unknown until an alias lands. Dropping it here would break the
    // rule the caller invoked by naming it mandatory, so it is carried on
    // an entry standing in for the history it has none of — the floor
    // score, and no measured cost, which is what an unrun test costs as
    // far as anything here knows.
    const entry = byKey.get(key) ?? unknownEntry(key, input);
    if (entry === undefined) continue;
    taken.add(key);
    // Mandatory work runs once. A repeat covers nothing a measured run
    // did not, and this pass is the one allowed to exceed the budget.
    place(input, lanes, entry, reason, 1);
  }
  const mandatoryLoad = laneLoad(lanes);
  const overBudget = Math.max(0, mandatoryLoad - budget);

  // The three shares are of what the mandatory pass left, so a change
  // that forced a great deal of work in does not then get a full budget
  // of discretionary tests on top of it.
  const left = Math.max(0, budget - mandatoryLoad);
  const withRepeats = (entry: ManifestEntry): number => entry.repeats;

  // Value first: descending score, ignoring cost.
  fill(
    input,
    lanes,
    taken,
    remaining().sort((a, b) => b.score - a.score),
    "value",
    mandatoryLoad + left * FILL_VALUE_SHARE,
    withRepeats,
  );

  // Density: descending value per second, which the value floor points at
  // the cheap tail.
  fill(
    input,
    lanes,
    taken,
    remaining().sort((a, b) =>
      b.score / Math.max(b.cost, 1e-6) - a.score / Math.max(a.cost, 1e-6)
    ),
    "density",
    mandatoryLoad + left * (FILL_VALUE_SHARE + FILL_DENSITY_SHARE),
    withRepeats,
  );

  // Exploration: a seeded draw over what the value ordering did not pick,
  // so the whole corpus is swept over time rather than sampled with
  // replacement forever.
  const pool = remaining();
  const order = seededOrder(manifest.seed, pool.length);
  fill(
    input,
    lanes,
    taken,
    order.map((i) => pool[i]!),
    "exploration",
    mandatoryLoad +
      left * (FILL_VALUE_SHARE + FILL_DENSITY_SHARE + FILL_EXPLORATION_SHARE),
    withRepeats,
  );

  return {
    lanes: lanes.map((lane) => ({
      lane: lane.lane,
      selections: lane.selections,
      projectedSeconds: lane.load,
      capabilities: [...lane.capabilities].sort(),
    })),
    withheld: manifest.withheld,
    overBudgetSeconds: overBudget,
    unschedulable,
  };
}

/**
 * A stand-in entry for an identity the manifest does not carry. The
 * caller says where it runs, because only the topology knows; without
 * that the identity cannot be placed and is reported rather than run.
 */
function unknownEntry(
  key: string,
  input: PlanInput,
): ManifestEntry | undefined {
  const surface = input.unknown?.get(key);
  if (surface === undefined) return undefined;
  let test: TestIdentity;
  try {
    const [k, s, n, v] = JSON.parse(key) as string[];
    if (
      typeof k !== "string" || typeof s !== "string" || typeof n !== "string"
    ) {
      return undefined;
    }
    test = v === undefined ? { k, s, n } : { k, s, n, v };
  } catch {
    return undefined;
  }
  return {
    test,
    suite: surface.suite,
    unit: surface.unit,
    cost: 0,
    score: VALUE_FLOOR,
    inputs: { catches: 0, mainCatches: 0, sources: 0, churn: 0 },
    flakeRate: 0,
    repeats: 1,
  };
}

function laneLoad(lanes: readonly Filling[]): number {
  return lanes.reduce((total, lane) => total + lane.load, 0);
}

function fill(
  input: PlanInput,
  lanes: Filling[],
  taken: Set<string>,
  candidates: readonly ManifestEntry[],
  reason: SelectionReason,
  ceiling: number,
  repeatsOf: (entry: ManifestEntry) => number,
): void {
  for (const entry of candidates) {
    const key = testIdentityKey(entry.test);
    if (taken.has(key)) continue;
    // An identity that would be repeated but no longer fits runs once:
    // one observation beats none.
    let repeats = repeatsOf(entry);
    while (repeats > 1 && !fits(input, lanes, entry, repeats, ceiling)) {
      repeats--;
    }
    if (!fits(input, lanes, entry, repeats, ceiling)) continue;
    taken.add(key);
    place(input, lanes, entry, reason, repeats);
  }
}
