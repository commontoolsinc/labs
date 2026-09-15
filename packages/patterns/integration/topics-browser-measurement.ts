/**
 * Browser-tier measurement of one operation on a Topics board, for
 * `docs/plans/topics-computation-cost.md`: reactive-body reads for the board's
 * pivot and for each topic's backlink, comment-count, and activity lifts,
 * scheduler graph size, and timing split between the main thread and the
 * worker as far as the shell's timing records that split.
 *
 * `measureTopicsReads()` turns telemetry and body read accounting on around the
 * operation, so its elapsed time carries their overhead.
 * `timeTopicsOperation()` leaves both off, for an interval a benchmark times.
 * Neither records transaction-attempt reads; {@link ATTEMPT_READS_NOTE} says
 * why.
 */

import { join } from "@std/path";

import type { Page } from "@commonfabric/integration";
import { RequestType, type RuntimeClient } from "@commonfabric/runtime-client";

import { settleView, waitForRuntimeIdle } from "./cfc-browser-helpers.ts";

/** Why no sample carries transaction-attempt reads. */
export const ATTEMPT_READS_NOTE =
  "Body reads only: transaction-attempt reads come from the headless tier, " +
  "because the runtime client's read-stats request enables body accounting " +
  "only.";

/** What the timing rows can and cannot say, rendering included. */
export const TIMING_NOTE =
  "Timing: a row sums the durations of spans that can overlap, so its total " +
  "can exceed the elapsed time. `vdom-applicator/apply-batch` is the only " +
  "main-thread rendering time the shell records, and it covers applying " +
  "worker VDOM batches to the DOM. Lit element updates, style, layout, and " +
  "paint have no timing of their own and fall only in the elapsed time. " +
  "`runtime-client/ipc/*` rows are main-thread waits on the worker, not " +
  "main-thread work.";

const ACCOUNTING_ON_NOTE =
  "Read accounting and telemetry were on around this operation, so its " +
  "elapsed time and timing rows include their overhead: not a latency sample.";

const ACCOUNTING_OFF_NOTE =
  "Read accounting and telemetry were off for this operation, which records " +
  "no reads.";

/**
 * The program root the topic board fixture deploys a board from, against which
 * a lift's module path is read.
 */
export const TOPICS_SOURCE_ROOT = join(import.meta.dirname!, "..");

/** A lift the plan measures separately, named by its binding. */
export interface TopicsLift {
  /** Binding name of the module-scope `lift()` declaration. */
  readonly name: string;

  /** Declaring module, relative to the program root. */
  readonly module: string;

  /** Whether the lift produces the board's pivot or reads it per topic. */
  readonly role: "producer" | "consumer";
}

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

/** A position in authored source: line 1-based, column 0-based. */
export interface SourcePosition {
  /** Authored line, 1-based. */
  readonly line: number;

  /** Authored column, 0-based. */
  readonly col: number;
}

/** A named lift located in the sources the board was deployed from. */
export interface TopicsLiftSite extends TopicsLift {
  /** `/<module>:<line>:<col>`, which is how a run's `src` ends. */
  readonly site: string;
}

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
   * Whether the running graph held an action at the lift's site before or
   * after the operation, or the operation ran one. A lift that is not running
   * reports zero runs.
   */
  readonly instantiated: boolean;
}

/** Scheduler graph size at one instant. */
export interface GraphSize {
  /** Scheduler actions. */
  readonly nodes: number;

  /** Dependency edges between them. */
  readonly edges: number;
}

/** One timing key's samples accumulated over an operation. */
export interface TimingRow {
  /**
   * `<logger>/<key>`, with each all-digit segment written as `*` so that
   * per-batch and per-mount keys add up to one row.
   */
  readonly key: string;

  /** Samples recorded over the operation. */
  readonly count: number;

  /** Their summed duration. */
  readonly totalMs: number;
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

  /**
   * Worker scheduler runs, from the count of its `scheduler/run` timing. A run
   * that starts while another is being timed goes uncounted, so this is a
   * lower bound.
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
  /** Started just before the operation and ended at its settled boundary. */
  readonly interval?: TimedInterval;
}

