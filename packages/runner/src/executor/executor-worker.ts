/// <reference lib="webworker" />

import type { MemorySpace } from "@commonfabric/memory/interface";
import type { SchedulerExecutionContextKey } from "@commonfabric/memory/v2/engine";
import {
  type ActionClaimKey,
  actionClaimMapKey,
  type BranchName,
  canonicalSchedulerPieceIdForDemandRoot,
  type DocsReadExecutionClaimRef,
  type ExecutionClaim,
  executionClaimIncarnationKey,
  parseSessionExecutionContextKey,
  principalOfUserContextKey,
  userExecutionContextKey,
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
import type { IMemorySpaceAddress } from "../storage/interface.ts";
import {
  createExecutorActionTransactionRouter,
  type ExecutorActionTransactionPlacement,
  type ExecutorActionTransactionRouter,
} from "./action-transaction-router.ts";
import type { ExecutorExecutionMetricsSnapshot } from "./shared-execution-pool.ts";
import {
  type AcceptedCommitNotice,
  type ForeignWakeNotice,
  HostStorageManager,
} from "../storage/v2-host-provider.ts";
import {
  ClaimedAttemptLifecycle,
  claimedAttemptRejection,
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
  /** Lane-partitioned user demand (A24). Absent on the pre-lane wire; once
   * present, the array is the complete set of live user lanes. */
  lanes?: WireLaneDemand[];
};

type WireLaneDemand = {
  contextKey: string;
  pieces: string[];
  demandGeneration: number;
  resetClaims?: boolean;
};

const worker = globalThis as unknown as DedicatedWorkerGlobalScope;
let runtime: Runtime | null = null;
let storage: HostStorageManager | null = null;
let actionRouter: ExecutorActionTransactionRouter | null = null;
let builtinBroker: ServerBuiltinBrokerClient | null = null;
let space: MemorySpace | null = null;
let branch: BranchName = "";
/** Canonical `user:<did>` key of the lease sponsor's own lane (C1.9c). */
let sponsorLaneKey: string | null = null;
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
/** Live claims per action, keyed by the claim's lane contextKey (C1.9c):
 * one action object holds at most one live claim PER LANE. Two different
 * lanes' claims for one actionId are disjoint chains (A3 holds per chain —
 * server issuance rejects chain-compatible duplicates) and must coexist. */
let claimsByAction = new WeakMap<object, Map<string, ExecutionClaim>>();
/** Lane pinned by a driver (claimed activation, per-lane host-wake rerun)
 * for the action's NEXT run. Consumed by the scheduler run wrapper. */
let laneRunPins = new WeakMap<object, string>();
/** Lane of the action's latest wrapper-started run. The storage commit
 * entry resolves a source action's owning lane through this — runs are
 * globally single-flight, and a run's commit is entered before the next
 * run of the same action can start, so "latest run" is exact. */
let laneRunsByAction = new WeakMap<object, string>();
let demandGeneration = 0;
/** Per-lane demand: the lane principal's aggregated pieces (raw demand
 * roots plus their canonical scheduler piece ids) and the lane's OWN wire
 * demand generation (A24). Candidates of a user lane carry this
 * generation, never the space one. */
const laneDemands = new Map<
  string,
  { pieces: Set<string>; schedulerPieces: Set<string>; generation: number }
>();
/** Lane-independent scoped-rank candidate templates (C1.9c; session rank
 * rides the same map since C2.7; supported-builtin effects since C2.8),
 * keyed by (pieceId, actionId): when a lane opens (or re-anchors) AFTER
 * discovery proved an action scoped-rank servable, the Worker synthesizes
 * that lane's candidate from the recorded template instead of waiting for
 * the next rerun of the action. The template's contextKey records the rank
 * the action classified at; the late-lane emission only synthesizes onto
 * lanes of that SAME rank (CA9). A builtin template carries its builtinId
 * so the synthesized candidate keeps the identity host passivity routing
 * requires. */
const userCandidateTemplates = new Map<
  string,
  {
    action: Action;
    claimKey: ActionClaimKey;
    builtinId?: string;
    // C3.6: a scoped-lane action's foreign-read surface, so a candidate
    // synthesized onto a lane that opens LATER still issues a cross-space-read
    // claim (foreign-read admission is rank-independent).
    crossSpaceReadSpaces?: readonly string[];
  }
>();
const userCandidateTemplateKey = (key: ActionClaimKey): string =>
  `${key.pieceId}\0${key.actionId}`;
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

const liveClaimForLane = (
  action: object,
  lane: string,
): ExecutionClaim | undefined => claimsByAction.get(action)?.get(lane);

const setLiveClaim = (action: object, claim: ExecutionClaim): void => {
  let claims = claimsByAction.get(action);
  if (claims === undefined) {
    claims = new Map<string, ExecutionClaim>();
    claimsByAction.set(action, claims);
  }
  claims.set(claim.contextKey, claim);
};

/** Delete lane authority only while the action still names this exact claim
 * incarnation on the claim's own lane. Returns true once, so late duplicate
 * callbacks cannot post a second host release (the map-shaped C1.9c twin of
 * claimed-attempt-lifecycle's deleteExactClaimForAction). */
const deleteExactLaneClaim = (
  claim: ExecutionClaim,
  action: object,
): boolean => {
  const claims = claimsByAction.get(action);
  const current = claims?.get(claim.contextKey);
  if (
    claims === undefined || current === undefined ||
    executionClaimIncarnationKey(current) !==
      executionClaimIncarnationKey(claim)
  ) {
    return false;
  }
  claims.delete(claim.contextKey);
  if (claims.size === 0) claimsByAction.delete(action);
  return true;
};

/** The lane an undirected (scheduler-loop) run of `action` serves: its
 * single live claim's lane, or with several live lanes a deterministic one
 * — the space claim, else the lease sponsor's lane, else the first-claimed
 * lane. One run can only read one lane's instances, so it must commit under
 * exactly that lane; the per-lane host wake (C1.4b attribution) drives one
 * pinned run per remaining lane. Routing an undirected run of a claimed
 * action as a shadow instead would re-grow shadow overlays on the shared
 * broad records the claimed §4 pair also writes — the C1.9b conflict storm
 * in a new shape. */
const undirectedRunLane = (action: object): string | undefined => {
  const claims = claimsByAction.get(action);
  if (claims === undefined || claims.size === 0) return undefined;
  if (claims.size === 1) return claims.keys().next().value;
  if (claims.has("space")) return "space";
  if (sponsorLaneKey !== null && claims.has(sponsorLaneKey)) {
    return sponsorLaneKey;
  }
  return claims.keys().next().value;
};

/** The claim governing the action's latest run — for continuation paths
 * (async builtin effects, commit rejections) that must name the exact claim
 * their originating run was routed under. */
const claimForActionRun = (action: object): ExecutionClaim | undefined => {
  const claims = claimsByAction.get(action);
  if (claims === undefined || claims.size === 0) return undefined;
  const lane = laneRunsByAction.get(action);
  if (lane !== undefined) {
    const claim = claims.get(lane);
    if (claim !== undefined) return claim;
  }
  if (claims.size === 1) return claims.values().next().value;
  return claims.get("space");
};

const hasAnyLiveClaim = (action: object): boolean =>
  (claimsByAction.get(action)?.size ?? 0) > 0;

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
  const live = liveClaimForLane(action, claim.contextKey);
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
  if (!deleteExactLaneClaim(claim, sourceAction)) return;
  // The lane may be re-claimed later: clear the router's candidate dedupe so
  // the next routed run re-emits this lane's (identical) candidate (C1.9c).
  actionRouter?.forgetLaneCandidate(sourceAction, claim.contextKey);
  worker.postMessage({ type, claim, diagnosticCode });
};

