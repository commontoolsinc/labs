import { DID, Identity, type Session } from "@commontools/identity";
import { CharmManager } from "@commontools/charm";
import { CharmsController } from "@commontools/charm/ops";
import {
  getLoggerCountsBreakdown,
  getTimingStatsBreakdown,
  Logger,
  resetAllCountBaselines,
  resetAllTimingBaselines,
} from "@commontools/utils/logger";
import {
  type Cancel,
  convertCellsToLinks,
  Runtime,
  RuntimeTelemetry,
  RuntimeTelemetryEvent,
  setRecipeEnvironment,
} from "@commontools/runner";
import { NameSchema, nameSchema } from "@commontools/runner/schemas";
import { StorageManager } from "../../runner/src/storage/cache.ts";
import {
  type NormalizedFullLink,
  parseLink,
} from "../../runner/src/link-utils.ts";
import {
  BooleanResponse,
  type CellGetRequest,
  type CellResolveAsCellRequest,
  CellResponse,
  type CellSendRequest,
  type CellSetRequest,
  type CellSubscribeRequest,
  type CellUnsubscribeRequest,
  type EnsureHomePatternRunningRequest,
  type GetCellRequest,
  GetGraphSnapshotRequest,
  type GetHomeSpaceCellRequest,
  type GetLoggerCountsRequest,
  GraphSnapshotResponse,
  type InitializationData,
  IPCClientRequest,
  JSONValueResponse,
  type LoggerCountsResponse,
  type LoggerMetadata,
  type LogLevel,
  NotificationType,
  type PageCreateRequest,
  type PageGetRequest,
  PageGetSpaceDefault as PatternGetSpaceRoot,
  type PageRemoveRequest,
  PageResponse,
  type PageStartRequest,
  type PageStopRequest,
  type RecreateSpaceRootPatternRequest,
  RequestType,
  type SetLoggerEnabledRequest,
  type SetLoggerLevelRequest,
  type SetPullModeRequest,
  type SetTelemetryEnabledRequest,
  type VDomEventRequest,
  type VDomMountRequest,
  type VDomMountResponse,
  type VDomUnmountRequest,
} from "../protocol/mod.ts";
import { HttpProgramResolver, Program } from "@commontools/js-compiler";
import { setLLMUrl } from "@commontools/llm";
import {
  createCellRef,
  createPageRef,
  getCell,
  mapCellRefsToSigilLinks,
} from "./utils.ts";
import { cellRefToKey } from "../shared/utils.ts";
import { RemoteResponse } from "@commontools/runtime-client";
import { WorkerReconciler } from "@commontools/html/worker";
import type { VDomOp } from "../vdom-worker/operations.ts";

export class RuntimeProcessor {
  private runtime: Runtime;
  private charmManager: CharmManager;
  private cc: CharmsController;
  private space: DID;
  private identity: Identity;
  private _isDisposed = false;
  private disposingPromise: Promise<void> | undefined;
  private subscriptions = new Map<string, Cancel>();
  private telemetry: RuntimeTelemetry;
  #telemetryEnabled = false;

  // VDOM event handlers registered by WorkerReconciler instances
  private vdomHandlers = new Map<number, (event: unknown) => void>();
  private nextVDomHandlerId = 1;

  // VDOM mounts: mountId -> { reconciler, cancel }
  private vdomMounts = new Map<
    number,
    { reconciler: WorkerReconciler; cancel: Cancel }
  >();
  private vdomBatchIdCounter = 0;

