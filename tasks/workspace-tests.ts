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
  preloadArgument,
  readNameMaps,
  recordsDir,
} from "@commonfabric/test-support/records";
import { writeUnlaunchedMembers } from "./unlaunched-members.ts";

export const ALL_DISABLED: string[] = [];

export function getPackageName(memberPath: string): string {
  const relativePath = memberPath.replace(/^\.\//, "");
  return relativePath.replace(/^packages\//, "");
}

export function parseDisabledPackageList(raw: string | undefined): string[] {
  return (raw ?? "").split(/[,\s]+/).filter((name) => name.length > 0);
}

export async function initializeDb(cwd: string = Deno.cwd()): Promise<boolean> {
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
    return false;
  }
  return true;
}

export async function testPackage(
  memberPath: string,
  packageName: string,
  packagePath: string,
  coverageRoot: string | undefined,
  extraEnv?: Record<string, string>,
  junitPath?: string,
  preload = true,
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
    // which is what threads the flags down to the leaf `deno test`. The
    // preload travels with the JUnit path because both reach the leaf the
    // same way and the report is what the preload's map is joined onto; a
    // member whose task cannot take one cannot take the other.
    const args = ["task", "test"];
    if (junitPath !== undefined) {
      args.push(`--junit-path=${junitPath}`);
      if (preload) args.push(preloadArgument());
    }
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
// file warns without failing anything. The name maps the leaf's preload
// left in the spool are what give each case its file; they are read here
// rather than once for the suite so that a run killed part way through
// keeps the attribution of every package that finished.
async function ingestLeafJUnit(
  fragment: FragmentWriter,
  spoolDir: string,
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
        fileByName: await readNameMaps(spoolDir, { within: prefix }),
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

// One `deno task test` invocation: a workspace member.
export interface TestUnit {
  memberPath: string;
  packageName: string;
}

// A member's test task takes an appended `--junit-path` whole when it runs
// exactly one `deno test`. That is read from the task itself, so a package
// that lands with an ordinary test task is covered without being listed
// anywhere. Two shapes are not readable from the task line, and both are
// named below.
//
// A task carrying a shell metacharacter puts the appended flag somewhere
// other than the test command: `api` chains a type-performance benchmark
// after its tests, and `patterns` and `ui` run two test commands each, so
// the flag would reach only the last one.
//
// A task that runs a script cannot show what the script does with the
// flags it is handed. The members listed here route through a runner that
// forwards them to one `deno test`. The runners that do not appear here
// keep their leaves out: `cli` runs three `deno test` invocations per
// slice, which would each overwrite the file, and `dashboard`, `identity`,
// and `iframe-sandbox` drive browser harnesses that record through the
// deno-web-test reporter instead.
const FLAG_FORWARDING_RUNNERS = new Set([
  "./packages/connectors/agents/host",
  "./packages/piece",
  "./tasks",
]);

/**
 * A directory, given as a path or a URL, as a URL that member paths
 * resolve against. The trailing slash is what makes a member resolve
 * inside the directory rather than beside it.
 */
function directoryUrl(root: string | URL): URL {
  const url = root instanceof URL
    ? new URL(root.href)
    : path.toFileUrl(path.resolve(root));
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

/**
 * A task as a manifest writes it: the command line itself, or an object that
 * may carry one. An object with no `command` is defined by its `dependencies`
 * instead, and Deno runs those.
 */
type TaskDefinition = string | { command?: string };

/** The manifest Deno resolves for a member, and its `test` task. */
interface MemberManifest {
  /** Path to the manifest, relative to the workspace root. */
  readonly path: string;

  /** The `test` task it defines, where it defines one. */
  readonly testTask: TaskDefinition | undefined;
}

/**
 * The manifest Deno resolves for a member, and the `test` task that one
 * manifest defines. A member carrying both a `deno.json` and a `deno.jsonc`
 * is read the way its own tooling reads it: Deno takes the `deno.json` and
 * ignores the other file entirely rather than merging the two, so a `test`
 * task written in the manifest Deno ignores is not a task anything can run.
 *
 * A member with no manifest at all takes the `deno.jsonc` path, so that a
 * report naming it names the file to write. Such a member never reaches the
 * fall-through a `test` task exists to prevent, because Deno refuses to load
 * a workspace at all when one of its members has no config file.
 */
async function memberManifest(
  member: string,
  root: string | URL,
): Promise<MemberManifest> {
  const rootUrl = directoryUrl(root);
  for (const manifest of ["deno.json", "deno.jsonc"]) {
    const manifestPath = `${member}/${manifest}`;
    let text: string;
    try {
      text = await Deno.readTextFile(new URL(manifestPath, rootUrl));
    } catch {
      continue;
    }
    const tasks = (parseJsonc(text) as {
      tasks?: Record<string, TaskDefinition>;
    })?.tasks;
    return { path: manifestPath, testTask: tasks?.test };
  }
  return { path: `${member}/deno.jsonc`, testTask: undefined };
}

/**
 * The command line a member's `test` task runs, when the manifest Deno
 * resolves for that member defines the task with a command. A task defined
 * by its `dependencies` alone carries no command and reads as `undefined`
 * here, the same as a member defining no `test` task at all;
 * `assertMemberTestTasksDefined()` is what tells those two apart.
 */
export async function memberTestTask(
  member: string,
  root: string | URL = Deno.cwd(),
): Promise<string | undefined> {
  const { testTask } = await memberManifest(member, root);
  return typeof testTask === "string" ? testTask : testTask?.command;
}

/**
 * Throws unless every member defines a `test` task of its own, in whatever
 * form — a command, or dependencies alone — in the manifest Deno resolves
 * for it. Starting a run with one missing is what this refuses: `deno task
 * test` in that member's directory resolves against the root workspace
 * instead, which is this suite, so the run re-enters itself once per such
 * member.
 */
export async function assertMemberTestTasksDefined(
  members: readonly string[],
  root: string | URL = Deno.cwd(),
): Promise<void> {
  const missing: string[] = [];
  for (const member of members) {
    const { path, testTask } = await memberManifest(member, root);
    if (testTask === undefined) missing.push(path);
  }
  if (missing.length === 0) return;
  const named = missing.map((manifest) => `\`${manifest}\``).join(", ");
  throw new Error(
    [
      `Every workspace member needs a \`test\` task of its own.`,
      `Missing from: ${named}.`,
      `Add a \`test\` entry to that manifest's \`tasks\` — \`deno test\` where`,
      `the package has tests, or \`echo 'No tests defined.'\` where it has`,
      `none yet, as \`packages/utils/deno.jsonc\` shows. Put it in the file`,
      `named above rather than in a second manifest beside it: where a member`,
      `carries both a \`deno.json\` and a \`deno.jsonc\`, Deno takes the`,
      `\`deno.json\` and ignores the other whole, \`imports\` and all.`,
      `Without the entry, \`deno task test\` in the package directory resolves`,
      `against the root workspace instead, and the whole suite runs inside`,
      `itself.`,
    ].join(" "),
  );
}

/**
 * Whether an appended `--junit-path` reaches this member's `deno test`
 * whole, so the runner can thread the flag and ingest the XML it writes.
 */
export function acceptsJUnitPath(
  member: string,
  task: string | undefined,
): boolean {
  if (FLAG_FORWARDING_RUNNERS.has(member)) return true;
  if (task === undefined) return false;
  if (/[&;|<>]/.test(task)) return false;
  return /(^|\s)deno test(\s|$)/.test(task);
}

/**
 * Whether an appended `--preload` reaches this member's `deno test` and
 * loads once it gets there. A member naming its own import map is the one
 * that cannot: that map governs every module of the invocation, the
 * preload included, so a specifier the preload needs and the map does not
 * carry fails the whole run rather than the preload alone. What that
 * member gives up is the preload's name map, and it loses nothing by it —
 * with no wrapper installed, the report keeps its own class names and
 * ingestion reads the file from those instead.
 */
export function acceptsPreload(
  member: string,
  task: string | undefined,
): boolean {
  if (!acceptsJUnitPath(member, task)) return false;
  return task === undefined || !/--import-map[= ]/.test(task);
}

/** The members whose leaves also take the preload. */
export async function preloadCapableMembers(
  members: readonly string[],
  root: string | URL = Deno.cwd(),
): Promise<Set<string>> {
  const capable = new Set<string>();
  for (const member of members) {
    if (acceptsPreload(member, await memberTestTask(member, root))) {
      capable.add(member);
    }
  }
  return capable;
}

/** The members whose leaves take the flag, read from their manifests. */
export async function junitCapableMembers(
  members: readonly string[],
  root: string | URL = Deno.cwd(),
): Promise<Set<string>> {
  const capable = new Set<string>();
  for (const member of members) {
    if (acceptsJUnitPath(member, await memberTestTask(member, root))) {
      capable.add(member);
    }
  }
  return capable;
}

// The identity scope of a unit: the package name with any internal slice
// label stripped, so the records of "cli (3/10)" and "cli (7/10)" join.
export function unitScope(packageName: string): string {
  return packageName.replace(/ \(\d+\/\d+\)$/, "");
}

// A filename-safe slug for a unit's JUnit file, unique per slice.
export function unitSlug(packageName: string): string {
  return packageName.replaceAll("/", "__").replace(/[^A-Za-z0-9_.-]+/g, "-");
}

// Every member the run is not told to leave out.
export function selectMembers(
  members: string[],
  disabledPackages: string[],
): TestUnit[] {
  return members
    .filter((memberPath) =>
      !disabledPackages.includes(getPackageName(memberPath))
    )
    .map((memberPath) => ({
      memberPath,
      packageName: getPackageName(memberPath),
    }));
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

/**
 * Runs the enabled members of the workspace at `workspaceCwd`, or this shard's
 * share of them, and returns whether every one of them passed.
 *
 * Workers stop taking new members once one fails, so a failing run leaves the
 * rest unstarted. With coverage collection on, the members it never started
 * are recorded in the coverage profile directory, since their coverage is
 * unknown rather than absent; see `unlaunched-members.ts`.
 */
export async function runTests(
  disabledPackages: string[],
  workspaceCwd: string = Deno.cwd(),
): Promise<boolean> {
  const suiteStartedAt = Date.now();
  const members = await readWorkspaceMembers(
    path.join(workspaceCwd, "deno.jsonc"),
  );
  // No member's test task is spawned until every member has been checked.
  // One with no `test` task of its own is what turns a single run into an
  // unbounded number of them.
  await assertMemberTestTasksDefined(members, workspaceCwd);
  const units = selectMembers(members, disabledPackages);
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
  // names come from the leaves. A temporary directory that cannot be
  // created turns recording off with a warning; it never fails the suite.
  const spoolDir = recordsDir();
  let junitRoot: string | undefined;
  if (spoolDir !== undefined) {
    try {
      junitRoot = await Deno.makeTempDir({ prefix: "workspace-junit-" });
    } catch (error) {
      console.warn(`test records: no JUnit directory: ${error}`);
    }
  }
  const fragment = spoolDir !== undefined && junitRoot !== undefined
    ? FragmentWriter.open(spoolDir)
    : undefined;
  const memberPaths = units.map((unit) => unit.memberPath);
  const workspaceUrl = new URL(`file://${path.resolve(workspaceCwd)}/`);
  const capable = junitRoot !== undefined
    ? await junitCapableMembers(memberPaths, workspaceUrl)
    : new Set<string>();
  const preloadable = junitRoot !== undefined
    ? await preloadCapableMembers(memberPaths, workspaceUrl)
    : new Set<string>();

  const results: PackageResult[] = [];
  let nextUnit = 0;
  let failureSeen = false;
  const workerCount = Math.min(testConcurrency(), units.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (!failureSeen && nextUnit < units.length) {
      const unit = units[nextUnit++];
      console.log(`Testing ${unit.packageName}...`);
      const packagePath = path.resolve(workspaceCwd, unit.memberPath);
      const junitPath = junitRoot !== undefined && capable.has(unit.memberPath)
        ? path.join(junitRoot, `${unitSlug(unit.packageName)}.xml`)
        : undefined;
      const result = await testPackage(
        unit.memberPath,
        unit.packageName,
        packagePath,
        coverageRoot,
        undefined,
        junitPath,
        preloadable.has(unit.memberPath),
      );
      results.push(result);
      if (
        junitPath !== undefined && fragment !== undefined &&
        spoolDir !== undefined
      ) {
        await ingestLeafJUnit(
          fragment,
          spoolDir,
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
  // Every unit below `nextUnit` was handed to a worker; the units above it are
  // the ones the stop after a failure left unstarted. An internally sharded
  // package is several units over one member, and a member with any unstarted
  // slice is measured over less than its own tests, so the member is named
  // whichever of its slices went unstarted.
  const unlaunchedMembers = [
    ...new Set(units.slice(nextUnit).map((unit) => unit.memberPath)),
  ];
  if (coverageRoot !== undefined) {
    await writeUnlaunchedMembers(coverageRoot, unlaunchedMembers);
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

  if (unlaunchedMembers.length > 0) {
    console.error("Packages this run selected and never started:");
    for (const member of unlaunchedMembers) {
      console.error(`- ${member}`);
    }
  }

  return failedPackages.length === 0;
}

export async function main(): Promise<boolean> {
  assertTaskTestsIncluded(await readWorkspaceMembers());
  // A failure here returns rather than exits: the entry point's recording
  // teardown runs in a finally that an exit would skip.
  if (!await initializeDb()) return false;
  return await runTests([
    ...ALL_DISABLED,
    ...parseDisabledPackageList(Deno.env.get("TEST_DISABLED_PACKAGES")),
  ]);
}
