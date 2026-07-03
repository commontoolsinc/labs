/**
 * Test runner for pattern-native tests.
 *
 * Test patterns (.test.tsx) are patterns that:
 * 1. Import and instantiate the pattern under test
 * 2. Define test steps as an array of { assertion } or { action } objects
 * 3. Return { tests: TestStep[] }
 *
 * TestStep is a discriminated union:
 * - { assertion: Reactive<boolean> } from computed(() => condition)
 * - { action: Stream<void> } from action(() => sideEffect)
 *
 * The discriminated union avoids TypeScript declaration emit issues
 * that occur when mixing Cell and Stream types in the same array.
 *
 * Example:
 * tests: [
 *   { assertion: computed(() => game.phase === "playing") },
 *   { action: action(() => game.start.send(undefined)) },
 *   { assertion: computed(() => game.phase === "started") },
 * ]
 *
 * Note: By default, test patterns can only import from their own directory or
 * subdirectories. To enable imports from sibling directories (e.g., `../shared/`),
 * use the --root option to specify a common ancestor directory.
 */

import { Identity } from "@commonfabric/identity";
import {
  ConsoleMethod,
  experimentalOptionsFromEnv,
  PatternCoverageCollector,
  patternCoverageOutputPath,
  Runtime,
  runtimePresets,
  writePatternCoverageLcov,
} from "@commonfabric/runner";
import type {
  Cell,
  ConsoleHandler,
  ErrorWithContext,
  ModuleByteCache,
  Pattern,
  SettleStats,
  Stream,
} from "@commonfabric/runner";
import type { CfcEnforcementMode } from "@commonfabric/runner/cfc";
import { getDefaultModuleByteCache } from "./compile-byte-cache.ts";
import type { Reactive } from "@commonfabric/api";
import { internSchema } from "@commonfabric/data-model/schema-hash";
import { toCompactDebugString } from "@commonfabric/data-model/value-debug";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import { basename } from "@std/path";
import { timeout } from "@commonfabric/utils/sleep";
import {
  appendLoggerDeltaMessages,
  snapshotLoggerErrorWarnCounts,
} from "./console-capture.ts";
import {
  buildActionEvent,
  type TrustedUiDescriptor,
} from "./trusted-test-event.ts";
import {
  multiUserDescriptorMeta,
  runMultiUserTestPattern,
} from "./multi-user-test-runner.ts";
import {
  type FetchMockEntry,
  makeMockFetch,
  readFetchMocks,
} from "./fetch-mock.ts";
import { materializeTestVDOM, mountTestVDOM } from "./materialize-test-vdom.ts";
import {
  type CDFPoint,
  getLogger,
  getLoggerCountsBreakdown,
  getTimingStatsBreakdown,
  resetAllCountBaselines,
  resetAllLoggerCounts,
  resetAllTimingBaselines,
  resetAllTimingStats,
} from "@commonfabric/utils/logger";

const phaseLogger = getLogger("test-runner-phase", {
  enabled: false,
  level: "debug",
  logCountEvery: 0,
});

type TimeStampConsole = Console & {
  timeStamp?: (label?: string) => void;
};

let phaseMarkSequence = 0;

function markPhaseBoundary(label: string, boundary: "start" | "end"): string {
  const markName = `${label}:${boundary}#${++phaseMarkSequence}`;
  performance.mark(markName);
  (console as TimeStampConsole).timeStamp?.(`${label}:${boundary}`);
  return markName;
}
async function withPhase<T>(
  keys: readonly string[],
  fn: () => Promise<T> | T,
): Promise<T> {
  const label = `cf-test/${keys.join("/")}`;
  const startMark = markPhaseBoundary(label, "start");
  phaseLogger.timeStart(...keys);
  try {
    return await fn();
  } finally {
    const endMark = markPhaseBoundary(label, "end");
    phaseLogger.timeEnd(...keys);
    performance.measure(`${label}#${phaseMarkSequence}`, startMark, endMark);
  }
}

function formatError(error: unknown): string {
  return error instanceof Error
    ? error.stack || error.message || String(error)
    : String(error);
}

/**
 * A test step is an object with an 'assertion', 'action', 'render', or 'settle'
 * property.
 * This discriminated union avoids TypeScript trying to unify incompatible Cell/Stream types.
 * Add `skip: true` to temporarily disable a step (like it.skip in other frameworks).
 *
 * Action steps may carry an `event` payload (sent instead of `undefined`) and
 * a `trustedUi` descriptor. With `trustedUi`, the runner sends the event with
 * renderer-trusted DOM provenance for that surface/action — the headless
 * equivalent of the user clicking the trusted surface — which CFC
 * `TrustedActionWrite` policies require under enforcement.
 *
 * A `{ settle: true }` step waits for FULL settlement (the scheduler, storage,
 * and every in-flight async builtin operation — a `db.query` RPC + writeback, a
 * fetch / llm call) via `runtime.settled()`. The light per-action settle returns
 * before that I/O lands, so insert `{ settle: true }` before an assertion that
 * reads an async-builtin result to keep the read deterministic under load.
 */
export type TestStep =
  | { assertion: Reactive<boolean>; skip?: boolean }
  | {
    action: Stream<unknown>;
    event?: unknown;
    trustedUi?: TrustedUiDescriptor;
    skip?: boolean;
  }
  | { render: unknown; skip?: boolean }
  | { settle: true; skip?: boolean };

type HarnessTestStepMeta = {
  action?: unknown;
  assertion?: unknown;
  event?: unknown;
  trustedUi?: unknown;
  render?: unknown;
  skip?: boolean;
  // `{ settle: true }` step: wait for full settlement (scheduler + storage +
  // in-flight async builtin I/O) via `runtime.settled()` before the next step.
  settle?: boolean;
};

type HarnessTestStepCell = Cell<unknown>;

interface DefaultPatternSeed {
  allPieces: unknown[];
  recentPieces: unknown[];
  backlinksIndex: { mentionable: unknown[] };
}

interface SpaceSeed {
  defaultPattern: Cell<DefaultPatternSeed>;
}

const testStepPeekSchema = internSchema(
  {
    type: "object",
    properties: {
      action: { type: "unknown" },
      assertion: { type: "unknown" },
      event: { type: "unknown" },
      trustedUi: {
        type: "object",
        properties: {
          surface: { type: "string" },
          action: { type: "string" },
        },
      },
      render: { type: "unknown" },
      skip: { type: "boolean" },
      settle: { type: "boolean" },
    },
  },
);

const testStepEntrySchema = internSchema(
  {
    type: "object",
    asCell: ["cell"],
  },
);

const testStepListSchema = internSchema(
  {
    type: "array",
    items: testStepEntrySchema,
    default: [],
  },
);

function actionStreamForStep(stepCell: HarnessTestStepCell): Stream<unknown> {
  const actionCell = stepCell.key("action") as unknown;
  if (
    typeof actionCell !== "object" || actionCell === null ||
    typeof (actionCell as { send?: unknown }).send !== "function"
  ) {
    throw new Error("Test step action is not a stream");
  }
  return actionCell as Stream<unknown>;
}

export interface TestResult {
  name: string;
  passed: boolean;
  skipped?: boolean;
  afterAction: string | null;
  error?: string;
  durationMs: number;
}

export interface NavigationEvent {
  /** Name ($NAME) of the navigation target, if available */
  name?: string;
  /** Index of the action that triggered this navigation */
  afterActionIndex: number;
}

