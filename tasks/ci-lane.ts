#!/usr/bin/env -S deno run -A

/**
 * The script every pull-request lane runs, and the full run on `main`
 * runs with selection switched off.
 *
 * Five lanes call this with their own lane number and nothing else.
 * There is no job ahead of them deciding what each will do: packing is a
 * pure function of the manifest, the diff, and the lane number, so all
 * five compute the same plan over the same inputs and take their own
 * share of it. That only holds while every lane resolves the same
 * manifest, which is why the moment they resolve it at is when the
 * commit under test was made rather than anything about the run.
 *
 *   deno run -A tasks/ci-lane.ts --lane 3 --of 5 --base origin/main
 *   deno run -A tasks/ci-lane.ts --full --lane 1 --of 4
 *   deno run -A tasks/ci-lane.ts --lane 1 --of 5 --dry-run
 */

import * as path from "@std/path";
import {
  FragmentWriter,
  recordsDir,
  type TestIdentity,
  testIdentityKey,
  type TestRecord,
} from "@commonfabric/test-support/records";
import { type CapabilityId, openCapabilities } from "./ci-capabilities.ts";
import { capabilitiesBySuite, loadTopology } from "./test-topology.ts";
import {
  type Invocation,
  type Suite,
  unavailableUnits,
  type UnitRequest,
} from "./test-topology/suite.ts";
import { collectRecords } from "./test-records-gather.ts";
import { fetchManifest, type ManifestFetch } from "./test-selection/store.ts";
import {
  plan,
  type Selection,
  type SelectionReason,
} from "./test-selection/plan.ts";
import type { Manifest } from "./test-selection/manifest.ts";
import { LANE_BUDGET_SECONDS, LANES } from "./test-selection/policy.ts";

/** What the lane was asked to do. */
export interface LaneOptions {
  lane: number;
  of: number;

  /** Run everything the topology holds, which is what `main` does. */
  full: boolean;

  /** Print the plan and run nothing. */
  dryRun: boolean;

  /** What the change is measured against. */
  base?: string;

  /**
   * The moment to resolve the manifest at, ISO 8601 UTC, in place of the
   * commit's own. For asking what a lane would have done at a moment
   * that is not this tree's, which is what a dry run against recorded
   * data wants.
   */
  at?: string;

  root: string;
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
      default:
        return undefined;
    }
  }
  if (!Number.isInteger(options.lane) || options.lane < 1) return undefined;
  if (!Number.isInteger(options.of) || options.of < options.lane) {
    return undefined;
  }
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

/** What the diff and the topology together make mandatory. */
export interface MandatoryInput {
  mandatory: Map<string, SelectionReason>;
  unknown: Map<string, { suite: string; unit: string }>;
}

/**
 * What must run whatever the score says: every unit of an `always` suite,
 * every unit the change touched, and every unit no manifest knows.
 *
 * The last of those is the rule the test-record spec requires of any
 * consumer that selects which tests run. A selector that never runs the
 * unselected starves its own data, and a renamed test is an unknown
 * identity until an alias lands.
 */
export function mandatoryFor(
  suites: readonly Suite[],
  manifest: Manifest | undefined,
  changed: ReadonlySet<string>,
): MandatoryInput {
  const mandatory = new Map<string, SelectionReason>();
  const unknown = new Map<string, { suite: string; unit: string }>();
  const known = new Map<string, Set<string>>();
  for (const entry of manifest?.entries ?? []) {
    const units = known.get(entry.suite);
    if (units === undefined) known.set(entry.suite, new Set([entry.unit]));
    else units.add(entry.unit);
  }
  const identitiesOf = new Map<string, string[]>();
  for (const entry of manifest?.entries ?? []) {
    const key = `${entry.suite}\t${entry.unit}`;
    identitiesOf.set(key, [
      ...identitiesOf.get(key) ?? [],
      testIdentityKey(entry.test),
    ]);
  }
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
      const recorded = identitiesOf.get(`${suite.id}\t${unit}`);
      if (recorded === undefined) {
        // Nothing in the manifest runs this unit, so it is unknown
        // whatever else made it mandatory.
        const key = testIdentityKey(unknownIdentity(suite, unit));
        mandatory.set(key, reason ?? "unknown");
        unknown.set(key, { suite: suite.id, unit });
        continue;
      }
      if (reason === undefined) continue;
      for (const key of recorded) mandatory.set(key, reason);
    }
  }
  return { mandatory, unknown };
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

  /** How many times this batch runs. Every run must pass. */
  repeats: number;
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
  const selectedNames = new Map<string, Set<string>>();
  const repeatsOf = new Map<string, number>();
  for (const selection of selections) {
    const key = `${selection.entry.suite}\t${selection.entry.unit}`;
    const names = selectedNames.get(key);
    if (names === undefined) {
      selectedNames.set(key, new Set([selection.entry.test.n]));
    } else names.add(selection.entry.test.n);
    repeatsOf.set(
      key,
      Math.max(repeatsOf.get(key) ?? 1, selection.repeats),
    );
  }
  for (const [key, names] of selectedNames) {
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
        repeats: repeatsOf.get(key) ?? 1,
      });
    } else {
      batch.units.push(request);
      batch.repeats = Math.max(batch.repeats, repeatsOf.get(key) ?? 1);
    }
  }
  return [...batches.values()];
}

