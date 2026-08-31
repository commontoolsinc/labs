/**
 * What the record store says about one test, and what that is worth.
 *
 * A test earns its place in a pull request by having caught real breakage
 * before, so the score is built on catches and decays slowly. Deciding
 * whether a failure is a catch is the delicate part: a test that is flaky
 * on `main` produces one failure per commit and would otherwise look like
 * the most valuable test in the repository. `foldObservations` is where
 * that judgement is made, once per observation, with the state it needs
 * carried forward from the day before.
 */

import type {
  ScoreInputs,
  TestIdentity,
} from "@commonfabric/test-support/records";
import { testIdentityKey } from "@commonfabric/test-support/records";
import {
  BREADTH_SATURATION,
  CATCH_BREADTH_WINDOW_DAYS,
  CATCH_WEIGHT_LOCAL,
  CATCH_WEIGHT_MAIN,
  CATCH_WEIGHT_PR,
  CHURN_HALF_LIFE_DAYS,
  CHURN_WINDOW_DAYS,
  COST_WINDOW_DAYS,
  ENVIRONMENTAL_MIN_SOURCES,
  FLAKE_WINDOW_DAYS,
  FRESHNESS_FLOOR,
  FRESHNESS_HALF_LIFE_DAYS,
  PROVEN_SATURATION,
  VALUE_FLOOR,
  WEIGHT_BREADTH,
  WEIGHT_CHURN,
  WEIGHT_PROVEN,
} from "./policy.ts";

/** Where a failure happened, which changes what it means. */
export type CatchPlace = "local" | "pr" | "main";

/** One execution of one test, as the publisher reads it from a report. */
export interface Observation {
  test: TestIdentity;
  outcome: "pass" | "fail" | "skip";
  durationMs: number;

  /** UTC calendar day, "yyyy-mm-dd". */
  day: string;

  /** The commit the tests ran against. */
  commit: string;

  /**
   * Who saw it: the branch for a continuous-integration run, the
   * reporting person's login for a local one.
   */
  source: string;

  /** Where it ran, which is what a catch there is worth. */
  place: CatchPlace;
}

/** What one identity's history has accumulated. */
export interface IdentityState {
  /** Catches, counted separately by where each happened. */
  localCatches: number;
  prCatches: number;
  mainCatches: number;

  /** The day of the most recent catch, absent when there are none. */
  lastCatch?: string;

  /** The distinct sources among the catches. */
  sources: string[];

  /** Failures and runs per day, for the churn term. */
  failuresByDay: Record<string, number>;
  runsByDay: Record<string, number>;

  /** Flake observations per day, against the failures of the same day. */
  flakesByDay: Record<string, number>;

  /**
   * The ninetieth percentile of the day's measured durations, in
   * milliseconds, and how many executions it was taken over. A day is
   * the unit because keeping every duration would make the state object
   * grow with the number of runs rather than with the number of tests.
   */
  costByDay: Record<string, { p90: number; count: number }>;

  /** The outcome of the most recent `main` run this identity appeared in. */
  lastMainOutcome?: "pass" | "fail" | "skip";

  /**
   * Failures on `main` that no later `main` run has judged yet. A
   * failure that the next `main` run passes was fixed by the change
   * between them, which makes it a catch; one that is still failing is
   * the same breakage continuing, and waits.
   */
  pendingMain: Array<{ day: string; commit: string; source: string }>;
}

/** A fresh, empty history. */
export function emptyState(): IdentityState {
  return {
    localCatches: 0,
    prCatches: 0,
    mainCatches: 0,
    sources: [],
    failuresByDay: {},
    runsByDay: {},
    flakesByDay: {},
    costByDay: {},
    pendingMain: [],
  };
}

/** Days between two "yyyy-mm-dd" days, `later` minus `earlier`. */
export function daysBetween(earlier: string, later: string): number {
  const from = Date.parse(`${earlier}T00:00:00Z`);
  const to = Date.parse(`${later}T00:00:00Z`);
  return Math.round((to - from) / 86_400_000);
}

