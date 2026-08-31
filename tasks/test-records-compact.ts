#!/usr/bin/env -S deno run --allow-read --allow-env --allow-net

/**
 * The compactor: rewrites each closed day of raw records as a handful of
 * rollup shards under the dataset's aggregated/ area, so full-history
 * consumers read a few objects per day plus the recent raw tail instead of
 * every object ever written. Rollups are write-once — a day is compacted
 * only after it has closed, its object names are deterministic, and an
 * existing shard is never touched — so re-running is idempotent and the
 * bucket's versioning never accumulates noncurrent copies.
 *
 * A day is many objects. A busy day is over a gigabyte of NDJSON, against
 * V8's maximum string length of about half that, and an object has to fit
 * in a string at both ends: the compactor builds one, and a reader fetches
 * one. Each shard is sized to fit, which also bounds what the compactor
 * holds — one shard's compressed bytes plus the raw objects its bounded
 * read-ahead window has in flight.
 *
 * Which shard an object belongs to is a hash of its name, so the partition
 * is a property of the object rather than of the order objects were read
 * in. A run that dies part way is completed by the next run, which writes
 * the shards that are missing and leaves the rest alone. The shard count
 * is in every shard's name, so shards from two runs that sized a day
 * differently are separate objects rather than the same object with two
 * meanings. The manifest is written last, and a day counts as compacted
 * when it exists.
 *
 * Reader-side validation lives here: every line of every raw object goes
 * through the schema validators, and only what validated reaches a shard.
 *
 *   deno task test-records-compact [--days N] [--plan]
 *
 * `--plan` reports from the listing alone and reads no object bodies, so it
 * says what a day would come to at any volume. What it cannot say is
 * whether a day's objects hold any records, which is a property of their
 * contents; a day of records-free objects shows as compactable and is then
 * left open by the run that reads it.
 *
 * The writer credential comes from CF_TEST_RECORDS_COMPACTOR_KEY_FILE, a
 * service-account key with create-only access to the aggregated/ area;
 * that principal is provisioned in the infra repository when compaction
 * is turned on. Until then the compactor runs read-only with --plan.
 */

import {
  buildObjectBody,
  createObject,
  datePartition,
  gzipChunks,
  type ListedObject,
  listObjectSizes,
  objectUrl,
  readEnv,
  readObject,
  RECORD_SCHEMA_VERSION,
  STORE_WRITE_SCOPE,
  type StoredReport,
  tokenFromKey,
} from "@commonfabric/test-support/records";
import {
  ciSubmissionsPrefix,
  parsePersonalKeyFile,
  storeBucket,
  storePrefix,
} from "./test-records-config.ts";

const ENCODER = new TextEncoder();

/** The folder holding one day's rollup shards and its manifest. */
export function rollupPrefix(day: string): string {
  return `${storePrefix()}/aggregated/ci/v${RECORD_SCHEMA_VERSION}/${day}/`;
}

/**
 * The manifest of a day's rollup, which names the day's shards. It is
 * written after every shard it names, so a day with a manifest is a day
 * whose rollup is complete, and a day without one has no rollup a reader
 * may use.
 */
export function rollupManifestName(day: string): string {
  return `${rollupPrefix(day)}rollup.json`;
}

/**
 * A shard's name within its day's folder. The count is in the name: two
 * runs that divided a day into different numbers of shards write different
 * objects rather than colliding on one name with two partitions behind it.
 */
export function rollupShardName(index: number, count: number): string {
  const pad = (value: number) => String(value).padStart(4, "0");
  return `${pad(index)}-of-${pad(count)}.ndjson`;
}

/**
 * Stored bytes a shard aims for. What a reader has to hold is the text a
 * shard decompresses to, which is this many bytes times however well the
 * day compressed, so the compression ratio that costs a reader is a high
 * one rather than a low one. The days measured when this was written ran
 * about 7.4 times; V8's limit of a little under 512 MiB is reached at 64
 * times. At eight mebibytes a shard is a few tens of megabytes of text,
 * and a busy day is tens of objects rather than thousands.
 */
export const SHARD_TARGET_BYTES = 8 * 1024 * 1024;

/** How many shards a day of the given stored size is divided into. */
export function shardCount(storedBytes: number): number {
  return Math.max(1, Math.ceil(storedBytes / SHARD_TARGET_BYTES));
}

