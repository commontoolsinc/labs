#!/usr/bin/env -S deno run -A

/**
 * The script every pull-request lane runs, and the script every lane of
 * the full run on `main` runs.
 *
 * Lanes call this with their own lane number and nothing else. There is
 * no job ahead of them deciding what each will do: packing is a pure
 * function of the working tree, the manifest, the diff, and the lane
 * number, so every lane computes the same plan over the same inputs and
 * takes its own share of it. That only holds while every lane resolves
 * the same manifest, which is why the moment they resolve it at is when
 * the commit under test was made rather than anything about the run.
 *
 * The full run differs in two values: it runs the whole corpus rather
 * than a budgeted part of it, and it has no diff. Everything else — what
 * the tree holds, what each test costs, how the work groups into lanes,
 * which identities inside a unit are skipped — is the same code, so the
 * two runs cannot come to different answers about the same tree.
 *
 * `main` cannot fix its number of lanes ahead of time the way a pull
 * request does, because the number depends on how much work there is and
 * the job matrix has to exist before anything starts. So one job asks
 * `--lane-count` and emits an integer, and that integer is the whole of
 * what passes from it to the lanes.
 *
 *   deno run -A tasks/ci-lane.ts --lane 3 --of 5 --base origin/main
 *   deno run -A tasks/ci-lane.ts --full --lane 1 --of 4
 *   deno run -A tasks/ci-lane.ts --full --lane-count
 *   deno run -A tasks/ci-lane.ts --lane 1 --of 5 --dry-run
 */

import * as path from "@std/path";
import {
  FragmentWriter,
  recordsDir,
  testIdentityKey,
  type TestRecord,
} from "@commonfabric/test-support/records";
import {
  type CapabilityId,
  openCapabilities,
  takeGithubToken,
} from "./ci-capabilities.ts";
import { capabilitiesBySuite, loadTopology } from "./test-topology.ts";
import {
  type Invocation,
  type Suite,
  unavailableUnits,
  type Unit,
  type UnitRequest,
} from "./test-topology/suite.ts";
import { collectRecords } from "./test-records-gather.ts";
import { fetchManifest, type ManifestFetch } from "./test-selection/store.ts";
import {
  fullLaneCount,
  plan,
  type Selection,
  type SelectionReason,
} from "./test-selection/plan.ts";
import { type Census, census, isStandIn } from "./test-selection/census.ts";
import {
  type CoverageGateSelection,
  measuredMembersOf,
  measuredSetDirectory,
  measuredSetName,
  measuredSets,
} from "./test-selection/coverage.ts";
import type { Manifest, WithheldReason } from "./test-selection/manifest.ts";
import { LANES } from "./test-selection/policy.ts";
import { writeLcovReport } from "./write-coverage-lcov.ts";
import {
  batchMeasurementName,
  LANE_MEASUREMENT_PREFIX,
  LANE_MEASUREMENT_SURFACE,
} from "./lane-measurement.ts";

/** What the lane was asked to do. */
export interface LaneOptions {
  lane: number;
  of: number;

  /** Run everything the topology holds, which is what `main` does. */
  full: boolean;

  /** Print the plan and run nothing. */
  dryRun: boolean;

  /**
   * Print how many lanes the full run needs, and nothing else. This is
   * what the job ahead of the full run asks, and it asks it of this
   * script rather than of one of its own so that the number and the
   * lanes that will honor it come from the same code.
   */
  laneCount: boolean;

  /** What the change is measured against. */
  base?: string;

  /**
   * The moment to resolve the manifest at, ISO 8601 UTC, in place of the
   * commit's own. For asking what a lane would have done at a moment
   * that is not this tree's, which is what a dry run against recorded
   * data wants.
   */
  at?: string;

  /**
   * Where coverage profiles and the reports converted from them go,
   * relative to the root. The job uploads what is under it.
   */
  coverageDir?: string;

  root: string;
}

/** Where coverage goes when the command line names nowhere else. */
export const DEFAULT_COVERAGE_DIR = "coverage";

/** Where a lane puts the profiles it collects, under its coverage directory. */
export const COVERAGE_PROFILE_DIR = "raw";

/** Where a lane puts the reports it converts, under its coverage directory. */
export const COVERAGE_REPORT_DIR = "lcov/sets";

/**
 * What a lane calls each report. One directory per measured set rather
 * than one file per set in a shared directory, because the conversion
 * puts what a report does not cover beside the report, and two sets
 * sharing a directory would share that too.
 */
export const COVERAGE_REPORT_FILE = "coverage.lcov";

/** Where this lane's coverage goes, absolute. */
export function coverageRoot(options: LaneOptions): string {
  return path.resolve(
    options.root,
    options.coverageDir ?? DEFAULT_COVERAGE_DIR,
  );
}