/**
 * Returns where the function argument of `name`'s module-scope
 * `const <name> = lift(<function>)` declaration starts in `text`. The
 * transformer records that position for a hoisted builder, and the runtime
 * reports it as the line and column of each run's `src`. Comments between the
 * call's parenthesis and the function are skipped; type arguments on `lift`,
 * and a function passed after schema arguments, are not recognized.
 *
 * @throws If `text` holds no such declaration or more than one; `source` names
 *   the text in the message.
 */
export function liftFunctionPosition(
  text: string,
  name: string,
  source = "the source",
): SourcePosition {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`\`${name}\` is not a plain identifier`);
  }
  const trivia = String.raw`(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*`;
  const declaration = new RegExp(
    String.raw`\bconst\s+${name}\s*=\s*lift\s*\(` + trivia,
    "g",
  );
  const matches = [...text.matchAll(declaration)];
  if (matches.length !== 1) {
    throw new Error(
      `Expected one \`const ${name} = lift(...)\` declaration in ${source}, ` +
        `found ${matches.length}`,
    );
  }
  const [match] = matches;
  const lines = text.slice(0, match.index + match[0].length).split("\n");
  return { line: lines.length, col: lines[lines.length - 1].length };
}

/**
 * Reads each lift's module under `sourceRoot` and returns where the lift's
 * function starts.
 *
 * @throws If a module does not declare its lift as
 *   {@link liftFunctionPosition} requires.
 */
export async function resolveTopicsLiftSites(
  sourceRoot: string = TOPICS_SOURCE_ROOT,
  lifts: readonly TopicsLift[] = TOPICS_LIFTS,
): Promise<TopicsLiftSite[]> {
  const texts = new Map<string, string>();
  const sites: TopicsLiftSite[] = [];
  for (const lift of lifts) {
    const path = join(sourceRoot, lift.module);
    let text = texts.get(path);
    if (text === undefined) {
      text = await Deno.readTextFile(path);
      texts.set(path, text);
    }
    const { line, col } = liftFunctionPosition(text, lift.name, path);
    sites.push({ ...lift, site: `/${lift.module}:${line}:${col}` });
  }
  return sites;
}

/**
 * Runs `operation` with telemetry and body read accounting on, and returns
 * each named lift's read totals with graph size and timing. Accounting is
 * enabled just before the operation and disabled once the view has settled
 * over an idle runtime, whether or not the operation succeeds.
 *
 * @throws If a lift cannot be identified in the sources, if a running module
 *   holds actions but none at a named lift's site or runs in two versions, or
 *   if the operation completes no runs, fails an event commit, or raises a
 *   page error.
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
    let sampling: PageSampling | undefined;
    const measured = await (async () => {
      const before = await readRuntimeState(page);
      const startedAt = performance.now();
      await options.operation();
      await settleOperation(page);
      return { before, elapsedMs: performance.now() - startedAt };
    })().finally(async () => {
      sampling = await stopSampling(page, token);
    });
    const after = await readRuntimeState(page);
    const state = sampling!;

    assertNoPageErrors(options.label, pageErrors.errors);
    if (state.eventCommitErrors.length > 0) {
      throw new Error(
        `${options.label}: ${state.eventCommitErrors.length} event commit(s) ` +
          `failed: ${state.eventCommitErrors.join("; ")}`,
      );
    }
    const measuredRuns = Object.values(state.bySrc)
      .reduce((sum, totals) => sum + totals.runs, 0);
    if (measuredRuns + state.runsWithoutReads === 0) {
      throw new Error(
        `${options.label}: the measured operation produced no runs`,
      );
    }

    const running = runningSites(
      sites,
      [...measured.before.srcs, ...after.srcs, ...Object.keys(state.bySrc)],
    );
    const named = new Map(sites.map((lift) => [lift.site, emptyTotals()]));
    const remaining = emptyTotals();
    for (const [src, totals] of Object.entries(state.bySrc)) {
      addTotals(named.get(parseSrc(src)?.site ?? "") ?? remaining, totals);
    }
    return {
      label: options.label,
      readAccounting: true,
      elapsedMs: measured.elapsedMs,
      graph: { before: measured.before.graph, after: after.graph },
      timing: timingBetween(measured.before, after),
      lifts: sites.map((lift) => ({
        ...lift,
        ...named.get(lift.site)!,
        instantiated: running.has(lift.site),
      })),
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
 * Runs `operation` with telemetry and read accounting left off, and returns
 * its elapsed time, graph size, and timing. `interval`, when given, starts just
 * before the operation and ends at the same settled boundary.
 *
 * @throws If the page raises an error.
 */
