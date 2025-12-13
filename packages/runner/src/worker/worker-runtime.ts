/**
 * Worker Runtime Script
 *
 * This script runs inside a web worker and creates/manages a Runtime instance
 * with CharmManager for charm operations.
 * Communication with the main thread happens via IPC messages.
 */

import { Identity, type Session } from "@commontools/identity";
import {
  charmId,
  CharmManager,
  getRecipeIdFromCharm,
  NameSchema,
} from "@commontools/charm";
import { CharmsController } from "@commontools/charm/ops";
import { Runtime } from "../runtime.ts";
import { StorageManager } from "../storage/cache.ts";
import { type Cell, convertCellsToLinks } from "../cell.ts";
import { isSigilLink } from "../link-utils.ts";
import type { Cancel } from "../cancel.ts";
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
  type CharmInfo,
  type CharmRemoveRequest,
  type CharmStartRequest,
  type CharmStopRequest,
  CharmSyncPatternRequest,
  type GetCellFromEntityIdRequest,
  type GetCellFromLinkRequest,
  type GetCellRequest,
  type InitializationData,
  type InitializeRequest,
  isWorkerIPCRequest,
  RuntimeWorkerMessageType,
} from "./ipc-protocol.ts";
import { HttpProgramResolver } from "@commontools/js-compiler";

// Runtime state
let runtime: Runtime | null = null;
let charmManager: CharmManager | null = null;
let charmsController: CharmsController | null = null;
let session: Session | null = null;
let initialized = false;

// Subscription tracking
const subscriptions = new Map<string, Cancel>();

/**
 * Initialize the runtime with the provided configuration.
 */
async function initialize(data: InitializationData): Promise<void> {
  if (initialized) {
    console.warn("[RuntimeWorker] Already initialized, skipping");
    return;
  }

  const apiUrlObj = new URL(data.apiUrl);
  const identity = await Identity.deserialize(data.identity);
  const spaceIdentity = data.spaceIdentity
    ? await Identity.deserialize(data.spaceIdentity)
    : undefined;

  session = {
    spaceIdentity,
    as: identity,
    space: data.spaceDid,
    spaceName: data.spaceName,
  };

  runtime = new Runtime({
    apiUrl: apiUrlObj,
    storageManager: StorageManager.open({
      as: identity,
      spaceIdentity: spaceIdentity,
      address: new URL("/api/storage/memory", data.apiUrl),
    }),
    recipeEnvironment: { apiUrl: apiUrlObj },

    // Forward console messages to main thread
    consoleHandler: ({ metadata, method, args }) => {
      self.postMessage({
        type: RuntimeWorkerMessageType.ConsoleMessage,
        metadata,
        method,
        args,
      });
      return args;
    },

    // Forward navigation requests to main thread
    navigateCallback: (target) => {
      self.postMessage({
        type: RuntimeWorkerMessageType.NavigateRequest,
        targetCellRef: {
          link: target.getAsLink(),
          schema: undefined,
        },
      });
    },

    // Forward errors to main thread
    errorHandlers: [
      (error) => {
        self.postMessage({
          type: RuntimeWorkerMessageType.ErrorReport,
          message: error.message,
          charmId: error.charmId,
          space: error.space,
          recipeId: error.recipeId,
          spellId: error.spellId,
        });
      },
    ],
  });

  // Initialize CharmManager
  charmManager = new CharmManager(session, runtime);
  await charmManager.synced();
  charmsController = new CharmsController(charmManager);

  initialized = true;
}

/**
 * Clean up and dispose the runtime.
 */
async function dispose(): Promise<void> {
  if (!initialized || !runtime) {
    return;
  }

  // Cancel all subscriptions
  for (const cancel of subscriptions.values()) {
    cancel();
  }
  subscriptions.clear();

  // Ensure storage is synced before cleanup
  await runtime.storageManager.synced();
  await runtime.dispose();
  runtime = null;
  initialized = false;
}

/**
 * Get cell value from a cell reference.
 * Handles both CellGetRequest and CellSyncRequest (they have the same shape).
 */
