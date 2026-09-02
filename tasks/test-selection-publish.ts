#!/usr/bin/env -S deno run --allow-read --allow-env --allow-net --allow-write

/**
 * The publisher: reads the record store, folds what is new into a rolling
 * aggregate, scores everything, and creates one manifest object.
 *
 *   deno run -A tasks/test-selection-publish.ts [--days N] [--bootstrap]
 *     [--out <dir>] [--dry-run] [--concurrency N]
 *
 * A run reads the newest aggregate and folds what that aggregate does not
 * already hold, which in the steady state is about two thousand objects.
 * A cold start has no aggregate to read and cannot fold three weeks of
 * raw history in one job either, so `--bootstrap` is the one-off that
 * starts from an empty one over a wider window, run by hand.
 *
 * That is the whole of what the flag does. What to read is `inputChoice`
 * asked of each source and date the window covers, and both modes ask it
 * alike; their answers differ because their aggregates differ, and not
 * because one of them chooses inputs a second way.
 *
 * When the publisher fails nothing breaks: the previous manifest is still
 * the newest one and lanes keep using it. A manifest going stale degrades
 * selection slowly rather than failing anything, which is the right
 * direction for a system nothing should gate on.
 */

import { join } from "@std/path";
import { ulid } from "@std/ulid";
import {
  createObject,
  gzipText,
  listObjects,
  loadAliasResolver,
  objectUrl,
  readObject,
  type StoredReport,
} from "@commonfabric/test-support/records";
import {
  ciSubmissionsPrefix,
  storeBucket,
  storePrefix,
} from "./test-records-config.ts";
import { rollupShards } from "./test-records-compact.ts";
import {
  type AggregateState,
  buildManifest,
  CI_SOURCE,
  dayOf,
  emptyAggregate,
  Fold,
  locateSurfaces,
  parseAggregate,
  partitionOf,
  type Unplaced,
} from "./test-selection/build.ts";
import { capabilitiesBySuite, loadTopology } from "./test-topology.ts";
import type { Suite } from "./test-topology/suite.ts";
import {
  manifestBody,
  manifestObjectName,
  manifestPrefix,
  newestAtOrBefore,
  stateObjectName,
  statePrefix,
} from "./test-selection/store.ts";
import { serializeManifest } from "./test-selection/manifest.ts";
import { plan } from "./test-selection/plan.ts";
import { LANE_BUDGET_SECONDS, LANES } from "./test-selection/policy.ts";

/**
 * Everything this reaches the world through. The default is the real
 * store; a test supplies its own and exercises the whole publish without
 * a network, which is the only way the path that actually runs in
 * production gets tested at all.
 */
export interface StoreAccess {
  list(prefix: string): Promise<string[]>;
  read(objectName: string): Promise<StoredReport>;
  readText(objectName: string): Promise<string>;
  create(name: string, body: Uint8Array): Promise<void>;

  /**
   * The objects a day's rollup was written as, when the day has a
   * complete one. A day is compacted into shards sized so that a reader
   * can hold what one decompresses to, and the day's manifest — written
   * after every shard it names — is what says the rollup is finished and
   * which shards it holds. Reading those replaces reading the day's
   * thousands of raw objects.
   *
   * Neither mode asks for one because of the flag it was given: the rule
   * asks wherever a source and date is one nothing has been folded from
   * yet. In the steady state the incremental path never reaches such a
   * day, because compaction waits a week for late arrivals and that path
   * reads two days, so in practice this answers a bootstrap and a run
   * catching up after an outage or a widened window.
   *
   * A rollup is a read optimization rather than the record of its day —
   * an object arriving after its shard is written stays in the raw area
   * alone — so a pair taken this way keeps only what the rollup held.
   */
  rollupShards(day: string): Promise<string[] | undefined>;

  /** The credential for creating an object, when one is reachable. */
  token(): string | undefined;
}

