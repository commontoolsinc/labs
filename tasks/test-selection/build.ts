/**
 * Turning what the store holds into a manifest.
 *
 * The publisher keeps a rolling aggregate rather than re-reading history
 * every time: a three-week read is a quarter of a million objects, and
 * nothing can afford that every four hours. So each run reads the newest
 * state, folds in the objects whose runs are not already in it, ages the
 * counters, scores everything, and writes a new state beside the new
 * manifest.
 */

import {
  type AliasResolver,
  parseReportGroups,
  type RunContext,
  type StoredReport,
  type TestIdentity,
  testIdentityKey,
} from "@commonfabric/test-support/records";
import {
  costSeconds,
  type DaySamples,
  daysBetween,
  emptyContext,
  emptySamples,
  emptyState,
  flakeRate,
  type FoldContext,
  foldObservations,
  type IdentityState,
  type Observation,
  parseContext,
  sampleDuration,
  scoreInputs,
  sealDay,
  serializeContext,
  type StoredFoldContext,
  trimContext,
  trimWindows,
  value,
} from "./score.ts";
import { claimsFor } from "../test-topology.ts";
import type { Suite } from "../test-topology/suite.ts";
import {
  type Calibration,
  dialSnapshot,
  digestIdentities,
  type Manifest,
  MANIFEST_SCHEMA_VERSION,
  type ManifestEntry,
  type WithheldEntry,
} from "./manifest.ts";
import {
  COST_WINDOW_DAYS,
  FLAKE_EXCLUSION_RATE,
  FLAKE_REPEAT_RATES,
  LANE_PROLOGUE_SECONDS,
  MAX_REPEATS,
} from "./policy.ts";

/** The publisher's rolling aggregate, as one stored object. */
export interface AggregateState {
  schema: typeof MANIFEST_SCHEMA_VERSION;

  /** The day the counters were last aged to. */
  day: string;

  /**
   * The reports already folded in, by object name. Object names carry the
   * workflow run, so this is exact rather than a guess from timestamps,
   * and a relay that re-ships an old run is handled correctly.
   */
  folded: string[];

  /**
   * What the two backward-looking rules saw in the runs already folded.
   * Both reach across objects — whether an identity disagreed with itself
   * at a commit, and how many sources a failure spans — and a commit's
   * runs can arrive in two different publisher runs, so the context has
   * to survive between them or those rules silently stop reaching.
   */
  context?: StoredFoldContext;

  /**
   * The source-and-date pairs folded from a rollup rather than from their
   * raw objects, each `"<source>\t<date>"`. A rollup carries its pair's
   * reports whole, so those raw objects are not in `folded` and a later
   * run over a wide window would otherwise fold them on top of it and
   * double every catch in them.
   *
   * Scoped to the source and not only to the date, because rollups cover
   * the continuous-integration area alone. A receipt naming the date by
   * itself would say the day is accounted for, and the local submissions
   * of that day — the evidence the score weighs highest — would never be
   * read.
   */
  compacted: string[];

  states: Record<string, IdentityState>;
}

/** A fresh aggregate, for a cold start. */
export function emptyAggregate(day: string): AggregateState {
  return {
    schema: MANIFEST_SCHEMA_VERSION,
    day,
    folded: [],
    context: serializeContext(emptyContext()),
    compacted: [],
    states: {},
  };
}

/** The submission area an object was written into. */
export const CI_SOURCE = "ci";

/**
 * The area a submission object belongs to: the shared
 * continuous-integration one, or one person's own. It is what a rollup
 * covers and what a receipt is scoped to.
 */
export function sourceOf(objectName: string): string {
  const who = localReporter(objectName);
  return who === undefined ? CI_SOURCE : `local/${who}`;
}

