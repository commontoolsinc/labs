import { DID, Identity } from "@commontools/identity";
import { CharmManager } from "@commontools/charm";
import { CharmsController } from "@commontools/charm/ops";
import { getLoggerCountsBreakdown, Logger } from "@commontools/utils/logger";
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
  CellResponse,
  type CellSendRequest,
  type CellSetRequest,
  type CellSubscribeRequest,
  type CellUnsubscribeRequest,
  type FavoriteAddRequest,
  type FavoriteIsMemberRequest,
  type FavoriteRemoveRequest,
  FavoritesResponse,
  type GetCellRequest,
  GetGraphSnapshotRequest,
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
  RequestType,
  type SetLoggerEnabledRequest,
  type SetLoggerLevelRequest,
  type SetPullModeRequest,
} from "../protocol/mod.ts";
import { HttpProgramResolver, Program } from "@commontools/js-compiler";
import { favoriteListSchema } from "@commontools/home-schemas";
import { setLLMUrl } from "@commontools/llm";
import {
  createCellRef,
  createPageRef,
  getCell,
  mapCellRefsToSigilLinks,
} from "./utils.ts";
import { cellRefToKey } from "../shared/utils.ts";
import { RemoteResponse } from "@commontools/runtime-client";

export class RuntimeProcessor {
  private runtime: Runtime;
  private charmManager: CharmManager;
  private cc: CharmsController;
  private space: DID;
  private _isDisposed = false;
  private disposingPromise: Promise<void> | undefined;
  private subscriptions = new Map<string, Cancel>();
  private telemetry: RuntimeTelemetry;

