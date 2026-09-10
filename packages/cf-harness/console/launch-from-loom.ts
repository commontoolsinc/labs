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

import { startConsoleServer } from "./server.ts";

/** The port Weaver's harness-console setting and loom's proxy both address. */
export const WEAVER_PAIRING_PORT = 8135;

/** The Docker runtime whose registration sites the CFC sidecar transports. */
const RUNSC_CFC_RUNTIME = "runsc-cfc";

/**
 * The prefix Docker Desktop's macOS VM writes in front of a host path in its
 * daemon configuration. The runtime registration records the path as the VM
 * addresses it; the harness writes the same directories from the host.
 */
const DOCKER_DESKTOP_HOST_PREFIX = "/host_mnt";

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
   * The Docker daemon configuration registering the sandbox runtime, when one
   * exists on this host.
   */
  dockerDaemonJson?: string;
  /** The absolute path `dockerDaemonJson` was read from, for error text. */
  dockerDaemonJsonPath: string;
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
 * The host path a `runsc-cfc` runtime argument names. Docker Desktop's macOS
 * VM records `/host_mnt/Users/…` for the host's `/Users/…`; a host that
 * registers the runtime directly records the host path already.
 */
const hostPathFromDockerRuntimeArgument = (value: string): string =>
  value.startsWith(`${DOCKER_DESKTOP_HOST_PREFIX}/`)
    ? value.slice(DOCKER_DESKTOP_HOST_PREFIX.length)
    : value;

const runtimeArgumentValue = (
  args: readonly unknown[],
  name: string,
): string | undefined => {
  const prefix = `--${name}=`;
  for (const entry of args) {
    if (typeof entry === "string" && entry.startsWith(prefix)) {
      return nonEmpty(entry.slice(prefix.length));
    }
  }
  return undefined;
};

/**
 * The two sidecar directories the registered `runsc-cfc` runtime writes and
 * reads, as host paths, or `undefined` when this host registers no such
 * runtime or the registration names neither directory.
 */
export const runscCfcSidecarDirectories = (
  dockerDaemonJson: string | undefined,
  dockerDaemonJsonPath: string,
): { resultDir?: string; invocationContextDir?: string } => {
  if (dockerDaemonJson === undefined) {
    return {};
  }
  const daemon = parseJsonRecord(dockerDaemonJson, dockerDaemonJsonPath);
  const runtime = objectField(
    objectField(daemon, "runtimes"),
    RUNSC_CFC_RUNTIME,
  );
  const args = Array.isArray(runtime.runtimeArgs) ? runtime.runtimeArgs : [];
  const resultDir = runtimeArgumentValue(args, "cfc-result-dir");
  const invocationContextDir = runtimeArgumentValue(
    args,
    "cfc-invocation-context-dir",
  );
  return {
    ...(resultDir !== undefined
      ? { resultDir: hostPathFromDockerRuntimeArgument(resultDir) }
      : {}),
    ...(invocationContextDir !== undefined
      ? {
        invocationContextDir: hostPathFromDockerRuntimeArgument(
          invocationContextDir,
        ),
      }
      : {}),
  };
};

/**
 * The plain path a `MEMORY_DIR` value names. `loom toolshed-store-dir` prints
 * a `file://` URL because that is what the toolshed takes; the console's own
 * store reader takes either, and the printout is for a person.
 */
const storeDirectoryDisplayPath = (memoryDir: string): string => {
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

  const sidecars = runscCfcSidecarDirectories(
    records.dockerDaemonJson,
    records.dockerDaemonJsonPath,
  );
  const cfcResultDir = options.cfcResultDir ?? sidecars.resultDir;
  if (cfcResultDir === undefined) {
    throw new Error(
      `no \`${RUNSC_CFC_RUNTIME}\` runtime in ` +
        `\`${records.dockerDaemonJsonPath}\` names ` +
        `\`--cfc-result-dir\`; set \`--cfc-result-dir\` to the directory ` +
        `the runtime writes its result sidecars to`,
    );
  }
  const cfcInvocationContextDir = options.cfcInvocationContextDir ??
    sidecars.invocationContextDir;
  if (cfcInvocationContextDir === undefined) {
    throw new Error(
      `no \`${RUNSC_CFC_RUNTIME}\` runtime in ` +
        `\`${records.dockerDaemonJsonPath}\` names ` +
        `\`--cfc-invocation-context-dir\`; set ` +
        `\`--cfc-invocation-context-dir\` to the directory the runtime reads ` +
        `invocation contexts from`,
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
      value: storeDirectoryDisplayPath(memoryDir),
      source: `\`loom toolshed-store-dir ${instance}\``,
    },
    {
      name: "cfc results",
      value: cfcResultDir,
      source: options.cfcResultDir === undefined
        ? `\`${RUNSC_CFC_RUNTIME}\` in \`${records.dockerDaemonJsonPath}\``
        : named,
    },
    {
      name: "cfc contexts",
      value: cfcInvocationContextDir,
      source: options.cfcInvocationContextDir === undefined
        ? `\`${RUNSC_CFC_RUNTIME}\` in \`${records.dockerDaemonJsonPath}\``
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
    MEMORY_DIR: memoryDir,
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

/**
 * Where Docker keeps the daemon configuration that registers a runtime. Docker
 * Desktop writes the per-user file; a host running the engine directly keeps
 * `/etc/docker/daemon.json`, which `--docker-daemon-json` names.
 */
const dockerConfigDirectory = (
  env: Record<string, string | undefined>,
): string => {
  const configured = nonEmpty(env.DOCKER_CONFIG);
  if (configured !== undefined) {
    return configured;
  }
  const home = nonEmpty(env.HOME);
  if (home === undefined) {
    throw new Error(
      "neither `DOCKER_CONFIG` nor `HOME` is set, so Docker's daemon " +
        "configuration cannot be located; set `--docker-daemon-json`",
    );
  }
  return join(home, ".docker");
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
      "docker-daemon-json",
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
  const dockerDaemonJsonPath = flag("docker-daemon-json") ??
    join(dockerConfigDirectory(env), "daemon.json");
  const dockerDaemonJson = await readOptionalFile(dockerDaemonJsonPath);

  const plan = resolveLoomLaunchPlan({
    piecesJson,
    piecesJsonPath,
    toolshedStoreDir: await readToolshedStoreDir(loomBinary, instance),
    ...(dockerDaemonJson !== undefined ? { dockerDaemonJson } : {}),
    dockerDaemonJsonPath,
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

  for (const variable of PROXY_VARIABLES) {
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
