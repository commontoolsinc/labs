/// <reference lib="webworker" />

import type { MemorySpace } from "@commonfabric/memory/interface";
import {
  type ActionClaimKey,
  actionClaimMapKey,
  type BranchName,
  canonicalSchedulerPieceIdForDemandRoot,
  type ExecutionClaim,
  executionClaimIncarnationKey,
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
  type RuntimeTelemetryEvent,
} from "../index.ts";
import {
  CellDataUnavailableError,
  type UnavailableCellAddress,
} from "../cell-data-unavailable-error.ts";
import {
  createExecutorActionTransactionRouter,
  type ExecutorActionTransactionPlacement,
} from "./action-transaction-router.ts";
import type { ExecutorExecutionMetricsSnapshot } from "./shared-execution-pool.ts";
import {
  type AcceptedCommitNotice,
  HostStorageManager,
} from "../storage/v2-host-provider.ts";
import {
  ClaimedAttemptLifecycle,
  claimedAttemptRejection,
  deleteExactClaimForAction,
} from "./claimed-attempt-lifecycle.ts";
import { prepareExecutorDemandPiece } from "./writer-discovery.ts";
import {
  createServerBuiltinBrokerClient,
  type ServerBuiltinBrokerClient,
  ServerBuiltinUnservedError,
} from "./server-builtin-channel.ts";
import { getTransactionSourceAction } from "../storage/transaction-source-context.ts";
import { SelectiveDemandWakeQueue } from "./selective-demand-wake.ts";
import {
  schedulerIdentityKeyForAction,
  schedulerIdentityKeyForStaleReader,
} from "./scheduler-wake-identity.ts";
import {
  disposeExecutorRuntimeAndTelemetry,
  maybeAttachExecutorOtelBridge,
} from "./worker-otel.ts";

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
const actionsBySchedulerIdentity = new Map<string, Action>();
const pendingCausalActorMatches = new Map<string, boolean>();
let causalActorMatchesByAction = new WeakMap<object, boolean>();
let permanentBuiltinFailureByAction = new WeakMap<
  object,
  { claim: ExecutionClaim; diagnosticCode: string }
>();
const claimedAttempts = new ClaimedAttemptLifecycle<Action>();
let claimsByAction = new WeakMap<object, ExecutionClaim>();
let demandGeneration = 0;
let selectiveWake: SelectiveDemandWakeQueue | null = null;
let detachOtelBridge: (() => void) | undefined;
let detachExecutionMetrics: (() => void) | undefined;
let work = Promise.resolve();
let stopped = false;
const executionMetrics = {
  schedulerRuns: 0,
  asyncRequests: 0,
  actionTransactions: { shadow: 0, authoritative: 0 },
};

const executionMetricsSnapshot = (): ExecutorExecutionMetricsSnapshot => ({
  schedulerRuns: executionMetrics.schedulerRuns,
  asyncRequests: executionMetrics.asyncRequests,
  actionTransactions: {
    shadow: executionMetrics.actionTransactions.shadow,
    authoritative: executionMetrics.actionTransactions.authoritative,
  },
});

const publishExecutionMetrics = (): void => {
  worker.postMessage({
    type: "execution-metrics",
    metrics: executionMetricsSnapshot(),
  });
};

let executionMetricsPublishQueued = false;
const scheduleExecutionMetricsPublish = (): void => {
  if (executionMetricsPublishQueued) return;
  executionMetricsPublishQueued = true;
  queueMicrotask(() => {
    executionMetricsPublishQueued = false;
    publishExecutionMetrics();
  });
};

const denyExternalBuiltinFetch: typeof globalThis.fetch = () =>
  Promise.reject(
    new TypeError("external builtins are disabled in executor shadow mode"),
  );

const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
  const measured = async (): Promise<T> => {
    try {
      return await operation();
    } finally {
      // One cumulative snapshot per serialized work item avoids per-action IPC
      // while still publishing async accepted-commit work with no host request.
      publishExecutionMetrics();
    }
  };
  const next = work.then(measured, measured);
  work = next.then(() => undefined, () => undefined);
  return next;
};

const normalizePieceId = (pieceId: string): string =>
  pieceId.startsWith("of:") ? pieceId.slice(3) : pieceId;

const claimKey = (claim: ActionClaimKey): string => actionClaimMapKey(claim);

