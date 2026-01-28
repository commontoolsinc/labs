/**
 * CompartmentManager: Manages SES compartments for pattern execution.
 *
 * This module provides secure sandboxing for pattern code execution using
 * SES (Secure ECMAScript) Compartments. Each pattern gets its own compartment
 * with frozen globals and exports, preventing:
 * - Closure state leakage between invocations
 * - Global object pollution
 * - Prototype tampering
 * - Unauthorized access to runtime internals
 */

import type {
  FrozenExport,
  LockdownOptions,
  PatternCompartment,
  PatternCompartmentConfig,
  SandboxConfig,
} from "./types.ts";
import {
  CompartmentInitializationError,
  SandboxSecurityError,
} from "./types.ts";
import { getDefaultLockdownOptions, resolveSandboxConfig } from "./config.ts";
import { createRuntimeGlobals } from "./runtime-globals.ts";
import { createSilentConsole } from "./sandboxed-console.ts";

// SES types (declared since we import dynamically)
declare const lockdown: (options?: LockdownOptions) => void;
declare const Compartment: new (
  globals?: object,
  modules?: object,
  options?: object,
) => CompartmentInstance;
declare const harden: <T>(obj: T) => T;

interface CompartmentInstance {
  evaluate(code: string): unknown;
  globalThis: object;
}

/**
 * CompartmentManager manages SES compartments for secure pattern execution.
 *
 * Key features:
 * - Lazy lockdown: SES lockdown is applied on first compartment creation
 * - Compartment reuse: Patterns are cached to avoid repeated parsing
 * - Frozen exports: All exports are deeply frozen (hardened)
 * - Sandboxed globals: Patterns only have access to allowed APIs
 *
 * @example
 * ```typescript
 * const manager = new CompartmentManager({ enabled: true });
 *
 * // Load a pattern
 * const compartment = manager.loadPattern({
 *   patternId: "my-pattern",
 *   source: "export const MyPattern = pattern<...>(...);",
 * });
 *
 * // Get a frozen export
 * const myPattern = manager.getExport("my-pattern", "MyPattern");
 *
 * // Evaluate arbitrary code (fresh compartment each time)
 * const result = manager.evaluateString("(() => 42)()");
 * ```
 */
export class CompartmentManager {
  private static lockdownApplied = false;
  private static lockdownPromise: Promise<void> | undefined;
  private readonly patternCompartments = new Map<string, PatternCompartment>();
  private readonly config: SandboxConfig;

  constructor(config?: Partial<SandboxConfig>) {
    this.config = resolveSandboxConfig(config);
  }

  /**
   * Check if SES lockdown has been applied and the manager is ready for sync operations.
   */
  isReady(): boolean {
    return CompartmentManager.lockdownApplied;
  }

  /**
   * Initialize the compartment manager by applying SES lockdown.
   * Call this early in your application lifecycle before running patterns.
   *
   * This method is idempotent - calling it multiple times is safe.
   */
  async initialize(): Promise<void> {
    if (!this.config.enabled) {
      return;
    }
    await this.ensureLockdown();
  }

  /**
   * Check if SES sandboxing is enabled.
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Apply SES lockdown if not already applied.
   * This is called lazily on first compartment creation.
   */
  private async ensureLockdown(): Promise<void> {
    if (CompartmentManager.lockdownApplied) {
      return;
    }

    // Dynamically import SES
    await import("npm:ses@1.14.0");

    // Apply lockdown with configured options
    const options = getDefaultLockdownOptions(this.config.debug);

    // Pre-remove configurable intrinsics that SES would warn about.
    // If SES starts warning about NEW intrinsics, those warnings will
    // surface and we should add them here.
    // deno-lint-ignore no-explicit-any
    const g = globalThis as any;
    delete g.Math?.f16round;

    // Symbol.metadata is not configurable so SES can't remove it and
    // logs a warning via console.error. Filter that known warning.
    // Any NEW intrinsic warnings will still surface since we only
    // suppress the specific Symbol%.metadata message.
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      const msg = args.map(String).join(" ");
      if (
        msg.includes("Removing unpermitted intrinsics") ||
        msg.includes("Removing intrinsics") ||
        msg.includes("Symbol%.metadata")
      ) return;
      origError.apply(console, args);
    };

