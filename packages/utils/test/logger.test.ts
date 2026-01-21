import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  getLogger,
  getLoggerCountsBreakdown,
  getTimingStatsBreakdown,
  getTotalLoggerCounts,
  log,
  LOG_COLORS,
  resetAllLoggerCounts,
  resetAllTimingStats,
  type TimingStats,
} from "../src/logger.ts";

describe("logger", () => {
  beforeEach(() => {
    // Reset to default log level before each test
    log.level = "info";
  });

  afterEach(() => {
    // Clean up global logger registry after each test
    const global = globalThis as unknown as {
      commontools?: { logger?: Record<string, unknown> };
    };
    if (global.commontools?.logger) {
      global.commontools.logger = {};
    }
  });

  // Helper to check styled timestamp format
  function expectStyledTimestamp(
    calls: unknown[][],
    index: number,
    color: string,
    level: string,
  ) {
    expect(calls[index][0]).toMatch(
      new RegExp(`^%c\\[${level}\\]\\[\\d{2}:\\d{2}:\\d{2}\\.\\d{3}\\]$`),
    );
    expect(calls[index][1]).toBe(color);
  }

  // Helper to check styled module::timestamp format
  function expectStyledModuleTimestamp(
    calls: unknown[][],
    index: number,
    module: string,
    color: string,
    level: string,
  ) {
    const pattern = new RegExp(
      `^%c\\[${level}\\]\\[${module}::\\d{2}:\\d{2}:\\d{2}\\.\\d{3}\\]$`,
    );
    expect(calls[index][0]).toMatch(pattern);
    expect(calls[index][1]).toBe(color);
  }

  // Helper to capture console output
  function captureConsole<T>(
    method: keyof Console,
    fn: () => T,
  ): { result: T; calls: unknown[][] } {
    const originalMethod = console[method];
    const calls: unknown[][] = [];

    // Mock the console method
    (console[method] as (...args: unknown[]) => void) = (
      ...args: unknown[]
    ) => {
      calls.push(args);
    };

    try {
      const result = fn();
      return { result, calls };
    } finally {
      // Restore original method
      (console[method] as unknown) = originalMethod;
    }
  }

  describe("basic log function", () => {
    it("should default to enabled state", () => {
      expect(log.disabled).toBe(false);
    });

    it("should log messages to console", () => {
      const { calls } = captureConsole("log", () => {
        log.info("test-key", "hello", "world");
      });

      expect(calls).toHaveLength(1);
      expectStyledTimestamp(calls, 0, LOG_COLORS.info, "INFO");
      expect(calls[0].slice(2)).toEqual(["test-key", "hello", "world"]);
    });

    it("should handle multiple arguments", () => {
      const { calls } = captureConsole("log", () => {
        log.info("test-key", "a", 1, true, { key: "value" });
      });

      expect(calls).toHaveLength(1);
      expectStyledTimestamp(calls, 0, LOG_COLORS.info, "INFO");
      expect(calls[0].slice(2)).toEqual(["test-key", "a", 1, true, {
        key: "value",
      }]);
    });

    it("should evaluate lazy functions", () => {
      let evaluated = false;
      const lazyMessage = () => {
        evaluated = true;
        return "lazy value";
      };

      const { calls } = captureConsole("log", () => {
        log.info("test-key", "static", lazyMessage);
      });

      expect(evaluated).toBe(true);
      expect(calls).toHaveLength(1);
      expectStyledTimestamp(calls, 0, LOG_COLORS.info, "INFO");
      expect(calls[0].slice(2)).toEqual(["test-key", "static", "lazy value"]);
    });

    it("should handle mixed static and lazy messages", () => {
      const { calls } = captureConsole("log", () => {
        log.info(
          "test-key",
          "start",
          () => "lazy1",
          "middle",
          () => "lazy2",
          "end",
        );
      });

      expect(calls).toHaveLength(1);
      expectStyledTimestamp(calls, 0, LOG_COLORS.info, "INFO");
      expect(calls[0].slice(2)).toEqual([
        "test-key",
        "start",
        "lazy1",
        "middle",
        "lazy2",
        "end",
      ]);
    });

    it("should flatten arrays returned by lazy functions", () => {
      const { calls } = captureConsole("log", () => {
        log.info(
          "test-key",
          "prefix",
          () => ["array", "of", "values"],
          "suffix",
        );
      });

      expect(calls).toHaveLength(1);
      expectStyledTimestamp(calls, 0, LOG_COLORS.info, "INFO");
      expect(calls[0].slice(2)).toEqual([
        "test-key",
        "prefix",
        "array",
        "of",
        "values",
        "suffix",
      ]);
    });
  });

  describe("severity levels", () => {
    it("should log debug messages", () => {
      log.level = "debug"; // Enable debug level
      const { calls } = captureConsole("debug", () => {
        log.debug("test-key", "debug message");
      });

      expect(calls).toHaveLength(1);
      expectStyledTimestamp(calls, 0, LOG_COLORS.debug, "DEBUG");
      expect(calls[0].slice(2)).toEqual(["test-key", "debug message"]);
    });

    it("should log info messages", () => {
      const { calls } = captureConsole("log", () => {
        log.info("test-key", "info message");
      });

      expect(calls).toHaveLength(1);
      expectStyledTimestamp(calls, 0, LOG_COLORS.info, "INFO");
      expect(calls[0].slice(2)).toEqual(["test-key", "info message"]);
    });

    it("should log warning messages", () => {
      const { calls } = captureConsole("warn", () => {
        log.warn("test-key", "warning message");
      });

      expect(calls).toHaveLength(1);
      expectStyledTimestamp(calls, 0, LOG_COLORS.warn, "WARN");
      expect(calls[0].slice(2)).toEqual(["test-key", "warning message"]);
    });

    it("should log error messages", () => {
      const { calls } = captureConsole("error", () => {
        log.error("test-key", "error message");
      });

      expect(calls).toHaveLength(1);
      expectStyledTimestamp(calls, 0, LOG_COLORS.error, "ERROR");
      expect(calls[0].slice(2)).toEqual(["test-key", "error message"]);
    });

    it("should default to info level when using log.info()", () => {
      const { calls } = captureConsole("log", () => {
        log.info("test-key", "default message");
      });

      expect(calls).toHaveLength(1);
      expectStyledTimestamp(calls, 0, LOG_COLORS.info, "INFO");
      expect(calls[0].slice(2)).toEqual(["test-key", "default message"]);
    });

    it("should support log.log() as alias for info", () => {
      const { calls } = captureConsole("log", () => {
        log.log("test-key", "message via log()");
      });

      expect(calls).toHaveLength(1);
      expectStyledTimestamp(calls, 0, LOG_COLORS.info, "INFO");
      expect(calls[0].slice(2)).toEqual(["test-key", "message via log()"]);
    });
  });

  describe("lazy evaluation", () => {
    it("should evaluate lazy functions for all levels", () => {
      log.level = "debug"; // Enable debug level
      const lazyDebug = () => "lazy debug";
      const lazyInfo = () => "lazy info";
      const lazyWarn = () => "lazy warn";
      const lazyError = () => "lazy error";

      const { calls: debugCalls } = captureConsole("debug", () => {
        log.debug("test-key", lazyDebug);
      });
      const { calls: infoCalls } = captureConsole("log", () => {
        log.info("test-key", lazyInfo);
      });
      const { calls: warnCalls } = captureConsole("warn", () => {
        log.warn("test-key", lazyWarn);
      });
      const { calls: errorCalls } = captureConsole("error", () => {
        log.error("test-key", lazyError);
      });

      expect(debugCalls[0].slice(2)).toEqual(["test-key", "lazy debug"]);
      expect(infoCalls[0].slice(2)).toEqual(["test-key", "lazy info"]);
      expect(warnCalls[0].slice(2)).toEqual(["test-key", "lazy warn"]);
      expect(errorCalls[0].slice(2)).toEqual(["test-key", "lazy error"]);
    });

    it("should not evaluate lazy functions when disabled", () => {
      log.disabled = true;
      let evaluated = false;
      const lazyMessage = () => {
        evaluated = true;
        return "should not be evaluated";
      };

      const { calls } = captureConsole("log", () => {
        log.info("test-key", lazyMessage);
      });

      expect(evaluated).toBe(false);
      expect(calls).toHaveLength(0);

      // Re-enable for other tests
      log.disabled = false;
    });
  });

  describe("log level filtering", () => {
    it("should filter messages based on log level", () => {
      log.level = "warn"; // Only show warn and error

      const { calls: debugCalls } = captureConsole("debug", () => {
        log.debug("test-key", "debug message");
      });
      const { calls: infoCalls } = captureConsole("log", () => {
        log.info("test-key", "info message");
      });
      const { calls: warnCalls } = captureConsole("warn", () => {
        log.warn("test-key", "warning message");
      });
      const { calls: errorCalls } = captureConsole("error", () => {
        log.error("test-key", "error message");
      });

      expect(debugCalls).toHaveLength(0);
      expect(infoCalls).toHaveLength(0);
      expect(warnCalls).toHaveLength(1);
      expect(errorCalls).toHaveLength(1);
    });

    it("should show all messages when set to debug", () => {
      log.level = "debug"; // Enable all levels
      const { calls: debugCalls } = captureConsole("debug", () => {
        log.debug("test-key", "debug message");
      });
      const { calls: infoCalls } = captureConsole("log", () => {
        log.info("test-key", "info message");
      });
      const { calls: warnCalls } = captureConsole("warn", () => {
        log.warn("test-key", "warning message");
      });
      const { calls: errorCalls } = captureConsole("error", () => {
        log.error("test-key", "error message");
      });

      expect(debugCalls).toHaveLength(1);
      expect(infoCalls).toHaveLength(1);
      expect(warnCalls).toHaveLength(1);
      expect(errorCalls).toHaveLength(1);
    });

    it("should only show error messages when set to error", () => {
      log.level = "error";
      const { calls: debugCalls } = captureConsole("debug", () => {
        log.debug("test-key", "debug message");
      });
      const { calls: infoCalls } = captureConsole("log", () => {
        log.info("test-key", "info message");
      });
      const { calls: warnCalls } = captureConsole("warn", () => {
        log.warn("test-key", "warning message");
      });
      const { calls: errorCalls } = captureConsole("error", () => {
        log.error("test-key", "error message");
      });

      expect(debugCalls).toHaveLength(0);
      expect(infoCalls).toHaveLength(0);
      expect(warnCalls).toHaveLength(0);
      expect(errorCalls).toHaveLength(1);
    });
  });

  describe("log level management", () => {
    it("should respect log.level changes", () => {
      // Test default level
      expect(log.level).toBe("info"); // Default

      // Test setting to debug
      log.level = "debug";
      expect(log.level).toBe("debug");

      // Test setting to error
      log.level = "error";
      expect(log.level).toBe("error");
    });
  });

  describe("tagged logger", () => {
    it("should create tagged logger with module name", () => {
      const logger = getLogger("test-module");
      const { calls } = captureConsole("log", () => {
        logger.info("test-key", "test message");
      });

      expect(calls).toHaveLength(1);
      expectStyledModuleTimestamp(
        calls,
        0,
        "test-module",
        LOG_COLORS.taggedInfo,
        "INFO",
      );
      expect(calls[0].slice(2)).toEqual(["test-key", "test message"]);
    });

    it("should support log() method as alias for info()", () => {
      const logger = getLogger("test-module");
      const { calls } = captureConsole("log", () => {
        logger.log("test-key", "test message via log()");
      });

      expect(calls).toHaveLength(1);
      expectStyledModuleTimestamp(
        calls,
        0,
        "test-module",
        LOG_COLORS.taggedInfo,
        "INFO",
      );
      expect(calls[0].slice(2)).toEqual(["test-key", "test message via log()"]);
    });

    it("should support all log levels in tagged logger", () => {
      const logger = getLogger("test-module");
      logger.level = "debug"; // Enable all levels

      const { calls: debugCalls } = captureConsole("debug", () => {
        logger.debug("test-key", "debug message");
      });
      const { calls: infoCalls } = captureConsole("log", () => {
        logger.info("test-key", "info message");
      });
      const { calls: warnCalls } = captureConsole("warn", () => {
        logger.warn("test-key", "warning message");
      });
      const { calls: errorCalls } = captureConsole("error", () => {
        logger.error("test-key", "error message");
      });

      expect(debugCalls).toHaveLength(1);
      expect(infoCalls).toHaveLength(1);
      expect(warnCalls).toHaveLength(1);
      expect(errorCalls).toHaveLength(1);

      expectStyledModuleTimestamp(
        debugCalls,
        0,
        "test-module",
        LOG_COLORS.taggedDebug,
        "DEBUG",
      );
      expectStyledModuleTimestamp(
        infoCalls,
        0,
        "test-module",
        LOG_COLORS.taggedInfo,
        "INFO",
      );
      expectStyledModuleTimestamp(
        warnCalls,
        0,
        "test-module",
        LOG_COLORS.taggedWarn,
        "WARN",
      );
      expectStyledModuleTimestamp(
        errorCalls,
        0,
        "test-module",
        LOG_COLORS.taggedError,
        "ERROR",
      );
    });

    it("should respect logger-specific level", () => {
      const logger = getLogger("test-module", { level: "warn" });

      const { calls: debugCalls } = captureConsole("debug", () => {
        logger.debug("test-key", "debug message");
      });
      const { calls: infoCalls } = captureConsole("log", () => {
        logger.info("test-key", "info message");
      });
      const { calls: warnCalls } = captureConsole("warn", () => {
        logger.warn("test-key", "warning message");
      });
      const { calls: errorCalls } = captureConsole("error", () => {
        logger.error("test-key", "error message");
      });

      expect(debugCalls).toHaveLength(0);
      expect(infoCalls).toHaveLength(0);
      expect(warnCalls).toHaveLength(1);
      expect(errorCalls).toHaveLength(1);
    });

    it("should support lazy evaluation in tagged logger", () => {
      const logger = getLogger("test-module");
      let evaluated = false;
      const lazyMessage = () => {
        evaluated = true;
        return "lazy tagged message";
      };

      const { calls } = captureConsole("log", () => {
        logger.info("test-key", lazyMessage);
      });

      expect(evaluated).toBe(true);
      expect(calls).toHaveLength(1);
      expectStyledModuleTimestamp(
        calls,
        0,
        "test-module",
        LOG_COLORS.taggedInfo,
        "INFO",
      );
      expect(calls[0].slice(2)).toEqual(["test-key", "lazy tagged message"]);
    });

    it("should support disabled state in tagged logger", () => {
      const logger = getLogger("test-module", { enabled: false });
      let evaluated = false;
      const lazyMessage = () => {
        evaluated = true;
        return "should not be evaluated";
      };

      const { calls } = captureConsole("log", () => {
        logger.info("test-key", lazyMessage);
      });

      expect(evaluated).toBe(false);
      expect(calls).toHaveLength(0);
      expect(logger.disabled).toBe(true);
    });

    it("should default to enabled state", () => {
      const logger = getLogger("test-module");
      expect(logger.disabled).toBe(false);

      const { calls } = captureConsole("log", () => {
        logger.info("test-key", "should show by default");
      });

      expect(calls).toHaveLength(1);
    });

    it("should allow runtime enable/disable of tagged logger", () => {
      const logger = getLogger("test-module", { enabled: false });

      // Initially disabled
      const { calls: disabledCalls } = captureConsole("log", () => {
        logger.info("test-key", "should not show");
      });
      expect(disabledCalls).toHaveLength(0);

      // Enable at runtime
      logger.disabled = false;
      const { calls: enabledCalls } = captureConsole("log", () => {
        logger.info("test-key", "should show");
      });
      expect(enabledCalls).toHaveLength(1);

      // Disable again
      logger.disabled = true;
      const { calls: disabledAgainCalls } = captureConsole("log", () => {
        logger.info("test-key", "should not show again");
      });
      expect(disabledAgainCalls).toHaveLength(0);
    });
  });

  describe("global vs tagged logger", () => {
    it("should have different formatting for global vs tagged", () => {
      const taggedLogger = getLogger("test-module");

      const { calls: globalCalls } = captureConsole("log", () => {
        log.info("test-key", "global message");
      });
      const { calls: taggedCalls } = captureConsole("log", () => {
        taggedLogger.info("tagged message");
      });

      expect(globalCalls).toHaveLength(1);
      expect(taggedCalls).toHaveLength(1);

      // Global should not have module name
      expect(globalCalls[0][0]).toMatch(
        /^%c\[INFO\]\[\d{2}:\d{2}:\d{2}\.\d{3}\]$/,
      );
      expect(globalCalls[0][1]).toBe(LOG_COLORS.info);

      // Tagged should have module name
      expect(taggedCalls[0][0]).toMatch(
        /^%c\[INFO\]\[test-module::\d{2}:\d{2}:\d{2}\.\d{3}\]$/,
      );
      expect(taggedCalls[0][1]).toBe(LOG_COLORS.taggedInfo);
    });

    it("should have independent log levels", () => {
      const taggedLogger = getLogger("test-module");

      // Set different levels
      log.level = "warn";
      taggedLogger.level = "debug";

      const { calls: globalDebugCalls } = captureConsole("debug", () => {
        log.debug("test-key", "global debug");
      });
      const { calls: globalWarnCalls } = captureConsole("warn", () => {
        log.warn("test-key", "global warn");
      });
      const { calls: taggedDebugCalls } = captureConsole("debug", () => {
        taggedLogger.debug("tagged debug");
      });
      const { calls: taggedWarnCalls } = captureConsole("warn", () => {
        taggedLogger.warn("tagged warn");
      });

      // Global logger should filter debug
      expect(globalDebugCalls).toHaveLength(0);
      expect(globalWarnCalls).toHaveLength(1);

      // Tagged logger should show debug
      expect(taggedDebugCalls).toHaveLength(1);
      expect(taggedWarnCalls).toHaveLength(1);
    });
  });

  describe("call counting", () => {
    it("should initialize counts to zero", () => {
      const logger = getLogger("count-test");
      expect(logger.counts.debug).toBe(0);
      expect(logger.counts.info).toBe(0);
      expect(logger.counts.warn).toBe(0);
      expect(logger.counts.error).toBe(0);
      expect(logger.counts.total).toBe(0);
    });

    it("should increment counts for each log level", () => {
      const logger = getLogger("count-test");
      logger.level = "debug"; // Enable all levels

      captureConsole("debug", () => logger.debug("test-key", "test"));
      expect(logger.counts.debug).toBe(1);
      expect(logger.counts.total).toBe(1);

      captureConsole("log", () => logger.info("test-key", "test"));
      expect(logger.counts.info).toBe(1);
      expect(logger.counts.total).toBe(2);

      captureConsole("warn", () => logger.warn("test-key", "test"));
      expect(logger.counts.warn).toBe(1);
      expect(logger.counts.total).toBe(3);

      captureConsole("error", () => logger.error("test-key", "test"));
      expect(logger.counts.error).toBe(1);
      expect(logger.counts.total).toBe(4);
    });

    it("should increment counts even when logger is disabled", () => {
      const logger = getLogger("count-test", { enabled: false });

      captureConsole("debug", () => logger.debug("test-key", "test"));
      captureConsole("log", () => logger.info("test-key", "test"));
      captureConsole("warn", () => logger.warn("test-key", "test"));
      captureConsole("error", () => logger.error("test-key", "test"));

      expect(logger.counts.debug).toBe(1);
      expect(logger.counts.info).toBe(1);
      expect(logger.counts.warn).toBe(1);
      expect(logger.counts.error).toBe(1);
      expect(logger.counts.total).toBe(4);
    });

    it("should increment counts even when log level filters messages", () => {
      const logger = getLogger("count-test", { level: "error" });

      captureConsole("debug", () => logger.debug("test-key", "test"));
      captureConsole("log", () => logger.info("test-key", "test"));
      captureConsole("warn", () => logger.warn("test-key", "test"));
      captureConsole("error", () => logger.error("test-key", "test"));

      // All counts should increment even though only error was logged
      expect(logger.counts.debug).toBe(1);
      expect(logger.counts.info).toBe(1);
      expect(logger.counts.warn).toBe(1);
      expect(logger.counts.error).toBe(1);
      expect(logger.counts.total).toBe(4);
    });

    it("should not evaluate lazy functions when disabled but still count", () => {
      const logger = getLogger("count-test", { enabled: false });
      let evaluated = false;
      const lazyMessage = () => {
        evaluated = true;
        return "should not be evaluated";
      };

      captureConsole("log", () => logger.info("test-key", lazyMessage));

      expect(evaluated).toBe(false); // Function not evaluated
      expect(logger.counts.info).toBe(1); // But count was incremented
    });

    it("should compute total as sum of all counts", () => {
      const logger = getLogger("count-test");
      logger.level = "debug";

      captureConsole("debug", () => {
        logger.debug("test-key", "test1");
        logger.debug("test-key", "test2");
      });
      captureConsole("log", () => {
        logger.info("test-key", "test1");
        logger.info("test-key", "test2");
        logger.info("test-key", "test3");
      });
      captureConsole("warn", () => logger.warn("test-key", "test"));
      captureConsole("error", () => {
        logger.error("test-key", "test1");
        logger.error("test-key", "test2");
      });

      expect(logger.counts.debug).toBe(2);
      expect(logger.counts.info).toBe(3);
      expect(logger.counts.warn).toBe(1);
      expect(logger.counts.error).toBe(2);
      expect(logger.counts.total).toBe(8);
    });

    it("should reset counts to zero with resetCounts()", () => {
      const logger = getLogger("count-test");
      logger.level = "debug";

      // Generate some counts
      captureConsole("debug", () => logger.debug("test-key", "test"));
      captureConsole("log", () => logger.info("test-key", "test"));
      captureConsole("warn", () => logger.warn("test-key", "test"));
      captureConsole("error", () => logger.error("test-key", "test"));

      expect(logger.counts.total).toBe(4);

      // Reset counts
      logger.resetCounts();

      expect(logger.counts.debug).toBe(0);
      expect(logger.counts.info).toBe(0);
      expect(logger.counts.warn).toBe(0);
      expect(logger.counts.error).toBe(0);
      expect(logger.counts.total).toBe(0);
    });

    it("should count log() calls as info", () => {
      const logger = getLogger("count-test");

      captureConsole("log", () => logger.log("test-key", "test"));

      expect(logger.counts.info).toBe(1);
      expect(logger.counts.debug).toBe(0);
      expect(logger.counts.total).toBe(1);
    });
  });

  describe("logger reuse", () => {
    it("should return the same logger instance for the same module name", () => {
      const logger1 = getLogger("reuse-test");
      const logger2 = getLogger("reuse-test");

      expect(logger1).toBe(logger2);
    });

    it("should preserve counts across getLogger calls", () => {
      const logger1 = getLogger("reuse-test");

      captureConsole("log", () => logger1.info("test-key", "test"));
      expect(logger1.counts.info).toBe(1);

      // Get the "same" logger again
      const logger2 = getLogger("reuse-test");
      expect(logger2.counts.info).toBe(1); // Count preserved
      expect(logger2).toBe(logger1); // Same instance
    });

    it("should ignore options when returning existing logger", () => {
      const logger1 = getLogger("reuse-test", { enabled: true, level: "info" });
      const logger2 = getLogger("reuse-test", {
        enabled: false,
        level: "debug",
      });

      expect(logger1).toBe(logger2);
      expect(logger2.disabled).toBe(false); // Original options preserved
      expect(logger2.level).toBe("info"); // Original options preserved
    });

    it("should be accessible via globalThis.commontools.logger", () => {
      const logger = getLogger("global-test");
      const global = globalThis as unknown as {
        commontools: { logger: Record<string, typeof logger> };
      };

      expect(global.commontools.logger["global-test"]).toBe(logger);
    });
  });

  describe("resetAllLoggerCounts", () => {
    it("should reset counts for all loggers", () => {
      const logger1 = getLogger("reset-all-test-1");
      const logger2 = getLogger("reset-all-test-2");
      const logger3 = getLogger("reset-all-test-3");

      // Generate counts
      captureConsole("log", () => {
        logger1.info("test-key", "test");
        logger1.info("test-key", "test");
        logger2.info("test-key", "test");
        logger3.info("test-key", "test");
        logger3.info("test-key", "test");
        logger3.info("test-key", "test");
      });

      expect(logger1.counts.info).toBe(2);
      expect(logger2.counts.info).toBe(1);
      expect(logger3.counts.info).toBe(3);

      // Reset all
      resetAllLoggerCounts();

      expect(logger1.counts.info).toBe(0);
      expect(logger2.counts.info).toBe(0);
      expect(logger3.counts.info).toBe(0);
      expect(logger1.counts.total).toBe(0);
      expect(logger2.counts.total).toBe(0);
      expect(logger3.counts.total).toBe(0);
    });

    it("should handle empty logger registry gracefully", () => {
      // Clean up registry
      const global = globalThis as unknown as {
        commontools?: { logger?: Record<string, unknown> };
      };
      if (global.commontools?.logger) {
        global.commontools.logger = {};
      }

      // Should not throw
      expect(() => resetAllLoggerCounts()).not.toThrow();
    });

    it("should not affect subsequent count increments", () => {
      const logger = getLogger("reset-all-test");

      captureConsole("log", () => logger.info("test-key", "test"));
      expect(logger.counts.info).toBe(1);

      resetAllLoggerCounts();
      expect(logger.counts.info).toBe(0);

      // Counts should work normally after reset
      captureConsole("log", () => logger.info("test-key", "test"));
      expect(logger.counts.info).toBe(1);
    });
  });

  describe("getTotalLoggerCounts", () => {
    it("should return total count across all loggers", () => {
      const logger1 = getLogger("total-test-1");
      const logger2 = getLogger("total-test-2");
      const logger3 = getLogger("total-test-3");

      logger1.level = "debug";
      logger2.level = "debug";
      logger3.level = "debug";

      // Generate different counts for each logger
      captureConsole("debug", () => logger1.debug("test-key", "test"));
      captureConsole("log", () => {
        logger1.info("test-key", "test");
        logger1.info("test-key", "test");
      });

      captureConsole("warn", () => {
        logger2.warn("test-key", "test");
        logger2.warn("test-key", "test");
        logger2.warn("test-key", "test");
      });

      captureConsole("error", () => {
        logger3.error("test-key", "test");
        logger3.error("test-key", "test");
        logger3.error("test-key", "test");
        logger3.error("test-key", "test");
      });

      // logger1: 1 debug + 2 info = 3
      // logger2: 3 warn = 3
      // logger3: 4 error = 4
      // Total: 10
      expect(getTotalLoggerCounts()).toBe(10);
    });

    it("should return 0 when no loggers exist", () => {
      // Clean up registry
      const global = globalThis as unknown as {
        commontools?: { logger?: Record<string, unknown> };
      };
      if (global.commontools?.logger) {
        global.commontools.logger = {};
      }

      expect(getTotalLoggerCounts()).toBe(0);
    });

    it("should return 0 when all counts are zero", () => {
      getLogger("total-test-zero-1");
      getLogger("total-test-zero-2");

      expect(getTotalLoggerCounts()).toBe(0);
    });

    it("should update as new log calls are made", () => {
      const logger = getLogger("total-test-update");

      expect(getTotalLoggerCounts()).toBe(0);

      captureConsole("log", () => logger.info("test-key", "test"));
      expect(getTotalLoggerCounts()).toBe(1);

      captureConsole("log", () => logger.info("test-key", "test"));
      expect(getTotalLoggerCounts()).toBe(2);
    });

    it("should reset to 0 after resetAllLoggerCounts", () => {
      const logger1 = getLogger("total-test-reset-1");
      const logger2 = getLogger("total-test-reset-2");

      captureConsole("log", () => {
        logger1.info("test-key", "test");
        logger2.info("test-key", "test");
        logger2.info("test-key", "test");
      });

      expect(getTotalLoggerCounts()).toBe(3);

      resetAllLoggerCounts();
      expect(getTotalLoggerCounts()).toBe(0);
    });
  });

  describe("getLoggerCountsBreakdown", () => {
    it("should return breakdown by logger name with total", () => {
      const logger1 = getLogger("breakdown-test-1");
      const logger2 = getLogger("breakdown-test-2");
      const logger3 = getLogger("breakdown-test-3");

      captureConsole("log", () => {
        logger1.info("test-key", "test");
        logger1.info("test-key", "test");
        logger2.info("test-key", "test");
        logger2.info("test-key", "test");
        logger2.info("test-key", "test");
        logger3.info("test-key", "test");
      });

      const breakdown = getLoggerCountsBreakdown();

      // Now returns nested structure with message keys
      expect(breakdown["breakdown-test-1"].total).toBe(2);
      expect(breakdown["breakdown-test-2"].total).toBe(3);
      expect(breakdown["breakdown-test-3"].total).toBe(1);
      expect(breakdown.total).toBe(6);
    });

    it("should return empty breakdown with 0 total when no loggers exist", () => {
      // Clean up registry
      const global = globalThis as unknown as {
        commontools?: { logger?: Record<string, unknown> };
      };
      if (global.commontools?.logger) {
        global.commontools.logger = {};
      }

      const breakdown = getLoggerCountsBreakdown();
      expect(breakdown.total).toBe(0);
      expect(Object.keys(breakdown).length).toBe(1); // Only 'total' key
    });

    it("should update as new log calls are made", () => {
      const logger = getLogger("breakdown-update-test");

      let breakdown = getLoggerCountsBreakdown();
      expect(breakdown["breakdown-update-test"].total).toBe(0);
      expect(breakdown.total).toBe(0);

      captureConsole("log", () => logger.info("test-key", "test"));

      breakdown = getLoggerCountsBreakdown();
      expect(breakdown["breakdown-update-test"].total).toBe(1);
      expect(breakdown.total).toBe(1);
    });

    it("should reset to 0 after resetAllLoggerCounts", () => {
      const logger1 = getLogger("breakdown-reset-1");
      const logger2 = getLogger("breakdown-reset-2");

      captureConsole("log", () => {
        logger1.info("test-key", "test");
        logger2.info("test-key", "test");
        logger2.info("test-key", "test");
      });

      let breakdown = getLoggerCountsBreakdown();
      expect(breakdown["breakdown-reset-1"].total).toBe(1);
      expect(breakdown["breakdown-reset-2"].total).toBe(2);
      expect(breakdown.total).toBe(3);

      resetAllLoggerCounts();

      breakdown = getLoggerCountsBreakdown();
      expect(breakdown["breakdown-reset-1"].total).toBe(0);
      expect(breakdown["breakdown-reset-2"].total).toBe(0);
      expect(breakdown.total).toBe(0);
    });

    it("should match getTotalLoggerCounts", () => {
      const logger1 = getLogger("breakdown-match-1");
      const logger2 = getLogger("breakdown-match-2");

      captureConsole("log", () => {
        logger1.info("test-key", "test");
        logger1.info("test-key", "test");
        logger2.info("test-key", "test");
      });

      const breakdown = getLoggerCountsBreakdown();
      const total = getTotalLoggerCounts();

      expect(breakdown.total).toBe(total);
      expect(breakdown.total).toBe(3);
    });
  });

  describe("logCountEvery", () => {
    it("should log summary at default threshold of 100", () => {
      const logger = getLogger("count-every-test");
      logger.level = "debug"; // Enable debug to see summary

      const { calls } = captureConsole("debug", () => {
        // Make exactly 100 calls
        for (let i = 0; i < 100; i++) {
          logger.info("test-key", "test");
        }
      });

      // Should have logged the summary once
      const summaryLogs = calls.filter((call) =>
        call.some((arg) => String(arg).includes("100 log calls made"))
      );
      expect(summaryLogs).toHaveLength(1);
      expect(summaryLogs[0].some((arg) => String(arg).includes("info: 100")))
        .toBe(true);
    });

    it("should log summary at custom threshold", () => {
      const logger = getLogger("count-every-custom", {
        logCountEvery: 50,
        level: "debug",
      });

      const { calls } = captureConsole("debug", () => {
        // Make exactly 50 calls
        for (let i = 0; i < 50; i++) {
          logger.info("test-key", "test");
        }
      });

      // Should have logged the summary once at 50
      const summaryLogs = calls.filter((call) =>
        call.some((arg) => String(arg).includes("50 log calls made"))
      );
      expect(summaryLogs).toHaveLength(1);
    });

    it("should not log summary when logCountEvery is 0", () => {
      const logger = getLogger("count-every-disabled", {
        logCountEvery: 0,
        level: "debug",
      });

      const { calls } = captureConsole("debug", () => {
        // Make 150 calls
        for (let i = 0; i < 150; i++) {
          logger.info("test-key", "test");
        }
      });

      // Should not have any summary logs
      const summaryLogs = calls.filter((call) =>
        call.some((arg) => String(arg).includes("log calls made"))
      );
      expect(summaryLogs).toHaveLength(0);
    });

    it("should log summary multiple times at thresholds", () => {
      const logger = getLogger("count-every-multiple", {
        logCountEvery: 25,
        level: "debug",
      });

      const { calls } = captureConsole("debug", () => {
        // Make 75 calls (should trigger at 25, 50, 75)
        for (let i = 0; i < 75; i++) {
          logger.info("test-key", "test");
        }
      });

      const summaryLogs = calls.filter((call) =>
        call.some((arg) => String(arg).includes("log calls made"))
      );
      expect(summaryLogs).toHaveLength(3);

      // Check each threshold
      expect(
        summaryLogs[0].some((arg) => String(arg).includes("25 log calls made")),
      ).toBe(true);
      expect(
        summaryLogs[1].some((arg) => String(arg).includes("50 log calls made")),
      ).toBe(true);
      expect(
        summaryLogs[2].some((arg) => String(arg).includes("75 log calls made")),
      ).toBe(true);
    });

    it("should not log summary when debug level is not enabled", () => {
      const logger = getLogger("count-every-no-debug", {
        logCountEvery: 50,
        level: "info", // Debug not enabled
      });

      const { calls } = captureConsole("debug", () => {
        // Make 100 calls
        for (let i = 0; i < 100; i++) {
          logger.info("test-key", "test");
        }
      });

      // Summary should not be logged since debug level is filtered
      expect(calls).toHaveLength(0);
    });

    it("should show breakdown of all log levels", () => {
      const logger = getLogger("count-every-breakdown", {
        logCountEvery: 10,
        level: "debug",
      });

      const { calls } = captureConsole("debug", () => {
        logger.debug("test-key", "test");
        logger.debug("test-key", "test");
        logger.info("test-key", "test");
        logger.info("test-key", "test");
        logger.info("test-key", "test");
        logger.warn("test-key", "test");
        logger.warn("test-key", "test");
        logger.error("test-key", "test");
        logger.error("test-key", "test");
        logger.error("test-key", "test");
      });

      // Should have one summary at 10
      const summaryLogs = calls.filter((call) =>
        call.some((arg) => String(arg).includes("10 log calls made"))
      );
      expect(summaryLogs).toHaveLength(1);

      // Check breakdown
      const summaryText = summaryLogs[0].join(" ");
      expect(summaryText).toContain("debug: 2");
      expect(summaryText).toContain("info: 3");
      expect(summaryText).toContain("warn: 2");
      expect(summaryText).toContain("error: 3");
    });

    it("should not increment counter for summary log itself", () => {
      const logger = getLogger("count-every-no-increment", {
        logCountEvery: 10,
        level: "debug",
      });

      captureConsole("debug", () => {
        // Make exactly 10 calls
        for (let i = 0; i < 10; i++) {
          logger.info("test-key", "test");
        }
      });

      // Counter should be exactly 10, not 11
      expect(logger.counts.total).toBe(10);
      expect(logger.counts.debug).toBe(0); // Summary didn't increment debug
    });

    it("should include module name in summary", () => {
      const logger = getLogger("my-module", {
        logCountEvery: 5,
        level: "debug",
      });

      const { calls } = captureConsole("debug", () => {
        for (let i = 0; i < 5; i++) {
          logger.info("test-key", "test");
        }
      });

      const summaryLogs = calls.filter((call) =>
        call.some((arg) => String(arg).includes("my-module: 5 log calls made"))
      );
      expect(summaryLogs).toHaveLength(1);
    });

    it("should work even when logger is disabled", () => {
      const logger = getLogger("count-every-disabled-logger", {
        logCountEvery: 10,
        level: "debug",
        enabled: false,
      });

      const { calls } = captureConsole("debug", () => {
        for (let i = 0; i < 10; i++) {
          logger.info("test-key", "test");
        }
      });

      // Summary should not be logged because logger is disabled
      expect(calls).toHaveLength(0);

      // But counter should still be at 10
      expect(logger.counts.total).toBe(10);
    });
  });

  describe("countsByKey", () => {
    it("should track counts by message key", () => {
      const logger = getLogger("key-test");
      logger.level = "debug";

      captureConsole("debug", () => {
        logger.debug("user-login", "User logged in");
        logger.debug("user-login", "Another login");
      });
      captureConsole("log", () => {
        logger.info("data-fetch", "Fetched data");
        logger.info("user-login", "Login info message");
      });
      captureConsole("warn", () => {
        logger.warn("user-login", "Login warning");
      });

      const byKey = logger.countsByKey;

      expect(byKey["user-login"].debug).toBe(2);
      expect(byKey["user-login"].info).toBe(1);
      expect(byKey["user-login"].warn).toBe(1);
      expect(byKey["user-login"].error).toBe(0);
      expect(byKey["user-login"].total).toBe(4);

      expect(byKey["data-fetch"].info).toBe(1);
      expect(byKey["data-fetch"].total).toBe(1);
    });

    it("should track different keys independently", () => {
      const logger = getLogger("multi-key-test");

      captureConsole("log", () => {
        logger.info("key-a", "Message A");
        logger.info("key-b", "Message B");
        logger.info("key-a", "Another A");
        logger.info("key-c", "Message C");
      });

      const byKey = logger.countsByKey;
      expect(byKey["key-a"].total).toBe(2);
      expect(byKey["key-b"].total).toBe(1);
      expect(byKey["key-c"].total).toBe(1);
    });

    it("should reset countsByKey when resetCounts is called", () => {
      const logger = getLogger("reset-key-test");

      captureConsole("log", () => {
        logger.info("key-1", "Message 1");
        logger.info("key-2", "Message 2");
      });

      expect(logger.countsByKey["key-1"].total).toBe(1);
      expect(logger.countsByKey["key-2"].total).toBe(1);

      logger.resetCounts();

      expect(Object.keys(logger.countsByKey).length).toBe(0);
    });

    it("should increment key counts even when logger is disabled", () => {
      const logger = getLogger("disabled-key-test", { enabled: false });

      captureConsole("log", () => {
        logger.info("key-disabled", "Should count");
        logger.info("key-disabled", "Should count again");
      });

      expect(logger.countsByKey["key-disabled"].total).toBe(2);
    });
  });

  describe("getLoggerCountsBreakdown with message keys", () => {
    it("should return nested structure with message keys", () => {
      const logger1 = getLogger("breakdown-keys-1");
      const logger2 = getLogger("breakdown-keys-2");

      captureConsole("log", () => {
        logger1.info("login", "Login 1");
        logger1.info("login", "Login 2");
        logger1.info("logout", "Logout 1");
        logger2.info("fetch", "Fetch 1");
        logger2.info("fetch", "Fetch 2");
        logger2.info("fetch", "Fetch 3");
      });

      const breakdown = getLoggerCountsBreakdown();

      // Check logger1 breakdown
      expect(breakdown["breakdown-keys-1"]["login"].total).toBe(2);
      expect(breakdown["breakdown-keys-1"]["logout"].total).toBe(1);
      expect(breakdown["breakdown-keys-1"].total).toBe(3);

      // Check logger2 breakdown
      expect(breakdown["breakdown-keys-2"]["fetch"].total).toBe(3);
      expect(breakdown["breakdown-keys-2"].total).toBe(3);

      // Check global total
      expect(breakdown.total).toBe(6);
    });

    it("should show per-level counts in nested structure", () => {
      const logger = getLogger("breakdown-levels");
      logger.level = "debug";

      captureConsole("debug", () => {
        logger.debug("test-op", "Debug 1");
        logger.debug("test-op", "Debug 2");
      });
      captureConsole("log", () => {
        logger.info("test-op", "Info 1");
      });
      captureConsole("warn", () => {
        logger.warn("test-op", "Warn 1");
      });
      captureConsole("error", () => {
        logger.error("test-op", "Error 1");
        logger.error("test-op", "Error 2");
      });

      const breakdown = getLoggerCountsBreakdown();
      const testOp = breakdown["breakdown-levels"]["test-op"];

      expect(testOp.debug).toBe(2);
      expect(testOp.info).toBe(1);
      expect(testOp.warn).toBe(1);
      expect(testOp.error).toBe(2);
      expect(testOp.total).toBe(6);
    });

    it("should handle multiple keys across multiple loggers", () => {
      const logger1 = getLogger("multi-1");
      const logger2 = getLogger("multi-2");

      captureConsole("log", () => {
        logger1.info("action-a", "A1");
        logger1.info("action-b", "B1");
        logger2.info("action-a", "A2");
        logger2.info("action-c", "C2");
      });

      const breakdown = getLoggerCountsBreakdown();

      expect(breakdown["multi-1"]["action-a"].total).toBe(1);
      expect(breakdown["multi-1"]["action-b"].total).toBe(1);
      expect(breakdown["multi-2"]["action-a"].total).toBe(1);
      expect(breakdown["multi-2"]["action-c"].total).toBe(1);
      expect(breakdown.total).toBe(4);
    });
  });

  describe("timing statistics", () => {
    describe("timeStart/timeEnd", () => {
      it("should record timing with timeStart/timeEnd pair", () => {
        const logger = getLogger("timing-test-basic");

        logger.timeStart("operation");
        // Small delay to ensure measurable time
        const start = performance.now();
        while (performance.now() - start < 2) {
          // busy wait
        }
        const elapsed = logger.timeEnd("operation");

        expect(elapsed).toBeDefined();
        expect(elapsed).toBeGreaterThanOrEqual(0);

        const stats = logger.getTimeStats("operation");
        expect(stats).toBeDefined();
        expect(stats?.count).toBe(1);
        expect(stats?.min).toBeGreaterThanOrEqual(0);
        expect(stats?.max).toBeGreaterThanOrEqual(0);
      });

      it("should return undefined when ending timer that was not started", () => {
        const logger = getLogger("timing-test-no-start");

        const elapsed = logger.timeEnd("nonexistent");
        expect(elapsed).toBeUndefined();
      });

      it("should support hierarchical keys", () => {
        const logger = getLogger("timing-test-hierarchy");

        logger.timeStart("cell", "get", "user-data");
        const elapsed = logger.timeEnd("cell", "get", "user-data");

        expect(elapsed).toBeDefined();

        // Stats should be recorded at all levels
        const cellStats = logger.getTimeStats("cell");
        const cellGetStats = logger.getTimeStats("cell", "get");
        const cellGetUserStats = logger.getTimeStats(
          "cell",
          "get",
          "user-data",
        );

        expect(cellStats).toBeDefined();
        expect(cellGetStats).toBeDefined();
        expect(cellGetUserStats).toBeDefined();

        // All should have count of 1
        expect(cellStats?.count).toBe(1);
        expect(cellGetStats?.count).toBe(1);
        expect(cellGetUserStats?.count).toBe(1);
      });

      it("should allow accessing stats with joined path", () => {
        const logger = getLogger("timing-test-path");

        logger.timeStart("a", "b", "c");
        logger.timeEnd("a", "b", "c");

        // Both ways should work
        const stats1 = logger.getTimeStats("a", "b", "c");
        const stats2 = logger.getTimeStats("a/b/c");

        expect(stats1).toBeDefined();
        expect(stats2).toBeDefined();
        expect(stats1?.count).toBe(1);
        expect(stats2?.count).toBe(1);
      });
    });

    describe("time() direct recording", () => {
      it("should record timing with explicit start time", () => {
        const logger = getLogger("timing-test-direct");

        const startTime = performance.now();
        // Small delay
        const delay = performance.now();
        while (performance.now() - delay < 2) {
          // busy wait
        }

        const elapsed = logger.time(startTime, "ipc", "request");

        expect(elapsed).toBeGreaterThanOrEqual(0);

        const stats = logger.getTimeStats("ipc", "request");
        expect(stats).toBeDefined();
        expect(stats?.count).toBe(1);
      });

      it("should record timing with explicit start and end times", () => {
        const logger = getLogger("timing-test-explicit");

        const startTime = 100;
        const endTime = 150;

        const elapsed = logger.time(startTime, endTime, "ipc", "test");

        expect(elapsed).toBe(50);

        const stats = logger.getTimeStats("ipc", "test");
        expect(stats?.min).toBe(50);
        expect(stats?.max).toBe(50);
      });

      it("should record hierarchical stats with direct recording", () => {
        const logger = getLogger("timing-test-direct-hierarchy");

        logger.time(100, 120, "ipc", "CellGet");

        expect(logger.getTimeStats("ipc")?.count).toBe(1);
        expect(logger.getTimeStats("ipc", "CellGet")?.count).toBe(1);
        expect(logger.getTimeStats("ipc")?.min).toBe(20);
        expect(logger.getTimeStats("ipc", "CellGet")?.min).toBe(20);
      });
    });

    describe("timing statistics calculation", () => {
      it("should calculate min/max/average correctly", () => {
        const logger = getLogger("timing-test-stats");

        // Record with explicit times for predictable values
        logger.time(0, 10, "op");
        logger.time(0, 20, "op");
        logger.time(0, 30, "op");
        logger.time(0, 40, "op");
        logger.time(0, 50, "op");

        const stats = logger.getTimeStats("op");

        expect(stats?.count).toBe(5);
        expect(stats?.min).toBe(10);
        expect(stats?.max).toBe(50);
        expect(stats?.totalTime).toBe(150);
        expect(stats?.average).toBe(30);
      });

      it("should calculate percentiles from samples", () => {
        const logger = getLogger("timing-test-percentiles");

        // Record 100 samples: 1-100ms
        for (let i = 1; i <= 100; i++) {
          logger.time(0, i, "op");
        }

        const stats = logger.getTimeStats("op");

        expect(stats?.count).toBe(100);
        expect(stats?.min).toBe(1);
        expect(stats?.max).toBe(100);

        // p50 should be around 50
        expect(stats?.p50).toBeGreaterThanOrEqual(40);
        expect(stats?.p50).toBeLessThanOrEqual(60);

        // p95 should be around 95
        expect(stats?.p95).toBeGreaterThanOrEqual(85);
        expect(stats?.p95).toBeLessThanOrEqual(100);
      });

      it("should track lastTime and lastTimestamp", () => {
        const logger = getLogger("timing-test-last");

        logger.time(0, 25, "op");
        const stats1 = logger.getTimeStats("op");
        expect(stats1?.lastTime).toBe(25);
        expect(stats1?.lastTimestamp).toBeGreaterThan(0);

        logger.time(0, 75, "op");
        const stats2 = logger.getTimeStats("op");
        expect(stats2?.lastTime).toBe(75);
        expect(stats2?.lastTimestamp).toBeGreaterThanOrEqual(
          stats1?.lastTimestamp ?? 0,
        );
      });
    });

    describe("timeStats property", () => {
      it("should return all timing stats as flat map", () => {
        const logger = getLogger("timing-test-all");

        logger.time(0, 10, "a", "b");
        logger.time(0, 20, "c");
        logger.time(0, 30, "d", "e", "f");

        const allStats = logger.timeStats;

        expect(Object.keys(allStats)).toContain("a");
        expect(Object.keys(allStats)).toContain("a/b");
        expect(Object.keys(allStats)).toContain("c");
        expect(Object.keys(allStats)).toContain("d");
        expect(Object.keys(allStats)).toContain("d/e");
        expect(Object.keys(allStats)).toContain("d/e/f");
      });

      it("should return empty object when no timings recorded", () => {
        const logger = getLogger("timing-test-empty");
        const allStats = logger.timeStats;

        expect(Object.keys(allStats)).toHaveLength(0);
      });
    });

    describe("resetTimeStats", () => {
      it("should clear all timing data", () => {
        const logger = getLogger("timing-test-reset");

        logger.time(0, 10, "op1");
        logger.time(0, 20, "op2");
        logger.timeStart("op3");

        expect(Object.keys(logger.timeStats).length).toBeGreaterThan(0);

        logger.resetTimeStats();

        expect(Object.keys(logger.timeStats)).toHaveLength(0);
        expect(logger.getTimeStats("op1")).toBeUndefined();
        expect(logger.getTimeStats("op2")).toBeUndefined();

        // Active timer should also be cleared
        const elapsed = logger.timeEnd("op3");
        expect(elapsed).toBeUndefined();
      });
    });

    describe("getTimingStatsBreakdown", () => {
      it("should aggregate timing stats from all loggers", () => {
        const logger1 = getLogger("timing-breakdown-1");
        const logger2 = getLogger("timing-breakdown-2");

        logger1.time(0, 10, "op1");
        logger2.time(0, 20, "op2");

        const breakdown = getTimingStatsBreakdown();

        expect(breakdown["timing-breakdown-1"]).toBeDefined();
        expect(breakdown["timing-breakdown-2"]).toBeDefined();
        expect(breakdown["timing-breakdown-1"]["op1"]?.count).toBe(1);
        expect(breakdown["timing-breakdown-2"]["op2"]?.count).toBe(1);
      });

      it("should not include loggers with no timing data", () => {
        const loggerWithTiming = getLogger("timing-breakdown-has-data");
        const loggerNoTiming = getLogger("timing-breakdown-no-data");

        loggerWithTiming.time(0, 10, "op");
        // loggerNoTiming has no timing data

        const breakdown = getTimingStatsBreakdown();

        expect(breakdown["timing-breakdown-has-data"]).toBeDefined();
        expect(breakdown["timing-breakdown-no-data"]).toBeUndefined();
      });
    });

    describe("resetAllTimingStats", () => {
      it("should reset timing stats for all loggers", () => {
        const logger1 = getLogger("timing-reset-all-1");
        const logger2 = getLogger("timing-reset-all-2");

        logger1.time(0, 10, "op");
        logger2.time(0, 20, "op");

        expect(Object.keys(logger1.timeStats).length).toBeGreaterThan(0);
        expect(Object.keys(logger2.timeStats).length).toBeGreaterThan(0);

        resetAllTimingStats();

        expect(Object.keys(logger1.timeStats)).toHaveLength(0);
        expect(Object.keys(logger2.timeStats)).toHaveLength(0);
      });

      it("should handle empty logger registry gracefully", () => {
        // Clean up registry
        const global = globalThis as unknown as {
          commontools?: { logger?: Record<string, unknown> };
        };
        if (global.commontools?.logger) {
          global.commontools.logger = {};
        }

        expect(() => resetAllTimingStats()).not.toThrow();
      });
    });

    describe("reservoir sampling", () => {
      it("should maintain bounded memory with many samples", () => {
        const logger = getLogger("timing-reservoir-test");

        // Record many samples to test reservoir behavior
        for (let i = 1; i <= 2000; i++) {
          logger.time(0, i, "high-volume");
        }

        const stats = logger.getTimeStats("high-volume");

        expect(stats?.count).toBe(2000);
        expect(stats?.min).toBe(1);
        expect(stats?.max).toBe(2000);

        // Percentiles should still be approximately correct due to reservoir sampling
        // With 2000 samples uniformly distributed 1-2000:
        // p50 should be around 1000, p95 should be around 1900
        // Allow wider margin due to random sampling
        expect(stats?.p50).toBeGreaterThan(500);
        expect(stats?.p50).toBeLessThan(1500);
        expect(stats?.p95).toBeGreaterThan(1500);
        expect(stats?.p95).toBeLessThanOrEqual(2000);
      });
    });

    describe("edge cases", () => {
      it("should handle zero elapsed time", () => {
        const logger = getLogger("timing-zero");

        logger.time(100, 100, "zero-time");

        const stats = logger.getTimeStats("zero-time");
        expect(stats?.min).toBe(0);
        expect(stats?.max).toBe(0);
        expect(stats?.average).toBe(0);
      });

      it("should handle single key (non-hierarchical)", () => {
        const logger = getLogger("timing-single");

        logger.time(0, 10, "single");

        const stats = logger.getTimeStats("single");
        expect(stats?.count).toBe(1);

        // Should NOT create parent paths for single keys
        expect(Object.keys(logger.timeStats)).toEqual(["single"]);
      });

      it("should accumulate stats for repeated measurements", () => {
        const logger = getLogger("timing-accumulate");

        logger.time(0, 10, "op");
        logger.time(0, 20, "op");
        logger.time(0, 30, "op");

        const stats = logger.getTimeStats("op");
        expect(stats?.count).toBe(3);
        expect(stats?.totalTime).toBe(60);
      });

      it("should handle stats request for nonexistent key", () => {
        const logger = getLogger("timing-nonexistent");

        const stats = logger.getTimeStats("does-not-exist");
        expect(stats).toBeUndefined();
      });
    });
  });
});