export async function timeTopicsOperation(
  page: Page,
  options: TimeTopicsOperationOptions,
): Promise<TopicsTimedSample> {
  const pageErrors = watchPageErrors(page);
  try {
    const before = await readRuntimeState(page);
    const startedAt = performance.now();
    options.interval?.start();
    await options.operation();
    await settleOperation(page);
    options.interval?.end();
    const elapsedMs = performance.now() - startedAt;
    const after = await readRuntimeState(page);

    assertNoPageErrors(options.label, pageErrors.errors);
    const timing = timingBetween(before, after);
    const workerRuns = timing.worker.find((row) =>
      row.key === "scheduler/scheduler/run"
    )
      ?.count ?? 0;
    return {
      label: options.label,
      readAccounting: false,
      elapsedMs,
      graph: { before: before.graph, after: after.graph },
      timing,
      workerRuns,
      notes: [ACCOUNTING_OFF_NOTE, ATTEMPT_READS_NOTE, TIMING_NOTE],
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
    lines.push(`  ${sample.workerRuns} worker scheduler runs`);
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

/** Shell globals a sample reads, and the samplings in progress in the page. */
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

  /** Samplings in progress, by token. */
  __cfTopicsSamplings?: Record<
    string,
    { sampling: PageSampling; stop: () => void }
  >;
};

/** Graph and timing as they stand at one instant. */
interface RuntimeState {
  /** Graph size. */
  graph: GraphSize;

  /** Distinct `src` values of the graph's actions. */
  srcs: string[];

  /** Main-thread `[count, totalTime]` by `<logger>/<key>`. */
  mainTiming: Record<string, [number, number]>;

  /** Worker `[count, totalTime]` by `<logger>/<key>`. */
  workerTiming: Record<string, [number, number]>;
}

/** Requests the helper itself sends, whose timing is not the operation's. */
const HELPER_REQUESTS: ReadonlySet<string> = new Set([
  RequestType.GetGraphSnapshot,
  RequestType.GetLoggerCounts,
  RequestType.SetReadStatsEnabled,
  RequestType.SetTelemetryEnabled,
]);

/** Matches a run's `src`: the module identity, then `/<path>:<line>:<col>`. */
const SRC_PATTERN = /^cf:module\/([^/]+)(\/.+:\d+:\d+)$/;

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
 * telemetry under `token` and enables telemetry and read accounting.
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
    (scope.__cfTopicsSamplings ??= {})[token] = {
      sampling,
      stop: () => rt.off("telemetry", listener),
    };
    await rt.setTelemetryEnabled(true);
    await rt.setReadStatsEnabled(true);
  }, { args: [token] });
}

/**
 * Helper for {@link measureTopicsReads}, which disables read accounting and
 * telemetry, unsubscribes the sampling under `token`, and returns what it
 * collected.
 */
async function stopSampling(page: Page, token: string): Promise<PageSampling> {
  return await page.evaluate(async (token: string) => {
    const scope = globalThis as MeasurementGlobal;
    const entry = scope.__cfTopicsSamplings?.[token];
    const rt = scope.commonfabric?.rt;
    if (!entry || !rt) {
      throw new Error("The sampling or the runtime client it measured is gone");
    }
    await rt.setReadStatsEnabled(false);
    await rt.setTelemetryEnabled(false);
    entry.stop();
    delete scope.__cfTopicsSamplings![token];
    return entry.sampling;
  }, { args: [token] });
}