/** Every unit of every suite, which is what the full run holds. */
export function everyBatch(
  suites: readonly Suite[],
  lane: number,
  of: number,
): Batch[] {
  const batches: Batch[] = [];
  let index = 0;
  for (const suite of suites) {
    const unavailable = unavailableUnits(suite);
    const units: UnitRequest[] = [];
    for (const unit of suite.units) {
      if (unavailable.has(unit)) continue;
      // A suite's units are spread across the lanes in the order they
      // enumerate, so every lane knows its own share without being told.
      if (index++ % of === lane - 1) units.push({ unit, skip: [] });
    }
    if (units.length > 0) batches.push({ suite, units, repeats: 1 });
  }
  return batches;
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

/** The record surface the lane measures itself on. */
export const LANE_MEASUREMENT_SURFACE = { kind: "gate", scope: "ci" };

/** What the lane's own measurements are named for. */
export const LANE_MEASUREMENT_PREFIX = "ci-lane ";

/**
 * Whether an identity is the lane measuring itself rather than a test.
 *
 * The topology claims test surfaces, and these are not one: nothing
 * enumerates them, nothing scores them, and no lane can be asked to run
 * one. They would therefore be identities no suite claims, which is what
 * the store half of the drift guard exists to fail on, so the guard is
 * told about them here — beside the code that writes them, rather than in
 * a second list that could describe something this no longer produces.
 */
export function isLaneMeasurement(test: TestIdentity): boolean {
  return test.k === LANE_MEASUREMENT_SURFACE.kind &&
    test.s === LANE_MEASUREMENT_SURFACE.scope &&
    test.n.startsWith(LANE_MEASUREMENT_PREFIX);
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
function spoolRecords(spool: string, records: readonly TestRecord[]): void {
  if (records.length === 0) return;
  const writer = FragmentWriter.open(spool);
  if (writer === undefined) return;
  for (const record of records) writer.append(record);
  writer.close();
}

/**
 * Runs one batch, once per repeat, gathering each execution's records
 * before the next can reuse a path the runner owns. Every repeat must
 * pass: a repeat is not a retry, and three runs of a test is strictly
 * stricter than one.
 */
export async function runBatch(
  batch: Batch,
  options: LaneOptions,
  workDir: string,
  spool: string | undefined,
  env: Record<string, string>,
): Promise<{ ok: boolean; records: TestRecord[]; seconds: number }> {
  const records: TestRecord[] = [];
  let ok = true;
  let seconds = 0;
  for (let run = 1; run <= batch.repeats; run++) {
    const outputDir = path.join(workDir, `${batch.suite.id}-${run}`);
    const batchSpool = path.join(outputDir, "spool");
    await Deno.mkdir(batchSpool, { recursive: true });
    const invocations = await batch.suite.command(batch.units, {
      root: options.root,
      outputDir,
      ...(options.base === undefined ? {} : { baseRef: options.base }),
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
      records.push(
        ...await collectRecords({
          spoolDir: batchSpool,
          junit: (invocation.junit ?? []).map((output) => ({
            kind: output.kind,
            scope: output.scope,
            glob: output.path,
            ...(output.filePrefix === undefined
              ? {}
              : { prefix: output.filePrefix }),
          })),
          ...(batch.suite.variant === undefined
            ? {}
            : { variant: batch.suite.variant }),
        }),
      );
      await Deno.remove(batchSpool, { recursive: true }).catch(() => {});
      await Deno.mkdir(batchSpool, { recursive: true });
    }
  }
  if (spool !== undefined) {
    spoolRecords(spool, [
      ...records,
      timingRecord(`ci-lane batch ${batch.suite.id}`, seconds, ok),
    ]);
  }
  return { ok, records, seconds };
}

/** Prints what the lane is about to do, for the job summary. */
export function describePlan(
  options: LaneOptions,
  batches: readonly Batch[],
  capabilities: readonly CapabilityId[],
  manifest: { objectName?: string; absent?: string },
  unschedulable: readonly string[] = [],
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
  lines.push("| Suite | Units | Repeats |");
  lines.push("| --- | --- | --- |");
  for (const batch of batches) {
    lines.push(
      `| ${batch.suite.id} | ${batch.units.length} | ${batch.repeats} |`,
    );
  }
  if (unschedulable.length > 0) {
    lines.push("");
    lines.push("Nothing can run these, so nothing did:");
    lines.push("");
    for (const entry of unschedulable) lines.push(`- ${entry}`);
  }
  const text = `${lines.join("\n")}\n`;
  console.log(text);
  const summary = Deno.env.get("GITHUB_STEP_SUMMARY");
  if (summary !== undefined && summary.length > 0) {
    Deno.writeTextFileSync(summary, text, { append: true });
  }
}

/** What the lane reaches for beyond its own arguments. */
export interface LaneDeps {
  /**
   * Where the manifest comes from. A caller that supplies one is saying
   * what the store holds, which is how the selected path — the packing,
   * the skip lists, the summary — is exercised without one.
   */
  manifest?: (at: string) => Promise<ManifestFetch>;
}

/** Runs one lane, and says whether everything in it passed. */
export async function runLane(
  options: LaneOptions,
  deps: LaneDeps = {},
): Promise<boolean> {
  const suites = await loadTopology(options.root);
  let batches: Batch[];
  let unschedulable: string[] = [];
  let fetched: { objectName?: string; absent?: string } = {};
  if (options.full) {
    batches = everyBatch(suites, options.lane, options.of);
    fetched = { absent: "running everything, so nothing is selected" };
  } else {
    const moment = await manifestMoment(options);
    if (moment.note !== undefined) console.log(`ci-lane: ${moment.note}`);
    const manifest = await (deps.manifest ?? ((at: string) =>
      fetchManifest({ at })))(moment.at);
    fetched = {
      ...(manifest.objectName === undefined
        ? {}
        : { objectName: manifest.objectName }),
      ...(manifest.absent === undefined ? {} : { absent: manifest.absent }),
    };
    const changed = await changedFiles(options.root, options.base);
    const { mandatory, unknown } = mandatoryFor(
      suites,
      manifest.manifest,
      changed,
    );
    if (manifest.manifest === undefined) {
      // With no manifest there is nothing to score, so the lane runs the
      // mandatory set and a deterministic slice of the corpus. That is no
      // worse than a coin toss about which tests run, which is what a
      // fixed shard layout was.
      batches = everyBatch(suites, options.lane, options.of);
    } else {
      const laid = plan({
        manifest: manifest.manifest,
        mandatory,
        capabilities: capabilitiesBySuite(suites),
        unknown,
        lanes: options.of,
      });
      const mine = laid.lanes.find((lane) =>
        lane.lane === options.lane
      );
      batches = batchesOf(suites, manifest.manifest, mine?.selections ?? []);
      // An identity costing more than a lane's hard bound runs nowhere,
      // and a mandatory one that cannot run is a hole in what the pull
      // request was told it tested. Naming it is what turns that into
      // something somebody can act on; the sixty-second rule is where
      // such a test gets split.
      unschedulable = laid.unschedulable.map((entry) =>
        `${entry.suite}: ${testIdentityKey(entry.test)} costs ` +
        `${entry.cost.toFixed(0)}s, more than a lane can hold`
      );
      if (laid.overBudgetSeconds > 0) {
        console.log(
          `ci-lane: the mandatory set puts a lane ` +
            `${laid.overBudgetSeconds.toFixed(0)} seconds past the ` +
            `${LANE_BUDGET_SECONDS}-second budget`,
        );
      }
    }
  }

  const needs = new Set<CapabilityId>();
  for (const batch of batches) {
    for (const capability of batch.suite.needs) needs.add(capability);
  }
  describePlan(options, batches, [...needs].sort(), fetched, unschedulable);
  if (options.dryRun) return true;

  const workDir = await Deno.makeTempDir({ prefix: "ci-lane-" });
  const spool = recordsDir();
  const opened = await openCapabilities([...needs], {
    root: options.root,
    dryRun: false,
    workDir,
  });
  if (spool !== undefined) {
    spoolRecords(
      spool,
      opened.timings.map((timing) =>
        timingRecord(`ci-lane setup ${timing.capability}`, timing.seconds, true)
      ),
    );
  }
  let ok = true;
  try {
    for (const batch of batches) {
      // A failure never stops the lane: one failing batch would otherwise
      // hide every batch and every repeat after it, and the point of a
      // lane is what it measured.
      const result = await runBatch(batch, options, workDir, spool, opened.env);
      if (!result.ok) ok = false;
    }
  } finally {
    await opened.close();
    // The lane owns this directory and nothing outside the lane reads
    // it, so it goes whether the batches passed, failed, or never ran.
    await Deno.remove(workDir, { recursive: true }).catch(() => {});
  }
  return ok;
}

async function main(): Promise<void> {
  const options = parseLaneArgs(Deno.args);
  if (options === undefined) {
    console.error(
      "usage: ci-lane.ts [--lane N] [--of M] [--full] [--dry-run] " +
        "[--base <ref>] [--at <iso>]",
    );
    Deno.exit(2);
  }
  if (!await runLane(options)) Deno.exit(1);
}

if (import.meta.main) {
  await main();
}