/**
 * The ninetieth percentile of a list of durations, by nearest rank. The
 * ninetieth rather than the maximum, because one unlucky runner should
 * not permanently inflate an estimate, and rather than the mean, because
 * a cost model that under-estimates blows the time budget.
 */
export function percentile90(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(0.9 * sorted.length);
  return sorted[Math.max(0, rank - 1)]!;
}

function addSource(state: IdentityState, source: string): void {
  if (!state.sources.includes(source)) state.sources.push(source);
}

function creditCatch(
  state: IdentityState,
  place: CatchPlace,
  day: string,
  source: string,
): void {
  if (place === "local") state.localCatches++;
  else if (place === "pr") state.prCatches++;
  else state.mainCatches++;
  if (state.lastCatch === undefined || state.lastCatch < day) {
    state.lastCatch = day;
  }
  addSource(state, source);
}

function bump(counts: Record<string, number>, day: string): void {
  counts[day] = (counts[day] ?? 0) + 1;
}

/**
 * Whether anything a test covers changed between two `main` commits. The
 * coverage attribution map is what answers this; without one the answer
 * is yes, which errs toward calling a failure a catch.
 */
export type CoveredChange = (
  identity: string,
  fromCommit: string,
  toCommit: string,
) => boolean;

/**
 * Judges the failures on `main` that were waiting for a later `main` run.
 * A failure the next run still shows is the same breakage continuing, so
 * it keeps waiting and nothing new is learned. A failure the next run
 * does not show either went away by itself, which is a flake, or was
 * fixed by the change between the two, which is a catch.
 */
function resolvePendingMain(
  state: IdentityState,
  key: string,
  observation: Observation,
  coveredChanged: CoveredChange,
): void {
  if (state.pendingMain.length === 0) return;
  if (observation.outcome === "fail") return;
  for (const pending of state.pendingMain) {
    if (pending.commit === observation.commit) continue;
    if (coveredChanged(key, pending.commit, observation.commit)) {
      creditCatch(state, "main", pending.day, pending.source);
    } else {
      bump(state.flakesByDay, pending.day);
    }
  }
  state.pendingMain = [];
}

/** How a batch of observations was judged. */
export interface FoldResult {
  states: Map<string, IdentityState>;

  /** Identities failing in the most recent `main` run that named them. */
  mainRed: Set<string>;
}

/**
 * The cross-batch context two of the rules need. A batch cannot be judged
 * on its own: whether an identity disagreed with itself at a commit, and
 * whether a failure spans enough sources to read as the environment, are
 * both questions about observations that may sit in another batch. A
 * caller folding a stream carries one of these along and trims it.
 */
export interface FoldContext {
  /** Every outcome seen for one identity at one commit, with its day. */
  outcomesAtCommit: Map<string, { day: string; outcomes: Set<string> }>;

  /** Where and when each identity has been seen failing. */
  failures: Map<string, Array<{ day: string; source: string }>>;

  /** The commit and source pairs a catch has already been credited to. */
  credited: Set<string>;
}

/** A context holding nothing, for a fold with no history behind it. */
export function emptyContext(): FoldContext {
  return {
    outcomesAtCommit: new Map(),
    failures: new Map(),
    credited: new Set(),
  };
}

/**
 * Drops what the two rules can no longer reach. Both look back at most
 * `CATCH_BREADTH_WINDOW_DAYS`, so anything older than that cannot change
 * a verdict, and a stream that never trimmed would grow with the number
 * of runs rather than with the number of tests.
 */
export function trimContext(context: FoldContext, today: string): void {
  const stale = (day: string) =>
    daysBetween(day, today) > CATCH_BREADTH_WINDOW_DAYS;
  for (const [key, seen] of context.failures) {
    const kept = seen.filter((failure) => !stale(failure.day));
    if (kept.length === 0) context.failures.delete(key);
    else context.failures.set(key, kept);
  }
  for (const [at, seen] of context.outcomesAtCommit) {
    if (stale(seen.day)) context.outcomesAtCommit.delete(at);
  }
}

