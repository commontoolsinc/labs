import {
  type ActionClaimKey,
  type ExecutionClaim,
  userExecutionContextKey,
} from "@commonfabric/memory/v2";
import type { MemorySpace } from "@commonfabric/memory/interface";
import type { CandidateClaim } from "./deno-space-executor.ts";
import {
  isSchedulerActionObservation,
  type SchedulerActionObservation,
} from "../scheduler/persistent-observation.ts";
import {
  actionClaimKeyFromObservation,
  classifyStaticActionServability,
  dynamicActionTransactionUnservableReason,
  executionClaimMatchesActionKey,
} from "../scheduler/servability.ts";
import type {
  ActionTransactionCommitResult,
  ActionTransactionRoute,
  ActionTransactionRouteInput,
  ActionTransactionRouter,
} from "../storage/v2.ts";
import type { IMemorySpaceAddress } from "../storage/interface.ts";
import { toMemorySpaceAddress } from "../link-types.ts";
import type { TelemetryAnnotations } from "../scheduler/types.ts";
import type { CompleteActionScopeSummary } from "../scheduler/persistent-observation.ts";
import { internSchemaAsTaggedHashString } from "@commonfabric/data-model/schema-hash";
import type { JSONSchema } from "../builder/types.ts";
import { touchedPointerPaths } from "../../../memory/v2/patch.ts";
import {
  isServerExecutableBuiltinId,
  type ServerBuiltinActionDescriptor,
  serverBuiltinImplementationHash,
} from "../builtins/server-execution.ts";
import { isCellLink, parseLink } from "../link-utils.ts";
import { getLogger } from "@commonfabric/utils/logger";

const logger = getLogger("execution.executor", {
  enabled: true,
  level: "error",
});

export interface ExecutorCandidateDiagnostic {
  readonly diagnosticCode: string;
  readonly claimKey?: ActionClaimKey;
}

export type ExecutorActionTransactionPlacement =
  | "shadow"
  | "authoritative";

export type ExecutorActionTransactionRouter = ActionTransactionRouter & {
  /**
   * Clear the per-lane candidate dedupe for one (action, lane) after the
   * WORKER released that lane's claim outside the router's own paths (a
   * scheduler commit rejection, a lane drain). Without this the next rerun
   * would suppress the identical candidate and the lane could never be
   * re-claimed (C1.9c).
   */
  forgetLaneCandidate(sourceAction: object, lane: string): void;
};

export interface ExecutorActionTransactionRouterOptions {
  readonly servedSpace: MemorySpace;
  readonly branch: string;
  /** The Worker has a narrow host broker for supported builtin effects. */
  readonly builtinBrokerAvailable?: boolean;
  /**
   * C1.5a candidate context rank, default OFF: when true, a computation
   * whose surfaces include user-scoped addresses classifies at user rank and
   * its candidate claim key carries `user:<lanePrincipal>` instead of
   * unserving. Effects and session-scoped surfaces keep today's space-only
   * classification either way (amendment 8). Requires `lanePrincipal`.
   */
  readonly userRankCandidates?: boolean;
  /** Principal of this Worker's acting context — the canonical `user:<did>`
   * candidate keys are constructed from it (amendment 18 helpers only). */
  readonly lanePrincipal?: string;
  /**
   * C1.9c per-lane candidates: canonical `user:<did>` context keys of the
   * OPEN user lanes whose aggregated demand (C1.8) covers `pieceId`. A
   * user-rank action produces one candidate per returned lane. An absent
   * callback or an `undefined` result (the pre-lane wire) falls back to the
   * lease sponsor's lane — the C1.5a single-lane behavior.
   */
  readonly openUserLaneKeys?: (
    pieceId: string,
  ) => readonly string[] | undefined;
  /** C1.9b lane hydration feed: the non-space (lane-instanced) documents the
   * routed observation touches, deduped by (scope, id) and path-rooted. The
   * Worker syncs exactly these documents under a lane before that lane's
   * claimed run, so the run reads durable instance rows instead of replica
   * defaults. Reported only when user-rank candidacy is enabled. */
  readonly onLaneSurface?: (
    sourceAction: object,
    addresses: readonly IMemorySpaceAddress[],
  ) => void;
  /** Live claim of `sourceAction` ON THE COMMIT'S OWNING LANE (C1.9c): one
   * action object can hold one live claim per lane, and only the lane a
   * commit runs under may attach its claim. Callers ignoring `lane` keep the
   * single-claim C1.5a shape. */
  readonly claimForAction: (
    sourceAction: object,
    lane: ActionClaimKey["contextKey"],
  ) => ExecutionClaim | undefined;
  /** Exact-incarnation permanent broker failure captured synchronously by the
   * Worker. Returning a reason converts the continuation into one canonical
   * observation-only unserved attempt. */
  readonly permanentUnservedReasonForAction?: (
    sourceAction: object,
    claim: ExecutionClaim,
  ) => string | undefined;
  readonly onCandidate: (
    candidate: CandidateClaim,
    sourceAction: object,
  ) => void;
  readonly onDiagnostic?: (diagnostic: ExecutorCandidateDiagnostic) => void;
  /** Bounded Worker-local accounting for complete action transactions whose
   * route was classified as shadow or authoritative. */
  readonly onActionTransaction?: (
    placement: ExecutorActionTransactionPlacement,
  ) => void;
  readonly onUnserved?: (
    claim: ExecutionClaim,
    sourceAction: object,
    diagnosticCode: string,
  ) => void;
  readonly onInvalidated?: (
    claim: ExecutionClaim,
    sourceAction: object,
    diagnosticCode: string,
  ) => void;
  /** Exact attempt readiness after storage accepts an upstream/unserved
   * route, distinct from eventual commit settlement. */
  readonly onAttemptStarted?: (
    claim: ExecutionClaim,
    sourceAction: object,
  ) => void;
  readonly onAttemptSettled?: (
    claim: ExecutionClaim,
    sourceAction: object,
    result: ActionTransactionCommitResult,
  ) => void;
}

