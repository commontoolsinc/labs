/**
 * Test runner for pattern-native tests.
 *
 * Test patterns (.test.tsx) are patterns that:
 * 1. Import and instantiate the pattern under test
 * 2. Define test steps as an array of { assertion } or { action } objects
 * 3. Return { tests: TestStep[] }
 *
 * TestStep is a discriminated union:
 * - { assertion: OpaqueRef<boolean> } from computed(() => condition)
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

import { Identity } from "@commontools/identity";
import { Engine, Runtime } from "@commontools/runner";
import type {
  Cell,
  ErrorWithContext,
  Pattern,
  SettleStats,
  Stream,
} from "@commontools/runner";
import type { OpaqueRef } from "@commontools/api";
import { FileSystemProgramResolver } from "@commontools/js-compiler";
import { basename } from "@std/path";
import { timeout } from "@commontools/utils/sleep";
import { experimentalOptionsFromEnv } from "./utils.ts";
import {
  type CDFPoint,
  getLoggerCountsBreakdown,
  getTimingStatsBreakdown,
  resetAllCountBaselines,
  resetAllTimingBaselines,
} from "@commontools/utils/logger";

/**
 * A test step is an object with either an 'assertion' or 'action' property.
 * This discriminated union avoids TypeScript trying to unify incompatible Cell/Stream types.
 * Add `skip: true` to temporarily disable a step (like it.skip in other frameworks).
 */
export type TestStep =
  | { assertion: OpaqueRef<boolean>; skip?: boolean }
  | { action: Stream<void>; skip?: boolean };

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

/** Performance metrics collected during a test run for tracking over time. */
export interface TestPerfStats {
  /** Whether pull-based scheduling was active */
  pullMode: boolean;
  /** Number of scheduler effects (sinks) */
  effects: number;
  /** Number of scheduler computations */
  computations: number;
  /** Scheduler timing: total time spent in execute() */
  schedulerExecuteMs: TimingSummary | null;
  /** Scheduler timing: total time spent in individual action runs */
  schedulerRunMs: TimingSummary | null;
  /** Scheduler timing: settle loop */
  schedulerSettleMs: TimingSummary | null;
  /** Scheduler timing: commit */
  schedulerCommitMs: TimingSummary | null;
  /** Top actions by total time */
  topActions: {
    id: string;
    preview?: string;
    runs: number;
    totalMs: number;
    avgMs: number;
  }[];
}

export interface TimingSummary {
  count: number;
  min: number;
  max: number;
  average: number;
  p50: number;
  p95: number;
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
  /** If true, non-idempotent computations are expected and should not fail the test */
  expectNonIdempotent?: boolean;
  /** Performance metrics for tracking over time */
  perf?: TestPerfStats;
}

export interface TestRunnerOptions {
  timeout?: number;
  verbose?: boolean;
  /** Root directory for resolving imports. If not provided, uses the test file's directory. */
  root?: string;
  /** Print logger stats for steps slower than this (ms). 0 = every step. Default 5000. Only applies when verbose is true. */
  statsThreshold?: number;
  /** Print per-test scheduler performance summary. Enabled by --perf-stats or --verbose. */
  perfStats?: boolean;
}

// ---------------------------------------------------------------------------
// Verbose-mode logger stats helpers
// ---------------------------------------------------------------------------