const noteAcceptedCommitCausalActors = (
  notice: AcceptedCommitNotice,
): void => {
  const matchesSponsor = notice.originMatchesExecutionSponsor === true;
  for (const reader of notice.staleDemandedReaders) {
    const identity = schedulerIdentityKeyForStaleReader(reader);
    if (identity === undefined) continue;
    // Several accepted commits may coalesce before one rerun. Every causal
    // origin must match the lease sponsor; a mismatch dominates that wave.
    const combined = (pendingCausalActorMatches.get(identity) ?? true) &&
      matchesSponsor;
    pendingCausalActorMatches.set(identity, combined);
    const action = actionsBySchedulerIdentity.get(identity);
    if (action !== undefined) {
      causalActorMatchesByAction.set(action, combined);
    }
  }
};

const registerCandidateSchedulerIdentity = (
  candidate: { claimKey: ActionClaimKey; builtinId?: string },
  action: Action,
): string => {
  const identity = schedulerIdentityKeyForAction(action, candidate.claimKey);
  actionsBySchedulerIdentity.set(identity, action);
  return identity;
};

const registerCandidateCausalActor = (
  identity: string,
  action: Action,
): boolean => {
  const matchesSponsor = pendingCausalActorMatches.get(identity) ?? true;
  pendingCausalActorMatches.delete(identity);
  causalActorMatchesByAction.set(action, matchesSponsor);
  return matchesSponsor;
};

const permanentUnservedReasonForAction = (
  action: object,
  claim: ExecutionClaim,
): string | undefined => {
  const failure = permanentBuiltinFailureByAction.get(action);
  const reason = failure !== undefined &&
      executionClaimIncarnationKey(failure.claim) ===
        executionClaimIncarnationKey(claim)
    ? failure.diagnosticCode
    : undefined;
  return reason;
};

const recordPermanentBuiltinFailure = (
  action: object,
  claim: ExecutionClaim,
  error: unknown,
): void => {
  if (!(error instanceof ServerBuiltinUnservedError)) return;
  const live = claimsByAction.get(action);
  if (
    live === undefined ||
    executionClaimIncarnationKey(live) !== executionClaimIncarnationKey(claim)
  ) {
    return;
  }
  const existing = permanentBuiltinFailureByAction.get(action);
  if (
    existing !== undefined &&
    executionClaimIncarnationKey(existing.claim) ===
      executionClaimIncarnationKey(claim)
  ) {
    return;
  }
  permanentBuiltinFailureByAction.set(action, {
    claim,
    diagnosticCode: error.diagnosticCode,
  });
};

