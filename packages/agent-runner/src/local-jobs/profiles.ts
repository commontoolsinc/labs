/**
 * Host-approved profiles for local jobs: the authority a job runs with,
 * chosen by name. A profile says which tools a job may use, which host
 * configurations back them, how many model turns it gets, and the
 * prompt-slot role its task binds as, whether a job may bring a browser
 * host, and the fabric session, pattern index and subagent profiles its
 * tools run against. The host writes the file; a caller names a profile and
 * may only narrow it — fewer tools, fewer turns, no browser — never widen
 * it, and never set its role or its fabric.
 *
 * A profile is refused when it is read if it grants a tool nothing in it
 * backs, the same contradiction `cf-harness` refuses a run for, so a bad
 * grant stops the runner's start rather than failing every job.
 */

import { isAbsolute } from "@std/path";

import { parseCfHarnessCliToolId } from "@commonfabric/cf-harness/cli";
import type { PromptSlotRole } from "@commonfabric/cf-harness/contracts/prompt-slot";
import {
  BROWSER_SUBAGENT_PROFILE,
  HARNESS_SUBAGENT_PROFILES,
  type HarnessSubagentProfile,
  PATTERN_AUTHOR_SUBAGENT_PROFILE,
} from "@commonfabric/cf-harness/contracts/subagent";
import {
  type BuiltinToolId,
  type HarnessToolBackingAvailability,
  withheldToolIds,
} from "@commonfabric/cf-harness/contracts/tool-descriptor";
import { checkInputCellSpec } from "@commonfabric/cf-harness/input-cells";
import { isDID } from "@commonfabric/identity/did";
import type { MemorySpace } from "@commonfabric/runner";
import { isObjectNotArray } from "@commonfabric/utils/types";

/** One profile, as the host file states it. */
export interface LocalJobProfile {
  /** The tools a job may use; `submit_result` is always added. */
  tools: string[];

  /** The most model turns a job may take. */
  maxModelTurns: number;

  /** The prompt-slot role a job's task binds as. */
  taskRole: PromptSlotRole;

  /**
   * What happens to a job a stop or a crash cut off. `never`: it ends
   * `interrupted` and is not run again.
   */
  retry: "never";

  /** The host file backing the read-only Loom tools, when a tool needs it. */
  loomRetrievalConfig?: string;

  /** The host file naming the command broker, when a tool needs it. */
  loomCommandsConfig?: string;

  /** Model name passed to `cf-harness`. */
  model?: string;

  /**
   * Whether a job may declare a browser host. A job that does browses
   * through it: the lane adds `delegate_task` and the `browser` subagent
   * profile to that job alone, so a job without a host never gains them.
   * The console's operator flag, `--allow-browser-host`, is the same grant.
   */
  browserHost?: boolean;

  /**
   * The fabric session a job's fabric tools (`run_pattern` and its kin) run
   * against: the toolshed, the space, and the key of the identity the job
   * reads and writes as. Its read ceiling is the host's, resolved per job.
   */
  fabric?: LocalJobFabric;

  /**
   * The pattern index `search_patterns`, `record_feedback` and a
   * `pattern-author` child search; signed with the fabric identity, so it
   * needs `fabric`.
   */
  patternIndexUrl?: string;

  /**
   * Whether a job contributes what it authors to the pattern index. Present
   * exactly when `patternIndexUrl` is, `true` unless the file says `false`,
   * as the harness defaults.
   */
  patternIndexPublish?: boolean;

  /**
   * The subagent profiles `delegate_task` may spawn, which the profile's
   * `tools` must then name. `browser` is not among them: a job gains it only
   * by declaring a browser host (`browserHost`).
   */
  subagentProfiles?: HarnessSubagentProfile[];
}

/** A profile's fabric session, as the host file states it. */
export interface LocalJobFabric {
  /** The origin of the toolshed serving the space. */
  host: string;

  /** The space the session opens. */
  space: string;