/**
 * Route complete executor action transactions. The first proven run stays in
 * the private shadow overlay and reports a CandidateClaim. Once the host sends
 * back an exact claim for that action object, the same router attaches its
 * transient assertion and admits only that whole transaction upstream.
 */
export function createExecutorActionTransactionRouter(
  options: ExecutorActionTransactionRouterOptions,
): ExecutorActionTransactionRouter {
  // Per-lane candidate dedupe (C1.9c): lane contextKey → encoded claim key
  // last reported for this action. A claim invalidation clears only its own
  // lane's entry, so sibling lanes' candidacy is undisturbed.
  const reported = new WeakMap<object, Map<string, string>>();
  // Emit candidates for every UNCLAIMED lane in `candidateKeys` (C1.9c).
  // Called from both local-shadow and authoritative routes: an action
  // already claimed on one lane keeps vouching for its sibling lanes'
  // candidacy — a late-opened or released lane re-candidates from the next
  // routed run instead of starving behind the claimed one.
  const emitCandidates = (
    sourceAction: object,
    candidateKeys: readonly ActionClaimKey[],
    builtinId: ReturnType<typeof prepareSupportedBuiltinObservation>,
  ): void => {
    if (candidateKeys.length === 0) return;
    let lanes = reported.get(sourceAction);
    if (lanes === undefined) {
      lanes = new Map<string, string>();
      reported.set(sourceAction, lanes);
    }
    for (const keyed of candidateKeys) {
      if (
        options.claimForAction(sourceAction, keyed.contextKey) !== undefined
      ) {
        // The lane already holds live authority for this action; its claim
        // lifecycle, not candidacy, owns it now.
        continue;
      }
      const encoded = JSON.stringify(keyed);
      if (lanes.get(keyed.contextKey) === encoded) continue;
      lanes.set(keyed.contextKey, encoded);
      options.onCandidate({
        claimKey: keyed,
        ...(builtinId !== undefined ? { builtinId } : {}),
      }, sourceAction);
    }
  };
  // An unclaimed unservable verdict is stable per diagnostic code and
  // fingerprints; the same action rerunning to the same verdict is pure
  // host/feed churn. Cleared when the action becomes a candidate or its
  // claim is invalidated, so a later regression re-reports once.
  const reportedUnservable = new WeakMap<object, string>();
  const builtinSummaries = new WeakMap<object, CompleteActionScopeSummary>();
  const builtinObservationTemplates = new WeakMap<
    object,
    SchedulerActionObservation
  >();
  const reportUnservable = (
    sourceAction: object,
    diagnosticCode: string,
    observation: {
      implementationFingerprint?: unknown;
      runtimeFingerprint?: unknown;
    },
    claimKey?: ActionClaimKey,
  ): void => {
    const encoded = [
      diagnosticCode,
      String(observation.implementationFingerprint ?? ""),
      String(observation.runtimeFingerprint ?? ""),
    ].join("\0");
    if (reportedUnservable.get(sourceAction) === encoded) return;
    reportedUnservable.set(sourceAction, encoded);
    options.onDiagnostic?.({
      diagnosticCode,
      ...(claimKey !== undefined ? { claimKey } : {}),
    });
  };
  const local = {
    disposition: "local",
    kind: "executor-shadow",
  } as const satisfies ActionTransactionRoute;

  const route: ActionTransactionRouter = (
    input: ActionTransactionRouteInput,
  ) => {
    const sourceAction = input.sourceAction;
    // The commit's owning lane (C1.9c): captured by the provider at commit
    // entry. Only that lane's claim may attach to this transaction — a
    // sibling lane's claim covers a different instance surface.
    const commitLane = input.lane ?? "space";
    const liveClaim = sourceAction === undefined
      ? undefined
      : options.claimForAction(sourceAction, commitLane);
    let observation = input.commit.schedulerObservation;
    let synthesizedContinuation = false;
    if (
      !isSchedulerActionObservation(observation) &&
      sourceAction !== undefined && liveClaim !== undefined
    ) {
      const continuation = synthesizeBuiltinContinuationObservation(
        input,
        sourceAction,
        builtinSummaries,
        builtinObservationTemplates,
      );
      if (continuation !== undefined) {
        input.commit.schedulerObservation = continuation;
        observation = continuation;
        synthesizedContinuation = true;
      }
    }
    if (!isSchedulerActionObservation(observation)) {
      if (sourceAction !== undefined && liveClaim !== undefined) {
        invalidateClaim(
          reported,
          options,
          liveClaim,
          sourceAction,
          "malformed-action-observation",
        );
      } else if (sourceAction !== undefined) {
        reportUnservable(sourceAction, "malformed-action-observation", {});
      } else {
        options.onDiagnostic?.({
          diagnosticCode: "malformed-action-observation",
        });
      }
      return local;
    }
    if (sourceAction === undefined) {
      const claimKey = actionClaimKeyFromObservation(observation);
      options.onDiagnostic?.({
        diagnosticCode: "missing-source-action",
        ...(claimKey !== undefined ? { claimKey } : {}),
      });
      return local;
    }
    const builtinId = prepareSupportedBuiltinObservation(
      input,
      observation,
      sourceAction,
      builtinSummaries,
      builtinObservationTemplates,
      !synthesizedContinuation,
    );
    const routedObservation = input.commit
      .schedulerObservation as SchedulerActionObservation;
    const userLaneEnabled = options.userRankCandidates === true &&
      typeof options.lanePrincipal === "string" &&
      options.lanePrincipal.length > 0;
    if (userLaneEnabled && options.onLaneSurface !== undefined) {
      const laneSurface = laneScopedDocumentAddresses(routedObservation);
      if (laneSurface.length > 0) {
        options.onLaneSurface(sourceAction, laneSurface);
      }
    }
    const staticDecision = classifyStaticActionServability(
      routedObservation,
      options.servedSpace,
      userLaneEnabled ? { userContext: true } : undefined,
    );
    // The candidate context rank follows the static classification: a
    // user-rank computation keys its candidates by the canonical user
    // context keys of the OPEN lanes with demand for its piece (C1.9c); on
    // the pre-lane wire the lease sponsor's lane remains the only one.
    const contextRank: "space" | "user" =
      staticDecision.status === "claim-ready" &&
        staticDecision.contextRank === "user"
        ? "user"
        : "space";
    // This commit's own claim identity: a claimed user-rank commit belongs
    // to its owning lane; an unclaimed (space-lane) run of a user-rank
    // action keeps the sponsor-lane key as the representative for
    // diagnostics and dedupe.
    const commitContextKey = contextRank === "user"
      ? (commitLane !== "space"
        ? commitLane
        : userExecutionContextKey(options.lanePrincipal!))
      : "space";
    const claimKey = actionClaimKeyFromObservation(
      routedObservation,
      commitContextKey,
    );
    if (claimKey === undefined) {
      const diagnosticCode = staticDecision.status === "unservable"
        ? staticDecision.reason
        : "malformed-candidate";
      if (liveClaim !== undefined) {
        invalidateClaim(
          reported,
          options,
          liveClaim,
          sourceAction,
          diagnosticCode,
        );
      } else {
        reportUnservable(sourceAction, diagnosticCode, routedObservation);
      }
      return local;
    }
    if (
      liveClaim !== undefined &&
      !executionClaimMatchesActionKey(liveClaim, claimKey)
    ) {
      invalidateClaim(
        reported,
        options,
        liveClaim,
        sourceAction,
        "claim-key-mismatch",
        claimKey,
      );
      return local;
    }
    // Engine-emission lockstep for the §4 output-widening pair (A7): a
    // user-rank claimed commit presents its trusted certificate with the
    // acting lane's instance of each broad direct output added to the write
    // envelopes — exactly the pair shape the engine's scope-sensitive
    // coverage (and its conformance fixtures) accepts.
    const observationForClaim = contextRank === "user"
      ? widenUserLaneOutputEnvelopes(routedObservation)
      : routedObservation;
    const permanentUnservedReason = liveClaim === undefined
      ? undefined
      : options.permanentUnservedReasonForAction?.(sourceAction, liveClaim);
    if (permanentUnservedReason !== undefined) {
      attachClaimAssertion(input.commit, observationForClaim, liveClaim!);
      return unservedRoute(
        reported,
        options,
        liveClaim!,
        sourceAction,
        permanentUnservedReason,
      );
    }
    const brokeredBuiltinReady = staticDecision.status === "broker-required" &&
      options.builtinBrokerAvailable === true && builtinId !== undefined;
    if (staticDecision.status !== "claim-ready" && !brokeredBuiltinReady) {
      const diagnosticCode = staticDecision.status === "broker-required"
        ? options.builtinBrokerAvailable === true
          ? "unsupported-server-builtin"
          : "broker-required"
        : staticDecision.reason;
      if (liveClaim !== undefined) {
        attachClaimAssertion(input.commit, observationForClaim, liveClaim);
        return unservedRoute(
          reported,
          options,
          liveClaim,
          sourceAction,
          diagnosticCode,
        );
      }
      reportUnservable(
        sourceAction,
        diagnosticCode,
        routedObservation,
        claimKey,
      );
      return local;
    }
    const dynamicReason = dynamicActionTransactionUnservableReason(
      input,
      routedObservation,
      {
        servedSpace: options.servedSpace,
        branch: options.branch,
        contextRank,
        // Executor user-rank commits act on the lane, so the engine's §4
        // broad scope-naming backstop applies at this seam too.
        laneActingCommit: contextRank === "user",
      },
    );
    if (dynamicReason !== undefined) {
      if (liveClaim !== undefined) {
        attachClaimAssertion(input.commit, observationForClaim, liveClaim);
        return unservedRoute(
          reported,
          options,
          liveClaim,
          sourceAction,
          dynamicReason,
        );
      }
      reportUnservable(
        sourceAction,
        dynamicReason,
        routedObservation,
        claimKey,
      );
      return local;
    }
    // One candidate per serving lane (C1.9c): space rank keys the single
    // space candidate; user rank keys one candidate per open user lane
    // whose demand covers the piece. Servability is an action-level
    // property (the certificate names declared scopes, never a principal),
    // so one proven run vouches for every lane's candidate.
    const candidateKeys: ActionClaimKey[] = contextRank === "user"
      ? candidateUserLaneKeys(options, claimKey.pieceId).map((
        contextKey,
      ) => ({ ...claimKey, contextKey }))
      : [claimKey];
    if (liveClaim === undefined) {
      if (routedObservation.transactionKind === "action-run") {
        options.onActionTransaction?.("shadow");
        logger.debug("execution-server-shadow-action-run", () => [
          "Server shadow action run completed",
          { actionId: claimKey.actionId, actionKind: claimKey.actionKind },
        ]);
      }
      return {
        ...local,
        afterLocalApply: () => {
          // The action proved servable; a later unservable regression is new
          // information and must report again.
          reportedUnservable.delete(sourceAction);
          emitCandidates(sourceAction, candidateKeys, builtinId);
        },
      };
    }

    attachClaimAssertion(input.commit, observationForClaim, liveClaim);
    if (routedObservation.transactionKind === "action-run") {
      options.onActionTransaction?.("authoritative");
      logger.debug("execution-server-authoritative-action-run", () => [
        "Server authoritative action run completed",
        { actionId: liveClaim.actionId, actionKind: liveClaim.actionKind },
      ]);
    }
    // A claimed run keeps vouching for its SIBLING lanes (C1.9c): a
    // still-unclaimed lane's candidate re-emits from this proven run. Only a
    // user-rank action has siblings — a space-rank claim owns the sole
    // "space" lane, so its lone candidate is already the claimed one and
    // `emitCandidates` would no-op. Attach the callback only when it does
    // real work (sibling vouching or the host's attempt-started hook), so a
    // fully-claimed space run stays a bare upstream route.
    const vouchForSiblingLanes = contextRank === "user";
    const afterRouteSelected =
      options.onAttemptStarted !== undefined || vouchForSiblingLanes
        ? () => {
          options.onAttemptStarted?.(liveClaim, sourceAction);
          if (vouchForSiblingLanes) {
            emitCandidates(sourceAction, candidateKeys, builtinId);
          }
        }
        : undefined;
    return {
      disposition: "upstream",
      ...(afterRouteSelected !== undefined ? { afterRouteSelected } : {}),
      ...(options.onAttemptSettled
        ? {
          onCommitSettled: (result: ActionTransactionCommitResult) =>
            options.onAttemptSettled!(liveClaim, sourceAction, result),
        }
        : {}),
      ...(options.onUnserved
        ? {
          onFirewallRejected: (diagnosticCode: string) => {
            reported.get(sourceAction)?.delete(liveClaim.contextKey);
            options.onUnserved!(
              liveClaim,
              sourceAction,
              diagnosticCode,
            );
          },
        }
        : {}),
    };
  };
  return Object.assign(route, {
    forgetLaneCandidate: (sourceAction: object, lane: string) => {
      reported.get(sourceAction)?.delete(lane);
    },
  });
}

