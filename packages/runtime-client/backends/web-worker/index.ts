/**
 * This is an entry point for a worker script that runs a local RuntimeWorker
 * that can communicate with a corresponding RuntimeClient.
 *
 * Imports from `@commontools/runner` may be used freely in this directory.
 */

import {
  IPCRemoteResponse,
  isIPCClientMessage,
  RequestType,
} from "../../protocol/mod.ts";
import { RuntimeProcessor } from "../mod.ts";

let worker: RuntimeProcessor | undefined;
let workerInitialization: Promise<RuntimeProcessor> | undefined;

self.addEventListener("message", async (event: MessageEvent) => {
  const message = event.data;

  try {
    if (!isIPCClientMessage(message)) {
      throw new Error(`Invalid IPC request: ${JSON.stringify(message)}`);
    }
    const { msgId, data: request } = message;

    if (request.type === RequestType.Initialize) {
      if (workerInitialization) {
        throw new Error("Initialization of WorkerRuntime already attempted.");
      }
      workerInitialization = RuntimeProcessor.initialize(
        request.data,
      );
      worker = await workerInitialization;
      self.postMessage({ msgId: message.msgId });
      return;
    }

    if (!worker) {
      throw new Error("WorkerRuntime not initialized.");
    }
    if (worker.isDisposed()) {
      // After disposal, silently ack any late-arriving requests.
      // Components may still be unsubscribing or finishing in-flight
      // operations during teardown — no point erroring on these.
      self.postMessage({ msgId });
      return;
    }

    const response = await worker.handleRequest(request);
    const payload: IPCRemoteResponse = response !== undefined
      ? { msgId, data: response }
      : { msgId };
    self.postMessage(payload);
  } catch (error) {
    console.error("[RuntimeWorker] Error:", error);
    self.postMessage({
      msgId: message.msgId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

if (typeof self !== "undefined" && self.postMessage) {
  // This is a web worker transport only message, coordinating
  // with the client indicating the web worker is active
  self.postMessage("READY");
}