  /** The absolute path of the PKCS#8 key the job reads and writes as. */
  identityKeyPath: string;
}

/** The profiles a host file names, by name. */
export type LocalJobProfiles = ReadonlyMap<string, LocalJobProfile>;

/** What a caller may ask of a profile. */
export interface LocalJobNarrowing {
  tools?: readonly string[];
  maxModelTurns?: number;

  /** The request's browser host declaration, when it made one. */
  browserHost?: unknown;

  /** The pieces the request hands the job, by name. */
  inputs?: Readonly<Record<string, string>>;
}

const ROLES: readonly PromptSlotRole[] = ["direct-command", "context", "quote"];

/** The tool that spawns a subagent. */
const DELEGATE_TOOL: BuiltinToolId = "delegate_task";

/**
 * The tools a profile's fabric session and pattern index back, read off the
 * harness's own backing table: what it withholds without the one, every
 * other backing granted.
 */
const toolsBackedBy = (
  missing: "fabricSessionAvailable" | "patternIndexAvailable",
): ReadonlySet<BuiltinToolId> => {
  const all: HarnessToolBackingAvailability = {
    fabricSessionAvailable: true,
    patternIndexAvailable: true,
    skillsShSearchAvailable: true,
    skillsShAcquisitionAvailable: true,
    skillRegistryAvailable: true,
    acquiredSkillsAvailable: true,
    docsCorpusAvailable: true,
    loomAuthoringAvailable: true,
    loomRetrievalAvailable: true,
    loomCommandsAvailable: true,
    structuredResultAvailable: true,
    clientActionsAvailable: true,
  };
  return withheldToolIds({ ...all, [missing]: false });
};
const FABRIC_TOOLS = toolsBackedBy("fabricSessionAvailable");
const PATTERN_INDEX_TOOLS = toolsBackedBy("patternIndexAvailable");

/** Helper for reading, which says whether `value` is an absolute URL. */
const isUrl = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
};

