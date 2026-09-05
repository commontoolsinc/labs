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

import { testIdentityKey } from "@commonfabric/test-support/records";
import {
  FILL_DENSITY_SHARE,
  FILL_EXPLORATION_SHARE,
  FILL_VALUE_SHARE,
  FLAKE_EXCLUSION_RATE,
  FULL_LANE_BOUND_SECONDS,
  FULL_LANE_BUDGET_SECONDS,
  LANE_BOUND_SECONDS,
  LANE_BUDGET_SECONDS,
  LANES,
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
  | "exploration"
  | "full";

/**
 * How much of the corpus a plan runs, which is the whole of the
 * difference between what a pull request runs and what `main` runs.
 *
 * `budgeted` spends a bounded amount on the tests worth the most, which
 * is the four passes below. `everything` runs the corpus it was given,
 * once each. Under `everything` every identity is required, so the
 * exclusions and the three discretionary passes have nothing to act on
 * and the rest of this file behaves the same way for both. Keeping the
 * difference to one value is what stops the two runs drifting into
 * packing the same tests differently.
 */
export type Policy = "budgeted" | "everything";

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

  /**
   * Seconds each of these lanes was packed against, which the policy
   * decides. Carried here so that whatever reports a lane's projected
   * time reports it against the figure it was actually judged by, rather
   * than working the figure out a second time.
   */
  budgetSeconds: number;

  /**
   * Identities this plan declined to run, so a lane can say why. Empty
   * for a full run, which declines nothing.
   */
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
   * Discretionary identities no lane can hold. One costing more than a
   * lane's planned budget is given a lane to itself and allowed to run up
   * to the hard bound; one costing more than the hard bound would only
   * time its lane out, so it is reported instead, and the sixty-second
   * rule is where such a test gets split. A mandatory identity is never
   * here, however expensive: it is placed, and `overBudgetSeconds` is
   * what says how far past its budget that put a lane.
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

  /** How much of the manifest to run. Defaults to `budgeted`. */
  policy?: Policy;

  /** How many lanes to fill, at least one. Defaults to the dial. */
  lanes?: number;

  /**
   * Seconds each lane may fill. Defaults to the dial the policy belongs
   * to, so that the full run cannot be packed against a pull request's
   * budget by leaving one field out.
   */
  budgetSeconds?: number;

  /** The hard bound on a lane's work step. Defaults to the policy's dial. */
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
  const everything = input.policy === "everything";
  const laneBudget = input.budgetSeconds ??
    (everything ? FULL_LANE_BUDGET_SECONDS : LANE_BUDGET_SECONDS);
  const budget = laneBudget * laneCount;
  const lanes: Filling[] = Array.from({ length: laneCount }, (_, i) => ({
    lane: i + 1,
    selections: [],
    capabilities: new Set<string>(),
    suites: new Set<string>(),
    units: new Set<string>(),
    load: 0,
  }));

  const bound = input.boundSeconds ??
    (everything ? FULL_LANE_BOUND_SECONDS : LANE_BOUND_SECONDS);
  const byKey = new Map<string, ManifestEntry>();
  for (const entry of manifest.entries) {
    byKey.set(testIdentityKey(entry.test), entry);
  }

  // What runs whatever anything else says. A full run is the case where
  // that is the whole corpus, which is why it needs no pass of its own:
  // the mandatory pass below places every identity, and the three
  // discretionary passes then find nothing left to take.
  const requiredOf: ReadonlyMap<string, SelectionReason> = everything
    ? new Map(
      manifest.entries.map((
        entry,
      ) => [testIdentityKey(entry.test), "full" as SelectionReason]),
    )
    : input.mandatory;

  // An identity whose own measured time is past the hard bound shares a
  // lane with nothing, so a discretionary one is reported rather than
  // placed in a lane that would then be killed at its bound. A mandatory
  // one is placed anyway: the change is not tested without it, and a lane
  // running long says so, where dropping it leaves the run reporting a
  // pass over a test that never ran. Its suite's correction is applied
  // first, because that is what the time will actually be.
  const unschedulable: UnschedulableEntry[] = [];
  for (const entry of manifest.entries) {
    if (requiredOf.has(testIdentityKey(entry.test))) continue;
    // What an empty lane would pay for it: its own corrected time plus
    // every overhead and setup that lane would open. Charging only the
    // test's own time would schedule an identity whose suite, unit, and
    // capabilities together put the lane past the bound it is killed at.
    const cost = loneCost(manifest, input, entry);
    if (cost <= bound) continue;
    // That whole figure is what is reported, so whoever reads it is told
    // the number the bound was compared against.
    unschedulable.push({ test: entry.test, suite: entry.suite, cost });
  }

  // What must not run, unless the change touches what it covers, in which
  // case it is very likely a fix and must be allowed to prove itself.
  const excluded = new Set<string>(
    unschedulable.map((entry) => testIdentityKey(entry.test)),
  );
  for (const held of manifest.withheld) {
    const key = testIdentityKey(held.test);
    if (!requiredOf.has(key)) excluded.add(key);
  }
  for (const entry of manifest.entries) {
    const key = testIdentityKey(entry.test);
    if (entry.flakeRate > FLAKE_EXCLUSION_RATE && !requiredOf.has(key)) {
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
  for (const [key, reason] of requiredOf) {
    // An identity the manifest does not carry cannot be placed, because
    // nothing here knows which suite would run it. Whoever enumerated the
    // working tree carries a stand-in entry for every unit it holds, so
    // reaching this without one means the caller named something
    // mandatory and handed over a corpus that does not contain it.
    //
    // Skipping it instead would drop a test that must run and say
    // nothing, and a run reporting a pass over a test that never ran is
    // the one failure of this design that would leave no trace. Every
    // identity being placed once it is required is then what makes the
    // full run complete, so that needs no separate check afterwards.
    const entry = byKey.get(key);
    if (entry === undefined) {
      throw new Error(
        `${key} must run, and the corpus this was given does not carry ` +
          `it, so nothing here knows what would run it`,
      );
    }
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

  // Exploration: a draw over what the value ordering did not pick, so
  // the whole corpus is swept over time rather than sampled with
  // replacement forever.
  //
  // Longest-unrun first, with the seeded shuffle breaking ties. Sweeping
  // is what the ordering buys: a test the draw reaches goes to the back
  // of the queue until everything else has had a turn, where a shuffle
  // alone would keep drawing from the whole corpus and leave part of it
  // unvisited for as long as chance allowed. It also covers whatever the
  // value model is currently blind to, without anything having to know
  // what that is.
  const pool = remaining();
  const order = seededOrder(manifest.seed, pool.length);
  const drawn = order.map((i) => pool[i]!);
  // An identity nothing has run inside the aggregate's reach carries no
  // day at all, and it is the one most worth drawing, so it sorts ahead
  // of every day there is.
  drawn.sort((a, b) => (a.lastRun ?? "").localeCompare(b.lastRun ?? ""));
  fill(
    input,
    lanes,
    taken,
    drawn,
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
    budgetSeconds: laneBudget,
    // A full run withholds nothing: every identity is required, so the
    // reasons the manifest gives for holding one back never applied.
    // Reporting the manifest's list here would have a run that ran a
    // test say in its own summary that no lane chose it.
    withheld: everything ? [] : manifest.withheld,
    overBudgetSeconds: overBudget,
    unschedulable,
  };
}

/**
 * How many lanes the full run needs.
 *
 * A pull request has a fixed number of lanes, so each one works out its
 * own share and no job sits ahead of them. `main` cannot: the number
 * depends on how much work there is, and the job matrix has to be known
 * before anything starts. So one job answers this, and an integer is the
 * whole of what it answers. The lanes then call `plan` over the same
 * manifest and take their own share of it, exactly as the pull-request
 * lanes do, so there is no second packing anywhere that could disagree
 * with the first.
 *
 * The search starts at the fewest lanes the work could conceivably fit
 * in and adds one while that helps. What it measures is the total by
 * which the lanes are over budget rather than the worst single lane: a
 * test costing more than a whole lane holds its own lane over budget at
 * every count, so the worst lane stops moving while every other lane is
 * still crowded, and a search reading the worst lane would stop there
 * and leave the rest of the run packed twice as tight as it asked for.
 * The total keeps falling while lanes are still worth adding and stops
 * falling once only the unsplittable part is left, which is where the
 * search stops. It terminates on that total, which cannot fall below
 * zero, and on one lane per identity being the finest packing there is.
 */
export function fullLaneCount(
  input: Omit<PlanInput, "policy" | "lanes" | "mandatory">,
): number {
  const manifest = input.manifest;
  const budget = input.budgetSeconds ?? FULL_LANE_BUDGET_SECONDS;
  // The tests' own corrected time, with no lane overhead in it. Every
  // overhead a lane pays only raises the answer, so this is a floor and
  // starting below it would measure packings that cannot fit.
  const work = manifest.entries.reduce(
    (total, entry) =>
      total + entry.cost *
        (manifest.calibration.suites[entry.suite]?.correction ?? 1),
    0,
  );
  const most = Math.max(1, manifest.entries.length);
  let count = Math.min(most, Math.max(1, Math.ceil(work / budget)));
  const packed = (lanes: number) =>
    plan({
      ...input,
      // Under `everything` every identity is required, so there is
      // nothing a caller could add to this that would change the answer.
      mandatory: new Map(),
      policy: "everything",
      budgetSeconds: budget,
      lanes,
    });
  /** Seconds by which the lanes are over budget, added up over all of them. */
  const overrun = (result: Plan): number =>
    result.lanes.reduce(
      (total, lane) => total + Math.max(0, lane.projectedSeconds - budget),
      0,
    );
  let best = overrun(packed(count));
  while (best > 0 && count < most) {
    const next = overrun(packed(count + 1));
    // A lane has to buy at least a second to be worth adding. Stopping
    // only on no improvement at all would let a run of ever smaller ones
    // carry the search as far as there are identities, and a lane's
    // budget is counted in seconds, so anything under one is noise.
    if (next > best - 1) break;
    count += 1;
    best = next;
  }
  return count;
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