export interface TestRunResult {
  path: string;
  results: TestResult[];
  totalDurationMs: number;
  error?: string;
  /** Navigation events recorded during the test run */
  navigations: NavigationEvent[];
  /** Runtime errors captured via errorHandlers during the test run */
  runtimeErrors: string[];
  /** If true, runtime errors are expected and should not fail the test */
  allowRuntimeErrors?: boolean;
  /** Non-idempotent computation names detected by the idempotency check */
  nonIdempotent: string[];
  /** If true, non-idempotent computations are expected: detected violations
   * don't fail the test, and detecting NONE fails it (the flag asserts the
   * detector fires; it is not a mere tolerance). */
  expectNonIdempotent?: boolean;
  /**
   * console.error() calls captured via the harness console event during the
   * run phase, plus logger-level error activity detected via count deltas.
   */
  consoleErrors: string[];
  /** If true, console errors are expected and should not fail the test. */
  allowConsoleErrors?: boolean;
  /**
   * console.warn() calls captured via the harness console event during the
   * run phase, plus logger-level warn activity detected via count deltas.
   */
  consoleWarnings: string[];
  /** If true, console warnings are expected and should not fail the test. */
  allowConsoleWarnings?: boolean;
}

export interface TestRunnerOptions {
  timeout?: number;
  verbose?: boolean;
  /** Root directory for resolving imports. If not provided, uses the test file's directory. */
  root?: string;
  /** Print logger stats for steps slower than this (ms). 0 = every step. Default 5000. Only applies when verbose is true. */
  statsThreshold?: number;
  /** Timing categories to always print in verbose stats output. Matched by exact name or prefix. */
  statsInclude?: string[];
  /** Number of per-step scheduler action deltas to print. Default 10. */
  statsActionLimit?: number;
  /** Override CFC enforcement mode for the test runtime. */
  cfcEnforcementMode?: CfcEnforcementMode;
  /** Shared compiled-module-byte cache for direct harness compiles. */
  moduleByteCache?: ModuleByteCache;
  /** Print storage-related logger timings and counts after each test file. */
  storageStats?: boolean;
  /** Limit for storage timing/count tables when storageStats is enabled. */
  storageStatsLimit?: number;
  /** Directory for pattern runtime coverage LCOV artifacts. */
  patternCoverageDir?: string;
  /** Keep the test descriptor's `$UI` demanded for the full test run. */
  continuousUI?: boolean;
}

// ---------------------------------------------------------------------------
// Verbose-mode logger stats helpers
// ---------------------------------------------------------------------------

type GlobalWithLoggers = {
  commonfabric?: {
    logger?: Record<
      string,
      {
        counts: {
          debug: number;
          info: number;
          warn: number;
          error: number;
          total: number;
        };
        getCountDeltas(): {
          debug: number;
          info: number;
          warn: number;
          error: number;
          total: number;
        };
        countsByKey?: Record<
          string,
          {
            debug: number;
            info: number;
            warn: number;
            error: number;
            total: number;
          }
        >;
      }
    >;
  };
};

function fmtMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms >= 10) return `${Math.round(ms)}ms`;
  if (ms >= 1) return `${ms.toFixed(1)}ms`;
  return `${ms.toFixed(2)}ms`;
}

function printSettleStats(stats: SettleStats | null): void {
  if (!stats || stats.iterations.length <= 1) return;
  console.log(
    `           Settle: ${stats.iterations.length} iterations, ${
      fmtMs(stats.totalDurationMs)
    }, ${stats.initialSeedCount} initial seeds, settled=${stats.settledEarly}`,
  );
  for (let i = 0; i < stats.iterations.length; i++) {
    const iter = stats.iterations[i];
    const effects = iter.actions.filter((a) => a.type === "effect").length;
    const comps = iter.actions.filter((a) => a.type === "computation").length;
    console.log(
      `             iter ${i}: workSet=${iter.workSetSize} order=${iter.orderSize} (${effects}E ${comps}C), ran=${iter.actionsRun}, ${
        fmtMs(iter.durationMs)
      }`,
    );
    // Show which actions are in the workSet (truncated)
    if (iter.actions.length > 0 && iter.workSetSize <= 40) {
      for (const a of iter.actions) {
        const tag = a.type === "effect" ? "E" : "C";
        // Shorten action ID for readability
        const shortId = a.id.length > 70 ? a.id.slice(0, 67) + "..." : a.id;
        console.log(`               [${tag}] ${shortId}`);
      }
    }
  }
}

function getGlobalLogCounts(): {
  debug: number;
  info: number;
  warn: number;
  error: number;
  total: number;
} {
  const g = globalThis as unknown as GlobalWithLoggers;
  const r = { debug: 0, info: 0, warn: 0, error: 0, total: 0 };
  if (g.commonfabric?.logger) {
    for (const logger of Object.values(g.commonfabric.logger)) {
      const c = logger.counts;
      r.debug += c.debug;
      r.info += c.info;
      r.warn += c.warn;
      r.error += c.error;
      r.total += c.total;
    }
  }
  return r;
}

function getGlobalLogCountDeltas(): {
  debug: number;
  info: number;
  warn: number;
  error: number;
  total: number;
} {
  const g = globalThis as unknown as GlobalWithLoggers;
  const r = { debug: 0, info: 0, warn: 0, error: 0, total: 0 };
  if (g.commonfabric?.logger) {
    for (const logger of Object.values(g.commonfabric.logger)) {
      const d = logger.getCountDeltas();
      r.debug += d.debug;
      r.info += d.info;
      r.warn += d.warn;
      r.error += d.error;
      r.total += d.total;
    }
  }
  return r;
}

function cdfPercentile(cdf: CDFPoint[], p: number): number {
  for (const point of cdf) {
    if (point.y >= p) return point.x;
  }
  return cdf[cdf.length - 1]?.x ?? 0;
}

function matchesTimingPrefix(name: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) =>
    name === prefix || name.startsWith(`${prefix}/`)
  );
}

