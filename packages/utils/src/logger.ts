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
 * logger.debug("processing-data", () => ["Processing:", data]);
 * ```
 *
 * @example Basic usage
 * ```typescript
 * import { log } from "@commontools/utils/logger";
 *
 * // Global logger instance - no module tag
 * // First parameter is always a string key for tracking
 * log.info("app-started", "Application started");
 * log.debug("debug-info", "Debug info"); // Won't show unless log.level = "debug"
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
 * // First parameter is the message key for metrics tracking
 * // Logs will show: [INFO][user-service::HH:MM:SS.mmm] key message
 * logger.log("processing-started", "Processing started");     // Same as logger.info()
 * logger.info("processing-user", "Processing user data");
 * logger.debug("cache-hit", "Cache hit for user", userId);
 * logger.warn("rate-limit", "API rate limit approaching");
 * logger.error("save-failed", "Failed to save user", error);
 * ```
 *
 * @example Lazy evaluation for expensive operations
 * ```typescript
 * const logger = getLogger("data-processor");
 *
 * // Function is only called if debug level is active
 * logger.debug("computed-value", () => `Computed value: ${expensiveComputation()}`);
 *
 * // Works with arrays that get flattened
 * logger.info("processing-items", () => ["Processing", count, "items"]);
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
 * verboseLogger.info("message-key", "This will show");
 * ```
 *
 * @example Call counting and metrics
 * ```typescript
 * const logger = getLogger("metrics-test");
 *
 * logger.info("event-1", "Event 1");
 * logger.info("event-2", "Event 2");
 * logger.warn("warning", "Warning");
 *
 * // Check overall counts (increments even when logger is disabled or filtered)
 * console.log(logger.counts);
 * // { debug: 0, info: 2, warn: 1, error: 0, total: 3 }
 *
 * // Check counts by message key
 * console.log(logger.countsByKey);
 * // { "event-1": { debug: 0, info: 1, warn: 0, error: 0, total: 1 }, ... }
 *
 * // Reset individual logger counts
 * logger.resetCounts();
 *
 * // Get total across ALL loggers (in TypeScript/Deno)
 * import { getTotalLoggerCounts } from "@commontools/utils/logger";
 * const total = getTotalLoggerCounts(); // Sum of all logger counts
 *
 * // Get breakdown by logger and message key (in TypeScript/Deno)
 * import { getLoggerCountsBreakdown } from "@commontools/utils/logger";
 * const breakdown = getLoggerCountsBreakdown();
 * // {
 * //   "module-1": {
 * //     "user-login": { debug: 5, info: 10, warn: 2, error: 0, total: 17 },
 * //     "data-fetch": { debug: 2, info: 5, warn: 0, error: 1, total: 8 },
 * //     total: 25
 * //   },
 * //   total: 25
 * // }
 *
 * // Reset all logger counts (in TypeScript/Deno)
 * import { resetAllLoggerCounts } from "@commontools/utils/logger";
 * resetAllLoggerCounts();
 * ```
 *
 * @example Browser console usage for metrics
 * ```javascript
 * // Get breakdown of all logger counts by name and message key
 * globalThis.commontools.getLoggerCountsBreakdown()
 * // Returns: {
 * //   "module-1": {
 * //     "user-login": { debug: 5, info: 10, warn: 2, error: 0, total: 17 },
 * //     total: 17
 * //   },
 * //   total: 17
 * // }
 *
 * // Get just the total count
 * globalThis.commontools.getTotalLoggerCounts()
 * // Returns: 17
 *
 * // Reset all counts
 * globalThis.commontools.resetAllLoggerCounts()
 *
 * // Access individual logger counts
 * globalThis.commontools.logger["module-name"].counts
 * // Returns: { debug: 5, info: 10, warn: 2, error: 1, total: 18 }
 *
 * // Access individual logger counts by key
 * globalThis.commontools.logger["module-name"].countsByKey
 * // Returns: { "user-login": { debug: 5, info: 10, warn: 2, error: 0, total: 17 }, ... }
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
 * Histogram bucket data for timing visualization
 */
export interface TimingHistogramBucket {
  lowerBound: number; // Lower bound of bucket (ms)
  upperBound: number; // Upper bound of bucket (ms)
  count: number; // Number of samples in this bucket
  totalTime: number; // Sum of all samples in this bucket (ms)
}