/** The store as it really is. */
export function liveStore(bucket: string): StoreAccess {
  return {
    list: (prefix) => listObjects({ bucket, prefix }),
    read: (objectName) => readObject({ bucket, objectName }),
    readText: async (objectName) => {
      const response = await fetch(objectUrl(bucket, objectName));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      // Transcoded on the way out, so this is already the JSON.
      return await response.text();
    },
    create: async (name, body) => {
      const token = writeToken();
      if (token === undefined) throw new Error("no write credential");
      await createObject({
        bucket,
        name,
        body,
        contentType: "application/json",
        contentEncoding: "gzip",
        token,
      });
    },
    rollupShards: async (day) => {
      try {
        return await rollupShards({ bucket, day });
      } catch {
        return undefined;
      }
    },
    token: writeToken,
  };
}

/** How many objects are fetched at once. */
const DEFAULT_CONCURRENCY = 24;

/** Days the incremental path looks back over for unfolded objects. */
const DEFAULT_DAYS = 2;

/** Days a bootstrap reads, when no window was asked for. */
const BOOTSTRAP_DAYS = 60;

/** Objects read and folded before the next batch is fetched. */
const CHUNK = 200;

/** What the command line asked for. */
export interface Options {
  days: number;
  bootstrap: boolean;
  dryRun: boolean;
  out?: string;
  concurrency: number;
}

export function parseArgs(args: readonly string[]): Options | undefined {
  const options: Options = {
    days: DEFAULT_DAYS,
    bootstrap: false,
    dryRun: false,
    concurrency: DEFAULT_CONCURRENCY,
  };
  // A window somebody asked for wins over the one a bootstrap implies,
  // whichever order the two were typed in.
  let daysGiven = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    switch (flag) {
      case "--bootstrap":
        options.bootstrap = true;
        if (!daysGiven) options.days = BOOTSTRAP_DAYS;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--days": {
        const days = Number(args[++i]);
        if (!Number.isInteger(days) || days < 1) return undefined;
        options.days = days;
        daysGiven = true;
        break;
      }
      case "--concurrency": {
        const concurrency = Number(args[++i]);
        if (!Number.isInteger(concurrency) || concurrency < 1) return undefined;
        options.concurrency = concurrency;
        break;
      }
      case "--out": {
        const out = args[++i];
        if (out === undefined) return undefined;
        options.out = out;
        break;
      }
      default:
        return undefined;
    }
  }
  return options;
}

/** The day partitions to list, newest last. */
export function dayPartitions(today: Date, days: number): string[] {
  const partitions: string[] = [];
  for (let back = days - 1; back >= 0; back--) {
    const day = new Date(today.getTime() - back * 86_400_000);
    partitions.push(day.toISOString().slice(0, 10).replaceAll("-", "/"));
  }
  return partitions;
}

/** Runs a mapper over items, at most `limit` of them at a time. */
async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  map: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await map(items[index]!);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/**
 * Every submission object of the days each area was asked for. A
 * continuous-integration object's day is a path segment, so its day is a
 * prefix and one listing per day is exact. A local object's path puts the
 * reporting person ahead of the day, so that area is listed once and
 * filtered.
 *
 * The two areas are asked for different days because the rule answers
 * differently for them. A continuous-integration day whose rollup is
 * folded owes nothing more; no local day is ever in that position, since
 * rollups cover the continuous-integration area alone.
 */
async function listSubmissions(
  store: StoreAccess,
  ciDays: readonly string[],
  localDays: readonly string[],
): Promise<string[]> {
  const wanted = new Set(localDays);
  const names: string[] = [];
  // A listing that fails is not an empty day. Folding what did list and
  // publishing from it would score every identity in the missing day as
  // though it had not run, and the manifest saying so would become the
  // one every lane obeys. The run ends instead, and the previous manifest
  // stays newest.
  for (const day of ciDays) {
    names.push(...await store.list(`${ciSubmissionsPrefix()}/v1/${day}/`));
  }
  const local = `${storePrefix()}/submissions/local/`;
  for (const name of await store.list(local)) {
    const day = partitionOf(name);
    if (day.length > 0 && wanted.has(day)) names.push(name);
  }
  return [...new Set(names)].sort(byDayThenName);
}

