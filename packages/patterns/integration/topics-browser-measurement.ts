/**
 * Browser-tier measurement of one operation on a Topics board, for
 * `docs/plans/topics-computation-cost.md`: reactive-body reads for the board's
 * pivot and for each topic's backlink, comment-count, and activity lifts,
 * scheduler graph size, and timing split between the main thread and the
 * worker as far as the shell's timing records that split.
 *
 * `measureTopicsReads()` turns telemetry and body read accounting on around the
 * operation, so its elapsed time carries their overhead.
 * `timeTopicsOperation()` turns both off, for an interval a benchmark times.
 * Neither records transaction-attempt reads; {@link ATTEMPT_READS_NOTE} says
 * why. Both need the runtime client that signing in creates, so neither
 * brackets cold initialization, and a sample whose client is replaced during
 * the operation fails. The decisions that need no page are in
 * `topics-browser-measurement-core.ts`.
 */

import { join } from "@std/path";

import type { Page } from "@commonfabric/integration";
import { RequestType, type RuntimeClient } from "@commonfabric/runtime-client";

import { settleView, waitForRuntimeIdle } from "./cfc-browser-helpers.ts";
import {
  confirmLiftImplementations,
  liftRunningStates,
  locateLift,
  parseSrc,
  type ResolvedTopicsLift,
  runThenStop,
  timingDelta,
  type TimingRow,
  type TimingSnapshot,
  type TopicsLift,
  type TopicsLiftSite,
  workerRunCount,
} from "./topics-browser-measurement-core.ts";

/** Why no sample carries transaction-attempt reads. */
export const ATTEMPT_READS_NOTE =
  "Body reads only: transaction-attempt reads come from the headless tier, " +
  "because the runtime client's read-stats request enables body accounting " +
  "only.";

/** What the timing rows measure, and what no row measures. */
export const TIMING_NOTE =
  "Timing: a row sums spans that can overlap, so its total can exceed the " +
  "elapsed time. `vdomApply` is the main thread's " +
  "`vdom-applicator/apply-batch`, applying worker VDOM batches' operations " +
  "to the DOM. The main thread's other rows include `vdom-renderer` mount " +
  "and unmount spans, which wait on the worker, `vdom-renderer` batch spans " +
  "around applying a batch, `vdom-applicator` dispose and remove-node spans, " +
  "and `runtime-client/ipc/*` waits on the worker. Lit element updates, " +
  "style, layout, and paint have no timing of their own and fall only in the " +
  "elapsed time.";

/** Why a timed interval reports no event commit error. */
export const COMMIT_ERRORS_NOTE =
  "Event commit errors: not observed with telemetry off. A measured sample of " +
  "the same operation, which the caller pairs with this one, checks them.";

const ACCOUNTING_ON_NOTE =
  "Read accounting and telemetry were on around this operation, so its " +
  "elapsed time and timing rows include their overhead: not a latency sample.";

const ACCOUNTING_OFF_NOTE =
  "Read accounting and telemetry were turned off before this interval, which " +
  "records no reads.";

const WORKER_RUNS_NOTE =
  "Worker runs: action runs the scheduler timed with `runSchedulerAction`'s " +
  "`scheduler/run` span, a lower bound when runs overlap.";

/**
 * The program root the topic board fixture deploys a board from, against which
 * a lift's module path is read.
 */
export const TOPICS_SOURCE_ROOT = join(import.meta.dirname!, "..");

/** The board's pivot, and the per-topic lifts that read it or report activity. */
export const TOPICS_LIFTS: readonly TopicsLift[] = [
  { name: "crossrefTable", module: "topics/main.tsx", role: "producer" },
  { name: "backlinksOf", module: "topics/topic.tsx", role: "consumer" },
  {
    name: "presentCommentCountOf",
    module: "topics/topic.tsx",
    role: "consumer",
  },
  { name: "lastActivityOf", module: "topics/topic.tsx", role: "consumer" },
];

/** Counters summed over a set of completed runs. */
export interface ReadTotals {
  /** Completed runs carrying a read sample. */
  runs: number;

  /** Sum of the runs' `durationMs`. */
  durationMs: number;

