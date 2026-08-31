#!/usr/bin/env -S deno run --allow-read --allow-env --allow-net --allow-write

/**
 * The publisher: reads the record store, folds what is new into a rolling
 * aggregate, scores everything, and creates one manifest object.
 *
 *   deno run -A tasks/test-selection-publish.ts [--days N] [--bootstrap]
 *     [--out <dir>] [--dry-run] [--concurrency N]
 *
 * The incremental path reads the newest aggregate and fetches only the
 * objects it has not already folded, which in the steady state is about
 * two thousand of them. A cold start cannot read three weeks of history
 * in one job, so `--bootstrap` is the one-off that does, run by hand.
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
  gunzipToText,
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
  dayOf,
  emptyAggregate,
  Fold,
  parseAggregate,
} from "./test-selection/build.ts";
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
 * The objects a day's rollup was written as, when the day has a complete
 * one. A day is compacted into shards sized so that a reader can hold
 * what one decompresses to, and the day's manifest — written after every
 * shard it names — is what says the rollup is finished and which shards
 * it holds. Reading those replaces reading the day's thousands of raw
 * objects.
 *
 * Only a bootstrap reads them. A rollup is written by the one principal
 * here whose credential exists as key material, so it carries weaker
 * provenance than the raw records it summarizes, and the record spec asks
 * a consumer that feeds decisions to treat it as a cache of a day rather
 * than the record of it. Seeding catch counts once, from days closed a
 * week or more ago, is that use; the four-hourly path that keeps the
 * manifest current never touches one.
 */
async function rollupFor(day: string): Promise<string[] | undefined> {
  try {
    return await rollupShards({ bucket: storeBucket(), day });
  } catch {
    return undefined;
  }
}

/**
 * Every submission object under the days asked for, across both areas.
 * A continuous-integration object's day is a path segment, so its day is
 * a prefix and one listing per day is exact. A local object's path puts
 * the reporting person ahead of the day, so that area is listed once and
 * filtered.
 */
