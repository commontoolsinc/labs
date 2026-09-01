/**
 * The workspace's unit tests, which is where almost all of the
 * repository's identities live.
 *
 * A member whose test task is a single `deno test` is enumerated one
 * file at a time, so a lane can be asked for a few files out of a
 * package holding hundreds. A member whose task is something else — a
 * runner script, two commands joined by `&&`, its own import map — is one
 * unit that runs whole, which is what every member is today.
 *
 * `packages/runner` is a suite of its own rather than one more member.
 * Nothing about how it runs differs; what differs is what its
 * measurements mean. In the reference build the workspace members
 * recorded about one and a half seconds of measured tests for every
 * second of test step, and the runner package about seven tenths, so one
 * fitted correction cannot describe both.
 */

import * as path from "@std/path";
import { parse as parseJsonc } from "@std/jsonc";
import {
  preloadArgument,
  SKIP_LIST_VARIABLE,
} from "@commonfabric/test-support/records";
import { memberTasks, memberTestFiles } from "./deno-task.ts";
import {
  claimsIdentity,
  type CommandContext,
  type Invocation,
  type LocatableRecord,
  type Location,
  type RecordSurface,
  skipListOf,
  type Suite,
  type UnitRequest,
  writeSkipList,
} from "./suite.ts";
import type { CapabilityId } from "../ci-capabilities.ts";

/** The member the runner suite owns; every other member is the other one. */
const RUNNER_MEMBER = "./packages/runner";

/** How a browser half is named as a unit, so it cannot be read as a file. */
const BROWSER_SUFFIX = "#browser-test";

/** What one member contributes to a unit suite. */
interface Member {
  /** As the workspace lists it, leading `./` included. */
  memberPath: string;

  /** The record scope its tests carry. */
  scope: string;

  /** Repository-relative test files, when the member is read one at a time. */
  files: string[];

  /** The task's flags and environment, when its files are selectable. */
  run?: { flags: string[]; env: Record<string, string> };

  /** The task that runs the Deno-only half, for a member that runs whole. */
  denoTestTask: string;

  /** Whether the member also names a browser half. */
  browserTest: boolean;
}