const cancelClaimedAttempts = (lane?: string): void => {
  const cancelled = lane === undefined
    ? claimedAttempts.cancelAll()
    : claimedAttempts.cancelMatching((claim) => claim.contextKey === lane);
  for (const { claim, action } of cancelled) {
    deleteExactLaneClaim(claim, action);
    actionRouter?.forgetLaneCandidate(action, claim.contextKey);
  }
};

const validateWireLanes = (
  lanes: unknown,
): WireLaneDemand[] | undefined => {
  if (lanes === undefined) return undefined;
  if (
    !Array.isArray(lanes) ||
    !lanes.every((lane) =>
      typeof lane?.contextKey === "string" && lane.contextKey !== "space" &&
      Array.isArray(lane.pieces) &&
      lane.pieces.every((piece: unknown) => typeof piece === "string") &&
      Number.isSafeInteger(lane.demandGeneration) &&
      Number(lane.demandGeneration) > 0
    )
  ) {
    throw new Error("executor lane demand is malformed");
  }
  return lanes as WireLaneDemand[];
};

/** Reconcile the complete lane set (A24). Removal is a full lane drain:
 * cancel exactly that lane's claimed attempts and prune the replica's lane
 * records (the C1.5b follow-on). A resetClaims or generation bump fences a
 * re-anchored lane the same way without touching siblings. `undefined`
 * means the pre-lane wire — state stays untouched, byte-identical. */
const applyLaneDemands = (lanes: WireLaneDemand[] | undefined): void => {
  if (lanes === undefined) return;
  const next = new Set(lanes.map((lane) => lane.contextKey));
  for (const contextKey of [...laneDemands.keys()]) {
    if (next.has(contextKey)) continue;
    cancelClaimedAttempts(contextKey);
    laneDemands.delete(contextKey);
    laneHydration.delete(contextKey);
    if (space !== null) {
      storage?.pruneExecutionLane(
        space,
        contextKey as SchedulerExecutionContextKey,
      );
    }
  }
  for (const lane of lanes) {
    const existing = laneDemands.get(lane.contextKey);
    if (lane.demandGeneration < (existing?.generation ?? 0)) {
      throw new Error("executor lane demand generation is malformed");
    }
    if (
      lane.resetClaims === true ||
      (existing !== undefined && lane.demandGeneration > existing.generation)
    ) {
      cancelClaimedAttempts(lane.contextKey);
      laneHydration.delete(lane.contextKey);
    }
    laneDemands.set(lane.contextKey, {
      pieces: new Set(lane.pieces),
      schedulerPieces: new Set(
        lane.pieces.map(canonicalSchedulerPieceIdForDemandRoot),
      ),
      generation: lane.demandGeneration,
    });
    // A lane opening (or re-anchoring) AFTER discovery proved actions
    // user-rank servable never sees those actions rerun on its own: the
    // shared runtime graph is already clean. Synthesize the lane's
    // candidates from the recorded templates (C1.9c) so a late-joining
    // principal's lane produces candidates without a graph rebuild.
    if (existing === undefined || lane.demandGeneration > existing.generation) {
      emitTemplateCandidatesForLane(lane.contextKey);
    }
  }
};

