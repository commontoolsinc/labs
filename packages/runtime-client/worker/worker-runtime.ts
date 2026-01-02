import { DID, Identity } from "@commontools/identity";
import { CharmManager, getRecipeIdFromCharm } from "@commontools/charm";
import { CharmController, CharmsController } from "@commontools/charm/ops";
import {
  type Cancel,
  convertCellsToLinks,
  Runtime,
  setRecipeEnvironment,
} from "@commontools/runner";
import { NameSchema, nameSchema } from "@commontools/runner/schemas";
import { StorageManager } from "../../runner/src/storage/cache.ts";
import {
  createSigilLinkFromParsedLink,
  type NormalizedFullLink,
  parseLink,
} from "../../runner/src/link-utils.ts";
import {
  type CellGetRequest,
  type CellRef,
  type CellSendRequest,
  type CellSetRequest,
  type CellSubscribeRequest,
  type CellSyncRequest,
  type CellUnsubscribeRequest,
  type CharmCreateRequest,
  type CharmGetRequest,
  CharmGetSpaceDefault as PatternGetSpaceRoot,
  type CharmInfo,
  type CharmRemoveRequest,
  CharmResultResponse,
  type CharmStartRequest,
  type CharmStopRequest,
  CharmSyncPatternRequest,
  type GetCellRequest,
  type InitializationData,
  RuntimeClientMessageType,
  SuccessResponse,
} from "../ipc.ts";
import { HttpProgramResolver, Program } from "@commontools/js-compiler";
import { setLLMUrl } from "@commontools/llm";
import { cellToCellRef, cellToCharmInfo } from "./utils.ts";
import { isCellResult } from "../../runner/src/query-result-proxy.ts";

export class WorkerRuntime {
  private runtime: Runtime;
  private charmManager: CharmManager;
  private cc: CharmsController;
  private space: DID;
  private _isDisposed = false;
  private disposingPromise: Promise<void> | undefined;
  private subscriptions = new Map<string, Cancel>();

  private constructor(
    runtime: Runtime,
    charmManager: CharmManager,
    cc: CharmsController,
    space: DID,
  ) {
    this.runtime = runtime;
    this.charmManager = charmManager;
    this.cc = cc;
    this.space = space;
  }

