/**
 * Implementation of the root `deno task test` runner. The entry point is
 * tasks/test.ts; the logic lives here because `deno coverage` skips files
 * whose names end in test.ts, and the coverage-debt metric scores an
 * unmeasured file as fully uncovered.
 */

import * as path from "@std/path";
import { parse as parseJsonc } from "@std/jsonc";
import { decode, encode } from "@commonfabric/utils/encoding";
import {
  FragmentWriter,
  ingestJUnit,
  recordsDir,
} from "@commonfabric/test-support/records";
import { parseShard, type Shard } from "./shard-utils.ts";
import { WORKSPACE_TEST_WEIGHTS } from "./test-timing-weights.ts";
import { assignWeightedShards } from "./weighted-shards.ts";

export const ALL_DISABLED: string[] = [];

export function getPackageName(memberPath: string): string {
  const relativePath = memberPath.replace(/^\.\//, "");
  return relativePath.replace(/^packages\//, "");
}

export function parseDisabledPackageList(raw: string | undefined): string[] {
  return (raw ?? "").split(/[,\s]+/).filter((name) => name.length > 0);
}

export async function initializeDb(cwd: string = Deno.cwd()): Promise<void> {
  console.log("Initializing database dependencies...");
  const result = await new Deno.Command(Deno.execPath(), {
    args: ["task", "initialize-db"],
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();

  if (!result.success) {
    console.error("Failed to initialize database dependencies.");
    console.log(decode(result.stdout));
    console.error(decode(result.stderr));
    Deno.exit(result.code);
  }
}

export async function testPackage(
  memberPath: string,
  packageName: string,
  packagePath: string,
  coverageRoot: string | undefined,
  extraEnv?: Record<string, string>,
  junitPath?: string,
): Promise<{
  memberPath: string;
  packageName: string;
  packagePath: string;
  durationMs: number;
  result: Deno.CommandOutput;
}> {
  const startedAt = Date.now();
  let result: Deno.CommandOutput;
  try {
    const env: Record<string, string> = { ENV: "test", ...extraEnv };
    if (coverageRoot) {
      env.DENO_COVERAGE_DIR = path.join(
        coverageRoot,
        packageName.replaceAll("/", "__"),
      );
    }

    // Trailing arguments to `deno task` append to the task's command line,
    // which is what threads the flag down to the leaf `deno test`.
    const args = junitPath !== undefined
      ? ["task", "test", `--junit-path=${junitPath}`]
      : ["task", "test"];
    result = await new Deno.Command(Deno.execPath(), {
      args,
      cwd: packagePath,
      env,
      stdout: "piped",
      stderr: "piped",
    }).output();
  } catch (e) {
    result = {
      success: false,
      stdout: new Uint8Array(),
      stderr: encode(`${e}`),
      code: 1,
      signal: null,
    };
  }

  const durationMs = Date.now() - startedAt;
  const duration = (durationMs / 1000).toFixed(1);
  const status = result.success ? "ok" : "failed";
  console.log(`Finished ${packageName} in ${duration}s (${status})`);

  return {
    memberPath,
    packageName,
    packagePath,
    durationMs,
    result,
  };
}

type PackageResult = Awaited<ReturnType<typeof testPackage>>;

function reportPackageFailure(result: PackageResult): void {
  console.error(`Failed ${result.packageName} (${result.packagePath})`);
  console.log(decode(result.result.stdout));
  console.error(decode(result.result.stderr));
}

// Reads one leaf's JUnit XML and appends its cases to the spool. A leaf
// that wrote no XML — it crashed before the end, since deno test writes
// the file only at process exit — contributes nothing, and a malformed
// file warns without failing anything.
async function ingestLeafJUnit(
  fragment: FragmentWriter,
  junitPath: string,
  scope: string,
  memberPath: string,
): Promise<void> {
  let xml: string;
  try {
    xml = await Deno.readTextFile(junitPath);
  } catch {
    return;
  }
  try {
    const prefix = memberPath.replace(/^\.\//, "");
    for (
      const record of ingestJUnit(xml, {
        kind: "unit",
        scope,
        filePrefix: prefix,
      })
    ) {
      fragment.append(record);
    }
  } catch (error) {
    console.warn(`test records: ingesting ${junitPath} failed: ${error}`);
  }
}

// Read the workspace member list from the root manifest. Parsed with the JSONC
// parser so a `deno.jsonc` carrying comments is read correctly.
export async function readWorkspaceMembers(
  configPath: string | URL = "./deno.jsonc",
): Promise<string[]> {
  const manifest = parseJsonc(await Deno.readTextFile(configPath)) as {
    workspace: string[];
  };
  return manifest.workspace;
}

export function assertTaskTestsIncluded(members: string[]): void {
  if (members.some((memberPath) => getPackageName(memberPath) === "tasks")) {
    return;
  }
  throw new Error(
    "The root workspace must include tasks so the workspace test job runs the task tests.",
  );
}

// One `deno task test` invocation: a workspace member, plus environment
// variables when the member is one slice of an internally sharded package.
export interface TestUnit {
  memberPath: string;
  packageName: string;
  env?: Record<string, string>;
}

// Packages whose test runner supports internal sharding via an environment
// variable. When the workspace run itself is sharded, such a package is
// expanded into `total` weighted units so one heavy package can run across
// several workspace shards. Without a workspace shard (local runs), the
// package runs as a single unit and the variable stays unset.
const INTERNALLY_SHARDED_PACKAGES: Record<
  string,
  { total: number; envVar: string }
> = {
  // packages/cli/test/run-tests.ts reads CLI_TEST_SHARD.
  cli: { total: 10, envVar: "CLI_TEST_SHARD" },
  piece: { total: 3, envVar: "PIECE_TEST_SHARD" },
  tasks: { total: 3, envVar: "TASK_TEST_SHARD" },
};

// Members whose `deno task test` runs exactly one `deno test` (directly, or
// through a runner that forwards trailing flags to one), so an appended
// --junit-path lands on it whole. The runner threads the flag to these and
// ingests the XML into the spool as unit-kind records when recording is on.
// The exceptions and why they stay out: patterns and ui run two test
// commands in one task line, so the flag reaches only the second; cli's
// run-tests.ts runs three deno test invocations per slice, which would each
// overwrite the file; static, content-hash, data-model, memory, pure-json,
// spec-model, and state-inspector route `test` through a task graph that
// appends arguments nowhere; identity, iframe-sandbox, and dashboard run
// browser harnesses that record through the deno-web-test reporter instead;
// home-schemas, generated-patterns, and patterns/auth have no tests.
const JUNIT_CAPABLE_MEMBERS = new Set([
  "./packages/api",
  "./packages/background-piece-service",
  "./packages/cf-harness",
  "./packages/connectors/agents",
  "./packages/deno-web-test",
  "./packages/felt",
  "./packages/fuse",
  "./packages/html",
  "./packages/integration",
  "./packages/js-compiler",
  "./packages/leb128",
  "./packages/lib-shell",
  "./packages/llm",
  "./packages/piece",
  "./packages/runner",
  "./packages/runtime-client",
  "./packages/schema-generator",
  "./packages/shell",
  "./packages/test-support",
  "./packages/toolshed",
  "./packages/ts-transformers",
  "./packages/utils",
  "./scripts",
  "./tasks",
]);

// The identity scope of a unit: the package name with any internal slice
// label stripped, so the records of "cli (3/10)" and "cli (7/10)" join.
export function unitScope(packageName: string): string {
  return packageName.replace(/ \(\d+\/\d+\)$/, "");
}

// A filename-safe slug for a unit's JUnit file, unique per slice.
export function unitSlug(packageName: string): string {
  return packageName.replaceAll("/", "__").replace(/[^A-Za-z0-9_.-]+/g, "-");
}

// Enabled workspace members are split by observed test cost. Without a shard,
// every enabled member is selected as a single unit.
export function selectShardMembers(
  members: string[],
  disabledPackages: string[],
  shard: Shard | undefined,
): TestUnit[] {
  const enabled = members.filter(
    (memberPath) => !disabledPackages.includes(getPackageName(memberPath)),
  );
  if (!shard) {
    return enabled.map((memberPath) => ({
      memberPath,
      packageName: getPackageName(memberPath),
    }));
  }

  const units: TestUnit[] = [];
  for (const memberPath of enabled) {
    const packageName = getPackageName(memberPath);
    const split = INTERNALLY_SHARDED_PACKAGES[packageName];
    if (!split) {
      units.push({ memberPath, packageName });
      continue;
    }
    for (let slice = 1; slice <= split.total; slice++) {
      units.push({
        memberPath,
        packageName: `${packageName} (${slice}/${split.total})`,
        env: { [split.envVar]: `${slice}/${split.total}` },
      });
    }
  }

  const assignments = assignWeightedShards(
    units.map((unit) => ({
      name: unit.packageName,
      weight: WORKSPACE_TEST_WEIGHTS[unit.packageName] ?? 1,
      group: unit.memberPath,
    })),
    shard.total,
  );
  return units
    .filter((unit) => assignments.get(unit.packageName) === shard.index)
    .sort((a, b) =>
      (WORKSPACE_TEST_WEIGHTS[b.packageName] ?? 1) -
        (WORKSPACE_TEST_WEIGHTS[a.packageName] ?? 1) ||
      a.packageName.localeCompare(b.packageName)
    );
}

// Cap on concurrently running package test tasks. Individual packages may also
// parallelize their tests. Half the cores limits that nested concurrency while
// allowing independent packages to overlap. TEST_CONCURRENCY overrides it.
export function testConcurrency(
  raw = Deno.env.get("TEST_CONCURRENCY"),
): number {
  if (raw) {
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new Error(
        `Invalid TEST_CONCURRENCY "${raw}"; expected a positive integer.`,
      );
    }
    return parsed;
  }
  return Math.max(2, Math.floor(navigator.hardwareConcurrency / 2));
}

export async function runTests(
  disabledPackages: string[],
  shard?: Shard,
  workspaceCwd: string = Deno.cwd(),
): Promise<boolean> {
  const suiteStartedAt = Date.now();
  const units = selectShardMembers(
    await readWorkspaceMembers(path.join(workspaceCwd, "deno.jsonc")),
    disabledPackages,
    shard,
  );
  if (units.length === 0) {
    console.error("No workspace packages selected to test.");
    return false;
  }
  // Resolve to an absolute path: each package's test subprocess runs with its
  // own cwd, so a relative DENO_COVERAGE_DIR would land under
  // packages/<pkg>/... instead of the shared workspace coverage directory.
  const coverageRootRaw = Deno.env.get("DENO_COVERAGE_DIR");
  const coverageRoot = coverageRootRaw
    ? path.resolve(workspaceCwd, coverageRootRaw)
    : undefined;

  // With recording on, junit-capable leaves get a --junit-path in a
  // temporary directory, and each leaf's XML is ingested into the spool as
  // unit-kind records under the package's own scope. The runner stays
  // plumbing: it forwards the flag and moves the results; the reported
  // names come from the leaves.
  const spoolDir = recordsDir();
  const junitRoot = spoolDir !== undefined
    ? await Deno.makeTempDir({ prefix: "workspace-junit-" })
    : undefined;
  const fragment = spoolDir !== undefined
    ? FragmentWriter.open(spoolDir)
    : undefined;

  const results: PackageResult[] = [];
  let nextUnit = 0;
  let failureSeen = false;
  const workerCount = Math.min(testConcurrency(), units.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (!failureSeen && nextUnit < units.length) {
      const unit = units[nextUnit++];
      console.log(`Testing ${unit.packageName}...`);
      const packagePath = path.resolve(workspaceCwd, unit.memberPath);
      const junitPath =
        junitRoot !== undefined && JUNIT_CAPABLE_MEMBERS.has(unit.memberPath)
          ? path.join(junitRoot, `${unitSlug(unit.packageName)}.xml`)
          : undefined;
      const result = await testPackage(
        unit.memberPath,
        unit.packageName,
        packagePath,
        coverageRoot,
        unit.env,
        junitPath,
      );
      results.push(result);
      if (junitPath !== undefined && fragment !== undefined) {
        await ingestLeafJUnit(
          fragment,
          junitPath,
          unitScope(unit.packageName),
          unit.memberPath,
        );
      }
      if (!result.result.success) {
        failureSeen = true;
        reportPackageFailure(result);
      }
    }
  });
  await Promise.all(workers);
  fragment?.close();
  if (junitRoot !== undefined) {
    await Deno.remove(junitRoot, { recursive: true }).catch(() => {});
  }
  const durationResults = [...results].sort((a, b) =>
    b.durationMs - a.durationMs
  );
  const failedPackages = results.filter((result) => !result.result.success);

  console.log("Package timings:");
  for (const result of durationResults) {
    const duration = (result.durationMs / 1000).toFixed(1);
    const status = result.result.success ? "ok" : "failed";
    console.log(`- ${result.packageName}: ${duration}s (${status})`);
  }
  console.log(
    `Total wall time: ${((Date.now() - suiteStartedAt) / 1000).toFixed(1)}s`,
  );

  if (failedPackages.length === 0) {
    console.log("All tests passing!");
  } else {
    console.error("One or more tests failed.");
    console.error("Failed packages:");
    for (const result of failedPackages) {
      console.error(`- ${result.packageName} (${result.packagePath})`);
    }
  }

  return failedPackages.length === 0;
}

export async function main(): Promise<boolean> {
  const shardRaw = Deno.env.get("TEST_SHARD");
  const shard = shardRaw ? parseShard(shardRaw) : undefined;
  assertTaskTestsIncluded(await readWorkspaceMembers());
  await initializeDb();
  return await runTests(
    [
      ...ALL_DISABLED,
      ...parseDisabledPackageList(Deno.env.get("TEST_DISABLED_PACKAGES")),
    ],
    shard,
  );
}