function handleCellGet(
  request: CellGetRequest | CellSyncRequest,
): { value: unknown } {
  if (!runtime) throw new Error("Runtime not initialized");

  const cell = runtime.getCellFromLink(
    request.cellRef.link,
    request.cellRef.schema,
  );
  const value = cell.get();

  // For serialization across the worker boundary, we need to convert
  // cell references to links but preserve the actual data structure.
  // Use getRaw if available to get the plain data, otherwise use convertCellsToLinks.
  // getRaw returns the raw storage value without the CellResult proxy wrapper.
  const rawValue = cell.getRaw?.({ meta: { scheduling: "ignore" } }) ?? value;
  const converted = convertCellsToLinks(rawValue);

  return { value: converted };
}

/**
 * Set cell value.
 */
function handleCellSet(request: CellSetRequest): void {
  if (!runtime) throw new Error("Runtime not initialized");

  const tx = runtime.edit();
  const cell = runtime.getCellFromLink(
    request.cellRef.link,
    request.cellRef.schema,
  );
  cell.withTx(tx).set(request.value);
  tx.commit();
}

/**
 * Send event to a stream cell.
 */
function handleCellSend(request: CellSendRequest): void {
  if (!runtime) throw new Error("Runtime not initialized");

  const tx = runtime.edit();
  const cell = runtime.getCellFromLink(
    request.cellRef.link,
    request.cellRef.schema,
  );
  // Cast to any to access send method (streams have it)
  (cell.withTx(tx) as any).send(request.event);
  tx.commit();
}

/**
 * Subscribe to cell changes.
 */
function handleCellSubscribe(request: CellSubscribeRequest): void {
  if (!runtime) throw new Error("Runtime not initialized");

  const { cellRef, subscriptionId } = request;

  // Cancel existing subscription if any
  const existing = subscriptions.get(subscriptionId);
  if (existing) {
    existing();
    subscriptions.delete(subscriptionId);
  }

  const cell = runtime.getCellFromLink(cellRef.link, cellRef.schema);

  let hasCallbackFired = false;
  const cancel = cell.sink((sinkValue) => {
    if (!hasCallbackFired) {
      // Skip the initial callback -- the client side sink
      // will call this with its current value
      hasCallbackFired = true;
      return;
    }

    // Dereference the value to get actual data, matching sync() behavior.
    // This handles both Cell/CellResult objects and SigilLinks.
    let value: unknown = sinkValue;

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
    while (isSigilLink(value)) {
      const linkKey = JSON.stringify(value);
      if (visited.has(linkKey)) break; // Prevent infinite loops
      visited.add(linkKey);

      // Resolve the link by getting the cell's value
      const linkedCell = runtime!.getCellFromLink(value, cellRef.schema);
      const linkedValue = linkedCell.getRaw?.({
        meta: { scheduling: "ignore" },
      });
      if (linkedValue == null) break;
      value = linkedValue;
    }

    // Post update notification to main thread
    self.postMessage({
      type: RuntimeWorkerMessageType.CellUpdate,
      subscriptionId,
      value: convertCellsToLinks(value),
    });
  });

  subscriptions.set(subscriptionId, cancel);
}

/**
 * Unsubscribe from cell changes.
 */
function handleCellUnsubscribe(request: CellUnsubscribeRequest): void {
  const cancel = subscriptions.get(request.subscriptionId);
  if (cancel) {
    cancel();
    subscriptions.delete(request.subscriptionId);
  }
}

/**
 * Get a new cell with cause.
 */
function handleGetCell(request: GetCellRequest): { cellRef: CellRef } {
  if (!runtime) throw new Error("Runtime not initialized");

  const cell = runtime.getCell(
    request.space,
    request.cause,
    request.schema,
  );

  return {
    cellRef: {
      link: cell.getAsLink(),
      schema: request.schema,
    },
  };
}

/**
 * Get cell from link.
 */
function handleGetCellFromLink(
  request: GetCellFromLinkRequest,
): { cellRef: CellRef } {
  if (!runtime) throw new Error("Runtime not initialized");

  const cell = runtime.getCellFromLink(request.link, request.schema);

  return {
    cellRef: {
      link: cell.getAsLink(),
      schema: request.schema,
    },
  };
}

/**
 * Get cell from entity ID.
 */
