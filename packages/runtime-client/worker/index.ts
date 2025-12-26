/**
 * This is an entry point for a worker script that runs a local RuntimeWorker
 * that can communicate with a corresponding RuntimeClient.
 *
 * Imports from `@commontools/runner` may be used freely in this directory.
 */

import {
  CellGetRequest,
  CellSendRequest,
  CellSetRequest,
  CellSubscribeRequest,
  CellSyncRequest,
  CellUnsubscribeRequest,
  CharmCreateFromProgramRequest,
  CharmCreateFromUrlRequest,
  CharmGetRequest,
  CharmGetSpaceDefault,
  CharmRemoveRequest,
  CharmStartRequest,
  CharmStopRequest,
  CharmSyncPatternRequest,
  GetCellRequest,
  InitializeRequest,
  isWorkerIPCRequest,
  RuntimeClientMessageType,
} from "../ipc.ts";
import { WorkerRuntime } from "./worker-runtime.ts";

let worker: WorkerRuntime | undefined;
let workerInitialization: Promise<WorkerRuntime> | undefined;

self.addEventListener("message", async (event: MessageEvent) => {
  const message = event.data;

  //console.log("[incoming", message);
  try {
    if (!isWorkerIPCRequest(message)) {
      throw new Error(`Invalid IPC request: ${JSON.stringify(message)}`);
    }

    let response: Record<string, unknown> = { msgId: message.msgId };

    if (message.type === RuntimeClientMessageType.Initialize) {
      if (workerInitialization) {
        throw new Error("Initialization of WorkerRuntime already attempted.");
      }
      workerInitialization = WorkerRuntime.initialize(
        (message as InitializeRequest).data,
      );
      worker = await workerInitialization;
      self.postMessage(response);
      return;
    }

    if (!worker) {
      throw new Error("WorkerRuntime not initialized.");
    }
    if (worker.isDisposed()) {
      throw new Error("WorkerRuntime is disposed.");
    }

    switch (message.type) {
      case RuntimeClientMessageType.Dispose:
        await worker.dispose();
        break;

      case RuntimeClientMessageType.CellGet:
        response = {
          ...response,
          ...worker.handleCellGet(message as CellGetRequest),
        };
        break;

      case RuntimeClientMessageType.CellSet:
        worker.handleCellSet(message as CellSetRequest);
        break;

      case RuntimeClientMessageType.CellSend:
        worker.handleCellSend(message as CellSendRequest);
        break;

      case RuntimeClientMessageType.CellSync:
        // Sync is similar to get but ensures data is fetched from storage
        response = {
          ...response,
          ...worker.handleCellGet(message as CellSyncRequest),
        };
        break;

      case RuntimeClientMessageType.CellSubscribe:
        worker.handleCellSubscribe(message as CellSubscribeRequest);
        break;

      case RuntimeClientMessageType.CellUnsubscribe:
        worker.handleCellUnsubscribe(message as CellUnsubscribeRequest);
        break;

      case RuntimeClientMessageType.GetCell:
        response = {
          ...response,
          ...worker.handleGetCell(message as GetCellRequest),
        };
        break;

      case RuntimeClientMessageType.Idle:
        await worker.handleIdle();
        break;

      // Charm operations
      case RuntimeClientMessageType.CharmCreateFromUrl:
        response = {
          ...response,
          ...(await worker.handleCharmCreateFromUrl(
            message as CharmCreateFromUrlRequest,
          )),
        };
        break;

      case RuntimeClientMessageType.CharmCreateFromProgram:
        response = {
          ...response,
          ...(await worker.handleCharmCreateFromProgram(
            message as CharmCreateFromProgramRequest,
          )),
        };
        break;

      case RuntimeClientMessageType.GetSpaceRootPattern:
        response = {
          ...response,
          ...(await worker.handleGetSpaceRootPattern(
            message as CharmGetSpaceDefault,
          )),
        };
        break;

      case RuntimeClientMessageType.CharmSyncPattern:
        response = {
          ...response,
          ...(await worker.handleCharmSyncPattern(
            message as CharmSyncPatternRequest,
          )),
        };
        break;

      case RuntimeClientMessageType.CharmGet:
        response = {
          ...response,
          ...(await worker.handleCharmGet(message as CharmGetRequest)),
        };
        break;

      case RuntimeClientMessageType.CharmRemove:
        await worker.handleCharmRemove(message as CharmRemoveRequest);
        break;

      case RuntimeClientMessageType.CharmStart:
        await worker.handleCharmStart(message as CharmStartRequest);
        break;

      case RuntimeClientMessageType.CharmStop:
        await worker.handleCharmStop(message as CharmStopRequest);
        break;

      case RuntimeClientMessageType.CharmGetAll:
        response = {
          ...response,
          ...worker.handleCharmGetAll(),
        };
        break;

      case RuntimeClientMessageType.CharmSynced:
        await worker.handleCharmSynced();
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

if (typeof self !== "undefined" && self.postMessage) {
  self.postMessage({ type: RuntimeClientMessageType.Ready, msgId: -1 });
}
