/**
 * RuntimeClient - Main thread controller for the worker-based Runtime
 *
 * This class manages a web worker that runs the Runtime, providing a clean API
 * for interacting with cells across the worker boundary.
 */

import type { DID, Identity } from "@commonfabric/identity";
import type {
  ActionRunTraceEntry,
  JSONSchema,
  RuntimeTelemetryMarkerResult,
  SchedulerDiagnosisResult,
  SchedulerGraphSnapshot,
  SettleStats,
  SettleStatsHistoryEntry,
  TriggerTraceEntry,
  WriteStackTraceEntry,
  WriteStackTraceMatcher,
} from "@commonfabric/runner/shared";
import { Program } from "@commonfabric/js-compiler/interface";
import { CellHandle } from "./cell-handle.ts";
import {
  type CellRef,
  ConsoleNotification,
  ErrorNotification,
  InitializationData,
  JSONValue,
  type LoggerCountsData,
  type LoggerFlagsData,
  type LoggerMetadata,
  type LoggerTimingData,
  type LogLevel,
  NavigateRequestNotification,
  type PatternSourcesResponse,
  RequestType,
  TelemetryNotification,
  type UploadBlobResponse,
} from "./protocol/mod.ts";
import { NameSchema } from "@commonfabric/runner/schemas";
import type { FabricValue } from "@commonfabric/data-model/fabric-value";
import { RuntimeTransport } from "./client/transport.ts";
import { EventEmitter } from "./client/emitter.ts";
import {
  InitializedRuntimeConnection,
  RuntimeConnection,
  type SubscriptionDiagnostics,
} from "./client/connection.ts";
import { PageHandle } from "./page-handle.ts";

export interface RuntimeClientOptions
  extends Omit<InitializationData, "apiUrl" | "identity" | "spaceIdentity"> {
  apiUrl: URL;
  identity: Identity;
  spaceIdentity?: Identity;
}

export type RuntimeClientEvents = {
  console: [ConsoleNotification];
  navigaterequest: [{ cell: CellHandle }];
  error: [ErrorNotification];
  telemetry: [RuntimeTelemetryMarkerResult];
};

export const $conn = Symbol("$request");

/**
 * RuntimeClient provides a main-thread interface to a Runtime running elsewhere.
 */
export class RuntimeClient extends EventEmitter<RuntimeClientEvents> {
  #conn: InitializedRuntimeConnection;

  private constructor(
    conn: InitializedRuntimeConnection,
    _options: RuntimeClientOptions,
  ) {
    super();
    this.#conn = conn;
    this.#conn.on("console", this._onConsole);
    this.#conn.on("navigaterequest", this._onNavigateRequest);
    this.#conn.on("error", this._onError);
    this.#conn.on("telemetry", this._onTelemetry);
  }

  /**
   * The runtime's lifetime signal. It aborts when the runtime is disposed.
   * Consumers observe it to stop work and to recognize that a disposal-raced
   * operation was cancelled rather than failed.
   */
  get signal(): AbortSignal {
    return this.#conn.signal;
  }

  static async initialize(
    transport: RuntimeTransport,
    options: RuntimeClientOptions,
  ): Promise<RuntimeClient> {
    // renderDeclassificationPolicy is a security knob: reject unknown values
    // loudly here, where the host's own config error can surface early. The
    // worker side additionally fails CLOSED (treats unknown as "deny") for
    // peers that don't go through this entry point.
    const renderPolicy = options.renderDeclassificationPolicy;
    if (
      renderPolicy !== undefined && renderPolicy !== "allow" &&
      renderPolicy !== "deny"
    ) {
      throw new Error(
        `Invalid renderDeclassificationPolicy: ${
          JSON.stringify(renderPolicy)
        } (expected "allow" or "deny")`,
      );
    }
    const initialized = await (new RuntimeConnection(transport)).initialize({
      apiUrl: options.apiUrl.toString(),
      spaceHostMap: options.spaceHostMap,
      identity: options.identity.serialize(),
      spaceIdentity: options.spaceIdentity?.serialize(),
      spaceDid: options.spaceDid,
      spaceName: options.spaceName,
      experimental: options.experimental,
      cfcEnforcementMode: options.cfcEnforcementMode,
      cfcFlowLabels: options.cfcFlowLabels,
      renderDeclassificationPolicy: options.renderDeclassificationPolicy,
      renderConfidentialityCeiling: options.renderConfidentialityCeiling,
      trustSnapshot: options.trustSnapshot,
      forwardWorkerConsole: options.forwardWorkerConsole,
    });
    return new RuntimeClient(initialized, options);
  }

  getCellFromRef<T>(
    ref: CellRef,
  ): CellHandle<T> {
    return new CellHandle<T>(this, ref);
  }

