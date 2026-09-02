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

  /**
   * Seconds of work this lane is expected to take, setup included. It
   * stops at the lane budget, except for a lane holding a single identity
   * costing more than that, which runs up to the hard bound, and for a
   * mandatory set that fits in no lane, which `overBudgetSeconds` reports.
   */
  projectedSeconds: number;

  /** The capabilities its batches need, in a stable order. */
  capabilities: string[];
}

/** The whole plan, and what it declined to run. */
export interface Plan {
  lanes: LaneAssignment[];

  /** Identities the manifest withheld, so a lane can say why. */
  withheld: Manifest["withheld"];

  /**
   * Seconds by which the mandatory pass alone put the longest lane past a
   * lane's budget, and zero where every lane held what it was given. The
   * longest lane is what a pull request waits on, which is why this is
   * that figure rather than the amount the five lanes' total was overrun
   * by.
   */
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

  /** How many lanes to fill, at least one. Defaults to the dial. */
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

  /** The suites whose overheads this lane has paid. */
  suites: Set<string>;

  /** The invocation units whose overheads this lane has paid. */
  units: Set<string>;

  /** Seconds of work placed here so far. */
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

/** A lane an identity could go in, and what it would cost there. */
interface Spot {
  lane: Filling;
  cost: number;
}

/**
 * What a lane may hold. A lane running one identity once and nothing else
 * may go up to the hard bound, which is where an identity costing more
 * than a whole lane's budget runs: it cannot be split, so a lane to
 * itself is the only place it goes. A repeat can be split — dropping one
 * run of it is what `fill` does — so a lane repeating an identity stops
 * at the budget like any other.
 */
function capacity(
  lane: Filling,
  repeats: number,
  laneBudget: number,
  bound: number,
): number {
  return lane.selections.length === 0 && repeats === 1 ? bound : laneBudget;
}

/**
 * Where this identity could go.
 *
 * `fitting` is the cheapest lane that can still hold it inside that
 * lane's own capacity, which is what makes tests needing the same
 * environment group together rather than being a special case in the
 * packer. Lanes of equal cost are separated by load, so the emptier one
 * wins.
 *
 * `shortest` is the lane the identity would leave shortest, whether or
 * not that lane can hold it. Only the mandatory pass uses it, and only
 * when nothing fits: that pass may put a lane past its budget, and
 * putting the overrun where the finishing time rises least is what keeps
 * the longest lane down.
 */
function spotsFor(
  input: PlanInput,
  lanes: readonly Filling[],
  entry: ManifestEntry,
  repeats: number,
  laneBudget: number,
  bound: number,
): { fitting?: Spot; shortest?: Spot } {
  let fitting: Spot | undefined;
  let shortest: Spot | undefined;
  for (const lane of lanes) {
    const cost = marginalCost(input.manifest, input, lane, entry, repeats);
    if (
      shortest === undefined ||
      lane.load + cost < shortest.lane.load + shortest.cost
    ) {
      shortest = { lane, cost };
    }
    if (lane.load + cost > capacity(lane, repeats, laneBudget, bound)) {
      continue;
    }
    if (
      fitting === undefined || cost < fitting.cost ||
      (cost === fitting.cost && lane.load < fitting.lane.load)
    ) {
      fitting = { lane, cost };
    }
  }
  return { fitting, shortest };
}

function place(
  input: PlanInput,
  spot: Spot,
  entry: ManifestEntry,
  reason: SelectionReason,
  repeats: number,
): void {
  const lane = spot.lane;
  lane.selections.push({ entry, reason, repeats });
  lane.load += spot.cost;
  lane.suites.add(entry.suite);
  lane.units.add(entry.unit);
  for (const capability of input.capabilities.get(entry.suite) ?? []) {
    lane.capabilities.add(capability);
  }
}

/**
 * Works out what runs, and where.
 *
 * Four passes in order. Mandatory first, which can in principle put a
 * lane past its budget and says how far past rather than silently
 * dropping work.
 * Then value, ignoring cost, which is what gets the expensive genuinely
 * broken integration test into the run. Then density, which sweeps up the
 * cheap tail the value floor puts at the top of the value-per-second
 * ordering. Then exploration, so the unselected corpus keeps producing
 * data.
 *
 * What the last three passes may spend is a share of the whole run's
 * budget rather than of each lane's, so an expensive test can have a lane
 * to itself while the others carry the tail. What keeps any one lane from
 * running long is separate from the shares: those three passes put no
 * work in a lane past that lane's budget, and the lane that carries an
 * identity costing more than a whole lane's budget carries that identity
 * and nothing else. Together they make every lane finish near the budget,
 * which is the number the pull request waits on. The mandatory pass is
 * bounded by neither, and reports how far past a lane it went.
 */
export function plan(input: PlanInput): Plan {
  const manifest = input.manifest;
  const laneCount = input.lanes ?? LANES;
  // Every pass below reaches for a lane to put work in, so there has to
  // be one.
  if (laneCount < 1) {
    throw new RangeError(
      `a plan needs a lane to fill, and was asked for ${laneCount}`,
    );
  }
  const laneBudget = input.budgetSeconds ?? LANE_BUDGET_SECONDS;
  const budget = laneBudget * laneCount;
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

  const required: {
    key: string;
    reason: SelectionReason;
    entry: ManifestEntry;
    cost: number;
  }[] = [];
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
    required.push({
      key,
      reason,
      entry,
      cost: loneCost(manifest, input, entry),
    });
  }