  static async initialize(data: InitializationData): Promise<WorkerRuntime> {
    const apiUrlObj = new URL(data.apiUrl);
    const identity = await Identity.deserialize(data.identity);
    const spaceIdentity = data.spaceIdentity
      ? await Identity.deserialize(data.spaceIdentity)
      : undefined;
    const space = data.spaceDid;

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

    const runtime = new Runtime({
      apiUrl: apiUrlObj,
      storageManager,
      recipeEnvironment: { apiUrl: apiUrlObj },

      consoleHandler: ({ metadata, method, args }) => {
        self.postMessage({
          type: RuntimeClientMessageType.ConsoleMessage,
          metadata,
          method,
          args,
        });
        return args;
      },

      navigateCallback: (target) => {
        const link = parseLink(target.getAsLink()) as NormalizedFullLink;
        self.postMessage({
          type: RuntimeClientMessageType.NavigateRequest,
          targetCellRef: link,
        });
      },

      errorHandlers: [
        (error) => {
          self.postMessage({
            type: RuntimeClientMessageType.ErrorReport,
            message: error.message,
            charmId: error.charmId,
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

    const charmManager = new CharmManager(session, runtime);
    await charmManager.synced();
    const cc = new CharmsController(charmManager);

    return new WorkerRuntime(runtime, charmManager, cc, space);
  }

  dispose(): Promise<void> {
    if (this.disposingPromise) return this.disposingPromise;
    this._isDisposed = true;
    this.disposingPromise = (async () => {
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
    request: CellGetRequest | CellSyncRequest,
  ): { value: unknown } {
    const sigilLink = createSigilLinkFromParsedLink(request.cellRef);
    const cell = this.runtime.getCellFromLink(
      sigilLink,
      request.cellRef.schema,
    );
    const value = cell.get();
    const rawValue = cell.getRaw?.({ meta: { scheduling: "ignore" } }) ?? value;
    const converted = convertCellsToLinks(rawValue);
    return { value: converted };
  }

  handleCellSet(request: CellSetRequest): void {
    const tx = this.runtime.edit();
    const sigilLink = createSigilLinkFromParsedLink(request.cellRef);
    const cell = this.runtime.getCellFromLink(
      sigilLink,
      request.cellRef.schema,
    );
    cell.withTx(tx).set(request.value);
    tx.commit();
  }

  /**
   * Send event to a stream cell.
   *
   * For handler streams (paths containing "__#" indicating internal handler streams),
   * we route directly to the scheduler. This is necessary because:
   * 1. Stream cells are detected by their stored value having { $stream: true }
   * 2. When events arrive before the charm has fully initialized, the stream
   *    structure may not exist yet, causing Cell.set() to fall through to
   *    regular cell behavior and fail with storage path errors like
   *    "Value at path value/internal/__#7stream is not an object"
   * 3. queueEvent bypasses storage entirely and goes directly to the scheduler
   *
   * For other cells, we use the standard set() method which handles both
   * stream and non-stream cells appropriately.
   */
  handleCellSend(request: CellSendRequest): void {
    const link = request.cellRef;

    // Check if this looks like a handler stream path (internal/__#Nstream pattern)
    // These are created by handler() and may not have their structure initialized
    // when the first event arrives
    const isHandlerStream = link.path.some((segment) =>
      segment.includes("__#") && segment.endsWith("stream")
    );

    if (isHandlerStream) {
      const event = convertCellsToLinks(request.event);
      this.runtime.scheduler.queueEvent(link, event);
    } else {
      const tx = this.runtime.edit();
      const cell = this.runtime.getCellFromLink(
        link,
        link.schema,
      );
      cell.withTx(tx).send(request.event);
      tx.commit();
    }
  }

  handleCellSubscribe(request: CellSubscribeRequest): void {
    const { cellRef, subscriptionId, hasValue } = request;

    // Cancel existing subscription if any
    const existing = this.subscriptions.get(subscriptionId);
    if (existing) {
      existing();
      this.subscriptions.delete(subscriptionId);
    }

    const cell = this.runtime.getCellFromLink(cellRef, cellRef.schema);

    let hasCallbackFired = false;
    const cancel = cell.sink((sinkValue) => {
      if (!hasCallbackFired) {
        hasCallbackFired = true;
        // Only skip the initial callback if the client already has a cached value.
        // For newly rehydrated cells (e.g., derived cells in VNode children),
        // we need to send the initial value since the client doesn't have it.
        if (hasValue) {
          return;
        }
      }

      // Dereference the value to get actual data, matching sync() behavior.
      // This handles both Cell/CellResult objects and SigilLinks.
      let value: unknown = sinkValue;
      if (isCellResult(sinkValue) && cell.equals(sinkValue)) {
        value = unwrapProxy(sinkValue);
      }

      self.postMessage({
        type: RuntimeClientMessageType.CellUpdate,
        subscriptionId,
        value: convertCellsToLinks(value),
      });
    });

    this.subscriptions.set(subscriptionId, cancel);
  }

  handleCellUnsubscribe(request: CellUnsubscribeRequest): void {
    const cancel = this.subscriptions.get(request.subscriptionId);
    if (cancel) {
      cancel();
      this.subscriptions.delete(request.subscriptionId);
    }
  }

  handleGetCell(request: GetCellRequest): { cellRef: CellRef } {
    const cell = this.runtime.getCell(
      request.space,
      request.cause,
      request.schema,
    );

    return {
      cellRef: cellToCellRef(cell, request.schema),
    };
  }

  async handleIdle(): Promise<void> {
    await this.runtime.idle();
  }

  async handleCharmCreate(
    request: CharmCreateRequest,
  ): Promise<Omit<CharmResultResponse, "msgId">> {
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
    const result = await charm.result.getCell();
    return {
      charm: cellToCharmInfo(charm.getCell()),
      result: cellToCellRef(result),
    };
  }

  async handleGetSpaceRootPattern(
    _: PatternGetSpaceRoot,
  ): Promise<Omit<CharmResultResponse, "msgId">> {
    const charm = await this.cc.ensureDefaultPattern();
    const result = await charm.result.getCell();
    return {
      charm: cellToCharmInfo(charm.getCell()),
      result: cellToCellRef(result),
    };
  }

  async handleCharmSyncPattern(
    request: CharmSyncPatternRequest,
  ): Promise<Omit<CharmResultResponse, "msgId"> | null> {
    const charm = await this.cc.get(request.charmId, true);
    if (!charm) return null;

    const cell = charm.getCell();
    const recipeId = getRecipeIdFromCharm(cell);
    const recipe = await cell.runtime.recipeManager.loadRecipe(
      recipeId,
      cell.space,
    );
    await cell.runtime.runSynced(cell, recipe);
    return {
      charm: cellToCharmInfo(cell),
      // TODO(runtime-worker-refactor): I think this needs to be the result cell
      result: cellToCellRef(cell),
    };
  }

  async handleCharmGet(
    request: CharmGetRequest,
  ): Promise<{ charm: CharmInfo } | null> {
    const cell = this.runtime.getCellFromEntityId(this.space, {
      "/": request.charmId,
    });
    const controller = new CharmController(
      this.charmManager,
      cell.asSchema(nameSchema),
    );

    if (request.runIt) {
      this.runtime.start(cell).catch(console.error);
    }

    return await controller
      ? { charm: cellToCharmInfo(controller.getCell()) }
      : null;
  }

  async handleCharmRemove(
    request: CharmRemoveRequest,
  ): Promise<Omit<SuccessResponse, "msgId">> {
    return { value: await this.cc.remove(request.charmId) };
  }

  async handleCharmStart(
    request: CharmStartRequest,
  ): Promise<Omit<SuccessResponse, "msgId">> {
    await this.cc.start(request.charmId);
    // @TODO(runtime-worker-refactor): Return status based on if
    // pattern was actually found and stopped
    return { value: true };
  }

  async handleCharmStop(
    request: CharmStopRequest,
  ): Promise<Omit<SuccessResponse, "msgId">> {
    await this.cc.stop(request.charmId);
    // @TODO(runtime-worker-refactor): Return status based on if
    // pattern was actually found and stopped
    return { value: true };
  }

  handleCharmGetAll(): { charmsListCellRef: CellRef } {
    const charmsCell = this.charmManager.getCharms();
    return {
      charmsListCellRef: cellToCellRef(charmsCell),
    };
  }

  async handleCharmSynced(): Promise<void> {
    await this.charmManager.synced();
  }
}

function unwrapProxy(proxy: unknown): any {
  if (Array.isArray(proxy)) {
    return [...proxy];
  } else if (proxy && typeof proxy === "object") {
    return { ...proxy };
  }
}