  /** Sum of proxy accesses. */
  proxyAccesses: number;

  /** Largest proxy-access count of any one run. */
  maxProxyAccesses: number;

  /** Sum of stored-link traversal attempts. */
  linkResolutions: number;

  /** Sum of each run's distinct-document count, not a union across runs. */
  distinctDocuments: number;

  /** Sum of each run's registered dependency count. */
  registeredDependencies: number;
}

/** One named lift's totals over a measured operation. */
export interface TopicsLiftRow extends ReadTotals, TopicsLiftSite {
  /**
   * Whether the lift's module ran before, during, or after the operation. A
   * lift reports `false`, with zero runs, only when no action's `src` named its
   * module's file under any path.
   */
  readonly instantiated: boolean;

  /**
   * The graph snapshot's preview of the implementation running at the lift's
   * site, which the helper confirmed against the lift's declaration. Absent
   * for a lift that is not running.
   */
  readonly implementation?: string;
}

/** Scheduler graph size at one instant. */
export interface GraphSize {
  /** Scheduler actions. */
  readonly nodes: number;

  /** Dependency edges between them. */
  readonly edges: number;
}

/** Timing accumulated over an operation, less the helper's own requests. */
export interface TopicsTiming {
  /** The shell page's timing statistics, slowest total first. */
  readonly mainThread: readonly TimingRow[];

  /** The runtime worker's timing statistics, slowest total first. */
  readonly worker: readonly TimingRow[];

  /** The main thread's VDOM batch application; see {@link TIMING_NOTE}. */
  readonly vdomApply: TimingRow;
}

/** What every sample records. */
interface TopicsSampleBase {
  /** The caller's name for the operation. */
  readonly label: string;

  /** From starting the operation to a settled view over an idle runtime. */
  readonly elapsedMs: number;

  /** Graph size before and after the operation. */
  readonly graph: { readonly before: GraphSize; readonly after: GraphSize };

  /** Timing split between the main thread and the worker. */
  readonly timing: TopicsTiming;

  /** Statements about what the sample's figures include and exclude. */
  readonly notes: readonly string[];
}

/** An operation measured with telemetry and body read accounting on. */
export interface TopicsReadSample extends TopicsSampleBase {
  /** Read accounting was on for this sample. */
  readonly readAccounting: true;

  /** One row per named lift, in {@link TOPICS_LIFTS} order. */
  readonly lifts: readonly TopicsLiftRow[];

  /** Every run that is not a named lift's. */
  readonly remaining: ReadTotals;

  /** Completed runs with no read sample, having started before accounting. */
  readonly runsWithoutReads: number;

  /** Successful event-commit markers. */
  readonly eventCommits: number;
}

/** An operation timed with telemetry and read accounting off. */
export interface TopicsTimedSample extends TopicsSampleBase {
  /** Read accounting was off for this sample. */
  readonly readAccounting: false;

  /** Telemetry and read accounting were turned off before the interval. */
  readonly accountingTurnedOff: true;

  /** Whether the caller declared that the operation may run nothing. */
  readonly mayRunNothing: boolean;

  /**
   * Action runs the worker's scheduler timed with `runSchedulerAction`'s
   * `scheduler/run` span. Runs that overlap share that span's timer, so this
   * is a lower bound.
   */
  readonly workerRuns: number;
}

/** Either kind of sample. */
export type TopicsSample = TopicsReadSample | TopicsTimedSample;

/** The operation a sample drives, and what to call it. */
export interface TopicsOperationOptions {
  /** Names the operation in the sample and in failures. */
  readonly label: string;

  /** Drives the page; the helper waits for the view and runtime afterward. */
  readonly operation: () => Promise<unknown>;
}

/** Options for {@link measureTopicsReads}. */
export interface MeasureTopicsReadsOptions extends TopicsOperationOptions {
  /** Program root the board was deployed from; {@link TOPICS_SOURCE_ROOT}. */
  readonly sourceRoot?: string;
}

/** The part of a `Deno.bench` context that brackets a timed interval. */
export interface TimedInterval {
  /** Starts the timed interval. */
  start(): void;

  /** Ends the timed interval. */
  end(): void;
}

