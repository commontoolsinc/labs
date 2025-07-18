import { beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  getLogger,
  getLogLevel,
  log,
  LOG_COLORS,
  setLogLevel,
} from "../src/logger.ts";

describe("logger", () => {
  // Save initial log level
  let initialLogLevel: string;

  beforeEach(() => {
    // Reset to default log level before each test
    setLogLevel("info");
  });

  // Helper to match timestamp pattern [HH:MM:SS.mmm]
  function isTimestamp(value: unknown): boolean {
    if (typeof value !== "string") return false;
    return /^\[\d{2}:\d{2}:\d{2}\.\d{3}\]$/.test(value);
  }

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
    it("should log messages to console", () => {
      const { calls } = captureConsole("log", () => {
        log("hello", "world");
      });

      expect(calls).toHaveLength(1);
      expectStyledTimestamp(calls, 0, LOG_COLORS.info, "INFO");
      expect(calls[0].slice(2)).toEqual(["hello", "world"]);
    });

    it("should handle multiple arguments", () => {
      const { calls } = captureConsole("log", () => {
        log("a", 1, true, { key: "value" });
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
        log("static", lazyMessage);
      });

      expect(evaluated).toBe(true);
      expect(calls).toHaveLength(1);
      expectStyledTimestamp(calls, 0, LOG_COLORS.info, "INFO");
      expect(calls[0].slice(2)).toEqual(["static", "lazy value"]);
    });

    it("should handle mixed static and lazy messages", () => {
      const { calls } = captureConsole("log", () => {
        log(
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
  });

  describe("severity levels", () => {
    it("should log debug messages", () => {
      setLogLevel("debug"); // Enable debug level
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

    it("should default to info level when using log()", () => {
      const { calls } = captureConsole("log", () => {
        log("default message");
      });

      expect(calls).toHaveLength(1);
      expectStyledTimestamp(calls, 0, LOG_COLORS.info, "INFO");
      expect(calls[0].slice(2)).toEqual(["default message"]);
    });

    it("should handle lazy evaluation for all levels", () => {
      setLogLevel("debug"); // Enable all levels

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

      expectStyledTimestamp(debugCalls, 0, LOG_COLORS.debug, "DEBUG");
      expect(debugCalls[0].slice(2)).toEqual(["lazy debug"]);
      expectStyledTimestamp(infoCalls, 0, LOG_COLORS.info, "INFO");
      expect(infoCalls[0].slice(2)).toEqual(["lazy info"]);
      expectStyledTimestamp(warnCalls, 0, LOG_COLORS.warn, "WARN");
      expect(warnCalls[0].slice(2)).toEqual(["lazy warn"]);
      expectStyledTimestamp(errorCalls, 0, LOG_COLORS.error, "ERROR");
      expect(errorCalls[0].slice(2)).toEqual(["lazy error"]);
    });
  });

  describe("severity filtering", () => {
    it("should filter messages below the current log level", () => {
      setLogLevel("warn");

      const { calls: debugCalls } = captureConsole("debug", () => {
        log.debug("debug message");
      });
      const { calls: infoCalls } = captureConsole("log", () => {
        log.info("info message");
      });
      const { calls: warnCalls } = captureConsole("warn", () => {
        log.warn("warn message");
      });
      const { calls: errorCalls } = captureConsole("error", () => {
        log.error("error message");
      });

      expect(debugCalls).toHaveLength(0); // Filtered out
      expect(infoCalls).toHaveLength(0); // Filtered out
      expect(warnCalls).toHaveLength(1); // Logged
      expect(errorCalls).toHaveLength(1); // Logged
    });

    it("should NOT evaluate lazy functions when severity is filtered out", () => {
      setLogLevel("error");

      let debugEvaluated = false;
      let infoEvaluated = false;
      let warnEvaluated = false;
      let errorEvaluated = false;

      captureConsole("debug", () => {
        log.debug(() => {
          debugEvaluated = true;
          return "expensive debug";
        });
      });

      captureConsole("log", () => {
        log.info(() => {
          infoEvaluated = true;
          return "expensive info";
        });
      });

      captureConsole("warn", () => {
        log.warn(() => {
          warnEvaluated = true;
          return "expensive warn";
        });
      });

      captureConsole("error", () => {
        log.error(() => {
          errorEvaluated = true;
          return "expensive error";
        });
      });

      expect(debugEvaluated).toBe(false); // Not evaluated!
      expect(infoEvaluated).toBe(false); // Not evaluated!
      expect(warnEvaluated).toBe(false); // Not evaluated!
      expect(errorEvaluated).toBe(true); // Evaluated
    });

    it("should respect setLogLevel changes", () => {
      // Start with debug level (everything logs)
      setLogLevel("debug");

      const { calls: debugCalls1 } = captureConsole("debug", () => {
        log.debug("debug 1");
      });
      expect(debugCalls1).toHaveLength(1);

      // Change to error level
      setLogLevel("error");

      const { calls: debugCalls2 } = captureConsole("debug", () => {
        log.debug("debug 2");
      });
      expect(debugCalls2).toHaveLength(0); // Now filtered
    });

    it("should get and set log levels correctly", () => {
      expect(getLogLevel()).toBe("info"); // Default

      setLogLevel("debug");
      expect(getLogLevel()).toBe("debug");

      setLogLevel("error");
      expect(getLogLevel()).toBe("error");
    });

    it("should throw on invalid log level", () => {
      expect(() => setLogLevel("invalid" as any)).toThrow(
        "Invalid log level: invalid",
      );
    });
  });

  describe("module tagging with getLogger", () => {
    it("should extract module name from file URLs", () => {
      const mathLogger = getLogger({
        url: "file:///home/user/project/utils/math.ts",
      });
      const { calls } = captureConsole("log", () => {
        mathLogger.info("calculation complete");
      });

      expect(calls).toHaveLength(1);
      expectStyledModuleTimestamp(
        calls,
        0,
        "math",
        LOG_COLORS.taggedInfo,
        "INFO",
      );
      expect(calls[0].slice(2)).toEqual(["calculation complete"]);
    });

    it("should handle various URL formats", () => {
      // Test different URL patterns
      const testCases = [
        { url: "file:///path/to/index.ts", expected: "index" },
        { url: "file:///path/to/user-service.js", expected: "user-service" },
        { url: "https://example.com/module.js", expected: "module" },
        {
          url: "file:///complex.name.with.dots.ts",
          expected: "complex.name.with.dots",
        },
      ];

      for (const { url, expected } of testCases) {
        const logger = getLogger({ url });
        const { calls } = captureConsole("log", () => {
          logger("test");
        });

        expectStyledModuleTimestamp(
          calls,
          0,
          expected,
          LOG_COLORS.taggedInfo,
          "INFO",
        );
      }
    });

    it("should handle invalid URLs gracefully", () => {
      const logger = getLogger({ url: "not-a-valid-url" });
      const { calls } = captureConsole("log", () => {
        logger("test message");
      });

      expect(calls).toHaveLength(1);
      expectStyledModuleTimestamp(
        calls,
        0,
        "unknown",
        LOG_COLORS.taggedInfo,
        "INFO",
      );
      expect(calls[0].slice(2)).toEqual(["test message"]);
    });

    it("should work with all severity levels", () => {
      setLogLevel("debug");
      const logger = getLogger({ url: "file:///path/to/auth.ts" });

      const { calls: debugCalls } = captureConsole("debug", () => {
        logger.debug("debug msg");
      });
      const { calls: infoCalls } = captureConsole("log", () => {
        logger.info("info msg");
      });
      const { calls: warnCalls } = captureConsole("warn", () => {
        logger.warn("warn msg");
      });
      const { calls: errorCalls } = captureConsole("error", () => {
        logger.error("error msg");
      });

      expectStyledModuleTimestamp(
        debugCalls,
        0,
        "auth",
        LOG_COLORS.taggedDebug,
        "DEBUG",
      );
      expect(debugCalls[0].slice(2)).toEqual(["debug msg"]);
      expectStyledModuleTimestamp(
        infoCalls,
        0,
        "auth",
        LOG_COLORS.taggedInfo,
        "INFO",
      );
      expect(infoCalls[0].slice(2)).toEqual(["info msg"]);
      expectStyledModuleTimestamp(
        warnCalls,
        0,
        "auth",
        LOG_COLORS.taggedWarn,
        "WARN",
      );
      expect(warnCalls[0].slice(2)).toEqual(["warn msg"]);
      expectStyledModuleTimestamp(
        errorCalls,
        0,
        "auth",
        LOG_COLORS.taggedError,
        "ERROR",
      );
      expect(errorCalls[0].slice(2)).toEqual(["error msg"]);
    });

    it("should respect severity filtering with tagged loggers", () => {
      setLogLevel("warn");
      const logger = getLogger({ url: "file:///path/to/database.ts" });

      const { calls: debugCalls } = captureConsole("debug", () => {
        logger.debug("should not appear");
      });
      const { calls: warnCalls } = captureConsole("warn", () => {
        logger.warn("should appear");
      });

      expect(debugCalls).toHaveLength(0);
      expect(warnCalls).toHaveLength(1);
      expectStyledModuleTimestamp(
        warnCalls,
        0,
        "database",
        LOG_COLORS.taggedWarn,
        "WARN",
      );
      expect(warnCalls[0].slice(2)).toEqual(["should appear"]);
    });

    it("should handle lazy evaluation with tags", () => {
      setLogLevel("error");
      const logger = getLogger({ url: "file:///path/to/service.ts" });

      let evaluated = false;
      captureConsole("log", () => {
        logger.info(() => {
          evaluated = true;
          return "expensive message";
        });
      });

      expect(evaluated).toBe(false); // Not evaluated due to filtering

      // Now test that it does evaluate when level allows
      evaluated = false;
      const { calls } = captureConsole("error", () => {
        logger.error(() => {
          evaluated = true;
          return "error message";
        });
      });

      expect(evaluated).toBe(true);
      expectStyledModuleTimestamp(
        calls,
        0,
        "service",
        LOG_COLORS.taggedError,
        "ERROR",
      );
      expect(calls[0].slice(2)).toEqual(["error message"]);
    });

    it("should use real import.meta.url", () => {
      // This test uses the actual import.meta.url of this test file
      const logger = getLogger({ url: import.meta.url });
      const { calls } = captureConsole("log", () => {
        logger("test from logger.test");
      });

      expect(calls).toHaveLength(1);
      expectStyledModuleTimestamp(
        calls,
        0,
        "logger.test",
        LOG_COLORS.taggedInfo,
        "INFO",
      );
    });

    it("should auto-detect caller when no URL provided", () => {
      // Call getLogger without parameters
      const logger = getLogger();
      const { calls } = captureConsole("log", () => {
        logger("auto-detected module");
      });

      expect(calls).toHaveLength(1);
      // Should detect this test file
      expectStyledModuleTimestamp(
        calls,
        0,
        "logger.test",
        LOG_COLORS.taggedInfo,
        "INFO",
      );
    });
  });

  describe("disabled property", () => {
    it("should create enabled logger by default", () => {
      const logger = getLogger();
      expect(logger.disabled).toBe(undefined);

      const { calls } = captureConsole("log", () => {
        logger.info("should appear");
      });

      expect(calls).toHaveLength(1);
      expectStyledModuleTimestamp(
        calls,
        0,
        "logger.test",
        LOG_COLORS.taggedInfo,
        "INFO",
      );
      expect(calls[0].slice(2)).toEqual(["should appear"]);
    });

    it("should create disabled logger when enabled: false", () => {
      const logger = getLogger({ enabled: false });
      expect(logger.disabled).toBe(true);

      const { calls } = captureConsole("log", () => {
        logger.info("should not appear");
      });

      expect(calls).toHaveLength(0);
    });

    it("should create enabled logger when enabled: true", () => {
      const logger = getLogger({ enabled: true });
      expect(logger.disabled).toBe(false);

      const { calls } = captureConsole("log", () => {
        logger.info("should appear");
      });

      expect(calls).toHaveLength(1);
    });

    it("should respect runtime changes to disabled property", () => {
      const logger = getLogger();

      // Initially enabled
      const { calls: calls1 } = captureConsole("log", () => {
        logger.info("message 1");
      });
      expect(calls1).toHaveLength(1);

      // Disable it
      logger.disabled = true;
      const { calls: calls2 } = captureConsole("log", () => {
        logger.info("message 2");
      });
      expect(calls2).toHaveLength(0);

      // Re-enable it
      logger.disabled = false;
      const { calls: calls3 } = captureConsole("log", () => {
        logger.info("message 3");
      });
      expect(calls3).toHaveLength(1);
    });

    it("should NOT evaluate lazy functions when disabled", () => {
      const logger = getLogger({ enabled: false });

      let evaluated = false;
      captureConsole("log", () => {
        logger.info(() => {
          evaluated = true;
          return "expensive computation";
        });
      });

      expect(evaluated).toBe(false); // Not evaluated!
    });

    it("should work with all severity levels when disabled", () => {
      const logger = getLogger({ enabled: false });

      const { calls: debugCalls } = captureConsole("debug", () => {
        logger.debug("debug");
      });
      const { calls: infoCalls } = captureConsole("log", () => {
        logger.info("info");
      });
      const { calls: warnCalls } = captureConsole("warn", () => {
        logger.warn("warn");
      });
      const { calls: errorCalls } = captureConsole("error", () => {
        logger.error("error");
      });

      expect(debugCalls).toHaveLength(0);
      expect(infoCalls).toHaveLength(0);
      expect(warnCalls).toHaveLength(0);
      expect(errorCalls).toHaveLength(0);
    });

    it("should work with URL and options parameters", () => {
      const logger = getLogger({
        url: "file:///custom/module.ts",
        enabled: false,
      });

      const { calls } = captureConsole("log", () => {
        logger.info("test");
      });

      expect(calls).toHaveLength(0);
      expect(logger.disabled).toBe(true);
    });
  });
});