/** The day partition in a submission object's name. */
export function partitionOf(objectName: string): string {
  return objectName.match(/\/v1\/(\d{4}\/\d{2}\/\d{2})\//)?.[1] ?? "";
}

/** How a source and a date name one pair, for a receipt or a lookup. */
export function sourceDateKey(source: string, date: string): string {
  return `${source}\t${date}`;
}

/**
 * Reads a stored aggregate. Returns undefined for anything that is not
 * one; a publisher that cannot read its own state starts from nothing
 * rather than from a half-understood one.
 */
export function parseAggregate(text: string): AggregateState | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const state = value as Record<string, unknown>;
  if (state.schema !== MANIFEST_SCHEMA_VERSION) return undefined;
  if (typeof state.day !== "string" || !Array.isArray(state.folded)) {
    return undefined;
  }
  // An array is an object, and read as one it would give a state set
  // keyed by index. Every such key fails to name an identity, so the
  // aggregate would be read as holding nothing rather than refused.
  if (
    typeof state.states !== "object" || state.states === null ||
    Array.isArray(state.states)
  ) {
    return undefined;
  }
  for (const name of state.folded) {
    if (typeof name !== "string") return undefined;
  }
  // An aggregate written before rollups were read carries no list, and
  // an empty one is the truthful reading of it: nothing was compacted.
  // The context is an optimization rather than a stored fact, so an
  // aggregate written without one, or with a malformed one, simply starts
  // the two cross-run rules from nothing.
  //
  // A receipt written before the source was part of one names a date
  // alone. Reading it forward as the continuous-integration area is
  // exact rather than a guess: that area is the only one a rollup has
  // ever covered, so nothing else could have written the receipt.
  const written = state.compacted ?? state.compactedDays ?? [];
  if (!Array.isArray(written)) return undefined;
  for (const pair of written) {
    if (typeof pair !== "string") return undefined;
  }
  const compacted = state.compacted === undefined
    ? (written as string[]).map((day) => sourceDateKey(CI_SOURCE, day))
    : written as string[];
  return {
    schema: MANIFEST_SCHEMA_VERSION,
    day: state.day,
    folded: state.folded as string[],
    context: serializeContext(parseContext(state.context)),
    compacted,
    states: state.states as Record<string, IdentityState>,
  };
}