/** Options for {@link timeTopicsOperation}. */
export interface TimeTopicsOperationOptions extends TopicsOperationOptions {
  /**
   * Started just before the operation, and ended at its settled boundary or
   * where the operation or the wait for that boundary throws.
   */
  readonly interval?: TimedInterval;

  /**
   * Declares that the operation may run nothing in the worker. Without it, a
   * timed operation that records no scheduler run fails.
   */
  readonly mayRunNothing?: boolean;
}

/**
 * Reads each lift's module under `sourceRoot` and returns where the lift's
 * function starts, with the declaration it was found by.
 *
 * @throws If a module does not declare its lift as `locateLift()` requires.
 */
export async function resolveTopicsLiftSites(
  sourceRoot: string = TOPICS_SOURCE_ROOT,
  lifts: readonly TopicsLift[] = TOPICS_LIFTS,
): Promise<ResolvedTopicsLift[]> {
  const texts = new Map<string, string>();
  const resolved: ResolvedTopicsLift[] = [];
  for (const lift of lifts) {
    const path = join(sourceRoot, lift.module);
    let text = texts.get(path);
    if (text === undefined) {
      text = await Deno.readTextFile(path);
      texts.set(path, text);
    }
    const { position, text: declaration } = locateLift(text, lift.name, path);
    resolved.push({
      ...lift,
      site: `/${lift.module}:${position.line}:${position.col}`,
      declaration,
    });
  }
  return resolved;
}

/**
 * Runs `operation` with telemetry and body read accounting on, and returns
 * each named lift's read totals with graph size and timing. Accounting is
 * enabled just before the operation and disabled once the view has settled
 * over an idle runtime, whether or not the operation succeeds. Each running
 * lift is confirmed by the implementation the graph shows at its site.
 *
 * @throws If a lift cannot be identified in the sources; if its module's file
 *   runs where `liftRunningStates()` refuses; if the implementation at a
 *   running lift's site is not the lift's; if the runtime client is replaced;
 *   or if the operation completes no run with a read sample, fails an event
 *   commit, or raises a page error. When the operation throws and disabling
 *   accounting also fails, an `AggregateError` holds both.
 */
export async function measureTopicsReads(
  page: Page,
  options: MeasureTopicsReadsOptions,
): Promise<TopicsReadSample> {
  const sites = await resolveTopicsLiftSites(options.sourceRoot);
  const pageErrors = watchPageErrors(page);
  try {
    const token = crypto.randomUUID();
    await startSampling(page, token);
    const { value: measured, stopped: state } = await runThenStop(
      async () => {
        const before = await readRuntimeState(page, token);
        const startedAt = performance.now();
        await options.operation();
        await settleOperation(page);
        return { before, elapsedMs: performance.now() - startedAt };
      },
      () => stopSampling(page, token),
    );
    const after = await readRuntimeState(page, token, true);

    assertNoPageErrors(options.label, pageErrors.errors);
    if (state.eventCommitErrors.length > 0) {
      throw new Error(
        `${options.label}: ${state.eventCommitErrors.length} event commit(s) ` +
          `failed: ${state.eventCommitErrors.join("; ")}`,
      );
    }
    const measuredRuns = Object.values(state.bySrc)
      .reduce((sum, totals) => sum + totals.runs, 0);
    if (measuredRuns === 0) {
      throw new Error(
        `${options.label}: the measured operation produced no runs with a ` +
          `read sample`,
      );
    }

    const running = liftRunningStates(sites, [
      ...Object.keys(measured.before.actions),
      ...Object.keys(after.actions),
      ...Object.keys(state.bySrc),
    ]);
    const implementations = confirmLiftImplementations(
      sites,
      [measured.before.actions, after.actions],
      running,
    );
    const bySite = new Map(sites.map((lift) => [lift.site, {
      totals: emptyTotals(),
      implementation: implementations.get(lift.site),
    }]));
    const remaining = emptyTotals();
    for (const [src, totals] of Object.entries(state.bySrc)) {
      const site = parseSrc(src)?.site;
      addTotals(
        (site === undefined ? undefined : bySite.get(site)?.totals) ??
          remaining,
        totals,
      );
    }
    return {
      label: options.label,
      readAccounting: true,
      elapsedMs: measured.elapsedMs,
      graph: { before: measured.before.graph, after: after.graph },
      timing: timingBetween(measured.before, after),
      lifts: sites.map((lift) => {
        const entry = bySite.get(lift.site)!;
        return {
          name: lift.name,
          module: lift.module,
          role: lift.role,
          site: lift.site,
          ...entry.totals,
          instantiated: running.get(lift.site)!,
          implementation: entry.implementation,
        };
      }),
      remaining,
      runsWithoutReads: state.runsWithoutReads,
      eventCommits: state.eventCommits,
      notes: [ACCOUNTING_ON_NOTE, ATTEMPT_READS_NOTE, TIMING_NOTE],
    };
  } finally {
    pageErrors.stop();
  }
}