  private constructor(
    runtime: Runtime,
    charmManager: CharmManager,
    cc: CharmsController,
    space: DID,
    identity: Identity,
    telemetry: RuntimeTelemetry,
  ) {
    this.runtime = runtime;
    this.charmManager = charmManager;
    this.cc = cc;
    this.space = space;
    this.identity = identity;
    this.telemetry = telemetry;
    this.telemetry.addEventListener("telemetry", this.#onTelemetry);
  }

  static async initialize(data: InitializationData): Promise<RuntimeProcessor> {
    const apiUrlObj = new URL(data.apiUrl);
    const identity = await Identity.deserialize(data.identity);
    const spaceIdentity = data.spaceIdentity
      ? await Identity.deserialize(data.spaceIdentity)
      : undefined;
    const space = data.spaceDid;
    const telemetry = new RuntimeTelemetry();

    setLLMUrl(data.apiUrl);
    setRecipeEnvironment({ apiUrl: apiUrlObj });

    const session = {
      spaceIdentity,
      as: identity,
      space: data.spaceDid,
      spaceName: data.spaceName,
    };

    const storageManager = StorageManager.open({
      as: identity,
      spaceIdentity: spaceIdentity,
      address: new URL("/api/storage/memory", data.apiUrl),
    });

    let charmManager: CharmManager | undefined = undefined;
    const runtime = new Runtime({
      apiUrl: apiUrlObj,
      storageManager,
      recipeEnvironment: { apiUrl: apiUrlObj },
      telemetry,
      consoleHandler: ({ metadata, method, args }) => {
        self.postMessage({
          type: NotificationType.ConsoleMessage,
          metadata,
          method,
          args,
        });
        return args;
      },

      navigateCallback: (target) => {
        const link = parseLink(target.getAsLink()) as NormalizedFullLink;
        // Add to the space's charm list here if it's from the
        // same space.
        if (link.space !== space) {
          console.warn("Navigating cross-space, not adding to charms list.");
        } else {
          charmManager!.add([target]);

          // Track as recently used (async, fire-and-forget)
          RuntimeProcessor.trackRecentCharm(charmManager!, target).catch(
            (e: unknown) => {
              console.error(
                "[RuntimeProcessor] Failed to track recent charm:",
                {
                  error: e instanceof Error ? e.message : e,
                },
              );
            },
          );
        }

        self.postMessage({
          type: NotificationType.NavigateRequest,
          targetCellRef: link,
        });
      },

      errorHandlers: [
        (error) => {
          self.postMessage({
            type: NotificationType.ErrorReport,
            message: error.message,
            pageId: error.charmId,
            space: error.space,
            recipeId: error.recipeId,
            spellId: error.spellId,
            stackTrace: error.stack,
          });
        },
      ],
    });

    if (!await runtime.healthCheck()) {
      throw new Error(`Could not connect to "${data.apiUrl}"`);
    }

    charmManager = new CharmManager(session, runtime);
    await charmManager.synced();
    const cc = new CharmsController(charmManager);

    return new RuntimeProcessor(
      runtime,
      charmManager,
      cc,
      space,
      identity,
      telemetry,
    );
  }

  dispose(): Promise<void> {
    if (this.disposingPromise) return this.disposingPromise;
    this._isDisposed = true;
    this.disposingPromise = (async () => {
      this.telemetry.removeEventListener("telemetry", this.#onTelemetry);
      try {
        for (const cancel of this.subscriptions.values()) {
          cancel();
        }
        this.subscriptions.clear();
        await this.runtime.storageManager.synced();
        await this.runtime.dispose();
      } catch (e) {
        console.error(`Failure during WorkerRuntime disposal: ${e}`);
      }
    })();
    return this.disposingPromise;
  }

  isDisposed(): boolean {
    return this._isDisposed;
  }

  handleCellGet(
    request: CellGetRequest,
  ): JSONValueResponse {
    const cell = getCell(this.runtime, request.cell);
    const value = cell.get();
    const converted = convertCellsToLinks(value, {
      includeSchema: true,
      keepAsCell: true,
      doNotConvertCellResults: true,
    });
    return { value: converted };
  }

  handleCellSet(request: CellSetRequest): void {
    const tx = this.runtime.edit();
    const cell = getCell(this.runtime, request.cell);
    const value = mapCellRefsToSigilLinks(request.value);
    cell.withTx(tx).set(value);
    tx.commit();
  }

  handleCellSend(request: CellSendRequest): void {
    const tx = this.runtime.edit();
    const cell = getCell(this.runtime, request.cell);
    cell.withTx(tx).send(mapCellRefsToSigilLinks(request.event));
    tx.commit();
  }

  handleCellSubscribe(request: CellSubscribeRequest): BooleanResponse {
    const key = cellRefToKey(request.cell);

    if (this.subscriptions.has(key)) {
      return { value: false };
    }

    const cell = getCell(this.runtime, request.cell);

    const cancel = cell.sink((value) => {
      const converted = convertCellsToLinks(value, {
        includeSchema: true,
        keepAsCell: true,
        doNotConvertCellResults: true,
      });

      // `.sink` fires synchronously on invocation. Trigger the notification
      // in a microtask so that the subscription response returns
      // before a notification fires.
      queueMicrotask(() =>
        self.postMessage({
          type: NotificationType.CellUpdate,
          cell: request.cell,
          value: converted,
        })
      );
    });

    this.subscriptions.set(key, cancel);
    return { value: true };
  }

  handleCellUnsubscribe(request: CellUnsubscribeRequest): BooleanResponse {
    const key = cellRefToKey(request.cell);
    const cancel = this.subscriptions.get(key);
    if (cancel) {
      cancel();
      this.subscriptions.delete(key);
      return { value: true };
    }
    return { value: false };
  }

  handleCellResolveAsCell(request: CellResolveAsCellRequest): CellResponse {
    const cell = getCell(this.runtime, request.cell);
    const resolved = cell.resolveAsCell();
    return {
      cell: createCellRef(resolved),
    };
  }

  handleGetCell(request: GetCellRequest): CellResponse {
    const cell = this.runtime.getCell(
      request.space,
      request.cause,
      request.schema,
    );

    return {
      cell: createCellRef(cell, request.schema),
    };
  }

  handleGetHomeSpaceCell(_request: GetHomeSpaceCellRequest): CellResponse {
    const homeSpaceCell = this.runtime.getHomeSpaceCell();
    return {
      cell: createCellRef(homeSpaceCell),
    };
  }

  /**
   * Ensure the home space's default pattern is running and return a CellRef to it.
   * This is needed for favorites operations which require the pattern to be active.
   * Creates the home pattern if it doesn't exist yet.
   */
  async handleEnsureHomePatternRunning(
    _request: EnsureHomePatternRunningRequest,
  ): Promise<CellResponse> {
    const homeSpaceCell = this.runtime.getHomeSpaceCell();
    await homeSpaceCell.sync();

    const defaultPatternCell = homeSpaceCell.key("defaultPattern").get()
      .resolveAsCell();
    await defaultPatternCell.sync();

    // Fast path: pattern already exists
    // (Value is a Cell itself, and source cell means it's instantiated)
    if (defaultPatternCell.getSourceCell()) {
      await this.runtime.start(defaultPatternCell);
      await this.runtime.idle();
      return {
        cell: createCellRef(defaultPatternCell),
      };
    }

    // Pattern doesn't exist - create it via home space CharmController
    const homeSession: Session = {
      as: this.identity,
      space: this.runtime.userIdentityDID,
    };
    const homeManager = new CharmManager(homeSession, this.runtime);
    await homeManager.synced();
    const homeCC = new CharmsController(homeManager);

    const homePattern = await homeCC.ensureDefaultPattern();

    return {
      cell: createCellRef(homePattern.getCell()),
    };
  }

  async handleIdle(): Promise<void> {
    await this.runtime.idle();
  }

  async handleCharmCreate(
    request: PageCreateRequest,
  ): Promise<PageResponse> {
    let program: Program | undefined;
    if ("url" in request.source && request.source.url) {
      program = await this.cc.manager().runtime.harness.resolve(
        new HttpProgramResolver(request.source.url),
      );
    } else if ("program" in request.source) {
      program = request.source.program;
    } else {
      throw new Error("Invalid source.");
    }

    const charm = await this.cc.create<NameSchema>(program, {
      input: request.argument as object | undefined,
      start: request.run ?? true,
    }, request.cause);
    return {
      page: createPageRef(charm.getCell()),
    };
  }

  async handleGetSpaceRootPattern(
    _: PatternGetSpaceRoot,
  ): Promise<PageResponse> {
    const charm = await this.cc.ensureDefaultPattern();
    return {
      page: createPageRef(charm.getCell()),
    };
  }

  async handleRecreateSpaceRootPattern(
    _: RecreateSpaceRootPatternRequest,
  ): Promise<PageResponse> {
    const charm = await this.cc.recreateDefaultPattern();
    return {
      page: createPageRef(charm.getCell()),
    };
  }

  // TODO(runtime-worker-refactor): Can this fail? What if the cell
  // is not a page cell?
  handlePageGet(
    request: PageGetRequest,
  ): PageResponse {
    let cell = this.runtime.getCellFromEntityId(this.space, {
      "/": request.pageId,
    });
    cell = cell.asSchema(nameSchema);

    if (request.runIt) {
      this.runtime.start(cell).catch(console.error);
    }

    return {
      page: createPageRef(cell),
    };
  }

  async handlePageRemove(
    request: PageRemoveRequest,
  ): Promise<BooleanResponse> {
    return { value: await this.cc.remove(request.pageId) };
  }

  async handlePageStart(
    request: PageStartRequest,
  ): Promise<BooleanResponse> {
    await this.cc.start(request.pageId);
    // @TODO(runtime-worker-refactor): Return status based on if
    // pattern was actually found and stopped
    return { value: true };
  }

  async handlePageStop(
    request: PageStopRequest,
  ): Promise<BooleanResponse> {
    await this.cc.stop(request.pageId);
    // @TODO(runtime-worker-refactor): Return status based on if
    // pattern was actually found and stopped
    return { value: true };
  }

  async handlePageGetAll(): Promise<CellResponse> {
    const charmsCell = await this.charmManager.getCharms();
    return {
      cell: createCellRef(charmsCell),
    };
  }

  async handlePageSynced(): Promise<void> {
    await this.charmManager.synced();
  }

  getGraphSnapshot(_: GetGraphSnapshotRequest): GraphSnapshotResponse {
    return { snapshot: this.runtime.scheduler.getGraphSnapshot() };
  }

  setPullMode(request: SetPullModeRequest): void {
    if (request.pullMode) {
      this.runtime.scheduler.enablePullMode();
    } else {
      this.runtime.scheduler.disablePullMode();
    }
  }

  getLoggerCounts(_: GetLoggerCountsRequest): LoggerCountsResponse {
    const counts = getLoggerCountsBreakdown();
    const metadata = this.#getLoggerMetadata();
    const timing = getTimingStatsBreakdown();
    return { counts, metadata, timing };
  }

  #getLoggerMetadata(): LoggerMetadata {
    const global = globalThis as unknown as {
      commontools?: { logger?: Record<string, Logger> };
    };
    const result: LoggerMetadata = {};
    if (global.commontools?.logger) {
      for (const [name, logger] of Object.entries(global.commontools.logger)) {
        result[name] = {
          enabled: !logger.disabled,
          level: (logger.level ?? "info") as LogLevel,
        };
      }
    }
    return result;
  }

  setLoggerLevel(request: SetLoggerLevelRequest): void {
    const loggers = this.#getLoggers(request.loggerName);
    for (const logger of loggers) {
      logger.level = request.level;
    }
  }

  setLoggerEnabled(request: SetLoggerEnabledRequest): void {
    const loggers = this.#getLoggers(request.loggerName);
    for (const logger of loggers) {
      logger.disabled = !request.enabled;
    }
  }

  setTelemetryEnabled(request: SetTelemetryEnabledRequest): void {
    this.#telemetryEnabled = request.enabled;
  }

  resetLoggerBaselines(_: any): void {
    resetAllCountBaselines();
    resetAllTimingBaselines();
  }

  #getLoggers(loggerName?: string): Logger[] {
    const global = globalThis as unknown as {
      commontools?: { logger?: Record<string, Logger> };
    };
    if (!global.commontools?.logger) {
      return [];
    }
    if (loggerName) {
      const logger = global.commontools.logger[loggerName];
      return logger ? [logger] : [];
    }
    return Object.values(global.commontools.logger);
  }