/** What one source and date still owes the aggregate. */
export type InputChoice = "settled" | "rollup" | "raw";

/**
 * What one source and date still has to give, which is the whole of how
 * this program chooses what to read.
 *
 * A bootstrap and an ordinary run apply it alike. A bootstrap is
 * permission to start from an empty aggregate and, by default, a wider
 * window; it is not a second way to choose inputs. Both then ask this of
 * each source and date the window covers, and the answers differ only
 * because the aggregates differ.
 *
 * `settled` — a receipt says this pair's rollup is folded. Rollups of
 * this format carry no record of which arrivals they cover, so nothing
 * can say how much a raw object of that pair would repeat. The pair is
 * closed rather than combined with objects whose overlap is unknown.
 *
 * `rollup` — nothing of this pair is folded and a rollup covers it, so
 * the rollup is the baseline and a receipt is written for it. One object
 * stands in for the day's thousands, which is what makes a cold start
 * over a wide window affordable at all.
 *
 * `raw` — everything else, and two different things reach it. A pair
 * with raw contributions already stays raw, because a rollup written
 * afterwards would overlap them. A pair no rollup covers is raw because
 * there is nothing else to read, which is every local source: rollups
 * cover the continuous-integration area alone.
 */
export function inputChoice(
  known: { settled: boolean; foldedRaw: boolean; rollup: boolean },
): InputChoice {
  if (known.settled) return "settled";
  if (known.foldedRaw || !known.rollup) return "raw";
  return "rollup";
}

/**
 * Orders submission objects the way the fold needs them: by the day they
 * were recorded, then by name. Sorting by name alone would put every
 * local object after every continuous-integration one, because their
 * areas sort that way, and the fold's backward-looking rules would then
 * judge a workstation's failure against a state from days later. Within
 * one day the order between the two areas is arbitrary, which is as fine
 * a grain as the per-day counters have anyway.
 */
export function byDayThenName(left: string, right: string): number {
  const day = partitionOf(left).localeCompare(partitionOf(right));
  return day !== 0 ? day : left.localeCompare(right);
}

/** What reading the rolling aggregate found. */
type AggregateRead =

  /** The state a previous run left. */
  | { state: AggregateState }
  /** The area holds no state at all, so this would be a first run. */
  | { absent: true }
  /** Something went wrong, and what a previous run left is unknown. */
  | { failed: string };

/**
 * Reads the newest aggregate.
 *
 * The three outcomes are kept apart because folding into an empty
 * aggregate while a real one exists is the worst thing this program can
 * do. `catches` accumulates over unbounded history and is the whole of
 * what makes a test worth running, and the state object is where that
 * history lives. A run that lost it and carried on would publish a
 * manifest scoring every test at the floor, and because it succeeded that
 * manifest would become the one every lane obeys. Failing is the designed
 * outcome — the previous manifest stays newest and selection decays
 * slowly — so an unreadable state is told apart from an absent one rather
 * than both becoming an empty one.
 */
async function readAggregate(store: StoreAccess): Promise<AggregateRead> {
  const prefix = statePrefix();
  let names: string[];
  try {
    // Trailing slash for the reason the manifest listing carries one: a
    // bare prefix matches a longer sibling too.
    names = await store.list(`${prefix}/`);
  } catch (error) {
    return { failed: `listing ${prefix} failed: ${error}` };
  }
  const newest = names.filter((name) => name.endsWith(".json.gz")).sort().at(
    -1,
  );
  if (newest === undefined) return { absent: true };
  try {
    const state = parseAggregate(await store.readText(newest));
    return state === undefined
      ? { failed: `${newest} is not an aggregate this reader understands` }
      : { state };
  } catch (error) {
    return { failed: `reading ${newest} failed: ${error}` };
  }
}