/** Helper for reading, which checks one profile and returns it. */
const profileOf = (name: string, value: unknown): LocalJobProfile => {
  const fail = (what: string): never => {
    throw new Error(`Local job profile \`${name}\`: ${what}.`);
  };
  if (!isObjectNotArray(value)) fail("it is not an object");
  const record = value as Record<string, unknown>;
  const {
    tools,
    maxModelTurns,
    taskRole,
    retry,
    loomRetrievalConfig,
    loomCommandsConfig,
    model,
    browserHost,
    fabric,
    patternIndexUrl,
    patternIndexPublish,
    subagentProfiles,
  } = record;
  if (
    !Array.isArray(tools) || !tools.every((tool) => typeof tool === "string")
  ) {
    fail("`tools` must be a list of tool names");
  }
  for (const tool of tools as string[]) {
    if (parseCfHarnessCliToolId(tool) === undefined) {
      fail(`\`tools\` names an unknown CLI tool: ${tool}`);
    }
  }
  if (
    typeof maxModelTurns !== "number" || !Number.isInteger(maxModelTurns) ||
    maxModelTurns < 1
  ) {
    fail("`maxModelTurns` must be a whole number of 1 or more");
  }
  if (!ROLES.includes(taskRole as PromptSlotRole)) {
    fail(`\`taskRole\` must be one of ${ROLES.join(", ")}`);
  }
  if (retry !== "never") fail("`retry` must be `never`");
  for (
    const [key, path] of [
      ["loomRetrievalConfig", loomRetrievalConfig],
      ["loomCommandsConfig", loomCommandsConfig],
    ] as const
  ) {
    if (
      path !== undefined && (typeof path !== "string" || !isAbsolute(path))
    ) {
      fail(`\`${key}\` must be an absolute path`);
    }
  }
  if (model !== undefined && typeof model !== "string") {
    fail("`model` must be a string");
  }
  if (browserHost !== undefined && typeof browserHost !== "boolean") {
    fail("`browserHost` must be true or false");
  }
  const session = fabric === undefined ? undefined : fabricOf(fabric, fail);
  if (patternIndexUrl !== undefined && !isUrl(patternIndexUrl)) {
    fail("`patternIndexUrl` must be a URL");
  }
  if (
    patternIndexPublish !== undefined &&
    typeof patternIndexPublish !== "boolean"
  ) {
    fail("`patternIndexPublish` must be true or false");
  }
  if (patternIndexPublish !== undefined && patternIndexUrl === undefined) {
    fail("`patternIndexPublish` needs `patternIndexUrl`");
  }
  if (patternIndexUrl !== undefined && session === undefined) {
    fail("`patternIndexUrl` needs `fabric`: the index signs as its identity");
  }
  if (
    subagentProfiles !== undefined &&
    (!Array.isArray(subagentProfiles) ||
      !subagentProfiles.every((profile) =>
        (HARNESS_SUBAGENT_PROFILES as readonly unknown[]).includes(profile)
      ))
  ) {
    fail(
      `\`subagentProfiles\` must be a list of ${
        HARNESS_SUBAGENT_PROFILES.join(", ")
      }`,
    );
  }
  const children = [
    ...new Set((subagentProfiles ?? []) as HarnessSubagentProfile[]),
  ];
  if (children.includes(BROWSER_SUBAGENT_PROFILE)) {
    fail(
      "`subagentProfiles` may not name `browser`; `browserHost` grants it to a job that declares a host",
    );
  }
  const granted = (tools as string[]).map((tool) =>
    parseCfHarnessCliToolId(tool)!
  );
  if (children.length > 0 && !granted.includes(DELEGATE_TOOL)) {
    fail("`subagentProfiles` needs `delegate_task` in `tools`");
  }
  if (
    children.includes(PATTERN_AUTHOR_SUBAGENT_PROFILE) &&
    (session === undefined || patternIndexUrl === undefined)
  ) {
    fail(
      "`subagentProfiles` names `pattern-author`, which needs `fabric` and `patternIndexUrl`",
    );
  }
  for (const [index, tool] of granted.entries()) {
    const named = (tools as string[])[index];
    if (FABRIC_TOOLS.has(tool) && session === undefined) {
      fail(`\`tools\` names \`${named}\`, which needs \`fabric\``);
    }
    if (PATTERN_INDEX_TOOLS.has(tool) && patternIndexUrl === undefined) {
      fail(`\`tools\` names \`${named}\`, which needs \`patternIndexUrl\``);
    }
  }
  return {
    tools: [...(tools as string[])],
    maxModelTurns: maxModelTurns as number,
    taskRole: taskRole as PromptSlotRole,
    retry: "never",
    ...(loomRetrievalConfig !== undefined
      ? { loomRetrievalConfig: loomRetrievalConfig as string }
      : {}),
    ...(loomCommandsConfig !== undefined
      ? { loomCommandsConfig: loomCommandsConfig as string }
      : {}),
    ...(model !== undefined ? { model: model as string } : {}),
    ...(browserHost === true ? { browserHost: true } : {}),
    ...(session !== undefined ? { fabric: session } : {}),
    ...(patternIndexUrl !== undefined
      ? {
        patternIndexUrl: patternIndexUrl as string,
        patternIndexPublish: patternIndexPublish !== false,
      }
      : {}),
    ...(children.length > 0 ? { subagentProfiles: children } : {}),
  };
};

/** Helper for reading, which checks a profile's fabric session. */
const fabricOf = (
  value: unknown,
  fail: (what: string) => never,
): LocalJobFabric => {
  if (!isObjectNotArray(value)) fail("`fabric` must be an object");
  const { host, space, identityKeyPath } = value as Record<string, unknown>;
  if (!isUrl(host)) fail("`fabric.host` must be a URL");
  if (typeof space !== "string" || space === "") {
    fail("`fabric.space` must name a space");
  }
  if (typeof identityKeyPath !== "string" || !isAbsolute(identityKeyPath)) {
    fail("`fabric.identityKeyPath` must be an absolute path");
  }
  return {
    host: host as string,
    space: space as string,
    identityKeyPath: identityKeyPath as string,
  };
};

