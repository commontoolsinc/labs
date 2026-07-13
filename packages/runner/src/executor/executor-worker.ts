/// <reference lib="webworker" />

import type { MemorySpace } from "@commonfabric/memory/interface";
import {
  type ActionClaimKey,
  type BranchName,
  canonicalSchedulerPieceIdForDemandRoot,
  type ExecutionClaim,
  type WireMemoryProtocolFlags,
} from "@commonfabric/memory/v2";
import {
  type Action,
  type Cell,
  entityIdFrom,
  type ExperimentalOptions,
  Runtime,
  runtimePresets,
} from "../index.ts";
import { createExecutorActionTransactionRouter } from "./action-transaction-router.ts";
import { HostStorageManager } from "../storage/v2-host-provider.ts";
import {
  isPermanentRejection,
  isTerminalRejection,
} from "../storage/rejection.ts";
import { prepareExecutorDemandPiece } from "./writer-discovery.ts";
import {
  createServerBuiltinBrokerClient,
  type ServerBuiltinBrokerClient,
} from "./server-builtin-channel.ts";
import { getTransactionSourceAction } from "../storage/transaction-source-context.ts";
import { SelectiveDemandWakeQueue } from "./selective-demand-wake.ts";

type WorkerRequest = {
  type:
    | "initialize"
    | "set-demand"
    | "wake"
    | "settle"
    | "stop"
    | "run-claimed-action";
  requestId?: number;
  space?: string;
  branch?: BranchName;
  principal?: string;
  leaseGeneration?: number;
  pieces?: string[];
  port?: MessagePort;
  builtinBrokerPort?: MessagePort;
  apiUrl?: string;
  patternApiUrl?: string;
  experimental?: ExperimentalOptions;
  protocolFlags?: Partial<WireMemoryProtocolFlags>;
  claim?: ExecutionClaim;
  demandGeneration?: number;
  resetClaims?: boolean;
};

const worker = globalThis as unknown as DedicatedWorkerGlobalScope;
let runtime: Runtime | null = null;
let storage: HostStorageManager | null = null;
let builtinBroker: ServerBuiltinBrokerClient | null = null;
let space: MemorySpace | null = null;
let branch: BranchName = "";
const demanded = new Map<string, Cell<unknown>>();
const candidateActions = new Map<string, Action>();
let claimsByAction = new WeakMap<object, ExecutionClaim>();
let demandGeneration = 0;
let selectiveWake: SelectiveDemandWakeQueue | null = null;
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

const claimKey = (claim: ActionClaimKey): string =>
  JSON.stringify({
    branch: claim.branch,
    space: claim.space,
    contextKey: claim.contextKey,
    pieceId: claim.pieceId,
    actionId: claim.actionId,
    actionKind: claim.actionKind,
    implementationFingerprint: claim.implementationFingerprint,
    runtimeFingerprint: claim.runtimeFingerprint,
  });

const invalidatesExecutorClaim = (error: unknown): boolean => {
  const named = error as { name?: string } | undefined | null;
  return named?.name === "StorageTransactionAborted" ||
    named?.name === "AuthorizationError" ||
    isPermanentRejection(named) || isTerminalRejection(named);
};

const pullDemand = async (
  schedulerPieceIds?: ReadonlySet<string>,
): Promise<void> => {
  for (const [pieceId, cell] of demanded) {
    if (
      schedulerPieceIds !== undefined &&
      !schedulerPieceIds.has(canonicalSchedulerPieceIdForDemandRoot(pieceId))
    ) {
      continue;
    }
    await cell.pull();
  }
};