/** Helper for the samplers, which reads graph size, `src` values, and timing. */
async function readRuntimeState(page: Page): Promise<RuntimeState> {
  return await page.evaluate(async () => {
    const cf = (globalThis as MeasurementGlobal).commonfabric;
    const rt = cf?.rt;
    const mainBreakdown = cf?.getTimingStatsBreakdown;
    if (!rt || !mainBreakdown) {
      throw new Error("The shell exposes no runtime client or timing to read");
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
    const graph = await rt.getGraphSnapshot();
    const workerTiming = flatten((await rt.getLoggerCounts()).timing);
    const srcs = new Set<string>();
    for (const node of graph.nodes) {
      if (node.src !== undefined) srcs.add(node.src);
    }
    return {
      graph: { nodes: graph.nodes.length, edges: graph.edges.length },
      srcs: [...srcs],
      mainTiming: flatten(mainBreakdown()),
      workerTiming,
    };
  });
}

//
// Aggregation
//

/** Splits a run's `src` into module identity and site, if it has that form. */
function parseSrc(src: string): { identity: string; site: string } | undefined {
  const match = SRC_PATTERN.exec(src);
  return match ? { identity: match[1], site: match[2] } : undefined;
}

/**
 * Helper for {@link measureTopicsReads}, which returns the sites among `srcs`.
 * A lift's module that appears in `srcs` must run in one version and hold an
 * action at the lift's site; otherwise the sources read are not the running
 * ones, and attributing runs by position would be wrong.
 */
function runningSites(
  lifts: readonly TopicsLiftSite[],
  srcs: readonly string[],
): Set<string> {
  const running = new Set<string>();
  const identitiesByModule = new Map<string, Set<string>>();
  for (const src of srcs) {
    const parsed = parseSrc(src);
    if (parsed === undefined) continue;
    running.add(parsed.site);
    const module = parsed.site.replace(/:\d+:\d+$/, "");
    const identities = identitiesByModule.get(module) ?? new Set();
    identities.add(parsed.identity);
    identitiesByModule.set(module, identities);
  }
  for (const lift of lifts) {
    const identities = identitiesByModule.get(`/${lift.module}`);
    if (identities === undefined) continue;
    if (identities.size > 1) {
      throw new Error(
        `\`/${lift.module}\` runs as ${identities.size} module versions, so ` +
          `\`${lift.name}\` cannot be attributed by position`,
      );
    }
    if (!running.has(lift.site)) {
      throw new Error(
        `\`${lift.name}\` resolves to \`${lift.site}\`, but the running ` +
          `\`/${lift.module}\` has no action there: the sources read are not ` +
          `the ones the board runs`,
      );
    }
  }
  return running;
}

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
  const mainThread = timingDelta(before.mainTiming, after.mainTiming);
  return {
    mainThread,
    worker: timingDelta(before.workerTiming, after.workerTiming),
    vdomApply:
      mainThread.find((row) => row.key === "vdom-applicator/apply-batch") ??
        { key: "vdom-applicator/apply-batch", count: 0, totalMs: 0 },
  };
}

/**
 * Helper for {@link timingBetween}, which subtracts one thread's statistics,
 * drops the helper's own requests, and joins keys differing only in an
 * all-digit segment.
 */
function timingDelta(
  before: Record<string, [number, number]>,
  after: Record<string, [number, number]>,
): TimingRow[] {
  const rows = new Map<string, { count: number; totalMs: number }>();
  for (const [key, [count, totalTime]] of Object.entries(after)) {
    const [countBefore, totalBefore] = before[key] ?? [0, 0];
    const segments = key.split("/");
    if (count <= countBefore || HELPER_REQUESTS.has(segments.at(-1)!)) {
      continue;
    }
    const joined = segments.map((segment) =>
      /^\d+$/.test(segment) ? "*" : segment
    ).join("/");
    const row = rows.get(joined) ?? { count: 0, totalMs: 0 };
    row.count += count - countBefore;
    row.totalMs += totalTime - totalBefore;
    rows.set(joined, row);
  }
  return [...rows.entries()]
    .map(([key, row]) => ({ key, ...row }))
    .sort((a, b) => b.totalMs - a.totalMs);
}