/**
 * Reads the host's profile file: a JSON object naming each profile.
 *
 * @throws Error naming the profile and field the file gets wrong.
 */
export const readLocalJobProfiles = async (
  path: string,
  readTextFile: (path: string) => Promise<string> = Deno.readTextFile,
): Promise<LocalJobProfiles> => {
  if (!isAbsolute(path)) {
    throw new Error("The local job profile file path must be absolute.");
  }
  const value: unknown = JSON.parse(await readTextFile(path));
  if (!isObjectNotArray(value)) {
    throw new Error("The local job profile file must hold a JSON object.");
  }
  return new Map(
    Object.entries(value as Record<string, unknown>).map((
      [name, profile],
    ) => [name, profileOf(name, profile)]),
  );
};

/**
 * Why `profile` cannot hold `inputs`, or `undefined` when it can: each one is
 * held to the rule the harness mints an input cell under, against the
 * profile's own space, so a piece in any other space is refused here rather
 * than when the job starts. A space the profile names by name rather than by
 * DID is compared as a name, as the harness compares it.
 */
const refuseInputs = (
  profile: LocalJobProfile,
  inputs: Readonly<Record<string, string>> | undefined,
): string | undefined => {
  if (inputs === undefined || Object.keys(inputs).length === 0) {
    return undefined;
  }
  const { fabric } = profile;
  if (fabric === undefined) {
    return "The profile has no fabric session, so it can hold no inputs.";
  }
  const byDid = isDID(fabric.space);
  for (const [name, ref] of Object.entries(inputs)) {
    try {
      checkInputCellSpec(
        { name, ref },
        byDid ? fabric.space as MemorySpace : undefined,
        byDid ? undefined : fabric.space,
      );
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
  return undefined;
};

/**
 * The profile a caller's request runs under: `profile` narrowed to the tools
 * and turns the caller asked for, and to a browser host only when the
 * request declared one, or the reason the request asks for more than the
 * profile allows.
 */
export const narrowLocalJobProfile = (
  profile: LocalJobProfile,
  narrowing: LocalJobNarrowing,
): { profile: LocalJobProfile } | { refusal: string } => {
  const { tools, maxModelTurns, browserHost } = narrowing;
  const beyond = tools?.filter((tool) => !profile.tools.includes(tool)) ?? [];
  if (beyond.length > 0) {
    return {
      refusal: `The profile does not allow ${
        beyond.map((tool) => `\`${tool}\``).join(", ")
      }.`,
    };
  }
  if (maxModelTurns !== undefined && maxModelTurns > profile.maxModelTurns) {
    return {
      refusal:
        `The profile allows at most ${profile.maxModelTurns} model turns.`,
    };
  }
  if (browserHost !== undefined && profile.browserHost !== true) {
    return { refusal: "The profile does not admit a browser host." };
  }
  const inputRefusal = refuseInputs(profile, narrowing.inputs);
  if (inputRefusal !== undefined) return { refusal: inputRefusal };
  const { browserHost: _admitted, subagentProfiles, ...rest } = profile;
  // Narrowed away from `delegate_task`, a job has nothing to spawn its
  // subagents with, and so is granted none.
  const delegates = (tools ?? profile.tools).some((tool) =>
    parseCfHarnessCliToolId(tool) === DELEGATE_TOOL
  );
  return {
    profile: {
      ...rest,
      ...(subagentProfiles !== undefined && delegates
        ? { subagentProfiles }
        : {}),
      ...(tools !== undefined ? { tools: [...tools] } : {}),
      ...(maxModelTurns !== undefined ? { maxModelTurns } : {}),
      ...(browserHost !== undefined ? { browserHost: true } : {}),
    },
  };
};
