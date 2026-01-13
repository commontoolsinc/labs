import { DID, Identity } from "@commontools/identity";
import { CharmManager } from "@commontools/charm";
import { CharmsController } from "@commontools/charm/ops";
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
  type GetCellRequest,
  GetGraphSnapshotRequest,
  GraphSnapshotResponse,
  type InitializationData,
  IPCClientRequest,
  JSONValueResponse,
  NotificationType,
  type PageCreateRequest,
  type PageGetRequest,
  PageGetSpaceDefault as PatternGetSpaceRoot,
  type PageRemoveRequest,
  PageResponse,
  type PageStartRequest,
  type PageStopRequest,
  RequestType,
} from "../protocol/mod.ts";
import { HttpProgramResolver, Program } from "@commontools/js-compiler";
import { setLLMUrl } from "@commontools/llm";
import {
  createCellRef,
  createPageRef,
  getCell,
  getPageResultCell,
  mapCellRefsToSigilLinks,
  unwrapProxy,
} from "./utils.ts";
import { isCellResult } from "../../runner/src/query-result-proxy.ts";
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
    const rawValue = cell.getRaw?.({ meta: { scheduling: "ignore" } }) ?? value;
    const converted = convertCellsToLinks(rawValue, {
      includeSchema: true,
      keepAsCell: true,
      doNotConvertCellResults: false,
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
    const link = request.cell;

    // Check if this looks like a handler stream path (internal/__#Nstream pattern)
    // These are created by handler() and may not have their structure initialized
    // when the first event arrives
    const isHandlerStream = link.path.some((segment) =>
      segment.includes("__#") && segment.endsWith("stream")
    );

    const event = mapCellRefsToSigilLinks(request.event);
    if (isHandlerStream) {
      this.runtime.scheduler.queueEvent(link, event);
    } else {
      const tx = this.runtime.edit();
      const cell = getCell(this.runtime, link);
      cell.withTx(tx).send(event);
      tx.commit();
    }
  }

  handleCellSubscribe(request: CellSubscribeRequest): BooleanResponse {
    const key = cellRefToKey(request.cell);

    if (this.subscriptions.has(key)) {
      return { value: false };
    }

    const cell = getCell(this.runtime, request.cell);

    const cancel = cell.sink((sinkValue) => {
      // Dereference the value to get actual data, matching sync() behavior.
      // This handles both Cell/CellResult objects and SigilLinks.
      let value: unknown = sinkValue;
      if (isCellResult(sinkValue) && cell.equals(sinkValue)) {
        value = unwrapProxy(sinkValue);
      }
      const converted = convertCellsToLinks(value, {
        includeSchema: true,
        keepAsCell: true,
        doNotConvertCellResults: false,
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
    const cell = charm.getCell();
    const result = getPageResultCell(cell);
    return {
      page: createPageRef(cell, result),
    };
  }

  async handleGetSpaceRootPattern(
    _: PatternGetSpaceRoot,
  ): Promise<PageResponse> {
    const charm = await this.cc.ensureDefaultPattern();
    const cell = charm.getCell();
    const result = getPageResultCell(cell);
    return {
      page: createPageRef(cell, result),
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
    const result = getPageResultCell(cell);

    if (request.runIt) {
      this.runtime.start(cell).catch(console.error);
    }

    return {
      page: createPageRef(cell, result),
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

  getGraphSnapshot(_: GetGraphSnapshotRequest): GraphSnapshotResponse {
    return { snapshot: this.runtime.scheduler.getGraphSnapshot() };
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
      default:
        throw new Error(`Unknown message type: ${(request as any).type}`);
    }
  }
}
