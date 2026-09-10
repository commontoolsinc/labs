#!/usr/bin/env -S deno run -A

/**
 * The launch path for a console that shares a loom instance's fabric: read the
 * instance's own records, print what they resolved to, and serve.
 *
 *   deno task --cwd packages/cf-harness console:loom --instance loom
 *
 * The console needs six things the instance already knows — the identity key,
 * the space, the toolshed URL, the store the toolshed serves, and the two
 * `runsc-cfc` sidecar directories the sandbox's mediation moves over — and an
 * operator transcribing them by hand gets a console that starts cleanly and is
 * wrong: a store keyed to a superseded labs pin reads as "no data at cell",
 * and sidecar directories no registered runtime writes drop every input label
 * in silence. So each value is derived from the record that decides it, tagged
 * with where it came from, and printed once before the server binds. Anything
 * that cannot be derived is a named flag whose absence is an error naming it,
 * never a default nobody chose. Arguments after `--` reach the console
 * untouched, so a flag this launcher has no opinion about is still reachable
 * through it rather than through a second launch path.
 *
 * The console's own flags and routes are in [`README.md`](README.md), and the
 * operator procedure this path belongs to is in
 * [`../docs/WEAVER.md`](../docs/WEAVER.md).
 */

import { parseArgs } from "@std/cli/parse-args";
import { join } from "@std/path";

import { registeredCfcSidecarHostDirs } from "../src/sandbox/docker-runsc.ts";
import { startConsoleServer } from "./server.ts";

/** The port Weaver's harness-console setting and loom's proxy both address. */
export const WEAVER_PAIRING_PORT = 8135;

/** The Docker runtime whose registration sites the CFC sidecar transports. */
const RUNSC_CFC_RUNTIME = "runsc-cfc";

/**
 * Proxy variables reach the console as ambient environment and break it two
 * ways: loopback toolshed calls leave the machine, and the pattern index sees
 * a proxy's identity rather than the console's. The launcher removes them from
 * the environment it serves under and reports that it did.
 */
const PROXY_VARIABLES = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "http_proxy",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
] as const;

/**
 * Every variable the launcher decides. A value it resolves is set; a value it
 * resolves to nothing is removed, because the printed report is a claim about
 * what the console runs under and an inherited variable the report does not
 * mention would make that claim untrue. `CF_HARNESS_SPACE_DB` is here without
 * being set: it names a store file directly, so an inherited one would silently
 * displace the store the report attributes to loom. Pass `-- --space-db <path>`
 * to name one, where it is a decision on the command line rather than ambient.
 */
export const LAUNCHER_OWNED_VARIABLES = [
  "CF_HARNESS_CONSOLE_PORT",
  "CF_HARNESS_CONSOLE_DIR",
  "CF_HARNESS_FABRIC_API_URL",
  "CF_HARNESS_FABRIC_IDENTITY",
  "CF_HARNESS_FABRIC_SPACE",
  "CF_HARNESS_FABRIC_CFC_POSTURE",
  "CF_HARNESS_FABRIC_CFC_FLOW_LABELS",
  "CF_HARNESS_FABRIC_CFC_ENFORCEMENT_MODE",
  "CF_HARNESS_RUNSC_CFC_RESULT_DIR",
  "CF_HARNESS_RUNSC_CFC_INVOCATION_CONTEXT_DIR",
  "CF_HARNESS_PATTERN_INDEX_URL",
  "CF_HARNESS_SKILLS_REGISTRY_URL",
  "CF_HARNESS_SPACE_DB",
  "MEMORY_DIR",
] as const;

/**
 * One resolved value, with the record that decided it. `source` is what an
 * operator reads to know which file to edit when a value is wrong.
 */
export interface ResolvedValue {
  name: string;
  value: string;
  source: string;
}

/**
 * The records a loom instance keeps, read for the launcher. Every field is the
 * verbatim content of one record, so resolution itself touches no filesystem
 * and no subprocess.
 */
export interface LoomInstanceRecords {
  /** The instance's `pieces.json`. */
  piecesJson: string;
  /** The absolute path `piecesJson` was read from, for error text. */
  piecesJsonPath: string;
  /**
   * What `loom toolshed-store-dir <instance>` printed: a `file://` URL for the
   * store keyed to the labs pin loom vendors, or an empty string when loom
   * could not instance-scope it.
   */
  toolshedStoreDir: string;
  /**
   * The runtime table `docker info --format '{{json .Runtimes}}'` reported, or
   * `undefined` when it could not be read. The running daemon's table rather
   * than the configuration on disk: an edited `daemon.json` the daemon has not
   * reloaded names directories nothing writes.
   */
  dockerRuntimes?: unknown;
  /** Why `dockerRuntimes` is absent, for error text. */
  dockerRuntimesUnreadable?: string;
}

