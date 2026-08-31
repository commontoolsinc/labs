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

  /**
   * When the run this came from started, ISO 8601 UTC. The day is what
   * the counters are kept by; this is what the order is taken from, which
   * a day is too coarse for.
   */
  startedAt: string;

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

/**
 * How long a commit stays reachable: how late a re-run of it may arrive
 * and still be recognized as one. Past this a repeated commit is judged
 * as though it were new, which errs toward calling its failure a catch.
 */
export const COMMIT_REACH_DAYS = 30;

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
  // One breakage, one catch. A test that stays red across several runs on
  // the default branch has one thing wrong with it, and the change that
  // makes it green fixed that one thing; crediting every run it failed
  // would make a long outage look like the most valuable test in the
  // repository. The first failure is the one the catch belongs to, since
  // that is where the breakage entered.
  const first = state.pendingMain.reduce((earliest, pending) =>
    pending.day < earliest.day ? pending : earliest
  );
  state.pendingMain = [];
  if (first.commit === observation.commit) {
    // The same commit, passing now and failing before, is the test
    // disagreeing with itself there. The two runs can arrive in separate
    // batches, so the same-commit check that catches this within one
    // batch does not see it, and dropping the pending failure silently
    // would lose the flake as well as the catch.
    bump(state.flakesByDay, first.day);
    return;
  }
  if (coveredChanged(key, first.commit, observation.commit)) {
    creditCatch(state, "main", first.day, first.source);
  } else {
    bump(state.flakesByDay, first.day);
  }
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

  /**
   * What the default branch said about one identity at one commit, with
   * the day. A rerun of a commit can arrive long after the run it
   * repeats, so this outlives the batch: without it, a later pass
   * elsewhere would make that rerun look like the first failure at a
   * commit the branch had already shown broken.
   */
  mainAtCommit: Map<string, { day: string; outcome: "pass" | "fail" }>;

  /**
   * The commit and source pairs a catch has already been credited to,
   * against the day it was credited on, so the set can be aged like
   * everything else here rather than growing with every catch ever made.
   */
  credited: Map<string, string>;

  /** Where and when each identity has been seen failing. */
  failures: Map<string, Array<{ day: string; source: string }>>;
}

/** A context holding nothing, for a fold with no history behind it. */
export function emptyContext(): FoldContext {
  return {
    outcomesAtCommit: new Map(),
    mainAtCommit: new Map(),
    credited: new Map(),
    failures: new Map(),
  };
}

/** A fold context as it travels between runs. */
export interface StoredFoldContext {
  outcomesAtCommit: Array<[string, { day: string; outcomes: string[] }]>;
  mainAtCommit: Array<[string, { day: string; outcome: "pass" | "fail" }]>;
  credited: Array<[string, string]>;
  failures: Array<[string, Array<{ day: string; source: string }>]>;
}

/** The outcomes a record may carry, for validating a stored context. */
const OUTCOMES = new Set(["pass", "fail", "skip"]);

