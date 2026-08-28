import {
  isAbsolute as isAbsoluteHostPath,
  join as joinHostPath,
} from "@std/path";
import {
  isAbsolute as isAbsoluteSandboxPath,
  join as joinSandboxPath,
  normalize,
} from "@std/path/posix";

import type {
  CfcEnforcementMode,
  CfcSandboxJsonValue,
  CfcSandboxResult,
  CfcStreamChannel,
  IFCLabel,
} from "@commonfabric/runner/cfc";
import {
  CFC_ENFORCING_STRICTNESS,
  cfcEnforcementStrictness,
} from "@commonfabric/runner/cfc";
import { isObjectNotArray } from "@commonfabric/utils/types";

import type { HarnessCfcInvocationContext } from "../contracts/cfc-invocation-context.ts";
import { SandboxPathEscapeError } from "./errors.ts";
import {
  DenoProcessRunner,
  type ProcessRunner,
  type ProcessRunResult,
} from "./process-runner.ts";
import type {
  CfcSidecarTransportKind,
  CfcTransportReadiness,
  DockerNetworkMode,
  DockerRunscAdditionalMount,
  DockerRunscAdditionalMountConfig,
  DockerRunscSandboxConfig,
  ResolveDockerRunscSandboxConfigOptions,
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxRuntime,
  SandboxRuntimeDescription,
  SandboxRuntimeMountDescription,
  SandboxShellRequest,
} from "./types.ts";

export const DEFAULT_DOCKER_RUNSC_IMAGE =
  "us-docker.pkg.dev/commontools-core/common-fabric/sandbox-kitchensink:latest";
export const DEFAULT_DOCKER_RUNTIME_NAME = "runsc-cfc";
export const DEFAULT_DOCKER_BINARY = "docker";
export const DEFAULT_WORKSPACE_MOUNT_PATH = "/workspace";
export const DEFAULT_SANDBOX_SHELL = "/bin/sh";
export const DEFAULT_DOCKER_NETWORK_MODE = "bridge" as const;
export const DEFAULT_FABRIC_MOUNT_PATH = "/fabric";
export const DOCKER_NETWORK_MODE_ENV = "CF_HARNESS_DOCKER_NETWORK_MODE";
export const CFC_RESULT_DIR_ENV = "CF_HARNESS_RUNSC_CFC_RESULT_DIR";
export const CFC_INVOCATION_CONTEXT_DIR_ENV =
  "CF_HARNESS_RUNSC_CFC_INVOCATION_CONTEXT_DIR";

interface RunscCfcLabelSidecar {
  string?: unknown;
  xattrJSON?: unknown;
}

interface RunscCfcResultSidecar {
  version?: unknown;
  containerId?: unknown;
  sandboxId?: unknown;
  waitStatus?: unknown;
  cfcTaint?: unknown;
}

const textEncoder = new TextEncoder();

const readEnvVar = (name: string): string | undefined => {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
};

const optionalNonEmptyString = (
  value: string | undefined,
): string | undefined =>
  value !== undefined && value.length > 0 ? value : undefined;

const parseDockerNetworkMode = (
  value: string | undefined,
): DockerNetworkMode | undefined => {
  if (value === undefined || value === "") {
    return undefined;
  }
  if (value === "none" || value === "bridge" || value === "host") {
    return value;
  }
  throw new Error(
    `${DOCKER_NETWORK_MODE_ENV} must be one of none, bridge, or host`,
  );
};

const validateAbsoluteHostDir = (path: string, label: string): string => {
  if (path.trim() === "") {
    throw new Error(`${label} must not be empty`);
  }
  if (!isAbsoluteHostPath(path)) {
    throw new Error(`${label} must be an absolute host path`);
  }
  return path;
};

export const resolveDefaultContainerUser = (
  hostOs: typeof Deno.build.os = Deno.build.os,
): string | undefined => {
  // Docker Desktop bind mounts are mediated by a Linux VM; the macOS uid/gid
  // does not imply write access inside the container.
  if (hostOs === "windows" || hostOs === "darwin") {
    return undefined;
  }
  const uidFromEnv = readEnvVar("UID");
  const gidFromEnv = readEnvVar("GID");
  if (uidFromEnv !== undefined && gidFromEnv !== undefined) {
    return `${uidFromEnv}:${gidFromEnv}`;
  }
  try {
    const uid = Deno.uid();
    const gid = Deno.gid();
    return `${uid}:${gid}`;
  } catch {
    try {
      const uidResult = new Deno.Command("id", {
        args: ["-u"],
        stdout: "piped",
        stderr: "null",
      }).outputSync();
      const gidResult = new Deno.Command("id", {
        args: ["-g"],
        stdout: "piped",
        stderr: "null",
      }).outputSync();
      if (uidResult.success && gidResult.success) {
        const uid = new TextDecoder().decode(uidResult.stdout).trim();
        const gid = new TextDecoder().decode(gidResult.stdout).trim();
        if (uid.length > 0 && gid.length > 0) {
          return `${uid}:${gid}`;
        }
      }
    } catch {
      return undefined;
    }
    return undefined;
  }
};