/** The user lanes a user-rank action's candidates key by (C1.9c): every
 * open lane whose C1.8 demand slice covers the piece; the sponsor's lane on
 * the pre-lane wire. Canonical keys only (amendment 18). */
function candidateUserLaneKeys(
  options: ExecutorActionTransactionRouterOptions,
  pieceId: string,
): readonly ActionClaimKey["contextKey"][] {
  const laneKeys = options.openUserLaneKeys?.(pieceId);
  if (laneKeys === undefined) {
    return [userExecutionContextKey(options.lanePrincipal!)];
  }
  return [...new Set(laneKeys)] as ActionClaimKey["contextKey"][];
}

function prepareSupportedBuiltinObservation(
  input: ActionTransactionRouteInput,
  observation: SchedulerActionObservation,
  sourceAction: object,
  summaries: WeakMap<object, CompleteActionScopeSummary>,
  templates: WeakMap<object, SchedulerActionObservation>,
  refreshFromActionRun: boolean,
):
  | import("../builtins/server-execution.ts").ServerExecutableBuiltinId
  | undefined {
  const descriptor = supportedBuiltinDescriptor(sourceAction, observation);
  if (descriptor === undefined) return undefined;

  let summary = summaries.get(sourceAction);
  if (summary === undefined) {
    summary = {
      version: 1,
      complete: true,
      implementationFingerprint: observation.implementationFingerprint,
      runtimeFingerprint: observation.runtimeFingerprint,
      piece: toMemorySpaceAddress(descriptor.piece),
      reads: dedupeAddresses([
        ...descriptor.reads.map(toMemorySpaceAddress),
        ...descriptor.runtimeWrites.map(toMemorySpaceAddress),
        ...descriptor.runtimeWrites.map((link) => ({
          ...toMemorySpaceAddress(link),
          path: [],
        })),
        ...observation.reads,
        ...observation.shallowReads,
        ...commitReadAddresses(input),
      ]),
      writes: dedupeAddresses([
        ...descriptor.writes.map(toMemorySpaceAddress),
        ...descriptor.runtimeWrites.map(toMemorySpaceAddress),
        ...descriptor.runtimeWrites.map((link) => ({
          ...toMemorySpaceAddress(link),
          path: [],
        })),
        ...observation.actualChangedWrites,
        ...observation.currentKnownWrites,
        ...(observation.declaredWrites ?? []),
        ...observation.materializerWriteEnvelopes,
        ...(observation.ignoredSchedulingWrites ?? []),
      ]),
      materializerWriteEnvelopes: dedupeAddresses(
        observation.materializerWriteEnvelopes,
      ),
      directOutputs: dedupeAddresses(
        descriptor.directOutputs.map(toMemorySpaceAddress),
      ),
    };
    summaries.set(sourceAction, summary);
  } else if (refreshFromActionRun) {
    // Supported builtin actions retain one sourceAction across reruns. Their
    // trusted runtimeWrites array can grow as lazy internal cells are minted,
    // and a later input may exercise framework/CFC reads not present in the
    // first run. Refresh the certificate with the same trusted descriptor and
    // canonical commit surfaces used for the initial candidate; otherwise the
    // second claimed request is rejected as an unobserved read and loops
    // revoke/reclaim without ever reaching the broker.
    summary = {
      ...summary,
      reads: dedupeAddresses([
        ...summary.reads,
        ...descriptor.reads.map(toMemorySpaceAddress),
        ...descriptor.runtimeWrites.map(toMemorySpaceAddress),
        ...descriptor.runtimeWrites.map((link) => ({
          ...toMemorySpaceAddress(link),
          path: [],
        })),
        ...observation.reads,
        ...observation.shallowReads,
        ...commitReadAddresses(input),
      ]),
      writes: dedupeAddresses([
        ...summary.writes,
        ...descriptor.writes.map(toMemorySpaceAddress),
        ...descriptor.runtimeWrites.map(toMemorySpaceAddress),
        ...descriptor.runtimeWrites.map((link) => ({
          ...toMemorySpaceAddress(link),
          path: [],
        })),
        ...observation.actualChangedWrites,
        ...observation.currentKnownWrites,
        ...(observation.declaredWrites ?? []),
        ...observation.materializerWriteEnvelopes,
        ...(observation.ignoredSchedulingWrites ?? []),
        ...commitWriteAddresses(input),
      ]),
    };
    summaries.set(sourceAction, summary);
  }
  if (refreshFromActionRun) templates.set(sourceAction, observation);
  input.commit.schedulerObservation = {
    ...observation,
    completeActionScopeSummary: summary,
  };
  return descriptor.id;
}