const replaceDemand = async (
  pieces: readonly string[],
  resetClaims = false,
): Promise<void> => {
  if (runtime === null || space === null) {
    throw new Error("executor Worker is not initialized");
  }
  const next = [...new Set(pieces)].sort();
  const nextSet = new Set(next);
  if (resetClaims) {
    for (const cell of demanded.values()) runtime.runner.stop(cell);
    demanded.clear();
    candidateActions.clear();
    claimsByAction = new WeakMap<object, ExecutionClaim>();
  }
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
    const discovery = await prepareExecutorDemandPiece({
      runtime,
      branch,
      pieceId,
      target: cell,
      instantiate: () => runtime!.start(cell),
    });
    demanded.set(pieceId, cell);
    worker.postMessage({ type: "writer-discovery", discovery });
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
    !(request.builtinBrokerPort instanceof MessagePort) ||
    !request.pieces.every((piece) => typeof piece === "string") ||
    !Number.isSafeInteger(request.leaseGeneration) ||
    Number(request.leaseGeneration) <= 0
  ) {
    throw new Error("invalid executor Worker initialization");
  }
  space = request.space as MemorySpace;
  branch = request.branch ?? "";
  const actionTransactionRouter = createExecutorActionTransactionRouter({
    servedSpace: space,
    branch,
    builtinBrokerAvailable: true,
    claimForAction: (action) => claimsByAction.get(action),
    onCandidate: (candidate, sourceAction) => {
      candidateActions.set(
        claimKey(candidate.claimKey),
        sourceAction as Action,
      );
      worker.postMessage({
        type: "candidate-claim",
        candidate: {
          ...candidate,
          ...(demandGeneration > 0 ? { demandGeneration } : {}),
        },
      });
    },
    onDiagnostic: (diagnostic) => {
      worker.postMessage({ type: "candidate-diagnostic", diagnostic });
    },
    onUnserved: (claim, sourceAction, diagnosticCode) => {
      claimsByAction.delete(sourceAction);
      worker.postMessage({ type: "unserved-claim", claim, diagnosticCode });
    },
    onInvalidated: (claim, sourceAction, diagnosticCode) => {
      claimsByAction.delete(sourceAction);
      worker.postMessage({
        type: "invalidated-claim",
        claim,
        diagnosticCode,
      });
    },
  });
  storage = HostStorageManager.connect({
    port: request.port,
    principal: request.principal as MemorySpace,
    space,
    branch,
    protocolFlags: request.protocolFlags,
    shadowWrites: true,
    actionTransactionRouter,
    onAcceptedCommitIntegrated(notice) {
      selectiveWake?.push(
        notice.staleDemandedReaders.map((reader) => reader.pieceId),
      );
    },
  });
  builtinBroker = createServerBuiltinBrokerClient({
    port: request.builtinBrokerPort,
    claimForRequest: () => {
      const sourceAction = getTransactionSourceAction();
      return sourceAction === undefined
        ? undefined
        : claimsByAction.get(sourceAction);
    },
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
    externalSinkDisposition: (sourceAction) =>
      sourceAction !== undefined && claimsByAction.has(sourceAction)
        ? "allow"
        : "suppress",
  }));
  runtime.installServerBuiltinFetch((builtinId, rawUrl, init) =>
    builtinBroker!.fetch(builtinId, rawUrl, init)
  );
  runtime.scheduler.setActionCommitRejectionHandler((action, error) => {
    const claim = claimsByAction.get(action);
    if (claim === undefined || !invalidatesExecutorClaim(error)) return;
    claimsByAction.delete(action);
    worker.postMessage({
      type: "invalidated-claim",
      claim,
      diagnosticCode: `commit-rejected:${
        (error as { name?: string })?.name ?? "unknown"
      }`,
    });
  });
  selectiveWake = new SelectiveDemandWakeQueue((pieceIds) =>
    enqueue(() => pullDemand(new Set(pieceIds)))
  );
  await replaceDemand(request.pieces);
};

const runClaimedAction = async (claim: ExecutionClaim): Promise<void> => {
  if (runtime === null || storage === null || space === null) {
    throw new Error("executor Worker is not initialized");
  }
  const action = candidateActions.get(claimKey(claim));
  if (action === undefined) {
    throw new Error("claimed executor action is no longer live");
  }
  storage.discardShadowWritesForAction(space, action);
  claimsByAction.set(action, claim);
  (action as Action & { prepareClaimedRerun?: () => void })
    .prepareClaimedRerun?.();
  await runtime.scheduler.run(action);
};

const settle = async (): Promise<number> => {
  if (runtime === null || storage === null) return 0;
  while (true) {
    await work;
    const throughSeq = await storage.acceptedCommitsSettled();
    await selectiveWake?.settled();
    await work;
    await runtime.settled();
    await storage.synced();
    const confirmedThroughSeq = await storage.acceptedCommitsSettled();
    await selectiveWake?.settled();
    await work;
    if (confirmedThroughSeq === throughSeq) return confirmedThroughSeq;
  }
};

const stop = async (): Promise<void> => {
  if (stopped) return;
  stopped = true;
  await settle();
  if (runtime !== null) {
    await runtime.dispose();
  } else if (storage !== null) {
    await storage.close();
  }
  builtinBroker?.dispose();
  builtinBroker = null;
  runtime = null;
  storage = null;
  space = null;
  branch = "";
  selectiveWake = null;
  demanded.clear();
  candidateActions.clear();
};

const handle = async (request: WorkerRequest): Promise<void> => {
  if (request.type === "run-claimed-action") {
    if (request.claim === undefined) {
      throw new Error("claimed executor rerun has no claim");
    }
    await enqueue(() => runClaimedAction(request.claim!));
    return;
  }
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
      if (
        !Number.isSafeInteger(request.demandGeneration) ||
        Number(request.demandGeneration) < demandGeneration
      ) {
        throw new Error("executor demand generation is malformed");
      }
      demandGeneration = Number(request.demandGeneration);
      await enqueue(() => replaceDemand(request.pieces!, request.resetClaims));
      break;
    case "wake":
      await enqueue(pullDemand);
      break;
    case "settle": {
      const dataSeq = await settle();
      worker.postMessage({
        type: "settled",
        requestId: request.requestId,
        dataSeq,
      });
      return;
    }
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