const normalizeWorkspacePath = (path: string): string => {
  const normalized = normalize(path);
  return normalized.length > 1 && normalized.endsWith("/")
    ? normalized.slice(0, -1)
    : normalized;
};

const validateSandboxRoot = (path: string, label: string): string => {
  const normalized = normalizeWorkspacePath(path);
  if (!isAbsoluteSandboxPath(normalized) || normalized === "/") {
    throw new Error(`${label} must be an absolute non-root sandbox path`);
  }
  return normalized;
};

const isWithinRoot = (root: string, path: string): boolean => {
  const normalizedRoot = normalizeWorkspacePath(root);
  const normalizedPath = normalizeWorkspacePath(path);
  return normalizedPath === normalizedRoot ||
    normalizedPath.startsWith(`${normalizedRoot}/`);
};

const rootsOverlap = (left: string, right: string): boolean =>
  isWithinRoot(left, right) || isWithinRoot(right, left);

const normalizeAdditionalMount = (
  mount: DockerRunscAdditionalMountConfig,
): DockerRunscAdditionalMount => {
  if (mount.hostPath.trim() === "") {
    throw new Error(`${mount.kind} hostPath must not be empty`);
  }
  if (mount.kind === "host-bind" && mount.name.trim() === "") {
    throw new Error("host-bind name must not be empty");
  }
  if (mount.kind === "host-bind") {
    return {
      kind: "host-bind",
      name: mount.name,
      hostPath: mount.hostPath,
      sandboxPath: validateSandboxRoot(
        mount.sandboxPath,
        "host-bind sandboxPath",
      ),
      readOnly: mount.readOnly ?? true,
    };
  }
  return {
    kind: "fabric-fuse",
    hostPath: mount.hostPath,
    sandboxPath: validateSandboxRoot(
      mount.sandboxPath ?? DEFAULT_FABRIC_MOUNT_PATH,
      "fabric-fuse sandboxPath",
    ),
    readOnly: mount.readOnly ?? false,
  };
};

const validateNonOverlappingMounts = (
  mounts: readonly { kind: string; sandboxPath: string }[],
): void => {
  for (let i = 0; i < mounts.length; i += 1) {
    for (let j = i + 1; j < mounts.length; j += 1) {
      const left = mounts[i]!;
      const right = mounts[j]!;
      if (rootsOverlap(left.sandboxPath, right.sandboxPath)) {
        throw new Error(
          `sandbox mount paths overlap: ${left.sandboxPath} (${left.kind}) and ${right.sandboxPath} (${right.kind})`,
        );
      }
    }
  }
};

const dockerMountArg = (mount: {
  hostPath: string;
  sandboxPath: string;
  readOnly: boolean;
}): string =>
  `type=bind,src=${mount.hostPath},dst=${mount.sandboxPath}${
    mount.readOnly ? ",readonly" : ""
  }`;

const resolveCfcInvocationContextDir = (
  options: ResolveDockerRunscSandboxConfigOptions,
): string | undefined => {
  const dir = optionalNonEmptyString(
    options.cfcInvocationContextDir ??
      readEnvVar(CFC_INVOCATION_CONTEXT_DIR_ENV),
  );
  return dir === undefined
    ? undefined
    : validateAbsoluteHostDir(dir, "cfcInvocationContextDir");
};

