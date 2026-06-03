import {
  isAbsolute as isAbsoluteHostPath,
  join as joinHostPath,
} from "@std/path";
import {
  isAbsolute as isAbsoluteSandboxPath,
  join as joinSandboxPath,
  normalize,
} from "@std/path/posix";
import { DenoProcessRunner, type ProcessRunner } from "./process-runner.ts";
import type {
  DockerNetworkMode,
  DockerRunscAdditionalMount,
  DockerRunscAdditionalMountConfig,
  DockerRunscCfcInvocationContextTransport,
  DockerRunscSandboxConfig,
  ResolveDockerRunscSandboxConfigOptions,
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxRuntime,
  SandboxRuntimeDescription,
  SandboxRuntimeMountDescription,
  SandboxShellRequest,
} from "./types.ts";
import type {
  CfcSandboxJsonValue,
  CfcSandboxResult,
  CfcStreamChannel,
  IFCLabel,
} from "@commonfabric/runner/cfc";

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

const resolveCfcInvocationContextTransport = (
  options: ResolveDockerRunscSandboxConfigOptions,
): DockerRunscCfcInvocationContextTransport | undefined => {
  if (options.cfcInvocationContextTransport !== undefined) {
    return {
      kind: "sidecar",
      dir: validateAbsoluteHostDir(
        options.cfcInvocationContextTransport.dir,
        "cfcInvocationContextTransport.dir",
      ),
    };
  }
  const dir = optionalNonEmptyString(
    options.cfcInvocationContextDir ??
      readEnvVar(CFC_INVOCATION_CONTEXT_DIR_ENV),
  );
  return dir === undefined ? undefined : {
    kind: "sidecar",
    dir: validateAbsoluteHostDir(dir, "cfcInvocationContextDir"),
  };
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
  const cfcInvocationContextTransport = resolveCfcInvocationContextTransport(
    options,
  );
  return {
    kind: "docker-runsc-cfc",
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
    ...(cfcInvocationContextTransport !== undefined
      ? { cfcInvocationContextTransport }
      : {}),
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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
  if (isRecord(value)) {
    return Object.values(value).some(hasNonEmptyXattrValue);
  }
  return value !== undefined && value !== null;
};

const runscTaintLabel = (taint: RunscCfcLabelSidecar): IFCLabel => {
  const xattr = isRecord(taint.xattrJSON) ? taint.xattrJSON : {};
  return {
    ...(Array.isArray(xattr.confidentiality)
      ? { confidentiality: xattr.confidentiality }
      : {}),
    ...(Array.isArray(xattr.integrity) ? { integrity: xattr.integrity } : {}),
  };
};

const isPublicRunscTaint = (taint: RunscCfcLabelSidecar): boolean => {
  if (isRecord(taint.xattrJSON)) {
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
  if (!isRecord(parsed.cfcTaint)) {
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
  readonly kind = "docker-runsc-cfc" as const;

  constructor(
    readonly config: DockerRunscSandboxConfig,
    private readonly runner: ProcessRunner = new DenoProcessRunner(),
  ) {}

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
      kind: this.kind,
      defaultWorkingDirectory: this.defaultWorkingDirectory(),
      cfc: {
        runtimeRequested: true,
        runtimeName: this.config.runtimeName,
        image: this.config.image,
        workspaceMountPath: this.config.workspaceMountPath,
        mounts: this.#mountDescriptions(),
        networkMode: this.config.dockerNetworkMode,
        extraDockerArgsCount: this.config.extraDockerArgs.length,
        ...(this.config.cfcInvocationContextTransport !== undefined
          ? {
            invocationContextTransport:
              this.config.cfcInvocationContextTransport.kind,
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
      throw new Error(`path escapes ${rootLabel}: ${path}`);
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

  private async writeCfcInvocationContextSidecar(
    containerID: string,
    request: SandboxCommandRequest,
    createResult: SandboxCommandResult,
  ): Promise<SandboxCommandResult | undefined> {
    if (
      this.config.cfcInvocationContextTransport === undefined ||
      request.cfcInvocationContext === undefined
    ) {
      return undefined;
    }
    const transport = this.config.cfcInvocationContextTransport;
    switch (transport.kind) {
      case "sidecar": {
        try {
          await Deno.mkdir(transport.dir, { recursive: true });
          await Deno.writeTextFile(
            cfcSidecarPath(transport.dir, containerID),
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
  }
}