/**
 * An access token for creating a manifest, when one is reachable. Only
 * the workflow has one: the publisher's identity is federated and pinned
 * to that workflow file, and it is the sole principal holding create on
 * the selection area. A person's own reporting key is scoped to their
 * `submissions/local/<username>/` folder and cannot write a manifest, so
 * there is no fallback to offer — `--dry-run --out` is how a person sees
 * what a run would produce.
 */
export function writeToken(): string | undefined {
  const federated = Deno.env.get("TEST_RECORDS_GCS_TOKEN");
  return federated !== undefined && federated.length > 0
    ? federated
    : undefined;
}

export async function publish(
  args: readonly string[],
  store: StoreAccess = liveStore(storeBucket()),
  now: Date = new Date(),
  topology: () => Promise<readonly Suite[]> = () => loadTopology(),
): Promise<number> {
  const options = parseArgs(args);
  if (options === undefined) {
    console.error(
      "usage: test-selection-publish.ts [--days N] [--bootstrap] " +
        "[--out <dir>] [--dry-run] [--concurrency N]",
    );
    return 2;
  }

  const startedAt = now;
  const today = startedAt.toISOString().slice(0, 10);
  let aggregate: AggregateState;
  if (options.bootstrap) {
    aggregate = emptyAggregate(today);
  } else {
    const read = await readAggregate(store);
    if ("failed" in read) {
      console.warn(`test selection: ${read.failed}`);
      console.warn(
        "test selection: refusing to publish from an empty aggregate, " +
          "which would score every test at the floor. The previous " +
          "manifest is still the newest one.",
      );
      return 1;
    }
    if ("absent" in read) {
      console.warn(
        "test selection: no aggregate exists yet. A first run reads the " +
          "whole window and is asked for deliberately, with --bootstrap.",
      );
      return 1;
    }
    aggregate = read.state;
  }
  const partitions = dayPartitions(startedAt, options.days);
  const resolver = await loadAliasResolver();
  const fold = new Fold(aggregate, resolver, today);
  const runs = new Set<string>();
  let commit = "unknown";

  const noteReport = (report: StoredReport): void => {
    for (const group of report.reports) {
      const id = group.context?.ci?.workflowRunId;
      if (id !== undefined) runs.add(id);
      if (group.context?.branch === "main") commit = group.context.commit;
    }
  };

  // What each source and date still owes, from the one rule both modes
  // apply. Only the continuous-integration area can answer anything but
  // `raw`, because it is the only one rollups cover, so it is the only
  // one the store is asked about — and it is asked only where the answer
  // could be a rollup, so a run over days it has already read raw asks
  // nothing.
  const rollups = new Map<string, readonly string[]>();
  const ciDays: string[] = [];
  for (const date of partitions) {
    const settled = fold.settled(CI_SOURCE, date);
    const foldedRaw = fold.hasRaw(CI_SOURCE, date);
    const shards = settled || foldedRaw
      ? undefined
      : await store.rollupShards(date);
    switch (
      inputChoice({ settled, foldedRaw, rollup: shards !== undefined })
    ) {
      case "rollup":
        rollups.set(date, shards!);
        break;
      case "raw":
        ciDays.push(date);
        break;
      case "settled":
        break;
    }
  }

  let settled = 0;
  for (const [date, shards] of rollups) {
    try {
      // A pair is folded whole or not at all: a shard that failed to read
      // would leave it partly folded, and writing its receipt would then
      // hide the rest of it from every later run.
      const reports = await mapConcurrent(
        shards,
        options.concurrency,
        (objectName) => store.read(objectName),
      );
      for (const report of reports) noteReport(report);
      fold.add(reports);
      fold.markSettled(CI_SOURCE, date);
      settled++;
    } catch (error) {
      console.warn(
        `test selection: reading the rollup of ${date} failed: ${error}`,
      );
      // No receipt was written, so the pair still owes what it owed, and
      // the raw path is what is left to read it by.
      ciDays.push(date);
    }
  }
  if (rollups.size > 0) {
    console.log(
      `test selection: folded ${settled} day(s) from their rollups`,
    );
  }

  let listed: string[];
  try {
    // Every day of the window for the local area: no local pair is ever
    // settled, so the rule answers `raw` for each of them.
    listed = await listSubmissions(store, ciDays, partitions);
  } catch (error) {
    console.warn(`test selection: listing the submissions failed: ${error}`);
    console.warn(
      "test selection: refusing to publish from part of the window. The " +
        "previous manifest is still the newest one.",
    );
    return 1;
  }
  const fresh = listed.filter((name) => !fold.knows(name));
  console.log(
    `test selection: ${listed.length} object(s) under ${ciDays.length} ` +
      `open day(s), ${fresh.length} not yet folded`,
  );

  // Read and fold in chunks rather than all at once. A bootstrap reads
  // tens of thousands of objects, each holding hundreds of executions,
  // and holding them all would be bounded by the number of runs rather
  // than by the number of tests.
  try {
    for (let at = 0; at < fresh.length; at += CHUNK) {
      const chunk = fresh.slice(at, at + CHUNK);
      const reports = await mapConcurrent(
        chunk,
        options.concurrency,
        // A read that fails is not an object with no records, so it is not
        // swallowed: the same partial-history argument as the listing.
        (objectName) => store.read(objectName),
      );
      for (const report of reports) noteReport(report);
      fold.add(reports);
      console.log(
        `test selection: folded ${at + chunk.length} of ${fresh.length} ` +
          `object(s)`,
      );
    }
  } catch (error) {
    console.warn(`test selection: reading a submission failed: ${error}`);
    console.warn(
      "test selection: refusing to publish from part of the window. The " +
        "previous manifest is still the newest one.",
    );
    return 1;
  }
  const folded = fold.finish();

  // The topology is what says where an identity runs. Its suite
  // identifiers and units are what a lane looks a suite up by and what
  // the packer charges overheads and capabilities against, so a manifest
  // built without it names surfaces nothing in the tree answers to.
  const suites = await topology();
  const { placed, unplaced } = locateSurfaces(suites, folded.surfaces);
  const states = new Map(
    [...folded.states].filter(([key]) => placed.has(key)),
  );

  const manifest = buildManifest({
    states,
    mainRed: folded.mainRed,
    surfaces: placed,
    today,
    generatedAt: startedAt.toISOString(),
    seed: ulid(),
    commit,
    runs: runs.size,
  });
  manifest.unavailable = suites.flatMap((suite) =>
    suite.unavailable.map((entry) => ({
      suite: suite.id,
      ...(suite.variant === undefined ? {} : { variant: suite.variant }),
      unit: entry.unit,
      ...(entry.leafName === undefined ? {} : { leafName: entry.leafName }),
      ...(entry.phase === undefined ? {} : { phase: entry.phase }),
      reason: entry.reason,
    }))
  );
  const reference = plan({
    manifest,
    mandatory: new Map(),
    capabilities: capabilitiesBySuite(suites),
  });
  // What the packer refused, from the packer, carrying the cost the bound
  // was compared against rather than a raw one that leaves out every
  // overhead the lane would have paid.
  manifest.unschedulable = reference.unschedulable;
  manifest.lanes = reference.lanes.map((lane) => ({
    lane: lane.lane,
    projectedSeconds: Math.round(lane.projectedSeconds * 10) / 10,
    batches: [...new Set(lane.selections.map((s) => s.entry.suite))].sort()
      .map((suite) => ({
        suite,
        identities: lane.selections
          .filter((s) => s.entry.suite === suite)
          .map((s) => JSON.stringify(s.entry.test)),
      })),
  }));

  summarize(manifest, reference, folded.observations, unplaced);

  if (options.out !== undefined) {
    await Deno.mkdir(options.out, { recursive: true });
    await Deno.writeTextFile(
      join(options.out, "manifest.json"),
      JSON.stringify(manifest, null, 2),
    );
    await Deno.writeTextFile(
      join(options.out, "state.json"),
      JSON.stringify(folded.aggregate),
    );
    console.log(`test selection: wrote ${options.out}/manifest.json`);
  }
  if (options.dryRun) return 0;

  const token = store.token();
  if (token === undefined) {
    console.warn(
      "test selection: no write credential, so nothing was created. The " +
        "previous manifest is still the newest one.",
    );
    return 0;
  }
  // The manifest first and the state after it. A run that died between
  // the two leaves a manifest whose aggregate is a cycle behind, which
  // the next run folds forward; the other order would leave a state
  // claiming objects no manifest was built from.
  const id = ulid();
  const name = manifestObjectName(manifest.generatedAt, id);
  await store.create(name, await manifestBody(manifest));
  console.log(`test selection: created ${name}`);
  await store.create(
    stateObjectName(today, id),
    await gzipText(JSON.stringify(folded.aggregate)),
  );
  return 0;
}

