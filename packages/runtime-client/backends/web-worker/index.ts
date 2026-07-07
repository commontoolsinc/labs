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
import { unrefTimer } from "@commonfabric/utils/sleep";

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

// Worker-side request decomposition, recorded into timing stats (they record
// even while the logger is disabled) under a `runner.`-prefixed logger so the
// integration-test load summaries pick them up:
//   runner.ipc/delivery/<type> — postMessage send → this handler running,
//     i.e. how long the request sat in the worker's macrotask queue. Uses the
//     envelope's `sentEpochMs` (timeOrigin-based, comparable across threads).
//   runner.ipc/handle/<type>   — handleRequest start → settled.
// A slow client round-trip decomposes as delivery (worker starved) vs handle
// (handler awaited something slow) vs the residue (response return path).
const ipcTimingLogger = getLogger("runner.ipc", { enabled: false });

// Worker event-loop lag probe (`runner.loop/workerLag`): each tick records how
// far past schedule the timer fired — long synchronous stretches (compile,
// large traverses, GC) and CPU starvation show up as its max/p95. Companion to
// the main-thread `loop/mainLag`; together they attribute a slow round-trip to
// a wedged thread rather than a slow handler. Lives for the worker's lifetime.
const LOOP_LAG_SAMPLE_MS = 100;
const loopLagLogger = getLogger("runner.loop", { enabled: false });
{
  let expected = performance.now() + LOOP_LAG_SAMPLE_MS;
  // Unref'd so that a unit test importing this worker entry to drive the
  // message handler (e.g. web-worker-console-bridge.test.ts), without
  // spawning/terminating a real worker, does not leak this interval or trip
  // Deno's op-leak sanitizer. In a real worker it runs for the worker's
  // lifetime as before.
  unrefTimer(setInterval(() => {
    const now = performance.now();
    const lag = now - expected;
    if (lag > 0) loopLagLogger.time(expected, now, "workerLag");
    expected = now + LOOP_LAG_SAMPLE_MS;
  }, LOOP_LAG_SAMPLE_MS));
}

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
    const receivedAt = performance.now();
    const sentEpochMs = (message as { sentEpochMs?: number }).sentEpochMs;
    if (typeof sentEpochMs === "number") {
      const deliveryMs = performance.timeOrigin + receivedAt - sentEpochMs;
      if (deliveryMs > 0) {
        ipcTimingLogger.time(
          receivedAt - deliveryMs,
          receivedAt,
          "delivery",
          request.type,
        );
      }
    }

    if (request.type === RequestType.Initialize) {
      if (workerInitialization) {
        throw new Error("Initialization of WorkerRuntime already attempted.");
      }
      setWorkerConsoleBridge(request.data.forwardWorkerConsole === true);
      workerInitialization = RuntimeProcessor.initialize(
        request.data,
      );
      worker = await workerInitialization;
      // Count the reply only once it is actually posted: if postMessage throws
      // (e.g. a non-cloneable payload) the catch below records a
      // `responded-error/*` instead, so the ledger never double-counts one
      // request as both a success and an error.
      self.postMessage({ msgId: message.msgId });
      ipcLogger.debug(`responded/${request.type}`, () => []);
      return;
    }

    // Toggling console forwarding is handled here, not in the RuntimeProcessor,
    // because the console patch lives in this worker entry. It is independent
    // of runtime initialization, so it is answered before the init check.
    if (request.type === RequestType.SetForwardWorkerConsole) {
      setWorkerConsoleBridge(request.enabled);
      self.postMessage({ msgId });
      ipcLogger.debug(`responded/${request.type}`, () => []);
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
      ipcLogger.debug(`responded/${request.type}`, () => []);
      return;
    }

    const handleStart = performance.now();
    let response;
    try {
      response = await worker.handleRequest(request);
    } finally {
      // Record handling latency whether or not the request threw, so
      // error-heavy periods do not silently underreport it.
      ipcTimingLogger.time(handleStart, "handle", request.type);
    }
    const payload: IPCRemoteResponse = response !== undefined
      ? { msgId, data: response }
      : { msgId };
    self.postMessage(payload);
    ipcLogger.debug(`responded/${request.type}`, () => []);
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
