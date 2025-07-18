/**
 * Minimal logging library for both Deno and browser environments
 *
 * @module
 * This module provides a flexible logging system with:
 * - Severity levels (debug, info, warn, error)
 * - Lazy evaluation for expensive computations
 * - Module-specific tagging with automatic detection
 * - Per-logger configuration
 * - Console styling support
 *
 * @example Typical usage - disabled by default with debug level
 * ```typescript
 * import { getLogger } from "@commontools/utils/logger";
 *
 * // Common pattern: create a debug logger that's disabled by default
 * // pass in function for lazy evaluation of parameters
 * const logger = getLogger({ enabled: false, level: "debug" });
 * logger.debug(() => ["Processing:", data]);
 * ```
 *
 * @example Basic usage
 * ```typescript
 * import { log, setLogLevel } from "@commontools/utils/logger";
 *
 * // Simple logging (uses info level by default)
 * log("Application started");
 *
 * // Change global log level
 * setLogLevel("debug");
 * ```
 *
 * @example Module-tagged logging
 * ```typescript
 * import { getLogger } from "@commontools/utils/logger";
 *
 * // Auto-detects calling module from stack trace - recommended approach
 * const logger = getLogger();
 *
 * // Logs will show: [INFO][your-module::HH:MM:SS.mmm] message
 * logger.info("Processing user data");
 * logger.debug("Cache hit for user", userId);
 * logger.warn("API rate limit approaching");
 * logger.error("Failed to save user", error);
 * ```
 *
 * @example Lazy evaluation for expensive operations
 * ```typescript
 * const logger = getLogger();
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
 * const debugLogger = getLogger({
 *   level: "debug",  // Show all messages for this logger
 *   enabled: true    // Explicitly enable
 * });
 *
 * // Create a disabled logger for verbose sections
 * const verboseLogger = getLogger({ enabled: false });
 *
 * // Enable/disable at runtime
 * verboseLogger.disabled = false; // Now it will log
 * verboseLogger.info("This will show");
 * ```
 */

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
 * Current minimum log level - messages below this level are ignored
 */
let currentLogLevel: LogLevel = "info";

/**
 * Initialize log level from environment variable if available
 */
if (typeof Deno !== "undefined") {
  try {
    const envLevel = Deno.env.get("LOG_LEVEL");
    if (envLevel && envLevel in LOG_LEVELS) {
      setLogLevel(envLevel as LogLevel);
    }
  } catch {
    // Ignore permission errors - use default log level
  }
}

/**
 * Set the minimum log level
 * @param level - The minimum level to log (debug < info < warn < error)
 */
export function setLogLevel(level: LogLevel): void {
  if (!(level in LOG_LEVELS)) {
    throw new Error(`Invalid log level: ${level}`);
  }
  currentLogLevel = level;
}

/**
 * Get the current log level
 */
export function getLogLevel(): LogLevel {
  return currentLogLevel;
}

/**
 * Check if a message at the given level should be logged
 */
function shouldLog(level: LogLevel, loggerLevel?: LogLevel): boolean {
  const effectiveLevel = loggerLevel ?? currentLogLevel;
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
 * Basic log function that accepts any message(s) and logs them to the console
 * Messages can be values or zero-arity functions that return values (for lazy evaluation)
 * @param messages - The messages to log
 */
export function log(...messages: LogMessage[]): void {
  log.info(...messages);
}

/**
 * Log a debug message
 */
log.debug = function (...messages: LogMessage[]): void {
  if (shouldLog("debug")) {
    console.debug(
      `%c[DEBUG][${getTimeStamp()}]`,
      LOG_COLORS.debug,
      ...resolveMessages(messages),
    );
  }
};

/**
 * Log an info message
 */
log.info = function (...messages: LogMessage[]): void {
  if (shouldLog("info")) {
    console.log(
      `%c[INFO][${getTimeStamp()}]`,
      LOG_COLORS.info,
      ...resolveMessages(messages),
    );
  }
};

/**
 * Log a warning message
 */
log.warn = function (...messages: LogMessage[]): void {
  if (shouldLog("warn")) {
    console.warn(
      `%c[WARN][${getTimeStamp()}]`,
      LOG_COLORS.warn,
      ...resolveMessages(messages),
    );
  }
};

/**
 * Log an error message
 */
log.error = function (...messages: LogMessage[]): void {
  if (shouldLog("error")) {
    console.error(
      `%c[ERROR][${getTimeStamp()}]`,
      LOG_COLORS.error,
      ...resolveMessages(messages),
    );
  }
};

/**
 * Tagged logger interface - same as log but with module name prefix
 */
export interface TaggedLogger {
  (...messages: LogMessage[]): void;
  debug: (...messages: LogMessage[]) => void;
  info: (...messages: LogMessage[]) => void;
  warn: (...messages: LogMessage[]) => void;
  error: (...messages: LogMessage[]) => void;

  /**
   * Controls whether this logger instance is disabled.
   * - undefined: Use default behavior (currently enabled, future: check config)
   * - true: Explicitly disabled, all logs are skipped
   * - false: Explicitly enabled, all logs are shown
   *
   * When undefined, future versions can check global config for this module.
   * Explicit true/false values will always override any global config.
   */
  disabled: boolean | undefined;
}

/**
 * Extract module name from import.meta.url
 * Examples:
 * - file:///path/to/utils/math.ts → "math"
 * - file:///path/to/index.ts → "index"
 * - https://example.com/module.js → "module"
 */
function extractModuleName(url: string): string {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    const filename = pathname.split("/").pop() || "unknown";
    // Remove extension
    const moduleName = filename.replace(/\.[^.]+$/, "");
    return moduleName;
  } catch {
    return "unknown";
  }
}