/**
 * Statistics for timing measurements
 */
export interface TimingStats {
  count: number; // Total measurements
  min: number; // Minimum time (ms)
  max: number; // Maximum time (ms)
  totalTime: number; // Sum for average calculation
  average: number; // totalTime / count
  p50: number; // Median (50th percentile)
  p95: number; // 95th percentile
  lastTime: number; // Most recent measurement
  lastTimestamp: number; // When last recorded
  histogram: TimingHistogramBucket[]; // 10 buckets, median at boundary 5/6
}

/**
 * Default reservoir size for timing samples.
 * 1000 samples provides good percentile accuracy with bounded memory.
 */
const TIMING_RESERVOIR_SIZE = 1000;

/**
 * Internal class for storing timing data with reservoir sampling.
 * Uses Algorithm R for random sampling to maintain representative distribution
 * with O(1) memory regardless of measurement count.
 */
class TimingDataStore {
  private count = 0;
  private min = Infinity;
  private max = -Infinity;
  private totalTime = 0;
  private lastTime = 0;
  private lastTimestamp = 0;
  private samples: number[] = [];

  /**
   * Record a timing measurement.
   * @param elapsed - The elapsed time in milliseconds
   */
  record(elapsed: number): void {
    this.count++;
    this.totalTime += elapsed;
    this.lastTime = elapsed;
    this.lastTimestamp = performance.now();

    if (elapsed < this.min) this.min = elapsed;
    if (elapsed > this.max) this.max = elapsed;

    // Reservoir sampling (Algorithm R)
    if (this.samples.length < TIMING_RESERVOIR_SIZE) {
      this.samples.push(elapsed);
    } else {
      const j = Math.floor(Math.random() * this.count);
      if (j < TIMING_RESERVOIR_SIZE) {
        this.samples[j] = elapsed;
      }
    }
  }

  /**
   * Get computed statistics from the recorded data.
   */
  getStats(): TimingStats {
    if (this.count === 0) {
      return {
        count: 0,
        min: 0,
        max: 0,
        totalTime: 0,
        average: 0,
        p50: 0,
        p95: 0,
        lastTime: 0,
        lastTimestamp: 0,
        histogram: [],
      };
    }

    // Sort samples for percentile calculation
    const sorted = [...this.samples].sort((a, b) => a - b);
    const p50Index = Math.floor(sorted.length * 0.5);
    const p95Index = Math.floor(sorted.length * 0.95);
    const median = sorted[p50Index] ?? 0;

    // Calculate 10 histogram buckets with median at 5/6 boundary
    const histogram = this.calculateHistogram(sorted, median);

    return {
      count: this.count,
      min: this.min,
      max: this.max,
      totalTime: this.totalTime,
      average: this.totalTime / this.count,
      p50: median,
      p95: sorted[p95Index] ?? sorted[sorted.length - 1] ?? 0,
      lastTime: this.lastTime,
      lastTimestamp: this.lastTimestamp,
      histogram,
    };
  }

  /**
   * Calculate 10 histogram buckets where median is at the 5/6 boundary.
   * Buckets 1-5 span [min, median], buckets 6-10 span [median, max].
   */
  private calculateHistogram(
    sorted: number[],
    median: number,
  ): TimingHistogramBucket[] {
    if (sorted.length === 0) return [];

    const buckets: TimingHistogramBucket[] = [];
    const min = sorted[0];
    const max = sorted[sorted.length - 1];

    // Create 5 buckets from min to median
    const lowerRange = median - min;
    const lowerBucketWidth = lowerRange / 5;

    for (let i = 0; i < 5; i++) {
      const lowerBound = min + i * lowerBucketWidth;
      const upperBound = i === 4 ? median : min + (i + 1) * lowerBucketWidth;
      buckets.push({
        lowerBound,
        upperBound,
        count: 0,
        totalTime: 0,
      });
    }

    // Create 5 buckets from median to max
    const upperRange = max - median;
    const upperBucketWidth = upperRange / 5;

    for (let i = 0; i < 5; i++) {
      const lowerBound = i === 0 ? median : median + i * upperBucketWidth;
      const upperBound = i === 4 ? max : median + (i + 1) * upperBucketWidth;
      buckets.push({
        lowerBound,
        upperBound,
        count: 0,
        totalTime: 0,
      });
    }

    // Fill buckets with sample data
    for (const sample of sorted) {
      // Find which bucket this sample belongs to
      let bucketIndex = -1;
      for (let i = 0; i < buckets.length; i++) {
        const bucket = buckets[i];
        // Include lower bound, exclude upper bound (except for last bucket)
        if (
          sample >= bucket.lowerBound &&
          (sample < bucket.upperBound || i === buckets.length - 1)
        ) {
          bucketIndex = i;
          break;
        }
      }

      if (bucketIndex >= 0) {
        buckets[bucketIndex].count++;
        buckets[bucketIndex].totalTime += sample;
      }
    }

    return buckets;
  }