export const resolveDockerRunscSandboxConfig = (
  options: ResolveDockerRunscSandboxConfigOptions,
): DockerRunscSandboxConfig => {
  const containerUser = options.containerUser ?? resolveDefaultContainerUser();
  const workspaceMountPath = validateSandboxRoot(
    options.workspaceMountPath ?? DEFAULT_WORKSPACE_MOUNT_PATH,
    "workspaceMountPath",
  );
  const additionalMounts = (options.additionalMounts ?? []).map(
    normalizeAdditionalMount,
  );
  validateNonOverlappingMounts([
    { kind: "workspace", sandboxPath: workspaceMountPath },
    ...additionalMounts,
  ]);
  const cfcResultDir = optionalNonEmptyString(
    options.cfcResultDir ?? readEnvVar(CFC_RESULT_DIR_ENV),
  );
  const cfcInvocationContextDir = resolveCfcInvocationContextDir(options);
  return {
    dockerBinary: options.dockerBinary ?? DEFAULT_DOCKER_BINARY,
    runtimeName: options.runtimeName ?? DEFAULT_DOCKER_RUNTIME_NAME,
    image: options.image ?? DEFAULT_DOCKER_RUNSC_IMAGE,
    ...(containerUser !== undefined ? { containerUser } : {}),
    workspaceHostPath: options.workspaceHostPath,
    workspaceMountPath,
    shellPath: options.shellPath ?? DEFAULT_SANDBOX_SHELL,
    dockerNetworkMode: options.dockerNetworkMode ??
      parseDockerNetworkMode(readEnvVar(DOCKER_NETWORK_MODE_ENV)) ??
      DEFAULT_DOCKER_NETWORK_MODE,
    additionalMounts,
    extraDockerArgs: options.extraDockerArgs ?? [],
    ...(cfcResultDir !== undefined ? { cfcResultDir } : {}),
    ...(cfcInvocationContextDir !== undefined
      ? { cfcInvocationContextDir }
      : {}),
  };
};

/**
 * In `enforce-*` modes the runtime depends on two trusted sidecar transports:
 *
 *  - `cfcInvocationContextDir` — the harness writes the initial-taint
 *    invocation context the sandbox reads in. Without it the sandbox starts
 *    untainted, so input labels (prompt-slot influence, prior observed labels)
 *    are silently dropped.
 *  - `cfcResultDir` — runsc writes the final-taint result the harness reads
 *    back to mediate output. Without it every command's CFC result is absent
 *    and enforce-mode mediation fail-closes every observation.
 *
 * Both come from `CF_HARNESS_RUNSC_CFC_*` env vars or explicit config and are
 * easy to omit. A run can then claim to enforce while the dangerous half
 * (missing input taint) degrades with no operator-visible signal. The engine
 * calls this at run start (before the first tool executes) so a mis-wired
 * enforce run aborts loudly rather than emitting silent denials mid-run.
 * `disabled`/`observe` impose no such floor.
 *
 * Naming the directories is the half of the floor that can be checked without
 * a Docker daemon. Whether the runtime is registered to read them is the other
 * half, and `cfcTransportReadinessFromDockerRuntimes` below decides it.
 */
export const assertDockerRunscCfcTransportForMode = (
  mode: CfcEnforcementMode,
  config: Pick<
    DockerRunscSandboxConfig,
    "cfcResultDir" | "cfcInvocationContextDir"
  >,
): void => {
  // `disabled` and `observe` do not mediate or deny tool output, so a missing
  // transport cannot silently weaken them; only the enforcing floor requires it.
  if (cfcEnforcementStrictness(mode) < CFC_ENFORCING_STRICTNESS) {
    return;
  }
  const missing: string[] = [];
  if (config.cfcInvocationContextDir === undefined) {
    missing.push(
      `CFC invocation-context transport (set --cfc-invocation-context-dir or ${CFC_INVOCATION_CONTEXT_DIR_ENV})`,
    );
  }
  if (config.cfcResultDir === undefined) {
    missing.push(
      `CFC result transport (set --cfc-result-dir or ${CFC_RESULT_DIR_ENV})`,
    );
  }
  if (missing.length > 0) {
    throw new Error(
      `cfc enforcement mode '${mode}' requires the runsc sandbox to wire ${
        missing.join(" and ")
      }; refusing to start a run that would silently degrade enforcement`,
    );
  }
};

export const CFC_INVOCATION_CONTEXT_DIR_RUNTIME_FLAG =
  "cfc-invocation-context-dir";
export const CFC_RESULT_DIR_RUNTIME_FLAG = "cfc-result-dir";

/**
 * Docker Desktop runs the daemon inside a Linux VM and projects host paths
 * into it under this prefix, so a runtime argument and the host path
 * `cf-harness` writes to name the same directory while differing textually.
 */
const DOCKER_DESKTOP_HOST_MOUNT_PREFIX = "/host_mnt";

const stripTrailingSlashes = (path: string): string => {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.length === 0 ? "/" : trimmed;
};