/**
 * The shard one raw object belongs to: FNV-1a over its name, taken modulo
 * the shard count. The assignment depends on the object's own name and
 * nothing else, so a re-run partitions a day the same way whatever else
 * has landed in it, and no record can end up in two shards.
 */
export function shardOf(objectName: string, count: number): number {
  let hash = 0x811c9dc5;
  for (const byte of ENCODER.encode(objectName)) {
    hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  }
  return hash % count;
}

/** A day's rollup manifest. */
export interface RollupManifest {
  schema: typeof RECORD_SCHEMA_VERSION;

  /** The day the shards cover, as "yyyy/mm/dd". */
  day: string;

  /** Shard names within the day's folder, in shard order. */
  shards: string[];
}

const SHARD_NAME = /^(\d{4,})-of-(\d{4,})\.ndjson$/;

/**
 * The partitions a day's folder already holds shards of, read off their
 * names. A day is partitioned once: a run that finds shards there finishes
 * the partition that wrote them rather than starting a second one, so its
 * shard names agree with theirs and nothing an earlier run wrote is left
 * unreferenced. More than one partition means a folder no run should add
 * to.
 */
export function startedShardCounts(
  day: string,
  present: readonly string[],
): number[] {
  const counts = new Set<number>();
  for (const name of present) {
    if (!name.startsWith(rollupPrefix(day))) continue;
    const parts = SHARD_NAME.exec(name.slice(rollupPrefix(day).length));
    if (parts !== null) counts.add(Number(parts[2]));
  }
  return [...counts].sort((a, b) => a - b);
}

/**
 * Parses a manifest, returning undefined for anything that is not one of
 * this schema version for the day asked about. A manifest is stored
 * material like any other, so it is validated at the read boundary, and
 * the shard names are checked against the one shape the compactor writes
 * rather than joined onto a prefix as given.
 */
export function parseRollupManifest(
  text: string,
  day: string,
): RollupManifest | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const manifest = value as Record<string, unknown>;
  if (manifest.schema !== RECORD_SCHEMA_VERSION) return undefined;
  if (manifest.day !== day) return undefined;
  if (!Array.isArray(manifest.shards)) return undefined;
  const shards: string[] = [];
  const seen = new Set<string>();
  let count: number | undefined;
  for (const shard of manifest.shards) {
    if (typeof shard !== "string") return undefined;
    const parts = SHARD_NAME.exec(shard);
    if (parts === null) return undefined;
    // One partition, each shard of it named once and within it: a repeated
    // shard would count its records twice, and an index past the count
    // names an object no run writes.
    const of = Number(parts[2]);
    count ??= of;
    if (of !== count || Number(parts[1]) >= of || seen.has(shard)) {
      return undefined;
    }
    seen.add(shard);
    shards.push(shard);
  }
  return { schema: RECORD_SCHEMA_VERSION, day, shards };
}

/**
 * The object names of a day's rollup shards, or undefined when the day has
 * no rollup a reader may use — it was never compacted, or a run that was
 * compacting it has not finished. Callers read the shards in the order
 * given and treat them as the day.
 */
export async function rollupShards(options: {
  bucket: string;
  day: string;
  fetch?: typeof fetch;
}): Promise<string[] | undefined> {
  const doFetch = options.fetch ?? fetch;
  const res = await doFetch(
    objectUrl(options.bucket, rollupManifestName(options.day)),
  );
  if (!res.ok) {
    // Read and discard so the connection is reusable.
    await res.text();
    return undefined;
  }
  const manifest = parseRollupManifest(await res.text(), options.day);
  if (manifest === undefined) return undefined;
  return manifest.shards.map((shard) => `${rollupPrefix(options.day)}${shard}`);
}

/**
 * Days between the compaction lag and the window edge. The lag leaves a
 * partition open for late arrivals — relay re-ships and swept local
 * orphans land days after their run's start date — and an orphan later
 * still reaches only readers of the raw area, which rollups do not
 * replace.
 */
export const COMPACTION_LAG_DAYS = 7;

/** The compactable partitions: past the lag, inside the window. */
export function closedDays(days: number, now: number = Date.now()): string[] {
  const result: string[] = [];
  for (let back = COMPACTION_LAG_DAYS; back <= days; back++) {
    const day = new Date(now - back * 24 * 60 * 60 * 1000);
    result.push(datePartition(day.toISOString()));
  }
  return result;
}