function printLoggerStats(
  elapsedMs: number,
  useDelta: boolean,
  label?: string,
  statsInclude: string[] = [],
): void {
  const counts = useDelta ? getGlobalLogCountDeltas() : getGlobalLogCounts();
  const dp = useDelta ? "Δ" : "";
  const labelStr = label ? ` | ${label}:` : ":";
  console.log(
    `  ⏱ ${
      fmtMs(elapsedMs)
    }${labelStr} ${dp}${counts.total} calls (d:${counts.debug} i:${counts.info} w:${counts.warn} e:${counts.error})`,
  );

  const breakdown = getTimingStatsBreakdown();
  const entries: {
    name: string;
    n: number;
    total: number;
    avg: number;
    p50: number;
    p95: number;
    max: number;
  }[] = [];

  for (const [loggerName, timings] of Object.entries(breakdown)) {
    for (const [key, timing] of Object.entries(timings)) {
      if (useDelta) {
        if (timing.countSinceBaseline === 0) {
          continue;
        }
        const cdf = timing.cdfSinceBaseline ?? [];
        entries.push({
          name: `${loggerName}/${key}`,
          n: timing.countSinceBaseline,
          total: timing.totalTimeSinceBaseline,
          avg: timing.averageSinceBaseline,
          p50: cdf.length > 0 ? cdfPercentile(cdf, 0.5) : 0,
          p95: cdf.length > 0 ? cdfPercentile(cdf, 0.95) : 0,
          max: cdf.length > 0 ? cdf[cdf.length - 1].x : 0,
        });
      } else {
        if (timing.count === 0) continue;
        entries.push({
          name: `${loggerName}/${key}`,
          n: timing.count,
          total: timing.totalTime,
          avg: timing.average,
          p50: timing.p50,
          p95: timing.p95,
          max: timing.max,
        });
      }
    }
  }

  if (entries.length > 0) {
    entries.sort((a, b) => b.total - a.total);
    const topEntries = entries.slice(0, 10);
    const topNames = new Set(topEntries.map((entry) => entry.name));
    const includedEntries = statsInclude.length > 0
      ? entries.filter((entry) =>
        !topNames.has(entry.name) &&
        matchesTimingPrefix(entry.name, statsInclude)
      )
      : [];

    console.log(`           Timings (top 10 by total time):`);
    for (const entry of topEntries) {
      const name = entry.name.padEnd(35);
      const np = useDelta ? "Δn" : " n";
      console.log(
        `             ${name} ${np}=${String(entry.n).padStart(5)} total=${
          fmtMs(entry.total).padStart(7)
        } avg=${fmtMs(entry.avg).padStart(7)} p95=${
          fmtMs(entry.p95).padStart(7)
        }`,
      );
    }

    if (includedEntries.length > 0) {
      console.log(`           Included Timings:`);
      for (const entry of includedEntries) {
        const name = entry.name.padEnd(35);
        const np = useDelta ? "Δn" : " n";
        console.log(
          `             ${name} ${np}=${String(entry.n).padStart(5)} total=${
            fmtMs(entry.total).padStart(7)
          } avg=${fmtMs(entry.avg).padStart(7)} p95=${
            fmtMs(entry.p95).padStart(7)
          }`,
        );
      }
    }
  }

  // Count breakdown: per-logger/per-key for absolute, per-logger for delta
  type CountEntry = {
    name: string;
    d: number;
    i: number;
    w: number;
    e: number;
    total: number;
  };
  const countEntries: CountEntry[] = [];
  if (useDelta) {
    const g = globalThis as unknown as GlobalWithLoggers;
    if (g.commonfabric?.logger) {
      for (const [name, logger] of Object.entries(g.commonfabric.logger)) {
        const c = logger.getCountDeltas();
        if (c.total > 0) {
          countEntries.push({
            name,
            d: c.debug,
            i: c.info,
            w: c.warn,
            e: c.error,
            total: c.total,
          });
        }
      }
    }
  } else {
    const countBreakdown = getLoggerCountsBreakdown();
    for (const [loggerName, loggerData] of Object.entries(countBreakdown)) {
      if (loggerName === "total") continue;
      for (
        const [key, keyCounts] of Object.entries(
          loggerData as Record<
            string,
            {
              debug: number;
              info: number;
              warn: number;
              error: number;
              total: number;
            }
          >,
        )
      ) {
        if (key === "total") continue;
        if (keyCounts.total > 0) {
          countEntries.push({
            name: `${loggerName}/${key}`,
            d: keyCounts.debug,
            i: keyCounts.info,
            w: keyCounts.warn,
            e: keyCounts.error,
            total: keyCounts.total,
          });
        }
      }
    }
  }

  if (countEntries.length > 0) {
    countEntries.sort((a, b) => b.total - a.total);
    const np = useDelta ? "Δ" : "";
    console.log(`           Counts (top 10 by calls):`);
    for (const entry of countEntries.slice(0, 10)) {
      const name = entry.name.padEnd(35);
      const parts: string[] = [];
      if (entry.d > 0) parts.push(`d:${entry.d}`);
      if (entry.i > 0) parts.push(`i:${entry.i}`);
      if (entry.w > 0) parts.push(`w:${entry.w}`);
      if (entry.e > 0) parts.push(`e:${entry.e}`);
      const levels = parts.length > 0 ? ` (${parts.join(" ")})` : "";
      console.log(
        `             ${name} ${np}n=${
          String(entry.total).padStart(7)
        }${levels}`,
      );
    }
  }
}

function isStorageLoggerName(name: string): boolean {
  return name === "traverse" ||
    name === "memory-provider" ||
    name === "memory-v2-query" ||
    name === "memory-v2-server" ||
    name.startsWith("storage") ||
    name === "extended-storage-transaction";
}

function printStorageStats(elapsedMs: number, limit = 16): void {
  type StorageCountEntry = {
    name: string;
    d: number;
    i: number;
    w: number;
    e: number;
    total: number;
  };

  type StorageCountKeyEntry = {
    logger: string;
    key: string;
    d: number;
    i: number;
    w: number;
    e: number;
    total: number;
  };

  console.log(`  🗄 ${fmtMs(elapsedMs)} | Storage totals:`);

  const timingBreakdown = getTimingStatsBreakdown();
  const timingEntries: {
    name: string;
    n: number;
    p50: number;
    p95: number;
    max: number;
  }[] = [];

  for (const [loggerName, timings] of Object.entries(timingBreakdown)) {
    if (!isStorageLoggerName(loggerName)) continue;
    for (const [key, timing] of Object.entries(timings)) {
      if (timing.count === 0) continue;
      timingEntries.push({
        name: `${loggerName}/${key}`,
        n: timing.count,
        p50: timing.p50,
        p95: timing.p95,
        max: timing.max,
      });
    }
  }

  if (timingEntries.length > 0) {
    timingEntries.sort((a, b) => b.p95 - a.p95);
    console.log(
      `           Timings (top ${
        Math.min(limit, timingEntries.length)
      } by p95):`,
    );
    for (const entry of timingEntries.slice(0, limit)) {
      const name = entry.name.padEnd(35);
      console.log(
        `             ${name}  n=${String(entry.n).padStart(5)} p50=${
          fmtMs(entry.p50).padStart(7)
        } p95=${fmtMs(entry.p95).padStart(7)} max=${
          fmtMs(entry.max).padStart(7)
        }`,
      );
    }
  }

  const g = globalThis as unknown as GlobalWithLoggers;
  const countEntries: StorageCountEntry[] = [];
  if (g.commonfabric?.logger) {
    for (const [name, logger] of Object.entries(g.commonfabric.logger)) {
      if (!isStorageLoggerName(name)) continue;
      const c = logger.counts;
      if (c.total > 0) {
        countEntries.push({
          name,
          d: c.debug,
          i: c.info,
          w: c.warn,
          e: c.error,
          total: c.total,
        });
      }
    }
  }

  if (countEntries.length > 0) {
    countEntries.sort((a, b) => b.total - a.total);
    console.log(`           Counts (all storage loggers):`);
    for (const entry of countEntries) {
      const parts: string[] = [];
      if (entry.d > 0) parts.push(`d:${entry.d}`);
      if (entry.i > 0) parts.push(`i:${entry.i}`);
      if (entry.w > 0) parts.push(`w:${entry.w}`);
      if (entry.e > 0) parts.push(`e:${entry.e}`);
      const levels = parts.length > 0 ? ` (${parts.join(" ")})` : "";
      console.log(
        `             ${entry.name.padEnd(35)} n=${
          String(entry.total).padStart(7)
        }${levels}`,
      );
    }
  }

  const keyEntries: StorageCountKeyEntry[] = [];
  if (g.commonfabric?.logger) {
    for (const [loggerName, logger] of Object.entries(g.commonfabric.logger)) {
      if (!isStorageLoggerName(loggerName) || !logger.countsByKey) continue;
      for (const [key, counts] of Object.entries(logger.countsByKey)) {
        if (counts.total === 0) continue;
        keyEntries.push({
          logger: loggerName,
          key,
          d: counts.debug,
          i: counts.info,
          w: counts.warn,
          e: counts.error,
          total: counts.total,
        });
      }
    }
  }

  if (keyEntries.length > 0) {
    keyEntries.sort((a, b) => b.total - a.total);
    console.log(
      `           Count keys (top ${Math.min(limit, keyEntries.length)}):`,
    );
    for (const entry of keyEntries.slice(0, limit)) {
      const parts: string[] = [];
      if (entry.d > 0) parts.push(`d:${entry.d}`);
      if (entry.i > 0) parts.push(`i:${entry.i}`);
      if (entry.w > 0) parts.push(`w:${entry.w}`);
      if (entry.e > 0) parts.push(`e:${entry.e}`);
      const levels = parts.length > 0 ? ` (${parts.join(" ")})` : "";
      console.log(
        `             ${`${entry.logger}/${entry.key}`.padEnd(55)} n=${
          String(entry.total).padStart(7)
        }${levels}`,
      );
    }
  }
}

/**
 * Print a table of scheduler action stats, sorted by total time descending.
 * Mirrors the table view in the shell's SchedulerGraphView debug UI.
 *
 * Stats are keyed by action ID (source location), so multiple action instances
 * from the same source share the same stats. We deduplicate by ID and count
 * how many live nodes share each ID.
 */
