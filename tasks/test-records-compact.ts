#!/usr/bin/env -S deno run --allow-read --allow-env --allow-net
/**
 * The compactor: rewrites each closed day of raw records as one rollup
 * object under the dataset's aggregated/ area, so full-history consumers
 * read one object per day plus the recent raw tail instead of every object
 * ever written. Rollups are write-once — a day is compacted only after it
 * has closed, its object name is deterministic, and an existing rollup is
 * never touched — so re-running is idempotent and the bucket's versioning
 * never accumulates noncurrent copies.
 *
 * Reader-side validation lives here: every line of every raw object goes
 * through the schema validators, and only what validated reaches a rollup.
 *
 *   deno run -A tasks/test-records-compact.ts [--days N]
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
  gzipText,
  listObjects,
  readEnv,
  readObject,
  RECORD_SCHEMA_VERSION,
  STORE_WRITE_SCOPE,
  tokenFromKey,
} from "@commonfabric/test-support/records";
import {
  ciSubmissionsPrefix,
  parsePersonalKeyFile,
  storeBucket,
  storePrefix,
} from "./test-records-config.ts";

/** The rollup object for a day of ci records. */
export function rollupName(day: string): string {
  return `${storePrefix()}/aggregated/ci/v${RECORD_SCHEMA_VERSION}/${day}.ndjson`;
}

/**
 * Days between the compaction lag and the window edge. The lag leaves a
 * partition open for late arrivals — relay re-ships and swept local
 * orphans land days after their run's start date — and an orphan later
 * still reaches only readers of the raw area, which rollups do not
 * replace.
 */
export const COMPACTION_LAG_DAYS = 7;

function closedDays(days: number): string[] {
  const result: string[] = [];
  const now = Date.now();
  for (let back = COMPACTION_LAG_DAYS; back <= days; back++) {
    const day = new Date(now - back * 24 * 60 * 60 * 1000);
    result.push(datePartition(day.toISOString()));
  }
  return result;
}

async function main(): Promise<void> {
  let days = 14;
  let plan = false;
  const args = [...Deno.args];
  while (args.length > 0) {
    const flag = args.shift()!;
    if (flag === "--plan") {
      plan = true;
    } else if (flag === "--days") {
      days = Number(args.shift());
      if (!Number.isInteger(days) || days < 1) {
        console.error("--days takes a positive integer");
        Deno.exit(2);
      }
    } else {
      console.error(`unknown flag ${flag}`);
      Deno.exit(2);
    }
  }

  const bucket = storeBucket();
  const rawPrefix = ciSubmissionsPrefix();

  let token: string | undefined;
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
    token = await tokenFromKey(key, STORE_WRITE_SCOPE);
  }

  for (const day of closedDays(days)) {
    const existing = await listObjects({
      bucket,
      prefix: rollupName(day),
    });
    if (existing.length > 0) continue;
    const raw = await listObjects({
      bucket,
      prefix: `${rawPrefix}/v${RECORD_SCHEMA_VERSION}/${day}/`,
    });
    if (raw.length === 0) continue;

    let body = "";
    let reportCount = 0;
    let recordCount = 0;
    for (const objectName of raw) {
      const report = await readObject({ bucket, objectName });
      if (report.context === undefined) continue;
      reportCount++;
      recordCount += report.records.length;
      body += buildObjectBody(report.context, report.records);
    }
    if (plan) {
      console.log(
        `would compact ${day}: ${raw.length} object(s), ${reportCount} ` +
          `report(s), ${recordCount} record(s) -> ${rollupName(day)}`,
      );
      continue;
    }
    const result = await createObject({
      bucket,
      name: rollupName(day),
      body: await gzipText(body),
      token: token!,
      contentType: "application/x-ndjson",
      contentEncoding: "gzip",
    });
    console.log(
      `${day}: ${recordCount} record(s) from ${raw.length} object(s) ` +
        `${result === "created" ? "compacted to" : "already at"} ${
          rollupName(day)
        }`,
    );
  }
}

if (import.meta.main) {
  await main();
}
