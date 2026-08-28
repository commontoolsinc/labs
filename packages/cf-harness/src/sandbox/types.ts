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
 * `unregistered` is the only status that refuses, and it is the only one that
 * is a statement about the world: no valid absolute value is registered for
 * the flag — absent, empty, or relative, and runsc refuses a non-absolute one
 * — so nothing reads the harness's directory. That holds under any filesystem
 * topology, against any daemon, however the arguments were parsed, and
 * whenever the registration was last reloaded, because **it compares no
 * paths**. Every attack on this check has been an attack on a comparison; this
 * status makes none.
 *
 * `registered` says a valid absolute directory is registered, and carries
 * which one. It is deliberately not a claim that the directory is the one the
 * harness writes to, and not a claim that the transport works. Comparing the
 * two spellings cannot establish either: Docker resolves bind paths on the
 * daemon's host, symlinks and case-insensitive projections make two spellings
 * one directory, `runtimes` is SIGHUP-reloadable, and Docker generates a shell
 * wrapper for runtime arguments so what runsc parses is not the array
 * `docker info` reports. The registered path travels with the status instead,
 * so an operator can see that it differs without this check pretending that
 * seeing it differ is knowing it differs. Affirming the transport needs an
 * end-to-end proof — a sentinel written by the harness and read back from
 * inside the sandbox — which this reading is not.
 *
 * `indeterminate` is the absence of any reading. Folding it into `unregistered`
 * refuses a host whose registration could not be read; folding it into
 * `registered` excuses a broken one.
 *
 * The word each status carries is what survives: these travel on the wire into
 * `policy-snapshot.json`, where no doc comment follows them, and a reader who
 * meets one there has only the word.
 */
export type CfcSidecarTransportReading =
  | { status: "registered"; registeredPath: string }
  | { status: "unregistered" }
  | { status: "indeterminate"; reason: string };

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
    invocationContextRegisteredPath?: string;
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