/** What an operator names themselves, over what the records decide. */
export interface LoomLaunchOptions {
  instance: string;
  port?: number;
  consoleDir?: string;
  patternIndexUrl?: string;
  skillsRegistryUrl?: string;
  noPatternIndex?: boolean;
  noSkillsRegistry?: boolean;
  cfcResultDir?: string;
  cfcInvocationContextDir?: string;
  posture?: string;
  flowLabels?: string;
  enforcementMode?: string;
}

/** The environment to serve under, and the printout that accounts for it. */
export interface LoomLaunchPlan {
  environment: Record<string, string>;
  resolved: readonly ResolvedValue[];
}

const nonEmpty = (value: string | undefined): string | undefined =>
  value === undefined || value.trim() === "" ? undefined : value.trim();

const parseJsonRecord = (
  text: string,
  path: string,
): Record<string, unknown> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `\`${path}\` is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`\`${path}\` does not hold a JSON object`);
  }
  return parsed as Record<string, unknown>;
};

const stringField = (
  record: Record<string, unknown>,
  key: string,
): string | undefined => {
  const value = record[key];
  return typeof value === "string" ? nonEmpty(value) : undefined;
};

const objectField = (
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> => {
  const value = record[key];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
};

/**
 * The plain filesystem path a store value names.
 *
 * `loom toolshed-store-dir` prints a `file://` URL, because the toolshed reads
 * `MEMORY_DIR` through `new URL()`. Inside this process nothing does: the space
 * store reader treats `MEMORY_DIR` as a directory to walk, and a `file://` URL
 * is not one — it walks nothing, falls through to its other candidate roots,
 * and reads a different store's cells as though they were this space's. So the
 * console is given the path, and the toolshed keeps the URL loom launched it
 * with.
 */
const storeDirectoryPath = (memoryDir: string): string => {
  try {
    return decodeURIComponent(new URL(memoryDir).pathname);
  } catch {
    return memoryDir;
  }
};

/**
 * Resolves the environment a console shares a loom instance's fabric under.
 *
 * Throws with the flag to set whenever a value is neither recorded by the
 * instance nor named by `options`, so an operator reads what to supply
 * rather than discovering later that a run had no labels or no data.
 */
export const resolveLoomLaunchPlan = (
  records: LoomInstanceRecords,
  options: LoomLaunchOptions,
): LoomLaunchPlan => {
  const { instance } = options;
  const pieces = parseJsonRecord(records.piecesJson, records.piecesJsonPath);
  const defaults = objectField(pieces, "defaults");

  const identity = stringField(defaults, "identity");
  if (identity === undefined) {
    throw new Error(
      `loom instance \`${instance}\` records no \`defaults.identity\` in ` +
        `\`${records.piecesJsonPath}\`; the console signs with the ` +
        `instance's key and has no other source for it`,
    );
  }
  const space = stringField(defaults, "local_space");
  if (space === undefined) {
    throw new Error(
      `loom instance \`${instance}\` records no \`defaults.local_space\` in ` +
        `\`${records.piecesJsonPath}\`; the console writes into the ` +
        `instance's space and has no other source for it`,
    );
  }
  const toolshedUrl = stringField(
    objectField(defaults, "server_urls"),
    "toolshed",
  );
  if (toolshedUrl === undefined) {
    throw new Error(
      `loom instance \`${instance}\` records no ` +
        `\`defaults.server_urls.toolshed\` in \`${records.piecesJsonPath}\`; ` +
        `the console reaches the instance's fabric at that URL`,
    );
  }
  const memoryDir = nonEmpty(records.toolshedStoreDir);
  if (memoryDir === undefined) {
    throw new Error(
      `\`loom toolshed-store-dir ${instance}\` printed no store, so loom ` +
        `could not key the instance's store to the labs commit it vendors; ` +
        `a console pointed at any other store reads the space as empty`,
    );
  }

  const sidecars = registeredCfcSidecarHostDirs({
    runtimeName: RUNSC_CFC_RUNTIME,
    runtimes: records.dockerRuntimes,
  });
  const registrationSource = records.dockerRuntimesUnreadable ??
    `no \`${RUNSC_CFC_RUNTIME}\` runtime \`docker info\` reports names it`;
  const cfcResultDir = options.cfcResultDir ?? sidecars.resultDir;
  if (cfcResultDir === undefined) {
    throw new Error(
      `no directory is registered for \`--cfc-result-dir\`: ` +
        `${registrationSource}; set \`--cfc-result-dir\` to the directory ` +
        `the runtime writes its result sidecars to`,
    );
  }
  const cfcInvocationContextDir = options.cfcInvocationContextDir ??
    sidecars.invocationContextDir;
  if (cfcInvocationContextDir === undefined) {
    throw new Error(
      `no directory is registered for ` +
        `\`--cfc-invocation-context-dir\`: ${registrationSource}; set ` +
        `\`--cfc-invocation-context-dir\` to the directory the runtime ` +
        `reads invocation contexts from`,
    );
  }

  if (
    options.patternIndexUrl !== undefined && options.noPatternIndex === true
  ) {
    throw new Error(
      "`--pattern-index-url` and `--no-pattern-index` contradict each other; " +
        "name an index or waive it, not both",
    );
  }
  if (
    options.skillsRegistryUrl !== undefined && options.noSkillsRegistry === true
  ) {
    throw new Error(
      "`--skills-registry-url` and `--no-skills-registry` contradict each " +
        "other; name a registry or waive it, not both",
    );
  }
  if (
    options.patternIndexUrl === undefined && options.noPatternIndex !== true
  ) {
    throw new Error(
      "a pattern index is a deployment's own, and loom records none: set " +
        "`--pattern-index-url`, or `--no-pattern-index` to run a console " +
        "whose sessions cannot search for published parts",
    );
  }
  if (
    options.skillsRegistryUrl === undefined &&
    options.noSkillsRegistry !== true
  ) {
    throw new Error(
      "a skills registry is a deployment's own, and loom records none: set " +
        "`--skills-registry-url`, or `--no-skills-registry` to run a console " +
        "whose sessions cannot search for skills",
    );
  }

  const port = options.port ?? WEAVER_PAIRING_PORT;
  const consoleDir = options.consoleDir ??
    `.cf-harness-console-${instance}-${port}`;
  const posture = options.posture ?? "max-enforcement";
  const flowLabels = options.flowLabels ?? "persist";
  const enforcementMode = options.enforcementMode ?? "enforce-explicit";

  const instanceSource = `\`${records.piecesJsonPath}\``;
  const launcherDefault = "launcher default";
  const named = "named on the command line";

  const resolved: ResolvedValue[] = [
    { name: "instance", value: instance, source: named },
    {
      name: "port",
      value: String(port),
      source: options.port === undefined
        ? `${launcherDefault} (the port Weaver pairs with)`
        : named,
    },
    {
      name: "console dir",
      value: consoleDir,
      source: options.consoleDir === undefined
        ? `${launcherDefault} (one directory per instance and port)`
        : named,
    },
    { name: "space", value: space, source: instanceSource },
    { name: "identity", value: identity, source: instanceSource },
    { name: "toolshed", value: toolshedUrl, source: instanceSource },
    {
      name: "store",
      value: storeDirectoryPath(memoryDir),
      source: `\`loom toolshed-store-dir ${instance}\``,
    },
    {
      name: "cfc results",
      value: cfcResultDir,
      source: options.cfcResultDir === undefined
        ? `\`${RUNSC_CFC_RUNTIME}\` as \`docker info\` reports it`
        : named,
    },
    {
      name: "cfc contexts",
      value: cfcInvocationContextDir,
      source: options.cfcInvocationContextDir === undefined
        ? `\`${RUNSC_CFC_RUNTIME}\` as \`docker info\` reports it`
        : named,
    },
    {
      name: "posture",
      value: `${posture}, flow labels ${flowLabels}, ${enforcementMode}`,
      source: options.posture === undefined &&
          options.flowLabels === undefined &&
          options.enforcementMode === undefined
        ? launcherDefault
        : named,
    },
    {
      name: "index",
      value: options.patternIndexUrl ?? "(none: --no-pattern-index)",
      source: named,
    },
    {
      name: "skills",
      value: options.skillsRegistryUrl ?? "(none: --no-skills-registry)",
      source: named,
    },
    {
      name: "proxy",
      value: "removed from the environment",
      source: "launcher",
    },
  ];

  const environment: Record<string, string> = {
    CF_HARNESS_CONSOLE_PORT: String(port),
    CF_HARNESS_CONSOLE_DIR: consoleDir,
    CF_HARNESS_FABRIC_API_URL: toolshedUrl,
    CF_HARNESS_FABRIC_IDENTITY: identity,
    CF_HARNESS_FABRIC_SPACE: space,
    CF_HARNESS_FABRIC_CFC_POSTURE: posture,
    CF_HARNESS_FABRIC_CFC_FLOW_LABELS: flowLabels,
    CF_HARNESS_FABRIC_CFC_ENFORCEMENT_MODE: enforcementMode,
    CF_HARNESS_RUNSC_CFC_RESULT_DIR: cfcResultDir,
    CF_HARNESS_RUNSC_CFC_INVOCATION_CONTEXT_DIR: cfcInvocationContextDir,
    MEMORY_DIR: storeDirectoryPath(memoryDir),
    ...(options.patternIndexUrl !== undefined
      ? { CF_HARNESS_PATTERN_INDEX_URL: options.patternIndexUrl }
      : {}),
    ...(options.skillsRegistryUrl !== undefined
      ? { CF_HARNESS_SKILLS_REGISTRY_URL: options.skillsRegistryUrl }
      : {}),
  };

  return { environment, resolved };
};

/** The lines the launcher prints before the server binds. */
export const loomLaunchReport = (
  plan: LoomLaunchPlan,
): readonly string[] => {
  const width = plan.resolved.reduce(
    (widest, entry) => Math.max(widest, entry.name.length),
    0,
  );
  return [
    "  cf-harness console, configured from loom:",
    ...plan.resolved.map((entry) =>
      `  ${entry.name.padEnd(width)}  ${entry.value}   [${entry.source}]`
    ),
  ];
};

const loomDataDirectory = (env: Record<string, string | undefined>): string => {
  const xdg = nonEmpty(env.XDG_DATA_HOME);
  if (xdg !== undefined) {
    return join(xdg, "loom");
  }
  const home = nonEmpty(env.HOME);
  if (home === undefined) {
    throw new Error(
      "neither `XDG_DATA_HOME` nor `HOME` is set, so loom's instance " +
        "directory cannot be located",
    );
  }
  return join(home, ".local", "share", "loom");
};

const readOptionalFile = async (path: string): Promise<string | undefined> => {
  try {
    return await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return undefined;
    }
    throw error;
  }
};

