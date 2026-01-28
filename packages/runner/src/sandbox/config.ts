/**
 * Configuration for SES sandboxing.
 */

import type { LockdownOptions, SandboxConfig } from "./types.ts";

/**
 * Environment variable to enable SES sandboxing.
 */
export const SES_ENABLED_ENV = "SES_ENABLED";

/**
 * Environment variable to enable debug mode.
 */
export const COMMON_TOOLS_DEBUG_ENV = "COMMON_TOOLS_DEBUG";

/**
 * Check if SES sandboxing is enabled via environment variable.
 *
 * SES sandboxing can be enabled by setting SES_ENABLED=true
 */
export function isSESEnabled(): boolean {
  // Check Deno environment
  if (typeof Deno !== "undefined") {
    try {
      const value = Deno.env.get(SES_ENABLED_ENV);
      return value === "true" || value === "1";
    } catch {
      // Permission denied or not available
      return false;
    }
  }

  // In non-Deno environments, default to disabled
  return false;
}

/**
 * Check if debug mode is enabled via environment variable.
 */
export function isDebugEnabled(): boolean {
  // Check Deno environment
  if (typeof Deno !== "undefined") {
    try {
      const value = Deno.env.get(COMMON_TOOLS_DEBUG_ENV);
      return value === "true" || value === "1";
    } catch {
      return false;
    }
  }

  // In non-Deno environments, default to disabled
  return false;
}

/**
 * Get the default sandbox configuration.
 */
export function getDefaultSandboxConfig(): SandboxConfig {
  return {
    enabled: isSESEnabled(),
    debug: isDebugEnabled(),
  };
}

/**
 * Get the default lockdown options for SES.
 *
 * These options balance security with developer experience:
 * - In debug mode: more verbose error messages
 * - In production mode: safer defaults
 */
export function getDefaultLockdownOptions(): LockdownOptions {
  const debug = isDebugEnabled();

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
