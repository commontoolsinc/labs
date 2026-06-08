import { DID, Identity, type Session } from "@commonfabric/identity";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import type { FabricValue } from "@commonfabric/data-model/fabric-value";
import { JsonEncodingContext } from "@commonfabric/data-model/json-wire";
import { PieceManager } from "@commonfabric/piece";
import { PiecesController } from "@commonfabric/piece/ops";
import {
  getLoggerCountsBreakdown,
  getLoggerFlagsBreakdown,
  getTimingStatsBreakdown,
  Logger,
  resetAllCountBaselines,
  resetAllTimingBaselines,
} from "@commonfabric/utils/logger";
import {
  type Cancel,
  type Cell,
  convertCellsToLinks,
  getCellOrThrow,
  isCell,
  isCellResult,
  Runtime,
  RuntimeTelemetry,
  RuntimeTelemetryEvent,
  setPatternEnvironment,
  type SigilLink,
} from "@commonfabric/runner";
import { cfcLabelViewForCell } from "@commonfabric/runner/cfc";
import {
  CachedCompiler,
  IDBCompilationCache,
} from "@commonfabric/runner/compilation-cache";
import { NameSchema, rendererVDOMSchema } from "@commonfabric/runner/schemas";
import { StorageManager } from "../../runner/src/storage/cache.ts";
import {
  getMetaLink,
  type NormalizedFullLink,
  parseLink,
} from "../../runner/src/link-utils.ts";
import {
  type ActionRunTraceResponse,
  BooleanResponse,
  type CellGetCfcLabelRequest,
  type CellGetRequest,
  type CellResolveAsCellRequest,
  CellResponse,
  type CellSendRequest,
  type CellSetRequest,
  type CellSubscribeRequest,
  type CellUnsubscribeRequest,
  type CfcLabelViewResponse,
  type DetectNonIdempotentRequest,
  type DetectNonIdempotentResponse,
  type EnsureHomePatternRunningRequest,
  type GetActionRunTraceRequest,
  type GetCellRequest,
  GetGraphSnapshotRequest,
  type GetHomeSpaceCellRequest,
  type GetLoggerCountsRequest,
  type GetPatternSourcesRequest,
  type GetSettleStatsHistoryRequest,
  type GetSettleStatsRequest,
  type GetTriggerTraceRequest,
  type GetWriteStackTraceRequest,
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
  type PageGetSlugRequest,
  PageGetSpaceDefault as PatternGetSpaceRoot,
  type PageRemoveRequest,
  PageResponse,
  type PageStartRequest,
  type PageStopRequest,
  type PatternSourcesResponse,
  type RecreateSpaceRootPatternRequest,
  RequestType,
  type SetActionRunTraceEnabledRequest,
  type SetBreakpointsRequest,
  type SetLoggerEnabledRequest,
  type SetLoggerLevelRequest,
  type SetPullModeRequest,
  type SetSettleStatsEnabledRequest,
  type SetTelemetryEnabledRequest,
  type SettleStatsHistoryResponse,
  type SettleStatsResponse,
  type SetTriggerTraceEnabledRequest,
  type SetWriteStackTraceMatchersRequest,
  type SlugResponse,
  type TriggerTraceResponse,
  type UploadBlobRequest,
  type UploadBlobResponse,
  type VDomEventRequest,
  type VDomMountRequest,
  type VDomMountResponse,
  type VDomUnmountRequest,
  type WriteStackTraceResponse,
} from "../protocol/mod.ts";
import { HttpProgramResolver, Program } from "@commonfabric/js-compiler";
import { setLLMUrl } from "@commonfabric/llm";
import {
  createCellRef,
  createPageRef,
  getCell,
  mapCellRefsToSigilLinks,
} from "./utils.ts";
import { cellRefToKey } from "../shared/utils.ts";
import { RemoteResponse } from "@commonfabric/runtime-client";
import { WorkerReconciler } from "@commonfabric/html/worker";
import type { VDomOp } from "../protocol/types.ts";
import type { JSONValue, RuntimeOptions, URI } from "@commonfabric/runner";

const MAX_SERIALIZATION_DEPTH = 5;
const blobUploadEncoding = new JsonEncodingContext();