async function listSubmissions(days: readonly string[]): Promise<string[]> {
  const bucket = storeBucket();
  const wanted = new Set(days);
  const names: string[] = [];
  for (const day of days) {
    const prefix = `${ciSubmissionsPrefix()}/v1/${day}/`;
    try {
      names.push(...await listObjects({ bucket, prefix }));
    } catch (error) {
      console.warn(`test selection: listing ${prefix} failed: ${error}`);
    }
  }
  const local = `${storePrefix()}/submissions/local/`;
  try {
    for (const name of await listObjects({ bucket, prefix: local })) {
      const day = name.match(/\/v1\/(\d{4}\/\d{2}\/\d{2})\//)?.[1];
      if (day !== undefined && wanted.has(day)) names.push(name);
    }
  } catch (error) {
    console.warn(`test selection: listing ${local} failed: ${error}`);
  }
  return [...new Set(names)].sort(byDayThenName);
}

/** The day partition in a submission object's name. */
export function partitionOf(objectName: string): string {
  return objectName.match(/\/v1\/(\d{4}\/\d{2}\/\d{2})\//)?.[1] ?? "";
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
async function readAggregate(): Promise<AggregateRead> {
  const bucket = storeBucket();
  const prefix = statePrefix();
  let names: string[];
  try {
    names = await listObjects({ bucket, prefix });
  } catch (error) {
    return { failed: `listing ${prefix} failed: ${error}` };
  }
  const newest = names.filter((name) => name.endsWith(".json.gz")).sort().at(
    -1,
  );
  if (newest === undefined) return { absent: true };
  try {
    const url = objectUrl(bucket, newest);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await gunzipToText(
      new Uint8Array(await response.arrayBuffer()),
    );
    const state = parseAggregate(text);
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
function writeToken(): string | undefined {
  const federated = Deno.env.get("TEST_RECORDS_GCS_TOKEN");
  return federated !== undefined && federated.length > 0
    ? federated
    : undefined;
}

async function main(args: readonly string[]): Promise<number> {
  const options = parseArgs(args);
  if (options === undefined) {
    console.error(
      "usage: test-selection-publish.ts [--days N] [--bootstrap] " +
        "[--out <dir>] [--dry-run] [--concurrency N]",
    );
    return 2;
  }

  const startedAt = new Date();
  const today = startedAt.toISOString().slice(0, 10);
  let aggregate: AggregateState;
  if (options.bootstrap) {
    aggregate = emptyAggregate(today);
  } else {
    const read = await readAggregate();
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
  const bucket = storeBucket();
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

  // A bootstrap folds each closed day from its rollup where one exists,
  // which is one object against the day's thousands. The days it takes
  // this way are recorded, so no later run over a wide window folds their
  // raw objects on top of them and doubles every catch in them.
  const compacted: string[] = [];
  if (options.bootstrap) {
    for (const day of partitions) {
      if (fold.knowsDay(day)) continue;
      const shards = await rollupFor(day);
      if (shards === undefined) continue;
      try {
        // A day is folded whole or not at all: a shard that failed to
        // read would leave the day partly folded, and marking it
        // compacted would then hide the rest of it from every later run.
        const reports = await mapConcurrent(
          shards,
          options.concurrency,
          (objectName) => readObject({ bucket, objectName }),
        );
        for (const report of reports) noteReport(report);
        fold.add(reports);
        fold.markCompacted(day);
        compacted.push(day);
      } catch (error) {
        console.warn(
          `test selection: reading the rollup of ${day} failed: ${error}`,
        );
      }
    }
    console.log(
      `test selection: folded ${compacted.length} day(s) from their rollups`,
    );
  }

  const open = partitions.filter((day) => !fold.knowsDay(day));
  const listed = await listSubmissions(open);
  const fresh = listed.filter((name) => !fold.knows(name));
  console.log(
    `test selection: ${listed.length} object(s) under ${open.length} ` +
      `open day(s), ${fresh.length} not yet folded`,
  );

  // Read and fold in chunks rather than all at once. A bootstrap reads
  // tens of thousands of objects, each holding hundreds of executions,
  // and holding them all would be bounded by the number of runs rather
  // than by the number of tests.
  for (let at = 0; at < fresh.length; at += CHUNK) {
    const chunk = fresh.slice(at, at + CHUNK);
    const reports = (await mapConcurrent(
      chunk,
      options.concurrency,
      async (objectName): Promise<StoredReport | undefined> => {
        try {
          return await readObject({ bucket, objectName });
        } catch (error) {
          console.warn(
            `test selection: reading ${objectName} failed: ${error}`,
          );
          return undefined;
        }
      },
    )).filter((report): report is StoredReport => report !== undefined);
    for (const report of reports) noteReport(report);
    fold.add(reports);
    console.log(
      `test selection: folded ${at + chunk.length} of ${fresh.length} ` +
        `object(s)`,
    );
  }
  const folded = fold.finish();

  const manifest = buildManifest({
    states: folded.states,
    mainRed: folded.mainRed,
    surfaces: folded.surfaces,
    today,
    generatedAt: startedAt.toISOString(),
    seed: ulid(),
    commit,
    runs: runs.size,
  });
  const reference = plan({
    manifest,
    mandatory: new Map(),
    capabilities: new Map(),
  });
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

  summarize(manifest, reference, folded.observations);

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

  const token = writeToken();
  if (token === undefined) {
    console.warn(
      "test selection: no write credential, so nothing was created. The " +
        "previous manifest is still the newest one.",
    );
    return 0;
  }
  const id = ulid();
  const name = manifestObjectName(manifest.generatedAt, id);
  const created = await createObject({
    bucket,
    name,
    body: await manifestBody(manifest),
    contentType: "application/json",
    contentEncoding: "gzip",
    token,
  });
  console.log(`test selection: ${name} ${created}`);
  await createObject({
    bucket,
    name: stateObjectName(today, id),
    body: await gzipText(JSON.stringify(folded.aggregate)),
    contentType: "application/json",
    contentEncoding: "gzip",
    token,
  });
  return 0;
}

/** What the job summary says: the shape of what this run decided. */
function summarize(
  manifest: ReturnType<typeof buildManifest>,
  reference: ReturnType<typeof plan>,
  observations: number,
): void {
  console.log(
    `test selection: folded ${observations} execution(s) into ` +
      `${manifest.entries.length} identities`,
  );
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
  const unschedulable = manifest.entries.filter(
    (entry) => entry.cost > LANE_BUDGET_SECONDS,
  );
  for (const entry of unschedulable) {
    console.log(
      `test selection: unschedulable, ${entry.cost.toFixed(1)}s: ` +
        JSON.stringify(entry.test),
    );
  }
}

// Re-exported so an offline check can build the same day list.
export { dayOf, manifestPrefix, newestAtOrBefore, serializeManifest };

if (import.meta.main) {
  Deno.exit(await main(Deno.args));
}
