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
  fullLaneCount,
  plan,
  type Selection,
  type SelectionReason,
} from "./test-selection/plan.ts";
import { type Census, census } from "./test-selection/census.ts";
import type { Manifest, WithheldReason } from "./test-selection/manifest.ts";
import {
  FULL_LANE_BUDGET_SECONDS,
  LANES,
  UNMEASURED_COST_SECONDS,
} from "./test-selection/policy.ts";

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
      batches.set(suiteId, { suite, units: [request], repeats });
    } else {
      batch.units.push(request);
      batch.repeats = Math.max(batch.repeats, repeats);
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
      timingRecord(`ci-lane batch ${batch.suite.id}`, seconds, ok),
    ]);
  }
  return { ok, records, conflicts, seconds };
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
  "main-red": "already failing in the latest run on `main`",
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
  lines.push("| Suite | Units | Tests | Their own time | Repeats | Chosen |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const batch of batches) {
    const share = chosenFor(batch.suite.id, chosen.selections);
    lines.push(
      `| ${batch.suite.id} | ${batch.units.length} | ${share.identities} | ` +
        `${share.seconds.toFixed(1)}s | ${batch.repeats} | ${share.why} |`,
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
    // So the shape of the tree answers instead, in two figures that can
    // only raise the count between them. A lane per suite that has
    // anything to run keeps the count growing as test surfaces are
    // added. A lane per budget's worth of units at the stand-in rate
    // keeps it growing as units are added to the suites there already
    // are, which the suite count alone would not notice: a repository
    // that grew to five times the units without gaining a suite would
    // otherwise be given the same number of lanes and run every one of
    // them past the bound its job is killed at.
    //
    // Neither is a projection. Both are shapes counted off the tree, and
    // taking the larger errs the way this has to err, since too few
    // lanes kills a run where too many only finishes some jobs early.
    const running = suites.filter((suite) => {
      const unavailable = unavailableUnits(suite);
      return suite.units.some((unit) => !unavailable.has(unit));
    });
    const perLane = Math.max(
      1,
      Math.floor(FULL_LANE_BUDGET_SECONDS / UNMEASURED_COST_SECONDS),
    );
    const byUnits = Math.ceil(seen.manifest.entries.length / perLane);
    const lanes = Math.max(1, running.length, byUnits);
    console.error(
      `ci-lane: nothing in this tree has a measured cost, so the lane ` +
        `count is ${lanes} from the shape of the tree — ${running.length} ` +
        `suites with anything to run, and ${byUnits} lanes' worth of ` +
        `units — rather than a projection from costs nobody has measured`,
    );
    return lanes;
  }
  return fullLaneCount({
    manifest: seen.manifest,
    capabilities: capabilitiesBySuite(suites),
  });
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
  const conflicts: TestRecord[] = [];
  try {
    for (const batch of batches) {
      // A failure never stops the lane: one failing batch would otherwise
      // hide every batch and every repeat after it, and the point of a
      // lane is what it measured.
      const result = await runBatch(batch, options, workDir, spool, opened.env);
      if (!result.ok) ok = false;
      conflicts.push(...result.conflicts);
    }
  } finally {
    await opened.close();
    // The lane owns this directory and nothing outside the lane reads
    // it, so it goes whether the batches passed, failed, or never ran.
    await Deno.remove(workDir, { recursive: true }).catch(() => {});
  }
  describeConflicts(conflicts);
  return ok;
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
        "[--lane-count] [--base <ref>] [--at <iso>]",
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
