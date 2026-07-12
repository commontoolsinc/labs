import type {
  ActionClaimKey,
  CellScope,
  ExecutionClaim,
} from "@commonfabric/memory/v2";
import type { MemorySpace } from "@commonfabric/memory/interface";
import type { CandidateClaim } from "./deno-space-executor.ts";
import {
  isSchedulerActionObservation,
  type SchedulerActionObservation,
} from "../scheduler/persistent-observation.ts";
import { classifyStaticActionServability } from "../scheduler/servability.ts";
import type {
  ActionTransactionRoute,
  ActionTransactionRouteInput,
  ActionTransactionRouter,
} from "../storage/v2.ts";
import type { IMemorySpaceAddress } from "../storage/interface.ts";

export interface ExecutorCandidateDiagnostic {
  readonly diagnosticCode: string;
  readonly claimKey?: ActionClaimKey;
}

export interface ExecutorActionTransactionRouterOptions {
  readonly servedSpace: MemorySpace;
  readonly branch: string;
  readonly claimForAction: (sourceAction: object) => ExecutionClaim | undefined;
  readonly onCandidate: (
    candidate: CandidateClaim,
    sourceAction: object,
  ) => void;
  readonly onDiagnostic?: (diagnostic: ExecutorCandidateDiagnostic) => void;
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
}

/**
 * Route complete executor action transactions. The first proven run stays in
 * the private shadow overlay and reports a CandidateClaim. Once the host sends
 * back an exact claim for that action object, the same router attaches its
 * transient assertion and admits only that whole transaction upstream.
 */