/** What the job summary says: the shape of what this run decided. */
function summarize(
  manifest: ReturnType<typeof buildManifest>,
  reference: ReturnType<typeof plan>,
  observations: number,
  unplaced: Unplaced,
): void {
  console.log(
    `test selection: folded ${observations} execution(s) into ` +
      `${manifest.entries.length} identities`,
  );
  if (unplaced.suiteLevel.length > 0) {
    console.log(
      `test selection: ${unplaced.suiteLevel.length} identities measure a ` +
        `suite rather than anything a lane can be asked to run`,
    );
  }
  if (unplaced.unclaimed.length > 0) {
    // Almost always an identity whose records predate the registration
    // preload, so nothing knows which file registers it. It is placed
    // again the first time it runs and records one.
    console.log(
      `test selection: ${unplaced.unclaimed.length} identities no suite ` +
        `claims, so no lane can run them`,
    );
  }
  const held = new Map<string, number>();
  for (const entry of manifest.withheld) {
    held.set(entry.reason, (held.get(entry.reason) ?? 0) + 1);
  }
  for (const [reason, count] of [...held].sort()) {
    console.log(`test selection: ${count} withheld as ${reason}`);
  }
  const times = reference.lanes.map((lane) => lane.projectedSeconds);
  for (const lane of reference.lanes) {
    console.log(
      `test selection: lane ${lane.lane} would run ` +
        `${lane.selections.length} test(s) in ` +
        `${lane.projectedSeconds.toFixed(1)}s of ${LANE_BUDGET_SECONDS}s`,
    );
  }
  if (times.length > 0) {
    const spread = Math.max(...times) - Math.min(...times);
    console.log(
      `test selection: ${LANES} lanes, spread ${spread.toFixed(1)}s`,
    );
  }
  const selected = reference.lanes.reduce(
    (total, lane) => total + lane.selections.length,
    0,
  );
  console.log(
    `test selection: ${selected} of ${manifest.entries.length} identities ` +
      `fit the budget`,
  );
  for (const entry of reference.unschedulable) {
    console.log(
      `test selection: unschedulable, ${entry.cost.toFixed(1)}s: ` +
        JSON.stringify(entry.test),
    );
  }
}

// Re-exported so an offline check can build the same day list.
export {
  dayOf,
  manifestPrefix,
  newestAtOrBefore,
  partitionOf,
  serializeManifest,
};

if (import.meta.main) {
  Deno.exit(await publish(Deno.args));
}
