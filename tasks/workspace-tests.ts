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
  RECORDS_DIR_VARIABLE,
  recordsDir,
  spoolWriteArgument,
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
  recording: readonly string[] = [],
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
    // recording arguments travel with the JUnit path because they reach
    // the leaf the same way and the report is what the preload's map is
    // joined onto; a member whose task cannot take one cannot take the
    // other.
    const args = ["task", "test"];
    if (junitPath !== undefined) {
      args.push(`--junit-path=${junitPath}`, ...recording);
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
        fileByName: await readNameMaps(spoolDir, { ranIn: prefix }),
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
    workspace?: string[];
  };
  // A manifest that declares no workspace is a member's own rather than
  // the root's, and answering with nothing would read downstream as a
  // repository holding no packages at all.
  if (!Array.isArray(manifest.workspace)) {
    throw new Error(`${configPath} declares no workspace`);
  }
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
// after its tests, and `patterns` runs two test commands, so the flag
// would reach only the last one. A member that names its halves as
// separate tasks has no `test` command at all, and takes neither flag for
// the same reason a dependencies-only task does not.
//
// A task that runs a script cannot show what the script does with the
// flags it is handed. The members listed here route through a runner that
// forwards them to one `deno test`. The runners that do not appear here
// keep their leaves out: `cli` runs three `deno test` invocations per
// slice, which would each overwrite the file, and `dashboard` and
// `identity` drive browser harnesses that record through the
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

/**
 * The spool this run records into, absolute, or undefined where there is
 * none or Deno cannot be told about the one there is.
 *
 * Resolving here is what makes one directory of three: the runner reads
 * the spool with the workspace as its working directory, each leaf runs
 * with its own package as one, and the write granted to a leaf names a
 * path. A comma separates one path from the next inside `--allow-write=`,
 * and Deno offers no way to write one that belongs to a path, so a spool
 * holding a comma is granted as two paths that are not it; such a run
 * records nothing and says so, as every other recording problem does.
 */
export function recordingSpool(
  raw: string | undefined,
  workspaceCwd: string,
  warn: (message: string) => void = console.warn,
): string | undefined {
  if (raw === undefined) return undefined;
  const spool = path.resolve(workspaceCwd, raw);
  if (!spool.includes(",")) return spool;
  warn(`test records: no recording, the spool holds a comma: ${spool}`);
  return undefined;
}

/**
 * The flags the leaf `deno test` of a member's task runs under. A
 * forwarding runner's task line holds two lists: the runner process's
 * own flags, and after `--` the ones it hands its leaf. The leaf is what
 * loads the preload, so the leaf's list is the one that decides what
 * permission the preload has. Every other member runs its leaf directly,
 * and the whole line is that leaf's.
 */
export function leafFlags(member: string, task: string): string[] {
  const tokens = task.split(/\s+/);
  if (!FLAG_FORWARDING_RUNNERS.has(member)) return tokens;
  const forwarded = tokens.indexOf("--");
  return forwarded === -1 ? tokens : tokens.slice(forwarded + 1);
}

/**
 * What each member's leaf takes to record, beyond the JUnit path: the
 * preload, and the write permission it needs to leave its name map in
 * the spool. A member whose task cannot take the preload takes neither,
 * and appears with no arguments at all.
 */
export async function memberRecordingArguments(
  members: readonly string[],
  spool: string,
  root: string | URL = Deno.cwd(),
): Promise<Map<string, string[]>> {
  const recording = new Map<string, string[]>();
  for (const member of members) {
    const task = await memberTestTask(member, root);
    if (!acceptsPreload(member, task)) {
      recording.set(member, []);
      continue;
    }
    const write = spoolWriteArgument(leafFlags(member, task ?? ""), spool);
    recording.set(
      member,
      write === undefined ? [preloadArgument()] : [preloadArgument(), write],
    );
  }
  return recording;
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

// The members to run: every one the caller did not disable.
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
 * Runs the enabled members of the workspace at `workspaceCwd`, and returns
 * whether every one of them passed.
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
  // No member's test task is spawned until every member has been checked:
  // one with no `test` task of its own is what turns a single run into an
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
  const spoolDir = recordingSpool(recordsDir(), workspaceCwd);
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
  const recording = junitRoot !== undefined && spoolDir !== undefined
    ? await memberRecordingArguments(memberPaths, spoolDir, workspaceUrl)
    : new Map<string, string[]>();

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
        spoolDir === undefined
          ? undefined
          : { [RECORDS_DIR_VARIABLE]: spoolDir },
        junitPath,
        recording.get(unit.memberPath),
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
  // Every unit below `nextUnit` was handed to a worker; the units above it
  // are the ones the stop after a failure left unstarted.
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
  return await runTests(ALL_DISABLED);
}