/**
 * Turns telemetry and read accounting off, runs `operation`, and returns its
 * elapsed time, graph size, and timing. `interval`, when given, starts just
 * before the operation and ends at the settled boundary, or where the
 * operation or the wait for that boundary throws. Event commit errors are not
 * observed with telemetry off; {@link COMMIT_ERRORS_NOTE} says what checks them.
 *
 * @throws If the page raises an error; if the runtime client is replaced; if
 *   the worker's timing has no run span to count; or if the worker records no
 *   scheduler run and the caller did not declare `mayRunNothing`.
 */
export async function timeTopicsOperation(
  page: Page,
  options: TimeTopicsOperationOptions,
): Promise<TopicsTimedSample> {
  const pageErrors = watchPageErrors(page);
  try {
    const token = crypto.randomUUID();
    await turnAccountingOff(page, token);
    const before = await readRuntimeState(page, token);
    const startedAt = performance.now();
    options.interval?.start();
    try {
      await options.operation();
      await settleOperation(page);
    } finally {
      options.interval?.end();
    }
    const elapsedMs = performance.now() - startedAt;
    const after = await readRuntimeState(page, token, true);

    assertNoPageErrors(options.label, pageErrors.errors);
    const workerRuns = workerRunCount(before.workerTiming, after.workerTiming);
    const mayRunNothing = options.mayRunNothing ?? false;
    if (workerRuns === 0 && !mayRunNothing) {
      throw new Error(
        `${options.label}: the timed operation ran nothing in the worker; ` +
          "declare `mayRunNothing` for an operation that may",
      );
    }
    return {
      label: options.label,
      readAccounting: false,
      accountingTurnedOff: true,
      mayRunNothing,
      elapsedMs,
      graph: { before: before.graph, after: after.graph },
      timing: timingBetween(before, after),
      workerRuns,
      notes: [
        ACCOUNTING_OFF_NOTE,
        COMMIT_ERRORS_NOTE,
        WORKER_RUNS_NOTE,
        ATTEMPT_READS_NOTE,
        TIMING_NOTE,
      ],
    };
  } finally {
    pageErrors.stop();
  }
}

/**
 * Formats a sample as lines for a diagnostic stream: the graph and elapsed
 * time, the lift rows when reads were recorded, the `timingRows` slowest timing
 * keys on each thread, and the sample's notes.
 */
