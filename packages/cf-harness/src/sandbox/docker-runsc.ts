import { isAbsolute, join, normalize } from "@std/path/posix";
import { DenoProcessRunner, type ProcessRunner } from "./process-runner.ts";
import type {
  DockerRunscSandboxConfig,
  ResolveDockerRunscSandboxConfigOptions,
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxRuntime,
  SandboxShellRequest,
} from "./types.ts";

export const DEFAULT_DOCKER_RUNSC_IMAGE =
  "us-docker.pkg.dev/commontools-core/common-fabric/sandbox-kitchensink:latest";
export const DEFAULT_DOCKER_RUNTIME_NAME = "runsc-cfc";
export const DEFAULT_DOCKER_BINARY = "docker";
export const DEFAULT_WORKSPACE_MOUNT_PATH = "/workspace";
export const DEFAULT_SANDBOX_SHELL = "/bin/sh";
export const DEFAULT_DOCKER_NETWORK_MODE = "none" as const;

const readEnvVar = (name: string): string | undefined => {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
};

const resolveDefaultContainerUser = (): string | undefined => {
  if (Deno.build.os === "windows") {
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

const isWithinRoot = (root: string, path: string): boolean => {
  const normalizedRoot = normalizeWorkspacePath(root);
  const normalizedPath = normalizeWorkspacePath(path);
  return normalizedPath === normalizedRoot ||
    normalizedPath.startsWith(`${normalizedRoot}/`);
};

export const resolveDockerRunscSandboxConfig = (
  options: ResolveDockerRunscSandboxConfigOptions,
): DockerRunscSandboxConfig => {
  const containerUser = options.containerUser ?? resolveDefaultContainerUser();
  return {
    kind: "docker-runsc-cfc",
    dockerBinary: options.dockerBinary ?? DEFAULT_DOCKER_BINARY,
    runtimeName: options.runtimeName ?? DEFAULT_DOCKER_RUNTIME_NAME,
    image: options.image ?? DEFAULT_DOCKER_RUNSC_IMAGE,
    ...(containerUser !== undefined ? { containerUser } : {}),
    workspaceHostPath: options.workspaceHostPath,
    workspaceMountPath: options.workspaceMountPath ??
      DEFAULT_WORKSPACE_MOUNT_PATH,
    shellPath: options.shellPath ?? DEFAULT_SANDBOX_SHELL,
    dockerNetworkMode: options.dockerNetworkMode ?? DEFAULT_DOCKER_NETWORK_MODE,
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

  isPathWithinWorkspace(path: string): boolean {
    return isWithinRoot(this.config.workspaceMountPath, path);
  }

  resolvePath(path: string, cwd?: string): string {
    const normalized = isAbsolute(path)
      ? normalize(path)
      : normalize(join(cwd ?? this.defaultWorkingDirectory(), path));
    if (!this.isPathWithinWorkspace(normalized)) {
      throw new Error(`path escapes workspace root: ${path}`);
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
      "--mount",
      `type=bind,src=${this.config.workspaceHostPath},dst=${this.config.workspaceMountPath}`,
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