export interface CompactOptions {
  days: number;
  plan: boolean;
  bucket: string;
  rawPrefix: string;

  /** Required unless plan is set. */
  token?: string;
  fetchImpl?: typeof fetch;
  now?: number;
}

/** How many raw objects a shard's reads run ahead of its compressor by. */
const READ_AHEAD = 16;

/** What one shard's reads came to. */
interface Tally {
  reports: number;
  records: number;
}

/**
 * The bodies of a shard's raw objects, in listing order, ready to be
 * compressed one after another. One body per report an object holds, each
 * carrying that report's own context line ahead of its own records, so an
 * object holding more than one report reaches the shard as the reports it
 * holds. Records with no valid context ahead of them are dropped: a rollup
 * keeps a context line ahead of every record, and a record with no context
 * has no report to belong to.
 *
 * Reads run ahead of the caller by a bounded window, so a shard's hundreds
 * of small objects are fetched several at a time while what is held stays
 * the size of that window. A read that fails is carried as a value rather
 * than a rejection, so a failure while an earlier read is still being
 * awaited surfaces where the failed object is reached instead of as an
 * unhandled rejection.
 */
async function* reportBodies(
  read: (objectName: string) => Promise<StoredReport>,
  objectNames: readonly string[],
  tally: Tally,
): AsyncGenerator<string> {
  const settle = (objectName: string) =>
    read(objectName).then(
      (report) => ({ report, error: undefined }),
      (error: unknown) => ({ report: undefined, error }),
    );
  const window: ReturnType<typeof settle>[] = [];
  let next = 0;
  while (next < objectNames.length && window.length < READ_AHEAD) {
    window.push(settle(objectNames[next++]!));
  }
  while (window.length > 0) {
    const settled = await window.shift()!;
    if (next < objectNames.length) window.push(settle(objectNames[next++]!));
    if (settled.report === undefined) throw settled.error;
    for (const group of settled.report.reports) {
      if (group.context === undefined) continue;
      tally.reports++;
      tally.records += group.records.length;
      yield buildObjectBody(group.context, group.records);
    }
  }
}