/**
 * Extract caller's file URL from stack trace
 */
function getCallerUrl(): string | undefined {
  const error = new Error();
  const stack = error.stack;

  if (!stack) return undefined;

  // Parse stack trace to find the caller
  // Stack trace format: "at functionName (file:///path/to/file.ts:line:col)"
  const lines = stack.split("\n");

  // Skip first 3 lines: Error message, getCallerUrl, and getLogger
  for (let i = 3; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/at\s+.*?\s+\((.*?):\d+:\d+\)|at\s+(.*?):\d+:\d+/);
    if (match) {
      const url = match[1] || match[2];
      if (url && !url.includes("/logger.ts")) {
        return url;
      }
    }
  }

  return undefined;
}

/**
 * Options for creating a tagged logger
 */
export interface GetLoggerOptions {
  /**
   * The import.meta.url from the calling module (optional - will auto-detect if not provided)
   */
  url?: string;
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
 * Create a logger tagged with the calling module name
 * @param options - Options for configuring the logger
 * @returns A logger that prefixes all messages with [moduleName]
 */
export function getLogger(options?: GetLoggerOptions): TaggedLogger {
  const url = options?.url || getCallerUrl() || "unknown";
  const tag = extractModuleName(url);

  // Set initial disabled state from options
  const initialDisabled = options?.enabled === undefined
    ? undefined
    : !options.enabled;

  // Set logger-specific level if provided
  const loggerLevel = options?.level;

  const taggedLog: TaggedLogger = (...messages: LogMessage[]) => {
    // Check disabled state - undefined means enabled
    if (taggedLog.disabled === true) return;
    if (shouldLog("info", loggerLevel)) {
      console.log(
        `%c[INFO][${tag}::${getTimeStamp()}]`,
        LOG_COLORS.taggedInfo,
        ...resolveMessages(messages),
      );
    }
  };

  taggedLog.debug = (...messages: LogMessage[]) => {
    // Check disabled state first to skip everything including lazy eval
    if (taggedLog.disabled === true) return;
    if (shouldLog("debug", loggerLevel)) {
      console.debug(
        `%c[DEBUG][${tag}::${getTimeStamp()}]`,
        LOG_COLORS.taggedDebug,
        ...resolveMessages(messages),
      );
    }
  };

  taggedLog.info = (...messages: LogMessage[]) => {
    if (taggedLog.disabled === true) return;
    if (shouldLog("info", loggerLevel)) {
      console.log(
        `%c[INFO][${tag}::${getTimeStamp()}]`,
        LOG_COLORS.taggedInfo,
        ...resolveMessages(messages),
      );
    }
  };

  taggedLog.warn = (...messages: LogMessage[]) => {
    if (taggedLog.disabled === true) return;
    if (shouldLog("warn", loggerLevel)) {
      console.warn(
        `%c[WARN][${tag}::${getTimeStamp()}]`,
        LOG_COLORS.taggedWarn,
        ...resolveMessages(messages),
      );
    }
  };

  taggedLog.error = (...messages: LogMessage[]) => {
    if (taggedLog.disabled === true) return;
    if (shouldLog("error", loggerLevel)) {
      console.error(
        `%c[ERROR][${tag}::${getTimeStamp()}]`,
        LOG_COLORS.taggedError,
        ...resolveMessages(messages),
      );
    }
  };

  // Set the disabled property
  taggedLog.disabled = initialDisabled;

  return taggedLog;
}
