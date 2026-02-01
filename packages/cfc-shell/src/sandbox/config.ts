/**
 * Sandbox Configuration
 *
 * Defines configurations and profiles for sandboxed real execution.
 * Sandboxed execution allows running real programs while maintaining
 * CFC label tracking on inputs and outputs.
 */

export interface SandboxedExecConfig {
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
}

export interface SandboxProfile {
  name: string;
  description: string;
  config: Partial<SandboxedExecConfig>;
}

export const defaultConfig: SandboxedExecConfig = {
  allowNetwork: false,
  allowedReadPaths: [],
  allowedWritePaths: [],
  timeout: 30000,
  memoryLimit: 256 * 1024 * 1024,
  env: {},
};

/** Built-in profiles for common use cases */
export const profiles: Record<string, SandboxProfile> = {
  "python-data": {
    name: "python-data",
    description: "Python data processing (no network)",
    config: { allowNetwork: false, timeout: 300000 },
  },
  "npm-install": {
    name: "npm-install",
    description: "NPM package installation (network allowed)",
    config: { allowNetwork: true, timeout: 120000 },
  },
  "build": {
    name: "build",
    description: "Build processes (no network)",
    config: { allowNetwork: false, timeout: 600000 },
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
    allowNetwork: overrides.allowNetwork ?? base.allowNetwork,
    allowedReadPaths: overrides.allowedReadPaths ?? base.allowedReadPaths,
    allowedWritePaths: overrides.allowedWritePaths ?? base.allowedWritePaths,
    timeout: overrides.timeout ?? base.timeout,
    memoryLimit: overrides.memoryLimit ?? base.memoryLimit,
    env: { ...base.env, ...overrides.env },
  };
}

/**
 * Get a profile by name
 */
export function getProfile(name: string): SandboxProfile | null {
  return profiles[name] ?? null;
}