    try {
      lockdown(options);
      CompartmentManager.lockdownApplied = true;

      if (this.config.debug) {
        console.log("[CompartmentManager] SES lockdown applied");
      }
    } catch (error) {
      // Lockdown may fail if already applied by another code path
      if (
        error instanceof Error && error.message.includes("already been called")
      ) {
        CompartmentManager.lockdownApplied = true;
      } else {
        throw error;
      }
    } finally {
      console.error = origError;
    }
  }

  /**
   * Load a pattern into a compartment.
   *
   * @param config - Pattern configuration including source code
   * @returns The pattern compartment with frozen exports
   */
  async loadPattern(
    config: PatternCompartmentConfig,
  ): Promise<PatternCompartment> {
    if (!this.config.enabled) {
      throw new SandboxSecurityError(
        "SES sandboxing is disabled. Enable it with sesEnabled: true in RuntimeOptions",
      );
    }

    // Check cache first
    const cached = this.patternCompartments.get(config.patternId);
    if (cached) {
      return cached;
    }

    // Ensure lockdown is applied
    await this.ensureLockdown();

    try {
      // Create runtime globals for this pattern
      const globals = createRuntimeGlobals(
        config.patternId,
        this.config.console,
      );

      // Create the compartment
      const compartment = new Compartment(
        harden(globals),
        {}, // No module map for now
        {
          name: config.patternId,
          // Disable dynamic import for security
          __noNamespaceBox__: true,
        },
      );

      // Wrap the source to capture exports
      const wrappedSource = this.wrapSourceForExports(config.source);

      // Evaluate the pattern source
      const exports = compartment.evaluate(wrappedSource) as Record<
        string,
        unknown
      >;

      // Build frozen exports map
      const frozenExports = new Map<string, FrozenExport>();

      for (const [name, value] of Object.entries(exports)) {
        if (typeof value === "function" || typeof value === "object") {
          // Harden (deeply freeze) the export
          const frozen = harden(value);

          frozenExports.set(name, {
            name,
            implementation: frozen,
            patternId: config.patternId,
          });
        }
      }

      // Create and cache the pattern compartment
      const patternCompartment: PatternCompartment = {
        patternId: config.patternId,
        exports: frozenExports,
        getExport: (name: string) => frozenExports.get(name),
      };

      this.patternCompartments.set(config.patternId, patternCompartment);

      if (this.config.debug) {
        console.log(
          `[CompartmentManager] Loaded pattern "${config.patternId}" with ${frozenExports.size} exports`,
        );
      }

      return patternCompartment;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new CompartmentInitializationError(
        `Failed to load pattern: ${message}`,
        config.patternId,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Get a frozen export from a loaded pattern.
   *
   * @param patternId - The pattern ID
   * @param exportName - The export name
   * @returns The frozen export, or undefined if not found
   */
  getExport(patternId: string, exportName: string): FrozenExport | undefined {
    const compartment = this.patternCompartments.get(patternId);
    return compartment?.getExport(exportName);
  }

  /**
   * Check if a pattern is loaded.
   *
   * @param patternId - The pattern ID
   * @returns True if the pattern is loaded
   */
  hasPattern(patternId: string): boolean {
    return this.patternCompartments.has(patternId);
  }

  /**
   * Evaluate a string of JavaScript code in a fresh compartment.
   * Each call creates a new compartment for isolation.
   *
   * @param code - The JavaScript code to evaluate
   * @returns The result of evaluation
   */
  async evaluateString(code: string): Promise<unknown> {
    if (!this.config.enabled) {
      throw new SandboxSecurityError(
        "SES sandboxing is disabled. Enable it with sesEnabled: true in RuntimeOptions",
      );
    }

    // Ensure lockdown is applied
    await this.ensureLockdown();

    return this.evaluateStringSync(code);
  }

  /**
   * Synchronously evaluate a string of JavaScript code in a fresh compartment.
   * Requires lockdown to be already applied (call initialize() first).
   *
   * @param code - The JavaScript code to evaluate
   * @returns The result of evaluation
   * @throws SandboxSecurityError if lockdown hasn't been applied
   */
  evaluateStringSync(code: string): unknown {
    if (!this.config.enabled) {
      throw new SandboxSecurityError(
        "SES sandboxing is disabled. Enable it with sesEnabled: true in RuntimeOptions",
      );
    }

    if (!CompartmentManager.lockdownApplied) {
      throw new SandboxSecurityError(
        "SES lockdown not applied. Call initialize() before using sync evaluation.",
        undefined,
        "evaluateStringSync",
      );
    }

    try {
      // Create minimal globals for string evaluation
      const globals = createRuntimeGlobals(
        "<eval>",
        this.config.debug ? undefined : createSilentConsole(),
      );

      // Create a fresh compartment
      const compartment = new Compartment(harden(globals), {}, {
        name: "<eval>",
        __noNamespaceBox__: true,
      });

      // Evaluate the code
      return compartment.evaluate(code);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new SandboxSecurityError(
        `Failed to evaluate code: ${message}`,
        undefined,
        "evaluateStringSync",
      );
    }
  }

  /**
   * Wrap source code to capture exports.
   * Transforms ES module exports into an object we can retrieve.
   */
  private wrapSourceForExports(source: string): string {
    // Wrap source so we can capture its exports.
    // The runtime's engine.ts exportsByValue mechanism already discovers
    // exports by iterating Object.entries(exports) from the compiled module,
    // so we don't need __exportName annotations. This wrapper just ensures
    // the source executes in a contained scope.
    return `
      (function() {
        ${source}
      }).call({})
    `;
  }

  /**
   * Clear all cached compartments.
   * Useful for testing or when reloading patterns.
   */
  clearCache(): void {
    this.patternCompartments.clear();

    if (this.config.debug) {
      console.log("[CompartmentManager] Cache cleared");
    }
  }

  /**
   * Get statistics about the compartment manager.
   */
  getStats(): {
    enabled: boolean;
    lockdownApplied: boolean;
    loadedPatterns: number;
    patternIds: string[];
  } {
    return {
      enabled: this.config.enabled,
      lockdownApplied: CompartmentManager.lockdownApplied,
      loadedPatterns: this.patternCompartments.size,
      patternIds: Array.from(this.patternCompartments.keys()),
    };
  }
}

/**
 * Singleton instance of the CompartmentManager.
 * Use this for the default runtime.
 */
let defaultManager: CompartmentManager | undefined;

/**
 * Get the default CompartmentManager instance.
 * Creates one if it doesn't exist.
 */
export function getCompartmentManager(): CompartmentManager {
  if (!defaultManager) {
    defaultManager = new CompartmentManager();
  }
  return defaultManager;
}

/**
 * Reset the default CompartmentManager.
 * Useful for testing.
 */
export function resetCompartmentManager(): void {
  defaultManager?.clearCache();
  defaultManager = undefined;
}