function supportedBuiltinDescriptor(
  sourceAction: object,
  observation: SchedulerActionObservation,
): ServerBuiltinActionDescriptor | undefined {
  const descriptor = (sourceAction as Partial<TelemetryAnnotations>)
    .serverBuiltin;
  if (
    descriptor?.version !== 1 ||
    !isServerExecutableBuiltinId(descriptor.id) ||
    observation.actionKind !== "effect" ||
    observation.implementationFingerprint !==
      `impl:${serverBuiltinImplementationHash(descriptor.id)}` ||
    !isAddressLike(descriptor.piece) ||
    !Array.isArray(descriptor.reads) ||
    !descriptor.reads.every(isAddressLike) ||
    !Array.isArray(descriptor.writes) ||
    !descriptor.writes.every(isAddressLike) ||
    !Array.isArray(descriptor.runtimeWrites) ||
    !descriptor.runtimeWrites.every(isAddressLike) ||
    !Array.isArray(descriptor.directOutputs) ||
    !descriptor.directOutputs.every(isAddressLike)
  ) {
    return undefined;
  }
  return descriptor;
}

function synthesizeBuiltinContinuationObservation(
  input: ActionTransactionRouteInput,
  sourceAction: object,
  summaries: WeakMap<object, CompleteActionScopeSummary>,
  templates: WeakMap<object, SchedulerActionObservation>,
): SchedulerActionObservation | undefined {
  let summary = summaries.get(sourceAction);
  const template = templates.get(sourceAction);
  if (summary === undefined || template === undefined) return undefined;
  const writes = commitWriteAddresses(input);
  const canonicalSchemaWrites = canonicalSchemaDocumentWriteAddresses(input);
  const materializedDocuments = sameTransactionMaterializedDocuments(
    input,
    summary,
  );
  if (
    canonicalSchemaWrites.length > 0 || materializedDocuments.length > 0
  ) {
    // CFC persistence may materialize a content-addressed schema document only
    // when an async model result is written. Its id can depend on the result's
    // post-call confidentiality envelope, so it cannot always be listed by the
    // pre-call builtin descriptor. Structured builtin results may likewise
    // split fresh entity documents that are linked from an already-authorized
    // write in this same transaction. Admit only canonical schema documents or
    // fresh same-transaction linked materializations; all semantic writes
    // remain bounded by the descriptor's pre-effect surface.
    summary = {
      ...summary,
      reads: dedupeAddresses([...summary.reads, ...materializedDocuments]),
      writes: dedupeAddresses([
        ...summary.writes,
        ...canonicalSchemaWrites,
        ...materializedDocuments,
      ]),
    };
    summaries.set(sourceAction, summary);
  }
  return {
    ...template,
    observedAtSeq: 0,
    transactionKind: "action-run",
    reads: commitReadAddresses(input),
    shallowReads: [],
    actualChangedWrites: writes,
    currentKnownWrites: summary.writes,
    materializerWriteEnvelopes: summary.materializerWriteEnvelopes,
    completeActionScopeSummary: summary,
    status: "success",
    executionClaimAssertion: undefined,
  };
}