/** What a fold may be told beyond the observations themselves. */
export interface FoldOptions {
  /** The state each identity's history had reached before this batch. */
  prior?: Map<string, IdentityState>;

  /** How to tell a fixed failure on `main` from one that healed itself. */
  coveredChanged?: CoveredChange;

  /** What earlier batches of the same stream saw. */
  context?: FoldContext;
}

/**
 * Folds a batch of observations into per-identity state.
 *
 * The observations must be in ascending time order, because the rules
 * that decide whether a failure is a catch look backwards at what `main`
 * last said and forwards at what it says next. Observations at one commit
 * are considered together: an identity that both passed and failed there
 * disagreed with itself, which is a flake observation and never a catch.
 */
export function foldObservations(
  observations: readonly Observation[],
  options: FoldOptions = {},
): FoldResult {
  const states = options.prior ?? new Map<string, IdentityState>();
  const coveredChanged = options.coveredChanged ?? (() => true);
  const context = options.context ?? emptyContext();
  const stateOf = (key: string): IdentityState => {
    let state = states.get(key);
    if (state === undefined) {
      state = emptyState();
      states.set(key, state);
    }
    return state;
  };

  // Same-commit disagreement, and the sources a failing identity appeared
  // on inside the environmental window, both need the whole batch in view
  // before any one observation can be judged.
  const outcomesAtCommit = context.outcomesAtCommit;
  const failures = context.failures;
  for (const observation of observations) {
    const key = testIdentityKey(observation.test);
    const at = `${key} ${observation.commit}`;
    let seen = outcomesAtCommit.get(at);
    if (seen === undefined) {
      seen = { day: observation.day, outcomes: new Set() };
      outcomesAtCommit.set(at, seen);
    }
    seen.outcomes.add(observation.outcome);
    if (observation.outcome === "fail") {
      const list = failures.get(key) ?? [];
      list.push({ day: observation.day, source: observation.source });
      failures.set(key, list);
    }
  }

  const environmental = (key: string, day: string, source: string): boolean => {
    const nearby = new Set<string>([source]);
    for (const failure of failures.get(key) ?? []) {
      if (Math.abs(daysBetween(failure.day, day)) > CATCH_BREADTH_WINDOW_DAYS) {
        continue;
      }
      nearby.add(failure.source);
    }
    return nearby.size >= ENVIRONMENTAL_MIN_SOURCES;
  };

  // A catch is attributed to the pair of the commit and the source that
  // saw it, so re-running one broken commit ten times counts once.
  const credited = context.credited;

  for (const observation of observations) {
    const key = testIdentityKey(observation.test);
    const state = stateOf(key);
    const day = observation.day;

    // A skip is a test that deliberately did not run. It says nothing
    // about the test and nothing about the change.
    if (observation.outcome === "skip") continue;

    bump(state.runsByDay, day);
    recordDuration(state, day, observation.durationMs);
    if (observation.place === "main") {
      resolvePendingMain(state, key, observation, coveredChanged);
      state.lastMainOutcome = observation.outcome;
    }
    if (observation.outcome === "pass") continue;

    bump(state.failuresByDay, day);

    const seen = outcomesAtCommit.get(`${key} ${observation.commit}`);
    if ((seen?.outcomes.size ?? 0) > 1) {
      // It passed and failed at one commit, with nothing between the two
      // runs but chance.
      bump(state.flakesByDay, day);
      continue;
    }
    if (environmental(key, day, observation.source)) continue;
    if (observation.place !== "main" && state.lastMainOutcome === "fail") {
      // Already broken on `main`, so this run learned nothing about the
      // change in front of it.
      continue;
    }
    if (observation.place === "main") {
      // Whether this was a catch depends on what the next `main` run
      // says, so it waits.
      state.pendingMain.push({
        day,
        commit: observation.commit,
        source: observation.source,
      });
      continue;
    }
    const attribution = `${key} ${observation.commit} ${observation.source}`;
    if (credited.has(attribution)) continue;
    credited.add(attribution);
    creditCatch(state, observation.place, day, observation.source);
  }

  const mainRed = new Set<string>();
  for (const [key, state] of states) {
    if (state.lastMainOutcome === "fail") mainRed.add(key);
  }
  return { states, mainRed };
}