/** Reads the command line, or returns undefined for a malformed one. */
export function parseLaneArgs(
  args: readonly string[],
  root: string = Deno.cwd(),
): LaneOptions | undefined {
  const options: LaneOptions = {
    lane: 1,
    of: LANES,
    full: false,
    dryRun: false,
    laneCount: false,
    root,
  };
  const rest = [...args];
  while (rest.length > 0) {
    const flag = rest.shift()!;
    if (flag === "--full") {
      options.full = true;
      continue;
    }
    if (flag === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (flag === "--lane-count") {
      options.laneCount = true;
      continue;
    }
    const value = rest.shift();
    if (value === undefined) return undefined;
    switch (flag) {
      case "--lane":
        options.lane = Number(value);
        break;
      case "--of":
        options.of = Number(value);
        break;
      case "--base":
        options.base = value;
        break;
      case "--at":
        options.at = value;
        break;
      case "--coverage-dir":
        options.coverageDir = value;
        break;
      default:
        return undefined;
    }
  }
  if (!Number.isInteger(options.lane) || options.lane < 1) return undefined;
  if (!Number.isInteger(options.of) || options.of < options.lane) {
    return undefined;
  }
  // Only the full run has a lane count to work out; a pull request's is
  // the dial. Accepting the question without `--full` would answer the
  // full run's question for a command line that did not ask it, and a
  // workflow edit dropping the flag would still get a plausible integer.
  if (options.laneCount && !options.full) return undefined;
  return options;
}

/**
 * The moment a lane resolves its manifest at: when the commit it is
 * testing was made.
 *
 * What the moment has to be is stable — every lane of a run agreeing, and
 * every later attempt agreeing with the first — rather than exact. The
 * commit satisfies that by construction, where the run does not: GitHub
 * reports `run_started_at` per attempt, so a re-run half a day later
 * reports that later moment, and an attempt resolving at its own start
 * would pack the lanes differently from the attempt it is re-running. A
 * test the first attempt placed in the lane that failed could move to a
 * lane the re-run does not run, leaving `Status` green over a set no
 * attempt ran whole.
 *
 * The commit needs nothing from the service that scheduled the run: no
 * credential, no request, and no failure path where the request is
 * refused. It is the same value on a workstation as in a job, so a dry
 * run answers the question a lane would answer rather than resolving
 * against the clock. And it is the better anchor of the two on its own
 * terms — the manifest worth reading is the one that was current when
 * the tree under test came into being.
 *
 * The committer date rather than the author's: a rebased or cherry-picked
 * commit keeps the date it was first written, which can be arbitrarily
 * old, while the committer date moves with the tree.
 */
export async function manifestMoment(
  options: LaneOptions,
): Promise<{ at: string; note?: string }> {
  if (options.at !== undefined) return { at: options.at };
  const result = await new Deno.Command("git", {
    args: ["log", "-1", "--format=%cI", "HEAD"],
    cwd: options.root,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const raw = new TextDecoder().decode(result.stdout).trim();
  // Git writes the committer's own offset, and manifest names carry UTC,
  // so the two are only comparable once this one is normalized.
  const at = result.success ? new Date(raw).getTime() : Number.NaN;
  if (Number.isNaN(at)) {
    return {
      at: new Date().toISOString(),
      note: "cannot read the commit's date, so the manifest is the newest " +
        "there is rather than the one this tree was made against",
    };
  }
  return { at: new Date(at).toISOString() };
}

/** The files this change touched, as the repository names them. */
export async function changedFiles(
  root: string,
  base: string | undefined,
): Promise<Set<string>> {
  if (base === undefined) return new Set();
  const result = await new Deno.Command("git", {
    args: ["diff", "--name-only", `${base}...HEAD`],
    cwd: root,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    // Treating this as a change-free pull request would drop every unit
    // the change touched out of the mandatory set without saying so, and
    // the lane would pass having run none of them.
    throw new Error(
      `cannot diff against ${base}: ` +
        new TextDecoder().decode(result.stderr).trim(),
    );
  }
  return new Set(
    new TextDecoder().decode(result.stdout).split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
}

/** One suite's share of a lane, and what runs inside it. */
export interface Batch {
  suite: Suite;

  /** Each unit, and the identities inside it that are not to run. */
  units: UnitRequest[];

  /**
   * How many times each unit runs, by unit. Every run must pass.
   *
   * Per unit rather than per batch, because what a repeat is for is
   * catching one test disagreeing with itself. One flaky unit is not a
   * reason to run the rest of the batch again, and running it again
   * would cost the lane time the packer never charged it for.
   */
  runs: Map<Unit, number>;
}

/** How many times a batch's longest-running unit runs. */
export function batchRepeats(batch: Batch): number {
  let most = 1;
  for (const runs of batch.runs.values()) most = Math.max(most, runs);
  return most;
}

/** The units of a batch that are still running on the `run`th time round. */
export function unitsForRun(batch: Batch, run: number): UnitRequest[] {
  return batch.units.filter((unit) => (batch.runs.get(unit.unit) ?? 1) >= run);
}

/**
 * Turns a lane's selections into batches. A unit runs once carrying the
 * skip list of everything inside it that was not selected, so choosing
 * one test out of a file leaves its siblings registered as ignored rather
 * than missing.
 */
export function batchesOf(
  suites: readonly Suite[],
  manifest: Manifest | undefined,
  selections: readonly Selection[],
): Batch[] {
  const bySuite = new Map<string, Suite>(
    suites.map((suite) => [suite.id, suite]),
  );
  const inUnit = new Map<string, string[]>();
  for (const entry of manifest?.entries ?? []) {
    const key = `${entry.suite}\t${entry.unit}`;
    inUnit.set(key, [...inUnit.get(key) ?? [], entry.test.n]);
  }
  const batches = new Map<string, Batch>();
  // What each unit was selected for: the names to run, and the most
  // repeats any one of them asked for.
  const selected = new Map<string, { names: Set<string>; repeats: number }>();
  for (const selection of selections) {
    const key = `${selection.entry.suite}\t${selection.entry.unit}`;
    const already = selected.get(key);
    if (already === undefined) {
      selected.set(key, {
        names: new Set([selection.entry.test.n]),
        repeats: selection.repeats,
      });
    } else {
      already.names.add(selection.entry.test.n);
      already.repeats = Math.max(already.repeats, selection.repeats);
    }
  }
  for (const [key, { names, repeats }] of selected) {
    const [suiteId, unit] = key.split("\t") as [string, string];
    const suite = bySuite.get(suiteId);
    if (suite === undefined) continue;
    const all = inUnit.get(key) ?? [];
    const skip = all.filter((name) => !names.has(name));
    const batch = batches.get(suiteId);
    const request: UnitRequest = { unit, skip };
    if (batch === undefined) {
      batches.set(suiteId, {
        suite,
        units: [request],
        runs: new Map([[unit, repeats]]),
      });
    } else {
      batch.units.push(request);
      batch.runs.set(unit, repeats);
    }
  }
  // Both orders are the tree's rather than the packer's, so what a
  // runner is handed is decided by which units are in the batch and
  // never by which pass put them there. A test that leans on running
  // after a sibling then behaves the same on `main` as on a pull
  // request, rather than passing in whichever mode happened to order
  // them the way it wanted.
  const enumerated = new Map<string, number>();
  for (const suite of suites) {
    suite.units.forEach((unit, index) =>
      enumerated.set(`${suite.id}\t${unit}`, index)
    );
  }
  const order = (suiteId: string, unit: string): number =>
    enumerated.get(`${suiteId}\t${unit}`) ?? Number.MAX_SAFE_INTEGER;
  for (const [suiteId, batch] of batches) {
    batch.units.sort((a, b) =>
      order(suiteId, a.unit) - order(suiteId, b.unit) ||
      (a.unit < b.unit ? -1 : a.unit > b.unit ? 1 : 0)
    );
  }
  return [...batches.values()].sort((a, b) =>
    a.suite.id < b.suite.id ? -1 : a.suite.id > b.suite.id ? 1 : 0
  );
}

/** What running one invocation came to. */
interface Outcome {
  ok: boolean;
  seconds: number;
}

/** Runs one invocation, with the capabilities' environment around it. */
export async function runInvocation(
  invocation: Invocation,
  env: Record<string, string>,
): Promise<Outcome> {
  const [command, ...args] = invocation.command;
  const startedAt = performance.now();
  const result = await new Deno.Command(command!, {
    args,
    cwd: invocation.cwd,
    env: { ...Deno.env.toObject(), ...env, ...invocation.env },
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  return {
    ok: result.success,
    seconds: (performance.now() - startedAt) / 1000,
  };
}

/**
 * A record measuring the lane machinery rather than a test. The publisher
 * fits `setupCost`, `suiteOverhead` and `correction` from these, so they
 * travel as ordinary records through the machinery that already exists
 * and need no pipeline of their own. They stay unmarked whatever variant
 * the batch they measure carried: they measure the lane, not an alternate
 * execution of one test.
 */
function timingRecord(name: string, seconds: number, ok: boolean): TestRecord {
  return {
    line: "record",
    test: {
      k: LANE_MEASUREMENT_SURFACE.kind,
      s: LANE_MEASUREMENT_SURFACE.scope,
      n: name,
    },
    outcome: ok ? "pass" : "fail",
    durationMs: Math.round(seconds * 1000),
  };
}

/** Appends records to the lane's own spool. */
export function spoolRecords(
  spool: string,
  records: readonly TestRecord[],
): void {
  if (records.length === 0) return;
  const writer = FragmentWriter.open(spool);
  if (writer === undefined) return;
  for (const record of records) writer.append(record);
  writer.close();
}

/** Where one batch's coverage profiles go, and which members write them. */
export interface BatchCoverage {
  /** The directory this suite's profiles go under, absolute. */
  dir: string;

  /**
   * The members to measure, or nothing to measure every member the batch
   * runs, which is what the full run asks for.
   */
  members?: ReadonlySet<string>;
}

/**
 * What a lane measures, given what the coverage gate decided.
 *
 * A pull request measures the members of the sets the gate is scoring and
 * no others: coverage costs time, and a profile no set is scored from is
 * time spent on something nothing reads. The full run measures every
 * member of every suite, because both the baselines and the
 * repository-wide trend come out of it.
 */
export function batchCoverage(
  options: LaneOptions,
  suiteId: string,
  gate: CoverageGateSelection,
): BatchCoverage | undefined {
  const dir = path.join(coverageRoot(options), COVERAGE_PROFILE_DIR, suiteId);
  if (options.full) return { dir };
  const members = measuredMembersOf(gate, suiteId);
  return members.size === 0 ? undefined : { dir, members };
}

/**
 * Converts every profile directory a lane wrote into one report beside
 * it, and says whether every conversion accounted for what it was given.
 *
 * Every directory is converted rather than only the ones a measured set
 * names, because the repository-wide figure the full run publishes is the
 * merge of all of them. Which of the reports the gate scores is decided
 * from the declarations, so an unscored report costs a conversion and
 * nothing else.
 */
/**
 * What a lane writes beside a set's report when the units it measured
 * through held a failure the run did not fail for.
 *
 * Coverage measured through a failing unit is short by whatever that
 * unit would have reached, and a run excusing a flaky failure stays
 * green, so nothing else downstream would know. The report still merges
 * into the repository-wide figure, which is a trend; what this stops is
 * the set's own number becoming the baseline every later pull request is
 * held to.
 */
export const COVERAGE_FAILURE_MARKER = "measured-through-a-failure.txt";

/**
 * Marks each measured set whose units a lane saw fail, beside the report
 * it wrote for that set.
 */
export async function markMeasuredFailures(
  options: LaneOptions,
  suites: readonly Suite[],
  failed: ReadonlySet<string>,
): Promise<string[]> {
  if (failed.size === 0) return [];
  const root = coverageRoot(options);
  const marked: string[] = [];
  for (const ref of measuredSets(suites)) {
    const hit = ref.set.units.filter((unit) =>
      failed.has(`${ref.suite}\t${unit}`)
    );
    if (hit.length === 0) continue;
    const at = path.join(
      root,
      COVERAGE_REPORT_DIR,
      measuredSetDirectory(ref),
      COVERAGE_FAILURE_MARKER,
    );
    await Deno.mkdir(path.dirname(at), { recursive: true });
    await Deno.writeTextFile(at, `${hit.sort().join("\n")}\n`);
    marked.push(measuredSetName(ref));
  }
  return marked.sort();
}

export async function convertCoverage(
  options: LaneOptions,
): Promise<{ ok: boolean; reports: string[] }> {
  const root = coverageRoot(options);
  const profiles = path.join(root, COVERAGE_PROFILE_DIR);
  const reports: string[] = [];
  let ok = true;
  for (const suiteId of await directoriesIn(profiles)) {
    for (const member of await directoriesIn(path.join(profiles, suiteId))) {
      const name = `${suiteId}/${member}`;
      const outcome = await writeLcovReport(
        path.join(profiles, suiteId, member),
        path.join(root, COVERAGE_REPORT_DIR, name, COVERAGE_REPORT_FILE),
      );
      if (!outcome.ok) ok = false;
      reports.push(name);
    }
  }
  return { ok, reports: reports.sort() };
}

/** The subdirectories of a directory, or none where it does not exist. */
async function directoriesIn(at: string): Promise<string[]> {
  const names: string[] = [];
  try {
    for await (const entry of Deno.readDir(at)) {
      if (entry.isDirectory) names.push(entry.name);
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
  return names.sort();
}

/**
 * Runs one batch, once per repeat, gathering each execution's records
 * before the next can reuse a path the runner owns. Every repeat must
 * pass: a repeat is not a retry, and three runs of a test is strictly
 * stricter than one.
 *
 * A record whose kind and scope are outside the suite's declared
 * surfaces, or that a producer marked with a variant the batch did not
 * run in, is kept as its producer wrote it and reported. The batch is
 * not failed for it: the mistake is in the metadata, and the tests it
 * came with either passed or did not. The record then belongs to no
 * suite, which is what the store half of the drift guard fails on.
 */
export async function runBatch(
  batch: Batch,
  options: LaneOptions,
  workDir: string,
  spool: string | undefined,
  env: Record<string, string>,
  coverage?: BatchCoverage,
): Promise<{
  ok: boolean;
  records: TestRecord[];
  conflicts: TestRecord[];
  seconds: number;
}> {
  const records: TestRecord[] = [];
  const conflicts: TestRecord[] = [];
  let ok = true;
  let seconds = 0;
  for (let run = 1; run <= batchRepeats(batch); run++) {
    const outputDir = path.join(workDir, `${batch.suite.id}-${run}`);
    const batchSpool = path.join(outputDir, "spool");
    await Deno.mkdir(batchSpool, { recursive: true });
    const invocations = await batch.suite.command(unitsForRun(batch, run), {
      root: options.root,
      outputDir,
      spoolDir: batchSpool,
      ...(options.base === undefined ? {} : { baseRef: options.base }),
      ...(coverage === undefined ? {} : {
        coverageDir: coverage.dir,
        ...(coverage.members === undefined
          ? {}
          : { measuredMembers: coverage.members }),
      }),
    });
    for (const invocation of invocations) {
      const outcome = await runInvocation(invocation, {
        ...env,
        // Each execution writes into a spool of its own, so a repeat
        // cannot read the previous run's fragments and a failure part
        // way through keeps what finished.
        CF_TEST_RECORDS_DIR: batchSpool,
        ...invocation.env,
      });
      seconds += outcome.seconds;
      if (!outcome.ok) ok = false;
      const collected = await collectRecords({
        spoolDir: batchSpool,
        junit: (invocation.junit ?? []).map((output) => ({
          kind: output.kind,
          scope: output.scope,
          glob: output.path,
          ...(output.filePrefix === undefined
            ? {}
            : { prefix: output.filePrefix }),
        })),
        surfaces: batch.suite.recordSurfaces,
        ...(batch.suite.variant === undefined
          ? {}
          : { variant: batch.suite.variant }),
      });
      records.push(...collected.records);
      conflicts.push(...collected.conflicts);
      await Deno.remove(batchSpool, { recursive: true }).catch(() => {});
      await Deno.mkdir(batchSpool, { recursive: true });
    }
  }
  if (spool !== undefined) {
    spoolRecords(spool, [
      ...records,
      timingRecord(
        batchMeasurementName(batch.suite.id, coverage !== undefined),
        seconds,
        ok,
      ),
    ]);
  }
  return { ok, records, conflicts, seconds };
}

/** What reading a batch's records against what it was asked to run found. */
export interface Accounting {
  /** Failing identities whose failure fails the lane. */
  gating: string[];

  /** Failing identities a flake rate excuses, where they are excused. */
  excused: string[];

  /**
   * Units the batch was asked to run that recorded nothing at all. A
   * unit runs its tests or it does not, so a unit with no record is a
   * runner that ran none of it — a skip list that swallowed the whole
   * unit, or a command that reported success having done nothing.
   */
  silent: string[];

  /**
   * Identities the batch was asked to run and no record accounts for.
   * An excused failure beside one of these is not excused: an invocation
   * that recorded a failure and then stopped has run almost nothing
   * while satisfying any weaker test.
   */
  unaccounted: string[];

  /**
   * The units a failure was seen in, whether or not it was excused. A
   * measured set holding one of these measured its member through a
   * failing test.
   */
  failedUnits: string[];
}

/**
 * Reads one batch's records against what it was asked to run.
 *
 * An identity is accounted for by a record naming it. A stand-in is
 * accounted for by its unit recording anything at all: a stand-in is what
 * the packer places for a unit no manifest has seen, and no record will
 * ever carry its name, because a real record is named for a test rather
 * than for a file.
 *
 * A unit that recorded nothing recorded nothing under any name, and that
 * is the state no run should pass in. An identity that went unaccounted
 * for while its unit recorded is ordinary churn — a manifest is hours old
 * by construction, and a test renamed since records under the new name —
 * so it costs an excusal rather than the run.
 */
export function accountFor(
  batch: Batch,
  asked: readonly Selection[],
  records: readonly TestRecord[],
  nonGating: ReadonlySet<string>,
): Accounting {
  const gating: string[] = [];
  const excused: string[] = [];
  const heard = new Set<string>();
  const heardUnits = new Set<string>();
  const failedUnits = new Set<string>();
  for (const record of records) {
    const location = batch.suite.locate(record);
    if (location?.level === "unit") heardUnits.add(location.unit);
    const key = testIdentityKey(record.test);
    heard.add(key);
    if (record.outcome !== "fail") continue;
    if (location?.level === "unit") failedUnits.add(location.unit);
    (nonGating.has(key) ? excused : gating).push(key);
  }
  const unaccounted = asked
    .filter((selection) => selection.entry.suite === batch.suite.id)
    .filter((selection) =>
      isStandIn(selection.entry)
        ? !heardUnits.has(selection.entry.unit)
        : !heard.has(testIdentityKey(selection.entry.test))
    )
    .map((selection) => testIdentityKey(selection.entry.test));
  const silent = batch.units
    .map((request) => request.unit)
    .filter((unit) => !heardUnits.has(unit));
  return {
    gating: [...new Set(gating)].sort(),
    excused: [...new Set(excused)].sort(),
    silent: silent.sort(),
    unaccounted: [...new Set(unaccounted)].sort(),
    failedUnits: [...failedUnits].sort(),
  };
}

/** Says what a batch's records came to, where they came to anything. */
export function describeAccounting(
  suite: string,
  accounting: Accounting,
  excusing: boolean,
): void {
  const lines: string[] = [];
  if (accounting.excused.length > 0) {
    lines.push(
      excusing
        ? `${suite}: ${accounting.excused.length} failures too flaky to ` +
          `judge a change by, which do not fail this run:`
        : `${suite}: ${accounting.excused.length} failures a flake rate ` +
          `would excuse, which fail this run because the batch did not ` +
          `account for everything it was asked to run:`,
      "",
    );
    for (const key of accounting.excused) lines.push(`- ${key}`);
  }
  if (accounting.silent.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(
      `${suite}: ${accounting.silent.length} units recorded nothing, so ` +
        `nothing ran them:`,
      "",
    );
    for (const unit of accounting.silent) lines.push(`- ${unit}`);
  }
  if (lines.length > 0) say(lines);
}

/** Says something both on the lane's output and in the job summary. */
function say(lines: readonly string[]): void {
  const text = `${lines.join("\n")}\n`;
  console.log(text);
  const summary = Deno.env.get("GITHUB_STEP_SUMMARY");
  if (summary !== undefined && summary.length > 0) {
    Deno.writeTextFileSync(summary, text, { append: true });
  }
}

/**
 * Names the records this lane produced that no suite describes, which is
 * the only report they get before the store half of the drift guard
 * fails on them.
 */
export function describeConflicts(conflicts: readonly TestRecord[]): void {
  if (conflicts.length === 0) return;
  say([
    "These records name a surface the suite that ran them does not " +
    "declare, so they were kept as written rather than marked:",
    "",
    ...conflicts.map((record) => `- ${testIdentityKey(record.test)}`),
  ]);
}

/** What a withheld identity is absent for, in words. */
const WITHHELD_REASONS: Record<WithheldReason, string> = {
  flaky: "too noisy to judge a change by",
};

/**
 * Names what the manifest withheld from selection, so that what a lane
 * did not run is visible rather than quietly absent.
 *
 * An identity the change made mandatory comes back in spite of being
 * withheld, since a change touching what a failing test covers is very
 * likely a fix and must be allowed to prove itself. Saying which of them
 * that happened to is the difference between "this did not run" and
 * "this ran because you touched it".
 */
export function describeWithheld(
  withheld: Manifest["withheld"],
  mandatory: ReadonlyMap<string, SelectionReason>,
): void {
  if (withheld.length === 0) return;
  const lines = [
    "Withheld from selection, so no lane chose them:",
    "",
    "| Identity | Suite | Withheld because | Ran anyway |",
    "| --- | --- | --- | --- |",
  ];
  for (const entry of withheld) {
    const back = mandatory.has(testIdentityKey(entry.test));
    lines.push(
      `| ${testIdentityKey(entry.test)} | ${entry.suite} | ` +
        `${WITHHELD_REASONS[entry.reason]} | ` +
        `${back ? "yes, the change reaches it" : "no"} |`,
    );
  }
  say(lines);
}

/** What one suite's share of a lane was chosen for, and what it costs. */
function chosenFor(
  suite: string,
  selections: readonly Selection[],
): { identities: number; seconds: number; why: string } {
  const mine = selections.filter((s) => s.entry.suite === suite);
  const reasons = new Map<SelectionReason, number>();
  let seconds = 0;
  for (const selection of mine) {
    reasons.set(selection.reason, (reasons.get(selection.reason) ?? 0) + 1);
    seconds += selection.entry.cost * selection.repeats;
  }
  return {
    identities: mine.length,
    seconds,
    why: [...reasons].sort().map(([reason, count]) => `${reason} ${count}`)
      .join(", "),
  };
}

/**
 * Prints what the lane is about to do, for the job summary.
 *
 * Where the lane is running a selection, each batch says what it is
 * expected to take and why each of its identities was chosen. "Why did
 * my test not run" is the question a selected run provokes, and a
 * summary that only names the suites cannot begin to answer it. The
 * seconds are the tests' own measured time and not what the lane will
 * take: the overheads the packer charged on top are per lane rather than
 * per identity, and `projectedSeconds` is where the whole figure is.
 */
export function describePlan(
  options: LaneOptions,
  batches: readonly Batch[],
  capabilities: readonly CapabilityId[],
  manifest: { objectName?: string; absent?: string },
  unschedulable: readonly string[],
  chosen: { selections: readonly Selection[]; projectedSeconds: number },
  budget: number,
  unmeasured: number,
  entries: number,
): void {
  const lines: string[] = [];
  lines.push(`## Lane ${options.lane} of ${options.of}`);
  lines.push("");
  lines.push(
    manifest.absent === undefined
      ? `Manifest: \`${manifest.objectName}\``
      : `Running unselected: ${manifest.absent}`,
  );
  lines.push("");
  lines.push(`Capabilities: ${capabilities.join(", ") || "none"}`);
  lines.push("");
  lines.push(
    `Projected: ${chosen.projectedSeconds.toFixed(0)}s of ${budget}s` +
      // Every stand-in in that figure is a guess at what a unit costs,
      // so a projection carrying many of them says what the lane would
      // take if the guesses were right rather than what it will take.
      // Somebody reading a summary beside a lane that ran four times as
      // long deserves to be told which of the two they have.
      (unmeasured === 0
        ? ""
        : `, ${unmeasured} of ${entries} costs unmeasured`),
  );
  lines.push("");
  lines.push(
    "| Suite | Units | Tests | Their own time | Executions | Chosen |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const batch of batches) {
    const share = chosenFor(batch.suite.id, chosen.selections);
    lines.push(
      `| ${batch.suite.id} | ${batch.units.length} | ${share.identities} | ` +
        `${share.seconds.toFixed(1)}s | ${batchRepeats(batch)} | ` +
        `${share.why} |`,
    );
  }
  if (unschedulable.length > 0) {
    lines.push("");
    lines.push("Nothing can run these, so nothing did:");
    lines.push("");
    for (const entry of unschedulable) lines.push(`- ${entry}`);
  }
  say(lines);
}

/** What the lane reaches for beyond its own arguments. */
export interface LaneDeps {
  /**
   * Where the manifest comes from. A caller that supplies one is saying
   * what the store holds, which is how the selected path — the packing,
   * the skip lists, the summary — is exercised without one.
   */
  manifest?: (at: string) => Promise<ManifestFetch>;

  /**
   * Where the suites come from. A caller that supplies them is saying
   * what the working tree holds, which is the only way what the lane
   * does with a batch — opening its capabilities, running it, gathering
   * what it recorded — can be exercised without running the
   * repository's real suites to find out.
   */
  topology?: (root: string) => Promise<Suite[]>;

  /**
   * Where the lane writes what it measured about itself. The default is
   * the enclosing run's spool, which is the job the lane is. A caller
   * that supplies one is saying where those measurements go, and a lane
   * run from inside a test needs to, because the enclosing run there is
   * the run testing it and its spool ships.
   */
  spool?: () => string | undefined;
}

/** What reading this tree against its manifest came to. */
interface Reading {
  seen: Census;
  fetched: { objectName?: string; absent?: string };
}

/**
 * Resolves the manifest this commit belongs to and reads the working
 * tree against it.
 *
 * Everything that plans anything starts here — a lane, and the job that
 * counts the full run's lanes — so the tree and the manifest are
 * resolved one way. Two readers of the same tree that resolved it
 * differently would be the drift this whole path exists to remove,
 * appearing one level above the packer instead of inside it.
 */
async function read(
  options: LaneOptions,
  suites: readonly Suite[],
  deps: LaneDeps,
  say: (line: string) => void,
): Promise<Reading> {
  const moment = await manifestMoment(options);
  if (moment.note !== undefined) say(`ci-lane: ${moment.note}`);
  const fetch = deps.manifest ?? ((at: string) => fetchManifest({ at }));
  const manifest = await fetch(moment.at);
  // A full run reads the manifest for what things cost and nothing else,
  // and a run with no diff has touched nothing.
  const changed = options.full
    ? new Set<string>()
    : await changedFiles(options.root, options.base);
  return {
    seen: census(suites, manifest.manifest, changed),
    fetched: {
      ...(manifest.objectName === undefined
        ? {}
        : { objectName: manifest.objectName }),
      ...(manifest.absent === undefined ? {} : { absent: manifest.absent }),
    },
  };
}

/**
 * Packs what this tree holds into the lanes this run has.
 *
 * The policy is the whole of what the two runs differ by here. Under
 * `everything` every identity is required, so the exclusions and the
 * value, density and exploration passes have nothing left to act on and
 * the packer behaves the same way for both.
 */
function packing(
  options: LaneOptions,
  suites: readonly Suite[],
  seen: Census,
): ReturnType<typeof plan> {
  return plan({
    manifest: seen.manifest,
    mandatory: seen.mandatory,
    capabilities: capabilitiesBySuite(suites),
    lanes: options.of,
    ...(options.full ? { policy: "everything" as const } : {}),
  });
}

/**
 * How many lanes the full run on `main` needs.
 *
 * This is the whole of what the job ahead of the full run decides, and an
 * integer is the whole of what it emits. The lanes then read the same
 * tree against the same manifest and take their own share, the way the
 * pull-request lanes do, so nothing about what runs passes through a job
 * output and there is no second packing to disagree with theirs.
 *
 * Notes about resolving the manifest go to the error stream, because
 * this answers on the standard one and a job reads the answer from
 * there.
 */
export async function fullLanes(
  options: LaneOptions,
  deps: LaneDeps = {},
): Promise<number> {
  const suites = await (deps.topology ?? loadTopology)(options.root);
  const { seen } = await read(options, suites, deps, console.error);
  if (seen.unmeasured === seen.manifest.entries.length) {
    // Nothing at all has a measured cost, so a cost model here would be
    // arithmetic over a figure this invented, and the answer would be
    // wrong by whatever that figure is wrong by. It errs in the
    // direction that breaks a run, too: too few lanes means every one of
    // them runs past the bound its job is killed at, where too many
    // means some jobs finish early.
    //
    // So a lane per suite with anything to run goes in as a floor. It
    // needs no number nobody measured, and it keeps the count growing as
    // test surfaces are added.
    //
    // The packing is still asked what it would need, and the larger of
    // the two wins. Its answer is only as good as the stand-in costs
    // behind it, which is why it cannot be the whole of this — but those
    // costs are what the lanes will actually be packed against, so an
    // answer below what they imply is one the lanes cannot honor
    // whatever else is true. That matters most where a stand-in costs
    // more than the bare unmeasured figure: a suite whose measured units
    // have all been renamed away carries its old median onto every
    // stand-in, and a count that assumed the bare figure would be out by
    // that whole multiple.
    const running = suites.filter((suite) => {
      const unavailable = unavailableUnits(suite);
      return suite.units.some((unit) => !unavailable.has(unit));
    });
    const byCost = fullLaneCount({
      manifest: seen.manifest,
      capabilities: capabilitiesBySuite(suites),
    });
    const lanes = Math.max(1, running.length, byCost);
    console.error(
      `ci-lane: nothing in this tree has a measured cost, so the lane ` +
        `count is ${lanes} — ${running.length} suites with anything to ` +
        `run, and ${byCost} from packing the stand-ins — rather than a ` +
        `projection from costs nobody has measured`,
    );
    return lanes;
  }
  return fullLaneCount({
    manifest: seen.manifest,
    capabilities: capabilitiesBySuite(suites),
  });
}

/**
 * The directory the continuous-integration job keeps its own temporary
 * files in, where the lane is running inside one.
 */
function runnerTemp(): string | undefined {
  const at = Deno.env.get("RUNNER_TEMP");
  return at === undefined || at.length === 0 ? undefined : at;
}

/** Runs one lane, and says whether everything in it passed. */
export async function runLane(
  options: LaneOptions,
  deps: LaneDeps = {},
): Promise<boolean> {
  const suites = await (deps.topology ?? loadTopology)(options.root);
  const { seen, fetched } = await read(options, suites, deps, console.log);
  const laid = packing(options, suites, seen);
  const mine = laid.lanes.find((lane) => lane.lane === options.lane);
  if (mine === undefined) {
    // A lane outside the run it belongs to. Taking an empty share
    // instead would run nothing and exit zero, reporting a pass over
    // a set no lane ran, which is the one failure of this design
    // that would be silent.
    throw new RangeError(
      `lane ${options.lane} has no share of a plan for ${options.of} lanes`,
    );
  }
  const batches = batchesOf(suites, seen.manifest, mine.selections);
  // A discretionary identity costing more than a lane's hard bound
  // runs nowhere, because a lane holding it would be killed before it
  // reported anything. Naming it is what turns that into something
  // somebody can act on; the sixty-second rule is where such a test
  // gets split. A mandatory one is placed however much it costs, and
  // the over-budget line below is where a lane says it ran long.
  const unschedulable = laid.unschedulable.map((entry) =>
    `${entry.suite}: ${testIdentityKey(entry.test)} costs ` +
    `${entry.cost.toFixed(0)}s, more than a lane can hold`
  );
  if (laid.overBudgetSeconds > 0) {
    console.log(
      `ci-lane: the mandatory set puts a lane ` +
        `${laid.overBudgetSeconds.toFixed(0)} seconds past the ` +
        `${laid.budgetSeconds}-second budget`,
    );
  }

  const needs = new Set<CapabilityId>();
  for (const batch of batches) {
    for (const capability of batch.suite.needs) needs.add(capability);
  }
  describePlan(
    options,
    batches,
    [...needs].sort(),
    fetched,
    unschedulable,
    { selections: mine.selections, projectedSeconds: mine.projectedSeconds },
    laid.budgetSeconds,
    seen.unmeasured,
    seen.manifest.entries.length,
  );
  describeWithheld(laid.withheld, seen.mandatory);
  if (options.dryRun) return true;

  const workDir = await Deno.makeTempDir({
    prefix: "ci-lane-",
    // Under the job's own temporary directory where there is one, so that
    // a workflow step can upload what a failing lane left behind. A
    // server's log is written here, and a lane that failed is exactly
    // when somebody wants to read one.
    ...(runnerTemp() === undefined ? {} : { dir: runnerTemp() }),
  });
  const spool = (deps.spool ?? recordsDir)();
  // Before any capability opens and before any batch runs. A child
  // inherits what this process holds, so a token left here would reach
  // every test in the lane whatever its suite declared — and a lane that
  // opens `github-api` is not the one where that matters.
  const githubToken = takeGithubToken();
  // The directory belongs to the lane from the moment it exists, and a
  // capability that refuses to open is one of the ways the lane ends.
  let opened;
  try {
    opened = await openCapabilities([...needs], {
      root: options.root,
      dryRun: false,
      workDir,
      ...(githubToken === undefined ? {} : { githubToken }),
    });
  } catch (error) {
    await Deno.remove(workDir, { recursive: true }).catch(() => {});
    throw error;
  }
  if (spool !== undefined) {
    spoolRecords(
      spool,
      opened.timings.map((timing) =>
        timingRecord(
          `${LANE_MEASUREMENT_PREFIX}setup ${timing.capability}`,
          timing.seconds,
          true,
        )
      ),
    );
  }
  let ok = true;
  const conflicts: TestRecord[] = [];
  // Units a failure was seen in, as `suite\tunit` keys. A set holding one
  // of these measured its member through a failing test, so its number is
  // short by whatever that test would have reached.
  const failedUnits = new Set<string>();
  // What a failure here is allowed not to fail the run for. A pull
  // request holds these back rather than running them, so the set is
  // empty there and the whole of this is the full run's.
  const nonGating = new Set(
    laid.nonGating.map((entry) => testIdentityKey(entry.test)),
  );
  try {
    for (const batch of batches) {
      // A failure never stops the lane: one failing batch would otherwise
      // hide every batch and every repeat after it, and the point of a
      // lane is what it measured.
      const result = await runBatch(
        batch,
        options,
        workDir,
        spool,
        // Two capabilities may export the same name and mean different
        // things by it, and the two server-execution arms can share a
        // lane.
        opened.envFor(batch.suite.needs),
        batchCoverage(options, batch.suite.id, seen.coverage),
      );
      conflicts.push(...result.conflicts);
      // The records decide, rather than the command's exit status: a
      // runner that failed only on identities a flake rate excuses
      // exits non-zero and has told this run nothing it should stop
      // for, and a runner that exited zero having run none of its unit
      // has.
      const accounting = accountFor(
        batch,
        mine.selections,
        result.records,
        nonGating,
      );
      // An invocation is excused only when it accounted for every
      // identity it was asked to run: one that recorded a failure and
      // then stopped has run almost nothing while satisfying any weaker
      // test.
      const excusing = accounting.unaccounted.length === 0;
      describeAccounting(batch.suite.id, accounting, excusing);
      if (accounting.silent.length > 0) ok = false;
      if (accounting.gating.length > 0) ok = false;
      if (!excusing && accounting.excused.length > 0) ok = false;
      for (const unit of accounting.failedUnits) {
        failedUnits.add(`${batch.suite.id}\t${unit}`);
      }
      // A batch that failed with no failing record of its own failed
      // somewhere the records cannot see — a runner that could not
      // start, a command that died before reporting.
      if (
        !result.ok && accounting.gating.length === 0 &&
        accounting.excused.length === 0
      ) {
        ok = false;
      }
    }
  } finally {
    await opened.close();
    // A lane that passed leaves nothing behind. A lane that failed keeps
    // what its capabilities wrote, because a server's log is what says
    // why a suite could not reach it, and the directory is under the
    // job's own temporary directory so the workflow can upload it.
    if (ok) await Deno.remove(workDir, { recursive: true }).catch(() => {});
  }
  describeConflicts(conflicts);
  // After the capabilities are closed, because a conversion is the lane's
  // own work and needs nothing a suite opened. A conversion that lost a
  // tracked file fails the lane: every line of that file reads as
  // uncovered downstream, so a gate scored from it would fail somebody
  // for a report that was never complete.
  const converted = await convertCoverage(options);
  if (!converted.ok) ok = false;
  const marked = await markMeasuredFailures(options, suites, failedUnits);
  describeCoverage(seen.coverage, converted.reports, marked);
  return ok;
}

/**
 * Says what the coverage gate is doing, and what this lane measured for
 * it. A change that reached a set and is not being gated says why here,
 * so that a set the cap left unforced is visible rather than absent.
 */
export function describeCoverage(
  gate: CoverageGateSelection,
  reports: readonly string[],
  marked: readonly string[] = [],
): void {
  if (
    gate.reached.length === 0 && reports.length === 0 && marked.length === 0
  ) {
    return;
  }
  const lines = ["## Coverage", ""];
  if (gate.off !== undefined) {
    lines.push(`No measured set is forced: ${gate.off}.`, "");
    lines.push("Reached, and not forced:", "");
    for (const ref of gate.reached) lines.push(`- ${measuredSetName(ref)}`);
  } else if (gate.sets.length > 0) {
    lines.push("Measured sets this change reaches, run whole and scored:", "");
    for (const ref of gate.sets) lines.push(`- ${measuredSetName(ref)}`);
  }
  if (reports.length > 0) {
    // A report belonging to a set is named as the set, so one summary
    // does not spell one thing two ways. What is left is a directory a
    // suite wrote and no set is scored from, which only the full run's
    // merge reads.
    const named = new Map(
      gate.reached.map((
        ref,
      ) => [measuredSetDirectory(ref), measuredSetName(ref)]),
    );
    lines.push("", "Reports this lane wrote:", "");
    for (const report of reports) {
      lines.push(`- ${named.get(report) ?? report}`);
    }
  }
  if (marked.length > 0) {
    lines.push(
      "",
      "Measured through a failing test, so no baseline is published:",
      "",
    );
    for (const set of marked) lines.push(`- ${set}`);
  }
  say(lines);
}

/**
 * Runs the lane the way the job runs it, and answers with the status it
 * would exit with: two for a command line this cannot read, one for a
 * lane that failed, zero otherwise.
 */
export async function main(
  args: readonly string[] = Deno.args,
  root: string = Deno.cwd(),
  deps: LaneDeps = {},
): Promise<number> {
  const options = parseLaneArgs(args, root);
  if (options === undefined) {
    console.error(
      "usage: ci-lane.ts [--lane N] [--of M] [--full] [--dry-run] " +
        "[--lane-count] [--base <ref>] [--at <iso>] [--coverage-dir <dir>]",
    );
    return 2;
  }
  if (options.laneCount) {
    console.log(String(await fullLanes(options, deps)));
    return 0;
  }
  return await runLane(options, deps) ? 0 : 1;
}

// `Deno.exitCode` rather than `Deno.exit`, which would end the process
// before the unload handlers run — and one of those is what writes a
// test run's name map into its spool.
if (import.meta.main) Deno.exitCode = await main();