/**
 * Return fresh entity documents materialized by a claimed builtin
 * continuation. A document is admitted only when all of these hold:
 *
 * - an already-authorized operation contains a direct link to it;
 * - the same commit creates it with a whole-document set; and
 * - the commit proves absence with seq-0 document reads.
 *
 * Following links transitively supports arrays/objects split across multiple
 * fresh documents without turning an arbitrary side write into a declared
 * surface.
 */
function sameTransactionMaterializedDocuments(
  input: ActionTransactionRouteInput,
  summary: CompleteActionScopeSummary,
): IMemorySpaceAddress[] {
  const writeEnvelopes = [
    ...summary.writes,
    ...summary.materializerWriteEnvelopes,
    ...summary.directOutputs,
  ];
  const operationKey = (operation: {
    id: string;
    scope?: "space" | "user" | "session";
  }) => `${operation.scope ?? "space"}:${operation.id}`;
  const provesFreshDocument = (operation: {
    id: string;
    scope?: "space" | "user" | "session";
  }): boolean => {
    const reads = input.commit.reads.confirmed.filter((read) =>
      read.id === operation.id &&
      (read.scope ?? "space") === (operation.scope ?? "space") &&
      read.seq === 0
    );
    return reads.some((read) => read.path.length === 0) ||
      ["cfc", "value"].every((field) =>
        reads.some((read) => read.path.length === 1 && read.path[0] === field)
      );
  };
  const freshSetOperations = new Map(
    input.commit.operations.flatMap((operation) => {
      if (
        operation.op !== "set" ||
        (operation.scope ?? "space") !== "space" ||
        !operation.id.startsWith("of:") ||
        !provesFreshDocument(operation)
      ) {
        return [];
      }
      return [[operationKey(operation), operation] as const];
    }),
  );
  const materialized = new Map<string, IMemorySpaceAddress>();
  const pendingValues: Array<{
    value: unknown;
    base: IMemorySpaceAddress;
  }> = [];

  const enqueueOperationValues = (
    operation: ActionTransactionRouteInput["commit"]["operations"][number],
  ): void => {
    if (operation.op === "sqlite") return;
    const base = addressOf({
      space: input.space,
      id: operation.id,
      scope: operation.scope ?? "space",
      path: [],
    });
    if (operation.op === "set") {
      pendingValues.push({ value: operation.value, base });
    } else if (operation.op === "patch") {
      for (const patch of operation.patches) {
        if ("value" in patch) pendingValues.push({ value: patch.value, base });
        if (patch.op === "splice") {
          pendingValues.push({ value: patch.add, base });
        }
      }
    }
  };

  for (const operation of input.commit.operations) {
    if (operation.op === "sqlite") continue;
    const operationAddress = addressOf({
      space: input.space,
      id: operation.id,
      scope: operation.scope ?? "space",
      path: [],
    });
    if (
      writeEnvelopes.some((envelope) =>
        envelope.id === operationAddress.id &&
        (envelope.scope ?? "space") === operationAddress.scope
      )
    ) {
      enqueueOperationValues(operation);
    }
  }

  const visit = (value: unknown, base: IMemorySpaceAddress): void => {
    if (isCellLink(value)) {
      const link = parseLink(value, base);
      if (
        link?.space !== input.space || link.path.length !== 0 ||
        (link.scope ?? "space") !== "space"
      ) return;
      const key = `space:${link.id}`;
      const setOperation = freshSetOperations.get(key);
      if (setOperation === undefined || materialized.has(key)) return;
      materialized.set(key, addressOf({ ...link, path: [] }));
      enqueueOperationValues(setOperation);
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, base);
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const entry of Object.values(value)) visit(entry, base);
    }
  };

  for (let index = 0; index < pendingValues.length; index++) {
    const pending = pendingValues[index]!;
    visit(pending.value, pending.base);
  }
  return [...materialized.values()];
}