function printActionStatsTable(runtime: Runtime): void {
  const snapshot = runtime.scheduler.getGraphSnapshot();
  const nodes = snapshot.nodes.filter((n) => n.stats && n.stats.runCount > 0);
  if (nodes.length === 0) return;

  // Deduplicate by id since stats are shared across instances with same source.
  // Count how many live nodes share each id.
  const seen = new Map<
    string,
    {
      stats: NonNullable<(typeof nodes)[0]["stats"]>;
      type: string;
      instances: number;
      childIds: Set<string>;
      preview?: string;
    }
  >();

  for (const node of nodes) {
    if (!node.stats) continue;
    const existing = seen.get(node.id);
    if (existing) {
      existing.instances++;
    } else {
      seen.set(node.id, {
        stats: node.stats,
        type: node.type,
        instances: 1,
        childIds: new Set(),
        preview: node.preview,
      });
    }
  }

  // Track parent-child: aggregate children into parents
  for (const node of nodes) {
    if (node.parentId && seen.has(node.parentId) && seen.has(node.id)) {
      seen.get(node.parentId)!.childIds.add(node.id);
    }
  }

  // Build rows: only top-level (not a child of another visible node)
  const allChildIds = new Set<string>();
  for (const entry of seen.values()) {
    for (const cid of entry.childIds) allChildIds.add(cid);
  }

  const rows: {
    id: string;
    type: string;
    instances: number;
    runs: number;
    totalMs: number;
    avgMs: number;
    lastMs: number;
    childCount: number;
    preview?: string;
  }[] = [];

  for (const [id, entry] of seen) {
    if (allChildIds.has(id)) continue;
    let totalMs = entry.stats.totalTime;
    let runs = entry.stats.runCount;
    for (const cid of entry.childIds) {
      const child = seen.get(cid);
      if (child) {
        totalMs += child.stats.totalTime;
        runs += child.stats.runCount;
      }
    }
    rows.push({
      id,
      type: entry.type,
      instances: entry.instances,
      runs,
      totalMs,
      avgMs: runs > 0 ? totalMs / runs : 0,
      lastMs: entry.stats.lastRunTime,
      childCount: entry.childIds.size,
      preview: entry.preview,
    });
  }

  rows.sort((a, b) => b.totalMs - a.totalMs);

  // Print table
  console.log(`\n  ⚡ Action Stats (top 20 by total time):`);
  console.log(
    `    ${"Action".padEnd(55)} ${"Runs".padStart(5)} ${"Total".padStart(9)} ${
      "Avg".padStart(9)
    } ${"Last".padStart(9)}`,
  );
  console.log(`    ${"─".repeat(90)}`);

  for (const row of rows.slice(0, 20)) {
    const suffix = [
      row.instances > 1 ? `${row.instances}x` : "",
      row.childCount > 0 ? `+${row.childCount}ch` : "",
    ].filter(Boolean).join(" ");
    // Use first line of preview if available, otherwise the action id
    const base = row.preview
      ? row.preview.split("\n")[0].trim().slice(0, 40)
      : row.id;
    const label = suffix ? `${base} (${suffix})` : base;
    const truncated = label.length > 54
      ? "…" + label.slice(label.length - 53)
      : label;
    console.log(
      `    ${truncated.padEnd(55)} ${String(row.runs).padStart(5)} ${
        fmtMs(row.totalMs).padStart(9)
      } ${fmtMs(row.avgMs).padStart(9)} ${fmtMs(row.lastMs).padStart(9)}`,
    );
  }

  const totalRuns = rows.reduce((s, r) => s + r.runs, 0);
  const totalTimeMs = rows.reduce((s, r) => s + r.totalMs, 0);
  console.log(`    ${"─".repeat(90)}`);
  console.log(
    `    ${"TOTAL".padEnd(55)} ${String(totalRuns).padStart(5)} ${
      fmtMs(totalTimeMs).padStart(9)
    }`,
  );
}

/**
 * Run a single test pattern file.
 */
