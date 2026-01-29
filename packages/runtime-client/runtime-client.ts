/**
 * RuntimeClient - Main thread controller for the worker-based Runtime
 *
 * This class manages a web worker that runs the Runtime, providing a clean API
 * for interacting with cells across the worker boundary.
 */

import type { DID, Identity } from "@commontools/identity";
import type {
  JSONSchema,
  RuntimeTelemetryMarkerResult,
  SchedulerGraphSnapshot,
} from "@commontools/runner/shared";
import { Program } from "@commontools/js-compiler/interface";
import { CellHandle } from "./cell-handle.ts";
import {
  type CellRef,
  ConsoleNotification,
  ErrorNotification,
  InitializationData,
  JSONValue,
  type LoggerCountsData,
  type LoggerMetadata,
  type LoggerTimingData,
  type LogLevel,
  NavigateRequestNotification,
  RequestType,
  TelemetryNotification,
} from "./protocol/mod.ts";
import { NameSchema } from "@commontools/runner/schemas";
import { RuntimeTransport } from "./client/transport.ts";
import { EventEmitter } from "./client/emitter.ts";
import {
  InitializedRuntimeConnection,
  RuntimeConnection,
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

  static async initialize(
    transport: RuntimeTransport,
    options: RuntimeClientOptions,
  ): Promise<RuntimeClient> {
    const initialized = await (new RuntimeConnection(transport)).initialize({
      apiUrl: options.apiUrl.toString(),
      identity: options.identity.serialize(),
      spaceIdentity: options.spaceIdentity?.serialize(),
      spaceDid: options.spaceDid,
      spaceName: options.spaceName,
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
    cause: JSONValue,
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

  async createPage<T = unknown>(
    input: string | URL | Program,
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
      source,
      argument: options?.argument,
      run: options?.run,
    });

    return new PageHandle<T>(this, response.page);
  }

  async getSpaceRootPattern(): Promise<PageHandle<NameSchema>> {
    const response = await this.#conn.request<
      RequestType.GetSpaceRootPattern
    >({
      type: RequestType.GetSpaceRootPattern,
    });
    return new PageHandle<NameSchema>(this, response.page);
  }

  async recreateSpaceRootPattern(): Promise<PageHandle<NameSchema>> {
    const response = await this.#conn.request<
      RequestType.RecreateSpaceRootPattern
    >({
      type: RequestType.RecreateSpaceRootPattern,
    });
    return new PageHandle<NameSchema>(this, response.page);
  }

  async getPage<T = unknown>(
    pageId: string,
    runIt?: boolean,
  ): Promise<PageHandle<T> | null> {
    const response = await this.#conn.request<RequestType.PageGet>({
      type: RequestType.PageGet,
      pageId: pageId,
      runIt,
    });

    if (!response) return null;

    return new PageHandle<T>(this, response.page);
  }

  async removePage(pageId: string): Promise<boolean> {
    const res = await this.#conn.request<RequestType.PageRemove>({
      type: RequestType.PageRemove,
      pageId: pageId,
    });
    return res.value;
  }

  /**
   * Get the pieces list cell.
   * Subscribe to this cell to get reactive updates of all pieces in the space.
   */
  async getPiecesListCell<T>(): Promise<CellHandle<T[]>> {
    const response = await this.#conn.request<RequestType.PageGetAll>({
      type: RequestType.PageGetAll,
    });

    return new CellHandle<T[]>(this, response.cell);
  }

  /**
   * Wait for the PieceManager to be synced with storage.
   */
  async synced(): Promise<void> {
    await this.#conn.request<RequestType.PageSynced>({
      type: RequestType.PageSynced,
    });
  }

  async getGraphSnapshot(): Promise<SchedulerGraphSnapshot> {
    const res = await this.#conn.request<RequestType.GetGraphSnapshot>({
      type: RequestType.GetGraphSnapshot,
    });
    return res.snapshot;
  }

  async setPullMode(pullMode: boolean): Promise<void> {
    await this.#conn.request<RequestType.SetPullMode>({
      type: RequestType.SetPullMode,
      pullMode,
    });
  }

  async getLoggerCounts(): Promise<{
    counts: LoggerCountsData;
    metadata: LoggerMetadata;
    timing: LoggerTimingData;
  }> {
    const res = await this.#conn.request<RequestType.GetLoggerCounts>({
      type: RequestType.GetLoggerCounts,
    });
    return { counts: res.counts, metadata: res.metadata, timing: res.timing };
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
   * Reset logger baselines for both counts and timing in the worker.
   * After calling this, loggers will track deltas from this baseline.
   */
  async resetLoggerBaselines(): Promise<void> {
    await this.#conn.request<RequestType.ResetLoggerBaselines>({
      type: RequestType.ResetLoggerBaselines,
    });
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