/** Canonical rank of one lane context key — the Worker-side twin of the
 * router's laneKeyRank (CA9: candidate lanes ⊆ action rank). */
const laneContextRank = (key: string): "user" | "session" | undefined => {
  if (principalOfUserContextKey(key) !== undefined) return "user";
  if (parseSessionExecutionContextKey(key) !== undefined) return "session";
  return undefined;
};

/** Emit recorded scoped-rank candidates for one lane (C1.9c, session lanes
 * since C2.7): every template of the LANE'S OWN RANK whose piece the lane's
 * demand slice covers, keyed by the lane's canonical contextKey and
 * carrying the lane's OWN wire generation (A24). The rank guard is
 * load-bearing once user and session lanes share this wire (C2.7): a
 * template records the rank its action CLASSIFIED at, and synthesizing it
 * onto a lane of another rank would pair a user-rank action with a session
 * lane (or vice versa) — the CA9 mixed-rank pairing the router's
 * candidateLaneKeys filter exists to prevent; the host would reject the
 * claim against chain-compatible issuance and churn. The host dedupes
 * re-emissions against its live-claim map. */
const emitTemplateCandidatesForLane = (contextKey: string): void => {
  const lane = laneDemands.get(contextKey);
  if (lane === undefined) return;
  const laneRank = laneContextRank(contextKey);
  if (laneRank === undefined) return;
  for (const template of userCandidateTemplates.values()) {
    if (laneContextRank(template.claimKey.contextKey) !== laneRank) continue;
    if (!lane.schedulerPieces.has(template.claimKey.pieceId)) continue;
    postCandidate(
      {
        claimKey: {
          ...template.claimKey,
          contextKey: contextKey as SchedulerExecutionContextKey,
        },
        ...(template.builtinId !== undefined
          ? { builtinId: template.builtinId }
          : {}),
        ...(template.crossSpaceReadSpaces !== undefined &&
            template.crossSpaceReadSpaces.length > 0
          ? { crossSpaceReadSpaces: template.crossSpaceReadSpaces }
          : {}),
      },
      template.action,
    );
  }
};

/** A candidate carries ITS lane's demand generation (A24). User candidates
 * without a wired lane fall back to the space generation — the C1.5a
 * pre-lane behavior the host validates them against. */
const candidateDemandGeneration = (contextKey: string): number =>
  contextKey === "space"
    ? demandGeneration
    : laneDemands.get(contextKey)?.generation ?? demandGeneration;

/** Register and post one candidate claim (C1.9c: shared by the router's
 * route-time per-lane emission and the late-lane template emission). */
const postCandidate = (
  candidate: {
    claimKey: ActionClaimKey;
    builtinId?: string;
    // C3.6: carried through so the spread below preserves the foreign-read
    // surface onto the posted candidate-claim message.
    crossSpaceReadSpaces?: readonly string[];
  },
  action: Action,
): void => {
  candidateActions.set(claimKey(candidate.claimKey), action);
  const identity = registerCandidateSchedulerIdentity(candidate, action);
  const causalActorMatchesSponsor = candidate.builtinId === undefined
    ? undefined
    : registerCandidateCausalActor(identity, action);
  if (candidate.claimKey.contextKey !== "space") {
    // Record the lane-independent template so a lane that opens later can
    // synthesize its own candidate. Since C2.8, supported builtins classify
    // at scoped ranks too — their templates carry the builtinId so the
    // synthesized candidates keep the passivity-routing identity.
    userCandidateTemplates.set(userCandidateTemplateKey(candidate.claimKey), {
      action,
      claimKey: candidate.claimKey,
      ...(candidate.builtinId !== undefined
        ? { builtinId: candidate.builtinId }
        : {}),
      ...(candidate.crossSpaceReadSpaces !== undefined &&
          candidate.crossSpaceReadSpaces.length > 0
        ? { crossSpaceReadSpaces: candidate.crossSpaceReadSpaces }
        : {}),
    });
  }
  const laneGeneration = candidateDemandGeneration(
    candidate.claimKey.contextKey,
  );
  worker.postMessage({
    type: "candidate-claim",
    candidate: {
      ...candidate,
      ...(causalActorMatchesSponsor !== undefined
        ? { causalActorMatchesSponsor }
        : {}),
      ...(laneGeneration > 0 ? { demandGeneration: laneGeneration } : {}),
    },
  });
};

/** The non-space (lane-instanced) documents each routed action touches,
 * reported by the router from real observations (C1.9b). */
const laneSurfacesByAction = new WeakMap<object, IMemorySpaceAddress[]>();