const hostDirsCorrespond = (
  runtimeArgValue: string,
  harnessDir: string,
): boolean => {
  const runtimePath = stripTrailingSlashes(runtimeArgValue);
  const harnessPath = stripTrailingSlashes(harnessDir);
  return runtimePath === harnessPath ||
    runtimePath ===
      stripTrailingSlashes(
        `${DOCKER_DESKTOP_HOST_MOUNT_PREFIX}${harnessPath}`,
      );
};

/**
 * runsc parses its arguments with Go's `flag` package, which accepts one or
 * two leading dashes and both the `=` and the separate-token spelling.
 */
const runtimeFlagValue = (
  args: readonly string[],
  flag: string,
): string | undefined => {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      continue;
    }
    for (const dashes of ["--", "-"]) {
      if (arg.startsWith(`${dashes}${flag}=`)) {
        return arg.slice(`${dashes}${flag}=`.length);
      }
      if (arg === `${dashes}${flag}`) {
        return args[index + 1];
      }
    }
  }
  return undefined;
};

const readRuntimeArgs = (
  entry: Record<string, unknown>,
): readonly string[] | "unreadable" => {
  const args = entry.runtimeArgs;
  // Docker omits `runtimeArgs` entirely when a runtime is registered without
  // any, so an absent key is a reading of "no arguments" rather than a failure
  // to read.
  if (args === undefined) {
    return [];
  }
  if (
    !Array.isArray(args) || args.some((arg) => typeof arg !== "string")
  ) {
    return "unreadable";
  }
  return args as readonly string[];
};

/**
 * Decide, from the runtime table `docker info` reports, whether the runtime a
 * run is about to launch is registered against the same sidecar directories
 * `cf-harness` is configured with.
 *
 * Naming a directory in the harness config says only where the harness will
 * write; it says nothing about whether anything reads there. The two
 * transports are wired independently, so a host can have a working result
 * transport — sidecars arrive, output mediation succeeds, the run looks
 * healthy — while the invocation context carrying input labels is written into
 * a directory the runtime was never told about.
 */
export const cfcTransportReadinessFromDockerRuntimes = (options: {
  runtimeName: string;
  runtimes: unknown;
  cfcInvocationContextDir?: string;
  cfcResultDir?: string;
}): CfcTransportReadiness => {
  if (!isObjectNotArray(options.runtimes)) {
    return {
      status: "indeterminate",
      reason: "docker info did not report a runtime table",
    };
  }
  const entry = options.runtimes[options.runtimeName];
  if (entry === undefined) {
    return {
      status: "indeterminate",
      reason:
        `docker runtime '${options.runtimeName}' is not registered on this host`,
    };
  }
  if (!isObjectNotArray(entry)) {
    return {
      status: "indeterminate",
      reason:
        `docker info reported a non-object entry for runtime '${options.runtimeName}'`,
    };
  }
  const args = readRuntimeArgs(entry);
  if (args === "unreadable") {
    return {
      status: "indeterminate",
      reason:
        `docker info reported non-string runtime arguments for '${options.runtimeName}'`,
    };
  }
  const unread: CfcSidecarTransportKind[] = [];
  const transports: readonly [
    CfcSidecarTransportKind,
    string,
    string | undefined,
  ][] = [
    [
      "invocation-context",
      CFC_INVOCATION_CONTEXT_DIR_RUNTIME_FLAG,
      options.cfcInvocationContextDir,
    ],
    ["result", CFC_RESULT_DIR_RUNTIME_FLAG, options.cfcResultDir],
  ];
  for (const [kind, flag, harnessDir] of transports) {
    if (harnessDir === undefined) {
      continue;
    }
    const registered = runtimeFlagValue(args, flag);
    if (
      registered === undefined || !hostDirsCorrespond(registered, harnessDir)
    ) {
      unread.push(kind);
    }
  }
  return unread.length > 0
    ? { status: "unwired", unread }
    : { status: "wired" };
};

const byteLength = (text: string): number => textEncoder.encode(text).length;

const appendStderr = (stderr: string, message: string): string =>
  stderr.length > 0
    ? `${stderr}${stderr.endsWith("\n") ? "" : "\n"}${message}`
    : message;

const parseDockerContainerID = (stdout: string): string | undefined => {
  const firstLine = stdout.trim().split(/\s+/)[0];
  return firstLine !== undefined && firstLine.length > 0
    ? firstLine
    : undefined;
};

const cfcSidecarPath = (dir: string, containerID: string): string => {
  if (
    containerID === "" ||
    containerID === "." ||
    containerID === ".." ||
    /[/\\]/.test(containerID)
  ) {
    throw new Error(
      `invalid Docker container ID for CFC sidecar: ${containerID}`,
    );
  }
  return joinHostPath(dir, `${containerID}.json`);
};

