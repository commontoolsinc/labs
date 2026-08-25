#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env
/**
 * The credential-free shipping step every CI test job ends with: gather the
 * job's spooled record fragments and its JUnit files into one artifact
 * directory that the relay workflow later uploads to the store.
 *
 *   deno run -A tasks/test-records-gather.ts --out <dir> --job <name>
 *     [--shard <label>]
 *     [--variant <name>]
 *     [--junit kind=<kind>,scope=<scope>[,prefix=<repo path>],glob=<glob>]...
 *
 * The output directory holds records.ndjson (one record line per test) and
 * job.json (the facts only the job knows: its display name, shard, the
 * commit it checked out, and the machine). The relay composes the context
 * line from the workflow_run event payload plus job.json, so nothing here
 * carries credentials. A failure warns and exits zero: this is telemetry,
 * and it never fails the job.
 */

import { expandGlob } from "@std/fs";
import { join } from "@std/path";
import {
  type Environment,
  ingestJUnit,
  readEnv,
  readSpool,
  recordsDir,
  serializeRecordLine,
  type TestRecord,
} from "@commonfabric/test-support/records";

/** One JUnit ingestion request from the command line. */
export interface JUnitSpec {
  kind: string;
  scope: string;
  prefix?: string;
  glob: string;
}

/** Facts only the job itself knows, shipped beside its records. */
export interface JobFacts {
  job: string;
  shard?: string;
  commit?: string;
  headCommit?: string;
  branch?: string;
  os: string;
  arch: string;
  denoVersion: string;
}

/** Parses one `kind=...,scope=...[,prefix=...],glob=...` specification. */
export function parseJUnitSpec(text: string): JUnitSpec {
  const fields = new Map<string, string>();
  for (const part of text.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) throw new Error(`not a key=value pair in --junit: ${part}`);
    fields.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  const kind = fields.get("kind");
  const scope = fields.get("scope");
  const glob = fields.get("glob");
  if (kind === undefined || scope === undefined || glob === undefined) {
    throw new Error(`--junit needs kind, scope, and glob: ${text}`);
  }
  const spec: JUnitSpec = { kind, scope, glob };
  const prefix = fields.get("prefix");
  if (prefix !== undefined) spec.prefix = prefix;
  return spec;
}

/** The head commit of the pull request the event describes, when any. */
export function headCommitOfEvent(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const pr = (payload as Record<string, unknown>).pull_request;
  if (typeof pr !== "object" || pr === null) return undefined;
  const head = (pr as Record<string, unknown>).head;
  if (typeof head !== "object" || head === null) return undefined;
  const sha = (head as Record<string, unknown>).sha;
  return typeof sha === "string" && sha.length > 0 ? sha : undefined;
}

export interface GatherOptions {
  out: string;
  job: string;
  shard?: string;
  variant?: string;
  junit: JUnitSpec[];
  spoolDir?: string;
  env?: Environment;
}