  // Longest-processing-time scheduling, which wants the largest piece of
  // work placed first: an expensive identity offered a set of lanes that
  // are already full has nowhere to go but past one lane's budget, where
  // the same identity offered empty lanes fits inside one. Every
  // mandatory identity runs whatever the order, so ordering this pass
  // decides only where the work lands. The key breaks ties, so two
  // identities costing the same are ordered the same way in every lane.
  required.sort((a, b) =>
    b.cost - a.cost || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  );

  for (const { key, reason, entry } of required) {
    // Mandatory work runs once. A repeat covers nothing a measured run
    // did not, and this pass is the one allowed to put a lane past its
    // budget: it takes a lane that can hold the work where there is one,
    // and the lane it leaves shortest where there is not.
    const spots = spotsFor(input, lanes, entry, 1, laneBudget, bound);
    // Every lane is a candidate for work that fits in none of them, and
    // there is at least one lane, so there is always a shortest.
    const spot = spots.fitting ?? spots.shortest!;
    taken.add(key);
    place(input, spot, entry, reason, 1);
  }
  const mandatoryLoad = laneLoad(lanes);
  // A mandatory set larger than the whole run's budget leaves some lane
  // past its own share of it, so measuring the longest lane reports that
  // case as well as the case the total misses: work that fits the run
  // between them but that no one lane can hold its part of.
  const overBudget = lanes.reduce(
    (most, lane) => Math.max(most, lane.load - laneBudget),
    0,
  );

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
    laneBudget,
    bound,
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
    laneBudget,
    bound,
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
    laneBudget,
    bound,
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

/**
 * Takes candidates in the order given, up to this pass's share of the
 * whole run's budget and no further. The share is of the whole rather
 * than of each lane, so an expensive test can have a lane to itself while
 * the others carry the tail; what stops any one lane running long is the
 * lane's own capacity, which `spotsFor` applies.
 */
function fill(
  input: PlanInput,
  lanes: Filling[],
  taken: Set<string>,
  candidates: readonly ManifestEntry[],
  reason: SelectionReason,
  ceiling: number,
  laneBudget: number,
  bound: number,
  repeatsOf: (entry: ManifestEntry) => number,
): void {
  for (const entry of candidates) {
    const key = testIdentityKey(entry.test);
    if (taken.has(key)) continue;
    const spent = laneLoad(lanes);
    // An identity that would be repeated but no longer fits runs fewer
    // times, down to once: one observation beats none.
    for (let repeats = repeatsOf(entry); repeats >= 1; repeats--) {
      const spot = spotsFor(input, lanes, entry, repeats, laneBudget, bound)
        .fitting;
      if (spot === undefined || spent + spot.cost > ceiling) continue;
      taken.add(key);
      place(input, spot, entry, reason, repeats);
      break;
    }
  }
}