const parseDockerWaitExitCode = (stdout: string): number | undefined => {
  const firstLine = stdout.trim().split(/\s+/)[0];
  if (firstLine === undefined || !/^-?\d+$/.test(firstLine)) {
    return undefined;
  }
  const parsed = Number(firstLine);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
};

const observedStream = (
  channel: CfcStreamChannel,
  text: string,
  label: IFCLabel,
) => ({
  channel,
  policy: "observed" as const,
  label,
  segments: text.length === 0
    ? []
    : [{ text, label, offset: 0, byteLength: byteLength(text) }],
});

const opaqueStream = (
  channel: CfcStreamChannel,
  text: string,
  label: IFCLabel,
) => ({
  channel,
  policy: "opaque" as const,
  label,
  byteLength: byteLength(text),
});

const deniedCfcResult = (
  code: string,
  message: string,
  details: Record<string, CfcSandboxJsonValue> = {},
): CfcSandboxResult => ({
  version: 1,
  stdout: {
    channel: "stdout",
    policy: "denied",
    label: {},
    reason: message,
  },
  stderr: {
    channel: "stderr",
    policy: "denied",
    label: {},
    reason: message,
  },
  exitCode: {
    policy: "denied",
    label: {},
    reason: message,
  },
  diagnostics: [{
    level: "error",
    code,
    message,
    details,
  }],
});

const hasNonEmptyXattrValue = (value: unknown): boolean => {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (isObjectNotArray(value)) {
    return Object.values(value).some(hasNonEmptyXattrValue);
  }
  return value !== undefined && value !== null;
};

const runscTaintLabel = (taint: RunscCfcLabelSidecar): IFCLabel => {
  const xattr = isObjectNotArray(taint.xattrJSON) ? taint.xattrJSON : {};
  return {
    ...(Array.isArray(xattr.confidentiality)
      ? { confidentiality: xattr.confidentiality }
      : {}),
    ...(Array.isArray(xattr.integrity) ? { integrity: xattr.integrity } : {}),
  };
};

const isPublicRunscTaint = (taint: RunscCfcLabelSidecar): boolean => {
  if (isObjectNotArray(taint.xattrJSON)) {
    return !Object.values(taint.xattrJSON).some(hasNonEmptyXattrValue);
  }
  const stringValue = typeof taint.string === "string"
    ? taint.string.trim()
    : "";
  return stringValue.length === 0 || stringValue === "{}";
};

const cfcResultFromRunscSidecar = (
  parsed: RunscCfcResultSidecar,
  expectedContainerID: string,
  commandResult: SandboxCommandResult,
): CfcSandboxResult => {
  if (parsed.version !== 1) {
    return deniedCfcResult(
      "runsc_cfc_sidecar_version",
      "runsc CFC result sidecar has an unsupported version",
      { containerId: expectedContainerID },
    );
  }
  if (parsed.containerId !== expectedContainerID) {
    return deniedCfcResult(
      "runsc_cfc_sidecar_container_mismatch",
      "runsc CFC result sidecar did not match the Docker container ID",
      {
        expectedContainerId: expectedContainerID,
        actualContainerId: typeof parsed.containerId === "string"
          ? parsed.containerId
          : "",
      },
    );
  }
  if (!isObjectNotArray(parsed.cfcTaint)) {
    return deniedCfcResult(
      "runsc_cfc_sidecar_missing_taint",
      "runsc CFC result sidecar did not include final CFC taint",
      { containerId: expectedContainerID },
    );
  }

  const cfcTaint = parsed.cfcTaint;
  const label = runscTaintLabel(cfcTaint);
  const details: Record<string, CfcSandboxJsonValue> = {
    containerId: expectedContainerID,
  };
  if (typeof parsed.sandboxId === "string") {
    details.sandboxId = parsed.sandboxId;
  }
  if (typeof parsed.waitStatus === "number") {
    details.waitStatus = parsed.waitStatus;
  }
  if (typeof cfcTaint.string === "string") {
    details.runscTaint = cfcTaint.string;
  }
  if (cfcTaint.xattrJSON !== undefined) {
    details.runscTaintXattrJSON = cfcTaint.xattrJSON as CfcSandboxJsonValue;
  }

  if (isPublicRunscTaint(cfcTaint)) {
    return {
      version: 1,
      stdout: observedStream("stdout", commandResult.stdout, label),
      stderr: observedStream("stderr", commandResult.stderr, label),
      exitCode: {
        policy: "observed",
        label,
        value: commandResult.exitCode,
      },
      diagnostics: [{
        level: "info",
        code: "runsc_cfc_result",
        message: "runsc reported final CFC taint for sandbox output",
        label,
        details,
      }],
    };
  }

  return {
    version: 1,
    stdout: opaqueStream("stdout", commandResult.stdout, label),
    stderr: opaqueStream("stderr", commandResult.stderr, label),
    exitCode: {
      policy: "opaque",
      label,
    },
    diagnostics: [{
      level: "info",
      code: "runsc_cfc_result",
      message:
        "runsc reported tainted sandbox output; raw streams are withheld from model context",
      label,
      details,
    }],
  };
};

