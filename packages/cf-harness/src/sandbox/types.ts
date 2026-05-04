import type { CfcSandboxResult } from "@commonfabric/runner/cfc";
import type { HarnessCfcInvocationContext } from "../contracts/cfc-invocation-context.ts";

export type HarnessSandboxKind = "docker-runsc-cfc";

export type DockerNetworkMode = "none" | "bridge" | "host";

export type SandboxRuntimeMountKind = "workspace" | "fabric-fuse";

export interface SandboxRuntimeMountDescription {
  kind: SandboxRuntimeMountKind;
  sandboxPath: string;
  readOnly: boolean;
}

export interface DockerRunscAdditionalMountConfig {
  kind: "fabric-fuse";
  hostPath: string;
  sandboxPath?: string;
  readOnly?: boolean;
}

export interface DockerRunscAdditionalMount {
  kind: "fabric-fuse";
  hostPath: string;
  sandboxPath: string;
  readOnly: boolean;
}

export interface DockerRunscCfcInvocationContextSidecarTransport {
  kind: "sidecar";
  dir: string;
}

export type DockerRunscCfcInvocationContextTransport =
  DockerRunscCfcInvocationContextSidecarTransport;

export interface DockerRunscSandboxConfig {
  kind: "docker-runsc-cfc";
  dockerBinary: string;
  runtimeName: string;
  image: string;
  containerUser?: string;
  workspaceHostPath: string;
  workspaceMountPath: string;
  shellPath: string;
  dockerNetworkMode: DockerNetworkMode;
  additionalMounts: readonly DockerRunscAdditionalMount[];
  extraDockerArgs: readonly string[];
  cfcResultDir?: string;
  cfcInvocationContextTransport?: DockerRunscCfcInvocationContextTransport;
}

export type HarnessSandboxConfig = DockerRunscSandboxConfig;

export interface ResolveDockerRunscSandboxConfigOptions {
  dockerBinary?: string;
  runtimeName?: string;
  image?: string;
  containerUser?: string;
  workspaceHostPath: string;
  workspaceMountPath?: string;
  shellPath?: string;
  dockerNetworkMode?: DockerNetworkMode;
  additionalMounts?: readonly DockerRunscAdditionalMountConfig[];
  extraDockerArgs?: readonly string[];
  cfcResultDir?: string;
  cfcInvocationContextDir?: string;
  cfcInvocationContextTransport?: DockerRunscCfcInvocationContextTransport;
}

export interface SandboxCommandRequest {
  argv: string[];
  cwd?: string;
  stdinText?: string;
  timeoutMs?: number;
  cfcInvocationContext?: HarnessCfcInvocationContext;
}

export interface SandboxShellRequest {
  command: string;
  args?: readonly string[];
  cwd?: string;
  stdinText?: string;
  timeoutMs?: number;
  cfcInvocationContext?: HarnessCfcInvocationContext;
}

export interface SandboxCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  cfcResult?: CfcSandboxResult;
}

export interface SandboxRuntimeDescription {
  kind: HarnessSandboxKind;
  defaultWorkingDirectory: string;
  cfc?: {
    runtimeRequested: boolean;
    runtimeName?: string;
    workspaceMountPath?: string;
    mounts?: readonly SandboxRuntimeMountDescription[];
    networkMode?: DockerNetworkMode;
    extraDockerArgsCount?: number;
    invocationContextTransport?: string;
  };
}

export interface SandboxRuntime {
  readonly kind: HarnessSandboxKind;
  describe?(): SandboxRuntimeDescription;
  resolvePath(path: string, cwd?: string): string;
  isPathWithinWorkspace(path: string): boolean;
  isPathWithinAllowedRoots?(path: string): boolean;
  defaultWorkingDirectory(): string;
  run(request: SandboxCommandRequest): Promise<SandboxCommandResult>;
  runShell(request: SandboxShellRequest): Promise<SandboxCommandResult>;
}