  /**
   * Reset all timing data.
   */
  reset(): void {
    this.count = 0;
    this.min = Infinity;
    this.max = -Infinity;
    this.totalTime = 0;
    this.lastTime = 0;
    this.lastTimestamp = 0;
    this.samples = [];
  }
}

/**
 * Build all hierarchical key paths from an array of key segments.
 * @example buildKeyPaths(["cell", "get", "user"]) => ["cell", "cell/get", "cell/get/user"]
 */
function buildKeyPaths(keys: string[]): string[] {
  const paths: string[] = [];
  for (let i = 1; i <= keys.length; i++) {
    paths.push(keys.slice(0, i).join("/"));
  }
  return paths;
}

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
 * Breakdown of counts by message key for a single logger
 */
export type LoggerBreakdown = {
  [messageKey: string]: LogCounts;
} & {
  total: number;
};

/**
 * Logger class that handles both basic and tagged logging
 */
export class Logger {
  private _disabled: boolean;
  public level?: LogLevel;
  private _counts: { debug: number; info: number; warn: number; error: number };
  private _countsByKey: Record<
    string,
    { debug: number; info: number; warn: number; error: number }
  >;
  private _logCountEvery: number;
  private _lastLoggedAt: number;
  private _timingsByKey: Map<string, TimingDataStore> = new Map();
  private _activeTimers: Map<string, number> = new Map();
  private _countBaseline: {
    debug: number;
    info: number;
    warn: number;
    error: number;
  } | null = null;
  private _timingBaseline: Map<string, TimingStats> | null = null;

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
    this._countsByKey = {};

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
   * Get the call counts broken down by message key.
   * Each key contains counts for debug, info, warn, error, and a computed total.
   */
  get countsByKey(): Record<string, LogCounts> {
    const result: Record<string, LogCounts> = {};
    for (const [key, counts] of Object.entries(this._countsByKey)) {
      result[key] = {
        debug: counts.debug,
        info: counts.info,
        warn: counts.warn,
        error: counts.error,
        get total(): number {
          return this.debug + this.info + this.warn + this.error;
        },
      };
    }
    return result;
  }

  /**
   * Reset all call counts to zero (both overall and by-key counts)
   */
  resetCounts(): void {
    this._counts.debug = 0;
    this._counts.info = 0;
    this._counts.warn = 0;
    this._counts.error = 0;
    this._countsByKey = {};
    this._lastLoggedAt = 0;
  }