export class DockerRunscSandboxRuntime implements SandboxRuntime {
  #cfcTransportReadiness?: CfcTransportReadiness;
  #cfcTransportReadinessProbe?: Promise<CfcTransportReadiness>;

  constructor(
    readonly config: DockerRunscSandboxConfig,
    private readonly runner: ProcessRunner = new DenoProcessRunner(),
  ) {}

  /**
   * Read the registered arguments of the Docker runtime this sandbox launches
   * and report whether they name the sidecar directories the harness is
   * configured with. The reading is memoized: a host's runtime registration
   * does not change under a run, and one `docker info` per sandbox is enough.
   */
  async probeCfcTransportReadiness(): Promise<CfcTransportReadiness> {
    this.#cfcTransportReadinessProbe ??= this.#readCfcTransportReadiness()
      .then((readiness) => {
        this.#cfcTransportReadiness = readiness;
        return readiness;
      });
    return await this.#cfcTransportReadinessProbe;
  }

  async #readCfcTransportReadiness(): Promise<CfcTransportReadiness> {
    let result: ProcessRunResult;
    try {
      result = await this.runner.run({
        command: this.config.dockerBinary,
        args: ["info", "--format", "{{json .Runtimes}}"],
      });
    } catch (error) {
      return {
        status: "indeterminate",
        reason: `docker info could not be run: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    if (result.exitCode !== 0) {
      return {
        status: "indeterminate",
        reason: `docker info exited ${result.exitCode}`,
      };
    }
    let runtimes: unknown;
    try {
      runtimes = JSON.parse(result.stdout);
    } catch (error) {
      return {
        status: "indeterminate",
        reason: `docker info runtime table could not be parsed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    return cfcTransportReadinessFromDockerRuntimes({
      runtimeName: this.config.runtimeName,
      runtimes,
      ...(this.config.cfcInvocationContextDir !== undefined
        ? { cfcInvocationContextDir: this.config.cfcInvocationContextDir }
        : {}),
      ...(this.config.cfcResultDir !== undefined
        ? { cfcResultDir: this.config.cfcResultDir }
        : {}),
    });
  }

  defaultWorkingDirectory(): string {
    return normalizeWorkspacePath(this.config.workspaceMountPath);
  }

  #mounts(): Array<{
    kind: SandboxRuntimeMountDescription["kind"];
    name?: string;
    hostPath: string;
    sandboxPath: string;
    readOnly: boolean;
  }> {
    return [
      {
        kind: "workspace",
        hostPath: this.config.workspaceHostPath,
        sandboxPath: this.config.workspaceMountPath,
        readOnly: false,
      },
      ...this.config.additionalMounts,
    ];
  }

