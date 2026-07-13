/// <reference lib="webworker" />

import type { MemorySpace } from "@commonfabric/memory/interface";
import {
  type ActionClaimKey,
  actionClaimMapKey,
  type BranchName,
  canonicalSchedulerPieceIdForDemandRoot,
  type ExecutionClaim,
  type WireMemoryProtocolFlags,
} from "@commonfabric/memory/v2";
import {
  type Action,
  type Cancel,
  type Cell,
  entityIdFrom,
  type ExperimentalOptions,
  Runtime,
  runtimePresets,
} from "../index.ts";
import {
  CellDataUnavailableError,
  type UnavailableCellAddress,
} from "../cell-data-unavailable-error.ts";
import { createExecutorActionTransactionRouter } from "./action-transaction-router.ts";
import { HostStorageManager } from "../storage/v2-host-provider.ts";
import {
  ClaimedAttemptLifecycle,
  claimedAttemptRejection,
  deleteExactClaimForAction,
} from "./claimed-attempt-lifecycle.ts";
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
const instantiatedDemand = new Set<string>();
const pendingDemand = new Map<string, UnavailableCellAddress>();
const demandSinks = new Map<string, Cancel>();
const candidateActions = new Map<string, Action>();
const claimedAttempts = new ClaimedAttemptLifecycle<Action>();
let claimsByAction = new WeakMap<object, ExecutionClaim>();
let demandGeneration = 0;
let selectiveWake: SelectiveDemandWakeQueue | null = null;
let work = Promise.resolve();
let stopped = false;

const denyExternalBuiltinFetch: typeof globalThis.fetch = () =>
  Promise.reject(
    new TypeError("external builtins are disabled in executor shadow mode"),
  );

const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
  const next = work.then(operation, operation);
  work = next.then(() => undefined, () => undefined);
  return next;
};

const normalizePieceId = (pieceId: string): string =>
  pieceId.startsWith("of:") ? pieceId.slice(3) : pieceId;

const claimKey = (claim: ActionClaimKey): string => actionClaimMapKey(claim);

const finishClaimedAttempt = (
  claim: ExecutionClaim,
  sourceAction: object,
): boolean => claimedAttempts.finish(claim, sourceAction as Action);

const releaseClaimedAttempt = (
  type: "unserved-claim" | "invalidated-claim",
  claim: ExecutionClaim,
  sourceAction: object,
  diagnosticCode: string,
): void => {
  // The activation waiter is already gone after the first successful
  // settlement, but later reactive reruns retain this claim. Release authority
  // whenever the action still names the exact incarnation, independently of
  // whether an activation lifecycle record remains.
  finishClaimedAttempt(claim, sourceAction);
  if (!deleteExactClaimForAction(claimsByAction, claim, sourceAction)) return;
  worker.postMessage({ type, claim, diagnosticCode });
};

const cancelClaimedAttempts = (): void => {
  for (const { claim, action } of claimedAttempts.cancelAll()) {
    deleteExactClaimForAction(claimsByAction, claim, action);
  }
};

const unavailableAddress = (cell: Cell<unknown>): UnavailableCellAddress => {
  const link = cell.getAsNormalizedFullLink();
  return {
    space: link.space,
    id: link.id,
    scope: link.scope,
    path: [...link.path],
  };
};

const revisionKey = (address: {
  id: string;
  scope?: string;
}): string => `${address.scope ?? "space"}\0${address.id}`;

const postFatal = (error: unknown): void => {
  worker.postMessage({
    type: "fatal",
    message: error instanceof Error ? error.message : String(error),
  });
};

const activateDemand = async (
  pieceId: string,
  cell: Cell<unknown>,
): Promise<boolean> => {
  if (runtime === null) throw new Error("executor Worker is not initialized");
  if (instantiatedDemand.has(pieceId)) return true;
  await cell.sync();
  if (cell.getRaw() === undefined) {
    pendingDemand.set(pieceId, unavailableAddress(cell));
    return false;
  }
  try {
    const discovery = await prepareExecutorDemandPiece({
      runtime,
      branch,
      pieceId,
      target: cell,
      instantiate: () => runtime!.start(cell),
    });
    // `pull()` below is a bounded settlement barrier, not durable demand. Keep
    // one consumer live so an async host claim can rerun the same action after
    // the initial pull's temporary consumer has been released.
    demandSinks.set(pieceId, cell.sink(() => undefined));
    instantiatedDemand.add(pieceId);
    pendingDemand.delete(pieceId);
    worker.postMessage({ type: "writer-discovery", discovery });
    return true;
  } catch (error) {
    // A demand may beat the commit that creates its piece, or a link in its
    // startup chain. Keep the lane live and retry that root when data arrives.
    if (error instanceof CellDataUnavailableError) {
      pendingDemand.set(pieceId, error.address);
      return false;
    }
    throw error;
  }
};

