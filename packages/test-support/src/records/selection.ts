/**
 * The test-selection manifest: what the publisher writes, what a lane
 * reads to decide what to run, and what the wall reads to show what
 * selection is doing. It holds every identity the store knows, what each
 * is worth, what each costs, what was withheld and why, and a reference
 * packing into lanes.
 *
 * A lane treats a manifest as untrusted input, the same as a record line,
 * so everything here is validated whole. A manifest that does not parse
 * is treated as absent, and a lane with no manifest runs the mandatory
 * set plus a deterministic slice rather than guessing at a half-read one.
 * The worst a corrupted manifest could achieve is a pull request that ran
 * fewer tests than it should have, which the full run on `main` catches;
 * that is what lets it be an ordinary public object rather than a signed
 * artifact.
 */

import { type TestIdentity, testIdentityKey } from "./schema.ts";

/** The inputs behind one identity's score, as a manifest records them. */
export interface ScoreInputs {
  /** Catches, weighted by where each happened. */
  catches: number;

  /** How many of those were on `main`, which measure escapes as well. */
  mainCatches: number;

  /** The day of the most recent catch, absent when there are none. */
  lastCatch?: string;

  /** How many distinct sources are among the catches. */
  sources: number;

  /** Recent failures over recent runs, decayed as they age. */
  churn: number;
}

/** The version a reader understands; anything else is treated as absent. */
export const MANIFEST_SCHEMA_VERSION = 1;

/** One selectable identity, with everything selection needs to know. */
export interface ManifestEntry {
  /** The complete identity, variant included when there is one. */
  test: TestIdentity;

  /** The suite that runs it. */
  suite: string;

  /**
   * The invocation unit it lives in: a file for a `deno test` suite, a
   * dispatch arm for a script. What a runner can be pointed at.
   */
  unit: string;

  /** What one execution costs, in seconds. */
  cost: number;

  /** What it is worth running. */
  score: number;

  /** The inputs behind that score, so a manifest explains itself. */
  inputs: ScoreInputs;

  /** How often it disagrees with itself. */
  flakeRate: number;

  /** How many times a lane runs it. Every one of them must pass. */
  repeats: number;

  /**
   * Whether it has been shown to pass as the only test in its unit. Until
   * it has, its siblings are not skipped and the unit is what runs.
   */
  independent?: boolean;
}

/** Why an identity is not selectable on a pull request. */
export type WithheldReason = "main-red" | "flaky";

/** One identity held back, and why. */
export interface WithheldEntry {
  test: TestIdentity;
  suite: string;
  reason: WithheldReason;
}

/** A test a configuration deliberately does not run. */
export interface UnavailableEntry {
  suite: string;
  variant?: string;
  unit: string;

  /** The exact leaf, when only one identity inside the unit is skipped. */
  leafName?: string;
  phase?: string;
  reason: string;
}

/** An identity no lane can hold, however it is packed. */
export interface UnschedulableEntry {
  test: TestIdentity;
  suite: string;
  cost: number;
}

/** The fitted numbers a lane's own timing records produced. */
export interface Calibration {
  /** Seconds each capability's setup takes. */
  setupCost: Record<string, number>;

  /** Per suite: the intercept and slope fitted from planned against actual. */
  suites: Record<string, { overhead: number; correction: number }>;

  /** Per invocation unit: what running it at all costs before any test. */
  unitOverhead: Record<string, number>;

  /** Seconds a lane spends outside its batches. */
  prologue: number;
}

/** One lane of the reference packing. */
export interface LanePlan {
  lane: number;

  /**
   * Seconds this lane is expected to take: the identities' own measured
   * time through their suites' corrections, plus every overhead and
   * capability setup the lane opens. A reader cannot recompute this from
   * the entries alone, which is why the packing carries it.
   */
  projectedSeconds: number;

  batches: Array<{ suite: string; identities: string[] }>;
}

/** What a covered package's own tests reached at one `main` commit. */
export interface CoverageBaseline {
  member: string;
  commit: string;
  day: string;
  uncoveredLines: number;
}

