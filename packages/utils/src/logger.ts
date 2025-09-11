/**
 * Minimal logging library for both Deno and browser environments
 *
 * @module
 * This module provides a flexible logging system with:
 * - Severity levels (debug, info, warn, error)
 * - Lazy evaluation for expensive computations
 * - Module-specific tagging with module names
 * - Per-logger configuration
 * - Console styling support
 *
 * @example Typical usage - disabled by default with debug level
 * ```typescript
 * import { getLogger } from "@commontools/utils/logger";
 *
 * // Common pattern: create a debug logger that's disabled by default
 * // pass in function for lazy evaluation of parameters
 * const logger = getLogger("my-module", { enabled: false, level: "debug" });
 * logger.debug(() => ["Processing:", data]);
 * ```
 *
 * @example Basic usage
 * ```typescript
 * import { log } from "@commontools/utils/logger";
 *
 * // Global logger instance - no module tag
 * log.info("Application started");
 * log.debug("Debug info"); // Won't show unless log.level = "debug"
 *
 * // Change global log level
 * log.level = "debug";
 * ```
 *
 * @example Module-tagged logging
 * ```typescript
 * import { getLogger } from "@commontools/utils/logger";
 *
 * // Explicitly specify module name - recommended approach
 * const logger = getLogger("user-service");
 *
 * // Logs will show: [INFO][user-service::HH:MM:SS.mmm] message
 * logger.log("Processing started");     // Same as logger.info()
 * logger.info("Processing user data");
 * logger.debug("Cache hit for user", userId);
 * logger.warn("API rate limit approaching");
 * logger.error("Failed to save user", error);
 * ```
 *
 * @example Lazy evaluation for expensive operations
 * ```typescript
 * const logger = getLogger("data-processor");
 *
 * // Function is only called if debug level is active
 * logger.debug(() => `Computed value: ${expensiveComputation()}`);
 *
 * // Works with arrays that get flattened
 * logger.info(() => ["Processing", count, "items"]);
 * ```
 *
 * @example Per-logger configuration
 * ```typescript
 * // Create a debug logger for development
 * const debugLogger = getLogger("debug-module", {
 *   level: "debug",  // Show all messages for this logger
 *   enabled: true    // Explicitly enable
 * });
 *
 * // Create a disabled logger for verbose sections
 * const verboseLogger = getLogger("verbose-module", { enabled: false });
 *
 * // Enable/disable at runtime
 * verboseLogger.disabled = false; // Now it will log
 * verboseLogger.info("This will show");
 * ```
 */

import { isDeno } from "@commontools/utils/env";

export type LogMessage = unknown | (() => unknown);

export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Numeric values for log levels to enable comparison
 */
const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Colors for each log level
 */
export const LOG_COLORS = {
  debug: "color: #6b7280",
  info: "color: #6b7280",
  warn: "color: #eab308",
  error: "color: #ef4444",
  // Tagged logger colors
  taggedDebug: "color: #6b7280; font-weight: 500",
  taggedInfo: "color: #10b981; font-weight: 500",
  taggedWarn: "color: #eab308; font-weight: 500",
  taggedError: "color: #ef4444; font-weight: 500",
} as const;

/**
 * Check if a message at the given level should be logged
 */
function shouldLog(level: LogLevel, loggerLevel?: LogLevel): boolean {
  const effectiveLevel = loggerLevel ?? "info";
  return LOG_LEVELS[level] >= LOG_LEVELS[effectiveLevel];
}

/**
 * Get current time in HH:MM:SS.mmm format
 */
function getTimeStamp(): string {
  return new Date().toISOString().slice(11, 23);
}

/**
 * Resolves log messages, evaluating functions if needed
 */
function resolveMessages(messages: LogMessage[]): unknown[] {
  return messages.flatMap((msg) => {
    const resolved = typeof msg === "function" ? msg() : msg;
    // flatMap expects arrays - it will flatten array results and wrap non-arrays
    return Array.isArray(resolved) ? resolved : [resolved];
  });
}

/**
 * Options for creating a logger
 */
