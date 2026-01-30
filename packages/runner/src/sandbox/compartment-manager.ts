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

import type { LockdownOptions, SandboxConfig } from "./types.ts";
import { SandboxSecurityError } from "./types.ts";
import { getDefaultLockdownOptions, resolveSandboxConfig } from "./config.ts";
// IMPORTANT: pre-lockdown-intrinsics must be imported before "ses" so that
// Date/Math are captured before SES tames them.
import "./pre-lockdown-intrinsics.ts";
import { createRuntimeGlobals } from "./runtime-globals.ts";
import { createSilentConsole } from "./sandboxed-console.ts";
import "ses";

// SES adds lockdown, Compartment, harden to globalThis
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
 * CompartmentManager manages SES lockdown and provides sandboxed evaluation.
 *
 * Key features:
 * - Lazy lockdown: SES lockdown is applied on first use
 * - Sandboxed globals: Evaluated code only has access to allowed APIs
 *
 * @example
 * ```typescript
 * const manager = new CompartmentManager({ enabled: true });
 * manager.initialize();
 * const result = manager.evaluateStringSync("(() => 42)()");
 * ```
 */
export class CompartmentManager {
  private static lockdownApplied = false;
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
  initialize(): void {
    if (!this.config.enabled) {
      return;
    }
    this.ensureLockdown();
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
  private ensureLockdown(): void {
    if (CompartmentManager.lockdownApplied) {
      return;
    }

    // Apply lockdown with configured options
    const options = getDefaultLockdownOptions(this.config.debug);

    // Pre-remove configurable intrinsics that SES would warn about.
    // If SES starts warning about NEW intrinsics, those warnings will
    // surface and we should add them here.
    // deno-lint-ignore no-explicit-any
    const g = globalThis as any;
    delete g.Math?.f16round;

    // Symbol.metadata is not configurable so SES can't remove it and
    // logs a warning via console.error. Buffer SES messages during lockdown
    // and replay any that aren't about the known Symbol%.metadata removal,
    // so new intrinsic warnings still surface.
    const buffered: unknown[][] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      buffered.push(args);
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

      // Replay any messages that aren't about the known Symbol%.metadata removal
      const unknown = buffered.filter((args) => {
        const msg = args.map(String).join(" ");
        return !msg.includes("Symbol%.metadata") &&
          !msg.includes("Removing unpermitted intrinsics");
      });
      // If there are unknown intrinsic removals, replay all messages
      // (including the header) so the full context is visible
      if (unknown.length > 0) {
        for (const args of buffered) {
          origError.apply(console, args);
        }
      }
    }
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
  defaultManager = undefined;
}