function canonicalSchemaDocumentWriteAddresses(
  input: ActionTransactionRouteInput,
): IMemorySpaceAddress[] {
  return input.commit.operations.flatMap((operation) => {
    if (
      operation.op !== "set" ||
      (operation.scope ?? "space") !== "space" ||
      !operation.id.startsWith("cid:") ||
      Object.keys(operation.value).some((key) => key !== "value") ||
      operation.value.value === undefined
    ) {
      return [];
    }
    try {
      if (
        internSchemaAsTaggedHashString(
          operation.value.value as JSONSchema,
        ) !== operation.id.slice("cid:".length)
      ) {
        return [];
      }
    } catch {
      return [];
    }
    return [addressOf({
      space: input.space,
      id: operation.id,
      scope: "space",
      path: ["value"],
    })];
  });
}

function commitReadAddresses(
  input: ActionTransactionRouteInput,
): IMemorySpaceAddress[] {
  return [...input.commit.reads.confirmed, ...input.commit.reads.pending].map(
    (read) =>
      addressOf({
        space: input.space,
        id: read.id,
        scope: read.scope ?? "space",
        path: [...read.path],
      }),
  );
}

function commitWriteAddresses(
  input: ActionTransactionRouteInput,
): IMemorySpaceAddress[] {
  return input.commit.operations.flatMap((operation) => {
    if (operation.op === "sqlite") return [];
    const paths = operation.op === "patch"
      ? operation.patches.flatMap(touchedPointerPaths)
      : operation.op === "delete"
      ? [[]]
      : [["value"]];
    return paths.map((path) =>
      addressOf({
        space: input.space,
        id: operation.id,
        scope: operation.scope ?? "space",
        path,
      })
    );
  });
}