export async function runTestPattern(
  testPath: string,
  options: TestRunnerOptions = {},
): Promise<TestRunResult> {
  const TIMEOUT = options.timeout ?? 60000;
  const startTime = performance.now();
  performance.clearMarks();
  performance.clearMeasures();
  resetAllLoggerCounts();
  resetAllTimingStats();

  // Collect runtime errors via the scheduler's error handler
  const runtimeErrors: ErrorWithContext[] = [];
  const patternCoverage = options.patternCoverageDir
    ? new PatternCoverageCollector()
    : undefined;
  let writeLocalPatternCoverage = patternCoverage !== undefined;
  let continuousUiCancel: (() => void) | undefined;
  const continuousUiErrors: Error[] = [];

  // Collect pattern-code console.error / console.warn calls (channel 1: harness
  // console event) and logger-level error/warn activity (channel 2: logger count
  // deltas).  Both are populated during the run phase only (after compile).
  const consoleErrors: string[] = [];
  const consoleWarnings: string[] = [];
  // Both channels cover the RUN phase only: the channel-1 handler is
  // registered at runtime setup (the scheduler accepts one handler), but it
  // stays inert until this flips at the same post-compile point where the
  // channel-2 snapshot is taken — compile/module-evaluation output is
  // infrastructure noise, not the test's behavior.
  let consoleCaptureActive = false;

  // 1. Create emulated runtime (same as piece step)
  const identity = await withPhase(
    ["runTestPattern", "identity"],
    () => Identity.fromPassphrase("test-runner"),
  );
  const space = identity.did();
  const { StorageManager } = await withPhase([
    "runTestPattern",
    "storageImport",
  ], () => import("@commonfabric/runner/storage/cache.deno"));
  const storageManager = await withPhase(
    ["runTestPattern", "storageManager"],
    () =>
      StorageManager.emulate({
        as: identity,
      }),
  );

  // Track navigation events for assertions and verbose output
  const navigations: NavigationEvent[] = [];
  let currentActionIndex = -1;

  // Fetch mocking: a test opts in by exporting a module-scope `fetchMocks` array.
  // We can't read it until after compile, so the injected fetch closes over a
  // late-populated `fetchMockEntries` and falls through to the real fetch until
  // (and unless) the test declares mocks. Driving the in-flight fetchJson to
  // completion is the harness's existing job — a `{ settle: true }` step (or any
  // action's settle) calls `runtime.settled()`, which awaits the fetch chain.
  const realFetch = globalThis.fetch.bind(globalThis);
  let fetchMockEntries: FetchMockEntry[] | undefined;
  const mockFetch = makeMockFetch(() => fetchMockEntries, realFetch);

  const runtime = await withPhase(
    ["runTestPattern", "runtime"],
    () =>
      // `runtimePresets.patternTest` carries the shared first-party posture
      // (CT-1814): the enforce-explicit CFC pin lives in the preset core, so
      // pattern tests act as a regression net for CFC without this site
      // restating the production default. Params below are this harness's
      // declared deltas.
      new Runtime(runtimePresets.patternTest({
        apiUrl: new URL(import.meta.url),
        storageManager,
        experimental: experimentalOptionsFromEnv(Deno.env.get),
        moduleByteCache: options.moduleByteCache ??
          getDefaultModuleByteCache(),
        // Inject a fetch that honors test-declared `fetchMocks` (scoped to this
        // runtime; no process-global mutation).
        fetch: mockFetch,
        // Tests that need a laxer mode than the shared pin opt out per test.
        ...(options.cfcEnforcementMode !== undefined
          ? { cfcEnforcementMode: options.cfcEnforcementMode }
          : {}),
        errorHandlers: [(error: ErrorWithContext) => runtimeErrors.push(error)],
        navigateCallback: (target) => {
          const name = (target.key("$NAME") as Cell<string | undefined>).get();
          navigations.push({
            name,
            afterActionIndex: currentActionIndex,
          });
          if (options.verbose) {
            const label = typeof name === "string" ? name : "(unnamed)";
            console.log(`    → navigateTo: ${label}`);
          }
        },
      })),
  );
  runtime.enableIdempotencyCheck();
  // Channel 1: capture pattern-code console.error / console.warn calls that
  // flow through the scheduler's harness console event.  The handler must
  // return args unchanged so the call still appears in the host console.
  runtime.scheduler.onConsole(
    (({ method, args }) => {
      if (!consoleCaptureActive) {
        return args;
      }
      if (method === ConsoleMethod.Error) {
        const text = args.map((a) => String(a)).join(" ");
        consoleErrors.push(`[console.error] ${text}`);
      } else if (method === ConsoleMethod.Warn) {
        const text = args.map((a) => String(a)).join(" ");
        consoleWarnings.push(`[console.warn] ${text}`);
      }
      return args;
    }) satisfies ConsoleHandler,
  );
  if (options.verbose) {
    runtime.scheduler.enableSettleStats();
  }
  // Compile/evaluate through the runtime's OWN harness, not a second Engine.
  // Verified-load registration, source maps, and module hashes all live on the
  // engine that evaluates the bundle; the runner and the builder's source-
  // location annotation consult `runtime.harness`. A separate Engine splits
  // that state, so `fn.src` stays a raw bundle coordinate and CFC verified-
  // binding identities (writeAuthorizedBy) fail under enforcement.
  const engine = await withPhase(
    ["runTestPattern", "engine"],
    () => runtime.harness,
  );

  try {
    // 2. Compile the test pattern
    const program = await withPhase(
      ["runTestPattern", "resolve"],
      () =>
        engine.resolve(
          new FileSystemProgramResolver(testPath, options.root),
        ),
    );
    const evalResult = await withPhase(
      ["runTestPattern", "compile"],
      // `compileAndRegisterModules` seals compile + evaluate + register, so the
      // evaluated artifacts are indexed exactly as the deployed runtime's load
      // path does (`patternFromEvaluation`). Without registration, anonymous
      // map/filter/flatMap ops fall back to a defer-corrupted embedded graph and a
      // grandchild derived-internal output throws at bind time (CT-1811).
      () =>
        runtime.patternManager.compileAndRegisterModules(program, {
          patternCoverage,
        }),
    );
    const { main } = evalResult;

    if (!main?.default) {
      throw new Error(
        `Test pattern must export a pattern function as default`,
      );
    }

    // Read the test's opt-in fetch mocks now (after compile, before the run):
    // a fetchJson with a non-empty URL fires during the initial settle, so the
    // entries must be in place before `runtime.run(...)` below. `main` is the
    // module namespace, so a named `fetchMocks` export is reachable.
    fetchMockEntries = readFetchMocks(main);

    // Multi-user tests export a descriptor ({ setup?, participants }) as the
    // default export. They run in worker-isolated runtimes against a shared
    // storage server — hand off to the multi-user orchestrator (this local
    // runtime is only used for detection; the try/finally below disposes it).
    const multiUserMeta = multiUserDescriptorMeta(main.default);
    if (multiUserMeta) {
      writeLocalPatternCoverage = false;
      return await withPhase(
        ["runTestPattern", "multiUser"],
        () => runMultiUserTestPattern(testPath, multiUserMeta, options),
      );
    }

    const testPatternFactory = main.default as Pattern;

    if (typeof testPatternFactory !== "function") {
      throw new Error(
        `Test pattern must export a pattern function as default, got ${typeof testPatternFactory}`,
      );
    }

    // 3. Set up defaultPattern so wish({ query: "#default" }) resolves.
    // In production, default-app.tsx provides this. The test harness must
    // create a minimal equivalent so patterns that use wish("#default") to
    // access allPieces, recentPieces, etc. work correctly.
    await withPhase(["runTestPattern", "defaultPatternSetup"], async () => {
      const setupTx = runtime.edit();
      const spaceCell = runtime.getCell<SpaceSeed>(
        space,
        space,
        undefined,
        setupTx,
      );
      const defaultPatternCell = runtime.getCell<DefaultPatternSeed>(
        space,
        "default-pattern",
        undefined,
        setupTx,
      );
      defaultPatternCell.key("allPieces").set([]);
      defaultPatternCell.key("recentPieces").set([]);
      defaultPatternCell.key("backlinksIndex").set({
        mentionable: [],
      });
      spaceCell.key("defaultPattern").set(defaultPatternCell);
      runtime.prepareTxForCommit?.(setupTx);
      await setupTx.commit();
      await runtime.idle();
    });

    // Channel 2: snapshot logger error/warn counts AFTER compile but BEFORE the
    // run/assert phase.  This excludes compile-cache and infrastructure noise
    // (e.g. cache-miss warnings emitted during engine.compileAndEvaluateModules)
    // while capturing everything the pattern's own handlers log at error/warn
    // level through the runtime logger.
    const loggerCountsBeforeRun = snapshotLoggerErrorWarnCounts();
    consoleCaptureActive = true;

    // 4. Instantiate the test pattern using runtime.run() for proper space context
    const patternResult = await withPhase(
      ["runTestPattern", "patternRun"],
      async () => {
        const tx = runtime.edit();

        // Create a result cell for the pattern
        const resultCell = runtime.getCell<Record<string, unknown>>(
          space,
          `test-pattern-result-${Date.now()}`,
          undefined,
          tx,
        );

        // Run the pattern with proper space context
        const value = runtime.run(tx, testPatternFactory, {}, resultCell);

        // Commit the transaction
        runtime.prepareTxForCommit?.(tx);
        await tx.commit();
        return value;
      },
    );

    if (options.continuousUI) {
      continuousUiCancel = await withPhase(
        ["runTestPattern", "continuousUI", "mount"],
        () =>
          mountTestVDOM(
            patternResult.key("$UI") as Cell<unknown>,
            (error) => continuousUiErrors.push(error),
          ),
      );
      if (options.verbose) {
        console.log("  Continuous $UI demand enabled");
      }
    }

    await withPhase(["runTestPattern", "initialSettle"], async () => {
      // Wait for initial setup to complete
      await runtime.idle();
      // Also wait for all in-flight storage subscriptions to settle.
      // replica.poll() fires without await during mount(), so subscription
      // updates can arrive after idle() resolves, scheduling more work.
      await storageManager.synced();
      await runtime.idle();
    });

    // 4. Get the tests array from pattern output
    const testsCell = await withPhase(
      ["runTestPattern", "testsCell"],
      () => patternResult.key("tests") as Cell<unknown>,
    );
    const testSteps = await withPhase(
      ["runTestPattern", "testsValue"],
      () => testsCell.asSchema(testStepListSchema).get(),
    );

    // Validate it's an array
    if (!Array.isArray(testSteps)) {
      throw new Error(
        "Test pattern must return { tests: TestStep[] }. Got: " +
          toCompactDebugString(typeof testSteps),
      );
    }

    // Check for allowRuntimeErrors, expectNonIdempotent, and console opt-out flags
    const allowRuntimeErrors = await withPhase(
      ["runTestPattern", "allowRuntimeErrors"],
      async () =>
        await (patternResult.key("allowRuntimeErrors") as Cell<unknown>)
          .pull() === true,
    );
    const expectNonIdempotent = await withPhase(
      ["runTestPattern", "expectNonIdempotent"],
      async () =>
        await (patternResult.key("expectNonIdempotent") as Cell<unknown>)
          .pull() === true,
    );
    const allowConsoleErrors = await withPhase(
      ["runTestPattern", "allowConsoleErrors"],
      async () =>
        await (patternResult.key("allowConsoleErrors") as Cell<unknown>)
          .pull() === true,
    );
    const allowConsoleWarnings = await withPhase(
      ["runTestPattern", "allowConsoleWarnings"],
      async () =>
        await (patternResult.key("allowConsoleWarnings") as Cell<unknown>)
          .pull() === true,
    );

    if (options.verbose) {
      console.log(`  Found ${testSteps.length} test steps`);
      printLoggerStats(
        performance.now() - startTime,
        false,
        "Setup",
        options.statsInclude,
      );
      printSettleStats(runtime.scheduler.getSettleStats());
      resetAllCountBaselines();
      resetAllTimingBaselines();
    }

    const settleRuntime = async (
      stepIndex: number,
      stepLabel: string,
      maxSettle = 20,
    ): Promise<void> => {
      await withPhase(
        ["runTestPattern", "step", stepLabel, "settle"],
        () =>
          Promise.race([
            (async () => {
              for (let settle = 0; settle < maxSettle; settle++) {
                const iterStart = performance.now();
                await withPhase(
                  [
                    "runTestPattern",
                    "step",
                    stepLabel,
                    "settle",
                    `iter-${settle}`,
                    "idle",
                  ],
                  () => runtime.idle(),
                );
                await withPhase(
                  [
                    "runTestPattern",
                    "step",
                    stepLabel,
                    "settle",
                    `iter-${settle}`,
                    "synced",
                  ],
                  () => storageManager.synced(),
                );
                const totalMs = performance.now() - iterStart;
                if (options.verbose && totalMs > 1) {
                  console.log(
                    `      settle[${settle}]: ${fmtMs(totalMs)}`,
                  );
                }
                // If both resolved nearly instantly, the system is settled.
                // synced() has ~1ms of overhead even when idle, so use 2ms.
                if (settle > 0 && totalMs < 2) break;
              }
              await withPhase(
                ["runTestPattern", "step", stepLabel, "settle", "finalIdle"],
                () => runtime.idle(),
              );
            })(),
            timeout(
              TIMEOUT,
              `Action at index ${stepIndex} timed out after ${TIMEOUT}ms`,
            ),
          ]),
      );
    };

    // Explicit `{ settle: true }` test step: in addition to the light per-action
    // settle above, wait for ALL in-flight async builtin work — the sqlite query
    // RPC + result writeback, fetch / llm calls — via `runtime.settled()`. A test
    // that asserts on an async-builtin result (e.g. a `db.query`) inserts this
    // before the assertion so it never reads a half-settled `{ pending: true }`.
    const settleFully = async (stepIndex: number): Promise<void> => {
      await withPhase(
        ["runTestPattern", "step", `settle_${stepIndex}`, "settled"],
        () =>
          Promise.race([
            runtime.settled(),
            timeout(
              TIMEOUT,
              `Settle step at index ${stepIndex} timed out after ${TIMEOUT}ms`,
            ),
          ]),
      );
    };

    // 5. Process tests sequentially
    const results: TestResult[] = [];
    let lastActionIndex: number | null = null;
    let assertionCount = 0;
    let actionCount = 0;
    let renderCount = 0;

    for (let i = 0; i < testSteps.length; i++) {
      if (options.verbose) {
        resetAllCountBaselines();
        resetAllTimingBaselines();
      }
      const itemStart = performance.now();
      const stepCell = testSteps[i] as HarnessTestStepCell;
      const stepValue = stepCell.asSchema(testStepPeekSchema)
        .get() as HarnessTestStepMeta;

      // Check which discriminant this step carries.
      const isAction = Object.hasOwn(stepValue, "action");
      const isAssertion = Object.hasOwn(stepValue, "assertion");
      const isRender = Object.hasOwn(stepValue, "render");
      const isSettle = Object.hasOwn(stepValue, "settle");

      // `{ settle: true }` step: wait for FULL settlement (scheduler + storage +
      // in-flight async builtin I/O — sqlite query RPC + writeback, fetch / llm)
      // before the next step. A test inserts this before an assertion that reads
      // an async-builtin result so it never observes a half-settled state. The
      // step is transparent — it produces no result. A settle timeout propagates
      // to the outer handler and fails the whole run (a stuck settle is fatal).
      if (isSettle) {
        if (!stepValue.skip) await settleFully(i);
        continue;
      }

      // `{ render: subject[UI] }` is a headless, per-step demand window. Run
      // the VDOM through the worker reconciler, discard its DOM
      // operations, wait for all recursively discovered UI cells, then remove
      // the demand before advancing to the next step.
      if (isRender) {
        renderCount++;
        const renderName = `render_${renderCount}`;
        if (!stepValue.skip) {
          await materializeTestVDOM(
            stepCell.key("render") as Cell<unknown>,
            () => settleRuntime(i, renderName, 20),
          );
          if (options.verbose) console.log(`  ◇ ${renderName}`);
        } else if (options.verbose) {
          console.log(`  ⊘ ${renderName} (skipped)`);
        }
        continue;
      }

      if (!isAction && !isAssertion) {
        throw new Error(
          `Test step at index ${i} must have an 'action', 'assertion', ` +
            `'render', or 'settle' key. Got: ${
              toCompactDebugString(Object.keys(stepValue))
            }`,
        );
      }

      // Handle skipped steps
      if (stepValue.skip) {
        if (isAction) {
          actionCount++;
          const actionName = `action_${actionCount}`;
          if (options.verbose) {
            console.log(`  ⊘ ${actionName} (skipped)`);
          }
        } else {
          assertionCount++;
          const assertionName = `assertion_${assertionCount}`;
          const suffix = lastActionIndex !== null
            ? ` (after action_${actionCount})`
            : "";
          results.push({
            name: assertionName,
            passed: true,
            skipped: true,
            afterAction: lastActionIndex !== null
              ? `action_${actionCount}`
              : null,
            durationMs: 0,
          });
          if (options.verbose) {
            console.log(`  ⊘ ${assertionName}${suffix} (skipped)`);
          }
        }
        continue;
      }

      if (isAction) {
        // It's an action - invoke it
        actionCount++;
        lastActionIndex = i;
        currentActionIndex = i;
        const actionName = `action_${actionCount}`;

        if (options.verbose) {
          console.log(`  → Running ${actionName}...`);
        }

        // Snapshot action stats before running (for delta tracking)
        const statsThreshold = options.statsThreshold ?? 5000;
        let preRunCounts: Map<string, number> | undefined;
        if (options.verbose) {
          preRunCounts = new Map();
          for (const node of runtime.scheduler.getGraphSnapshot().nodes) {
            if (node.stats) {
              preRunCounts.set(node.id, node.stats.runCount);
            }
          }
        }

        // Get the action stream via .key()
        const actionStream = await withPhase(
          ["runTestPattern", "step", actionName, "stream"],
          () => actionStreamForStep(stepCell),
        );

        // Send the step's event (undefined for plain void actions), wrapped
        // with renderer-trusted provenance when the step declares `trustedUi`.
        await withPhase(["runTestPattern", "step", actionName, "send"], () => {
          actionStream.send(
            buildActionEvent(stepValue.event, stepValue.trustedUi),
          );
        });

        // Wait for idle, then settle commits and re-idle.
        // Optimistic commits can fail (CAS conflicts), causing rollbacks
        // and reactive re-scheduling. We loop idle→synced until both
        // resolve quickly (< 1ms), indicating quiescence. Max iterations
        // as a safety net against infinite loops.
        try {
          await settleRuntime(i, actionName, 20);
        } catch (err) {
          results.push({
            name: actionName,
            passed: false,
            afterAction: null,
            error: err instanceof Error ? err.message : String(err),
            durationMs: performance.now() - itemStart,
          });
        }

        // Print per-action run deltas for slow actions
        if (
          options.verbose && preRunCounts &&
          (performance.now() - itemStart > statsThreshold ||
            statsThreshold === 0)
        ) {
          const postSnapshot = runtime.scheduler.getGraphSnapshot();
          const deltas: { id: string; preview?: string; delta: number }[] = [];
          const seen = new Set<string>();
          for (const node of postSnapshot.nodes) {
            if (!node.stats || seen.has(node.id)) continue;
            seen.add(node.id);
            const pre = preRunCounts.get(node.id) ?? 0;
            const delta = node.stats.runCount - pre;
            if (delta > 0) {
              deltas.push({
                id: node.id,
                preview: node.preview,
                delta,
              });
            }
          }
          if (deltas.length > 0) {
            deltas.sort((a, b) => b.delta - a.delta);
            const totalDelta = deltas.reduce((s, d) => s + d.delta, 0);
            const actionLimit = options.statsActionLimit ?? 10;
            console.log(
              `    ⟳ ${totalDelta} scheduler runs across ${deltas.length} actions:`,
            );
            // Build reads/writes lookup from post-snapshot
            const nodeInfo = new Map<
              string,
              { reads?: string[]; writes?: string[] }
            >();
            for (const node of postSnapshot.nodes) {
              if (!nodeInfo.has(node.id)) {
                nodeInfo.set(node.id, {
                  reads: node.reads,
                  writes: node.writes,
                });
              }
            }
            // Helper to shorten cell paths: did:key:z6Mk.../of:fid1:abc.../value/foo → …abc.../value/foo
            const shortenPath = (r: string): string => {
              // Format: did:key:.../of:fid1:abc.../path/parts
              const ofIdx = r.indexOf("/of:");
              if (ofIdx < 0) return r.length > 40 ? "…" + r.slice(-39) : r;
              const afterOf = r.slice(ofIdx + 4);
              const slashIdx = afterOf.indexOf("/");
              if (slashIdx < 0) return "…" + afterOf.slice(-20);
              const entityId = afterOf.slice(0, slashIdx);
              const path = afterOf.slice(slashIdx);
              const shortEntity = entityId.length > 10
                ? entityId.slice(0, 8) + "…"
                : entityId;
              return shortEntity + path;
            };
            // Collect all entity IDs read by re-triggered actions
            const entityReadCounts = new Map<string, number>();
            for (const d of deltas) {
              const info = nodeInfo.get(d.id);
              if (info?.reads) {
                for (const r of info.reads) {
                  // Extract entity: everything between /of: and the next /
                  const ofIdx = r.indexOf("/of:");
                  if (ofIdx < 0) continue;
                  const afterOf = r.slice(ofIdx + 4);
                  const slashIdx = afterOf.indexOf("/");
                  const entity = slashIdx < 0
                    ? afterOf
                    : afterOf.slice(0, slashIdx);
                  const path = slashIdx < 0 ? "" : afterOf.slice(slashIdx);
                  const key = entity.slice(0, 8) + "…" + path;
                  entityReadCounts.set(
                    key,
                    (entityReadCounts.get(key) ?? 0) + d.delta,
                  );
                }
              }
            }

            for (const d of deltas.slice(0, actionLimit)) {
              const label = d.preview
                ? d.preview.split("\n")[0].trim().slice(0, 50)
                : d.id;
              const info = nodeInfo.get(d.id);
              const reads = info?.reads;
              const writes = info?.writes;
              // Show non-schema reads (skip the first entry which is typically the schema query)
              const nonSchemaReads = reads?.filter((r) =>
                !r.includes("%22query%22")
              ) ?? [];
              const rStr = nonSchemaReads.length > 0
                ? ` r:[${
                  nonSchemaReads.slice(0, 3).map(shortenPath).join(", ")
                }${
                  nonSchemaReads.length > 3
                    ? ` +${nonSchemaReads.length - 3}`
                    : ""
                }]`
                : reads && reads.length > 0
                ? ` r:[schema-query +${reads.length - 1}]`
                : "";
              const wStr = writes && writes.length > 0
                ? ` w:[${writes.slice(0, 2).map(shortenPath).join(", ")}${
                  writes.length > 2 ? ` +${writes.length - 2}` : ""
                }]`
                : "";
              console.log(
                `      ${String(d.delta).padStart(4)}× ${label}${rStr}${wStr}`,
              );
            }

            // Show top read entities across all re-triggered actions
            const topReads = [...entityReadCounts.entries()]
              .filter(([k]) => !k.includes("%22query%22"))
              .sort((a, b) => b[1] - a[1]);
            if (topReads.length > 0) {
              console.log(`    📖 Most-read entities:`);
              for (const [entity, count] of topReads.slice(0, 5)) {
                console.log(`      ${String(count).padStart(4)}× ${entity}`);
              }
            }
            if (deltas.length > actionLimit) {
              const rest = deltas.slice(actionLimit).reduce(
                (s, d) => s + d.delta,
                0,
              );
              console.log(
                `      ${String(rest).padStart(4)}× (${
                  deltas.length - actionLimit
                } more actions)`,
              );
            }
          }
        }
      } else {
        // It's an assertion - check the boolean value
        assertionCount++;
        const assertionName = `assertion_${assertionCount}`;

        let passed = false;
        let error: string | undefined;

        const evaluateAssertion = async (): Promise<
          { passed: boolean; error?: string }
        > => {
          // Get the assertion cell via .key()
          try {
            const assertCell = stepCell.key("assertion") as Cell<unknown>;
            const value = await assertCell.pull();
            if (value === true) {
              return { passed: true };
            }
            return {
              passed: false,
              error: `Expected true, got ${toCompactDebugString(value)}`,
            };
          } catch (err) {
            return {
              passed: false,
              error: `Error reading assertion: ${
                err instanceof Error ? err.message : String(err)
              }`,
            };
          }
        };

        ({ passed, error } = await withPhase(
          ["runTestPattern", "step", assertionName, "evaluate"],
          () => evaluateAssertion(),
        ));

        if (!passed && lastActionIndex !== null) {
          try {
            for (let retry = 0; retry < 3 && !passed; retry++) {
              await new Promise((resolve) => setTimeout(resolve, 0));
              await settleRuntime(i, assertionName, 6);
              ({ passed, error } = await withPhase(
                [
                  "runTestPattern",
                  "step",
                  assertionName,
                  `retry-${retry + 1}`,
                  "evaluate",
                ],
                () => evaluateAssertion(),
              ));
            }
          } catch (err) {
            passed = false;
            error = err instanceof Error ? err.message : String(err);
          }
        }

        results.push({
          name: assertionName,
          passed,
          afterAction: lastActionIndex !== null
            ? `action_${actionCount}`
            : null,
          error,
          durationMs: performance.now() - itemStart,
        });

        if (options.verbose) {
          const status = passed ? "✓" : "✗";
          const suffix = lastActionIndex !== null
            ? ` (after action_${actionCount})`
            : "";
          console.log(`  ${status} ${assertionName}${suffix}`);
        }
      }

      // Print delta stats for slow steps
      if (options.verbose) {
        const statsThreshold = options.statsThreshold ?? 5000;
        const stepDuration = performance.now() - itemStart;
        if (stepDuration > statsThreshold || statsThreshold === 0) {
          const stepLabel = isAction
            ? `action_${actionCount}`
            : `assertion_${assertionCount}`;
          printLoggerStats(
            performance.now() - startTime,
            true,
            `${stepLabel} took ${fmtMs(stepDuration)}`,
            options.statsInclude,
          );
          printSettleStats(runtime.scheduler.getSettleStats());
        }
      }
    }

    // Print action stats table (sorted by total time, like the shell debug UI)
    if (options.verbose) {
      printActionStatsTable(runtime);
    }
    if (options.storageStats) {
      printStorageStats(
        performance.now() - startTime,
        options.storageStatsLimit ?? 16,
      );
    }

    // Collect idempotency violations detected during normal execution
    const nonIdempotent = runtime.getIdempotencyViolations()
      .map((r) => {
        const id = r.actionInfo?.patternName ?? r.actionId;
        return r.differingWriteKeys.length
          ? `${id} (differing writes: ${r.differingWriteKeys.join(", ")})`
          : id;
      });

    // Channel 2: compute logger error/warn deltas since the run-phase snapshot
    // and append any new activity to the console capture lists.
    appendLoggerDeltaMessages(
      loggerCountsBeforeRun,
      consoleErrors,
      consoleWarnings,
    );

    const errorMessages = [
      ...runtimeErrors.map((e) => String(e)),
      ...continuousUiErrors.map((e) => `[continuous $UI] ${String(e)}`),
    ];
    return {
      path: testPath,
      results,
      totalDurationMs: performance.now() - startTime,
      navigations,
      runtimeErrors: errorMessages,
      allowRuntimeErrors,
      nonIdempotent,
      expectNonIdempotent,
      consoleErrors,
      allowConsoleErrors,
      consoleWarnings,
      allowConsoleWarnings,
    };
  } catch (err) {
    let errorMessage = err instanceof Error ? err.message : String(err);

    // Add helpful hint for import resolution errors when --root wasn't provided
    if (
      errorMessage.includes("No such file or directory") &&
      errorMessage.includes("readfile") &&
      !options.root
    ) {
      errorMessage +=
        "\n    Hint: If the test imports from sibling directories (e.g., ../shared/), use --root to specify a common ancestor.";
    }

    const errorMessages = [
      ...runtimeErrors.map((e) => String(e)),
      ...continuousUiErrors.map((e) => `[continuous $UI] ${String(e)}`),
    ];
    return {
      path: testPath,
      results: [],
      totalDurationMs: performance.now() - startTime,
      navigations,
      runtimeErrors: errorMessages,
      nonIdempotent: [],
      error: errorMessage,
      consoleErrors,
      consoleWarnings,
    };
  } finally {
    if (
      patternCoverage && options.patternCoverageDir &&
      writeLocalPatternCoverage
    ) {
      await withPhase(
        ["runTestPattern", "coverage", "write"],
        () =>
          writePatternCoverageLcov(
            patternCoverage,
            patternCoverageOutputPath(options.patternCoverageDir!, testPath),
            { root: options.root },
          ),
      ).catch((error) => {
        console.error(
          `[cf test] failed to write pattern coverage for ${testPath}: ${
            formatError(error)
          }`,
        );
      });
    }
    // 6. Cleanup
    continuousUiCancel?.();
    continuousUiCancel = undefined;
    await withPhase(["runTestPattern", "cleanup", "engineDispose"], () => {
      engine.dispose();
    });
    await withPhase(
      ["runTestPattern", "cleanup", "storageClose"],
      () => storageManager.close(),
    );
  }
}

