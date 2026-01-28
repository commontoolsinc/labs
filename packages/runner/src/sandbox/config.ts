/**
 * Configuration for SES sandboxing.
 */

import type { LockdownOptions, SandboxConfig } from "./types.ts";

/**
 * Get the default sandbox configuration.
 */
export function getDefaultSandboxConfig(): SandboxConfig {
  return {
    enabled: true,
    debug: false,
  };
}

/**
 * Get the default lockdown options for SES.
 *
 * These options balance security with developer experience:
 * - In debug mode: more verbose error messages
 * - In production mode: safer defaults
 */
export function getDefaultLockdownOptions(debug = false): LockdownOptions {
  return {
    // Error taming: "unsafe" shows full stack traces for debugging
    errorTaming: debug ? "unsafe" : "safe",

    // Stack filtering: "verbose" shows all frames including SES internals
    stackFiltering: debug ? "verbose" : "concise",

    // Override taming: "severe" for maximum compatibility
    overrideTaming: "severe",

    // Console taming: "unsafe" preserves console functionality
    consoleTaming: "unsafe",
  };
}

/**
 * Merge user-provided config with defaults.
 */
export function resolveSandboxConfig(
  userConfig?: Partial<SandboxConfig>,
): SandboxConfig {
  const defaults = getDefaultSandboxConfig();
  return {
    ...defaults,
    ...userConfig,
  };
}