/** The record scope of a member: its path with `packages/` taken off. */
export function memberScope(memberPath: string): string {
  return memberPath.replace(/^\.\//, "").replace(/^packages\//, "");
}

/** The members the workspace declares. */
async function workspaceMembers(root: string): Promise<string[]> {
  const manifest = parseJsonc(
    await Deno.readTextFile(path.join(root, "deno.jsonc")),
  ) as { workspace: string[] };
  return manifest.workspace;
}

/** Reads one member, or nothing where the member has no tests. */
async function readMember(
  root: string,
  memberPath: string,
): Promise<Member | undefined> {
  const memberDir = path.resolve(root, memberPath);
  const tasks = await memberTasks(memberDir);
  if (!tasks.present) return undefined;
  const member: Member = {
    memberPath,
    scope: memberScope(memberPath),
    files: [],
    denoTestTask: tasks.denoTestTask ?? "test",
    browserTest: tasks.browserTest,
  };
  if (tasks.denoTest === undefined) return member;
  // Normalized against the repository root, because a member's task may
  // name a file outside its own directory and a unit is a path anyone
  // else can resolve.
  member.files = (await memberTestFiles(memberDir, tasks.denoTest))
    .map((file) => path.relative(root, path.resolve(memberDir, file)));
  member.run = { flags: tasks.denoTest.flags, env: tasks.denoTest.env };
  return member;
}

/** A member's own unit, which is the whole of it. */
function wholeUnit(member: Member): string {
  return member.memberPath.replace(/^\.\//, "");
}

/**
 * Builds a suite over a set of members. The two unit suites differ only
 * in which members they hold and what they are called, so they are one
 * implementation with two callers.
 */
function unitSuite(
  id: string,
  needs: readonly CapabilityId[],
  members: readonly Member[],
): Suite {
  const byUnit = new Map<string, Member>();
  const byScope = new Map<string, Member>();
  const units: string[] = [];
  for (const member of members) {
    byScope.set(member.scope, member);
    if (member.files.length > 0) {
      for (const file of member.files) {
        units.push(file);
        byUnit.set(file, member);
      }
    } else {
      units.push(wholeUnit(member));
      byUnit.set(wholeUnit(member), member);
    }
    if (member.browserTest) {
      const unit = `${wholeUnit(member)}${BROWSER_SUFFIX}`;
      units.push(unit);
      byUnit.set(unit, member);
    }
  }

  const recordSurfaces: RecordSurface[] = [];
  for (const member of members) {
    recordSurfaces.push({ kind: "unit", scope: member.scope });
    recordSurfaces.push({ kind: "browser", scope: member.scope });
  }

  return {
    id,
    recordSurfaces,
    needs,
    units,
    unavailable: [],

    locate(record: LocatableRecord): Location | undefined {
      if (!claimsIdentity({ recordSurfaces }, record.test)) return undefined;
      const member = byScope.get(record.test.s);
      if (member === undefined) return undefined;
      // The browser half records under its own kind, and it is one unit
      // whether or not the Deno-only half is read a file at a time.
      if (record.test.k === "browser" && member.browserTest) {
        return { level: "unit", unit: `${wholeUnit(member)}${BROWSER_SUFFIX}` };
      }
      if (member.files.length === 0) {
        return { level: "unit", unit: wholeUnit(member) };
      }
      // A file the store carries but the tree no longer holds is a test
      // that moved. It is not this suite's to place, and the identity is
      // unknown, which is what makes it run.
      if (record.file !== undefined && byUnit.has(record.file)) {
        return { level: "unit", unit: record.file };
      }
      return undefined;
    },

    async command(
      requests: readonly UnitRequest[],
      context: CommandContext,
    ): Promise<Invocation[]> {
      const byMember = new Map<Member, UnitRequest[]>();
      for (const request of requests) {
        const member = byUnit.get(request.unit);
        if (member === undefined) continue;
        const group = byMember.get(member);
        if (group === undefined) byMember.set(member, [request]);
        else group.push(request);
      }
      const invocations: Invocation[] = [];
      for (const [member, group] of byMember) {
        const memberDir = path.resolve(context.root, member.memberPath);
        const slug = member.scope.replaceAll("/", "__");
        const env: Record<string, string> = { ENV: "test", ...member.run?.env };
        if (context.coverageDir !== undefined) {
          env.DENO_COVERAGE_DIR = path.join(context.coverageDir, slug);
        }
        const whole = wholeUnit(member);
        const files: UnitRequest[] = [];
        let runsWhole = false;
        let runsBrowser = false;
        for (const request of group) {
          if (request.unit === whole) runsWhole = true;
          else if (request.unit === `${whole}${BROWSER_SUFFIX}`) {
            runsBrowser = true;
          } else files.push(request);
        }
        if (runsWhole) {
          // A member whose task cannot be handed a subset runs the task,
          // which is what every member does today. The skip list still
          // reaches inside it, through the environment the task inherits.
          invocations.push({
            command: [Deno.execPath(), "task", member.denoTestTask],
            cwd: memberDir,
            env: {
              ...env,
              ...await skipEnv(context, slug, group),
            },
          });
        }
        if (files.length > 0 && member.run !== undefined) {
          const junitPath = path.join(context.outputDir, `${slug}.xml`);
          invocations.push({
            command: [
              Deno.execPath(),
              "test",
              ...member.run.flags,
              preloadArgument(),
              `--junit-path=${junitPath}`,
              ...files.map((request) =>
                path.relative(
                  memberDir,
                  path.resolve(context.root, request.unit),
                )
              ),
            ],
            cwd: memberDir,
            env: { ...env, ...await skipEnv(context, slug, files) },
            junit: [{
              path: junitPath,
              kind: "unit",
              scope: member.scope,
              filePrefix: member.memberPath.replace(/^\.\//, ""),
            }],
          });
        }
        if (runsBrowser) {
          invocations.push({
            command: [Deno.execPath(), "task", "browser-test"],
            cwd: memberDir,
            env,
          });
        }
      }
      return invocations;
    },
  };
}

/**
 * Writes a batch's skip list and names it in the environment, or leaves
 * the environment alone where nothing is skipped.
 */
async function skipEnv(
  context: CommandContext,
  slug: string,
  requests: readonly UnitRequest[],
): Promise<Record<string, string>> {
  const skips = skipListOf(requests);
  if (Object.keys(skips).length === 0) return {};
  const skipListPath = path.join(context.outputDir, `${slug}.skip.json`);
  await writeSkipList(skipListPath, skips);
  return { [SKIP_LIST_VARIABLE]: skipListPath };
}

/** The two unit suites, read from the working tree. */
export async function loadUnitSuites(root: string): Promise<Suite[]> {
  const members: Member[] = [];
  let runner: Member | undefined;
  for (const memberPath of await workspaceMembers(root)) {
    const member = await readMember(root, memberPath);
    if (member === undefined) continue;
    if (memberPath === RUNNER_MEMBER) runner = member;
    else members.push(member);
  }
  const suites = [
    unitSuite("workspace-unit", ["deno", "fuse", "browser"], members),
  ];
  if (runner !== undefined) {
    suites.push(unitSuite("runner-unit", ["deno"], [runner]));
  }
  return suites;
}