function handleGetCellFromEntityId(
  request: GetCellFromEntityIdRequest,
): { cellRef: CellRef } {
  if (!runtime) throw new Error("Runtime not initialized");

  const cell = runtime.getCellFromEntityId(
    request.space,
    { "/": request.entityId },
    request.path,
    request.schema,
  );

  return {
    cellRef: {
      link: cell.getAsLink(),
      schema: request.schema,
    },
  };
}

/**
 * Wait for runtime to be idle.
 */
async function handleIdle(): Promise<void> {
  if (!runtime) throw new Error("Runtime not initialized");
  await runtime.idle();
}

// ============================================================================
// Charm Handlers
// ============================================================================

/**
 * Helper to convert a charm cell to CharmInfo
 */
function cellToCharmInfo(cell: Cell<unknown>): CharmInfo {
  const id = charmId(cell);
  if (!id) throw new Error("Cell is not a charm");
  return {
    id,
    cellRef: {
      link: cell.getAsLink(),
      schema: undefined,
    },
  };
}

/**
 * Create a new charm from a URL.
 */
async function handleCharmCreateFromUrl(
  request: CharmCreateFromUrlRequest,
): Promise<{ charm: CharmInfo }> {
  if (!charmsController) throw new Error("CharmsController not initialized");
  const program = await charmsController.manager().runtime.harness.resolve(
    new HttpProgramResolver(request.entryUrl),
  );

  const charm = await charmsController.create<NameSchema>(program, {
    input: request.argument as object | undefined,
    start: request.run ?? true,
  }, request.cause);

  return { charm: cellToCharmInfo(charm.getCell()) };
}

/**
 * Create a new charm from a Program.
 */
async function handleCharmCreateFromProgram(
  request: CharmCreateFromProgramRequest,
): Promise<{ charm: CharmInfo }> {
  if (!charmsController) throw new Error("CharmsController not initialized");
  const charm = await charmsController.create<NameSchema>(request.program, {
    input: request.argument as object | undefined,
    start: request.run ?? true,
  }, request.cause);

  return { charm: cellToCharmInfo(charm.getCell()) };
}

async function handleCharmSyncPattern(
  request: CharmSyncPatternRequest,
): Promise<{ charm: CharmInfo | null }> {
  if (!charmsController) throw new Error("CharmsController not initialized");
  const charm = await charmsController.get(request.charmId, true);
  if (!charm) return { charm: null };

  const cell = charm.getCell();
  const recipeId = getRecipeIdFromCharm(cell);
  const recipe = await cell.runtime.recipeManager.loadRecipe(
    recipeId,
    cell.space,
  );
  await cell.runtime.runSynced(cell, recipe);
  return { charm: cellToCharmInfo(cell) };
}

/**
 * Get a charm by ID.
 */
async function handleCharmGet(
  request: CharmGetRequest,
): Promise<{ charm: CharmInfo | null }> {
  if (!charmsController) throw new Error("CharmsController not initialized");

  const charm = await charmsController.get(request.charmId, request.runIt);
  if (!charm) return { charm: null };

  return { charm: cellToCharmInfo(charm.getCell()) };
}

/**
 * Remove a charm.
 */
async function handleCharmRemove(request: CharmRemoveRequest): Promise<void> {
  if (!charmsController) throw new Error("CharmsController not initialized");
  await charmsController.remove(request.charmId);
}

/**
 * Start a charm.
 */
async function handleCharmStart(request: CharmStartRequest): Promise<void> {
  if (!charmsController) throw new Error("CharmsController not initialized");
  await charmsController.start(request.charmId);
}

/**
 * Stop a charm.
 */
async function handleCharmStop(request: CharmStopRequest): Promise<void> {
  if (!charmsController) throw new Error("CharmsController not initialized");
  await charmsController.stop(request.charmId);
}

/**
 * Get all charms - returns cell ref for the charms list.
 */
function handleCharmGetAll(): { charmsListCellRef: CellRef } {
  if (!charmManager) throw new Error("CharmManager not initialized");

  const charmsCell = charmManager.getCharms();
  return {
    charmsListCellRef: {
      link: charmsCell.getAsLink(),
      schema: undefined,
    },
  };
}