export function formatTopicsSample(
  sample: TopicsSample,
  timingRows = 8,
): string[] {
  const { before, after } = sample.graph;
  const lines = [
    `${sample.label}: ${sample.elapsedMs.toFixed(0)}ms, read accounting ${
      sample.readAccounting ? "on" : "off"
    }; graph ${before.nodes} -> ${after.nodes} nodes, ${before.edges} -> ${after.edges} edges`,
  ];
  if (sample.readAccounting) {
    const columns = (values: readonly (string | number)[]) =>
      values.map((value) => String(value).padStart(10)).join(" ");
    const row = (label: string, totals: ReadTotals, site: string) =>
      `  ${label.padEnd(32)} ${
        columns([
          totals.runs,
          totals.durationMs.toFixed(1),
          totals.proxyAccesses,
          totals.maxProxyAccesses,
          totals.linkResolutions,
          totals.distinctDocuments,
          totals.registeredDependencies,
        ])
      }  ${site}`;
    lines.push(
      `  ${"lift".padEnd(32)} ${
        columns([
          "runs",
          "ms",
          "accesses",
          "max/run",
          "link hops",
          "docs Σ",
          "deps Σ",
        ])
      }  site`,
    );
    for (const lift of sample.lifts) {
      lines.push(row(
        `${lift.role} ${lift.name}`,
        lift,
        lift.instantiated ? lift.site : `${lift.site} (not running)`,
      ));
    }
    lines.push(row("remaining", sample.remaining, ""));
    lines.push(
      `  ${sample.runsWithoutReads} runs without a read sample; ` +
        `${sample.eventCommits} event commits`,
    );
  } else {
    lines.push(
      `  ${sample.workerRuns} worker scheduler runs${
        sample.mayRunNothing ? ", declared that it may run nothing" : ""
      }; telemetry and read accounting turned off before the interval`,
    );
  }
  const timingLine = (row: TimingRow) =>
    `    ${row.totalMs.toFixed(1).padStart(9)}ms ${
      String(row.count).padStart(6)
    }x  ${row.key}`;
  const { vdomApply } = sample.timing;
  lines.push(
    `  main thread, ${vdomApply.totalMs.toFixed(1)}ms applying ` +
      `${vdomApply.count} VDOM batches:`,
    ...sample.timing.mainThread.slice(0, timingRows).map(timingLine),
    "  worker:",
    ...sample.timing.worker.slice(0, timingRows).map(timingLine),
    ...sample.notes.map((note) => `  note: ${note}`),
  );
  return lines;
}

//
// Page access
//

/** Run markers summed in the page while a sampling is active. */
interface PageSampling {
  /** Totals by run `src`; a run with no `src` is keyed by the empty string. */
  bySrc: Record<string, ReadTotals>;

  /** Completed runs that carried no read sample. */
  runsWithoutReads: number;

  /** Successful event-commit markers. */
  eventCommits: number;

  /** Messages of failed event-commit markers. */
  eventCommitErrors: string[];
}

/** One sample's hold on the page: the client it started with, and any listener. */
interface PageSampleEntry {
  /** The runtime client the sample started against. */
  client: RuntimeClient;

  /** Run markers collected, for a sample measuring reads. */
  sampling?: PageSampling;

  /** Unsubscribes the telemetry listener, for a sample measuring reads. */
  unsubscribe?: () => void;
}

/** Shell globals a sample reads, and the samples in progress in the page. */
type MeasurementGlobal = typeof globalThis & {
  /** The shell's debugging globals. */
  commonfabric?: {
    /** The runtime client the shell's views run against. */
    rt?: RuntimeClient;

    /** Main-thread timing statistics by logger and key. */
    getTimingStatsBreakdown?: () => Record<
      string,
      Record<string, { count: number; totalTime: number }>
    >;
  };

  /** Samples in progress, by token. */
  __cfTopicsSamples?: Record<string, PageSampleEntry>;
};

/** Graph, implementations, and timing as they stand at one instant. */
interface RuntimeState {
  /** Graph size. */
  graph: GraphSize;

  /** Distinct implementation previews of the graph's actions, by `src`. */
  actions: Record<string, string[]>;

  /** Main-thread timing. */
  mainTiming: TimingSnapshot;

  /** Worker timing. */
  workerTiming: TimingSnapshot;
}

/** Requests the helper itself sends, whose timing is not the operation's. */
const HELPER_REQUESTS: ReadonlySet<string> = new Set([
  RequestType.GetGraphSnapshot,
  RequestType.GetLoggerCounts,
  RequestType.SetReadStatsEnabled,
  RequestType.SetTelemetryEnabled,
]);

/**
 * Helper for the samplers, which collects page errors until `stop()` is
 * called.
 */
function watchPageErrors(page: Page): { errors: string[]; stop(): void } {
  const errors: string[] = [];
  const listening = new AbortController();
  page.addEventListener("pageerror", (event) => {
    errors.push(event.detail.message);
  }, { signal: listening.signal });
  return { errors, stop: () => listening.abort() };
}

