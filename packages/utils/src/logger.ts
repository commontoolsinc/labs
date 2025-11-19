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
 * - Call counting and metrics tracking
 * - Automatic periodic count summaries
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
 *
 * @example Call counting and metrics
 * ```typescript
 * const logger = getLogger("metrics-test");
 *
 * logger.info("Event 1");
 * logger.info("Event 2");
 * logger.warn("Warning");
 *
 * // Check counts (increments even when logger is disabled or filtered)
 * console.log(logger.counts);
 * // { debug: 0, info: 2, warn: 1, error: 0, total: 3 }
 *
 * // Reset individual logger counts
 * logger.resetCounts();
 *
 * // Get total across ALL loggers (in TypeScript/Deno)
 * import { getTotalLoggerCounts } from "@commontools/utils/logger";
 * const total = getTotalLoggerCounts(); // Sum of all logger counts
 *
 * // Get breakdown by logger name with total (in TypeScript/Deno)
 * import { getLoggerCountsBreakdown } from "@commontools/utils/logger";
 * const breakdown = getLoggerCountsBreakdown();
 * // { "module-1": 450, "module-2": 320, "module-3": 472, total: 1242 }
 *
 * // Reset all logger counts (in TypeScript/Deno)
 * import { resetAllLoggerCounts } from "@commontools/utils/logger";
 * resetAllLoggerCounts();
 * ```
 *
 * @example Browser console usage for metrics
 * ```javascript
 * // Get breakdown of all logger counts by name
 * globalThis.commontools.getLoggerCountsBreakdown()
 * // Returns: { "module-1": 450, "module-2": 320, total: 770 }
 *
 * // Get just the total count
 * globalThis.commontools.getTotalLoggerCounts()
 * // Returns: 770
 *
 * // Reset all counts
 * globalThis.commontools.resetAllLoggerCounts()
 *
 * // Access individual loggers
 * globalThis.commontools.logger["module-name"].counts
 * // Returns: { debug: 5, info: 10, warn: 2, error: 1, total: 18 }
 *
 * // Reset specific logger
 * globalThis.commontools.logger["module-name"].resetCounts()
 * ```
 *
 * @example Automatic count summaries
 * ```typescript
 * // By default, logs a debug message every 100 calls
 * const logger = getLogger("my-module");
 * // After 100 calls: [DEBUG][my-module::HH:MM:SS.mmm] my-module: 100 log calls made (debug: 20, info: 50, warn: 25, error: 5)
 *
 * // Customize the threshold
 * const customLogger = getLogger("custom-module", { logCountEvery: 50 });
 * // Logs summary every 50 calls instead
 *
 * // Disable automatic summaries
 * const quietLogger = getLogger("quiet-module", { logCountEvery: 0 });
 * // No automatic summaries (but counts still tracked)
 *
 * // Note: Summary logs don't increment counters and only appear when
 * // logger is enabled and debug level is active
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
  /**
   * Log a debug message every N total calls showing count breakdown.
   * Set to 0 to disable. Defaults to 100.
   */
  logCountEvery?: number;
}

/**
 * Call counts for each log level
 */
export interface LogCounts {
  debug: number;
  info: number;
  warn: number;
  error: number;
  readonly total: number;
}

/**
 * Logger class that handles both basic and tagged logging
 */
export class Logger {
  private _disabled: boolean;
  public level?: LogLevel;
  private _counts: { debug: number; info: number; warn: number; error: number };
  private _logCountEvery: number;
  private _lastLoggedAt: number;

  constructor(private moduleName?: string, options?: GetLoggerOptions) {
    // Set initial disabled state from options
    // Default to false (enabled) if not specified
    this._disabled = options?.enabled === undefined ? false : !options.enabled;

    // Set logger-specific level if provided; default to "info" when unset.
    // This keeps behavior consistent and avoids assigning undefined with
    // exactOptionalPropertyTypes enabled.
    this.level = options?.level ?? getEnvLevel() ?? "info";

    // Initialize call counts
    this._counts = { debug: 0, info: 0, warn: 0, error: 0 };

    // Set logCountEvery threshold (default to 100, 0 to disable)
    this._logCountEvery = options?.logCountEvery ?? 100;
    this._lastLoggedAt = 0;
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
   * Get the call counts for each log level, including a computed total.
   * Counts are incremented even when the logger is disabled or the log level
   * filters out the message.
   */
  get counts(): LogCounts {
    return {
      debug: this._counts.debug,
      info: this._counts.info,
      warn: this._counts.warn,
      error: this._counts.error,
      get total(): number {
        return this.debug + this.info + this.warn + this.error;
      },
    };
  }

  /**
   * Reset all call counts to zero
   */
  resetCounts(): void {
    this._counts.debug = 0;
    this._counts.info = 0;
    this._counts.warn = 0;
    this._counts.error = 0;
  }

  /**
   * Check if we should log the count summary and do so if needed.
   * This is called after incrementing the counter.
   */
  private maybeLogCountSummary(): void {
    // Skip if disabled or logCountEvery is 0
    if (this._logCountEvery === 0) return;

    const total = this.counts.total;
    const threshold = Math.floor(total / this._logCountEvery);

    // Check if we've crossed a new threshold
    if (threshold > this._lastLoggedAt) {
      this._lastLoggedAt = threshold;

      // Only log if debug level is enabled
      if (shouldLog("debug", this.level)) {
        const { prefix, color } = this.getLogFormat("debug");
        const moduleName = this.moduleName || "logger";
        const message =
          `${moduleName}: ${total} log calls made (debug: ${this._counts.debug}, info: ${this._counts.info}, warn: ${this._counts.warn}, error: ${this._counts.error})`;
        console.debug(prefix, color, message);
      }
    }
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
    this._counts.debug++;
    if (this._disabled) return;
    this.maybeLogCountSummary();
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
    this._counts.info++;
    if (this._disabled) return;
    this.maybeLogCountSummary();
    if (shouldLog("info", this.level)) {
      const { prefix, color } = this.getLogFormat("info");
      console.log(prefix, color, ...resolveMessages(messages));
    }
  }

  /**
   * Log a warning message
   */
  warn(...messages: LogMessage[]): void {
    this._counts.warn++;
    if (this._disabled) return;
    this.maybeLogCountSummary();
    if (shouldLog("warn", this.level)) {
      const { prefix, color } = this.getLogFormat("warn");
      console.warn(prefix, color, ...resolveMessages(messages));
    }
  }

  /**
   * Log an error message
   */
  error(...messages: LogMessage[]): void {
    this._counts.error++;
    if (this._disabled) return;
    this.maybeLogCountSummary();
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
 * Create a logger tagged with the specified module name.
 * If a logger with the same module name already exists, returns the existing instance.
 * @param moduleName - The name of the module (will appear in log messages)
 * @param options - Options for configuring the logger (only used if creating a new logger)
 * @returns A logger that prefixes all messages with [moduleName]
 */
export function getLogger(
  moduleName: string,
  options?: GetLoggerOptions,
): Logger {
  // Initialize global storage if needed
  const global = globalThis as unknown as {
    commontools: { logger: Record<string, Logger> };
  };
  if (!global.commontools) {
    global.commontools = { logger: {} };
  }
  if (!global.commontools.logger) {
    global.commontools.logger = {};
  }

  // Return existing logger if one exists
  if (global.commontools.logger[moduleName]) {
    return global.commontools.logger[moduleName];
  }

  // Create and store new logger
  const logger = new Logger(moduleName, options);
  global.commontools.logger[moduleName] = logger;

  return logger;
}

/**
 * Reset call counts for all registered loggers.
 * Iterates through all loggers in globalThis.commontools.logger and resets their counts.
 */
export function resetAllLoggerCounts(): void {
  const global = globalThis as unknown as {
    commontools?: { logger?: Record<string, Logger> };
  };
  if (global.commontools?.logger) {
    Object.values(global.commontools.logger).forEach((logger) =>
      logger.resetCounts()
    );
  }
}

/**
 * Get the total count of all log calls across all registered loggers.
 * @returns The sum of all log calls (debug + info + warn + error) across all loggers
 */
export function getTotalLoggerCounts(): number {
  const global = globalThis as unknown as {
    commontools?: { logger?: Record<string, Logger> };
  };
  if (!global.commontools?.logger) {
    return 0;
  }
  return Object.values(global.commontools.logger)
    .reduce((sum, logger) => sum + logger.counts.total, 0);
}

/**
 * Get a breakdown of log counts by logger name, plus a total.
 * @returns Object with counts per logger and a total property
 */
export function getLoggerCountsBreakdown(): Record<string, number> & {
  total: number;
} {
  const global = globalThis as unknown as {
    commontools?: { logger?: Record<string, Logger> };
  };

  const breakdown: Record<string, number> = {};
  let total = 0;

  if (global.commontools?.logger) {
    for (const [name, logger] of Object.entries(global.commontools.logger)) {
      const count = logger.counts.total;
      breakdown[name] = count;
      total += count;
    }
  }

  return { ...breakdown, total };
}

// Make helper functions available globally for browser console access
if (typeof globalThis !== "undefined") {
  const global = globalThis as unknown as {
    commontools: {
      logger: Record<string, Logger>;
      getTotalLoggerCounts?: typeof getTotalLoggerCounts;
      getLoggerCountsBreakdown?: typeof getLoggerCountsBreakdown;
      resetAllLoggerCounts?: typeof resetAllLoggerCounts;
    };
  };
  if (!global.commontools) {
    global.commontools = { logger: {} } as typeof global.commontools;
  }
  global.commontools.getTotalLoggerCounts = getTotalLoggerCounts;
  global.commontools.getLoggerCountsBreakdown = getLoggerCountsBreakdown;
  global.commontools.resetAllLoggerCounts = resetAllLoggerCounts;
}