function dedupeAddresses(
  values: readonly (IMemorySpaceAddress | {
    space: string;
    id: string;
    path: readonly string[];
    scope?: "space" | "user" | "session";
    type?: string;
  })[],
): IMemorySpaceAddress[] {
  const result = new Map<string, IMemorySpaceAddress>();
  for (const value of values) {
    const address = addressOf(value);
    result.set(
      JSON.stringify([
        address.space,
        address.id,
        address.scope ?? "space",
        address.path,
      ]),
      address,
    );
  }
  return [...result.values()];
}

function addressOf(value: {
  space: string;
  id: string;
  path: readonly string[];
  scope?: "space" | "user" | "session";
  type?: string;
}): IMemorySpaceAddress {
  return {
    space: value.space as MemorySpace,
    id: value.id as IMemorySpaceAddress["id"],
    scope: value.scope ?? "space",
    path: [...value.path],
    ...(value.type !== undefined
      ? { type: value.type as IMemorySpaceAddress["type"] }
      : {}),
  };
}

function isAddressLike(value: unknown): value is {
  space: string;
  id: string;
  path: string[];
  scope?: "space" | "user" | "session";
  type?: string;
} {
  if (typeof value !== "object" || value === null) return false;
  const address = value as Record<string, unknown>;
  return typeof address.space === "string" && address.space.length > 0 &&
    typeof address.id === "string" && address.id.length > 0 &&
    Array.isArray(address.path) &&
    address.path.every((segment) => typeof segment === "string") &&
    (address.scope === undefined || address.scope === "space" ||
      address.scope === "user" || address.scope === "session");
}

