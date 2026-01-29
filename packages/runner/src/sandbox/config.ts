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
    // Note: mathTaming and dateTaming were removed in SES ≥1.11.0.
    // Math.random() and Date.now() are available because we pass the
    // real Math and Date objects as compartment globals (see runtime-globals.ts).
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