  #onTelemetry = (event: Event) => {
    if (!this.#telemetryEnabled) return;
    const marker = (event as RuntimeTelemetryEvent).marker;
    self.postMessage({
      type: NotificationType.Telemetry,
      marker,
    });
  };

  private static async trackRecentCharm(
    charmManager: CharmManager,
    target: unknown,
  ): Promise<void> {
    const defaultPattern = await charmManager.getDefaultPattern();
    if (!defaultPattern) return;

    const cell = defaultPattern.asSchema({
      type: "object",
      properties: {
        trackRecent: { asStream: true },
      },
      required: ["trackRecent"],
    });
    const handler = cell.key("trackRecent");
    handler.send({ charm: target });
  }

  async handleRequest(
    request: IPCClientRequest,
  ): Promise<RemoteResponse | void> {
    switch (request.type) {
      case RequestType.Dispose:
        return await this.dispose();
      case RequestType.CellGet:
        return this.handleCellGet(request);
      case RequestType.CellSet:
        return this.handleCellSet(request);
      case RequestType.CellSend:
        return this.handleCellSend(request);
      case RequestType.CellSubscribe:
        return this.handleCellSubscribe(request);
      case RequestType.CellUnsubscribe:
        return this.handleCellUnsubscribe(request);
      case RequestType.CellResolveAsCell:
        return this.handleCellResolveAsCell(request);
      case RequestType.GetCell:
        return this.handleGetCell(request);
      case RequestType.GetHomeSpaceCell:
        return this.handleGetHomeSpaceCell(request);
      case RequestType.EnsureHomePatternRunning:
        return await this.handleEnsureHomePatternRunning(request);
      case RequestType.Idle:
        return await this.handleIdle();
      case RequestType.PageCreate:
        return await this.handleCharmCreate(
          request,
        );
      case RequestType.GetSpaceRootPattern:
        return await this.handleGetSpaceRootPattern(
          request,
        );
      case RequestType.RecreateSpaceRootPattern:
        return await this.handleRecreateSpaceRootPattern(
          request,
        );
      case RequestType.PageGet:
        return this.handlePageGet(request);
      case RequestType.PageRemove:
        return await this.handlePageRemove(request);
      case RequestType.PageStart:
        return await this.handlePageStart(request);
      case RequestType.PageStop:
        return await this.handlePageStop(request);
      case RequestType.PageGetAll:
        return await this.handlePageGetAll();
      case RequestType.PageSynced:
        return await this.handlePageSynced();
      case RequestType.GetGraphSnapshot:
        return this.getGraphSnapshot(request);
      case RequestType.SetPullMode:
        return this.setPullMode(request);
      case RequestType.GetLoggerCounts:
        return this.getLoggerCounts(request);
      case RequestType.SetLoggerLevel:
        return this.setLoggerLevel(request);
      case RequestType.SetLoggerEnabled:
        return this.setLoggerEnabled(request);
      case RequestType.SetTelemetryEnabled:
        return this.setTelemetryEnabled(request);
      case RequestType.ResetLoggerBaselines:
        return this.resetLoggerBaselines(request);
      case RequestType.VDomEvent:
        return this.handleVDomEvent(request);
      case RequestType.VDomMount:
        return this.handleVDomMount(request);
      case RequestType.VDomUnmount:
        return this.handleVDomUnmount(request);
      default:
        throw new Error(`Unknown message type: ${(request as any).type}`);
    }
  }

