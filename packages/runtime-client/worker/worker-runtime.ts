import { Identity } from "@commontools/identity";
import { CharmManager, getRecipeIdFromCharm } from "@commontools/charm";
import { CharmsController } from "@commontools/charm/ops";
import {
  type Cancel,
  type Cell,
  convertCellsToLinks,
  isCell,
  Runtime,
  setRecipeEnvironment,
} from "@commontools/runner";
import { NameSchema } from "@commontools/runner/schemas";
import { StorageManager } from "../../runner/src/storage/cache.ts";
import {
  createSigilLinkFromParsedLink,
  isSigilLink,
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
  CharmCreateFromProgramRequest,
  type CharmCreateFromUrlRequest,
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
} from "../ipc.ts";
import { HttpProgramResolver } from "@commontools/js-compiler";
import { setLLMUrl } from "@commontools/llm";
import { cellToCellRef, cellToCharmInfo } from "./utils.ts";
import { LINK_V1_TAG } from "@commontools/runtime-client";
import { isCellResult } from "../../runner/src/query-result-proxy.ts";

export class WorkerRuntime {
  private runtime: Runtime;
  private charmManager: CharmManager;
  private cc: CharmsController;
  private _isDisposed = false;
  private disposingPromise: Promise<void> | undefined;
  private subscriptions = new Map<string, Cancel>();

  private constructor(
    runtime: Runtime,
    charmManager: CharmManager,
    cc: CharmsController,
  ) {
    this.runtime = runtime;
    this.charmManager = charmManager;
    this.cc = cc;
  }

  static async initialize(data: InitializationData): Promise<WorkerRuntime> {
    const apiUrlObj = new URL(data.apiUrl);
    const identity = await Identity.deserialize(data.identity);
    const spaceIdentity = data.spaceIdentity
      ? await Identity.deserialize(data.spaceIdentity)
      : undefined;

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

    return new WorkerRuntime(runtime, charmManager, cc);
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
      console.log(
        "SINK",
        cell.getAsNormalizedFullLink().id,
        isCell(sinkValue)
          ? `Cell<${sinkValue.getAsNormalizedFullLink().id}>`
          : sinkValue,
        convertCellsToLinks(sinkValue),
      );
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
      if (isCellResult(sinkValue)) {
        if (cell.equals(sinkValue)) {
          value = unwrapProxy(sinkValue);
          console.log("CELL RESULT", value);
        } else {
          console.warn("NOT EQUALS!");
        }
      }

      /*
      // Follow Cell/CellResult references
      while (value && typeof value === "object" && "getRaw" in value) {
        const rawValue = (value as Cell<unknown>).getRaw?.({
          meta: { scheduling: "ignore" },
        });
        if (rawValue == null) break;
        value = rawValue;
      }

      // Follow SigilLinks to get actual data (like sync() does on main thread)
      const visited = new Set<string>();
      let isSelfReference = false;
      while (isSigilLink(value)) {
        const linkKey = JSON.stringify(value);
        if (visited.has(linkKey)) break; // Prevent infinite loops
        visited.add(linkKey);

        // Resolve the link by getting the cell's value
        const linkedCell = this.runtime.getCellFromLink(value, cellRef.schema);

        // Check for self-reference: if the link points back to the original cell,
        // skip sending this update to avoid infinite subscription loops
        if (cell.equals(linkedCell)) {
          isSelfReference = true;
          break;
        }

        const linkedValue = linkedCell.getRaw?.({
          meta: { scheduling: "ignore" },
        });
        if (linkedValue == null) break;
        value = linkedValue;
      }

      // Don't send self-referential values - they create infinite loops
      if (isSelfReference) {
        return;
      }

      // Also check if value is a Cell that equals the original cell
      // (would become a self-referential link after convertCellsToLinks)
      if (value && typeof value === "object" && "equals" in value) {
        if ((value as Cell<unknown>).equals(cell)) {
          return;
        }
      }
      */

      // Post update notification to main thread
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

  async handleCharmCreateFromUrl(
    request: CharmCreateFromUrlRequest,
  ): Promise<Omit<CharmResultResponse, "msgId">> {
    const program = await this.cc.manager().runtime.harness.resolve(
      new HttpProgramResolver(request.entryUrl),
    );

    const charm = await this.cc.create<NameSchema>(program, {
      input: request.argument as object | undefined,
      start: request.run ?? true,
    }, request.cause);
    const result = charm.result.getCell();
    return {
      charm: cellToCharmInfo(charm.getCell()),
      result: cellToCellRef(result),
    };
  }

  async handleCharmCreateFromProgram(
    request: CharmCreateFromProgramRequest,
  ): Promise<Omit<CharmResultResponse, "msgId">> {
    const charm = await this.cc.create<NameSchema>(request.program, {
      input: request.argument as object | undefined,
      start: request.run ?? true,
    }, request.cause);
    const result = charm.result.getCell();
    return {
      charm: cellToCharmInfo(charm.getCell()),
      result: cellToCellRef(result),
    };
  }

  async handleGetSpaceRootPattern(
    _: PatternGetSpaceRoot,
  ): Promise<Omit<CharmResultResponse, "msgId">> {
    const charm = await this.cc.ensureDefaultPattern();
    const result = charm.result.getCell();
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
      result: cellToCellRef(cell),
    };
  }

  async handleCharmGet(
    request: CharmGetRequest,
  ): Promise<{ charm: CharmInfo } | null> {
    const charm = await this.cc.get(request.charmId, request.runIt);
    return charm ? { charm: cellToCharmInfo(charm.getCell()) } : null;
  }

  async handleCharmRemove(request: CharmRemoveRequest): Promise<void> {
    await this.cc.remove(request.charmId);
  }

  async handleCharmStart(request: CharmStartRequest): Promise<void> {
    await this.cc.start(request.charmId);
  }

  async handleCharmStop(request: CharmStopRequest): Promise<void> {
    await this.cc.stop(request.charmId);
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
