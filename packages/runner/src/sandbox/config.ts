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
    // SES always tames Date/Math (no-arg new Date() throws, Math.random()
    // returns NaN). We work around this by capturing the original Date/Math
    // before lockdown (see pre-lockdown-intrinsics.ts) and passing them as
    // compartment globals (see runtime-globals.ts).
    // TODO(seefeld): Remove the pre-lockdown intrinsics workaround once we
    // lock down Date and Math.random again (patterns should not use them).
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
