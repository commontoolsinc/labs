/**
 * Collects per-test history from the test-run record store: pull on our own
 * schedule, cache locally, and hand back the per-identity series that
 * trend.ts fits — pass rates and durations by day. Reads only the
 * decision-grade ci/ area of the public bucket, so no credential is
 * involved; records are untrusted input and every line rides through the
 * schema validators in the shared library, with the day aggregates
 * revalidated when the cache file is read back.
 *
 * Following the dashboard's values (README.md): the series localize flaky
 * and drifting tests so they get fixed. Nothing here ranks people.
 */

import {
  type AliasResolver,
  datePartition,
  listObjects,
  loadAliasResolver,
  readObject,
  testIdentityKey,
} from "@commonfabric/test-support/records";
import { dashboardCacheFile } from "./history-files.ts";

export const TEST_RECORDS_BUCKET = "cf-ci-metadata";
export const TEST_RECORDS_CI_PREFIX = "labs/test-records/submissions/ci";
export const TEST_RECORDS_HISTORY_DAYS = 60;

/**
 * Days always refetched on refresh. Relay objects land minutes after
 * their run and are dated by run start, and swept local orphans can land
 * days later, so a trailing window of partitions stays open rather than
 * only today.
 */
export const TEST_RECORDS_REFRESH_TAIL_DAYS = 3;

/** One test's aggregate for one day. */
export interface DayAggregate {
  /** JSON-array identity key, with an optional fourth variant part. */
  key: string;
  /** "yyyy/mm/dd". */
  day: string;
  runs: number;
  failures: number;
  skips: number;
  totalDurationMs: number;
  maxDurationMs: number;
}

export function isDayAggregate(value: unknown): value is DayAggregate {
  if (typeof value !== "object" || value === null) return false;
  const aggregate = value as Record<string, unknown>;
  if (
    typeof aggregate.key !== "string" ||
    typeof aggregate.day !== "string" ||
    !/^\d{4}\/\d{2}\/\d{2}$/.test(aggregate.day) ||
    !Number.isInteger(aggregate.runs) || (aggregate.runs as number) < 1 ||
    !Number.isInteger(aggregate.failures) ||
    (aggregate.failures as number) < 0 ||
    !Number.isInteger(aggregate.skips) || (aggregate.skips as number) < 0 ||
    (aggregate.failures as number) + (aggregate.skips as number) >
      (aggregate.runs as number) ||
    typeof aggregate.totalDurationMs !== "number" ||
    !Number.isFinite(aggregate.totalDurationMs) ||
    aggregate.totalDurationMs < 0 ||
    typeof aggregate.maxDurationMs !== "number" ||
    !Number.isFinite(aggregate.maxDurationMs) || aggregate.maxDurationMs < 0
  ) {
    return false;
  }
  // The key has three required identity parts and an optional variant.
  try {
    const identity = JSON.parse(aggregate.key);
    return Array.isArray(identity) &&
      (identity.length === 3 || identity.length === 4) &&
      identity.every((part) => typeof part === "string" && part.length > 0);
  } catch {
    return false;
  }
}

/**
 * Fetches one day of the store and aggregates it per identity.
 * Fork-authored reports are excluded — these aggregates feed decisions —
 * and identities resolve through the alias file as of the day, so a
 * renamed test keeps one continuous series.
 */
