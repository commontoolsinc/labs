/**
 * Reading the store. The bucket is publicly readable, so listing and
 * fetching need no credential at all; records are untrusted input, and
 * every line goes through the schema validators, with malformed lines
 * ignored. Objects are gzip-encoded with transcoding, so a plain fetch
 * receives NDJSON.
 */

import {
  parseContextLine,
  parseRecordLine,
  type RunContext,
  type TestRecord,
} from "./schema.ts";

const STORAGE = "https://storage.googleapis.com/storage/v1";

/** Lists every object name under a prefix, paginating as needed. */
export async function listObjects(options: {
  bucket: string;
  prefix: string;
  fetch?: typeof fetch;
}): Promise<string[]> {
  const doFetch = options.fetch ?? fetch;
  const names: string[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(
      `${STORAGE}/b/${encodeURIComponent(options.bucket)}/o`,
    );
    url.searchParams.set("prefix", options.prefix);
    url.searchParams.set("fields", "items(name),nextPageToken");
    url.searchParams.set("maxResults", "1000");
    if (pageToken !== undefined) url.searchParams.set("pageToken", pageToken);
    const res = await doFetch(url);
    if (!res.ok) {
      throw new Error(
        `listing ${options.prefix} failed: HTTP ${res.status}`,
      );
    }
    const page = await res.json() as {
      items?: { name?: string }[];
      nextPageToken?: string;
    };
    for (const item of page.items ?? []) {
      if (typeof item.name === "string") names.push(item.name);
    }
    pageToken = page.nextPageToken;
  } while (pageToken !== undefined);
  return names.sort();
}

/** One report inside an object: a context line and the records under it. */
export interface StoredReportGroup {
  context: RunContext | undefined;
  records: TestRecord[];
}

/**
 * One uploaded object, validated line by line. A submission object holds
 * one report; a rollup concatenates a day of them, one context line ahead
 * of each report's records. `reports` keeps that per-report grouping —
 * which is what carries provenance such as the fork flag — while `context`
 * and `records` flatten the object for consumers reading single-report
 * submissions.
 */
export interface StoredReport {
  objectName: string;
  context: RunContext | undefined;
  records: TestRecord[];
  reports: StoredReportGroup[];
}

/**
 * Parses object text into report groups: every context line starts a
 * report, and record lines belong to the report whose context most
 * recently preceded them. Record lines ahead of any context form a group
 * with no context, and lines that parse as neither are dropped.
 */
export function parseReportGroups(text: string): StoredReportGroup[] {
  const groups: StoredReportGroup[] = [];
  let current: StoredReportGroup | undefined;
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    const context = parseContextLine(line);
    if (context !== undefined) {
      current = { context, records: [] };
      groups.push(current);
      continue;
    }
    const record = parseRecordLine(line);
    if (record !== undefined) {
      if (current === undefined) {
        current = { context: undefined, records: [] };
        groups.push(current);
      }
      current.records.push(record);
    }
  }
  return groups;
}

/** Fetches and validates one object. */
export async function readObject(options: {
  bucket: string;
  objectName: string;
  fetch?: typeof fetch;
}): Promise<StoredReport> {
  const doFetch = options.fetch ?? fetch;
  const url = `https://storage.googleapis.com/${
    encodeURIComponent(options.bucket)
  }/${options.objectName.split("/").map(encodeURIComponent).join("/")}`;
  const res = await doFetch(url);
  if (!res.ok) {
    throw new Error(
      `reading ${options.objectName} failed: HTTP ${res.status}`,
    );
  }
  const reports = parseReportGroups(await res.text());
  return {
    objectName: options.objectName,
    context: reports[0]?.context,
    records: reports.flatMap((report) => report.records),
    reports,
  };
}