/** The reporting person named by a local submission's object name. */
export function localReporter(objectName: string): string | undefined {
  return objectName.match(/\/submissions\/local\/([^/]+)\//)?.[1];
}

/** The UTC calendar day of an ISO 8601 timestamp. */
export function dayOf(startedAt: string): string {
  return startedAt.slice(0, 10);
}

/**
 * Where one report's executions happened, and who saw them. Undefined for
 * a report a decision must not read: a fork run's records are authored by
 * the fork, and a run with no context cannot say where it came from.
 */
export function provenance(
  context: RunContext | undefined,
  objectName: string,
): { place: Observation["place"]; source: string } | undefined {
  if (context === undefined) return undefined;
  if (context.env === "local") {
    const reporter = localReporter(objectName);
    return reporter === undefined
      ? undefined
      : { place: "local", source: reporter };
  }
  if (context.ci === undefined || context.ci.fork === true) return undefined;
  const branch = context.branch ?? "";
  if (branch.length === 0) return undefined;
  const place = context.ci.event === "push" && branch === "main"
    ? "main"
    : "pr";
  return { place, source: branch };
}

/** What one stored object says, once the parts nothing may read are out. */
export interface ReadReport {
  observations: Observation[];

  /** Where each identity in it runs, by identity key. */
  surfaces: Map<string, Surface>;

  /** Every measured duration, by identity key and then by day. */
  durations: Map<string, Map<string, number[]>>;
}

/**
 * Reads one stored object. A report a decision must not read contributes
 * nothing: a fork run's records are authored by the fork, and a group
 * with no context cannot say where it came from.
 */
export function readReport(
  report: StoredReport,
  resolver: AliasResolver,
): ReadReport {
  const observations: Observation[] = [];
  const surfaces = new Map<string, Surface>();
  const durations = new Map<string, Map<string, number[]>>();
  for (const group of report.reports) {
    const where = provenance(group.context, report.objectName);
    if (where === undefined || group.context === undefined) continue;
    const day = dayOf(group.context.startedAt);
    for (const record of group.records) {
      const test = resolver.resolve(record.test, day);
      const key = testIdentityKey(test);
      // A record with no file names its own identity as the unit, which
      // is all an unmapped record can say. Where another record of the
      // same identity did carry a file, that is the better answer and the
      // unmapped one must not overwrite it: the suites are mid-migration
      // onto the preload, so one identity can have records of both kinds.
      const surface = recordSurface(test, record.file);
      const known = surfaces.get(key);
      if (known === undefined || surface.fromFile) surfaces.set(key, surface);
      observations.push({
        test,
        outcome: record.outcome,
        durationMs: record.durationMs,
        day,
        startedAt: group.context.startedAt,
        commit: group.context.commit,
        source: where.source,
        place: where.place,
      });
      if (record.outcome === "skip") continue;
      let byDay = durations.get(key);
      if (byDay === undefined) {
        byDay = new Map();
        durations.set(key, byDay);
      }
      byDay.set(day, [...(byDay.get(day) ?? []), record.durationMs]);
    }
  }
  return { observations, surfaces, durations };
}

/** The invocation unit and suite a record belongs to. */
export interface Surface {
  suite: string;
  unit: string;

  /** Whether the unit came from a record's file rather than its name. */
  fromFile: boolean;
}

/** Whether a surface names a file rather than falling back to a name. */
function isFileBacked(surface: Surface): boolean {
  return surface.fromFile;
}

/**
 * How an identity is grouped, until the topology says. A record's kind
 * and scope name the surface that produced it, and the file the
 * registration preload captured names what a runner can be pointed at; an
 * identity with no file is its own invocation unit, which is what every
 * suite outside the unit tests already is.
 */
export function recordSurface(
  test: TestIdentity,
  file: string | undefined,
): Surface {
  const suite = test.v === undefined
    ? `${test.k}:${test.s}`
    : `${test.k}:${test.s}:${test.v}`;
  return { suite, unit: file ?? test.n, fromFile: file !== undefined };
}

/** What the topology could not place, and why. */
export interface Unplaced {
  /**
   * Identities whose only claim is on the suite as a whole: the
   * overlapping whole-invocation measurements a script records beside
   * its own steps. They name no unit, so nothing can be asked to run one
   * of them, and summing them with their own steps would count that work
   * twice.
   */
  suiteLevel: string[];

  /**
   * Identities no suite claims at a unit level. An identity recorded
   * before the registration preload carried its file is the usual one:
   * the store knows the test and nothing knows which file registers it,
   * so it will be placed again the first time it runs and records one.
   */
  unclaimed: string[];
}

/**
 * Where each identity runs, as the topology says rather than as its own
 * record surface guesses.
 *
 * Both halves of the system key on the suite identifier and unit a
 * manifest carries: the lane runner asks the topology for the suite by
 * that name, and the packer charges that suite's overhead and its
 * capabilities. A manifest naming a surface derived from the record's
 * own kind and scope matches no suite, so every unit reads as unknown
 * and every selection is dropped for naming a suite the tree does not
 * hold.
 *
 * An identity this cannot place is left out of the manifest rather than
 * carried under a name nothing can run, and is reported so that the two
 * reasons for it stay visible.
 */
export function locateSurfaces(
  suites: readonly Suite[],
  surfaces: ReadonlyMap<string, Surface>,
): { placed: Map<string, Surface>; unplaced: Unplaced } {
  const placed = new Map<string, Surface>();
  const unplaced: Unplaced = { suiteLevel: [], unclaimed: [] };
  for (const [key, surface] of surfaces) {
    const test = identityOfKey(key);
    if (test === undefined) continue;
    const claims = claimsFor(suites, {
      test,
      // The unit a record's own surface fell back to is the file where
      // one was recorded, and the identity's own name where none was.
      // Only the first is a file, and only that is what `locate` joins
      // on.
      ...(surface.fromFile ? { file: surface.unit } : {}),
    });
    // Two suites claiming one identity is a topology defect rather than
    // an ambiguity to settle here, and the drift guard is what fails on
    // it. Placing it either way would put the work in whichever suite
    // came first.
    const unit = claims.length === 1 ? claims[0]!.unit : undefined;
    if (unit !== undefined) {
      placed.set(key, {
        suite: claims[0]!.suite.id,
        unit,
        fromFile: surface.fromFile,
      });
      continue;
    }
    if (claims.length === 1) unplaced.suiteLevel.push(key);
    else unplaced.unclaimed.push(key);
  }
  return { placed, unplaced };
}

/** How many times a lane runs an identity, given how flaky it is. */
export function repeatsFor(rate: number): number {
  if (rate > FLAKE_EXCLUSION_RATE) return 1;
  let repeats = 1;
  for (const band of FLAKE_REPEAT_RATES) {
    if (rate > band) repeats++;
  }
  return Math.min(repeats, MAX_REPEATS);
}

/** What a manifest is built from beyond the folded state. */
export interface BuildInput {
  states: Map<string, IdentityState>;

  /** Identities failing in the newest run on `main`. */
  mainRed: ReadonlySet<string>;

  /** Where each identity runs, by identity key. */
  surfaces: ReadonlyMap<string, Surface>;

  /** The day the score is taken as of. */
  today: string;

  generatedAt: string;
  seed: string;
  commit: string;
  runs: number;
  calibration?: Partial<Calibration>;
}

/** A number with the digits past `places` dropped. */
function round(value: number, places: number): number {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

/** The identity a key names, parsed back out of its canonical form. */
export function identityOfKey(key: string): TestIdentity | undefined {
  let parts: unknown;
  try {
    parts = JSON.parse(key);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parts) || parts.length < 3) return undefined;
  const [k, s, n, v] = parts;
  if (typeof k !== "string" || typeof s !== "string" || typeof n !== "string") {
    return undefined;
  }
  const test: TestIdentity = { k, s, n };
  if (typeof v === "string") test.v = v;
  return test;
}

/**
 * The last day this identity is known to have run. The run counts are
 * kept per day and aged rather than kept forever, so an identity nothing
 * has run inside that reach has no answer, which the exploration draw
 * reads as the longest unrun of all.
 */
export function lastRun(state: IdentityState): string | undefined {
  let latest: string | undefined;
  for (const [day, runs] of Object.entries(state.runsByDay)) {
    if (runs <= 0) continue;
    if (latest === undefined || day > latest) latest = day;
  }
  return latest;
}

/** Builds a manifest from folded state. */
export function buildManifest(input: BuildInput): Manifest {
  const entries: ManifestEntry[] = [];
  const withheld: WithheldEntry[] = [];
  for (const [key, state] of input.states) {
    const test = identityOfKey(key);
    if (test === undefined) continue;
    const surface = input.surfaces.get(key) ?? recordSurface(test, undefined);
    const inputs = scoreInputs(state, input.today);
    const rate = flakeRate(state, input.today);
    // Rounded because the digits past these are noise, and because a
    // manifest carries one entry per identity: at twenty thousand of them
    // the difference between a rounded float and a full one is megabytes.
    inputs.catches = round(inputs.catches, 2);
    inputs.churn = round(inputs.churn, 6);
    const ran = lastRun(state);
    entries.push({
      test,
      suite: surface.suite,
      unit: surface.unit,
      cost: round(costSeconds(state, input.today), 3),
      score: round(value(inputs, input.today), 4),
      inputs,
      flakeRate: round(rate, 4),
      repeats: repeatsFor(rate),
      ...(ran === undefined ? {} : { lastRun: ran }),
    });
    if (input.mainRed.has(key)) {
      withheld.push({ test, suite: surface.suite, reason: "main-red" });
    } else if (rate > FLAKE_EXCLUSION_RATE) {
      withheld.push({ test, suite: surface.suite, reason: "flaky" });
    }
  }
  entries.sort((a, b) =>
    testIdentityKey(a.test).localeCompare(testIdentityKey(b.test))
  );
  return {
    schema: MANIFEST_SCHEMA_VERSION,
    generatedAt: input.generatedAt,
    seed: input.seed,
    commit: input.commit,
    runs: input.runs,
    dials: dialSnapshot(),
    calibration: {
      setupCost: input.calibration?.setupCost ?? {},
      suites: input.calibration?.suites ?? {},
      unitOverhead: input.calibration?.unitOverhead ?? {},
      prologue: input.calibration?.prologue ?? LANE_PROLOGUE_SECONDS,
    },
    entries,
    withheld,
    unavailable: [],
    unschedulable: [],
    lanes: [],
    known: {
      count: entries.length,
      digest: digestIdentities(entries.map((e) => testIdentityKey(e.test))),
    },
    coverageBaselines: [],
  };
}

/** A fold in progress, which the caller feeds reports to in time order. */
export class Fold {
  readonly #states: Map<string, IdentityState>;
  readonly #context: FoldContext;
  readonly #surfaces = new Map<string, Surface>();
  readonly #samples = new Map<string, Map<string, DaySamples>>();
  readonly #folded: string[];
  readonly #foldedIndex: Set<string>;
  readonly #compacted: string[];

  /**
   * The source-and-date pairs `folded` holds raw objects from, which is
   * what says a rollup written later would overlap them.
   */
  readonly #rawPairs: Set<string>;
  readonly #resolver: AliasResolver;
  readonly #today: string;
  #observations = 0;

  constructor(
    aggregate: AggregateState,
    resolver: AliasResolver,
    today: string,
  ) {
    this.#states = new Map(
      Object.entries(aggregate.states).map((
        [key, state],
      ) => [key, { ...emptyState(), ...state }]),
    );
    this.#context = parseContext(aggregate.context);
    this.#folded = [...aggregate.folded];
    // The array is what is persisted; membership is asked once per listed
    // object per run, and the list grows without bound, so the question
    // is answered against a set rather than by scanning.
    this.#foldedIndex = new Set(this.#folded);
    this.#compacted = [...aggregate.compacted];
    this.#rawPairs = new Set(
      this.#folded.map((name) =>
        sourceDateKey(sourceOf(name), partitionOf(name))
      ),
    );
    this.#resolver = resolver;
    this.#today = today;
  }

  /** How many executions have been folded in. */
  get observations(): number {
    return this.#observations;
  }

  /** Whether this object's records are already part of the aggregate. */
  knows(objectName: string): boolean {
    return this.#foldedIndex.has(objectName);
  }

  /**
   * Whether this source and date were folded from a rollup. Their raw
   * objects are not in `folded`, so a caller listing them has to ask
   * about the pair instead or it will fold the pair twice.
   */
  settled(source: string, date: string): boolean {
    return this.#compacted.includes(sourceDateKey(source, date));
  }

  /**
   * Whether any raw object of this source and date is already folded. A
   * rollup written later would overlap those contributions, and nothing
   * in a rollup of this format says by how much, so a pair that answers
   * yes stays on the raw path.
   */
  hasRaw(source: string, date: string): boolean {
    return this.#rawPairs.has(sourceDateKey(source, date));
  }

  /**
   * Records that a source and date came from their rollup, so no later
   * run folds the raw objects the rollup summarizes.
   */
  markSettled(source: string, date: string): void {
    const key = sourceDateKey(source, date);
    if (!this.#compacted.includes(key)) this.#compacted.push(key);
  }

  /**
   * Folds one batch. The batch must be in ascending time order, and later
   * batches must be later than earlier ones, because the rules that decide
   * whether a failure is a catch look backwards at what `main` last said
   * and forwards at what it says next.
   */
  add(reports: readonly StoredReport[]): void {
    const observations: Observation[] = [];
    for (const report of reports) {
      const read = readReport(report, this.#resolver);
      // Appended one at a time rather than spread: a rollup shard holds a
      // whole day, and spreading that many arguments onto the stack is
      // past what a call can carry.
      for (const observation of read.observations) {
        observations.push(observation);
      }
      for (const [key, surface] of read.surfaces) {
        // A file names something a runner can be pointed at, and an
        // identity's own name does not. A record with no file arriving in
        // a later report must not replace one that had it.
        const known = this.#surfaces.get(key);
        if (known === undefined || isFileBacked(surface)) {
          this.#surfaces.set(key, surface);
        }
      }
      for (const [key, byDay] of read.durations) {
        let known = this.#samples.get(key);
        for (const [day, sampled] of byDay) {
          // A day past the cost window is sealed and then dropped again
          // by the same `finish` that sealed it, so sampling it buys
          // nothing and a bootstrap holds sixty days of it at once.
          if (daysBetween(day, this.#today) > COST_WINDOW_DAYS) continue;
          if (known === undefined) {
            known = new Map();
            this.#samples.set(key, known);
          }
          const into = known.get(day) ?? emptySamples();
          for (const durationMs of sampled) sampleDuration(into, durationMs);
          known.set(day, into);
        }
      }
      this.#folded.push(report.objectName);
      this.#foldedIndex.add(report.objectName);
    }
    // Sorted here rather than by object, because one object can hold many
    // reports — a rollup holds a whole day of them — and a batch can hold
    // objects whose reports interleave in time. The rules that decide
    // whether a failure is a catch look backwards and forwards along this
    // order, so it has to be the order the runs actually happened in.
    // By the parsed instant rather than the text: these come from two
    // producers, and one writing fractional seconds where the other does
    // not makes the later run sort first, because "." precedes "Z".
    observations.sort((a, b) =>
      Date.parse(a.startedAt) - Date.parse(b.startedAt)
    );
    this.#observations += observations.length;
    foldObservations(observations, {
      prior: this.#states,
      context: this.#context,
    });
    // The two cross-batch rules reach back a couple of days, so what is
    // older cannot change a verdict and is dropped rather than carried
    // through a bootstrap's whole read.
    const newest = observations.at(-1)?.day;
    if (newest !== undefined) trimContext(this.#context, newest);
  }

  /** Closes the fold, sealing each day's cost and aging the counters. */
  finish(): FoldResult {
    for (const [key, byDay] of this.#samples) {
      const state = this.#states.get(key);
      if (state === undefined) continue;
      for (const [day, sampled] of byDay) sealDay(state, day, sampled);
    }
    for (const state of this.#states.values()) {
      trimWindows(state, this.#today);
    }
    const mainRed = new Set<string>();
    for (const [key, state] of this.#states) {
      if (state.lastMainOutcome === "fail") mainRed.add(key);
    }
    return {
      aggregate: {
        schema: MANIFEST_SCHEMA_VERSION,
        day: this.#today,
        folded: this.#folded,
        context: serializeContext(this.#context),
        compacted: this.#compacted,
        states: Object.fromEntries(this.#states),
      },
      states: this.#states,
      mainRed,
      surfaces: this.#surfaces,
      observations: this.#observations,
    };
  }
}

/** What a finished fold produced. */
export interface FoldResult {
  aggregate: AggregateState;
  states: Map<string, IdentityState>;
  mainRed: Set<string>;
  surfaces: Map<string, Surface>;
  observations: number;
}

/** Folds a whole set of reports at once, for a caller holding them all. */
export function foldReports(
  aggregate: AggregateState,
  reports: readonly StoredReport[],
  resolver: AliasResolver,
  today: string,
): FoldResult {
  const fold = new Fold(aggregate, resolver, today);
  fold.add(reports.filter((report) => !fold.knows(report.objectName)));
  return fold.finish();
}

/** Parses object text the way the store's reader does, for offline use. */
export function reportFromText(
  objectName: string,
  text: string,
): StoredReport {
  const reports = parseReportGroups(text);
  return {
    objectName,
    context: reports[0]?.context,
    records: reports.flatMap((report) => report.records),
    reports,
  };
}
