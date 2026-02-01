/**
 * Types for SES (Secure ECMAScript) sandboxing.
 *
 * These types define the interfaces for compartment management,
 * pattern isolation, and secure execution.
 */

import type { Temporal as TemporalType } from "temporal-polyfill";

/**
 * Sandbox configuration options.
 */
export interface SandboxConfig {
  /**
   * Whether SES sandboxing is enabled.
   * When false, falls back to eval-based execution.
   * Default: false
   */
  readonly enabled: boolean;

  /**
   * Whether to enable debug mode.
   * When true, provides more detailed error messages.
   * Default: false
   */
  readonly debug: boolean;

  /**
   * Console implementation to use in the sandbox.
   * Default: uses a sandboxed console that prefixes output.
   */
  readonly console?: Console;
}

/**
 * SES lockdown options.
 * These configure how aggressively SES restricts the JavaScript environment.
 */
export interface LockdownOptions {
  /**
   * Error taming level.
   * - "safe": Errors have limited stack trace information
   * - "unsafe": Errors expose full stack traces (for debugging)
   */
  readonly errorTaming?: "safe" | "unsafe";

  /**
   * Stack trace filtering.
   * - "concise": Only shows user code frames
   * - "verbose": Shows all frames including SES internals
   */
  readonly stackFiltering?: "concise" | "verbose";

  /**
   * Whether to overwrite existing intrinsics.
   * Usually "severe" for maximum compatibility.
   */
  readonly overrideTaming?: "moderate" | "severe" | "min";

  /**
   * Whether to harden console methods.
   */
  readonly consoleTaming?: "safe" | "unsafe";
}

/**
 * Runtime globals available in pattern compartments.
 * These are the functions and values that patterns can access.
 *
 * We use `unknown` for many CommonTools types since their exact
 * types are complex and would create circular dependencies.
 */
export interface RuntimeGlobals {
  // Recipe/Pattern builders
  readonly recipe: unknown;
  readonly pattern: unknown;
  readonly patternTool: unknown;

  // Module builders
  readonly lift: unknown;
  readonly handler: unknown;
  readonly action: unknown;
  readonly derive: unknown;
  readonly computed: unknown;

  // Cell constructors
  readonly Cell: unknown;
  readonly Writable: unknown;
  readonly OpaqueCell: unknown;
  readonly Stream: unknown;
  readonly ComparableCell: unknown;
  readonly ReadonlyCell: unknown;
  readonly WriteonlyCell: unknown;
  readonly cell: unknown;
  readonly equals: unknown;

  // Built-in modules
  readonly str: unknown;
  readonly ifElse: unknown;
  readonly when: unknown;
  readonly unless: unknown;
  readonly llm: unknown;
  readonly llmDialog: unknown;
  readonly generateObject: unknown;
  readonly generateText: unknown;
  readonly fetchData: unknown;
  readonly fetchProgram: unknown;
  readonly streamData: unknown;
  readonly compileAndRun: unknown;
  readonly navigateTo: unknown;
  readonly wish: unknown;

  // Utilities
  readonly byRef: unknown;
  readonly getRecipeEnvironment: unknown;
  readonly getEntityId: unknown;

  // Constants (types vary between string and symbol)
  readonly ID: unknown;
  readonly ID_FIELD: unknown;
  readonly SELF: unknown;
  readonly TYPE: unknown;
  readonly NAME: unknown;
  readonly UI: unknown;

  // Schema utilities
  readonly schema: unknown;
  readonly toSchema: unknown;
  readonly AuthSchema: unknown;

  // Render utilities
  readonly h: unknown;

  // Standard globals (JSON, Math, Date, etc.) are provided by SES intrinsics
  readonly console: Console;

  // Temporal API (SES-safe replacement for Date.now() and new Date())
  readonly Temporal: typeof TemporalType;

  // SES-safe replacement for Math.random() — returns [0, 1)
  readonly secureRandom: () => number;

  // SES-safe replacement for crypto.randomUUID()
  readonly randomUUID: () => string;

  // Network
  // TODO(seefeld): Remove direct fetch access once patterns migrate to fetchData
  readonly fetch: typeof fetch;

  // SES utilities
  readonly harden: <T>(obj: T) => T;
}

/**
 * Error thrown when a security violation is detected.
 */
export class SandboxSecurityError extends Error {
  constructor(
    message: string,
    public readonly patternId?: string,
    public readonly attemptedOperation?: string,
  ) {
    super(message);
    this.name = "SandboxSecurityError";
  }
}