export function runtimeOptionsFromInitializationData(
  data: InitializationData,
  storageManager: RuntimeOptions["storageManager"],
  telemetry: RuntimeTelemetry,
  cachedCompiler: CachedCompiler | undefined,
): RuntimeOptions {
  const apiUrlObj = new URL(data.apiUrl);
  return {
    apiUrl: apiUrlObj,
    storageManager,
    patternEnvironment: { apiUrl: apiUrlObj },
    telemetry,
    experimental: data.experimental,
    cfcEnforcementMode: data.cfcEnforcementMode,
    trustSnapshotProvider: data.trustSnapshot
      ? () => data.trustSnapshot
      : undefined,
    cachedCompiler,
  };
}

/**
 * Formats a cell link for display in console output.
 * Returns a string like "[Cell: of:bafy.../path/to/prop]"
 */
function formatCellLink(cell: Cell<unknown>): string {
  try {
    const link: SigilLink = cell.getAsLink();
    const inner = link["/"]["link@1"];
    const pathStr = inner.path?.length ? `/${inner.path.join("/")}` : "";
    return `[Cell: ${inner.id ?? "?"}${pathStr}]`;
  } catch {
    return "[Cell]";
  }
}

/**
 * Deep-walks a value and converts uncloneable parts (Cells, Proxies, functions)
 * into cloneable representations for postMessage. Preserves the structure of
 * objects so that `console.log({ self, name: "test" })` shows both the cell
 * reference AND the other properties.
 *
 * Exported for testing.
 */
export function sanitizeForPostMessage(
  value: unknown,
  seen = new WeakSet<object>(),
  depth = 0,
): unknown {
  // Handle primitives immediately
  if (value === null || value === undefined) return value;
  const type = typeof value;
  if (type !== "object" && type !== "function") return value;

  // Functions can't be cloned
  if (type === "function") return "[Function]";

  // Depth limit to prevent runaway recursion
  if (depth >= MAX_SERIALIZATION_DEPTH) {
    return "[Max depth exceeded]";
  }

  const obj = value as object;

  // Circular reference protection
  if (seen.has(obj)) return "[Circular]";
  seen.add(obj);

  // Check for Cell (direct cell reference)
  if (isCell(value)) {
    return formatCellLink(value);
  }

  // Check for query result proxy (has toCell symbol) - walk the data AND show the ref
  // Wrap in try-catch since isCellResult accesses a symbol property, which can throw
  // on hostile Proxies with throwing get traps
  try {
    if (isCellResult(value)) {
      const cell = getCellOrThrow(value);
      const cellRef = formatCellLink(cell);

      // Walk the proxy's enumerable properties to extract the actual data
      // This works because the Proxy forwards property access to the underlying value
      const data: Record<string, unknown> = { __ref: cellRef };
      for (const key of Object.keys(value as object)) {
        try {
          data[key] = sanitizeForPostMessage(
            (value as Record<string, unknown>)[key],
            seen,
            depth + 1,
          );
        } catch {
          data[key] = "[Unreadable]";
        }
      }
      return data;
    }
  } catch {
    // isCellResult or getCellOrThrow threw - hostile Proxy, bail out
    return "[Object - uncloneable]";
  }

  // Arrays — cast needed because isCell/isCellResult type guards over-narrow
  if (Array.isArray(value as object)) {
    return (value as unknown[]).map((item) =>
      sanitizeForPostMessage(item, seen, depth + 1)
    );
  }

  // Plain objects - walk properties
  try {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
      try {
        result[key] = sanitizeForPostMessage(
          (obj as Record<string, unknown>)[key],
          seen,
          depth + 1,
        );
      } catch {
        result[key] = "[Unreadable]";
      }
    }
    return result;
  } catch {
    // Object doesn't support iteration (e.g., Proxy with throwing traps)
    // Try to get constructor name for a more helpful message
    try {
      const name = obj.constructor?.name;
      if (name && name !== "Object") {
        return `[${name} - uncloneable]`;
      }
    } catch {
      // Ignore
    }
    return "[Object - uncloneable]";
  }
}

export const hasExplicitSubscriptionSchema = (schema: unknown): boolean =>
  schema === true ||
  (schema !== undefined && schema !== false &&
    typeof schema === "object" && schema !== null &&
    Object.keys(schema).length > 0);

