import { beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { getLogger, log, LOG_COLORS } from "../src/logger.ts";

describe("logger", () => {
  beforeEach(() => {
    // Reset to default log level before each test
    log.level = "info";
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
    (console[method] as any) = (...args: unknown[]) => {
      calls.push(args);
    };

    try {
      const result = fn();
      return { result, calls };
    } finally {
      // Restore original method
      (console[method] as any) = originalMethod;
    }
  }

  describe("basic log function", () => {
    it("should default to enabled state", () => {
      expect(log.disabled).toBe(false);
    });

    it("should log messages to console", () => {
      const { calls } = captureConsole("log", () => {
        log.info("hello", "world");
      });

      expect(calls).toHaveLength(1);
      expectStyledTimestamp(calls, 0, LOG_COLORS.info, "INFO");
      expect(calls[0].slice(2)).toEqual(["hello", "world"]);
    });

    it("should handle multiple arguments", () => {
      const { calls } = captureConsole("log", () => {
        log.info("a", 1, true, { key: "value" });
      });

      expect(calls).toHaveLength(1);
      expectStyledTimestamp(calls, 0, LOG_COLORS.info, "INFO");
      expect(calls[0].slice(2)).toEqual(["a", 1, true, { key: "value" }]);
    });

    it("should evaluate lazy functions", () => {
      let evaluated = false;
      const lazyMessage = () => {
        evaluated = true;
        return "lazy value";
      };

      const { calls } = captureConsole("log", () => {
        log.info("static", lazyMessage);
      });

      expect(evaluated).toBe(true);
      expect(calls).toHaveLength(1);
      expectStyledTimestamp(calls, 0, LOG_COLORS.info, "INFO");
      expect(calls[0].slice(2)).toEqual(["static", "lazy value"]);
    });

    it("should handle mixed static and lazy messages", () => {
      const { calls } = captureConsole("log", () => {
        log.info(
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
          "prefix",
          () => ["array", "of", "values"],
          "suffix",
        );
      });

      expect(calls).toHaveLength(1);
      expectStyledTimestamp(calls, 0, LOG_COLORS.info, "INFO");
      expect(calls[0].slice(2)).toEqual([
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
        log.debug("debug message");
      });

      expect(calls).toHaveLength(1);
      expectStyledTimestamp(calls, 0, LOG_COLORS.debug, "DEBUG");
      expect(calls[0].slice(2)).toEqual(["debug message"]);
    });

    it("should log info messages", () => {
      const { calls } = captureConsole("log", () => {
        log.info("info message");
      });

      expect(calls).toHaveLength(1);
      expectStyledTimestamp(calls, 0, LOG_COLORS.info, "INFO");
      expect(calls[0].slice(2)).toEqual(["info message"]);
    });

    it("should log warning messages", () => {
      const { calls } = captureConsole("warn", () => {
        log.warn("warning message");
      });

      expect(calls).toHaveLength(1);
      expectStyledTimestamp(calls, 0, LOG_COLORS.warn, "WARN");
      expect(calls[0].slice(2)).toEqual(["warning message"]);
    });

    it("should log error messages", () => {
      const { calls } = captureConsole("error", () => {
        log.error("error message");
      });

      expect(calls).toHaveLength(1);
      expectStyledTimestamp(calls, 0, LOG_COLORS.error, "ERROR");
      expect(calls[0].slice(2)).toEqual(["error message"]);
    });

    it("should default to info level when using log.info()", () => {
      const { calls } = captureConsole("log", () => {
        log.info("default message");
      });

      expect(calls).toHaveLength(1);
      expectStyledTimestamp(calls, 0, LOG_COLORS.info, "INFO");
      expect(calls[0].slice(2)).toEqual(["default message"]);
    });

    it("should support log.log() as alias for info", () => {
      const { calls } = captureConsole("log", () => {
        log.log("message via log()");
      });

      expect(calls).toHaveLength(1);
      expectStyledTimestamp(calls, 0, LOG_COLORS.info, "INFO");
      expect(calls[0].slice(2)).toEqual(["message via log()"]);
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
        log.debug(lazyDebug);
      });
      const { calls: infoCalls } = captureConsole("log", () => {
        log.info(lazyInfo);
      });
      const { calls: warnCalls } = captureConsole("warn", () => {
        log.warn(lazyWarn);
      });
      const { calls: errorCalls } = captureConsole("error", () => {
        log.error(lazyError);
      });

      expect(debugCalls[0].slice(2)).toEqual(["lazy debug"]);
      expect(infoCalls[0].slice(2)).toEqual(["lazy info"]);
      expect(warnCalls[0].slice(2)).toEqual(["lazy warn"]);
      expect(errorCalls[0].slice(2)).toEqual(["lazy error"]);
    });

    it("should not evaluate lazy functions when disabled", () => {
      log.disabled = true;
      let evaluated = false;
      const lazyMessage = () => {
        evaluated = true;
        return "should not be evaluated";
      };

      const { calls } = captureConsole("log", () => {
        log.info(lazyMessage);
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
        log.debug("debug message");
      });
      const { calls: infoCalls } = captureConsole("log", () => {
        log.info("info message");
      });
      const { calls: warnCalls } = captureConsole("warn", () => {
        log.warn("warning message");
      });
      const { calls: errorCalls } = captureConsole("error", () => {
        log.error("error message");
      });

      expect(debugCalls).toHaveLength(0);
      expect(infoCalls).toHaveLength(0);
      expect(warnCalls).toHaveLength(1);
      expect(errorCalls).toHaveLength(1);
    });

    it("should show all messages when set to debug", () => {
      log.level = "debug"; // Enable all levels
      const { calls: debugCalls } = captureConsole("debug", () => {
        log.debug("debug message");
      });
      const { calls: infoCalls } = captureConsole("log", () => {
        log.info("info message");
      });
      const { calls: warnCalls } = captureConsole("warn", () => {
        log.warn("warning message");
      });
      const { calls: errorCalls } = captureConsole("error", () => {
        log.error("error message");
      });

      expect(debugCalls).toHaveLength(1);
      expect(infoCalls).toHaveLength(1);
      expect(warnCalls).toHaveLength(1);
      expect(errorCalls).toHaveLength(1);
    });

    it("should only show error messages when set to error", () => {
      log.level = "error";
      const { calls: debugCalls } = captureConsole("debug", () => {
        log.debug("debug message");
      });
      const { calls: infoCalls } = captureConsole("log", () => {
        log.info("info message");
      });
      const { calls: warnCalls } = captureConsole("warn", () => {
        log.warn("warning message");
      });
      const { calls: errorCalls } = captureConsole("error", () => {
        log.error("error message");
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
        logger.info("test message");
      });

      expect(calls).toHaveLength(1);
      expectStyledModuleTimestamp(
        calls,
        0,
        "test-module",
        LOG_COLORS.taggedInfo,
        "INFO",
      );
      expect(calls[0].slice(2)).toEqual(["test message"]);
    });

    it("should support log() method as alias for info()", () => {
      const logger = getLogger("test-module");
      const { calls } = captureConsole("log", () => {
        logger.log("test message via log()");
      });

      expect(calls).toHaveLength(1);
      expectStyledModuleTimestamp(
        calls,
        0,
        "test-module",
        LOG_COLORS.taggedInfo,
        "INFO",
      );
      expect(calls[0].slice(2)).toEqual(["test message via log()"]);
    });

    it("should support all log levels in tagged logger", () => {
      const logger = getLogger("test-module");
      logger.level = "debug"; // Enable all levels

      const { calls: debugCalls } = captureConsole("debug", () => {
        logger.debug("debug message");
      });
      const { calls: infoCalls } = captureConsole("log", () => {
        logger.info("info message");
      });
      const { calls: warnCalls } = captureConsole("warn", () => {
        logger.warn("warning message");
      });
      const { calls: errorCalls } = captureConsole("error", () => {
        logger.error("error message");
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
        logger.debug("debug message");
      });
      const { calls: infoCalls } = captureConsole("log", () => {
        logger.info("info message");
      });
      const { calls: warnCalls } = captureConsole("warn", () => {
        logger.warn("warning message");
      });
      const { calls: errorCalls } = captureConsole("error", () => {
        logger.error("error message");
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
        logger.info(lazyMessage);
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
      expect(calls[0].slice(2)).toEqual(["lazy tagged message"]);
    });

    it("should support disabled state in tagged logger", () => {
      const logger = getLogger("test-module", { enabled: false });
      let evaluated = false;
      const lazyMessage = () => {
        evaluated = true;
        return "should not be evaluated";
      };

      const { calls } = captureConsole("log", () => {
        logger.info(lazyMessage);
      });

      expect(evaluated).toBe(false);
      expect(calls).toHaveLength(0);
      expect(logger.disabled).toBe(true);
    });

    it("should default to enabled state", () => {
      const logger = getLogger("test-module");
      expect(logger.disabled).toBe(false);

      const { calls } = captureConsole("log", () => {
        logger.info("should show by default");
      });

      expect(calls).toHaveLength(1);
    });

    it("should allow runtime enable/disable of tagged logger", () => {
      const logger = getLogger("test-module", { enabled: false });

      // Initially disabled
      const { calls: disabledCalls } = captureConsole("log", () => {
        logger.info("should not show");
      });
      expect(disabledCalls).toHaveLength(0);

      // Enable at runtime
      logger.disabled = false;
      const { calls: enabledCalls } = captureConsole("log", () => {
        logger.info("should show");
      });
      expect(enabledCalls).toHaveLength(1);

      // Disable again
      logger.disabled = true;
      const { calls: disabledAgainCalls } = captureConsole("log", () => {
        logger.info("should not show again");
      });
      expect(disabledAgainCalls).toHaveLength(0);
    });
  });

  describe("global vs tagged logger", () => {
    it("should have different formatting for global vs tagged", () => {
      const taggedLogger = getLogger("test-module");

      const { calls: globalCalls } = captureConsole("log", () => {
        log.info("global message");
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
        log.debug("global debug");
      });
      const { calls: globalWarnCalls } = captureConsole("warn", () => {
        log.warn("global warn");
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
});
