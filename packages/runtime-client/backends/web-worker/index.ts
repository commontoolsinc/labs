/**
 * This is an entry point for a worker script that runs a local RuntimeWorker
 * that can communicate with a corresponding RuntimeClient.
 *
 * Imports from `@commonfabric/runner` may be used freely in this directory.
 */
import "core-js/proposals/explicit-resource-management";
import "core-js/proposals/async-explicit-resource-management";

import {
  IPCRemoteResponse,
  isIPCClientMessage,
  isIPCClientNotification,
  RequestType,
} from "../../protocol/mod.ts";
import { RuntimeProcessor } from "../mod.ts";
import { getLogger } from "@commonfabric/utils/logger";

// Count-only ledger of request traffic as seen by the worker: one
// `received/<type>` per request that reached this message handler and one
// `responded/<type>` (or `responded-error/<type>`) per reply posted back.
// Counts increment even while the logger is disabled and the lazy args are
// never evaluated, so this costs ~nothing per request. Read back through
// `getLoggerCounts()`, and paired with the main thread's pending-request
// table it classifies a stuck request: absent from `received` means delivery
// starved; received without a matching `responded` means the handler never
// returned; both present means the response was lost in transit.
const ipcLogger = getLogger("runtime-worker.ipc", { enabled: false });

let worker: RuntimeProcessor | undefined;
let workerInitialization: Promise<RuntimeProcessor> | undefined;

const CONSOLE_LEVELS = ["log", "warn", "error"] as const;
type ConsoleLevel = (typeof CONSOLE_LEVELS)[number];
type ConsoleMethod = (...args: unknown[]) => void;

// The worker's original console methods, saved while the bridge is installed.
// `undefined` means the bridge is off and `console` is untouched, so disabled
// forwarding adds no per-log cost.
let savedConsole: Record<ConsoleLevel, ConsoleMethod> | undefined;

function formatConsoleArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  // Errors serialize to `{}` under JSON.stringify (message/stack are
  // non-enumerable), which would drop exactly the detail this bridge exists
  // to surface, so forward the stack (or name/message) instead.
  if (arg instanceof Error) return arg.stack ?? `${arg.name}: ${arg.message}`;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

/**
 * Patch the worker's `console.log`/`warn`/`error` so each call also posts a
 * structured `{ __workerConsole: { level, text } }` message that the web-worker
 * transport re-emits on the page console. The original method is called first,
 * so nothing is lost in the worker's own console. No-op if already installed.
 */
function installWorkerConsoleBridge(): void {
  if (savedConsole) return;
  const saved: Record<ConsoleLevel, ConsoleMethod> = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  savedConsole = saved;

  for (const level of CONSOLE_LEVELS) {
    console[level] = (...args: unknown[]) => {
      saved[level].apply(console, args);
      try {
        self.postMessage({
          __workerConsole: {
            level,
            text: args.map(formatConsoleArg).join(" "),
          },
        });
      } catch {
        // A non-cloneable payload or a closed channel must not break the
        // logging call itself.
      }
    };
  }
}

/**
 * Restore the worker's native console methods, returning `console` to a state
 * with no forwarding overhead. No-op if the bridge is not installed.
 */
function uninstallWorkerConsoleBridge(): void {
  if (!savedConsole) return;
  for (const level of CONSOLE_LEVELS) {
    console[level] = savedConsole[level];
  }
  savedConsole = undefined;
}

function setWorkerConsoleBridge(enabled: boolean): void {
  if (enabled) installWorkerConsoleBridge();
  else uninstallWorkerConsoleBridge();
}

self.addEventListener("message", async (event: MessageEvent) => {
  const message = event.data;

  // One-way notifications carry no msgId and get no response. Drop them once
  // the worker is gone or disposed; in teardown the main thread may still be
  // flushing fire-and-forget signals.
  if (isIPCClientNotification(message)) {
    try {
      if (worker && !worker.isDisposed()) {
        worker.handleNotification(message);
      }
    } catch (error) {
      console.error("[RuntimeWorker] Notification error:", error);
    }
    return;
  }

  try {
    if (!isIPCClientMessage(message)) {
      throw new Error(`Invalid IPC request: ${JSON.stringify(message)}`);
    }
    const { msgId, data: request } = message;
    ipcLogger.debug(`received/${request.type}`, () => []);

    if (request.type === RequestType.Initialize) {
      if (workerInitialization) {
        throw new Error("Initialization of WorkerRuntime already attempted.");
      }
      setWorkerConsoleBridge(request.data.forwardWorkerConsole === true);
      workerInitialization = RuntimeProcessor.initialize(
        request.data,
      );
      worker = await workerInitialization;
      ipcLogger.debug(`responded/${request.type}`, () => []);
      self.postMessage({ msgId: message.msgId });
      return;
    }

    // Toggling console forwarding is handled here, not in the RuntimeProcessor,
    // because the console patch lives in this worker entry. It is independent
    // of runtime initialization, so it is answered before the init check.
    if (request.type === RequestType.SetForwardWorkerConsole) {
      setWorkerConsoleBridge(request.enabled);
      ipcLogger.debug(`responded/${request.type}`, () => []);
      self.postMessage({ msgId });
      return;
    }

    if (!worker) {
      throw new Error("WorkerRuntime not initialized.");
    }
    if (worker.isDisposed()) {
      // After disposal, silently ack any late-arriving requests.
      // Components may still be unsubscribing or finishing in-flight
      // operations during teardown — no point erroring on these.
      ipcLogger.debug(`responded/${request.type}`, () => []);
      self.postMessage({ msgId });
      return;
    }

    const response = await worker.handleRequest(request);
    const payload: IPCRemoteResponse = response !== undefined
      ? { msgId, data: response }
      : { msgId };
    ipcLogger.debug(`responded/${request.type}`, () => []);
    self.postMessage(payload);
  } catch (error) {
    console.error("[RuntimeWorker] Error:", error);
    const type = isIPCClientMessage(message) ? message.data.type : "invalid";
    ipcLogger.debug(`responded-error/${type}`, () => []);
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