/**
 * Folds one duration into the day's percentile. The running value is the
 * larger of what the day held and this execution, which converges on the
 * day's own ninetieth percentile from below without keeping the samples;
 * `sealDay` is what replaces it with the exact figure when the day's
 * observations are all in hand.
 */
function recordDuration(
  state: IdentityState,
  day: string,
  durationMs: number,
): void {
  const sample = state.costByDay[day];
  if (sample === undefined) {
    state.costByDay[day] = { p90: durationMs, count: 1 };
    return;
  }
  sample.count++;
  if (durationMs > sample.p90) sample.p90 = durationMs;
}

/**
 * How many of a day's slowest executions are kept for one identity. The
 * ninetieth percentile sits inside the slowest tenth, so keeping this
 * many is exact for any day with up to ten times as many executions, and
 * an identity runs about 250 times a day across the whole matrix. Past
 * that the estimate falls back to the smallest sample kept, which
 * over-estimates, and over-estimating is the safe direction for a budget.
 */
export const COST_SAMPLE_CAP = 64;

/** The slowest executions of one identity on one day, and how many ran. */
export interface DaySamples {
  /** Ascending, at most `COST_SAMPLE_CAP` of them. */
  slowest: number[];
  count: number;
}

/** A fresh, empty sample. */
export function emptySamples(): DaySamples {
  return { slowest: [], count: 0 };
}

/** Folds one duration into a day's bounded sample of its slowest runs. */
export function sampleDuration(samples: DaySamples, durationMs: number): void {
  samples.count++;
  if (
    samples.slowest.length === COST_SAMPLE_CAP &&
    durationMs <= samples.slowest[0]!
  ) {
    return;
  }
  let at = samples.slowest.length;
  while (at > 0 && samples.slowest[at - 1]! > durationMs) at--;
  samples.slowest.splice(at, 0, durationMs);
  if (samples.slowest.length > COST_SAMPLE_CAP) samples.slowest.shift();
}

/**
 * The ninetieth percentile of a day, from its bounded sample. Exact while
 * the percentile's rank falls inside what was kept; past that it is the
 * smallest kept sample, which is an over-estimate.
 */
export function sampledPercentile90(samples: DaySamples): number {
  if (samples.count === 0) return 0;
  const rank = Math.ceil(0.9 * samples.count);
  const fromTop = samples.count - rank;
  const index = samples.slowest.length - 1 - fromTop;
  return samples.slowest[Math.max(0, index)] ?? 0;
}

/**
 * Replaces a day's cost with the ninetieth percentile of the durations
 * given. Called once per identity per day, with that day's whole set, by
 * whoever folded it.
 */
export function sealDay(
  state: IdentityState,
  day: string,
  durationsMs: readonly number[] | DaySamples,
): void {
  if (Array.isArray(durationsMs)) {
    if (durationsMs.length === 0) return;
    state.costByDay[day] = {
      p90: percentile90(durationsMs),
      count: durationsMs.length,
    };
    return;
  }
  const samples = durationsMs as DaySamples;
  if (samples.count === 0) return;
  state.costByDay[day] = {
    p90: sampledPercentile90(samples),
    count: samples.count,
  };
}

/** Ages a state's per-day counters, dropping days past their windows. */
export function trimWindows(state: IdentityState, today: string): void {
  const drop = (counts: Record<string, unknown>, windowDays: number): void => {
    for (const day of Object.keys(counts)) {
      if (daysBetween(day, today) > windowDays) delete counts[day];
    }
  };
  drop(state.runsByDay, CHURN_WINDOW_DAYS);
  drop(state.failuresByDay, CHURN_WINDOW_DAYS);
  drop(state.flakesByDay, FLAKE_WINDOW_DAYS);
  drop(state.costByDay, COST_WINDOW_DAYS);
}