type GlobalWithLoggers = {
  commontools?: {
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
  if (g.commontools?.logger) {
    for (const logger of Object.values(g.commontools.logger)) {
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
  if (g.commontools?.logger) {
    for (const logger of Object.values(g.commontools.logger)) {
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

function printLoggerStats(
  elapsedMs: number,
  useDelta: boolean,
  label?: string,
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
    p50: number;
    p95: number;
    max: number;
  }[] = [];

  for (const [loggerName, timings] of Object.entries(breakdown)) {
    for (const [key, timing] of Object.entries(timings)) {
      if (useDelta) {
        if (!timing.cdfSinceBaseline || timing.cdfSinceBaseline.length === 0) {
          continue;
        }
        const cdf = timing.cdfSinceBaseline;
        entries.push({
          name: `${loggerName}/${key}`,
          n: cdf.length,
          p50: cdfPercentile(cdf, 0.5),
          p95: cdfPercentile(cdf, 0.95),
          max: cdf[cdf.length - 1].x,
        });
      } else {
        if (timing.count === 0) continue;
        entries.push({
          name: `${loggerName}/${key}`,
          n: timing.count,
          p50: timing.p50,
          p95: timing.p95,
          max: timing.max,
        });
      }
    }
  }

  if (entries.length > 0) {
    entries.sort((a, b) => b.p95 - a.p95);
    console.log(`           Timings (top 10 by p95):`);
    for (const entry of entries.slice(0, 10)) {
      const name = entry.name.padEnd(35);
      const np = useDelta ? "Δn" : " n";
      console.log(
        `             ${name} ${np}=${String(entry.n).padStart(5)} p50=${
          fmtMs(entry.p50).padStart(7)
        } p95=${fmtMs(entry.p95).padStart(7)} max=${
          fmtMs(entry.max).padStart(7)
        }`,
      );
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
    if (g.commontools?.logger) {
      for (const [name, logger] of Object.entries(g.commontools.logger)) {
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
 * Collect performance stats from the runtime for tracking over time.
 */
function collectPerfStats(runtime: Runtime): TestPerfStats {
  const schedulerStats = runtime.scheduler.getStats();
  const pullMode = runtime.scheduler.isPullModeEnabled();

  // Extract timing summaries from the logger
  const breakdown = getTimingStatsBreakdown();
  const schedulerTimings = breakdown["scheduler"] ?? {};

  function toSummary(
    key: string,
  ): TimingSummary | null {
    const t = schedulerTimings[key];
    if (!t || t.count === 0) return null;
    return {
      count: t.count,
      min: t.min,
      max: t.max,
      average: t.average,
      p50: t.p50,
      p95: t.p95,
    };
  }

  // Collect top actions by total time
  const snapshot = runtime.scheduler.getGraphSnapshot();
  const seen = new Map<
    string,
    {
      stats: NonNullable<(typeof snapshot.nodes)[0]["stats"]>;
      preview?: string;
      childIds: Set<string>;
    }
  >();
  for (const node of snapshot.nodes) {
    if (!node.stats || node.stats.runCount === 0) continue;
    const existing = seen.get(node.id);
    if (!existing) {
      seen.set(node.id, {
        stats: node.stats,
        preview: node.preview,
        childIds: new Set(),
      });
    }
  }
  for (const node of snapshot.nodes) {
    if (node.parentId && seen.has(node.parentId) && seen.has(node.id)) {
      seen.get(node.parentId)!.childIds.add(node.id);
    }
  }
  const allChildIds = new Set<string>();
  for (const entry of seen.values()) {
    for (const cid of entry.childIds) allChildIds.add(cid);
  }

  const topActions: TestPerfStats["topActions"] = [];
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
    topActions.push({
      id,
      preview: entry.preview,
      runs,
      totalMs,
      avgMs: runs > 0 ? totalMs / runs : 0,
    });
  }
  topActions.sort((a, b) => b.totalMs - a.totalMs);

  return {
    pullMode,
    effects: schedulerStats.effects,
    computations: schedulerStats.computations,
    schedulerExecuteMs: toSummary("scheduler/execute"),
    schedulerRunMs: toSummary("scheduler/run"),
    schedulerSettleMs: toSummary("scheduler/execute/settle"),
    schedulerCommitMs: toSummary("scheduler/run/commit"),
    topActions: topActions.slice(0, 10),
  };
}

/**
 * Print a compact perf summary line for a test run.
 */
function printPerfSummary(perf: TestPerfStats, path: string): void {
  const mode = perf.pullMode ? "pull" : "push";
  const exec = perf.schedulerExecuteMs;
  const run = perf.schedulerRunMs;
  const parts = [
    `mode=${mode}`,
    `effects=${perf.effects}`,
    `computations=${perf.computations}`,
  ];
  if (exec) {
    parts.push(
      `execute: n=${exec.count} p50=${fmtMs(exec.p50)} p95=${fmtMs(exec.p95)}`,
    );
  }
  if (run) {
    parts.push(
      `run: n=${run.count} p50=${fmtMs(run.p50)} p95=${fmtMs(run.p95)}`,
    );
  }
  console.log(`  [PERF] ${basename(path)}: ${parts.join(", ")}`);
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

  // Collect runtime errors via the scheduler's error handler
  const runtimeErrors: ErrorWithContext[] = [];

  // 1. Create emulated runtime (same as piece step)
  const identity = await Identity.fromPassphrase("test-runner");
  const space = identity.did();
  const { StorageManager } = await import(
    "@commontools/runner/storage/cache.deno"
  );
  const storageManager = StorageManager.emulate({ as: identity });

  // Track navigation events for assertions and verbose output
  const navigations: NavigationEvent[] = [];
  let currentActionIndex = -1;

  const runtime = new Runtime({
    storageManager,
    experimental: experimentalOptionsFromEnv(),
    apiUrl: new URL(import.meta.url),
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
  });
  runtime.enableIdempotencyCheck();
  if (options.verbose) {
    runtime.scheduler.enableSettleStats();
  }
  const engine = new Engine(runtime);

  // Track sink subscriptions for cleanup
  let sinkCancel: (() => void) | undefined;
  const assertionSinkCancels: (() => void)[] = [];

  // Catch unhandled errors from async pattern code (e.g. wish() using setTimeout).
  // Without this, patterns that throw in async callbacks crash the process.
  const uncaughtErrors: string[] = [];
  const globalErrorHandler = (e: ErrorEvent) => {
    e.preventDefault();
    uncaughtErrors.push(e.error?.message ?? e.message);
  };
  globalThis.addEventListener("error", globalErrorHandler);

  try {
    // 2. Compile the test pattern
    const program = await engine.resolve(
      new FileSystemProgramResolver(testPath, options.root),
    );
    const { main } = await engine.process(program, {
      noCheck: false,
      noRun: false,
    });

    if (!main?.default) {
      throw new Error(
        `Test pattern must export a pattern function as default`,
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
    {
      const setupTx = runtime.edit();
      const spaceCell = runtime.getCell(space, space, undefined, setupTx);
      const defaultPatternCell = runtime.getCell(
        space,
        "default-pattern",
        undefined,
        setupTx,
      );
      (defaultPatternCell as any).key("allPieces").set([]);
      (defaultPatternCell as any).key("recentPieces").set([]);
      (defaultPatternCell as any).key("backlinksIndex").set({
        mentionable: [],
      });
      (spaceCell as any).key("defaultPattern").set(defaultPatternCell);
      await setupTx.commit();
      await runtime.idle();
    }

    // 4. Instantiate the test pattern using runtime.run() for proper space context
    const tx = runtime.edit();

    // Create a result cell for the pattern
    const resultCell = runtime.getCell<Record<string, unknown>>(
      space,
      `test-pattern-result-${Date.now()}`,
      undefined,
      tx,
    );

    // Run the pattern with proper space context
    const patternResult = runtime.run(tx, testPatternFactory, {}, resultCell);

    // Commit the transaction
    await tx.commit();

    // Wait for initial setup to complete
    await runtime.idle();
    // Also wait for all in-flight storage subscriptions to settle.
    // replica.poll() fires without await during mount(), so subscription
    // updates can arrive after idle() resolves, scheduling more work.
    await storageManager.synced();
    await runtime.idle();

    // Keep the pattern reactive - store cancel function for cleanup
    sinkCancel = patternResult.sink(() => {});

    // 4. Get the tests array from pattern output
    const testsCell = patternResult.key("tests") as Cell<unknown>;
    const testsValue = testsCell.get();

    // In pull mode, assertion computations are stored as cell references in the
    // tests array. The patternResult sink doesn't deeply dereference them, so
    // their computations have no effect in the dependency chain and never
    // re-execute when inputs change. Sink each assertion cell individually so
    // pull mode keeps them reactive.
    if (
      Array.isArray(testsValue) && runtime.scheduler.isPullModeEnabled()
    ) {
      for (let i = 0; i < testsValue.length; i++) {
        const step = testsValue[i] as { assertion?: unknown };
        if ("assertion" in step) {
          try {
            const assertCell = testsCell.key(i).key(
              "assertion",
            ) as Cell<unknown>;
            assertionSinkCancels.push(assertCell.sink(() => {}));
          } catch {
            // Some assertion cells may not support sink
          }
        }
      }
      // Let the new sinks settle so dependency graph is up to date
      await runtime.idle();
    }

    // Validate it's an array
    if (!Array.isArray(testsValue)) {
      throw new Error(
        "Test pattern must return { tests: TestStep[] }. Got: " +
          JSON.stringify(typeof testsValue),
      );
    }

    // Check for allowRuntimeErrors and expectNonIdempotent flags
    const allowRuntimeErrors =
      (patternResult.key("allowRuntimeErrors") as Cell<unknown>).get() === true;
    const expectNonIdempotent =
      (patternResult.key("expectNonIdempotent") as Cell<unknown>).get() ===
        true;

    if (options.verbose) {
      console.log(`  Found ${testsValue.length} test steps`);
      printLoggerStats(performance.now() - startTime, false, "Setup");
      printSettleStats(runtime.scheduler.getSettleStats());
      resetAllCountBaselines();
      resetAllTimingBaselines();
    }

    // 5. Process tests sequentially
    const results: TestResult[] = [];
    let lastActionIndex: number | null = null;
    let assertionCount = 0;
    let actionCount = 0;

    for (let i = 0; i < testsValue.length; i++) {
      if (options.verbose) {
        resetAllCountBaselines();
        resetAllTimingBaselines();
      }
      const itemStart = performance.now();
      const stepValue = testsValue[i] as {
        action?: unknown;
        assertion?: unknown;
        skip?: boolean;
      };

      // Check if this step has 'action' or 'assertion' key
      const isAction = "action" in stepValue;
      const isAssertion = "assertion" in stepValue;

      if (!isAction && !isAssertion) {
        throw new Error(
          `Test step at index ${i} must have either 'action' or 'assertion' key. Got: ${
            JSON.stringify(Object.keys(stepValue))
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
        const actionStream = testsCell.key(i).key(
          "action",
        ) as unknown as Stream<unknown>;

        // Send undefined for void streams
        actionStream.send(undefined);

        // Wait for idle, then settle commits and re-idle.
        // Optimistic commits can fail (CAS conflicts), causing rollbacks
        // and reactive re-scheduling. We loop idle→synced until both
        // resolve quickly (< 1ms), indicating quiescence. Max iterations
        // as a safety net against infinite loops.
        try {
          const MAX_SETTLE = 20;
          await Promise.race([
            (async () => {
              for (let settle = 0; settle < MAX_SETTLE; settle++) {
                const iterStart = performance.now();
                await runtime.idle();
                await storageManager.synced();
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
              await runtime.idle();
            })(),
            timeout(
              TIMEOUT,
              `Action at index ${i} timed out after ${TIMEOUT}ms`,
            ),
          ]);
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
            // Helper to shorten cell paths: did:key:z6Mk.../of:baedrei.../value/foo → …rei.../value/foo
            const shortenPath = (r: string): string => {
              // Format: did:key:.../of:baedrei.../path/parts
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

            for (const d of deltas.slice(0, 10)) {
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
            if (deltas.length > 10) {
              const rest = deltas.slice(10).reduce((s, d) => s + d.delta, 0);
              console.log(
                `      ${String(rest).padStart(4)}× (${
                  deltas.length - 10
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

        try {
          // Get the assertion cell via .key()
          const assertCell = testsCell.key(i).key("assertion") as Cell<unknown>;
          const value = assertCell.get();
          passed = value === true;
          if (!passed) {
            error = `Expected true, got ${JSON.stringify(value)}`;
          }
        } catch (err) {
          passed = false;
          error = `Error reading assertion: ${
            err instanceof Error ? err.message : String(err)
          }`;
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
          );
          printSettleStats(runtime.scheduler.getSettleStats());
        }
      }
    }

    // Print action stats table (sorted by total time, like the shell debug UI)
    if (options.verbose) {
      printActionStatsTable(runtime);
    }

    // Collect perf stats before cleanup
    const perf = collectPerfStats(runtime);

    // Collect idempotency violations detected during normal execution
    const nonIdempotent = runtime.getIdempotencyViolations()
      .map((r) => r.actionInfo?.patternName ?? r.actionId);

    const errorMessages = runtimeErrors.map((e) => String(e));
    return {
      path: testPath,
      results,
      totalDurationMs: performance.now() - startTime,
      navigations,
      runtimeErrors: errorMessages,
      allowRuntimeErrors,
      nonIdempotent,
      expectNonIdempotent,
      perf,
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

    const errorMessages = runtimeErrors.map((e) => String(e));
    return {
      path: testPath,
      results: [],
      totalDurationMs: performance.now() - startTime,
      navigations,
      runtimeErrors: errorMessages,
      nonIdempotent: [],
      error: errorMessage,
    };
  } finally {
    // 6. Cleanup
    globalThis.removeEventListener("error", globalErrorHandler);
    for (const cancel of assertionSinkCancels) cancel();
    sinkCancel?.();
    engine.dispose();
    await storageManager.close();
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
    }
  }

  // Performance summary (only with --verbose or --perf-stats)
  if (options.perfStats) {
    const resultsWithPerf = allResults.filter((r) => r.perf);
    if (resultsWithPerf.length > 0) {
      console.log(`\n--- Performance Summary ---`);
      for (const result of resultsWithPerf) {
        printPerfSummary(result.perf!, result.path);
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