  /**
   * Increment the count for a specific message key and log level
   */
  private incrementKeyCount(key: string, level: LogLevel): void {
    // Skip reserved key name "total" to prevent corruption of breakdown totals
    if (key === "total") {
      console.warn(
        `[Logger] Message key "total" is reserved and cannot be used. Please use a different key.`,
      );
      return;
    }
    if (!this._countsByKey[key]) {
      this._countsByKey[key] = { debug: 0, info: 0, warn: 0, error: 0 };
    }
    this._countsByKey[key][level]++;
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
  debug(key: string, ...messages: LogMessage[]): void {
    this._counts.debug++;
    this.incrementKeyCount(key, "debug");
    if (this._disabled) return;
    this.maybeLogCountSummary();
    if (shouldLog("debug", this.level)) {
      const { prefix, color } = this.getLogFormat("debug");
      console.debug(prefix, color, key, ...resolveMessages(messages));
    }
  }

  /**
   * Log a message at info level (default logging method)
   */
  log(key: string, ...messages: LogMessage[]): void {
    this.info(key, ...messages);
  }

  /**
   * Log an info message
   */
  info(key: string, ...messages: LogMessage[]): void {
    this._counts.info++;
    this.incrementKeyCount(key, "info");
    if (this._disabled) return;
    this.maybeLogCountSummary();
    if (shouldLog("info", this.level)) {
      const { prefix, color } = this.getLogFormat("info");
      console.log(prefix, color, key, ...resolveMessages(messages));
    }
  }

  /**
   * Log a warning message
   */
  warn(key: string, ...messages: LogMessage[]): void {
    this._counts.warn++;
    this.incrementKeyCount(key, "warn");
    if (this._disabled) return;
    this.maybeLogCountSummary();
    if (shouldLog("warn", this.level)) {
      const { prefix, color } = this.getLogFormat("warn");
      console.warn(prefix, color, key, ...resolveMessages(messages));
    }
  }

  /**
   * Log an error message
   */
  error(key: string, ...messages: LogMessage[]): void {
    this._counts.error++;
    this.incrementKeyCount(key, "error");
    if (this._disabled) return;
    this.maybeLogCountSummary();
    if (shouldLog("error", this.level)) {
      const { prefix, color } = this.getLogFormat("error");
      console.error(prefix, color, key, ...resolveMessages(messages));
    }
  }

  // ============================================================
  // Timing Methods
  // ============================================================

  /**
   * Start a timer for the given key path.
   * Hierarchical keys are supported - passing multiple segments will record
   * stats at each level when timeEnd is called.
   *
   * @example
   * logger.timeStart("cell", "get", "user-data");
   * // ... operation ...
   * logger.timeEnd("cell", "get", "user-data");
   * // Records to: "cell", "cell/get", "cell/get/user-data"
   */
  timeStart(...keys: string[]): void {
    const keyPath = keys.join("/");
    this._activeTimers.set(keyPath, performance.now());
  }

  /**
   * End a timer and record the elapsed time.
   * Returns the elapsed time in milliseconds, or undefined if no matching timer exists.
   *
   * Stats are recorded to all levels of the hierarchical key path.
   */
  timeEnd(...keys: string[]): number | undefined {
    const keyPath = keys.join("/");
    const startTime = this._activeTimers.get(keyPath);
    if (startTime === undefined) {
      return undefined;
    }
    this._activeTimers.delete(keyPath);

    const elapsed = performance.now() - startTime;
    this._recordTime(elapsed, keys);
    return elapsed;
  }

  /**
   * Record a timing measurement directly.
   * Useful for measuring IPC latency or other cases where you have explicit timestamps.
   *
   * Overloads:
   * - time(startTime, ...keys) - end time defaults to performance.now()
   * - time(startTime, endTime, ...keys) - explicit end time
   *
   * @example
   * // End time defaults to now
   * logger.time(startTimestamp, "ipc", "CellGet");
   *
   * // Explicit end time
   * logger.time(startTimestamp, endTimestamp, "ipc", "CellGet");
   *
   * @returns The elapsed time in milliseconds
   */
  time(startTime: number, ...rest: (string | number)[]): number {
    let endTime: number;
    let keys: string[];

    // Determine if second argument is endTime or first key
    if (rest.length > 0 && typeof rest[0] === "number") {
      endTime = rest[0] as number;
      keys = rest.slice(1) as string[];
    } else {
      endTime = performance.now();
      keys = rest as string[];
    }

    const elapsed = endTime - startTime;
    if (keys.length > 0) {
      this._recordTime(elapsed, keys);
    }
    return elapsed;
  }

  /**
   * Internal method to record timing to all levels of a key hierarchy.
   */
  private _recordTime(elapsed: number, keys: string[]): void {
    const paths = buildKeyPaths(keys);
    for (const path of paths) {
      let store = this._timingsByKey.get(path);
      if (!store) {
        store = new TimingDataStore();
        this._timingsByKey.set(path, store);
      }
      store.record(elapsed);
    }
  }

  /**
   * Get timing statistics for a specific key path.
   * Accepts either separate key segments or a single "/" joined path.
   *
   * @example
   * logger.getTimeStats("cell", "get");  // Using segments
   * logger.getTimeStats("cell/get");     // Using joined path
   */
  getTimeStats(...keys: string[]): TimingStats | undefined {
    const keyPath = keys.join("/");
    const store = this._timingsByKey.get(keyPath);
    return store?.getStats();
  }

  /**
   * Get all timing statistics for this logger.
   * Returns a flat map with "/" joined keys.
   */
  get timeStats(): Record<string, TimingStats> {
    const result: Record<string, TimingStats> = {};
    for (const [key, store] of this._timingsByKey) {
      result[key] = store.getStats();
    }
    return result;
  }

  /**
   * Reset all timing statistics for this logger.
   */
  resetTimeStats(): void {
    this._timingsByKey.clear();
    this._activeTimers.clear();
  }

  // ============================================================
  // Baseline Methods
  // ============================================================

  /**
   * Reset the count baseline to current count values.
   * After calling this, getCountDeltas() will return counts relative to this baseline.
   */
  resetCountBaseline(): void {
    this._countBaseline = { ...this._counts };
  }

  /**
   * Reset the timing baseline to current timing values.
   * After calling this, getTimingDeltas() will return timing relative to this baseline.
   */
  resetTimingBaseline(): void {
    this._timingBaseline = new Map();
    for (const [key, store] of this._timingsByKey) {
      this._timingBaseline.set(key, store.getStats());
    }
  }

  /**
   * Get count deltas since the baseline was set.
   * If no baseline exists, returns the current counts.
   */
  getCountDeltas(): {
    debug: number;
    info: number;
    warn: number;
    error: number;
    total: number;
  } {
    if (!this._countBaseline) {
      return { ...this._counts, total: this.getTotal() };
    }
    return {
      debug: this._counts.debug - this._countBaseline.debug,
      info: this._counts.info - this._countBaseline.info,
      warn: this._counts.warn - this._countBaseline.warn,
      error: this._counts.error - this._countBaseline.error,
      total: this.getTotal() - (
        this._countBaseline.debug + this._countBaseline.info +
        this._countBaseline.warn + this._countBaseline.error
      ),
    };
  }

  /**
   * Get timing deltas since the baseline was set.
   * If no baseline exists, returns null.
   * For each key, returns the delta in counts and timing metrics.
   */
  getTimingDeltas(): Record<string, TimingStats> | null {
    if (!this._timingBaseline) return null;
    const deltas: Record<string, TimingStats> = {};
    for (const [key, store] of this._timingsByKey) {
      const current = store.getStats();
      const baseline = this._timingBaseline.get(key);
      if (baseline) {
        deltas[key] = {
          count: current.count - baseline.count,
          min: current.min,
          max: current.max,
          totalTime: current.totalTime - baseline.totalTime,
          average: (current.count > baseline.count)
            ? (current.totalTime - baseline.totalTime) /
              (current.count - baseline.count)
            : 0,
          p50: current.p50,
          p95: current.p95,
          lastTime: current.lastTime,
          lastTimestamp: current.lastTimestamp,
          histogram: current.histogram, // Use current histogram
        };
      } else {
        // New key since baseline
        deltas[key] = current;
      }
    }
    return deltas;
  }

  /**
   * Get the total count of all log calls (debug + info + warn + error).
   */
  private getTotal(): number {
    return this._counts.debug + this._counts.info + this._counts.warn +
      this._counts.error;
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
 * Get a breakdown of log counts by logger name and message key, plus totals.
 * @returns Object with nested counts per logger/key and a total property
 */
export function getLoggerCountsBreakdown(): Record<string, LoggerBreakdown> & {
  total: number;
} {
  const global = globalThis as unknown as {
    commontools?: { logger?: Record<string, Logger> };
  };

  const breakdown: Record<string, LoggerBreakdown> = {};
  let total = 0;

  if (global.commontools?.logger) {
    for (const [name, logger] of Object.entries(global.commontools.logger)) {
      const loggerBreakdown = { total: 0 } as LoggerBreakdown;

      // Add counts by key (skip "total" to avoid overwriting the reserved property)
      for (const [key, counts] of Object.entries(logger.countsByKey)) {
        if (key === "total") {
          continue; // Skip reserved property name
        }
        loggerBreakdown[key] = counts;
        loggerBreakdown.total += counts.total;
      }

      breakdown[name] = loggerBreakdown;
      total += loggerBreakdown.total;
    }
  }

  return { ...breakdown, total } as Record<string, LoggerBreakdown> & {
    total: number;
  };
}

/**
 * Breakdown of timing stats by logger name
 */
export type TimingStatsBreakdown = {
  [loggerName: string]: Record<string, TimingStats>;
};

/**
 * Get a breakdown of timing statistics by logger name and key.
 * @returns Object with nested timing stats per logger and key
 *
 * @example
 * getTimingStatsBreakdown()
 * // {
 * //   "runtime-client": {
 * //     "ipc": { count: 2415, min: 0.1, max: 45.2, average: 1.9, p50: 1.5, p95: 6.8, ... },
 * //     "ipc/CellGet": { count: 1523, min: 0.1, max: 45.2, average: 2.3, p50: 1.8, p95: 8.4, ... }
 * //   },
 * //   "runner": {
 * //     "cell": { count: 500, min: 0.1, p50: 2.0, p95: 8.5, max: 45.0, ... },
 * //     "cell/get": { count: 450, min: 0.1, p50: 2.1, p95: 8.7, max: 45.0, ... }
 * //   }
 * // }
 */
export function getTimingStatsBreakdown(): TimingStatsBreakdown {
  const global = globalThis as unknown as {
    commontools?: { logger?: Record<string, Logger> };
  };

  const breakdown: TimingStatsBreakdown = {};

  if (global.commontools?.logger) {
    for (const [name, logger] of Object.entries(global.commontools.logger)) {
      const stats = logger.timeStats;
      if (Object.keys(stats).length > 0) {
        breakdown[name] = stats;
      }
    }
  }

  return breakdown;
}

/**
 * Reset timing statistics for all registered loggers.
 * Iterates through all loggers in globalThis.commontools.logger and resets their timing stats.
 */
export function resetAllTimingStats(): void {
  const global = globalThis as unknown as {
    commontools?: { logger?: Record<string, Logger> };
  };
  if (global.commontools?.logger) {
    Object.values(global.commontools.logger).forEach((logger) =>
      logger.resetTimeStats()
    );
  }
}

/**
 * Reset count baseline for all registered loggers.
 * After calling this, each logger's getCountDeltas() will return counts relative to this baseline.
 */
export function resetAllCountBaselines(): void {
  const global = globalThis as unknown as {
    commontools?: { logger?: Record<string, Logger> };
  };
  if (global.commontools?.logger) {
    Object.values(global.commontools.logger).forEach((logger) =>
      logger.resetCountBaseline()
    );
  }
}

/**
 * Reset timing baseline for all registered loggers.
 * After calling this, each logger's getTimingDeltas() will return timing relative to this baseline.
 */
export function resetAllTimingBaselines(): void {
  const global = globalThis as unknown as {
    commontools?: { logger?: Record<string, Logger> };
  };
  if (global.commontools?.logger) {
    Object.values(global.commontools.logger).forEach((logger) =>
      logger.resetTimingBaseline()
    );
  }
}

// Make helper functions available globally for browser console access
if (typeof globalThis !== "undefined") {
  const global = globalThis as unknown as {
    commontools: {
      logger: Record<string, Logger>;
      getTotalLoggerCounts?: typeof getTotalLoggerCounts;
      getLoggerCountsBreakdown?: typeof getLoggerCountsBreakdown;
      resetAllLoggerCounts?: typeof resetAllLoggerCounts;
      getTimingStatsBreakdown?: typeof getTimingStatsBreakdown;
      resetAllTimingStats?: typeof resetAllTimingStats;
      resetAllCountBaselines?: typeof resetAllCountBaselines;
      resetAllTimingBaselines?: typeof resetAllTimingBaselines;
    };
  };
  if (!global.commontools) {
    global.commontools = { logger: {} } as typeof global.commontools;
  }
  global.commontools.getTotalLoggerCounts = getTotalLoggerCounts;
  global.commontools.getLoggerCountsBreakdown = getLoggerCountsBreakdown;
  global.commontools.resetAllLoggerCounts = resetAllLoggerCounts;
  global.commontools.getTimingStatsBreakdown = getTimingStatsBreakdown;
  global.commontools.resetAllTimingStats = resetAllTimingStats;
  global.commontools.resetAllCountBaselines = resetAllCountBaselines;
  global.commontools.resetAllTimingBaselines = resetAllTimingBaselines;
}
