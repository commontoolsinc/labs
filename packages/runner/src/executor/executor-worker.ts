/// <reference lib="webworker" />

import type { MemorySpace } from "@commonfabric/memory/interface";
import type {
  BranchName,
  WireMemoryProtocolFlags,
} from "@commonfabric/memory/v2";
import {
  type Cell,
  entityIdFrom,
  type ExperimentalOptions,
  Runtime,
  runtimePresets,
} from "../index.ts";
import type { IStorageNotification } from "../storage/interface.ts";
import { HostStorageManager } from "../storage/v2-host-provider.ts";

type WorkerRequest = {
  type: "initialize" | "set-demand" | "wake" | "stop";
  requestId: number;
  space?: string;
  branch?: BranchName;
  principal?: string;
  leaseGeneration?: number;
  pieces?: string[];
  port?: MessagePort;
  apiUrl?: string;
  patternApiUrl?: string;
  experimental?: ExperimentalOptions;
  protocolFlags?: Partial<WireMemoryProtocolFlags>;
};

const worker = globalThis as unknown as DedicatedWorkerGlobalScope;
let runtime: Runtime | null = null;
let storage: HostStorageManager | null = null;
let space: MemorySpace | null = null;
const demanded = new Map<string, Cell<unknown>>();
let cancelStorageSubscription: (() => void) | null = null;
let work = Promise.resolve();
let stopped = false;

const denyExternalBuiltinFetch: typeof globalThis.fetch = () =>
  Promise.reject(
    new TypeError("external builtins are disabled in executor shadow mode"),
  );

const enqueue = (operation: () => Promise<void>): Promise<void> => {
  const next = work.then(operation, operation);
  work = next.catch(() => undefined);
  return next;
};

const normalizePieceId = (pieceId: string): string =>
  pieceId.startsWith("of:") ? pieceId.slice(3) : pieceId;

const pullDemand = async (): Promise<void> => {
  for (const cell of demanded.values()) await cell.pull();
};

const replaceDemand = async (pieces: readonly string[]): Promise<void> => {
  if (runtime === null || space === null) {
    throw new Error("executor Worker is not initialized");
  }
  const next = [...new Set(pieces)].sort();
  const nextSet = new Set(next);
  for (const [pieceId, cell] of demanded) {
    if (nextSet.has(pieceId)) continue;
    runtime.runner.stop(cell);
    demanded.delete(pieceId);
  }
  for (const pieceId of next) {
    if (demanded.has(pieceId)) continue;
    const cell = runtime.getCellFromEntityId<unknown>(
      space,
      entityIdFrom(normalizePieceId(pieceId)),
    );
    await cell.sync();
    await runtime.start(cell);
    demanded.set(pieceId, cell);
  }
  await pullDemand();
};

const initialize = async (request: WorkerRequest): Promise<void> => {
  if (runtime !== null || storage !== null) {
    throw new Error("executor Worker is already initialized");
  }
  if (
    typeof request.space !== "string" ||
    typeof request.principal !== "string" ||
    typeof request.apiUrl !== "string" ||
    typeof request.patternApiUrl !== "string" ||
    !(request.port instanceof MessagePort) || !Array.isArray(request.pieces) ||
    !request.pieces.every((piece) => typeof piece === "string") ||
    !Number.isSafeInteger(request.leaseGeneration) ||
    Number(request.leaseGeneration) <= 0
  ) {
    throw new Error("invalid executor Worker initialization");
  }
  space = request.space as MemorySpace;
  storage = HostStorageManager.connect({
    port: request.port,
    principal: request.principal as MemorySpace,
    space,
    branch: request.branch ?? "",
    protocolFlags: request.protocolFlags,
    shadowWrites: true,
  });
  runtime = new Runtime(runtimePresets.productionServer({
    apiUrl: new URL(request.apiUrl),
    patternApiUrl: new URL(request.patternApiUrl),
    storageManager: storage,
    experimental: {
      ...request.experimental,
      persistentSchedulerState: true,
      serverPrimaryExecution: true,
    },
    fetch: denyExternalBuiltinFetch,
    externalSinkDisposition: "suppress",
  }));
  const storageSubscription: IStorageNotification = {
    next(notification) {
      if (notification.type === "integrate" && !stopped) {
        queueMicrotask(() => void enqueue(pullDemand));
      }
      return { done: false };
    },
  };
  storage.subscribe(storageSubscription);
  cancelStorageSubscription = () => storage?.unsubscribe(storageSubscription);
  await replaceDemand(request.pieces);
};

const stop = async (): Promise<void> => {
  if (stopped) return;
  stopped = true;
  cancelStorageSubscription?.();
  cancelStorageSubscription = null;
  await work;
  if (runtime !== null) {
    await runtime.settled();
    await runtime.dispose();
  } else if (storage !== null) {
    await storage.close();
  }
  runtime = null;
  storage = null;
  space = null;
  demanded.clear();
};

const handle = async (request: WorkerRequest): Promise<void> => {
  if (!Number.isSafeInteger(request.requestId)) {
    throw new Error("executor Worker request has no request id");
  }
  switch (request.type) {
    case "initialize":
      await initialize(request);
      worker.postMessage({ type: "ready", requestId: request.requestId });
      return;
    case "set-demand":
      if (!Array.isArray(request.pieces)) {
        throw new Error("executor demand is malformed");
      }
      await enqueue(() => replaceDemand(request.pieces!));
      break;
    case "wake":
      await enqueue(pullDemand);
      break;
    case "stop":
      await stop();
      break;
    default:
      throw new Error("unknown executor Worker request");
  }
  worker.postMessage({ type: "complete", requestId: request.requestId });
};

worker.addEventListener("message", (event: MessageEvent<unknown>) => {
  const request = event.data as WorkerRequest;
  void handle(request).catch((error) => {
    worker.postMessage({
      type: "fatal",
      requestId: request?.requestId,
      message: error instanceof Error ? error.message : String(error),
    });
  });
});

worker.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
  worker.postMessage({
    type: "fatal",
    message: event.reason instanceof Error
      ? event.reason.message
      : String(event.reason),
  });
});

worker.postMessage({ type: "booted" });
