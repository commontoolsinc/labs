export type HarnessSandboxKind = "docker-runsc-cfc";

export type DockerNetworkMode = "none" | "bridge" | "host";

export interface DockerRunscSandboxConfig {
  kind: "docker-runsc-cfc";
  dockerBinary: string;
  runtimeName: string;
  image: string;
  workspaceHostPath: string;
  workspaceMountPath: string;
  shellPath: string;
  dockerNetworkMode: DockerNetworkMode;
  extraDockerArgs: readonly string[];
}

export type HarnessSandboxConfig = DockerRunscSandboxConfig;

export interface ResolveDockerRunscSandboxConfigOptions {
  dockerBinary?: string;
  runtimeName?: string;
  image?: string;
  workspaceHostPath: string;
  workspaceMountPath?: string;
  shellPath?: string;
  dockerNetworkMode?: DockerNetworkMode;
  extraDockerArgs?: readonly string[];
}

export interface SandboxCommandRequest {
  argv: string[];
  cwd?: string;
  stdinText?: string;
  timeoutMs?: number;
}

export interface SandboxShellRequest {
  command: string;
  args?: readonly string[];
  cwd?: string;
  stdinText?: string;
  timeoutMs?: number;
}

export interface SandboxCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SandboxRuntime {
  readonly kind: HarnessSandboxKind;
  resolvePath(path: string): string;
  defaultWorkingDirectory(): string;
  run(request: SandboxCommandRequest): Promise<SandboxCommandResult>;
  runShell(request: SandboxShellRequest): Promise<SandboxCommandResult>;
}