/**
 * The churn term: recent failures over recent runs, with each day's
 * counts halved every `CHURN_HALF_LIFE_DAYS` as they age. Decayed rather
 * than cut off at a window's edge, because a ratio over a long window
 * measures total historical brokenness rather than the current rate. A
 * week of failures eight months ago would otherwise outrank a test that
 * is failing right now.
 */
export function churn(state: IdentityState, today: string): number {
  let failures = 0;
  let runs = 0;
  for (const [day, count] of Object.entries(state.runsByDay)) {
    const age = daysBetween(day, today);
    if (age > CHURN_WINDOW_DAYS) continue;
    const weight = 0.5 ** (age / CHURN_HALF_LIFE_DAYS);
    runs += count * weight;
    failures += (state.failuresByDay[day] ?? 0) * weight;
  }
  return runs === 0 ? 0 : failures / runs;
}

/** The share of a test's failures that were flake observations. */
export function flakeRate(state: IdentityState, today: string): number {
  let failures = 0;
  let flakes = 0;
  for (const [day, count] of Object.entries(state.failuresByDay)) {
    if (daysBetween(day, today) > FLAKE_WINDOW_DAYS) continue;
    failures += count;
    flakes += state.flakesByDay[day] ?? 0;
  }
  return failures === 0 ? 0 : flakes / failures;
}

/**
 * What one execution of this identity costs, in seconds: the largest of
 * the days' ninetieth percentiles inside the cost window. Largest rather
 * than averaged, because a cost model that under-estimates blows the time
 * budget, and each day's own percentile has already absorbed that day's
 * unlucky runners.
 */
export function costSeconds(state: IdentityState, today: string): number {
  let worst = 0;
  for (const [day, sample] of Object.entries(state.costByDay)) {
    if (daysBetween(day, today) > COST_WINDOW_DAYS) continue;
    if (sample.p90 > worst) worst = sample.p90;
  }
  return worst / 1000;
}

export type { ScoreInputs };

/** The score's inputs for one identity, as of a given day. */
export function scoreInputs(
  state: IdentityState,
  today: string,
): ScoreInputs {
  const inputs: ScoreInputs = {
    catches: CATCH_WEIGHT_LOCAL * state.localCatches +
      CATCH_WEIGHT_PR * state.prCatches +
      CATCH_WEIGHT_MAIN * state.mainCatches,
    mainCatches: state.mainCatches,
    sources: state.sources.length,
    churn: churn(state, today),
  };
  if (state.lastCatch !== undefined) inputs.lastCatch = state.lastCatch;
  return inputs;
}

/**
 * What a test is worth running.
 *
 * The no-catch branch is not decoration. A test with no catches has no
 * `lastCatch`, so the age of its most recent one does not exist, and
 * multiplying zero by a missing number yields a missing number rather
 * than zero. A missing score sorts unpredictably against real ones, so
 * the branch is written rather than left to the algebra.
 */
export function value(inputs: ScoreInputs, today: string): number {
  let record = 0;
  if (inputs.catches > 0 && inputs.lastCatch !== undefined) {
    const proven = 1 - 0.5 ** (inputs.catches / PROVEN_SATURATION);
    const age = daysBetween(inputs.lastCatch, today);
    const freshness = FRESHNESS_FLOOR +
      (1 - FRESHNESS_FLOOR) * 0.5 ** (age / FRESHNESS_HALF_LIFE_DAYS);
    record = proven * freshness;
  }
  const breadth = 1 - 0.5 ** (inputs.sources / BREADTH_SATURATION);
  return VALUE_FLOOR + WEIGHT_PROVEN * record + WEIGHT_BREADTH * breadth +
    WEIGHT_CHURN * inputs.churn;
}