/**
 * Runs `loom toolshed-store-dir <instance>`, which never mutates and prints
 * the store the instance's toolshed serves. A `loom` that exits nonzero is
 * reported with its own diagnostic, since it is the one that knows why.
 */
const readToolshedStoreDir = async (
  loomBinary: string,
  instance: string,
): Promise<string> => {
  let output: Deno.CommandOutput;
  try {
    output = await new Deno.Command(loomBinary, {
      args: ["toolshed-store-dir", instance],
      stdout: "piped",
      stderr: "piped",
    }).output();
  } catch (error) {
    throw new Error(
      `could not run \`${loomBinary} toolshed-store-dir ${instance}\`: ` +
        `${error instanceof Error ? error.message : String(error)}; set ` +
        `\`--loom-bin\` to loom's executable`,
    );
  }
  if (!output.success) {
    throw new Error(
      `\`${loomBinary} toolshed-store-dir ${instance}\` failed: ` +
        new TextDecoder().decode(output.stderr).trim(),
    );
  }
  return new TextDecoder().decode(output.stdout).trim();
};

/**
 * The runtime table `docker info` reports, or the reason it could not be read.
 * The running daemon's table rather than `daemon.json`: a configuration file
 * the daemon has not reloaded names directories nothing writes.
 */
const readDockerRuntimes = async (
  dockerBinary: string,
): Promise<{ runtimes?: unknown; unreadable?: string }> => {
  let output: Deno.CommandOutput;
  try {
    output = await new Deno.Command(dockerBinary, {
      args: ["info", "--format", "{{json .Runtimes}}"],
      stdout: "piped",
      stderr: "piped",
    }).output();
  } catch (error) {
    return {
      unreadable: `\`${dockerBinary} info\` could not be run: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  if (!output.success) {
    return {
      unreadable: `\`${dockerBinary} info\` exited ${output.code}: ${
        new TextDecoder().decode(output.stderr).trim()
      }`,
    };
  }
  try {
    return { runtimes: JSON.parse(new TextDecoder().decode(output.stdout)) };
  } catch (error) {
    return {
      unreadable: `\`${dockerBinary} info\` reported a runtime table that ` +
        `does not parse: ${
          error instanceof Error ? error.message : String(error)
        }`,
    };
  }
};