/** C3.4 foreign read surface: each routed action's FOREIGN-space read
 * addresses, reported by the router from real observations. Keyed per
 * action (WeakMap — retired actions release their targets); the inner
 * map dedupes by (space, scope, id). A foreign wake consults this to
 * refresh the Worker's read-only foreign mount for exactly the matched
 * actions' addresses in the waking read space. */
let foreignReadTargetsByAction = new WeakMap<
  object,
  Map<string, IMemorySpaceAddress>
>();

/** Project the wire claim reference of one live claim (identity + bound
 * generations — never credentials; the host derives space/branch from
 * the channel's lease binding). */
const foreignReadClaimRef = (
  claim: ExecutionClaim,
): DocsReadExecutionClaimRef => ({
  contextKey: claim.contextKey,
  pieceId: claim.pieceId,
  actionId: claim.actionId,
  actionKind: claim.actionKind,
  implementationFingerprint: claim.implementationFingerprint,
  runtimeFingerprint: claim.runtimeFingerprint,
  leaseGeneration: claim.leaseGeneration,
  claimGeneration: claim.claimGeneration,
});

/**
 * C3.4: refresh the foreign mount for one waking read space — issue an
 * authenticated point read per registered space-scoped foreign address
 * of each matched action, under that action's LIVE claim (the wake's
 * lane when it holds one, else the action's representative claim). The
 * intermediate posture stays pinned: stamped documents LAND in the
 * mount; nothing here relaxes servability, so the rerun's attempt still
 * settles unserved until C3.6 relaxes the classifier (C3.5, built
 * 2026-07-18, relaxed the ENGINE firewall and made the mount entries the
 * asserted vector basis — see `foreignReadStampsForAction`).
 *
 * Fail-closed and bounded: a denied/failed/fenced read lands nothing
 * and is NOT retried — one attempt per (action, address) per wake; the
 * next wake (or claimed rerun) is the only re-trigger. Scoped foreign
 * addresses are skipped (decision #3: unservable v1 — the send side
 * would reject them anyway).
 */
const refreshForeignMountForWake = async (
  notice: ForeignWakeNotice,
): Promise<void> => {
  const manager = storage;
  if (manager === null) return;
  for (const reader of notice.staleForeignReaders) {
    const identity = schedulerIdentityKeyForStaleReader(reader);
    const action = identity === undefined
      ? undefined
      : actionsBySchedulerIdentity.get(identity);
    if (action === undefined) continue;
    const claim = reader.executionContextKey !== "space"
      ? liveClaimForLane(action, reader.executionContextKey) ??
        claimForActionRun(action)
      : claimForActionRun(action);
    if (claim === undefined) continue;
    const targets = foreignReadTargetsByAction.get(action);
    if (targets === undefined) continue;
    for (const address of targets.values()) {
      if (address.space !== notice.readSpace) continue;
      if ((address.scope ?? "space") !== "space") continue;
      try {
        await manager.readForeignDoc(
          notice.readSpace,
          foreignReadClaimRef(claim),
          { id: address.id },
        );
      } catch (error) {
        // Constant-shape authority rejections and denials are expected
        // fail-closed outcomes here (the wake raced a rotation/drain).
        console.warn(
          "executor foreign mount refresh failed (fail-closed)",
          notice.readSpace,
          address.id,
          error,
        );
      }
    }
  }
};

/**
 * C3.11: hydrate the read-only foreign mount for a claimed cross-space-READ
 * action BEFORE its first run under a newly activated claim — the same
 * authenticated point read `refreshForeignMountForWake` issues on a wake, but
 * driven by claim ACTIVATION so the very first served run is stamped.
 *
 * Why this is load-bearing (the composed-serve defect this closes): without a
 * pre-run mount, the initial claimed run reads the foreign source through the
 * home mirror WITHOUT a served-point-read stamp, so `foreignReadStampsForAction`
 * yields nothing, the accepted observation floors at SESSION (the conservative
 * no-provenance posture — `claimedForeignReadFloorExempt` requires the engine's
 * accept-path provenance, which requires the stamps), and the SPACE-rank
 * cross-space-read claim fences it `claim-context-mismatch`. The fence loses the
 * claim before any foreign wake can refresh the mount, so the composed serve
 * never recovers. The memory C3.4/C3.5/C3.6 fixtures never caught this because
 * they hand-attach `foreignReadStamps` to the claimed observation; the real
 * `executor-worker.ts` run path (first exercised by the C3.11 gate) does not.
 *
 * Gated on `claim.crossSpaceReadSpaces`: absent/empty (every same-space claim)
 * makes this a no-op, so same-space execution is byte-identical. Fail-closed and
 * bounded exactly like the wake refresh — a denied/failed read lands nothing and
 * is not retried (the run then settles unserved, the pre-C3.11 behavior), never
 * a Worker fatal.
 */