  private constructor(
    runtime: Runtime,
    charmManager: CharmManager,
    cc: CharmsController,
    space: DID,
    telemetry: RuntimeTelemetry,
  ) {
    this.runtime = runtime;
    this.charmManager = charmManager;
    this.cc = cc;
    this.space = space;
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
          (async () => {
            try {
              const defaultPattern = await charmManager!.getDefaultPattern();
              if (defaultPattern) {
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
            } catch (e) {
              console.warn("Failed to track recent charm:", e);
            }
          })();
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

    return new RuntimeProcessor(runtime, charmManager, cc, space, telemetry);
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

  handlePageGetAll(): CellResponse {
    const charmsCell = this.charmManager.getCharms();
    return {
      cell: createCellRef(charmsCell),
    };
  }

  async handlePageSynced(): Promise<void> {
    await this.charmManager.synced();
  }

  /**
   * Get the home space's defaultPattern cell which owns favorites.
   * Favorites are always stored in the user's home space, regardless of
   * which space the user is currently viewing.
   */
  private async getHomeDefaultPattern() {
    const homeSpaceCell = this.runtime.getHomeSpaceCell();
    await homeSpaceCell.sync();

    const defaultPatternCell = homeSpaceCell.key("defaultPattern");
    await defaultPatternCell.sync();

    // Check that defaultPattern exists
    const patternLink = defaultPatternCell.get();
    if (!patternLink) {
      throw new Error(
        "Home space defaultPattern not initialized. Visit home space first.",
      );
    }

    // Start the pattern to ensure it's running
    const charmCell = defaultPatternCell.resolveAsCell();
    if (charmCell) {
      await this.runtime.start(charmCell);
      await this.runtime.idle();
    }

    return defaultPatternCell;
  }

  async handleFavoriteAdd(request: FavoriteAddRequest): Promise<void> {
    const defaultPattern = await this.getHomeDefaultPattern();

    // Get the charm cell to add
    const charmCell = this.runtime.getCellFromEntityId(this.space, {
      "/": request.charmId,
    });

    // Get the charm cell with schema marking addFavorite as a stream
    // Key insight: Must use .asSchema({ asStream: true }) to mark as stream,
    // then .send() will use scheduler.queueEvent() internally
    const patternCharm = defaultPattern.resolveAsCell();
    if (!patternCharm) {
      throw new Error("Could not resolve home pattern");
    }

    const cell = patternCharm.asSchema({
      type: "object",
      properties: {
        addFavorite: { asStream: true },
      },
      required: ["addFavorite"],
    });

    const handlerStream = cell.key("addFavorite");
    handlerStream.send({ charm: charmCell, tag: request.tag || "" });
    await this.runtime.idle();
  }

  async handleFavoriteRemove(request: FavoriteRemoveRequest): Promise<void> {
    const defaultPattern = await this.getHomeDefaultPattern();

    // Get the charm cell to remove
    const charmCell = this.runtime.getCellFromEntityId(this.space, {
      "/": request.charmId,
    });

    // Get the charm cell with schema marking removeFavorite as a stream
    const patternCharm = defaultPattern.resolveAsCell();
    if (!patternCharm) {
      throw new Error("Could not resolve home pattern");
    }

    const cell = patternCharm.asSchema({
      type: "object",
      properties: {
        removeFavorite: { asStream: true },
      },
      required: ["removeFavorite"],
    });

    const handlerStream = cell.key("removeFavorite");
    handlerStream.send({ charm: charmCell });
    await this.runtime.idle();
  }

  async handleFavoriteIsMember(
    request: FavoriteIsMemberRequest,
  ): Promise<BooleanResponse> {
    const defaultPattern = await this.getHomeDefaultPattern();

    // Get favorites cell and resolve it
    const favoritesCell = defaultPattern.key("favorites")
      .resolveAsCell()
      ?.asSchema(favoriteListSchema);

    if (!favoritesCell) {
      return { value: false };
    }

    await favoritesCell.sync();
    const favorites = favoritesCell.get();

    if (!favorites || !Array.isArray(favorites)) {
      return { value: false };
    }

    // Check if charm is in favorites by comparing entity IDs
    const charmCell = this.runtime.getCellFromEntityId(this.space, {
      "/": request.charmId,
    });

    const isMember = favorites.some(
      (fav: any) =>
        fav.cell &&
        typeof fav.cell.equals === "function" &&
        fav.cell.equals(charmCell),
    );

    return { value: isMember };
  }

  async handleFavoritesGetAll(): Promise<FavoritesResponse> {
    const defaultPattern = await this.getHomeDefaultPattern();

    // Get favorites cell and resolve it
    const favoritesCell = defaultPattern.key("favorites")
      .resolveAsCell()
      ?.asSchema(favoriteListSchema);

    if (!favoritesCell) {
      return { favorites: [] };
    }

    await favoritesCell.sync();
    const favorites = favoritesCell.get();

    if (!favorites || !Array.isArray(favorites)) {
      return { favorites: [] };
    }

    // Convert to response format
    const result = favorites.map((fav: any) => {
      const charmId = fav.cell?.entityId?.["/"] || "";
      const userTags = Array.isArray(fav.userTags)
        ? fav.userTags
        : (fav.userTags?.get?.() || []);
      return {
        charmId,
        tag: fav.tag || "",
        userTags,
      };
    });

    return { favorites: result };
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
    return { counts, metadata };
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
    const marker = (event as RuntimeTelemetryEvent).marker;
    self.postMessage({
      type: NotificationType.Telemetry,
      marker,
    });
  };

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
      case RequestType.GetCell:
        return this.handleGetCell(request);
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
      case RequestType.PageGet:
        return this.handlePageGet(request);
      case RequestType.PageRemove:
        return await this.handlePageRemove(request);
      case RequestType.PageStart:
        return await this.handlePageStart(request);
      case RequestType.PageStop:
        return await this.handlePageStop(request);
      case RequestType.PageGetAll:
        return this.handlePageGetAll();
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
      case RequestType.FavoriteAdd:
        return await this.handleFavoriteAdd(request);
      case RequestType.FavoriteRemove:
        return await this.handleFavoriteRemove(request);
      case RequestType.FavoriteIsMember:
        return await this.handleFavoriteIsMember(request);
      case RequestType.FavoritesGetAll:
        return await this.handleFavoritesGetAll();
      default:
        throw new Error(`Unknown message type: ${(request as any).type}`);
    }
  }
}