export async function collectDay(
  day: string,
  options: {
    bucket?: string;
    prefix?: string;
    fetchImpl?: typeof fetch;
    aliases?: AliasResolver;
  } = {},
): Promise<DayAggregate[]> {
  const bucket = options.bucket ?? TEST_RECORDS_BUCKET;
  const prefix = options.prefix ?? TEST_RECORDS_CI_PREFIX;
  const listOptions: Parameters<typeof listObjects>[0] = {
    bucket,
    prefix: `${prefix}/v1/${day}/`,
  };
  if (options.fetchImpl !== undefined) listOptions.fetch = options.fetchImpl;
  const names = await listObjects(listOptions);
  const byKey = new Map<string, DayAggregate>();
  for (const objectName of names) {
    const readOptions: Parameters<typeof readObject>[0] = {
      bucket,
      objectName,
    };
    if (options.fetchImpl !== undefined) readOptions.fetch = options.fetchImpl;
    const report = await readObject(readOptions);
    for (const group of report.reports) {
      if (group.context?.ci?.fork === true) continue;
      for (const record of group.records) {
        const test = options.aliases !== undefined
          ? options.aliases.resolve(record.test, day)
          : record.test;
        const key = testIdentityKey(test);
        let entry = byKey.get(key);
        if (entry === undefined) {
          entry = {
            key,
            day,
            runs: 0,
            failures: 0,
            skips: 0,
            totalDurationMs: 0,
            maxDurationMs: 0,
          };
          byKey.set(key, entry);
        }
        entry.runs++;
        if (record.outcome === "fail") entry.failures++;
        if (record.outcome === "skip") entry.skips++;
        entry.totalDurationMs += record.durationMs;
        entry.maxDurationMs = Math.max(entry.maxDurationMs, record.durationMs);
      }
    }
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

interface StoredHistory {
  version: 1;
  /** Cached day aggregates; the refresh tail is always refetched. */
  days: Record<string, DayAggregate[]>;
}

function isStoredHistory(value: unknown): value is StoredHistory {
  if (typeof value !== "object" || value === null) return false;
  const stored = value as Record<string, unknown>;
  if (stored.version !== 1) return false;
  if (typeof stored.days !== "object" || stored.days === null) return false;
  return Object.entries(stored.days as Record<string, unknown>).every(
    ([day, aggregates]) =>
      Array.isArray(aggregates) &&
      aggregates.every(
        (aggregate) => isDayAggregate(aggregate) && aggregate.day === day,
      ),
  );
}

/** The per-test series trend.ts fits: times ascending, one point per day. */
export interface TestSeries {
  key: string;
  /** Milliseconds since epoch, one per day with data, ascending. */
  times: number[];
  /** Fraction of runs that passed that day. */
  passRates: number[];
  /** Mean duration that day, in milliseconds. */
  meanDurationsMs: number[];
}

export class TestRecordsHistoryStore {
  #file: string;
  #days = new Map<string, DayAggregate[]>();

  constructor(file: string = dashboardCacheFile("test-records-history.json")) {
    this.#file = file;
  }

  /** Loads the cache, ignoring a missing or invalid file. */
  async load(): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await Deno.readTextFile(this.#file));
    } catch {
      return;
    }
    if (!isStoredHistory(parsed)) return;
    this.#days = new Map(Object.entries(parsed.days));
  }

  async #save(): Promise<void> {
    const days: Record<string, DayAggregate[]> = {};
    for (const [day, aggregates] of [...this.#days].sort()) {
      days[day] = aggregates;
    }
    const stored: StoredHistory = { version: 1, days };
    const temporary = `${this.#file}.tmp-${crypto.randomUUID()}`;
    await Deno.writeTextFile(temporary, JSON.stringify(stored));
    await Deno.rename(temporary, this.#file);
  }

  /** Days the cache holds. */
  days(): string[] {
    return [...this.#days.keys()].sort();
  }

  /**
   * Fetches whatever the window needs: every missing closed day, and
   * today, whose partition is still being written. One pass, no retries;
   * a day that fails to fetch stays absent until the next refresh. With
   * no resolver given, the repository's alias file is loaded, so renamed
   * tests keep continuous series by default.
   */
  async refresh(
    now: number,
    options: {
      bucket?: string;
      prefix?: string;
      fetchImpl?: typeof fetch;
      windowDays?: number;
      aliases?: AliasResolver;
    } = {},
  ): Promise<void> {
    const windowDays = options.windowDays ?? TEST_RECORDS_HISTORY_DAYS;
    const collectOptions = {
      ...options,
      aliases: options.aliases ?? await loadAliasResolver(),
    };
    for (let back = windowDays - 1; back >= 0; back--) {
      const day = datePartition(
        new Date(now - back * 24 * 60 * 60 * 1000).toISOString(),
      );
      if (back >= TEST_RECORDS_REFRESH_TAIL_DAYS && this.#days.has(day)) {
        continue;
      }
      try {
        this.#days.set(day, await collectDay(day, collectOptions));
      } catch (error) {
        console.warn(`test records history: ${day} failed: ${error}`);
      }
    }
    for (const day of this.#days.keys()) {
      const age = now - new Date(day.replaceAll("/", "-")).getTime();
      if (age > windowDays * 24 * 60 * 60 * 1000) this.#days.delete(day);
    }
    await this.#save();
  }

  /** The identities present in the window, most-run first. */
  identities(): { key: string; runs: number }[] {
    const runsByKey = new Map<string, number>();
    for (const aggregates of this.#days.values()) {
      for (const aggregate of aggregates) {
        runsByKey.set(
          aggregate.key,
          (runsByKey.get(aggregate.key) ?? 0) + aggregate.runs,
        );
      }
    }
    return [...runsByKey.entries()]
      .map(([key, runs]) => ({ key, runs }))
      .sort((a, b) => b.runs - a.runs || a.key.localeCompare(b.key));
  }

  /** The series for one identity, ready for trend fitting. */
  series(key: string): TestSeries {
    const series: TestSeries = {
      key,
      times: [],
      passRates: [],
      meanDurationsMs: [],
    };
    for (const day of this.days()) {
      const aggregate = this.#days.get(day)!.find(
        (candidate) => candidate.key === key,
      );
      if (aggregate === undefined) continue;
      // Rates are over the runs that executed: a skip is neither a pass
      // nor a failure, and an all-skip day contributes no point.
      const executed = aggregate.runs - aggregate.skips;
      if (executed <= 0) continue;
      series.times.push(new Date(day.replaceAll("/", "-")).getTime());
      series.passRates.push(
        (executed - aggregate.failures) / executed,
      );
      series.meanDurationsMs.push(
        aggregate.totalDurationMs / aggregate.runs,
      );
    }
    return series;
  }
}