const pullDemand = async (
  schedulerPieceIds?: ReadonlySet<string>,
  demandedPieceIds?: ReadonlySet<string>,
): Promise<void> => {
  for (const [pieceId, cell] of demanded) {
    if (demandedPieceIds !== undefined && !demandedPieceIds.has(pieceId)) {
      continue;
    }
    if (
      schedulerPieceIds !== undefined &&
      !schedulerPieceIds.has(canonicalSchedulerPieceIdForDemandRoot(pieceId))
    ) {
      continue;
    }
    if (!(await activateDemand(pieceId, cell))) continue;
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
    for (const [pieceId, cell] of demanded) {
      demandSinks.get(pieceId)?.();
      runtime.runner.stop(cell);
    }
    demanded.clear();
    instantiatedDemand.clear();
    pendingDemand.clear();
    demandSinks.clear();
    candidateActions.clear();
    claimsByAction = new WeakMap<object, ExecutionClaim>();
  }
  for (const [pieceId, cell] of demanded) {
    if (nextSet.has(pieceId)) continue;
    demandSinks.get(pieceId)?.();
    demandSinks.delete(pieceId);
    runtime.runner.stop(cell);
    demanded.delete(pieceId);
    instantiatedDemand.delete(pieceId);
    pendingDemand.delete(pieceId);
  }
  for (const pieceId of next) {
    if (demanded.has(pieceId)) continue;
    const cell = runtime.getCellFromEntityId<unknown>(
      space,
      entityIdFrom(normalizePieceId(pieceId)),
    );
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
      releaseClaimedAttempt(
        "unserved-claim",
        claim,
        sourceAction,
        diagnosticCode,
      );
    },
    onInvalidated: (claim, sourceAction, diagnosticCode) => {
      releaseClaimedAttempt(
        "invalidated-claim",
        claim,
        sourceAction,
        diagnosticCode,
      );
    },
    onAttemptStarted: (claim, sourceAction) => {
      claimedAttempts.markRouted(claim, sourceAction as Action);
    },
    onAttemptSettled: (claim, sourceAction, result) => {
      if (result.error === undefined) {
        finishClaimedAttempt(claim, sourceAction);
      }
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
      if (pendingDemand.size > 0) {
        const revised = new Set(notice.revisions.map(revisionKey));
        const ready = new Set<string>();
        for (const [pieceId, address] of pendingDemand) {
          if (
            address.space === notice.space && revised.has(revisionKey(address))
          ) {
            ready.add(pieceId);
          }
        }
        if (ready.size > 0) {
          void enqueue(() => pullDemand(undefined, ready)).catch(postFatal);
        }
      }
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
  runtime.scheduler.setActionCommitRejectionHandler((
    action,
    error,
    disposition,
  ) => {
    const claim = claimsByAction.get(action);
    if (claim === undefined) return;
    const rejection = claimedAttemptRejection(error, disposition);
    if (!rejection.release) return;
    releaseClaimedAttempt(
      "invalidated-claim",
      claim,
      action,
      rejection.diagnosticCode,
    );
  });
  runtime.scheduler.setActionObservationAdoptionGuard((action) =>
    claimsByAction.has(action)
  );
  selectiveWake = new SelectiveDemandWakeQueue((pieceIds) =>
    enqueue(() => pullDemand(new Set(pieceIds)))
  );
  // Serialize initial activation with commit-feed retries. A piece-creation
  // commit can arrive while its first sync is in flight; the retry must run
  // after this attempt rather than instantiate the same root concurrently.
  await enqueue(() => replaceDemand(request.pieces!));
};

type StartedClaimedAction = {
  finalSettlement: Promise<void>;
};

const startClaimedAction = async (
  claim: ExecutionClaim,
): Promise<StartedClaimedAction> => {
  if (runtime === null || storage === null || space === null) {
    throw new Error("executor Worker is not initialized");
  }
  const action = candidateActions.get(claimKey(claim));
  if (action === undefined) {
    throw new Error("claimed executor action is no longer live");
  }
  const attempt = claimedAttempts.start(claim, action);
  try {
    storage.discardShadowWritesForAction(space, action);
    claimsByAction.set(action, claim);
    (action as Action & { prepareClaimedRerun?: () => void })
      .prepareClaimedRerun?.();
    // Scheduler completion means the action transaction has been kicked off,
    // but the storage router can still be selecting its async route. The exact
    // afterRouteSelected callback is the readiness acknowledgement; eventual
    // accepted settlement remains deliberately outside the global work lane.
    await runtime.scheduler.run(action);
    await attempt.routeReady;
    return { finalSettlement: attempt.finalSettlement };
  } catch (error) {
    finishClaimedAttempt(claim, action);
    deleteExactClaimForAction(claimsByAction, claim, action);
    throw error;
  }
};

const settle = async (): Promise<number> => {
  if (runtime === null || storage === null) return 0;
  while (true) {
    await work;
    await claimedAttempts.settled();
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
  // Final-settlement waiters intentionally sit outside `work`. End their exact
  // local authority before settle waits on queued demand/pull operations.
  cancelClaimedAttempts();
  await settle();
  for (const cancel of demandSinks.values()) cancel();
  demandSinks.clear();
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
  instantiatedDemand.clear();
  pendingDemand.clear();
  candidateActions.clear();
};

const handle = async (request: WorkerRequest): Promise<void> => {
  if (!Number.isSafeInteger(request.requestId)) {
    throw new Error("executor Worker request has no request id");
  }
  if (request.type === "run-claimed-action") {
    if (request.claim === undefined) {
      throw new Error("claimed executor rerun has no claim");
    }
    const started = await enqueue(() => startClaimedAction(request.claim!));
    worker.postMessage({ type: "complete", requestId: request.requestId });
    // Do not await this on `work` or the request/control handler: a conflict,
    // broker call, or delayed settlement must not starve renewal, demand
    // changes, selective pulls, settle, or stop.
    void started.finalSettlement.catch(postFatal);
    return;
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
      if (request.resetClaims === true) cancelClaimedAttempts();
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