const hydrateForeignReadMount = async (
  claim: ExecutionClaim,
  action: object,
): Promise<void> => {
  const manager = storage;
  if (manager === null) return;
  const readSpaces = claim.crossSpaceReadSpaces;
  if (readSpaces === undefined || readSpaces.length === 0) return;
  const targets = foreignReadTargetsByAction.get(action);
  if (targets === undefined) return;
  const readSpaceSet = new Set(readSpaces);
  for (const address of targets.values()) {
    if (!readSpaceSet.has(address.space)) continue;
    if ((address.scope ?? "space") !== "space") continue;
    try {
      await manager.readForeignDoc(
        address.space,
        foreignReadClaimRef(claim),
        { id: address.id },
      );
    } catch (error) {
      // Same fail-closed posture as the wake refresh: a denied/failed/fenced
      // read lands nothing (the run settles unserved) and is not retried.
      console.warn(
        "executor foreign mount hydration failed (fail-closed)",
        address.space,
        address.id,
        error,
      );
    }
  }
};

/** Per-lane hydration ledger (C1.9b): document sync tasks keyed by
 * `scope\0id`, valid for one lane demand generation. Drains, re-anchors,
 * and resetClaims drop the record so the next claimed activation
 * re-hydrates. */
const laneHydration = new Map<
  string,
  { generation: number; pulled: Map<string, Promise<void>> }
>();

/**
 * Hydrate a user lane's replica instances of one claimed action's scoped
 * documents before running it (C1.9b). The Worker's demand pulls register
 * SPACE-lane watches, so durable user-scoped instance rows written before
 * the Worker (or its lane) existed are absent from the replica: a claimed
 * lane run then reads defaults, its commit asserts seq-0 reads against
 * durable rows, and every attempt conflicts — an unthrottled claimed-commit
 * conflict storm that never settles. Syncing each scoped document WITH the
 * lane as the ambient acting context registers a lane-scoped watch (the
 * C1.4b read seam): the host resolves the instance under the LANE principal,
 * delivers the existing rows, and the watch keeps them fresh so later input
 * writes reach the replica before the claimed rerun.
 */
const hydrateExecutionLane = async (
  claim: ExecutionClaim,
  action: object,
): Promise<void> => {
  if (claim.contextKey === "space" || runtime === null || storage === null) {
    return;
  }
  const addresses = laneSurfacesByAction.get(action) ?? [];
  if (addresses.length === 0) return;
  const generation = laneDemands.get(claim.contextKey)?.generation ??
    demandGeneration;
  let record = laneHydration.get(claim.contextKey);
  if (record === undefined || record.generation < generation) {
    record = { generation, pulled: new Map() };
    laneHydration.set(claim.contextKey, record);
  }
  const ledger = record;
  const provider = storage.open(space!);
  const pending: Promise<void>[] = [];
  for (const address of addresses) {
    const key = `${address.scope ?? "space"}\0${address.id}`;
    let task = ledger.pulled.get(key);
    if (task === undefined) {
      // provider.sync reaches the replica's pull entry synchronously, so the
      // ambient lane is captured for the watch registration (the C1.5b
      // runWithExecutionLane contract).
      task = storage.runWithExecutionLane(
        space!,
        claim.contextKey,
        () =>
          provider.sync(
            address.id,
            { path: [], schema: false },
            address.scope,
          ),
      ).then(
        (result) => {
          // Fail-open: an unsynced document must not poison the lane; the
          // next claimed activation retries it.
          if (result.error !== undefined) ledger.pulled.delete(key);
        },
        () => {
          ledger.pulled.delete(key);
        },
      );
      ledger.pulled.set(key, task);
    }
    pending.push(task);
  }
  await Promise.all(pending);
};

/** Coalescer for per-lane claimed reruns: lanes with a rerun queued but not
 * yet started. A wake arriving DURING a lane's run enqueues a fresh one —
 * the host feed is at-least-once and the run must see the newest rows. */
let pendingLaneRerunsByAction = new WeakMap<object, Set<string>>();

/**
 * Re-run one claimed action under ONE lane's acting context (C1.9c): the
 * per-lane recompute of design §7. The host's durable read index attributes
 * stale readers per lane (C1.4b), so a lane's input change wakes exactly
 * (action, lane); the run is pinned to that lane — its reads resolve the
 * lane's document instances (hydrated and watch-kept since C1.9b) and its
 * commit attaches exactly that lane's claim. A lane-blind scheduler-loop
 * rerun cannot serve a non-sponsor lane: the space session resolves user
 * scope as the lease sponsor.
 */