export interface GetLoggerOptions {
  /**
   * Whether this logger should be enabled
   * If not specified (undefined), follows default behavior
   */
  enabled?: boolean;
  /**
   * The minimum log level for this logger
   * If not specified, uses the global log level
   */
  level?: LogLevel;
}

/**
 * Logger class that handles both basic and tagged logging
 */
export class Logger {
  private _disabled: boolean;
  public level?: LogLevel;

  constructor(private moduleName?: string, options?: GetLoggerOptions) {
    // Set initial disabled state from options
    // Default to false (enabled) if not specified
    this._disabled = options?.enabled === undefined ? false : !options.enabled;

    // Set logger-specific level if provided. With exactOptionalPropertyTypes,
    // avoid assigning undefined explicitly to optional properties.
    const resolved = options?.level ?? getEnvLevel();
    if (resolved !== undefined) this.level = resolved;
  }

  /**
   * Controls whether this logger instance is disabled.
   * - true: Logger is disabled, all logs are skipped
   * - false: Logger is enabled, logs are shown based on level (default)
   */
  get disabled(): boolean {
    return this._disabled;
  }

  set disabled(value: boolean) {
    this._disabled = value;
  }

  /**
   * Get the prefix and color for a log level
   */
  private getLogFormat(level: LogLevel): { prefix: string; color: string } {
    const levelUpper = level.toUpperCase();
    const timestamp = getTimeStamp();

    if (this.moduleName) {
      const prefix = `%c[${levelUpper}][${this.moduleName}::${timestamp}]`;
      const color = LOG_COLORS[
        `tagged${
          levelUpper.charAt(0) + level.slice(1)
        }` as keyof typeof LOG_COLORS
      ];
      return { prefix, color };
    } else {
      const prefix = `%c[${levelUpper}][${timestamp}]`;
      const color = LOG_COLORS[level];
      return { prefix, color };
    }
  }

  /**
   * Log a debug message
   */
  debug(...messages: LogMessage[]): void {
    if (this._disabled) return;
    if (shouldLog("debug", this.level)) {
      const { prefix, color } = this.getLogFormat("debug");
      console.debug(prefix, color, ...resolveMessages(messages));
    }
  }

  /**
   * Log a message at info level (default logging method)
   */
  log(...messages: LogMessage[]): void {
    this.info(...messages);
  }

  /**
   * Log an info message
   */
  info(...messages: LogMessage[]): void {
    if (this._disabled) return;
    if (shouldLog("info", this.level)) {
      const { prefix, color } = this.getLogFormat("info");
      console.log(prefix, color, ...resolveMessages(messages));
    }
  }

  /**
   * Log a warning message
   */
  warn(...messages: LogMessage[]): void {
    if (this._disabled) return;
    if (shouldLog("warn", this.level)) {
      const { prefix, color } = this.getLogFormat("warn");
      console.warn(prefix, color, ...resolveMessages(messages));
    }
  }

  /**
   * Log an error message
   */
  error(...messages: LogMessage[]): void {
    if (this._disabled) return;
    if (shouldLog("error", this.level)) {
      const { prefix, color } = this.getLogFormat("error");
      console.error(prefix, color, ...resolveMessages(messages));
    }
  }
}

/**
 * Global logger instance for basic logging
 */
export const log = new Logger();

/**
 * We may want to initialize log level from environment variable if available
 */
function getEnvLevel() {
  if (isDeno()) {
    try {
      const envLevel = Deno.env.get("LOG_LEVEL");
      if (envLevel && envLevel in LOG_LEVELS) {
        return envLevel as LogLevel;
      }
    } catch {
      // Ignore permission errors - use default log level
    }
  }
  return undefined;
}

/**
 * Create a logger tagged with the specified module name
 * @param moduleName - The name of the module (will appear in log messages)
 * @param options - Options for configuring the logger
 * @returns A logger that prefixes all messages with [moduleName]
 */
export function getLogger(
  moduleName: string,
  options?: GetLoggerOptions,
): Logger {
  return new Logger(moduleName, options);
}
