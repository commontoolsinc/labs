import type { CfcSandboxResult } from "@commonfabric/runner/cfc";
import type { HarnessCfcInvocationContext } from "../contracts/cfc-invocation-context.ts";

export type DockerNetworkMode = "none" | "bridge" | "host";

export type SandboxRuntimeMountKind =
  | "workspace"
  | "fabric-fuse"
  | "host-bind";

export type SandboxHostMountMode = "readonly" | "writable";

export interface SandboxRuntimeMountDescription {
  kind: SandboxRuntimeMountKind;
  name?: string;
  hostPath?: string;
  sandboxPath: string;
  readOnly: boolean;
  mode?: SandboxHostMountMode;
}

export interface DockerRunscFabricAdditionalMountConfig {
  kind: "fabric-fuse";
  hostPath: string;
  sandboxPath?: string;
  readOnly?: boolean;
}

export interface DockerRunscHostBindAdditionalMountConfig {
  kind: "host-bind";
  name: string;
  hostPath: string;
  sandboxPath: string;
  readOnly?: boolean;
}

export type DockerRunscAdditionalMountConfig =
  | DockerRunscFabricAdditionalMountConfig
  | DockerRunscHostBindAdditionalMountConfig;

export interface DockerRunscFabricAdditionalMount {
  kind: "fabric-fuse";
  hostPath: string;
  sandboxPath: string;
  readOnly: boolean;
}

export interface DockerRunscHostBindAdditionalMount {
  kind: "host-bind";
  name: string;
  hostPath: string;
  sandboxPath: string;
  readOnly: boolean;
}

export type DockerRunscAdditionalMount =
  | DockerRunscFabricAdditionalMount
  | DockerRunscHostBindAdditionalMount;

export interface DockerRunscSandboxConfig {
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
  // Read once per sandbox and then memoized, so a verdict outlives the read
  // that produced it. `readonly` keeps the directory it was read against from
  // moving underneath it.
  readonly cfcResultDir?: string;
  readonly cfcInvocationContextDir?: string;
}

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
}

/**
 * Which of the two host sidecar directories a readiness reading is about.
 * `cf-harness` writes into the invocation-context directory and reads out of
 * the result directory; the installed Docker runtime is the counterparty for
 * both, and it can be wired for either one independently of the other.
 */
export type CfcSidecarTransportKind = "invocation-context" | "result";

/**
 * One transport's reading.
 *
 * The three states stay distinct rather than collapsing into a boolean because
 * the evidence behind them differs. `unwired` is a positive reading of the
 * runtime's registered arguments; `indeterminate` is the absence of any
 * reading. Folding the second into the first refuses a host whose registration
 * simply could not be read, and folding it into `wired` excuses a broken one.
 */
export type CfcSidecarTransportReading =
  | { status: "wired" }
  | { status: "unwired" }
  | { status: "indeterminate"; reason: string };

/**
 * Whether the installed Docker runtime is registered to use the sidecar
 * directories `cf-harness` is configured with — **one reading per transport**,
 * with an entry present exactly when that transport is configured.
 *
 * The pair is read in a single pass but must not be summarized into a single
 * verdict. The two transports are registered independently and can disagree,
 * and a summary has to pick one answer: an `unwired` result directory would
 * otherwise outrank and erase an `indeterminate` invocation-context one, so a
 * consumer asking about input taint would be told about output mediation
 * instead, and an enforcing invocation would start carrying exactly the
 * uncertainty the third state exists to preserve.
 */
export type CfcTransportReadiness = {
  readonly [K in CfcSidecarTransportKind]?: CfcSidecarTransportReading;
};

export interface SandboxCommandRequest {
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdinText?: string;
  timeoutMs?: number;
  cfcInvocationContext?: HarnessCfcInvocationContext;
}

export interface SandboxShellRequest {
  command: string;
  args?: readonly string[];
  cwd?: string;
  env?: Record<string, string>;
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
  kind: "docker-runsc-cfc";
  defaultWorkingDirectory: string;
  cfc?: {
    runtimeRequested: boolean;
    runtimeName?: string;
    image?: string;
    workspaceMountPath?: string;
    mounts?: readonly SandboxRuntimeMountDescription[];
    networkMode?: DockerNetworkMode;
    extraDockerArgsCount?: number;
    invocationContextTransport?: string;
    invocationContextTransportReadiness?: string;
  };
}

export interface SandboxRuntime {
  describe(): SandboxRuntimeDescription;
  /**
   * Read whether the host runtime is registered to use this sandbox's CFC
   * sidecar directories, so that `describe()` reports a reading rather than
   * `unverified`. Optional because it is meaningful only for a runtime that
   * has a counterparty to check; a caller that wants the description to carry
   * a reading awaits this first.
   */
  probeCfcTransportReadiness?(): Promise<CfcTransportReadiness>;
  resolvePath(path: string, cwd?: string): string;
  isPathWithinWorkspace(path: string): boolean;
  isPathWithinAllowedRoots(path: string): boolean;
  defaultWorkingDirectory(): string;
  run(request: SandboxCommandRequest): Promise<SandboxCommandResult>;
  runShell(request: SandboxShellRequest): Promise<SandboxCommandResult>;
}
