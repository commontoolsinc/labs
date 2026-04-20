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

export const DEFAULT_DOCKER_RUNSC_IMAGE = "alpine:3.20";
export const DEFAULT_DOCKER_RUNTIME_NAME = "runsc-cfc";
export const DEFAULT_DOCKER_BINARY = "docker";
export const DEFAULT_WORKSPACE_MOUNT_PATH = "/workspace";
export const DEFAULT_SANDBOX_SHELL = "/bin/sh";
export const DEFAULT_DOCKER_NETWORK_MODE = "none" as const;

const isWithinRoot = (root: string, path: string): boolean =>
  path === root || path.startsWith(`${root}/`);

export const resolveDockerRunscSandboxConfig = (
  options: ResolveDockerRunscSandboxConfigOptions,
): DockerRunscSandboxConfig => ({
  kind: "docker-runsc-cfc",
  dockerBinary: options.dockerBinary ?? DEFAULT_DOCKER_BINARY,
  runtimeName: options.runtimeName ?? DEFAULT_DOCKER_RUNTIME_NAME,
  image: options.image ?? DEFAULT_DOCKER_RUNSC_IMAGE,
  workspaceHostPath: options.workspaceHostPath,
  workspaceMountPath: options.workspaceMountPath ??
    DEFAULT_WORKSPACE_MOUNT_PATH,
  shellPath: options.shellPath ?? DEFAULT_SANDBOX_SHELL,
  dockerNetworkMode: options.dockerNetworkMode ?? DEFAULT_DOCKER_NETWORK_MODE,
  extraDockerArgs: options.extraDockerArgs ?? [],
});

export class DockerRunscSandboxRuntime implements SandboxRuntime {
  readonly kind = "docker-runsc-cfc" as const;

  constructor(
    readonly config: DockerRunscSandboxConfig,
    private readonly runner: ProcessRunner = new DenoProcessRunner(),
  ) {}

  defaultWorkingDirectory(): string {
    return this.config.workspaceMountPath;
  }

  isPathWithinWorkspace(path: string): boolean {
    return isWithinRoot(
      this.config.workspaceMountPath,
      normalize(path),
    );
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