const clearPermanentBuiltinFailure = (
  action: object,
  claim: ExecutionClaim,
): void => {
  const failure = permanentBuiltinFailureByAction.get(action);
  if (
    failure !== undefined &&
    executionClaimIncarnationKey(failure.claim) ===
      executionClaimIncarnationKey(claim)
  ) {
    permanentBuiltinFailureByAction.delete(action);
  }
};

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
  clearPermanentBuiltinFailure(sourceAction, claim);
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
  const growsOnly = !resetClaims &&
    [...demanded.keys()].every((pieceId) => nextSet.has(pieceId));
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
    actionsBySchedulerIdentity.clear();
    pendingCausalActorMatches.clear();
    causalActorMatchesByAction = new WeakMap<object, boolean>();
    permanentBuiltinFailureByAction = new WeakMap<
      object,
      { claim: ExecutionClaim; diagnosticCode: string }
    >();
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
  const added = new Set<string>();
  for (const pieceId of next) {
    if (demanded.has(pieceId)) continue;
    const cell = runtime.getCellFromEntityId<unknown>(
      space,
      entityIdFrom(normalizePieceId(pieceId)),
    );
    demanded.set(pieceId, cell);
    added.add(pieceId);
  }
  // Existing roots retain a standing sink and receive their own selective
  // invalidation wakes. Re-pulling them for an unrelated demand addition
  // installs redundant temporary pull effects and serially re-traverses every
  // active graph. A shrink/reset still rebuilds and pulls every survivor.
  await pullDemand(
    undefined,
    growsOnly ? added : new Set(demanded.keys()),
  );
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
    // C1.5a: user-rank candidate production stays inert unless the host
    // passes the experimental option; the Worker's acting principal (the
    // lease sponsor until C1.5b's per-lane contexts) keys the lane.
    userRankCandidates: request.experimental
      ?.serverPrimaryExecutionUserRankCandidates === true,
    lanePrincipal: request.principal,
    claimForAction: (action) => claimsByAction.get(action),
    permanentUnservedReasonForAction,
    onCandidate: (candidate, sourceAction) => {
      const action = sourceAction as Action;
      candidateActions.set(
        claimKey(candidate.claimKey),
        action,
      );
      const identity = registerCandidateSchedulerIdentity(candidate, action);
      const causalActorMatchesSponsor = candidate.builtinId === undefined
        ? undefined
        : registerCandidateCausalActor(identity, action);
      worker.postMessage({
        type: "candidate-claim",
        candidate: {
          ...candidate,
          ...(causalActorMatchesSponsor !== undefined
            ? { causalActorMatchesSponsor }
            : {}),
          ...(demandGeneration > 0 ? { demandGeneration } : {}),
        },
      });
    },
    onDiagnostic: (diagnostic) => {
      worker.postMessage({ type: "candidate-diagnostic", diagnostic });
    },
    onActionTransaction: (
      placement: ExecutorActionTransactionPlacement,
    ) => {
      executionMetrics.actionTransactions[placement] += 1;
      // Async actions can complete after their originating work item. Publish
      // independently so the host does not need a later request to see them.
      scheduleExecutionMetricsPublish();
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
    onAcceptedCommitWillIntegrate(notice) {
      noteAcceptedCommitCausalActors(notice);
    },
    onAcceptedCommitIntegrated(notice) {
      const stalePieceIds = new Set<string>();
      for (const reader of notice.staleDemandedReaders) {
        const identity = schedulerIdentityKeyForStaleReader(reader);
        const action = identity === undefined
          ? undefined
          : actionsBySchedulerIdentity.get(identity);
        if (action !== undefined) {
          // A live registered action reruns from its direct invalidation; the
          // changed documents already arrived with this notice's replica
          // sync, so re-pulling its piece's whole closure would only re-run
          // the host graph query per wave (measured: the dominant host
          // main-isolate cost, stalling every client round trip). A rerun
          // that reaches a newly linked, not-yet-synced document still fails
          // open to the pending-demand retry path.
          runtime?.scheduler.invalidateActionForHostWake(action);
        } else {
          // No live registration matches (parked piece, replaced identity, or
          // a not-yet-instantiated root): the closure pull is the only wake.
          stalePieceIds.add(reader.pieceId);
        }
      }
      selectiveWake?.push([...stalePieceIds]);
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
  // A demand shrink stops removed roots; the scheduler unregisters exactly
  // the actions those roots no longer keep live (an action shared with a
  // surviving root stays registered). Release each retired action's exact
  // claim so a shrink surrenders only its own authority instead of resetting
  // the lane, and drop its candidate-index entries so a racing host claim
  // cannot target the dead action.
  storage.setExecutionActionUnregisterHook((unregistered) => {
    if (stopped) return;
    const claim = claimsByAction.get(unregistered);
    if (claim !== undefined) {
      releaseClaimedAttempt(
        "invalidated-claim",
        claim,
        unregistered,
        "action-unregistered",
      );
    }
    for (const [key, action] of candidateActions) {
      if (action === unregistered) candidateActions.delete(key);
    }
    for (const [key, action] of actionsBySchedulerIdentity) {
      if (action === unregistered) actionsBySchedulerIdentity.delete(key);
    }
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
  const onRuntimeTelemetry = (event: Event): void => {
    if (
      (event as RuntimeTelemetryEvent).marker.type === "scheduler.run.complete"
    ) {
      executionMetrics.schedulerRuns += 1;
      scheduleExecutionMetricsPublish();
    }
  };
  runtime.telemetry.addEventListener("telemetry", onRuntimeTelemetry);
  const metricsRuntime = runtime;
  detachExecutionMetrics = () =>
    metricsRuntime.telemetry.removeEventListener(
      "telemetry",
      onRuntimeTelemetry,
    );
  detachOtelBridge = await maybeAttachExecutorOtelBridge(runtime, {
    spanAttributes: {
      "space.did": space,
      "user.did": request.principal,
    },
  });
  runtime.installServerBuiltinFetch((builtinId, rawUrl, init) => {
    // Capture both object and exact claim before crossing an async broker
    // boundary. Broker IPC never receives a causal actor identity.
    const sourceAction = getTransactionSourceAction();
    const claim = sourceAction === undefined
      ? undefined
      : claimsByAction.get(sourceAction);
    if (
      sourceAction !== undefined && claim !== undefined &&
      causalActorMatchesByAction.get(sourceAction) !== true
    ) {
      const error = new ServerBuiltinUnservedError(
        "builtin-causal-actor-mismatch",
        "server builtin causal actor does not match the lease sponsor",
      );
      recordPermanentBuiltinFailure(sourceAction, claim, error);
      return Promise.reject(error);
    }
    try {
      executionMetrics.asyncRequests += 1;
      // Builtin effects can start after the serialized pull that scheduled
      // them has returned. Publish at this rare egress boundary so health
      // snapshots do not wait for an unrelated later wake or shutdown.
      publishExecutionMetrics();
      const pending = builtinBroker!.fetch(builtinId, rawUrl, init);
      return sourceAction === undefined || claim === undefined
        ? pending
        : pending.catch((error) => {
          recordPermanentBuiltinFailure(sourceAction, claim, error);
          throw error;
        });
    } catch (error) {
      if (sourceAction !== undefined && claim !== undefined) {
        recordPermanentBuiltinFailure(sourceAction, claim, error);
      }
      return Promise.reject(error);
    }
  });
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
    // The exact claim is gone synchronously. Re-running this same rejected
    // input through the generic scheduler retry path would immediately acquire
    // a new incarnation and bypass that revocation; wait for a fresh durable
    // invalidation instead.
    return "suppress-retry";
  });
  // Executor shadows independently run durable clean computations at startup
  // and rerun remote invalidations to discover candidate authority.
  runtime.scheduler.setActionObservationAdoptionGuard(() => true);
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

/** The claimed action was unregistered (typically by a demand shrink) between
 * candidate emission and claim activation. Claim-scoped, not lane-fatal. */
class ClaimedActionGoneError extends Error {}

const startClaimedAction = async (
  claim: ExecutionClaim,
): Promise<StartedClaimedAction> => {
  if (runtime === null || storage === null || space === null) {
    throw new Error("executor Worker is not initialized");
  }
  const action = candidateActions.get(claimKey(claim));
  if (action === undefined) {
    throw new ClaimedActionGoneError(
      "claimed executor action is no longer live",
    );
  }
  const attempt = claimedAttempts.start(claim, action);
  try {
    const identity = schedulerIdentityKeyForAction(action, claim);
    pendingCausalActorMatches.delete(identity);
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
  let shutdownError: unknown;
  if (runtime !== null) {
    const detach = detachOtelBridge;
    detachOtelBridge = undefined;
    shutdownError = await disposeExecutorRuntimeAndTelemetry(runtime, detach);
  } else if (storage !== null) {
    try {
      await storage.close();
    } catch (error) {
      shutdownError = error;
    }
  }
  detachExecutionMetrics?.();
  detachExecutionMetrics = undefined;
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
  actionsBySchedulerIdentity.clear();
  pendingCausalActorMatches.clear();
  causalActorMatchesByAction = new WeakMap<object, boolean>();
  permanentBuiltinFailureByAction = new WeakMap<
    object,
    { claim: ExecutionClaim; diagnosticCode: string }
  >();
  if (shutdownError !== undefined) throw shutdownError;
};

const handle = async (request: WorkerRequest): Promise<void> => {
  if (!Number.isSafeInteger(request.requestId)) {
    throw new Error("executor Worker request has no request id");
  }
  if (request.type === "run-claimed-action") {
    if (request.claim === undefined) {
      throw new Error("claimed executor rerun has no claim");
    }
    let started: StartedClaimedAction;
    try {
      started = await enqueue(() => startClaimedAction(request.claim!));
    } catch (error) {
      if (error instanceof ClaimedActionGoneError) {
        // A claim can land while a demand shrink stops its action. Release
        // that exact claim instead of failing the whole lane.
        worker.postMessage({
          type: "invalidated-claim",
          claim: request.claim,
          diagnosticCode: "action-unregistered",
        });
        worker.postMessage({ type: "complete", requestId: request.requestId });
        return;
      }
      throw error;
    }
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
      // settle() can finish scheduler work outside an enqueue operation; send
      // the final cumulative counters before acknowledging its barrier.
      publishExecutionMetrics();
      worker.postMessage({
        type: "settled",
        requestId: request.requestId,
        dataSeq,
      });
      return;
    }
    case "stop":
      await stop();
      publishExecutionMetrics();
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