/** Helper for the samplers, which fails a sample that raised page errors. */
function assertNoPageErrors(label: string, errors: readonly string[]): void {
  if (errors.length > 0) {
    throw new Error(
      `${label}: the page raised ${errors.length} error(s): ${
        errors.join("; ")
      }`,
    );
  }
}

/**
 * Helper for the samplers, which waits for the operation's boundary: a
 * settled view, then an idle runtime with its commits confirmed.
 */
async function settleOperation(page: Page): Promise<void> {
  await settleView(page);
  await waitForRuntimeIdle(page);
}

/**
 * Helper for {@link measureTopicsReads}, which subscribes to the page's
 * telemetry under `token` and enables telemetry and read accounting, leaving
 * the page as it found it when enabling fails.
 */
async function startSampling(page: Page, token: string): Promise<void> {
  await page.evaluate(async (token: string) => {
    const scope = globalThis as MeasurementGlobal;
    const rt = scope.commonfabric?.rt;
    if (!rt) throw new Error("The shell exposes no runtime client to measure");
    const sampling: PageSampling = {
      bySrc: {},
      runsWithoutReads: 0,
      eventCommits: 0,
      eventCommitErrors: [],
    };
    const listener: Parameters<typeof rt.on<"telemetry">>[1] = (marker) => {
      if (marker.type === "scheduler.event.commit") {
        if (marker.error) sampling.eventCommitErrors.push(marker.error);
        else sampling.eventCommits++;
        return;
      }
      if (marker.type !== "scheduler.run.complete") return;
      if (!marker.reads) {
        sampling.runsWithoutReads++;
        return;
      }
      const totals = sampling.bySrc[marker.src ?? ""] ??= {
        runs: 0,
        durationMs: 0,
        proxyAccesses: 0,
        maxProxyAccesses: 0,
        linkResolutions: 0,
        distinctDocuments: 0,
        registeredDependencies: 0,
      };
      totals.runs++;
      totals.durationMs += marker.durationMs;
      totals.proxyAccesses += marker.reads.proxyAccesses;
      totals.maxProxyAccesses = Math.max(
        totals.maxProxyAccesses,
        marker.reads.proxyAccesses,
      );
      totals.linkResolutions += marker.reads.linkResolutions;
      totals.distinctDocuments += marker.reads.distinctDocuments;
      totals.registeredDependencies += marker.reads.registeredDependencies;
    };
    rt.on("telemetry", listener);
    const samples = scope.__cfTopicsSamples ??= {};
    samples[token] = {
      client: rt,
      sampling,
      unsubscribe: () => rt.off("telemetry", listener),
    };
    try {
      await rt.setTelemetryEnabled(true);
      await rt.setReadStatsEnabled(true);
    } catch (error) {
      // Leave the page as it was found. The enabling failure is what the
      // caller hears about, so a failure to disable does not replace it.
      rt.off("telemetry", listener);
      delete samples[token];
      await Promise.allSettled([
        rt.setReadStatsEnabled(false),
        rt.setTelemetryEnabled(false),
      ]);
      throw error;
    }
  }, { args: [token] });
}

/**
 * Helper for {@link timeTopicsOperation}, which records the runtime client
 * under `token` and turns read accounting and telemetry off so that a timed
 * interval does not inherit either.
 */
async function turnAccountingOff(page: Page, token: string): Promise<void> {
  await page.evaluate(async (token: string) => {
    const scope = globalThis as MeasurementGlobal;
    const rt = scope.commonfabric?.rt;
    if (!rt) throw new Error("The shell exposes no runtime client to time");
    (scope.__cfTopicsSamples ??= {})[token] = { client: rt };
    await rt.setReadStatsEnabled(false);
    await rt.setTelemetryEnabled(false);
  }, { args: [token] });
}

/**
 * Helper for {@link measureTopicsReads}, which unsubscribes the sampling under
 * `token`, disables read accounting and telemetry, and returns what it
 * collected.
 *
 * @throws If the runtime client is not the one the sampling started against:
 *   its listener and its accounting belonged to the replaced client.
 */