/** Whether a value is a "yyyy-mm-dd" day this reader can measure from. */
function isDay(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`));
}

/** The context, flattened for the aggregate that carries it. */
export function serializeContext(context: FoldContext): StoredFoldContext {
  return {
    outcomesAtCommit: [...context.outcomesAtCommit].map((
      [at, seen],
    ) => [at, { day: seen.day, outcomes: [...seen.outcomes] }]),
    mainAtCommit: [...context.mainAtCommit],
    credited: [...context.credited],
    failures: [...context.failures],
  };
}

/**
 * The context a previous run left. Anything malformed yields an empty
 * one: a context is an optimization over re-reading, and losing it costs
 * the two cross-run rules their reach rather than any stored fact.
 */
export function parseContext(value: unknown): FoldContext {
  const context = emptyContext();
  if (typeof value !== "object" || value === null) return context;
  const stored = value as Partial<StoredFoldContext>;
  const pairs = (raw: unknown): Array<[string, unknown]> =>
    Array.isArray(raw)
      ? raw.filter((entry): entry is [string, unknown] =>
        Array.isArray(entry) && typeof entry[0] === "string"
      )
      : [];

  for (const [at, seen] of pairs(stored.outcomesAtCommit)) {
    if (typeof seen !== "object" || seen === null) continue;
    const held = seen as { day?: unknown; outcomes?: unknown };
    if (!isDay(held.day) || !Array.isArray(held.outcomes)) continue;
    // An outcome this reader does not know would read as one more thing
    // the identity did at that commit, and two of them is the test
    // disagreeing with itself — which suppresses a real catch.
    const outcomes = held.outcomes.filter((outcome): outcome is string =>
      typeof outcome === "string" && OUTCOMES.has(outcome)
    );
    if (outcomes.length === 0) continue;
    context.outcomesAtCommit.set(at, {
      day: held.day,
      outcomes: new Set(outcomes),
    });
  }
  for (const [at, seen] of pairs(stored.mainAtCommit)) {
    if (typeof seen !== "object" || seen === null) continue;
    const held = seen as { day?: unknown; outcome?: unknown };
    if (!isDay(held.day)) continue;
    if (held.outcome !== "pass" && held.outcome !== "fail") continue;
    context.mainAtCommit.set(at, { day: held.day, outcome: held.outcome });
  }
  for (const [attribution, day] of pairs(stored.credited)) {
    // A day that cannot be read cannot be aged, and an entry that is
    // never aged suppresses that catch for good.
    if (isDay(day)) context.credited.set(attribution, day);
  }
  for (const [key, seen] of pairs(stored.failures)) {
    if (!Array.isArray(seen)) continue;
    const kept = seen.filter((failure): failure is {
      day: string;
      source: string;
    } =>
      typeof failure === "object" && failure !== null &&
      isDay((failure as { day?: unknown }).day) &&
      typeof (failure as { source?: unknown }).source === "string"
    );
    if (kept.length > 0) context.failures.set(key, kept);
  }
  return context;
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
  // A commit is re-run within days of the run it repeats, not months, so
  // these age on the same window. Kept forever they would grow with the
  // number of catches the repository has ever made.
  const old = (day: string) => daysBetween(day, today) > COMMIT_REACH_DAYS;
  for (const [at, seen] of context.mainAtCommit) {
    if (old(seen.day)) context.mainAtCommit.delete(at);
  }
  for (const [attribution, day] of context.credited) {
    if (old(day)) context.credited.delete(attribution);
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
    // A skip is a test that deliberately did not run, so it agrees with
    // nothing and contradicts nothing; counting it as disagreement would
    // read a skip beside a failure as the test disagreeing with itself.
    if (observation.outcome !== "skip") seen.outcomes.add(observation.outcome);
    if (observation.outcome === "fail") {
      const list = failures.get(key) ?? [];
      list.push({ day: observation.day, source: observation.source });
      failures.set(key, list);
    }
  }

  // What the default branch said at each commit, gathered before anything
  // is judged. Otherwise a failure elsewhere at the same commit is
  // classified against whatever `main` had said *last*, which depends on
  // whether this batch happened to list the `main` run first.
  const mainAtCommit = new Map<string, "pass" | "fail" | "skip">();
  for (const observation of observations) {
    if (observation.place !== "main" || observation.outcome === "skip") {
      continue;
    }
    const at = `${testIdentityKey(observation.test)} ${observation.commit}`;
    // A failure anywhere at one commit is the commit being broken; a pass
    // beside it does not clear that.
    if (observation.outcome === "fail" || !mainAtCommit.has(at)) {
      mainAtCommit.set(at, observation.outcome);
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
    // about the test and nothing about the change, so it does not reach
    // `lastMainOutcome` either: a test skipped on the default branch has
    // not been shown to be fixed, and the last run that did execute it is
    // the last thing known about it. That keeps a still-broken test out of
    // every pull request, which is the direction this design takes
    // whenever the two errors are a lost signal and a change that cannot
    // go green.
    if (observation.outcome === "skip") continue;

    bump(state.runsByDay, day);
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
    if (observation.place !== "main") {
      // Already broken on the default branch, so this run learned nothing
      // about the change in front of it. What that branch says at this
      // very commit outranks what it last said, and is known ahead of
      // time so that the order this batch happened to arrive in cannot
      // decide the verdict.
      const here = mainAtCommit.get(`${key} ${observation.commit}`);
      if (
        here === "fail" ||
        (here === undefined && state.lastMainOutcome === "fail")
      ) {
        continue;
      }
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
    credited.set(attribution, day);
    creditCatch(state, observation.place, day, observation.source);
  }

  const mainRed = new Set<string>();
  for (const [key, state] of states) {
    if (state.lastMainOutcome === "fail") mainRed.add(key);
  }
  return { states, mainRed };
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
 * Folds a batch of one day's durations into that day's cost.
 *
 * A day is read across as many runs as it takes for its objects to
 * arrive, so this is given part of a day at a time and has to combine
 * rather than replace: a later batch of two fast executions would
 * otherwise overwrite a morning of slow ones and understate what the
 * identity costs, which is the direction that overruns a lane.
 *
 * What it keeps is the higher percentile and the summed count. Two
 * percentiles cannot be averaged into the percentile of their union
 * without the samples behind them, and of the two answers available the
 * larger is the one a time budget survives.
 */
export function sealDay(
  state: IdentityState,
  day: string,
  durationsMs: readonly number[] | DaySamples,
): void {
  // The only writer of a day's cost, so what is already there is another
  // sealing of the same day from an earlier run and can be combined with
  // this one. Nothing writes a provisional value alongside it: a running
  // maximum kept as the fold went would be merged here as though it were
  // a percentile, and its count added to a count that already includes
  // it.
  const batch = Array.isArray(durationsMs)
    ? { p90: percentile90(durationsMs), count: durationsMs.length }
    : {
      p90: sampledPercentile90(durationsMs as DaySamples),
      count: (durationsMs as DaySamples).count,
    };
  if (batch.count === 0) return;
  const known = state.costByDay[day];
  state.costByDay[day] = known === undefined ? batch : {
    p90: Math.max(known.p90, batch.p90),
    count: known.count + batch.count,
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