  // TODO(unused)
  // Currently unused in shell, but a PieceManager-like layer
  // could be built using this
  async getCell<T>(
    space: DID,
    cause: FabricValue,
    schema?: JSONSchema,
  ): Promise<CellHandle<T>> {
    const response = await this.#conn.request<RequestType.GetCell>({
      type: RequestType.GetCell,
      space,
      cause,
      schema,
    });

    return new CellHandle<T>(this, response.cell);
  }

  async getHomeSpaceCell(): Promise<CellHandle<unknown>> {
    const response = await this.#conn.request<RequestType.GetHomeSpaceCell>({
      type: RequestType.GetHomeSpaceCell,
    });
    return new CellHandle(this, response.cell);
  }

  /**
   * Ensure the home space's default pattern is running and return a CellHandle to it.
   * This starts the pattern if needed and waits for it to be ready.
   */
  async ensureHomePatternRunning(): Promise<CellHandle<unknown>> {
    const response = await this.#conn.request<
      RequestType.EnsureHomePatternRunning
    >({
      type: RequestType.EnsureHomePatternRunning,
    });
    return new CellHandle(this, response.cell);
  }

  // TODO(unused)
  async idle(): Promise<void> {
    await this.#conn.request<RequestType.Idle>({ type: RequestType.Idle });
  }

  /**
   * Await all in-flight compile-cache write-backs in the worker. Distinct from
   * `idle()` (reactive/scheduler quiescence): this guarantees persistence
   * durability, so a subsequent load of an already-compiled pattern reads the
   * cached entry instead of recompiling in-client.
   */
  async flushCompileCacheWrites(): Promise<void> {
    await this.#conn.request<RequestType.FlushCompileCacheWrites>({
      type: RequestType.FlushCompileCacheWrites,
    });
  }

  async createPage<T = unknown>(
    input: string | URL | Program,
    space: DID,
    options?: { argument?: JSONValue; run?: boolean },
  ): Promise<PageHandle<T>> {
    const source = input instanceof URL
      ? { url: input.href }
      : typeof input === "string"
      ? {
        program: {
          main: "/main.tsx",
          files: [{
            name: "/main.tsx",
            contents: input,
          }],
        },
      }
      : { program: input };

    const response = await this.#conn.request<
      RequestType.PageCreate
    >({
      type: RequestType.PageCreate,
      space,
      source,
      argument: options?.argument,
      run: options?.run,
    });

    return new PageHandle<T>(this, response.page);
  }

  // Page operations name their space explicitly — there is no
  // implicit/default space at this layer. The worker resolves each
  // operation against that space's piece context over the same
  // connection.

  async getSpaceRootPattern(space: DID): Promise<PageHandle<NameSchema>> {
    const response = await this.#conn.request<
      RequestType.GetSpaceRootPattern
    >({
      type: RequestType.GetSpaceRootPattern,
      space,
    });
    return new PageHandle<NameSchema>(this, response.page);
  }

  async recreateSpaceRootPattern(
    space: DID,
  ): Promise<PageHandle<NameSchema>> {
    const response = await this.#conn.request<
      RequestType.RecreateSpaceRootPattern
    >({
      type: RequestType.RecreateSpaceRootPattern,
      space,
    });
    return new PageHandle<NameSchema>(this, response.page);
  }

  async getPage<T = unknown>(
    pageId: string,
    space: DID,
    runIt?: boolean,
  ): Promise<PageHandle<T> | null> {
    const response = await this.#conn.request<RequestType.PageGet>({
      type: RequestType.PageGet,
      pageId: pageId,
      runIt,
      space,
    });

    if (!response) return null;

    return new PageHandle<T>(this, response.page);
  }

  async getPageSlug(pageId: string, space: DID): Promise<string | undefined> {
    const response = await this.#conn.request<RequestType.PageGetSlug>({
      type: RequestType.PageGetSlug,
      pageId,
      space,
    });
    return response.slug;
  }

  async removePage(pageId: string, space: DID): Promise<boolean> {
    const res = await this.#conn.request<RequestType.PageRemove>({
      type: RequestType.PageRemove,
      pageId: pageId,
      space,
    });
    return res.value;
  }

  /**
   * Get the pieces list cell.
   * Subscribe to this cell to get reactive updates of all pieces in the space.
   */
  async getPiecesListCell<T>(space: DID): Promise<CellHandle<T[]>> {
    const response = await this.#conn.request<RequestType.PageGetAll>({
      type: RequestType.PageGetAll,
      space,
    });

    return new CellHandle<T[]>(this, response.cell);
  }

  /**
   * Wait for the PieceManager to be synced with storage.
   *
   * Note: storage sync is connection-wide, so this awaits all open
   * spaces; `space` only selects which space's piece context (and its
   * space-cell sync) to await — and lazily opens that context if this
   * is the first operation to touch the space.
   */
  async synced(space: DID): Promise<void> {
    await this.#conn.request<RequestType.PageSynced>({
      type: RequestType.PageSynced,
      space,
    });
  }

  /**
   * Record a runtime-learned host hint for a space (site-table v0):
   * makes a just-learned `space → host` fact effective on the live
   * runtime. The durable record belongs in the home-space site table;
   * this is the immediate, in-session half. Returns whether the hint
   * is in effect (seed wins; an opened space is never re-pointed).
   */
  async registerSpaceHost(space: DID, host: string): Promise<boolean> {
    const res = await this.#conn.request<RequestType.RegisterSpaceHost>({
      type: RequestType.RegisterSpaceHost,
      space,
      host,
    });
    return res.value;
  }

  /**
   * Wait for convergence across EVERY space this worker has opened.
   * Spaceless by design (like idle) — for quiescence checks that don't
   * care about any particular space, e.g. test/debug harnesses.
   */
  async allSynced(): Promise<void> {
    await this.#conn.request<RequestType.RuntimeSynced>({
      type: RequestType.RuntimeSynced,
    });
  }

  async getGraphSnapshot(): Promise<SchedulerGraphSnapshot> {
    const res = await this.#conn.request<RequestType.GetGraphSnapshot>({
      type: RequestType.GetGraphSnapshot,
    });
    return res.snapshot;
  }

  getSubscriptionDiagnostics(): SubscriptionDiagnostics {
    return this.#conn.getSubscriptionDiagnostics();
  }

  resetSubscriptionDiagnostics(): void {
    this.#conn.resetSubscriptionDiagnostics();
  }

  async getLoggerCounts(): Promise<{
    counts: LoggerCountsData;
    metadata: LoggerMetadata;
    timing: LoggerTimingData;
    flags: LoggerFlagsData;
  }> {
    const res = await this.#conn.request<RequestType.GetLoggerCounts>({
      type: RequestType.GetLoggerCounts,
    });
    return {
      counts: res.counts,
      metadata: res.metadata,
      timing: res.timing,
      flags: res.flags,
    };
  }

  /**
   * Set log level for a logger in the worker.
   * @param level - The log level to set
   * @param loggerName - Optional logger name. If not provided, sets level for all loggers.
   */
  async setLoggerLevel(level: LogLevel, loggerName?: string): Promise<void> {
    await this.#conn.request<RequestType.SetLoggerLevel>({
      type: RequestType.SetLoggerLevel,
      level,
      loggerName,
    });
  }

  /**
   * Enable or disable a logger in the worker.
   * @param enabled - Whether to enable or disable the logger
   * @param loggerName - Optional logger name. If not provided, sets enabled for all loggers.
   */
  async setLoggerEnabled(enabled: boolean, loggerName?: string): Promise<void> {
    await this.#conn.request<RequestType.SetLoggerEnabled>({
      type: RequestType.SetLoggerEnabled,
      enabled,
      loggerName,
    });
  }

  /**
   * Enable or disable telemetry data emission from the worker.
   * When disabled, telemetry events will not be sent over IPC.
   * @param enabled - Whether to enable or disable telemetry
   */
  async setTelemetryEnabled(enabled: boolean): Promise<void> {
    await this.#conn.request<RequestType.SetTelemetryEnabled>({
      type: RequestType.SetTelemetryEnabled,
      enabled,
    });
  }

  /**
   * Enable or disable forwarding of the worker runtime's console output to the
   * main thread for the running worker. Takes effect immediately, without a
   * reload. When disabled the worker restores its native console methods, so
   * there is no per-log cost while off.
   */
  async setForwardWorkerConsole(enabled: boolean): Promise<void> {
    await this.#conn.request<RequestType.SetForwardWorkerConsole>({
      type: RequestType.SetForwardWorkerConsole,
      enabled,
    });
  }

  /**
   * Reset logger baselines for both counts and timing in the worker.
   * After calling this, loggers will track deltas from this baseline.
   */
  async resetLoggerBaselines(): Promise<void> {
    await this.#conn.request<RequestType.ResetLoggerBaselines>({
      type: RequestType.ResetLoggerBaselines,
    });
  }

  /**
   * Enable or disable collection of settle stats in the worker scheduler.
   * When disabled, the last captured settle stats are cleared.
   */
  async setSettleStatsEnabled(enabled: boolean): Promise<void> {
    await this.#conn.request<RequestType.SetSettleStatsEnabled>({
      type: RequestType.SetSettleStatsEnabled,
      enabled,
    });
  }

  /**
   * Return settle stats captured during the last worker scheduler execute() call.
   * Returns null if settle stats are disabled or no execute() has been captured yet.
   */
  async getSettleStats(): Promise<SettleStats | null> {
    const res = await this.#conn.request<RequestType.GetSettleStats>({
      type: RequestType.GetSettleStats,
    });
    return res.stats;
  }

  /**
   * Return recent settle stats history captured from worker execute() calls.
   * Entries are ordered oldest first.
   */
  async getSettleStatsHistory(): Promise<SettleStatsHistoryEntry[]> {
    const res = await this.#conn.request<RequestType.GetSettleStatsHistory>({
      type: RequestType.GetSettleStatsHistory,
    });
    return res.history;
  }

  /**
   * Return recent exact action-run history captured from worker scheduler runs.
   * Entries are ordered oldest first.
   */
  async getActionRunTrace(): Promise<ActionRunTraceEntry[]> {
    const res = await this.#conn.request<RequestType.GetActionRunTrace>({
      type: RequestType.GetActionRunTrace,
    });
    return res.trace;
  }

  /**
   * Enable or disable collection of exact action-run history in the worker scheduler.
   * When disabled, the current action-run history buffer is cleared.
   */
  async setActionRunTraceEnabled(enabled: boolean): Promise<void> {
    await this.#conn.request<RequestType.SetActionRunTraceEnabled>({
      type: RequestType.SetActionRunTraceEnabled,
      enabled,
    });
  }

  /**
   * Enable or disable collection of structured trigger-trace entries in the worker scheduler.
   * When disabled, the current trigger trace buffer is cleared.
   */
  async setTriggerTraceEnabled(enabled: boolean): Promise<void> {
    await this.#conn.request<RequestType.SetTriggerTraceEnabled>({
      type: RequestType.SetTriggerTraceEnabled,
      enabled,
    });
  }

  /**
   * Return recent structured trigger-trace entries captured from worker storage changes.
   * Entries are ordered oldest first.
   */
  async getTriggerTrace(): Promise<TriggerTraceEntry[]> {
    const res = await this.#conn.request<RequestType.GetTriggerTrace>({
      type: RequestType.GetTriggerTrace,
    });
    return res.trace;
  }

  /**
   * Configure transaction-level write stack tracing in the worker.
   * Passing an empty matcher list disables the probe and clears prior entries.
   */
  async setWriteStackTraceMatchers(
    matchers: WriteStackTraceMatcher[],
  ): Promise<void> {
    await this.#conn.request<RequestType.SetWriteStackTraceMatchers>({
      type: RequestType.SetWriteStackTraceMatchers,
      matchers,
    });
  }

  /**
   * Return recent transaction-level write stack trace entries from the worker.
   * Entries are ordered oldest first.
   */
  async getWriteStackTrace(): Promise<WriteStackTraceEntry[]> {
    const res = await this.#conn.request<RequestType.GetWriteStackTrace>({
      type: RequestType.GetWriteStackTrace,
    });
    return res.trace;
  }

  /**
   * Run non-idempotent computation detection.
   * Returns a report of non-idempotent actions found.
   */
  async getPatternSources(): Promise<PatternSourcesResponse> {
    return await this.#conn.request<RequestType.GetPatternSources>({
      type: RequestType.GetPatternSources,
    });
  }

  async setBreakpoints(actionIds: string[]): Promise<void> {
    await this.#conn.request<RequestType.SetBreakpoints>({
      type: RequestType.SetBreakpoints,
      actionIds,
    });
  }

  async uploadBlob(options: {
    space: DID;
    contentType: string;
    body: Uint8Array;
    suffix?: string;
  }): Promise<UploadBlobResponse> {
    return await this.#conn.request<RequestType.UploadBlob>({
      type: RequestType.UploadBlob,
      space: options.space,
      contentType: options.contentType,
      body: Array.from(options.body),
      suffix: options.suffix,
    });
  }

  async detectNonIdempotent(
    durationMs?: number,
  ): Promise<SchedulerDiagnosisResult> {
    const res = await this.#conn.request<RequestType.DetectNonIdempotent>({
      type: RequestType.DetectNonIdempotent,
      durationMs,
    });
    return res.result;
  }

  async dispose(): Promise<void> {
    await this.#conn.dispose();
  }

  async [Symbol.asyncDispose]() {
    await this.dispose();
  }

  [$conn](): InitializedRuntimeConnection {
    return this.#conn;
  }

  private _onConsole = (data: ConsoleNotification): void => {
    this.emit("console", data);
  };

  private _onNavigateRequest = (data: NavigateRequestNotification): void => {
    this.emit("navigaterequest", {
      cell: new CellHandle(this, data.targetCellRef),
    });
  };

  private _onError = (data: ErrorNotification): void => {
    this.emit("error", data);
  };

  private _onTelemetry = (data: TelemetryNotification): void => {
    this.emit("telemetry", data.marker);
  };
}