/** Compacts every closed day that has records and no rollup yet. */
export async function compactDays(options: CompactOptions): Promise<void> {
  const { bucket, rawPrefix, plan } = options;
  const list = (prefix: string): Promise<ListedObject[]> => {
    const listOptions: Parameters<typeof listObjectSizes>[0] = {
      bucket,
      prefix,
    };
    if (options.fetchImpl !== undefined) listOptions.fetch = options.fetchImpl;
    return listObjectSizes(listOptions);
  };
  const read = (objectName: string): Promise<StoredReport> => {
    const readOptions: Parameters<typeof readObject>[0] = {
      bucket,
      objectName,
    };
    if (options.fetchImpl !== undefined) readOptions.fetch = options.fetchImpl;
    return readObject(readOptions);
  };
  const create = (
    name: string,
    body: Uint8Array,
    contentType: string,
    contentEncoding?: string,
  ): ReturnType<typeof createObject> => {
    const createOptions: Parameters<typeof createObject>[0] = {
      bucket,
      name,
      body,
      token: options.token!,
      contentType,
    };
    if (contentEncoding !== undefined) {
      createOptions.contentEncoding = contentEncoding;
    }
    if (options.fetchImpl !== undefined) {
      createOptions.fetch = options.fetchImpl;
    }
    return createObject(createOptions);
  };

  for (const day of closedDays(options.days, options.now)) {
    const present = await list(rollupPrefix(day));
    if (present.some((object) => object.name === rollupManifestName(day))) {
      continue;
    }
    const raw = await list(`${rawPrefix}/v${RECORD_SCHEMA_VERSION}/${day}/`);
    if (raw.length === 0) continue;
    const stored = raw.reduce((total, object) => total + object.size, 0);
    // The shard count comes from the listing's sizes, and a rollup cannot
    // be rewritten once written. A day that lists objects but no bytes is
    // a listing that did not answer, so it is reported and left open.
    if (stored === 0) {
      console.error(
        `${day}: ${raw.length} object(s) listed with no size; ` +
          "leaving the day open",
      );
      continue;
    }
    // A day already part way through a partition is finished in that
    // partition, whatever it would be sized at now.
    const started = startedShardCounts(
      day,
      present.map((object) => object.name),
    );
    if (started.length > 1) {
      console.error(
        `${day}: the folder holds shards of ${started.length} partitions ` +
          `(${started.join(", ")}); leaving the day open`,
      );
      continue;
    }
    const count = started[0] ?? shardCount(stored);
    if (plan) {
      console.log(
        `would compact ${day}: ${raw.length} object(s), ` +
          `${(stored / 1e6).toFixed(1)} MB -> ${count} shard(s) under ` +
          rollupPrefix(day),
      );
      continue;
    }

    const members: string[][] = Array.from({ length: count }, () => []);
    for (const object of raw) {
      members[shardOf(object.name, count)]!.push(object.name);
    }
    const existing = new Set(present.map((object) => object.name));
    const shards: string[] = [];
    const total: Tally = { reports: 0, records: 0 };
    let written = 0;
    for (let index = 0; index < count; index++) {
      const shard = rollupShardName(index, count);
      const name = `${rollupPrefix(day)}${shard}`;
      if (existing.has(name)) {
        shards.push(shard);
        continue;
      }
      if (members[index]!.length === 0) continue;
      const tally: Tally = { reports: 0, records: 0 };
      const body = await gzipChunks(reportBodies(read, members[index]!, tally));
      // A shard with no records is not written, and a day whose objects
      // hold no records is therefore left with no shards and no manifest:
      // a write-once rollup would permanently exclude anything that later
      // lands in that day — an old run re-run, a late orphan — for nothing.
      if (tally.records === 0) continue;
      if (
        await create(name, body, "application/x-ndjson", "gzip") === "created"
      ) {
        written++;
      }
      total.reports += tally.reports;
      total.records += tally.records;
      shards.push(shard);
    }
    if (shards.length === 0) {
      console.log(`${day}: no records yet; leaving the day open`);
      continue;
    }
    const manifest: RollupManifest = {
      schema: RECORD_SCHEMA_VERSION,
      day,
      shards,
    };
    const result = await create(
      rollupManifestName(day),
      ENCODER.encode(JSON.stringify(manifest)),
      "application/json",
    );
    if (result === "exists") {
      console.log(`${day}: another run's manifest got there first`);
      continue;
    }
    console.log(
      `${day}: ${raw.length} object(s) compacted to ${shards.length} ` +
        `shard(s) under ${rollupPrefix(day)}; ${written} written now, ` +
        `holding ${total.records} record(s) in ${total.reports} report(s)`,
    );
  }
}

/** Parses the command line; undefined means a malformed one. */
export function parseCompactArgs(
  argsIn: readonly string[],
): { days: number; plan: boolean } | undefined {
  let days = 14;
  let plan = false;
  const args = [...argsIn];
  while (args.length > 0) {
    const flag = args.shift()!;
    if (flag === "--plan") {
      plan = true;
    } else if (flag === "--days") {
      days = Number(args.shift());
      if (!Number.isInteger(days) || days < COMPACTION_LAG_DAYS) {
        console.error(
          `--days takes an integer of at least ${COMPACTION_LAG_DAYS}: a ` +
            "shorter window reaches back only into days still open for " +
            "late arrivals.",
        );
        return undefined;
      }
    } else {
      console.error(`unknown flag ${flag}`);
      return undefined;
    }
  }
  return { days, plan };
}

async function main(): Promise<void> {
  const parsed = parseCompactArgs(Deno.args);
  if (parsed === undefined) Deno.exit(2);
  const { days, plan } = parsed;

  const options: CompactOptions = {
    days,
    plan,
    bucket: storeBucket(),
    rawPrefix: ciSubmissionsPrefix(),
  };
  if (!plan) {
    const keyPath = readEnv("CF_TEST_RECORDS_COMPACTOR_KEY_FILE");
    if (keyPath === undefined || keyPath.length === 0) {
      console.error(
        "CF_TEST_RECORDS_COMPACTOR_KEY_FILE is not set; run with --plan " +
          "to see what would be compacted.",
      );
      Deno.exit(2);
    }
    const key = parsePersonalKeyFile(await Deno.readTextFile(keyPath));
    if (key === undefined) {
      console.error(`${keyPath} is not a service-account key file`);
      Deno.exit(2);
    }
    options.token = await tokenFromKey(key, STORE_WRITE_SCOPE);
  }

  await compactDays(options);
}

if (import.meta.main) {
  await main();
}