function invalidateClaim(
  reported: WeakMap<object, Map<string, string>>,
  options: ExecutorActionTransactionRouterOptions,
  claim: ExecutionClaim,
  sourceAction: object,
  diagnosticCode: string,
  claimKey?: ActionClaimKey,
): void {
  reported.get(sourceAction)?.delete(claim.contextKey);
  if (options.onInvalidated !== undefined) {
    options.onInvalidated(claim, sourceAction, diagnosticCode);
  } else {
    options.onDiagnostic?.({
      diagnosticCode,
      ...(claimKey !== undefined ? { claimKey } : {}),
    });
  }
}

function unservedRoute(
  reported: WeakMap<object, Map<string, string>>,
  options: ExecutorActionTransactionRouterOptions,
  claim: ExecutionClaim,
  sourceAction: object,
  diagnosticCode: string,
): ActionTransactionRoute {
  return {
    disposition: "unserved",
    diagnosticCode,
    ...(options.onAttemptStarted
      ? {
        afterRouteSelected: () =>
          options.onAttemptStarted!(claim, sourceAction),
      }
      : {}),
    ...(options.onUnserved
      ? {
        onSettled: () => {
          reported.get(sourceAction)?.delete(claim.contextKey);
          options.onUnserved!(claim, sourceAction, diagnosticCode);
        },
      }
      : {}),
  };
}

/**
 * The lane-instanced document set of one routed observation (C1.9b): every
 * distinct (scope, id) with a non-space declared scope, path-rooted. These
 * are the documents whose per-lane instance rows a claimed lane run reads or
 * writes, and therefore the exact set the Worker must hydrate under a lane
 * before running there.
 */
function laneScopedDocumentAddresses(
  observation: SchedulerActionObservation,
): IMemorySpaceAddress[] {
  const summary = observation.completeActionScopeSummary;
  const sources: readonly (readonly IMemorySpaceAddress[])[] = [
    observation.reads,
    observation.shallowReads,
    observation.actualChangedWrites,
    observation.currentKnownWrites,
    observation.declaredWrites ?? [],
    observation.materializerWriteEnvelopes,
    ...(summary === undefined
      ? []
      : [summary.reads, summary.writes, summary.directOutputs]),
  ];
  const result = new Map<string, IMemorySpaceAddress>();
  for (const addresses of sources) {
    for (const address of addresses) {
      const scope = address.scope ?? "space";
      if (scope === "space") continue;
      const key = `${scope}\0${address.id}`;
      if (!result.has(key)) {
        result.set(key, { ...address, path: [] });
      }
    }
  }
  return [...result.values()];
}

/**
 * The §4 output-widening pair, presented as the engine admits it
 * (context-lattice C1.2/C1.9): the transformer certificate declares the
 * derived output ONCE at the broad space address, while a user-rank run
 * writes that document twice — the broad scope-naming redirect link plus the
 * value at the ACTING principal's user instance. The engine's write-coverage
 * check is scope-sensitive, so the claimed commit's trusted summary must
 * carry the lane instance explicitly; add `user`-scope twins of the broad
 * direct outputs to the write envelopes (id and path unchanged — never
 * another document, never session scope). This mirrors the shape pinned by
 * the engine's lane-firewall conformance tests.
 */
function widenUserLaneOutputEnvelopes(
  observation: SchedulerActionObservation,
): SchedulerActionObservation {
  const summary = observation.completeActionScopeSummary;
  if (summary === undefined) return observation;
  const laneInstances = summary.directOutputs
    .filter((output) => (output.scope ?? "space") === "space")
    .map((output) => ({
      ...output,
      scope: "user" as const,
      path: [...output.path],
    }));
  if (laneInstances.length === 0) return observation;
  const writes = dedupeAddresses([...summary.writes, ...laneInstances]);
  if (writes.length === summary.writes.length) return observation;
  return {
    ...observation,
    completeActionScopeSummary: { ...summary, writes },
  };
}

function attachClaimAssertion(
  commit: ActionTransactionRouteInput["commit"],
  observation: SchedulerActionObservation,
  claim: ExecutionClaim,
): void {
  commit.schedulerObservation = {
    ...observation,
    executionClaimAssertion: {
      contextKey: claim.contextKey,
      leaseGeneration: claim.leaseGeneration,
      claimGeneration: claim.claimGeneration,
    },
  };
}