async function stopSampling(page: Page, token: string): Promise<PageSampling> {
  return await page.evaluate(async (token: string) => {
    const scope = globalThis as MeasurementGlobal;
    const entry = scope.__cfTopicsSamples?.[token];
    if (!entry?.sampling || !entry.unsubscribe) {
      throw new Error("The sampling under this token is gone");
    }
    entry.unsubscribe();
    if (scope.commonfabric?.rt !== entry.client) {
      delete scope.__cfTopicsSamples![token];
      throw new Error(
        "The runtime client was replaced during the measured operation, so " +
          "its runs were not all observed",
      );
    }
    await entry.client.setReadStatsEnabled(false);
    await entry.client.setTelemetryEnabled(false);
    return entry.sampling;
  }, { args: [token] });
}

/**
 * Helper for the samplers, which reads graph size, implementation previews,
 * and timing, and with `release` forgets the sample under `token`.
 *
 * @throws If the runtime client is not the one the sample started against.
 */
async function readRuntimeState(
  page: Page,
  token: string,
  release = false,
): Promise<RuntimeState> {
  return await page.evaluate(async (token: string, release: boolean) => {
    const scope = globalThis as MeasurementGlobal;
    const entry = scope.__cfTopicsSamples?.[token];
    const cf = scope.commonfabric;
    const mainBreakdown = cf?.getTimingStatsBreakdown;
    if (!entry || !mainBreakdown) {
      throw new Error("The sample or the shell's timing to read is gone");
    }
    if (release) delete scope.__cfTopicsSamples![token];
    if (cf?.rt !== entry.client) {
      throw new Error(
        "The runtime client was replaced during the operation, so its graph " +
          "and timing describe another runtime",
      );
    }
    const flatten = (
      groups: Record<
        string,
        Record<string, { count: number; totalTime: number }>
      >,
    ) => {
      const flat: Record<string, [number, number]> = {};
      for (const [logger, keys] of Object.entries(groups)) {
        for (const [key, stats] of Object.entries(keys)) {
          flat[`${logger}/${key}`] = [stats.count, stats.totalTime];
        }
      }
      return flat;
    };
    const graph = await entry.client.getGraphSnapshot();
    const workerTiming = flatten((await entry.client.getLoggerCounts()).timing);
    const actions: Record<string, string[]> = {};
    for (const node of graph.nodes) {
      if (node.src === undefined) continue;
      const previews = actions[node.src] ??= [];
      if (node.preview !== undefined && !previews.includes(node.preview)) {
        previews.push(node.preview);
      }
    }
    return {
      graph: { nodes: graph.nodes.length, edges: graph.edges.length },
      actions,
      mainTiming: flatten(mainBreakdown()),
      workerTiming,
    };
  }, { args: [token, release] });
}

//
// Aggregation
//

/** Returns totals of zero. */
function emptyTotals(): ReadTotals {
  return {
    runs: 0,
    durationMs: 0,
    proxyAccesses: 0,
    maxProxyAccesses: 0,
    linkResolutions: 0,
    distinctDocuments: 0,
    registeredDependencies: 0,
  };
}

/** Adds `from` into `into`. */
function addTotals(into: ReadTotals, from: ReadTotals): void {
  into.runs += from.runs;
  into.durationMs += from.durationMs;
  into.proxyAccesses += from.proxyAccesses;
  into.maxProxyAccesses = Math.max(
    into.maxProxyAccesses,
    from.maxProxyAccesses,
  );
  into.linkResolutions += from.linkResolutions;
  into.distinctDocuments += from.distinctDocuments;
  into.registeredDependencies += from.registeredDependencies;
}

/** Helper for the samplers, which returns timing recorded between two states. */
function timingBetween(
  before: RuntimeState,
  after: RuntimeState,
): TopicsTiming {
  const mainThread = timingDelta(
    before.mainTiming,
    after.mainTiming,
    HELPER_REQUESTS,
  );
  return {
    mainThread,
    worker: timingDelta(
      before.workerTiming,
      after.workerTiming,
      HELPER_REQUESTS,
    ),
    vdomApply:
      mainThread.find((row) => row.key === "vdom-applicator/apply-batch") ??
        { key: "vdom-applicator/apply-batch", count: 0, totalMs: 0 },
  };
}
