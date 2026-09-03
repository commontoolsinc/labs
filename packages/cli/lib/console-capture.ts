/**
 * Channel-2 console capture for the pattern test runner: logger-level
 * error/warn detection via count deltas.
 *
 * Runtime-internal `logger.error` / `logger.warn` calls (e.g. pattern-manager,
 * cfc, llm) do not flow through the scheduler's harness console event, so the
 * runner detects them by snapshotting every logger's per-key error/warn counts
 * after compile and diffing at the end of the run. Message text is not
 * retained by the counts; the logger name + message key identify the source.
 *
 * Shared by the single-runtime runner (test-runner.ts) and the multi-user
 * worker (multi-user-test-worker.ts) — each worker process has its own logger
 * globals, so each captures its own deltas.
 */

import { isPerfDiagnosticWarnKey } from "./perf-diagnostic-logs.ts";

interface LevelCounts {
  error: number;
  warn: number;
}

interface LoggerGlobal {
  counts: LevelCounts;
  countsByKey?: Record<string, LevelCounts>;
}

/** Per-(logger, key) snapshot of error/warn counts at a point in time. */
export type LoggerErrorWarnSnapshot = Map<string, LevelCounts>;

const loggerGlobals = (): Record<string, LoggerGlobal> => {
  const global = globalThis as unknown as {
    commonfabric?: { logger?: Record<string, LoggerGlobal> };
  };
  return global.commonfabric?.logger ?? {};
};

const entryKey = (loggerName: string, key: string): string =>
  `${loggerName}\x00${key}`;

/**
 * Capture the current per-key error/warn counts for every registered logger.
 * Call right after compile, before the pattern run phase begins, so compile
 * infrastructure noise (cache misses etc.) is excluded while everything the
 * run phase logs is in scope.
 */
export function snapshotLoggerErrorWarnCounts(): LoggerErrorWarnSnapshot {
  const snapshot: LoggerErrorWarnSnapshot = new Map();
  for (const [name, logger] of Object.entries(loggerGlobals())) {
    for (const [key, counts] of Object.entries(logger.countsByKey ?? {})) {
      snapshot.set(entryKey(name, key), {
        error: counts.error,
        warn: counts.warn,
      });
    }
  }
  return snapshot;
}

/**
 * Diff current logger counts against the pre-run snapshot and append a
 * `[logger:<name>] <n> error(s)/warning(s) (key: <key>)` line per (logger,
 * key) that logged during the run. A warn key that
 * `perf-diagnostic-logs.ts` names a perf diagnostic is skipped.
 */
export function appendLoggerDeltaMessages(
  snapshot: LoggerErrorWarnSnapshot,
  errors: string[],
  warnings: string[],
): void {
  for (const [name, logger] of Object.entries(loggerGlobals())) {
    for (const [key, counts] of Object.entries(logger.countsByKey ?? {})) {
      const pre = snapshot.get(entryKey(name, key)) ?? { error: 0, warn: 0 };
      const deltaError = counts.error - pre.error;
      const deltaWarn = counts.warn - pre.warn;
      if (deltaError > 0) {
        errors.push(`[logger:${name}] ${deltaError} error(s) (key: ${key})`);
      }
      if (deltaWarn > 0 && !isPerfDiagnosticWarnKey(name, key)) {
        warnings.push(`[logger:${name}] ${deltaWarn} warning(s) (key: ${key})`);
      }
    }
  }
}