/**
 * Run all test patterns in a directory or a single test file.
 */
export async function runTests(
  pathOrPaths: string | string[],
  options: TestRunnerOptions = {},
): Promise<{
  passed: number;
  failed: number;
  skipped: number;
  results: TestRunResult[];
}> {
  const paths = Array.isArray(pathOrPaths) ? pathOrPaths : [pathOrPaths];
  const allResults: TestRunResult[] = [];
  let totalPassed = 0;
  let totalFailed = 0;
  let totalSkipped = 0;

  for (const testPath of paths) {
    console.log(`\n${basename(testPath)}`);

    const result = await runTestPattern(testPath, options);
    allResults.push(result);

    if (result.error) {
      console.log(`  ✗ Error: ${result.error}`);
      totalFailed++;
    } else {
      for (const test of result.results) {
        if (test.skipped) {
          totalSkipped++;
        } else if (test.passed) {
          totalPassed++;
        } else {
          totalFailed++;
        }

        const status = test.skipped ? "⊘" : test.passed ? "✓" : "✗";
        const suffix = test.afterAction ? ` (after ${test.afterAction})` : "";
        const skipLabel = test.skipped ? " (skipped)" : "";
        console.log(`  ${status} ${test.name}${suffix}${skipLabel}`);
        if (!test.passed && !test.skipped && test.error) {
          console.log(`    ${test.error}`);
        }
      }

      // Print navigation summary if any navigations occurred
      if (result.navigations.length > 0) {
        console.log(
          `  📍 ${result.navigations.length} navigation(s): ${
            result.navigations
              .map((n) => n.name ?? "(unnamed)")
              .join(", ")
          }`,
        );
      }

      // Report non-idempotent computations
      if (result.nonIdempotent.length > 0) {
        if (result.expectNonIdempotent) {
          console.log(
            `  ⊘ ${result.nonIdempotent.length} non-idempotent computation(s) (expected)`,
          );
        } else {
          totalFailed++;
          console.log(
            `  ✗ ${result.nonIdempotent.length} non-idempotent computation(s):`,
          );
          for (const name of result.nonIdempotent) {
            console.log(`    ${name}`);
          }
        }
      } else if (result.expectNonIdempotent) {
        // The flag asserts the detector fires — passing silently here would
        // let detection regressions defang the non-idempotent fixtures.
        totalFailed++;
        console.log(
          "  ✗ expected non-idempotent computation(s), none detected",
        );
      }

      // Report runtime errors
      if (result.runtimeErrors.length > 0) {
        if (result.allowRuntimeErrors) {
          console.log(
            `  ⊘ ${result.runtimeErrors.length} runtime error(s) (allowed)`,
          );
        } else {
          totalFailed++;
          console.log(
            `  ✗ ${result.runtimeErrors.length} runtime error(s) during test:`,
          );
          for (const msg of result.runtimeErrors) {
            // Show first line of each error, truncated
            const firstLine = msg.split("\n")[0];
            const truncated = firstLine.length > 120
              ? firstLine.slice(0, 120) + "..."
              : firstLine;
            console.log(`    ${truncated}`);
          }
        }
      }

      // Report console errors (channel 1: console.error; channel 2: logger errors)
      if (result.consoleErrors && result.consoleErrors.length > 0) {
        if (result.allowConsoleErrors) {
          console.log(
            `  ⊘ ${result.consoleErrors.length} console error(s) (allowed)`,
          );
        } else {
          totalFailed++;
          console.log(
            `  ✗ ${result.consoleErrors.length} console error(s) during test:`,
          );
          for (const msg of result.consoleErrors) {
            const truncated = msg.length > 120
              ? msg.slice(0, 120) + "..."
              : msg;
            console.log(`    ${truncated}`);
          }
        }
      }

      // Report console warnings (channel 1: console.warn; channel 2: logger warns)
      if (result.consoleWarnings && result.consoleWarnings.length > 0) {
        if (result.allowConsoleWarnings) {
          console.log(
            `  ⊘ ${result.consoleWarnings.length} console warning(s) (allowed)`,
          );
        } else {
          totalFailed++;
          console.log(
            `  ✗ ${result.consoleWarnings.length} console warning(s) during test:`,
          );
          for (const msg of result.consoleWarnings) {
            const truncated = msg.length > 120
              ? msg.slice(0, 120) + "..."
              : msg;
            console.log(`    ${truncated}`);
          }
        }
      }
    }
  }

  // Summary
  const totalTime = allResults.reduce((sum, r) => sum + r.totalDurationMs, 0);
  const parts = [`${totalPassed} passed`, `${totalFailed} failed`];
  if (totalSkipped > 0) {
    parts.push(`${totalSkipped} skipped`);
  }
  console.log(`\n${parts.join(", ")} (${Math.round(totalTime)}ms)`);

  return {
    passed: totalPassed,
    failed: totalFailed,
    skipped: totalSkipped,
    results: allResults,
  };
}

/**
 * Discover test files in a directory.
 */
export async function discoverTestFiles(dir: string): Promise<string[]> {
  const testFiles: string[] = [];

  try {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isFile && entry.name.endsWith(".test.tsx")) {
        testFiles.push(`${dir}/${entry.name}`);
      } else if (entry.isDirectory) {
        // Recursively search subdirectories
        const subFiles = await discoverTestFiles(`${dir}/${entry.name}`);
        testFiles.push(...subFiles);
      }
    }
  } catch {
    // Directory doesn't exist or can't be read
  }

  return testFiles;
}