  /**
   * Handle a DOM event dispatched from the main thread.
   * This routes the event to the appropriate handler registered by a pattern's reconciler.
   */
  handleVDomEvent(request: VDomEventRequest): void {
    // Get the reconciler for this handler and dispatch the event
    const handler = this.vdomHandlers.get(request.handlerId);
    if (handler) {
      try {
        handler(request.event);
      } catch (error) {
        console.error("[RuntimeProcessor] VDom event handler error:", error);
      }
    } else {
      console.warn(
        `[RuntimeProcessor] No handler found for handlerId: ${request.handlerId}`,
      );
    }
  }

  /**
   * Register a VDOM event handler and return its ID.
   * Used by WorkerReconciler to register handlers for DOM events.
   */
  registerVDomHandler(handler: (event: unknown) => void): number {
    const id = this.nextVDomHandlerId++;
    this.vdomHandlers.set(id, handler);
    return id;
  }

  /**
   * Unregister a VDOM event handler.
   */
  unregisterVDomHandler(handlerId: number): void {
    this.vdomHandlers.delete(handlerId);
  }

  /**
   * Handle a request to start VDOM rendering for a cell.
   * Creates a WorkerReconciler, subscribes to the cell, and sends VDomBatch notifications.
   */
  handleVDomMount(request: VDomMountRequest): VDomMountResponse {
    const { mountId, cell: cellRef } = request;

    // Check if already mounted
    if (this.vdomMounts.has(mountId)) {
      console.warn(
        `[RuntimeProcessor] Mount ${mountId} already exists, unmounting first`,
      );
      this.handleVDomUnmount({ type: RequestType.VDomUnmount, mountId });
    }

    // Get the cell from the runtime
    const cell = getCell(this.runtime, cellRef);

    // Create a reconciler that sends ops to the main thread
    const reconciler = new WorkerReconciler({
      onOps: (ops: VDomOp[]) => {
        const batchId = this.vdomBatchIdCounter++;
        self.postMessage({
          type: NotificationType.VDomBatch,
          batchId,
          ops,
          mountId,
        });
      },
      onError: (error: Error) => {
        console.error(
          `[RuntimeProcessor] VDom reconciler error for mount ${mountId}:`,
          error,
        );
        self.postMessage({
          type: NotificationType.ErrorReport,
          message: error.message,
          stackTrace: error.stack,
        });
      },
    });

    // Mount the cell - the reconciler will subscribe and emit initial ops
    const cancel = reconciler.mount(cell);

    // Track this mount
    this.vdomMounts.set(mountId, { reconciler, cancel });

    // Return the root node ID
    const rootId = reconciler.getRootNodeId() ?? 0;
    return { rootId };
  }

  /**
   * Handle a request to stop VDOM rendering for a mount.
   */
  handleVDomUnmount(request: VDomUnmountRequest): void {
    const { mountId } = request;

    const mount = this.vdomMounts.get(mountId);
    if (!mount) {
      console.warn(`[RuntimeProcessor] Mount ${mountId} not found for unmount`);
      return;
    }

    // Cancel subscriptions and clean up
    mount.cancel();
    mount.reconciler.unmount();
    this.vdomMounts.delete(mountId);
  }
}