export function createExecutorActionTransactionRouter(
  options: ExecutorActionTransactionRouterOptions,
): ActionTransactionRouter {
  const reported = new WeakMap<object, string>();
  const local = {
    disposition: "local",
    kind: "executor-shadow",
  } as const satisfies ActionTransactionRoute;

  return (input: ActionTransactionRouteInput) => {
    const observation = input.commit.schedulerObservation;
    if (!isSchedulerActionObservation(observation)) {
      const sourceAction = input.sourceAction;
      const liveClaim = sourceAction === undefined
        ? undefined
        : options.claimForAction(sourceAction);
      if (sourceAction !== undefined && liveClaim !== undefined) {
        invalidateClaim(
          reported,
          options,
          liveClaim,
          sourceAction,
          "malformed-action-observation",
        );
      } else {
        options.onDiagnostic?.({
          diagnosticCode: "malformed-action-observation",
        });
      }
      return local;
    }
    const staticDecision = classifyStaticActionServability(
      observation,
      options.servedSpace,
    );
    const claimKey = safeActionClaimKey(observation);
    if (input.sourceAction === undefined) {
      options.onDiagnostic?.({
        diagnosticCode: "missing-source-action",
        ...(claimKey !== undefined ? { claimKey } : {}),
      });
      return local;
    }
    const sourceAction = input.sourceAction;

    const liveClaim = options.claimForAction(sourceAction);
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
        options.onDiagnostic?.({ diagnosticCode });
      }
      return local;
    }
    if (liveClaim !== undefined && !claimMatchesKey(liveClaim, claimKey)) {
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
    if (staticDecision.status !== "claim-ready") {
      const diagnosticCode = staticDecision.status === "broker-required"
        ? "broker-required"
        : staticDecision.reason;
      if (liveClaim !== undefined) {
        attachClaimAssertion(input.commit, observation, liveClaim);
        return unservedRoute(
          reported,
          options,
          liveClaim,
          sourceAction,
          diagnosticCode,
        );
      }
      options.onDiagnostic?.({ diagnosticCode, claimKey });
      return local;
    }
    const dynamicReason = dynamicUnservableReason(input, observation, options);
    if (dynamicReason !== undefined) {
      if (liveClaim !== undefined) {
        attachClaimAssertion(input.commit, observation, liveClaim);
        return unservedRoute(
          reported,
          options,
          liveClaim,
          sourceAction,
          dynamicReason,
        );
      }
      options.onDiagnostic?.({ diagnosticCode: dynamicReason, claimKey });
      return local;
    }
    if (liveClaim === undefined) {
      const encoded = JSON.stringify(claimKey);
      if (reported.get(sourceAction) !== encoded) {
        reported.set(sourceAction, encoded);
        options.onCandidate({ claimKey }, sourceAction);
      }
      return local;
    }

    attachClaimAssertion(input.commit, observation, liveClaim);
    return {
      disposition: "upstream",
      ...(options.onUnserved
        ? {
          onFirewallRejected: (diagnosticCode: string) => {
            reported.delete(sourceAction);
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
}

function invalidateClaim(
  reported: WeakMap<object, string>,
  options: ExecutorActionTransactionRouterOptions,
  claim: ExecutionClaim,
  sourceAction: object,
  diagnosticCode: string,
  claimKey?: ActionClaimKey,
): void {
  reported.delete(sourceAction);
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
  reported: WeakMap<object, string>,
  options: ExecutorActionTransactionRouterOptions,
  claim: ExecutionClaim,
  sourceAction: object,
  diagnosticCode: string,
): ActionTransactionRoute {
  return {
    disposition: "unserved",
    diagnosticCode,
    ...(options.onUnserved
      ? {
        onSettled: () => {
          reported.delete(sourceAction);
          options.onUnserved!(claim, sourceAction, diagnosticCode);
        },
      }
      : {}),
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

function safeActionClaimKey(
  observation: SchedulerActionObservation,
): ActionClaimKey | undefined {
  if (
    typeof observation.ownerSpace !== "string" ||
    observation.ownerSpace.length === 0 ||
    typeof observation.pieceId !== "string" ||
    observation.pieceId.length === 0 ||
    typeof observation.actionId !== "string" ||
    observation.actionId.length === 0 ||
    (observation.actionKind !== "computation" &&
      observation.actionKind !== "effect") ||
    typeof observation.implementationFingerprint !== "string" ||
    observation.implementationFingerprint.length === 0 ||
    typeof observation.runtimeFingerprint !== "string" ||
    observation.runtimeFingerprint.length === 0
  ) {
    return undefined;
  }
  return {
    branch: observation.branch,
    space: observation.ownerSpace,
    contextKey: "space",
    pieceId: observation.pieceId,
    actionId: observation.actionId,
    actionKind: observation.actionKind,
    implementationFingerprint: observation.implementationFingerprint,
    runtimeFingerprint: observation.runtimeFingerprint,
  };
}

function dynamicUnservableReason(
  input: ActionTransactionRouteInput,
  observation: SchedulerActionObservation,
  options: ExecutorActionTransactionRouterOptions,
): string | undefined {
  const commit = input.commit;
  if (input.space !== options.servedSpace) return "dynamic-foreign-space";
  if (observation.branch !== options.branch) return "dynamic-foreign-branch";
  if (observation.transactionKind !== "action-run") {
    return "dynamic-non-action-transaction";
  }
  if (commit.schedulerObservationBatch !== undefined) {
    return "dynamic-observation-batch";
  }
  if (commit.merge !== undefined) return "dynamic-branch-merge";
  for (const read of [...commit.reads.confirmed, ...commit.reads.pending]) {
    if ((read.scope ?? "space") !== "space") {
      return "dynamic-non-space-read-scope";
    }
    if (
      "branch" in read && read.branch !== undefined &&
      read.branch !== options.branch
    ) {
      return "dynamic-foreign-read-branch";
    }
  }
  for (const operation of commit.operations) {
    if (operation.op === "sqlite") return "dynamic-sqlite-operation";
    if ((operation.scope ?? "space") !== "space") {
      return "dynamic-non-space-write-scope";
    }
  }
  for (const precondition of commit.preconditions ?? []) {
    if (
      precondition.kind === "entity-absent" &&
      (precondition.scope ?? "space") !== "space"
    ) {
      return "dynamic-non-space-write-scope";
    }
  }

  const summary = observation.completeActionScopeSummary!;
  const readEnvelopes = summary.reads;
  const writeEnvelopes = [
    ...summary.writes,
    ...summary.materializerWriteEnvelopes,
    ...summary.directOutputs,
  ];
  for (const address of [...observation.reads, ...observation.shallowReads]) {
    const reason = addressReason(address, options.servedSpace, "read");
    if (reason !== undefined) return reason;
    if (!readEnvelopes.some((envelope) => covers(envelope, address))) {
      return "dynamic-read-outside-static-surface";
    }
  }
  for (
    const address of [
      ...observation.actualChangedWrites,
      ...observation.currentKnownWrites,
      ...(observation.declaredWrites ?? []),
      ...observation.materializerWriteEnvelopes,
      ...(observation.ignoredSchedulingWrites ?? []),
    ]
  ) {
    const reason = addressReason(address, options.servedSpace, "write");
    if (reason !== undefined) return reason;
    if (!writeEnvelopes.some((envelope) => covers(envelope, address))) {
      return "dynamic-write-outside-static-surface";
    }
  }
  for (const operation of commit.operations) {
    if (operation.op === "sqlite") continue;
    if (
      !writeEnvelopes.some((envelope) =>
        envelope.id === operation.id && scopeOf(envelope) === scopeOf(operation)
      )
    ) {
      return "dynamic-write-outside-static-surface";
    }
  }
  return undefined;
}

function addressReason(
  address: IMemorySpaceAddress,
  servedSpace: MemorySpace,
  kind: "read" | "write",
): string | undefined {
  if (address.space !== servedSpace) return `dynamic-foreign-${kind}-space`;
  if (scopeOf(address) !== "space") {
    return `dynamic-non-space-${kind}-scope`;
  }
  return undefined;
}

function covers(
  envelope: IMemorySpaceAddress,
  address: IMemorySpaceAddress,
): boolean {
  return envelope.space === address.space && envelope.id === address.id &&
    scopeOf(envelope) === scopeOf(address) &&
    envelope.path.length <= address.path.length &&
    envelope.path.every((segment, index) => segment === address.path[index]);
}

function scopeOf(value: { scope?: CellScope }): CellScope {
  return value.scope ?? "space";
}

function claimMatchesKey(
  claim: ExecutionClaim,
  key: ActionClaimKey,
): boolean {
  return claim.branch === key.branch && claim.space === key.space &&
    claim.contextKey === key.contextKey && claim.pieceId === key.pieceId &&
    claim.actionId === key.actionId && claim.actionKind === key.actionKind &&
    claim.implementationFingerprint === key.implementationFingerprint &&
    claim.runtimeFingerprint === key.runtimeFingerprint;
}
