/**
 * Sandboxed console implementation for pattern execution.
 *
 * This console prefixes all output with the pattern ID to help
 * identify which pattern is producing log output.
 */

export interface SandboxedConsoleOptions {
  /**
   * The pattern ID to prefix log messages with.
   */
  readonly patternId: string;

  /**
   * Whether to include timestamps in log messages.
   */
  readonly includeTimestamp?: boolean;

  /**
   * Maximum length of log messages before truncation.
   */
  readonly maxMessageLength?: number;

  /**
   * The underlying console to write to.
   */
  readonly targetConsole?: Console;
}

/**
 * Create a sandboxed console that prefixes all output with the pattern ID.
 *
 * This helps identify which pattern is producing log output during debugging.
 *
 * @param options - Configuration options
 * @returns A Console-compatible object
 */
export function createSandboxedConsole(
  options: SandboxedConsoleOptions,
): Console {
  const {
    patternId,
    includeTimestamp = false,
    maxMessageLength = 10000,
    targetConsole = console,
  } = options;

  const prefix = `[${patternId}]`;

  const formatArgs = (args: unknown[]): unknown[] => {
    const timestamp = includeTimestamp ? `[${new Date().toISOString()}]` : "";
    const fullPrefix = timestamp ? `${timestamp} ${prefix}` : prefix;

    // Truncate very long messages
    const processedArgs = args.map((arg) => {
      if (typeof arg === "string" && arg.length > maxMessageLength) {
        return arg.slice(0, maxMessageLength) + "... [truncated]";
      }
      return arg;
    });

    return [fullPrefix, ...processedArgs];
  };

  return {
    log: (...args: unknown[]) => {
      targetConsole.log(...formatArgs(args));
    },
    info: (...args: unknown[]) => {
      targetConsole.info(...formatArgs(args));
    },
    warn: (...args: unknown[]) => {
      targetConsole.warn(...formatArgs(args));
    },
    error: (...args: unknown[]) => {
      targetConsole.error(...formatArgs(args));
    },
    debug: (...args: unknown[]) => {
      targetConsole.debug(...formatArgs(args));
    },
    trace: (...args: unknown[]) => {
      targetConsole.trace(...formatArgs(args));
    },
    assert: (condition?: boolean, ...args: unknown[]) => {
      if (!condition) {
        targetConsole.error(...formatArgs(["Assertion failed:", ...args]));
      }
    },
    clear: () => {
      // No-op: don't allow patterns to clear the console
    },
    count: (label?: string) => {
      targetConsole.count(`${prefix} ${label ?? "default"}`);
    },
    countReset: (label?: string) => {
      targetConsole.countReset(`${prefix} ${label ?? "default"}`);
    },
    dir: (obj: unknown, options?: object) => {
      targetConsole.log(prefix, "dir:");
      targetConsole.dir(obj, options);
    },
    dirxml: (...args: unknown[]) => {
      targetConsole.log(...formatArgs(["dirxml:", ...args]));
    },
    group: (...args: unknown[]) => {
      targetConsole.group(...formatArgs(args));
    },
    groupCollapsed: (...args: unknown[]) => {
      targetConsole.groupCollapsed(...formatArgs(args));
    },
    groupEnd: () => {
      targetConsole.groupEnd();
    },
    table: (data: unknown, columns?: string[]) => {
      targetConsole.log(prefix, "table:");
      targetConsole.table(data, columns);
    },
    time: (label?: string) => {
      targetConsole.time(`${prefix} ${label ?? "default"}`);
    },
    timeEnd: (label?: string) => {
      targetConsole.timeEnd(`${prefix} ${label ?? "default"}`);
    },
    timeLog: (label?: string, ...args: unknown[]) => {
      targetConsole.timeLog(`${prefix} ${label ?? "default"}`, ...args);
    },
    timeStamp: (label?: string) => {
      // @ts-ignore: timeStamp is not in standard Console interface but exists in some environments
      if (typeof targetConsole.timeStamp === "function") {
        // @ts-ignore: timeStamp is not in standard Console interface but exists in some environments
        targetConsole.timeStamp(`${prefix} ${label ?? ""}`);
      }
    },
    // @ts-ignore: profile is not in standard Console interface but exists in some environments
    profile: (label?: string) => {
      // @ts-ignore: profile is not in standard Console interface but exists in some environments
      if (typeof targetConsole.profile === "function") {
        // @ts-ignore: profile is not in standard Console interface but exists in some environments
        targetConsole.profile(`${prefix} ${label ?? ""}`);
      }
    },
    // @ts-ignore: profileEnd is not in standard Console interface but exists in some environments
    profileEnd: (label?: string) => {
      // @ts-ignore: profileEnd is not in standard Console interface but exists in some environments
      if (typeof targetConsole.profileEnd === "function") {
        // @ts-ignore: profileEnd is not in standard Console interface but exists in some environments
        targetConsole.profileEnd(`${prefix} ${label ?? ""}`);
      }
    },
  } as Console;
}

/**
 * Create a no-op console that silently discards all output.
 * Useful for production environments where pattern logs should be suppressed.
 */
export function createSilentConsole(): Console {
  const noop = () => {};
  return {
    log: noop,
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    assert: noop,
    clear: noop,
    count: noop,
    countReset: noop,
    dir: noop,
    dirxml: noop,
    group: noop,
    groupCollapsed: noop,
    groupEnd: noop,
    table: noop,
    time: noop,
    timeEnd: noop,
    timeLog: noop,
    timeStamp: noop,
    profile: noop,
    profileEnd: noop,
  } as Console;
}