const scheduleLaneRerun = (action: Action, lane: string): void => {
  let lanes = pendingLaneRerunsByAction.get(action);
  if (lanes === undefined) {
    lanes = new Set<string>();
    pendingLaneRerunsByAction.set(action, lanes);
  }
  if (lanes.has(lane)) return;
  lanes.add(lane);
  void enqueue(async () => {
    lanes.delete(lane);
    if (runtime === null || storage === null || space === null) return;
    const claim = liveClaimForLane(action, lane);
    if (claim === undefined) return;
    await hydrateExecutionLane(claim, action);
    laneRunPins.set(action, lane);
    try {
      await storage.runWithExecutionLane(
        space,
        claim.contextKey,
        () => runtime!.scheduler.run(action),
      );
    } finally {
      laneRunPins.delete(action);
    }
  }).catch(postFatal);
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

// FA6 matcher, declared-fallback arm by construction: a pending demand
// address is a local UNRESOLVED address (no instance exists yet), so it
// never carries a resolved scopeKey and revisions match on declared scope.
// Instance-exact scopeKey matching lives in the host provider's tracked
// snapshot matcher (acceptedRevisionMatchesSnapshot).
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
    userCandidateTemplates.clear();
    laneHydration.clear();
    actionsBySchedulerIdentity.clear();
    pendingCausalActorMatches.clear();
    causalActorMatchesByAction = new WeakMap<object, boolean>();
    permanentBuiltinFailureByAction = new WeakMap<
      object,
      { claim: ExecutionClaim; diagnosticCode: string }
    >();
    claimsByAction = new WeakMap<object, Map<string, ExecutionClaim>>();
    laneRunPins = new WeakMap<object, string>();
    laneRunsByAction = new WeakMap<object, string>();
    foreignReadTargetsByAction = new WeakMap<
      object,
      Map<string, IMemorySpaceAddress>
    >();
    pendingLaneRerunsByAction = new WeakMap<object, Set<string>>();
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
  sponsorLaneKey = userExecutionContextKey(request.principal);
  const actionTransactionRouter = actionRouter =
    createExecutorActionTransactionRouter({
      servedSpace: space,
      branch,
      builtinBrokerAvailable: true,
      // C1.5a: user-rank candidate production stays inert unless the host
      // passes the experimental option; the Worker's acting principal (the
      // lease sponsor until C1.5b's per-lane contexts) keys the lane.
      userRankCandidates: request.experimental
        ?.serverPrimaryExecutionUserRankCandidates === true,
      // C2.5: session-rank candidate production, layered on the user dial
      // (ladder semantics). Candidates key by OPEN session lanes only —
      // there is no session analog of `lanePrincipal` (review CA9: the
      // session identity source is the host's lane-grant machinery).
      sessionRankCandidates: request.experimental
        ?.serverPrimaryExecutionSessionRankCandidates === true,
      // C3.6: foreign space-scoped read admission, ORTHOGONAL to the rank
      // dials above (a capability, not a lane). Off, foreign reads classify
      // unservable byte-identically.
      crossSpaceReadCandidates: request.experimental
        ?.serverPrimaryExecutionCrossSpaceReadCandidates === true,
      lanePrincipal: request.principal,
      // C1.9c: a user-rank action produces one candidate per OPEN lane whose
      // demand slice covers its piece. Before any lane is wired the router's
      // sponsor-lane fallback keeps the C1.5a pre-lane shape.
      openUserLaneKeys: (pieceId) => {
        if (laneDemands.size === 0) return undefined;
        const lanes: string[] = [];
        for (const [contextKey, lane] of laneDemands) {
          if (lane.schedulerPieces.has(pieceId)) lanes.push(contextKey);
        }
        return lanes;
      },
      onLaneSurface: (sourceAction, addresses) => {
        laneSurfacesByAction.set(sourceAction, [...addresses]);
      },
      // C3.4: register each routed action's foreign READ addresses so a
      // foreign wake can refresh the mount for exactly those documents.
      onForeignReadSurface: (sourceAction, addresses) => {
        const targets = new Map<string, IMemorySpaceAddress>();
        for (const address of addresses) {
          targets.set(
            `${address.space}\0${address.scope ?? "space"}\0${address.id}`,
            address,
          );
        }
        foreignReadTargetsByAction.set(sourceAction, targets);
      },
      // C3.5: assert the mount's stamped entries for the attempt's foreign
      // reads with the claimed commit (space-scoped only — decision #3;
      // unmounted documents contribute nothing and the attempt settles
      // scalar-only for them under the vacuous rule). The host validates
      // every stamp against its own served-point-read record; this is
      // assertion, never authority.
      foreignReadStampsForAction: (_sourceAction, addresses) => {
        const manager = storage;
        if (manager === null) return undefined;
        const stamps: { space: string; id: string; seq: number }[] = [];
        for (const address of addresses) {
          if ((address.scope ?? "space") !== "space") continue;
          const entry = manager.foreignDocument(address.space, address.id);
          if (entry === undefined) continue;
          stamps.push({ space: entry.space, id: entry.id, seq: entry.seq });
        }
        return stamps.length > 0 ? stamps : undefined;
      },
      claimForAction: (action, lane) => liveClaimForLane(action, lane),
      permanentUnservedReasonForAction,
      onCandidate: (candidate, sourceAction) => {
        postCandidate(candidate, sourceAction as Action);
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
          return;
        }
        // A conflicted claimed LANE commit must retry under ITS OWN lane
        // (C2.9). A conflict is a wait-for-catch-up, not a failure
        // (storage/rejection.ts): the client path recovers by re-queuing the
        // action, but here the storage revert only marks the ACTION invalid
        // — lane-blind — so the follow-up undirected dispatch serves a
        // DIFFERENT lane (`undirectedRunLane` prefers space / the sponsor /
        // the first-claimed lane) and this lane's rejected value is never
        // recomputed. If no later input change arrives to wake the lane, its
        // durable claimed row stays stale forever while the owning session's
        // client stays claim-suppressed — a permanent liveness wedge, found
        // by the C2.9 session-lane gate (bob's session lane: input write
        // raced the lane hydration, the conflict retry consumed the last
        // input change, and nothing ever re-ran the lane). The re-queue is
        // ordered AFTER the rejection's finalize (this callback fires once
        // the revert dropped the optimistic pending write), re-validates the
        // live claim, re-hydrates, and re-reads refreshed rows; the
        // conflict-admission floor paces repeated conflicts against catch-up
        // progress, so this converges rather than spinning.
        if (
          claim.contextKey !== "space" &&
          (result.error as { name?: string }).name === "ConflictError"
        ) {
          scheduleLaneRerun(sourceAction as Action, claim.contextKey);
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
    // C1.5b per-lane acting context, per-run since C1.9c: a commit's owning
    // lane is the lane its RUN was started under (the run wrapper records
    // it), so one action serving several lanes attributes each commit to
    // exactly the lane whose instances that run read (A6). Runs outside the
    // wrapper (event handlers) resolve no lane and stay on the space lane.
    executionLaneForAction: (action) =>
      laneRunsByAction.get(action) as SchedulerExecutionContextKey | undefined,
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
          // A per-lane stale reader with live authority on that lane reruns
          // UNDER that lane (C1.9c): the wake identity carries the lane's
          // contextKey because the claimed run's reads were attributed to it
          // (C1.4b), and only a lane-pinned run reads the lane's instances.
          if (
            reader.executionContextKey !== "space" &&
            liveClaimForLane(action, reader.executionContextKey) !== undefined
          ) {
            scheduleLaneRerun(action, reader.executionContextKey);
            continue;
          }
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
    // C3.3a (C3A11's provider leg): an in-flight Worker hears that its
    // foreign inputs changed. Same stale-reader consumption as a home
    // accepted-commit notice — matched live registration reruns (lane-
    // pinned when a live lane claim owns the row), unmatched identities
    // fall back to the selective closure pull — but with NO document
    // wave (the changed documents live in the READ space's seq domain).
    // C3.4 (2026-07-18): the wake now ALSO refreshes the read-only
    // foreign mount — authenticated point reads under the matched
    // action's live claim land stamped documents keyed
    // (space, id, scopeKey). C3.5 (built 2026-07-18) relaxed the
    // engine's foreign-space-surface fence for space-scoped foreign
    // READS and turned mount entries into the asserted vector basis,
    // but the runner-side servability classifier
    // (`foreign-read-space` / `dynamic-foreign-read-space`) is
    // deliberately untouched, so the rerun's attempt still settles
    // canonically unserved and clients fail open to their own
    // replicas until C3.6's servability stage lifts the classifier.
    onForeignWake(notice) {
      const stalePieceIds = new Set<string>();
      for (const reader of notice.staleForeignReaders) {
        const identity = schedulerIdentityKeyForStaleReader(reader);
        const action = identity === undefined
          ? undefined
          : actionsBySchedulerIdentity.get(identity);
        if (action !== undefined) {
          if (
            reader.executionContextKey !== "space" &&
            liveClaimForLane(action, reader.executionContextKey) !== undefined
          ) {
            scheduleLaneRerun(action, reader.executionContextKey);
            continue;
          }
          runtime?.scheduler.invalidateActionForHostWake(action);
        } else {
          stalePieceIds.add(reader.pieceId);
        }
      }
      selectiveWake?.push([...stalePieceIds]);
      // C3.4: mount refresh rides the serialized work queue (never
      // concurrent with runs), one bounded attempt per wake. Advisory:
      // an unexpected failure warns — the mount simply stays stale and
      // the attempt stays unserved (fail closed), never a Worker fatal.
      void enqueue(() => refreshForeignMountForWake(notice)).catch(
        (error) => {
          console.warn("executor foreign mount refresh pass failed", error);
        },
      );
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
    const claims = claimsByAction.get(unregistered);
    if (claims !== undefined) {
      // Release every lane's claim: the retired action can serve none.
      for (const claim of [...claims.values()]) {
        releaseClaimedAttempt(
          "invalidated-claim",
          claim,
          unregistered,
          "action-unregistered",
        );
      }
    }
    for (const [key, action] of candidateActions) {
      if (action === unregistered) candidateActions.delete(key);
    }
    for (const [key, action] of actionsBySchedulerIdentity) {
      if (action === unregistered) actionsBySchedulerIdentity.delete(key);
    }
    for (const [key, template] of userCandidateTemplates) {
      if (template.action === unregistered) userCandidateTemplates.delete(key);
    }
  });
  builtinBroker = createServerBuiltinBrokerClient({
    port: request.builtinBrokerPort,
    claimForRequest: () => {
      const sourceAction = getTransactionSourceAction();
      return sourceAction === undefined
        ? undefined
        : claimForActionRun(sourceAction);
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
      sourceAction !== undefined && hasAnyLiveClaim(sourceAction)
        ? "allow"
        : "suppress",
  }));
  // C1.9c: every scheduler-driven run of an action executes under its
  // resolved lane as the ambient acting context — a driver's explicit pin
  // first (claimed activation, per-lane host-wake rerun), else the lane of
  // the action's single live claim (conflict retries and local-differential
  // reruns of a claimed action re-read ITS lane's instances), else the
  // space lane. The wrapper records the resolved lane so the commit entry
  // attributes this run's transaction to exactly that lane (A6).
  runtime.scheduler.setActionRunWrapper((action, run) => {
    const lane = laneRunPins.get(action) ?? undirectedRunLane(action) ??
      "space";
    laneRunsByAction.set(action, lane);
    if (lane === "space" || storage === null || space === null) return run();
    return storage.runWithExecutionLane(
      space,
      lane as SchedulerExecutionContextKey,
      run,
    );
  });
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
      : claimForActionRun(sourceAction);
    // The egress guard is lane-conditional since C2.8 (context-lattice
    // §3/OQ6): §B.5's causal-actor/sponsor-match consent applies ONLY to
    // SPACE-lane claims, whose executing identity is an unrelated volunteer
    // sponsor. A scoped-lane claim's builtin is the LANE principal's own
    // standing side effect — the acting context IS the consent — so the
    // guard validates the LANE identity instead: this run must be pinned to
    // the claim's own lane (the scheduler run wrapper records it), or the
    // continuation would egress under another lane's identity. The lane
    // GRANT's liveness is validated host-side at the brokered-egress
    // execution point (Server.hasLiveExecutionClaim consults the live lane
    // grant at the bound generation).
    if (sourceAction !== undefined && claim !== undefined) {
      if (claim.contextKey === "space") {
        if (causalActorMatchesByAction.get(sourceAction) !== true) {
          const error = new ServerBuiltinUnservedError(
            "builtin-causal-actor-mismatch",
            "server builtin causal actor does not match the lease sponsor",
          );
          recordPermanentBuiltinFailure(sourceAction, claim, error);
          return Promise.reject(error);
        }
      } else if (laneRunsByAction.get(sourceAction) !== claim.contextKey) {
        const error = new ServerBuiltinUnservedError(
          "builtin-lane-identity-mismatch",
          "server builtin run is not pinned to its claim's lane",
        );
        recordPermanentBuiltinFailure(sourceAction, claim, error);
        return Promise.reject(error);
      }
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
    // The rejected commit belongs to the action's latest run; release
    // exactly that run's lane claim (C1.9c), never a sibling lane's.
    const claim = claimForActionRun(action);
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
  // Lanes live at startup arrive with initialize so the first candidates
  // already carry their lane's generation (A24).
  applyLaneDemands(validateWireLanes(request.lanes));
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
    // C1.9b: a user lane's claimed run must see the lane's durable instance
    // rows, not replica defaults (see hydrateExecutionLane).
    await hydrateExecutionLane(claim, action);
    const identity = schedulerIdentityKeyForAction(action, claim);
    pendingCausalActorMatches.delete(identity);
    storage.discardShadowWritesForAction(space, action);
    setLiveClaim(action, claim);
    // C3.11: a cross-space-read claim's FIRST run must be stamped, or its
    // accepted observation floors at session and fences the space-rank claim.
    // No-op for a same-space claim (byte-identical), fail-closed for a foreign
    // read that cannot be served (the run then settles unserved).
    await hydrateForeignReadMount(claim, action);
    (action as Action & { prepareClaimedRerun?: () => void })
      .prepareClaimedRerun?.();
    // Scheduler completion means the action transaction has been kicked off,
    // but the storage router can still be selecting its async route. The exact
    // afterRouteSelected callback is the readiness acknowledgement; eventual
    // accepted settlement remains deliberately outside the global work lane.
    // The run is pinned to the claim's lane (C1.9c): the scheduler run
    // wrapper makes it the ambient acting context so its synchronous reads
    // resolve that lane's document instances, and records it so the commit
    // attributes to exactly this lane across awaits.
    laneRunPins.set(action, claim.contextKey);
    try {
      await storage.runWithExecutionLane(
        space,
        claim.contextKey,
        () => runtime!.scheduler.run(action),
      );
    } finally {
      laneRunPins.delete(action);
    }
    await attempt.routeReady;
    return { finalSettlement: attempt.finalSettlement };
  } catch (error) {
    finishClaimedAttempt(claim, action);
    deleteExactLaneClaim(claim, action);
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
  actionRouter = null;
  space = null;
  branch = "";
  sponsorLaneKey = null;
  selectiveWake = null;
  demanded.clear();
  instantiatedDemand.clear();
  pendingDemand.clear();
  candidateActions.clear();
  userCandidateTemplates.clear();
  laneHydration.clear();
  laneDemands.clear();
  actionsBySchedulerIdentity.clear();
  pendingCausalActorMatches.clear();
  causalActorMatchesByAction = new WeakMap<object, boolean>();
  permanentBuiltinFailureByAction = new WeakMap<
    object,
    { claim: ExecutionClaim; diagnosticCode: string }
  >();
  claimsByAction = new WeakMap<object, Map<string, ExecutionClaim>>();
  laneRunPins = new WeakMap<object, string>();
  laneRunsByAction = new WeakMap<object, string>();
  foreignReadTargetsByAction = new WeakMap<
    object,
    Map<string, IMemorySpaceAddress>
  >();
  pendingLaneRerunsByAction = new WeakMap<object, Set<string>>();
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
      applyLaneDemands(validateWireLanes(request.lanes));
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
