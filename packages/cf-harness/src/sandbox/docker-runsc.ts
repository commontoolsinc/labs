import { isAbsolute, join, normalize } from "@std/path/posix";
import { DenoProcessRunner, type ProcessRunner } from "./process-runner.ts";
import type {
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
export const DEFAULT_DOCKER_NETWORK_MODE = "none" as const;
export const DEFAULT_FABRIC_MOUNT_PATH = "/fabric";

const readEnvVar = (name: string): string | undefined => {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
};

export const resolveDefaultContainerUser = (
  hostOs: typeof Deno.build.os = Deno.build.os,
): string | undefined => {
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
  if (!isAbsolute(normalized) || normalized === "/") {
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
  return {
    kind: mount.kind,
    hostPath: mount.hostPath,
    sandboxPath: validateSandboxRoot(
      mount.sandboxPath ?? DEFAULT_FABRIC_MOUNT_PATH,
      `${mount.kind} sandboxPath`,
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
  return {
    kind: "docker-runsc-cfc",
    dockerBinary: options.dockerBinary ?? DEFAULT_DOCKER_BINARY,
    runtimeName: options.runtimeName ?? DEFAULT_DOCKER_RUNTIME_NAME,
    image: options.image ?? DEFAULT_DOCKER_RUNSC_IMAGE,
    ...(containerUser !== undefined ? { containerUser } : {}),
    workspaceHostPath: options.workspaceHostPath,
    workspaceMountPath,
    shellPath: options.shellPath ?? DEFAULT_SANDBOX_SHELL,
    dockerNetworkMode: options.dockerNetworkMode ?? DEFAULT_DOCKER_NETWORK_MODE,
    additionalMounts,
    extraDockerArgs: options.extraDockerArgs ?? [],
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
    return this.#mounts().map(({ kind, sandboxPath, readOnly }) => ({
      kind,
      sandboxPath,
      readOnly,
    }));
  }

  describe(): SandboxRuntimeDescription {
    return {
      kind: this.kind,
      defaultWorkingDirectory: this.defaultWorkingDirectory(),
      cfc: {
        runtimeRequested: true,
        runtimeName: this.config.runtimeName,
        workspaceMountPath: this.config.workspaceMountPath,
        mounts: this.#mountDescriptions(),
        networkMode: this.config.dockerNetworkMode,
        extraDockerArgsCount: this.config.extraDockerArgs.length,
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
    const normalized = isAbsolute(path)
      ? normalize(path)
      : normalize(join(cwd ?? this.defaultWorkingDirectory(), path));
    if (!this.isPathWithinAllowedRoots(normalized)) {
      const rootLabel = this.config.additionalMounts.length === 0
        ? "workspace root"
        : "allowed sandbox roots";
      throw new Error(`path escapes ${rootLabel}: ${path}`);
    }
    return normalized;
  }

  run(request: SandboxCommandRequest): Promise<SandboxCommandResult> {
    const dockerArgs = [
      "run",
      "--rm",
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
      ...this.config.extraDockerArgs,
      this.config.image,
      ...request.argv,
    ];
    return this.runner.run({
      command: this.config.dockerBinary,
      args: dockerArgs,
      stdinText: request.stdinText,
      timeoutMs: request.timeoutMs,
    });
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
      stdinText: request.stdinText,
      timeoutMs: request.timeoutMs,
    });
  }
}