/** One publisher run's whole output. */
export interface Manifest {
  schema: typeof MANIFEST_SCHEMA_VERSION;

  /** ISO 8601 UTC. */
  generatedAt: string;

  /** Seeds the exploration draw, so five lanes draw the same set. */
  seed: string;

  /** The `main` commit whose topology was enumerated. */
  commit: string;

  /** How many workflow runs the aggregate behind this manifest saw. */
  runs: number;

  /** Every dial this manifest was built with. */
  dials: Record<string, unknown>;

  calibration: Calibration;
  entries: ManifestEntry[];
  withheld: WithheldEntry[];
  unavailable: UnavailableEntry[];
  unschedulable: UnschedulableEntry[];
  lanes: LanePlan[];

  /** How many item-level identities the store knows, and their digest. */
  known: { count: number; digest: string };

  /** The newest coverage attribution map, published on its own cadence. */
  attributionMap?: string;

  coverageBaselines: CoverageBaseline[];
}

/**
 * A digest over the identities a manifest knows, order-independent, so
 * two manifests built from the same set agree whatever order they walked
 * it in. Used to tell a lane whether an identity it enumerated is one the
 * store has never seen, which is what makes an unknown identity run.
 */
export function digestIdentities(keys: Iterable<string>): string {
  // A sum of per-key hashes: commutative, so order cannot change it, and
  // this is a change detector rather than anything anybody trusts.
  let low = 0;
  let high = 0;
  for (const key of [...keys].sort()) {
    let hash = 2166136261;
    for (let i = 0; i < key.length; i++) {
      hash ^= key.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    low = (low + (hash >>> 0)) % 0x100000000;
    high = (high + (hash >>> 16)) % 0x100000000;
  }
  return `${low.toString(16).padStart(8, "0")}` +
    `${high.toString(16).padStart(8, "0")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * An ISO 8601 UTC instant. A reader measures a manifest's age from this,
 * and a value that is not a date parses as a missing number, which
 * compares false against every threshold — so a corrupt manifest would
 * read as freshly generated forever.
 */
function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value)) return false;
  return Number.isFinite(Date.parse(value));
}

function parseIdentity(value: unknown): TestIdentity | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !isNonEmptyString(value.k) || !isNonEmptyString(value.s) ||
    !isNonEmptyString(value.n)
  ) {
    return undefined;
  }
  if (value.v !== undefined && !isNonEmptyString(value.v)) return undefined;
  const test: TestIdentity = { k: value.k, s: value.s, n: value.n };
  if (value.v !== undefined) test.v = value.v;
  return test;
}

function parseInputs(value: unknown): ScoreInputs | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !isFiniteNumber(value.catches) || !isFiniteNumber(value.mainCatches) ||
    !isFiniteNumber(value.sources) || !isFiniteNumber(value.churn)
  ) {
    return undefined;
  }
  if (value.lastCatch !== undefined && !isNonEmptyString(value.lastCatch)) {
    return undefined;
  }
  const inputs: ScoreInputs = {
    catches: value.catches,
    mainCatches: value.mainCatches,
    sources: value.sources,
    churn: value.churn,
  };
  if (value.lastCatch !== undefined) inputs.lastCatch = value.lastCatch;
  return inputs;
}

function parseEntry(value: unknown): ManifestEntry | undefined {
  if (!isRecord(value)) return undefined;
  const test = parseIdentity(value.test);
  const inputs = parseInputs(value.inputs);
  if (test === undefined || inputs === undefined) return undefined;
  if (!isNonEmptyString(value.suite) || !isNonEmptyString(value.unit)) {
    return undefined;
  }
  if (
    !isFiniteNumber(value.cost) || value.cost < 0 ||
    !isFiniteNumber(value.score) ||
    // A share of a test's runs, so outside zero to one it is not one. A
    // negative rate would sit under the exclusion threshold and stay
    // selectable, which is the direction a corrupt manifest must not go.
    !isFiniteNumber(value.flakeRate) || value.flakeRate < 0 ||
    value.flakeRate > 1 ||
    // A count of runs. Nothing can run a test one and a half times.
    !isFiniteNumber(value.repeats) || !Number.isInteger(value.repeats) ||
    value.repeats < 1
  ) {
    return undefined;
  }
  if (
    value.independent !== undefined && typeof value.independent !== "boolean"
  ) {
    return undefined;
  }
  const entry: ManifestEntry = {
    test,
    suite: value.suite,
    unit: value.unit,
    cost: value.cost,
    score: value.score,
    inputs,
    flakeRate: value.flakeRate,
    repeats: value.repeats,
  };
  if (value.independent !== undefined) entry.independent = value.independent;
  return entry;
}

function parseWithheld(value: unknown): WithheldEntry | undefined {
  if (!isRecord(value)) return undefined;
  const test = parseIdentity(value.test);
  if (test === undefined || !isNonEmptyString(value.suite)) return undefined;
  if (value.reason !== "main-red" && value.reason !== "flaky") return undefined;
  return { test, suite: value.suite, reason: value.reason };
}

function parseUnavailable(value: unknown): UnavailableEntry | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !isNonEmptyString(value.suite) || !isNonEmptyString(value.unit) ||
    !isNonEmptyString(value.reason)
  ) {
    return undefined;
  }
  for (const optional of ["variant", "leafName", "phase"] as const) {
    if (value[optional] !== undefined && !isNonEmptyString(value[optional])) {
      return undefined;
    }
  }
  const entry: UnavailableEntry = {
    suite: value.suite,
    unit: value.unit,
    reason: value.reason,
  };
  if (value.variant !== undefined) entry.variant = value.variant as string;
  if (value.leafName !== undefined) entry.leafName = value.leafName as string;
  if (value.phase !== undefined) entry.phase = value.phase as string;
  return entry;
}

function parseUnschedulable(value: unknown): UnschedulableEntry | undefined {
  if (!isRecord(value)) return undefined;
  const test = parseIdentity(value.test);
  if (test === undefined || !isNonEmptyString(value.suite)) return undefined;
  if (!isFiniteNumber(value.cost) || value.cost < 0) return undefined;
  return { test, suite: value.suite, cost: value.cost };
}

function parseCalibration(value: unknown): Calibration | undefined {
  if (!isRecord(value)) return undefined;
  const numbers = (raw: unknown): Record<string, number> | undefined => {
    if (!isRecord(raw)) return undefined;
    const out: Record<string, number> = {};
    for (const [name, seconds] of Object.entries(raw)) {
      if (!isFiniteNumber(seconds) || seconds < 0) return undefined;
      out[name] = seconds;
    }
    return out;
  };
  const setupCost = numbers(value.setupCost);
  const unitOverhead = numbers(value.unitOverhead);
  if (setupCost === undefined || unitOverhead === undefined) return undefined;
  if (!isRecord(value.suites)) return undefined;
  if (!isFiniteNumber(value.prologue) || value.prologue < 0) return undefined;
  const suites: Calibration["suites"] = {};
  for (const [suite, fitted] of Object.entries(value.suites)) {
    if (!isRecord(fitted)) return undefined;
    if (
      !isFiniteNumber(fitted.overhead) || fitted.overhead < 0 ||
      !isFiniteNumber(fitted.correction) || fitted.correction <= 0
    ) {
      return undefined;
    }
    suites[suite] = {
      overhead: fitted.overhead,
      correction: fitted.correction,
    };
  }
  return { setupCost, suites, unitOverhead, prologue: value.prologue };
}

function parseLane(value: unknown): LanePlan | undefined {
  if (!isRecord(value)) return undefined;
  if (!isFiniteNumber(value.lane) || value.lane < 1) return undefined;
  if (!isFiniteNumber(value.projectedSeconds) || value.projectedSeconds < 0) {
    return undefined;
  }
  if (!Array.isArray(value.batches)) return undefined;
  const batches: LanePlan["batches"] = [];
  for (const raw of value.batches) {
    if (!isRecord(raw) || !isNonEmptyString(raw.suite)) return undefined;
    if (!Array.isArray(raw.identities)) return undefined;
    for (const key of raw.identities) {
      if (!isNonEmptyString(key)) return undefined;
    }
    batches.push({ suite: raw.suite, identities: raw.identities as string[] });
  }
  return {
    lane: value.lane,
    projectedSeconds: value.projectedSeconds,
    batches,
  };
}

function parseBaseline(value: unknown): CoverageBaseline | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !isNonEmptyString(value.member) || !isNonEmptyString(value.commit) ||
    !isNonEmptyString(value.day) || !isFiniteNumber(value.uncoveredLines) ||
    value.uncoveredLines < 0
  ) {
    return undefined;
  }
  return {
    member: value.member,
    commit: value.commit,
    day: value.day,
    uncoveredLines: value.uncoveredLines,
  };
}

/** Maps a list through a parser, failing whole if any element fails. */
function parseAll<T>(
  value: unknown,
  parse: (raw: unknown) => T | undefined,
): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: T[] = [];
  for (const raw of value) {
    const parsed = parse(raw);
    if (parsed === undefined) return undefined;
    out.push(parsed);
  }
  return out;
}

/**
 * Validates a manifest whole. Returns undefined for anything that is not
 * one of this schema version, including a newer one: a reader that does
 * not know a field cannot know what obeying the rest would mean.
 */
export function parseManifest(value: unknown): Manifest | undefined {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!isRecord(value)) return undefined;
  if (value.schema !== MANIFEST_SCHEMA_VERSION) return undefined;
  if (
    !isTimestamp(value.generatedAt) || !isNonEmptyString(value.seed) ||
    !isNonEmptyString(value.commit) || !isFiniteNumber(value.runs) ||
    value.runs < 0 || !isRecord(value.dials)
  ) {
    return undefined;
  }
  const calibration = parseCalibration(value.calibration);
  const entries = parseAll(value.entries, parseEntry);
  const withheld = parseAll(value.withheld, parseWithheld);
  const unavailable = parseAll(value.unavailable, parseUnavailable);
  const unschedulable = parseAll(value.unschedulable, parseUnschedulable);
  const lanes = parseAll(value.lanes, parseLane);
  const coverageBaselines = parseAll(value.coverageBaselines, parseBaseline);
  if (
    calibration === undefined || entries === undefined ||
    withheld === undefined || unavailable === undefined ||
    unschedulable === undefined || lanes === undefined ||
    coverageBaselines === undefined
  ) {
    return undefined;
  }
  if (
    !isRecord(value.known) || !isFiniteNumber(value.known.count) ||
    value.known.count < 0 || !isNonEmptyString(value.known.digest)
  ) {
    return undefined;
  }
  if (
    value.attributionMap !== undefined &&
    !isNonEmptyString(value.attributionMap)
  ) {
    return undefined;
  }
  // One identity may not appear twice: the packer removes an identity
  // from the selectable set as it takes it, and a duplicate would let a
  // later pass take it again.
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = testIdentityKey(entry.test);
    if (seen.has(key)) return undefined;
    seen.add(key);
  }
  const manifest: Manifest = {
    schema: MANIFEST_SCHEMA_VERSION,
    generatedAt: value.generatedAt,
    seed: value.seed,
    commit: value.commit,
    runs: value.runs,
    dials: value.dials,
    calibration,
    entries,
    withheld,
    unavailable,
    unschedulable,
    lanes,
    known: { count: value.known.count, digest: value.known.digest },
    coverageBaselines,
  };
  if (value.attributionMap !== undefined) {
    manifest.attributionMap = value.attributionMap;
  }
  return manifest;
}

/** Serializes a manifest for the store. */
export function serializeManifest(manifest: Manifest): string {
  return JSON.stringify(manifest);
}