/**
 * Wait for CharmManager to be synced.
 */
async function handleCharmSynced(): Promise<void> {
  if (!charmManager) throw new Error("CharmManager not initialized");
  await charmManager.synced();
}

// Message handler
self.addEventListener("message", async (event: MessageEvent) => {
  const message = event.data;

  //console.log("[incoming", message);
  try {
    if (!isWorkerIPCRequest(message)) {
      throw new Error(`Invalid IPC request: ${JSON.stringify(message)}`);
    }

    let response: Record<string, unknown> = { msgId: message.msgId };

    switch (message.type) {
      case RuntimeWorkerMessageType.Initialize:
        await initialize((message as InitializeRequest).data);
        break;

      case RuntimeWorkerMessageType.Dispose:
        await dispose();
        break;

      case RuntimeWorkerMessageType.CellGet:
        response = {
          ...response,
          ...handleCellGet(message as CellGetRequest),
        };
        break;

      case RuntimeWorkerMessageType.CellSet:
        handleCellSet(message as CellSetRequest);
        break;

      case RuntimeWorkerMessageType.CellSend:
        handleCellSend(message as CellSendRequest);
        break;

      case RuntimeWorkerMessageType.CellSync:
        // Sync is similar to get but ensures data is fetched from storage
        response = {
          ...response,
          ...handleCellGet(message as CellSyncRequest),
        };
        break;

      case RuntimeWorkerMessageType.CellSubscribe:
        handleCellSubscribe(message as CellSubscribeRequest);
        break;

      case RuntimeWorkerMessageType.CellUnsubscribe:
        handleCellUnsubscribe(message as CellUnsubscribeRequest);
        break;

      case RuntimeWorkerMessageType.GetCell:
        response = {
          ...response,
          ...handleGetCell(message as GetCellRequest),
        };
        break;

      case RuntimeWorkerMessageType.GetCellFromLink:
        response = {
          ...response,
          ...handleGetCellFromLink(message as GetCellFromLinkRequest),
        };
        break;

      case RuntimeWorkerMessageType.GetCellFromEntityId:
        response = {
          ...response,
          ...handleGetCellFromEntityId(message as GetCellFromEntityIdRequest),
        };
        break;

      case RuntimeWorkerMessageType.Idle:
        await handleIdle();
        break;

      // Charm operations
      case RuntimeWorkerMessageType.CharmCreateFromUrl:
        response = {
          ...response,
          ...(await handleCharmCreateFromUrl(
            message as CharmCreateFromUrlRequest,
          )),
        };
        break;

      case RuntimeWorkerMessageType.CharmCreateFromProgram:
        response = {
          ...response,
          ...(await handleCharmCreateFromProgram(
            message as CharmCreateFromProgramRequest,
          )),
        };
        break;

      case RuntimeWorkerMessageType.CharmSyncPattern:
        response = {
          ...response,
          ...(await handleCharmSyncPattern(message as CharmSyncPatternRequest)),
        };
        break;

      case RuntimeWorkerMessageType.CharmGet:
        response = {
          ...response,
          ...(await handleCharmGet(message as CharmGetRequest)),
        };
        break;

      case RuntimeWorkerMessageType.CharmRemove:
        await handleCharmRemove(message as CharmRemoveRequest);
        break;

      case RuntimeWorkerMessageType.CharmStart:
        await handleCharmStart(message as CharmStartRequest);
        break;

      case RuntimeWorkerMessageType.CharmStop:
        await handleCharmStop(message as CharmStopRequest);
        break;

      case RuntimeWorkerMessageType.CharmGetAll:
        response = {
          ...response,
          ...handleCharmGetAll(),
        };
        break;

      case RuntimeWorkerMessageType.CharmSynced:
        await handleCharmSynced();
        break;

      default:
        throw new Error(`Unknown message type: ${(message as any).type}`);
    }

    self.postMessage(response);
  } catch (error) {
    console.error("[RuntimeWorker] Error:", error);
    self.postMessage({
      msgId: message.msgId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Signal ready to the controller
if (typeof self !== "undefined" && self.postMessage) {
  self.postMessage({ type: RuntimeWorkerMessageType.Ready, msgId: -1 });
}