export class RuntimeProcessor {
  private runtime: Runtime;
  private pieceManager: PieceManager;
  private cc: PiecesController;
  private apiUrl: URL;
  private space: DID;
  private identity: Identity;
  private _isDisposed = false;
  private disposingPromise: Promise<void> | undefined;
  private subscriptions = new Map<string, Cancel>();
  private telemetry: RuntimeTelemetry;
  #telemetryEnabled = false;

  // VDOM mounts: mountId -> { reconciler, cancel }
  private vdomMounts = new Map<
    number,
    { reconciler: WorkerReconciler; cancel: Cancel }
  >();
  private vdomBatchIdCounter = 0;

  private constructor(
    runtime: Runtime,
    pieceManager: PieceManager,
    cc: PiecesController,
    apiUrl: URL,
    space: DID,
    identity: Identity,
    telemetry: RuntimeTelemetry,
  ) {
    this.runtime = runtime;
    this.pieceManager = pieceManager;
    this.cc = cc;
    this.apiUrl = apiUrl;
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
    setPatternEnvironment({ apiUrl: apiUrlObj });

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

    // Construct compilation cache if a build hash was provided (browser path).
    const cachedCompiler = data.buildHash
      ? new CachedCompiler(new IDBCompilationCache(), data.buildHash)
      : undefined;

    let pieceManager: PieceManager | undefined = undefined;
    const runtime = new Runtime({
      ...runtimeOptionsFromInitializationData(
        data,
        storageManager,
        telemetry,
        cachedCompiler,
      ),
      consoleHandler: ({ metadata, method, args }) => {
        // Deep-walk args to convert uncloneable objects (Cells, Proxies,
        // functions) into cloneable representations for postMessage.
        // This preserves object structure so `console.log({ self, name })`
        // shows both the cell reference and other properties.
        const sanitizedArgs = args.map((arg) => sanitizeForPostMessage(arg));
        self.postMessage({
          type: NotificationType.ConsoleMessage,
          metadata,
          method,
          args: sanitizedArgs,
        });
        return args;
      },

      navigateCallback: (target) => {
        const link = parseLink(target.getAsLink()) as NormalizedFullLink;
        self.postMessage({
          type: NotificationType.NavigateRequest,
          targetCellRef: link,
        });
      },

      pieceCreatedCallback: (piece) => {
        const writeContext = runtime.getWriteDebugContext();
        const manager = pieceManager;
        if (!manager) return;
        void runtime.withWriteDebugContext(
          writeContext,
          () => manager.add([piece]),
        ).catch((e: unknown) => {
          console.error(
            "[RuntimeProcessor] Failed to add created piece:",
            {
              error: e instanceof Error ? e.message : e,
            },
          );
        });
      },

      errorHandlers: [
        (error) => {
          self.postMessage({
            type: NotificationType.ErrorReport,
            message: error.message,
            pageId: error.pieceId,
            space: error.space,
            patternId: error.patternId,
            spellId: error.spellId,
            stackTrace: error.stack,
          });
        },
      ],
    });

    if (!await runtime.healthCheck()) {
      throw new Error(`Could not connect to "${data.apiUrl}"`);
    }

    // Allow the worker to acknowledge initialization immediately. Consumers
    // that need storage/piece-manager convergence should call `synced()`.
    pieceManager = new PieceManager(session, runtime);
    const cc = new PiecesController(pieceManager);

    return new RuntimeProcessor(
      runtime,
      pieceManager,
      cc,
      apiUrlObj,
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

        // Clean up VDOM mounts
        for (const { reconciler, cancel } of this.vdomMounts.values()) {
          cancel();
          reconciler.unmount();
        }
        this.vdomMounts.clear();

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
    let cell = getCell(this.runtime, request.cell);
    if (request.meta !== undefined) {
      const rootCell = getCell(this.runtime, { ...request.cell, path: [] });
      if (
        request.meta === "pattern" || request.meta === "argument" ||
        request.meta === "result"
      ) {
        // For the meta link fields, use the meta linked cell instead
        const rootCell = getCell(this.runtime, { ...request.cell, path: [] });
        const link = getMetaLink(rootCell, request.meta);
        if (link === undefined) return { value: undefined };
        cell = this.runtime.getCellFromLink({
          ...link,
          path: [...link.path, ...request.cell.path],
        });
      } else {
        // For meta cells that aren't link cells, return the raw data
        return {
          value: rootCell.getMetaRaw(request.meta) as JSONValue | undefined,
        };
      }
    }
    const value = cell.get();
    const converted = convertCellsToLinks(value, {
      includeSchema: true,
      keepAsCell: true,
      doNotConvertCellResults: true,
      includeCfcLabelView: true,
    });
    return { value: converted };
  }

  handleCellSet(request: CellSetRequest): void {
    const tx = this.runtime.edit();
    const cell = getCell(this.runtime, request.cell);
    const value = mapCellRefsToSigilLinks(request.value);
    cell.withTx(tx).set(value);
    this.runtime.prepareTxForCommit(tx);
    // Local visibility is established by commit(); the promise tracks remote
    // confirmation/rollback and must not block cell IPC.
    tx.commit();
  }

  handleCellSend(request: CellSendRequest): void {
    const tx = this.runtime.edit();
    const cell = getCell(this.runtime, request.cell);
    cell.withTx(tx).send(mapCellRefsToSigilLinks(request.event));
    this.runtime.prepareTxForCommit(tx);
    // Local visibility is established by commit(); the promise tracks remote
    // confirmation/rollback and must not block cell IPC.
    tx.commit();
  }

  handleCellSubscribe(request: CellSubscribeRequest): BooleanResponse {
    const key = cellRefToKey(request.cell);

    if (this.subscriptions.has(key)) {
      return { value: false };
    }

    const cell = getCell(this.runtime, request.cell);

    const cancel = cell.sink((value) => {
      // Log empty-schema subscriptions that produce CellResult proxies.
      // These are the call sites that need real schemas added.
      const hasSchema = hasExplicitSubscriptionSchema(request.cell.schema);
      if (!hasSchema && isCellResult(value)) {
        console.error(
          `[handleCellSubscribe] EMPTY SCHEMA SUBSCRIPTION producing ` +
            `CellResult proxy. Add a schema to this subscription site!\n` +
            `  cell: ${request.cell.id}\n` +
            `  path: ${JSON.stringify(request.cell.path)}\n` +
            `  space: ${request.cell.space}\n` +
            `  schema: ${JSON.stringify(request.cell.schema)}`,
        );
      }
      const converted = convertCellsToLinks(value, {
        includeSchema: true,
        keepAsCell: true,
        doNotConvertCellResults: true,
        includeCfcLabelView: true,
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

  async handleCellGetCfcLabel(
    request: CellGetCfcLabelRequest,
  ): Promise<CfcLabelViewResponse> {
    // Label reads must use the runtime's stored cell identity. The request
    // schema is client-supplied view context, not trusted label provenance.
    const { schema: _schema, ...cellRef } = request.cell;
    const cell = getCell(this.runtime, cellRef);
    const rootCell = this.runtime.getCellFromLink({
      ...cell.getAsNormalizedFullLink(),
      path: [],
    });
    await syncMetaLinkedDocs(rootCell);
    await cell.sync();
    return {
      cfcLabel: cfcLabelViewForCell(cell),
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
    // (Value is a Cell itself, and pattern metadata means it's instantiated)
    // We've followed all the links from "defaultPattern", so our cell should
    // be the result cell for the default pattern.
    if (getMetaLink(defaultPatternCell, "pattern")) {
      await this.runtime.start(defaultPatternCell);
      await this.runtime.idle();
      return {
        cell: createCellRef(defaultPatternCell),
      };
    }

    // Pattern doesn't exist - create it via home space PieceController
    const homeSession: Session = {
      as: this.identity,
      space: this.runtime.userIdentityDID,
    };
    const homeManager = new PieceManager(homeSession, this.runtime);
    await homeManager.synced();
    const homeCC = new PiecesController(homeManager);

    const homePattern = await homeCC.ensureDefaultPattern();

    return {
      cell: createCellRef(homePattern.getCell()),
    };
  }

  async handleIdle(): Promise<void> {
    await this.runtime.idle();
  }

  async handlePieceCreate(
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

    const piece = await this.cc.create<NameSchema>(program, {
      input: request.argument as object | undefined,
      start: request.run ?? true,
    }, request.cause);
    return {
      page: createPageRef(piece.getCell()),
    };
  }

  async handleGetSpaceRootPattern(
    _: PatternGetSpaceRoot,
  ): Promise<PageResponse> {
    const piece = await this.cc.ensureDefaultPattern();
    return {
      page: createPageRef(piece.getCell()),
    };
  }

  async handleRecreateSpaceRootPattern(
    _: RecreateSpaceRootPatternRequest,
  ): Promise<PageResponse> {
    const piece = await this.cc.recreateDefaultPattern();
    return {
      page: createPageRef(piece.getCell()),
    };
  }

  // TODO(runtime-worker-refactor): Can this fail? What if the cell
  // is not a page cell?
  async handlePageGet(
    request: PageGetRequest,
  ): Promise<PageResponse> {
    const requestedCell = this.runtime.getCellFromEntityId(
      this.pieceManager.getSpace(),
      { "/": request.pageId },
    );
    await requestedCell.sync();
    const redirect = parseLink(
      requestedCell.getRaw(),
      requestedCell.getAsNormalizedFullLink(),
    );
    if (redirect?.overwrite === "redirect") {
      const target = this.runtime.getCellFromLink({
        ...redirect,
        space: redirect.space ?? this.pieceManager.getSpace(),
        scope: redirect.scope ?? "space",
      });
      await target.sync();
      const targetLink = target.getAsNormalizedFullLink();
      const hasPattern = target.getMetaRaw("pattern") !== undefined;
      if (!hasPattern || targetLink.path.length > 0) {
        const pageCell = hasPattern && targetLink.path.length > 0
          ? target.asSchemaFromLinks()
          : target;
        await pageCell.pull();
        return {
          page: createPageRef(pageCell),
        };
      }

      const cell = await this.cc.manager().get(
        target,
        request.runIt ?? false,
      );
      return {
        page: createPageRef(cell),
      };
    }

    const cell = await this.cc.manager().get(
      request.pageId,
      request.runIt ?? false,
    );

    return {
      page: createPageRef(cell),
    };
  }

  async handlePageGetSlug(
    request: PageGetSlugRequest,
  ): Promise<SlugResponse> {
    const cell = this.runtime.getCellFromEntityId(
      this.pieceManager.getSpace(),
      { "/": request.pageId },
    );
    await cell.sync();
    const slug = cell.getMetaRaw("slug");
    return { slug: typeof slug === "string" ? slug : undefined };
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
    const piecesCell = await this.pieceManager.getPieces();
    return {
      cell: createCellRef(piecesCell),
    };
  }

  async handlePageSynced(): Promise<void> {
    await this.pieceManager.synced();
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
    const flags = getLoggerFlagsBreakdown();
    return { counts, metadata, timing, flags };
  }

  #getLoggerMetadata(): LoggerMetadata {
    const global = globalThis as unknown as {
      commonfabric?: { logger?: Record<string, Logger> };
    };
    const result: LoggerMetadata = {};
    if (global.commonfabric?.logger) {
      for (const [name, logger] of Object.entries(global.commonfabric.logger)) {
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
    this.runtime.scheduler.setEventPreflightTelemetryEnabled(request.enabled);
  }

  resetLoggerBaselines(_: any): void {
    resetAllCountBaselines();
    resetAllTimingBaselines();
  }

  #getLoggers(loggerName?: string): Logger[] {
    const global = globalThis as unknown as {
      commonfabric?: { logger?: Record<string, Logger> };
    };
    if (!global.commonfabric?.logger) {
      return [];
    }
    if (loggerName) {
      const logger = global.commonfabric.logger[loggerName];
      return logger ? [logger] : [];
    }
    return Object.values(global.commonfabric.logger);
  }

  #onTelemetry = (event: Event) => {
    if (!this.#telemetryEnabled) return;
    const marker = (event as RuntimeTelemetryEvent).marker;
    self.postMessage({
      type: NotificationType.Telemetry,
      marker,
    });
  };

  getPatternSources(
    _request: GetPatternSourcesRequest,
  ): PatternSourcesResponse {
    const snapshot = this.runtime.scheduler.getGraphSnapshot();
    const seen = new Set<string>();
    const patterns: PatternSourcesResponse["patterns"] = [];

    for (const node of snapshot.nodes) {
      if (node.patternId && !seen.has(node.patternId)) {
        seen.add(node.patternId);
        try {
          const meta = this.runtime.patternManager.getPatternMeta({
            patternId: node.patternId as URI,
          });
          if (meta?.program && typeof meta.program === "object") {
            const program = meta.program as {
              files?: Array<{ name: string; contents: string }>;
            };
            if (program.files) {
              patterns.push({
                patternId: node.patternId,
                patternName: meta.patternName,
                files: program.files.map((f) => ({
                  name: f.name,
                  contents: f.contents,
                })),
              });
            }
          }
        } catch {
          // Pattern not found or no metadata available
        }
      }
    }
    return { patterns };
  }

  setBreakpoints(request: SetBreakpointsRequest): void {
    this.runtime.scheduler.setBreakpoints(request.actionIds);
  }

  async handleUploadBlob(
    request: UploadBlobRequest,
  ): Promise<UploadBlobResponse> {
    const suffix = (request.suffix ?? "bin").replace(/^\./, "") || "bin";
    const bytes = Uint8Array.from(request.body);
    const target = new URL(
      `/${this.space}/blobs/upload.${encodeURIComponent(suffix)}`,
      this.apiUrl,
    );
    // Blob upload payloads must preserve FabricBytes even when the wider
    // process is running with legacy memory JSON flags.
    const body = blobUploadEncoding.encode({
      type: request.contentType,
      body: new FabricBytes(bytes),
    } as FabricValue);
    const response = await fetch(target, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (!response.ok) {
      throw new Error(
        `Blob upload failed: ${response.status} ${await response.text()}`,
      );
    }
    const result = await response.json() as Partial<UploadBlobResponse>;
    if (typeof result.id !== "string" || typeof result.url !== "string") {
      throw new Error("Blob upload returned an invalid response");
    }
    return { id: result.id, url: result.url };
  }

  async detectNonIdempotent(
    request: DetectNonIdempotentRequest,
  ): Promise<DetectNonIdempotentResponse> {
    const result = await this.runtime.scheduler.runDiagnosis(
      request.durationMs,
    );
    return { result };
  }

  getSettleStats(
    _request: GetSettleStatsRequest,
  ): SettleStatsResponse {
    return {
      stats: this.runtime.scheduler.getSettleStats(),
    };
  }

  getSettleStatsHistory(
    _request: GetSettleStatsHistoryRequest,
  ): SettleStatsHistoryResponse {
    return {
      history: this.runtime.scheduler.getSettleStatsHistory(),
    };
  }

  setSettleStatsEnabled(
    request: SetSettleStatsEnabledRequest,
  ): void {
    this.runtime.scheduler.setSettleStatsEnabled(request.enabled);
  }

  getActionRunTrace(
    _request: GetActionRunTraceRequest,
  ): ActionRunTraceResponse {
    return {
      trace: this.runtime.scheduler.getActionRunTrace(),
    };
  }

  setActionRunTraceEnabled(
    request: SetActionRunTraceEnabledRequest,
  ): void {
    this.runtime.scheduler.setActionRunTraceEnabled(request.enabled);
  }

  getTriggerTrace(
    _request: GetTriggerTraceRequest,
  ): TriggerTraceResponse {
    return {
      trace: this.runtime.scheduler.getTriggerTrace(),
    };
  }

  setTriggerTraceEnabled(
    request: SetTriggerTraceEnabledRequest,
  ): void {
    this.runtime.scheduler.setTriggerTraceEnabled(request.enabled);
  }

  getWriteStackTrace(
    _request: GetWriteStackTraceRequest,
  ): WriteStackTraceResponse {
    return {
      trace: this.runtime.getWriteStackTrace(),
    };
  }

  setWriteStackTraceMatchers(
    request: SetWriteStackTraceMatchersRequest,
  ): void {
    this.runtime.setWriteStackTraceMatchers(request.matchers);
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
      case RequestType.CellGetCfcLabel:
        return await this.handleCellGetCfcLabel(request);
      case RequestType.GetCell:
        return this.handleGetCell(request);
      case RequestType.GetHomeSpaceCell:
        return this.handleGetHomeSpaceCell(request);
      case RequestType.EnsureHomePatternRunning:
        return await this.handleEnsureHomePatternRunning(request);
      case RequestType.Idle:
        return await this.handleIdle();
      case RequestType.PageCreate:
        return await this.handlePieceCreate(
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
        return await this.handlePageGet(request);
      case RequestType.PageGetSlug:
        return await this.handlePageGetSlug(request);
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
      case RequestType.GetSettleStats:
        return this.getSettleStats(request);
      case RequestType.GetSettleStatsHistory:
        return this.getSettleStatsHistory(request);
      case RequestType.SetSettleStatsEnabled:
        return this.setSettleStatsEnabled(request);
      case RequestType.GetActionRunTrace:
        return this.getActionRunTrace(request);
      case RequestType.SetActionRunTraceEnabled:
        return this.setActionRunTraceEnabled(request);
      case RequestType.GetTriggerTrace:
        return this.getTriggerTrace(request);
      case RequestType.SetTriggerTraceEnabled:
        return this.setTriggerTraceEnabled(request);
      case RequestType.GetWriteStackTrace:
        return this.getWriteStackTrace(request);
      case RequestType.SetWriteStackTraceMatchers:
        return this.setWriteStackTraceMatchers(request);
      case RequestType.DetectNonIdempotent:
        return await this.detectNonIdempotent(request);
      case RequestType.GetPatternSources:
        return this.getPatternSources(request);
      case RequestType.SetBreakpoints:
        return this.setBreakpoints(request);
      case RequestType.UploadBlob:
        return await this.handleUploadBlob(request);
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
   * This routes the event to the appropriate reconciler based on mountId.
   */
  handleVDomEvent(request: VDomEventRequest): void {
    const mount = this.vdomMounts.get(request.mountId);
    if (!mount) {
      console.warn(
        `[RuntimeProcessor] No mount found for mountId: ${request.mountId}`,
      );
      return;
    }

    mount.reconciler.dispatchEvent(
      request.handlerId,
      request.event,
    );
  }

  /**
   * Handle a request to start VDOM rendering for a cell.
   * Creates a WorkerReconciler, subscribes to the cell, and sends VDomBatch notifications.
   */
  handleVDomMount(request: VDomMountRequest): VDomMountResponse {
    const { mountId, cell: cellRef } = request;

    // Check if already mounted
    if (this.vdomMounts.has(mountId)) {
      this.handleVDomUnmount({ type: RequestType.VDomUnmount, mountId });
    }

    // Get the cell from the runtime and apply rendererVDOMSchema
    // The schema has a [UI] property definition that handles VDOM unwrapping
    const rawCell = getCell(this.runtime, cellRef);
    const cell = rawCell.asSchema(rendererVDOMSchema);

    // Create a reconciler that sends ops to the main thread
    const reconciler = new WorkerReconciler({
      onOps: (ops: VDomOp[]) => {
        const batchId = this.vdomBatchIdCounter++;
        self.postMessage({
          type: NotificationType.VDomBatch,
          batchId,
          ops,
          mountId,
          rootId: reconciler.getRootNodeId(),
        });
      },
      onError: (error: Error) => {
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

/**
 * Sync a root cell and each direct metadata-linked cell reachable from it.
 *
 * `internal` is raw manifest metadata, not a direct metadata link. Callers that
 * need a transactional root cell can create it first and pass it.
 */
async function syncMetaLinkedDocs(
  cell: Cell<any>,
  cycleCheck: Set<string> = new Set<string>(),
) {
  const pendingCells = [cell];
  cycleCheck.add(cell.sourceURI);
  while (pendingCells.length > 0) {
    const currentCell = pendingCells.shift()!;
    await currentCell.sync();
    for (const meta of ["pattern", "argument"] as const) {
      const link = getMetaLink(currentCell, meta);
      if (link === undefined) continue;
      const linkedCell = currentCell.runtime.getCellFromLink(link, undefined);
      if (linkedCell === undefined) continue;
      if (cycleCheck.has(linkedCell.sourceURI)) continue;
      cycleCheck.add(linkedCell.sourceURI);
      pendingCells.push(linkedCell);
    }
  }
}