/** Gathers the spool and JUnit files into the artifact directory. */
export async function gather(options: GatherOptions): Promise<void> {
  if (options.variant !== undefined && options.variant.length === 0) {
    throw new Error("--variant must not be empty");
  }
  const records: TestRecord[] = [];
  if (options.spoolDir !== undefined) {
    const spooled = await readSpool(options.spoolDir);
    for (const warning of spooled.warnings) {
      console.warn(`test records: ${warning}`);
    }
    records.push(...spooled.records);
  }
  for (const spec of options.junit) {
    let matched = 0;
    try {
      for await (const entry of expandGlob(spec.glob)) {
        if (!entry.isFile) continue;
        matched++;
        // Caught per file: one unreadable or malformed report costs only
        // itself, not the records of every later file the glob matched.
        try {
          const xml = await Deno.readTextFile(entry.path);
          const ingestOptions: Parameters<typeof ingestJUnit>[1] = {
            kind: spec.kind,
            scope: spec.scope,
          };
          if (spec.prefix !== undefined) ingestOptions.filePrefix = spec.prefix;
          records.push(...ingestJUnit(xml, ingestOptions));
        } catch (error) {
          console.warn(
            `test records: ingesting ${entry.path} failed: ${error}`,
          );
        }
      }
    } catch (error) {
      console.warn(`test records: expanding ${spec.glob} failed: ${error}`);
    }
    if (matched === 0) {
      console.warn(`test records: no JUnit files matched ${spec.glob}`);
    }
  }

  if (options.variant !== undefined) {
    for (const record of records) record.test.v = options.variant;
  }

  const env = options.env ?? Deno.env.get;
  const facts: JobFacts = {
    job: options.job,
    os: Deno.build.os,
    arch: Deno.build.arch,
    denoVersion: Deno.version.deno,
  };
  if (options.shard !== undefined) facts.shard = options.shard;
  const commit = readEnv("GITHUB_SHA", env);
  if (commit !== undefined && commit.length > 0) facts.commit = commit;
  const branch = readEnv("GITHUB_HEAD_REF", env) ??
    readEnv("GITHUB_REF_NAME", env);
  if (branch !== undefined && branch.length > 0) facts.branch = branch;
  const eventPath = readEnv("GITHUB_EVENT_PATH", env);
  if (eventPath !== undefined && eventPath.length > 0) {
    try {
      const payload = JSON.parse(await Deno.readTextFile(eventPath));
      const headCommit = headCommitOfEvent(payload);
      if (headCommit !== undefined) facts.headCommit = headCommit;
    } catch {
      // The event payload is optional context; a job without one still
      // records.
    }
  }

  await Deno.mkdir(options.out, { recursive: true });
  await Deno.writeTextFile(
    join(options.out, "job.json"),
    JSON.stringify(facts, null, 2) + "\n",
  );
  let lines = "";
  for (const record of records) {
    lines += serializeRecordLine(record);
  }
  await Deno.writeTextFile(join(options.out, "records.ndjson"), lines);
  console.log(
    `test records: gathered ${records.length} record(s) into ${options.out}`,
  );
}

function usage(): never {
  console.error(
    "usage: test-records-gather.ts --out <dir> --job <name> " +
      "[--shard <label>] [--variant <name>] [--junit <spec>]...",
  );
  Deno.exit(2);
}

/**
 * Parses the command line into gather options, or returns undefined for a
 * malformed one. A malformed --junit specification skips itself with a
 * warning: the spool and the other specifications still gather, so one bad
 * flag does not cost the job's whole record set.
 */
export function parseGatherArgs(
  argsIn: readonly string[],
): GatherOptions | undefined {
  let out: string | undefined;
  let job: string | undefined;
  let shard: string | undefined;
  let variant: string | undefined;
  const junit: JUnitSpec[] = [];
  const args = [...argsIn];
  while (args.length > 0) {
    const flag = args.shift()!;
    const value = args.shift();
    if (value === undefined) return undefined;
    switch (flag) {
      case "--out":
        out = value;
        break;
      case "--job":
        job = value;
        break;
      case "--shard":
        shard = value;
        break;
      case "--variant":
        if (value.length === 0) return undefined;
        variant = value;
        break;
      case "--junit":
        try {
          junit.push(parseJUnitSpec(value));
        } catch (error) {
          console.warn(`test records: ignoring --junit ${value}: ${error}`);
        }
        break;
      default:
        return undefined;
    }
  }
  if (out === undefined || job === undefined) return undefined;
  const options: GatherOptions = { out, job, junit };
  if (shard !== undefined) options.shard = shard;
  if (variant !== undefined) options.variant = variant;
  return options;
}

async function main(): Promise<void> {
  const options = parseGatherArgs(Deno.args);
  if (options === undefined) usage();
  const spoolDir = recordsDir();
  if (spoolDir !== undefined) options.spoolDir = spoolDir;
  await gather(options);
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    // Telemetry never fails the job; a usage error above still exits 2.
    console.warn(`test records: gathering failed: ${error}`);
  }
}