const positiveInteger = (value: string, flag: string): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer: ${value}`);
  }
  return parsed;
};

/**
 * Resolves a loom instance's records into a console environment, prints what
 * they resolved to, and serves under it.
 */
export const launchConsoleFromLoom = async (
  args: readonly string[] = Deno.args,
  env: Record<string, string | undefined> = Deno.env.toObject(),
): Promise<void> => {
  const parsed = parseArgs([...args], {
    string: [
      "instance",
      "loom-bin",
      "port",
      "console-dir",
      "pattern-index-url",
      "skills-registry-url",
      "cfc-result-dir",
      "cfc-invocation-context-dir",
      "fabric-cfc-posture",
      "fabric-cfc-flow-labels",
      "fabric-cfc-enforcement-mode",
      "docker-bin",
    ],
    boolean: ["no-pattern-index", "no-skills-registry"],
    "--": true,
  });
  const flag = (name: string): string | undefined =>
    typeof parsed[name] === "string" ? nonEmpty(parsed[name]) : undefined;

  const instance = flag("instance") ?? nonEmpty(env.LOOM_INSTANCE_ID);
  if (instance === undefined) {
    throw new Error(
      "no loom instance named: set `--instance` or `LOOM_INSTANCE_ID`",
    );
  }
  const loomBinary = flag("loom-bin") ?? nonEmpty(env.LOOM_BIN) ?? "loom";
  const instanceDir = join(loomDataDirectory(env), "instances", instance);
  const piecesJsonPath = join(instanceDir, "pieces.json");
  const piecesJson = await readOptionalFile(piecesJsonPath);
  if (piecesJson === undefined) {
    throw new Error(
      `loom instance \`${instance}\` has no \`${piecesJsonPath}\`; name a ` +
        `running instance with \`--instance\``,
    );
  }
  const dockerBinary = flag("docker-bin") ?? nonEmpty(env.CF_HARNESS_DOCKER) ??
    "docker";
  const docker = await readDockerRuntimes(dockerBinary);

  const plan = resolveLoomLaunchPlan({
    piecesJson,
    piecesJsonPath,
    toolshedStoreDir: await readToolshedStoreDir(loomBinary, instance),
    ...(docker.runtimes !== undefined
      ? { dockerRuntimes: docker.runtimes }
      : {}),
    ...(docker.unreadable !== undefined
      ? { dockerRuntimesUnreadable: docker.unreadable }
      : {}),
  }, {
    instance,
    ...(flag("port") !== undefined
      ? { port: positiveInteger(flag("port")!, "--port") }
      : {}),
    ...(flag("console-dir") !== undefined
      ? { consoleDir: flag("console-dir")! }
      : {}),
    ...(flag("pattern-index-url") !== undefined
      ? { patternIndexUrl: flag("pattern-index-url")! }
      : {}),
    ...(flag("skills-registry-url") !== undefined
      ? { skillsRegistryUrl: flag("skills-registry-url")! }
      : {}),
    noPatternIndex: parsed["no-pattern-index"] === true,
    noSkillsRegistry: parsed["no-skills-registry"] === true,
    ...(flag("cfc-result-dir") !== undefined
      ? { cfcResultDir: flag("cfc-result-dir")! }
      : {}),
    ...(flag("cfc-invocation-context-dir") !== undefined
      ? { cfcInvocationContextDir: flag("cfc-invocation-context-dir")! }
      : {}),
    ...(flag("fabric-cfc-posture") !== undefined
      ? { posture: flag("fabric-cfc-posture")! }
      : {}),
    ...(flag("fabric-cfc-flow-labels") !== undefined
      ? { flowLabels: flag("fabric-cfc-flow-labels")! }
      : {}),
    ...(flag("fabric-cfc-enforcement-mode") !== undefined
      ? { enforcementMode: flag("fabric-cfc-enforcement-mode")! }
      : {}),
  });

  console.log("");
  for (const line of loomLaunchReport(plan)) {
    console.log(line);
  }

  for (const variable of [...PROXY_VARIABLES, ...LAUNCHER_OWNED_VARIABLES]) {
    Deno.env.delete(variable);
  }
  for (const [name, value] of Object.entries(plan.environment)) {
    Deno.env.set(name, value);
  }
  await startConsoleServer((parsed["--"] ?? []).map(String));
};

// Running the file serves; importing it (the tests do) serves nothing.
if (import.meta.main) {
  try {
    await launchConsoleFromLoom();
  } catch (error) {
    // A misconfigured launch is an operator's problem to fix, and the message
    // is the whole of what they need; the stack behind it is noise.
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }
}