  #mountDescriptions(): SandboxRuntimeMountDescription[] {
    return this.#mounts().map((mount) => ({
      kind: mount.kind,
      ...(mount.kind === "host-bind" ? { name: mount.name } : {}),
      hostPath: mount.hostPath,
      sandboxPath: mount.sandboxPath,
      readOnly: mount.readOnly,
      ...(mount.kind === "host-bind"
        ? { mode: mount.readOnly ? "readonly" as const : "writable" as const }
        : {}),
    }));
  }

  describe(): SandboxRuntimeDescription {
    return {
      kind: "docker-runsc-cfc",
      defaultWorkingDirectory: this.defaultWorkingDirectory(),
      cfc: {
        runtimeRequested: true,
        runtimeName: this.config.runtimeName,
        image: this.config.image,
        workspaceMountPath: this.config.workspaceMountPath,
        mounts: this.#mountDescriptions(),
        networkMode: this.config.dockerNetworkMode,
        extraDockerArgsCount: this.config.extraDockerArgs.length,
        ...(this.config.cfcInvocationContextDir !== undefined
          ? {
            invocationContextTransport: "sidecar",
            // Naming the directory says where the harness writes, not that
            // anything reads there. Until a probe has read the runtime's
            // registration this snapshot must say so rather than let the
            // transport tag stand in for a working one.
            invocationContextTransportReadiness:
              this.#cfcTransportReadiness?.status ?? "unverified",
          }
          : {}),
      },
    };
  }

  isPathWithinWorkspace(path: string): boolean {
    return isWithinRoot(this.config.workspaceMountPath, path);
  }

  isPathWithinAllowedRoots(path: string): boolean {
    return this.#mounts().some((mount) =>
      isWithinRoot(mount.sandboxPath, path)
    );
  }

  resolvePath(path: string, cwd?: string): string {
    const normalized = isAbsoluteSandboxPath(path)
      ? normalize(path)
      : normalize(joinSandboxPath(cwd ?? this.defaultWorkingDirectory(), path));
    if (!this.isPathWithinAllowedRoots(normalized)) {
      const rootLabel = this.config.additionalMounts.length === 0
        ? "workspace root"
        : "allowed sandbox roots";
      throw new SandboxPathEscapeError(
        path,
        `path escapes ${rootLabel}: ${path}`,
      );
    }
    return normalized;
  }

  async run(request: SandboxCommandRequest): Promise<SandboxCommandResult> {
    const createArgs = [
      "create",
      ...(request.stdinText !== undefined ? ["-i"] : []),
      "--runtime",
      this.config.runtimeName,
      "--network",
      this.config.dockerNetworkMode,
      ...(this.config.containerUser !== undefined
        ? ["--user", this.config.containerUser]
        : []),
      ...this.#mounts().flatMap((mount) => ["--mount", dockerMountArg(mount)]),
      "-w",
      request.cwd
        ? this.resolvePath(request.cwd)
        : this.defaultWorkingDirectory(),
      ...Object.entries(request.env ?? {})
        .sort(([left], [right]) => left.localeCompare(right))
        .flatMap(([name, value]) => ["--env", `${name}=${value}`]),
      ...this.config.extraDockerArgs,
      this.config.image,
      ...request.argv,
    ];
    const createResult = await this.runner.run({
      command: this.config.dockerBinary,
      args: createArgs,
    });
    if (createResult.exitCode !== 0) {
      return createResult;
    }
    const containerID = parseDockerContainerID(createResult.stdout);
    if (containerID === undefined) {
      return {
        stdout: createResult.stdout,
        stderr: appendStderr(
          createResult.stderr,
          "docker create did not return a container ID",
        ),
        exitCode: 125,
      };
    }

    try {
      const sidecarFailure = await this.writeCfcInvocationContextSidecar(
        containerID,
        request,
        createResult,
      );
      if (sidecarFailure !== undefined) {
        return sidecarFailure;
      }
      const startResult = await this.runner.run({
        command: this.config.dockerBinary,
        args: [
          "start",
          "--attach",
          ...(request.stdinText !== undefined ? ["--interactive"] : []),
          containerID,
        ],
        stdinText: request.stdinText,
        timeoutMs: request.timeoutMs,
      });
      const waitResult = await this.runner.run({
        command: this.config.dockerBinary,
        args: ["wait", containerID],
      });
      const exitCode = parseDockerWaitExitCode(waitResult.stdout) ??
        startResult.exitCode;
      const commandResult: SandboxCommandResult = {
        stdout: startResult.stdout,
        stderr: waitResult.exitCode === 0
          ? startResult.stderr
          : appendStderr(startResult.stderr, waitResult.stderr),
        exitCode,
      };
      const cfcResult = await this.readCfcResultSidecar(
        containerID,
        commandResult,
      );
      return cfcResult === undefined
        ? commandResult
        : { ...commandResult, cfcResult };
    } finally {
      await this.runner.run({
        command: this.config.dockerBinary,
        args: ["rm", "-f", containerID],
      });
    }
  }

  runShell(request: SandboxShellRequest): Promise<SandboxCommandResult> {
    return this.run({
      argv: [
        this.config.shellPath,
        "-lc",
        request.command,
        this.config.shellPath,
        ...(request.args ?? []),
      ],
      cwd: request.cwd,
      env: request.env,
      stdinText: request.stdinText,
      timeoutMs: request.timeoutMs,
      cfcInvocationContext: request.cfcInvocationContext,
    });
  }

  private async readCfcResultSidecar(
    containerID: string,
    commandResult: SandboxCommandResult,
  ): Promise<CfcSandboxResult | undefined> {
    if (this.config.cfcResultDir === undefined) {
      return undefined;
    }
    let sidecarPath: string;
    try {
      sidecarPath = cfcSidecarPath(this.config.cfcResultDir, containerID);
    } catch (error) {
      return deniedCfcResult(
        "runsc_cfc_sidecar_container_id",
        "runsc CFC sidecar path could not be derived from the Docker container ID",
        {
          containerId: containerID,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
    let text: string;
    try {
      text = await Deno.readTextFile(sidecarPath);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return undefined;
      }
      return deniedCfcResult(
        "runsc_cfc_sidecar_read_error",
        "failed to read runsc CFC result sidecar",
        {
          containerId: containerID,
          sidecarPath,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
    try {
      const parsed = JSON.parse(text) as RunscCfcResultSidecar;
      return cfcResultFromRunscSidecar(parsed, containerID, commandResult);
    } catch (error) {
      return deniedCfcResult(
        "runsc_cfc_sidecar_parse_error",
        "failed to parse runsc CFC result sidecar",
        {
          containerId: containerID,
          sidecarPath,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  /**
   * Refuse an enforcing invocation whose input labels would be written into a
   * directory the runtime is not registered to read.
   *
   * This half of the CFC sidecar pair fails open: nothing downstream notices
   * that the sandbox started untainted, so the run goes on reporting the
   * enforcement posture it printed at startup while dropping every input
   * label it was handed. Refusing here states the condition once, at the call
   * it actually affects, instead of leaving it to be inferred from an output
   * mediation denial that has a different cause.
   *
   * Only a positive reading of the runtime's registered arguments refuses. A
   * host whose registration could not be read is `indeterminate` and runs, so
   * that an unreadable `docker info` cannot masquerade as evidence of a
   * misconfiguration.
   */
  async #refuseUnreadCfcInvocationContext(
    context: HarnessCfcInvocationContext,
    createResult: SandboxCommandResult,
    dir: string | undefined,
  ): Promise<SandboxCommandResult | undefined> {
    const refuse = (detail: string): SandboxCommandResult => ({
      stdout: createResult.stdout,
      stderr: appendStderr(
        createResult.stderr,
        `refusing to start a container under cfc enforcement mode '${context.cfcEnforcementMode}': ${detail}`,
      ),
      exitCode: 125,
    });
    if (
      cfcEnforcementStrictness(context.cfcEnforcementMode) <
        CFC_ENFORCING_STRICTNESS
    ) {
      return undefined;
    }
    // `assertDockerRunscCfcTransportForMode` already refuses an unconfigured
    // transport at run start, but it guards the engine's entry rather than
    // this one, and a runtime constructed directly reaches here with the same
    // labels and no guard behind it.
    if (dir === undefined) {
      return refuse(
        `no CFC invocation-context directory is configured, so this invocation's ` +
          `CFC input labels have nowhere to be read from`,
      );
    }
    const readiness = await this.probeCfcTransportReadiness();
    if (
      readiness.status !== "unwired" ||
      !readiness.unread.includes("invocation-context")
    ) {
      return undefined;
    }
    return refuse(
      `the '${this.config.runtimeName}' docker runtime is not registered with ` +
        `--${CFC_INVOCATION_CONTEXT_DIR_RUNTIME_FLAG}=${dir}, so this invocation's ` +
        `CFC input labels would be written and never read`,
    );
  }

  private async writeCfcInvocationContextSidecar(
    containerID: string,
    request: SandboxCommandRequest,
    createResult: SandboxCommandResult,
  ): Promise<SandboxCommandResult | undefined> {
    const context = request.cfcInvocationContext;
    if (context === undefined) {
      return undefined;
    }
    const dir = this.config.cfcInvocationContextDir;
    const refusal = await this.#refuseUnreadCfcInvocationContext(
      context,
      createResult,
      dir,
    );
    if (refusal !== undefined) {
      return refusal;
    }
    if (dir === undefined) {
      return undefined;
    }
    try {
      await Deno.mkdir(dir, { recursive: true });
      await Deno.writeTextFile(
        cfcSidecarPath(dir, containerID),
        `${JSON.stringify(request.cfcInvocationContext, null, 2)}\n`,
      );
      return undefined;
    } catch (error) {
      return {
        stdout: createResult.stdout,
        stderr: appendStderr(
          createResult.stderr,
          `failed to write CFC invocation context sidecar: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
        exitCode: 125,
      };
    }
  }
}
