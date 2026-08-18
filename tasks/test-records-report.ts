#!/usr/bin/env -S deno run --allow-read --allow-env --allow-net
/**
 * The reader-side reports over the record store: name collisions,
 * high-churn identities, and tests over the sixty-second rule. Reads only
 * the decision-grade ci/ prefix, whose writer credential never leaves
 * Google-managed federation, and needs no credential itself — the store is
 * public.
 *
 *   deno run -A tasks/test-records-report.ts [--days N] [--gate]
 *
 * --gate turns the over-60-seconds report into an exit status, the ratchet
 * the design document describes; it stays advisory until the violator list
 * is short enough for someone to flip the flag in CI.
 */

import {
  type AliasResolver,
  datePartition,
  listObjects,
  loadAliasResolver,
  readObject,
  type StoredReport,
} from "@commonfabric/test-support/records";
import { ciSubmissionsPrefix, storeBucket } from "./test-records-config.ts";

/** A test's aggregate over the report window. */
export interface IdentityAggregate {
  key: string;
  runs: number;
  failures: number;
  skips: number;
  maxDurationMs: number;
}

export function identityKey(test: { k: string; s: string; n: string }): string {
  // A JSON array: unambiguous however many spaces the name contains, and
  // printable everywhere the key surfaces.
  return JSON.stringify([test.k, test.s, test.n]);
}

export function formatIdentity(key: string): string {
  const [k, s, n] = JSON.parse(key) as [string, string, string];
  return `[${k}] ${s}: ${n}`;
}

/**
 * Aggregates every record of every report by identity. Identities are
 * resolved through the alias file as of each report's own start day, so a
 * renamed test's history aggregates under its current name.
 */
export function aggregate(
  reports: readonly StoredReport[],
  aliases?: AliasResolver,
): Map<string, IdentityAggregate> {
  const byIdentity = new Map<string, IdentityAggregate>();
  for (const report of reports) {
    const day = report.context !== undefined
      ? datePartition(report.context.startedAt)
      : undefined;
    for (const record of report.records) {
      const test = aliases !== undefined && day !== undefined
        ? aliases.resolve(record.test, day)
        : record.test;
      const key = identityKey(test);
      let entry = byIdentity.get(key);
      if (entry === undefined) {
        entry = { key, runs: 0, failures: 0, skips: 0, maxDurationMs: 0 };
        byIdentity.set(key, entry);
      }
      entry.runs++;
      if (record.outcome === "fail") entry.failures++;
      if (record.outcome === "skip") entry.skips++;
      entry.maxDurationMs = Math.max(entry.maxDurationMs, record.durationMs);
    }
  }
  return byIdentity;
}

/**
 * Collisions: one identity reported more than once inside a single
 * uploaded object — two records of one test in one job.
 */
export function collisions(
  reports: readonly StoredReport[],
): { objectName: string; key: string; count: number }[] {
  const found: { objectName: string; key: string; count: number }[] = [];
  for (const report of reports) {
    const counts = new Map<string, number>();
    for (const record of report.records) {
      const key = identityKey(record.test);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const [key, count] of counts) {
      if (count > 1) {
        found.push({ objectName: report.objectName, key, count });
      }
    }
  }
  return found;
}

/**
 * High-churn identity families: identities that appear in only one run of
 * the window, grouped by their name with digit runs collapsed. A family
 * with several one-run members is a name built from a counter, a position,
 * or an interpolated value — the shapes the design document tells authors
 * to avoid.
 */
export function churnFamilies(
  byIdentity: ReadonlyMap<string, IdentityAggregate>,
  windowRuns: number,
): { family: string; members: number }[] {
  if (windowRuns < 2) return [];
  const families = new Map<string, number>();
  for (const entry of byIdentity.values()) {
    if (entry.runs > 1) continue;
    const family = entry.key.replaceAll(/\d+/g, "#");
    families.set(family, (families.get(family) ?? 0) + 1);
  }
  return [...families.entries()]
    .filter(([, members]) => members >= 3)
    .map(([family, members]) => ({ family, members }))
    .sort((a, b) => b.members - a.members);
}

/** Identities whose worst CI duration crossed the sixty-second rule. */
export function overSixtySeconds(
  byIdentity: ReadonlyMap<string, IdentityAggregate>,
): IdentityAggregate[] {
  return [...byIdentity.values()]
    .filter((entry) => entry.maxDurationMs > 60_000)
    .sort((a, b) => b.maxDurationMs - a.maxDurationMs);
}

function recentDatePrefixes(days: number): string[] {
  const prefixes: string[] = [];
  const now = Date.now();
  for (let back = 0; back < days; back++) {
    const day = new Date(now - back * 24 * 60 * 60 * 1000);
    prefixes.push(datePartition(day.toISOString()));
  }
  return prefixes;
}

async function main(): Promise<void> {
  let days = 7;
  let gate = false;
  const args = [...Deno.args];
  while (args.length > 0) {
    const flag = args.shift()!;
    if (flag === "--gate") {
      gate = true;
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
  const prefix = ciSubmissionsPrefix();
  const names: string[] = [];
  for (const day of recentDatePrefixes(days)) {
    names.push(
      ...await listObjects({
        bucket,
        prefix: `${prefix}/v1/${day}/`,
      }),
    );
  }
  console.log(
    `${names.length} object(s) under ${prefix} in the last ${days} day(s).`,
  );
  const reports: StoredReport[] = [];
  let forkReports = 0;
  for (const objectName of names) {
    const report = await readObject({ bucket, objectName });
    // Fork-authored reports never feed decisions — this report's numbers
    // and its ratchet gate among them (docs/specs/test-records.md).
    if (report.context?.ci?.fork === true) {
      forkReports++;
      continue;
    }
    reports.push(report);
  }
  if (forkReports > 0) {
    console.log(`${forkReports} fork-authored object(s) excluded.`);
  }
  const runs = new Set(
    reports.map((report) => report.context?.ci?.workflowRunId ?? ""),
  ).size;
  const byIdentity = aggregate(reports, await loadAliasResolver());
  console.log(
    `${byIdentity.size} distinct identities across ${runs} workflow run(s).`,
  );

  const collided = collisions(reports);
  console.log(`\nCollisions (${collided.length}):`);
  for (const collision of collided.slice(0, 50)) {
    console.log(
      `  ${collision.count}x ${formatIdentity(collision.key)} in ${
        collision.objectName.split("/").at(-1)
      }`,
    );
  }

  const churny = churnFamilies(byIdentity, runs);
  console.log(`\nHigh-churn identity families (${churny.length}):`);
  for (const family of churny.slice(0, 50)) {
    console.log(`  ${family.members} one-run members: ${family.family}`);
  }

  const slow = overSixtySeconds(byIdentity);
  console.log(`\nOver sixty seconds (${slow.length}):`);
  for (const entry of slow.slice(0, 50)) {
    console.log(
      `  ${(entry.maxDurationMs / 1000).toFixed(1)}s  ${
        formatIdentity(entry.key)
      }`,
    );
  }

  if (gate && slow.length > 0) {
    console.error(
      `\n${slow.length} test(s) exceed the sixty-second rule; the ratchet ` +
        "fails.",
    );
    Deno.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
