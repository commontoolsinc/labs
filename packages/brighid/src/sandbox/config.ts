/**
 * Sandbox Configuration
 *
 * Defines configurations and profiles for sandboxed real execution.
 * Sandboxed execution allows running real programs while maintaining
 * CFC label tracking on inputs and outputs.
 */

export interface SandboxedExecConfig {
  backend: "auto" | "host" | "cfc-sandbox";
  sandboxRuntime: "auto" | "cfc-sandbox" | "docker-cfc" | "runsc-direct";
  fabricMountMode: "none" | "labs-fuse";
  /** Allow network access from sandbox (default: false) */
  allowNetwork: boolean;
  /** Real filesystem paths readable by sandbox */
  allowedReadPaths: string[];
  /** Real filesystem paths writable by sandbox */
  allowedWritePaths: string[];
  /** Max execution time in ms (default: 30000) */
  timeout: number;
  /** Max memory in bytes (default: 256MB) */
  memoryLimit: number;
  /** Environment variables to pass (filtered — no secrets) */
  env: Record<string, string>;
  cfcSandboxBinary?: string;
  dockerBinaryPath?: string;
  dockerRuntimeName?: string;
  runscBinaryPath?: string;
  runscRootPath?: string;
  runscRootfsPath?: string;
  image?: string;
  policyPath?: string;
  guestWorkspacePath: string;
  fabricHostPath?: string;
  fabricGuestPath: string;
  labsCheckout?: string;
  toolshedApiUrl: string;
  fabricWaitSeconds: number;
}

export interface SandboxProfile {
  name: string;
  description: string;
  config: Partial<SandboxedExecConfig>;
}

export const defaultConfig: SandboxedExecConfig = {
  backend: "auto",
  sandboxRuntime: "auto",
  fabricMountMode: "labs-fuse",
  allowNetwork: false,
  allowedReadPaths: [],
  allowedWritePaths: [],
  timeout: 30000,
  memoryLimit: 256 * 1024 * 1024,
  env: {},
  cfcSandboxBinary: undefined,
  dockerBinaryPath: undefined,
  dockerRuntimeName: undefined,
  runscBinaryPath: undefined,
  runscRootPath: undefined,
  runscRootfsPath: undefined,
  image:
    "us-docker.pkg.dev/commontools-core/common-fabric/sandbox-kitchensink:latest",
  policyPath: undefined,
  guestWorkspacePath: "/workspace",
  fabricHostPath: undefined,
  fabricGuestPath: "/fabric",
  labsCheckout: undefined,
  toolshedApiUrl: "https://toolshed.saga-castor.ts.net",
  fabricWaitSeconds: 10,
};

/** Built-in profiles for common use cases */
export const profiles: Record<string, SandboxProfile> = {
  "python-data": {
    name: "python-data",
    description: "Python data processing (no network)",
    config: { backend: "host", allowNetwork: false, timeout: 300000 },
  },
  "npm-install": {
    name: "npm-install",
    description: "NPM package installation (network allowed)",
    config: { backend: "host", allowNetwork: true, timeout: 120000 },
  },
  "build": {
    name: "build",
    description: "Build processes (no network)",
    config: { backend: "host", allowNetwork: false, timeout: 600000 },
  },
};

/**
 * Merge base config with overrides
 */
export function mergeConfig(
  base: SandboxedExecConfig,
  overrides: Partial<SandboxedExecConfig>,
): SandboxedExecConfig {
  return {
    backend: overrides.backend ?? base.backend,
    sandboxRuntime: overrides.sandboxRuntime ?? base.sandboxRuntime,
    fabricMountMode: overrides.fabricMountMode ?? base.fabricMountMode,
    allowNetwork: overrides.allowNetwork ?? base.allowNetwork,
    allowedReadPaths: overrides.allowedReadPaths ?? base.allowedReadPaths,
    allowedWritePaths: overrides.allowedWritePaths ?? base.allowedWritePaths,
    timeout: overrides.timeout ?? base.timeout,
    memoryLimit: overrides.memoryLimit ?? base.memoryLimit,
    env: { ...base.env, ...overrides.env },
    cfcSandboxBinary: overrides.cfcSandboxBinary ?? base.cfcSandboxBinary,
    dockerBinaryPath: overrides.dockerBinaryPath ?? base.dockerBinaryPath,
    dockerRuntimeName: overrides.dockerRuntimeName ?? base.dockerRuntimeName,
    runscBinaryPath: overrides.runscBinaryPath ?? base.runscBinaryPath,
    runscRootPath: overrides.runscRootPath ?? base.runscRootPath,
    runscRootfsPath: overrides.runscRootfsPath ?? base.runscRootfsPath,
    image: overrides.image ?? base.image,
    policyPath: overrides.policyPath ?? base.policyPath,
    guestWorkspacePath: overrides.guestWorkspacePath ?? base.guestWorkspacePath,
    fabricHostPath: overrides.fabricHostPath ?? base.fabricHostPath,
    fabricGuestPath: overrides.fabricGuestPath ?? base.fabricGuestPath,
    labsCheckout: overrides.labsCheckout ?? base.labsCheckout,
    toolshedApiUrl: overrides.toolshedApiUrl ?? base.toolshedApiUrl,
    fabricWaitSeconds: overrides.fabricWaitSeconds ?? base.fabricWaitSeconds,
  };
}

/**
 * Get a profile by name
 */
export function getProfile(name: string): SandboxProfile | null {
  return profiles[name] ?? null;
}
