import {
  type ActionClaimKey,
  actionClaimMapKey,
  type ExecutionClaim,
  executionClaimIncarnationKey,
} from "@commonfabric/memory/v2";
import { toCompactDebugString } from "@commonfabric/data-model/value-debug";
import type { ExecutionRoutingDiagnostics } from "@commonfabric/runner/shared";

export interface RolloutActionTraceEntry {
  readonly actionId: string;
  readonly actualWrites: readonly { readonly entityId: string }[];
}

export interface DiscoveredRolloutAction {
  readonly key: ActionClaimKey;
  readonly claim: ExecutionClaim;
}

/**
 * Select the one computation that both wrote during the actor trace and is
 * claimed in the already piece-scoped routing snapshot. Neither creation
 * provenance nor a guessed result-cell id is used as producer identity.
 */
export function discoverScopedWritingAction(
  trace: readonly RolloutActionTraceEntry[],
  diagnostics: ExecutionRoutingDiagnostics,
  resultEntityId: string,
): DiscoveredRolloutAction {
  if (diagnostics.snapshotRequired) {
    throw new Error("cannot discover an action from a gapped routing snapshot");
  }
  const writingActionIds = new Set(
    trace.filter((entry) =>
      entry.actualWrites.some((write) => write.entityId === resultEntityId)
    ).map((entry) => entry.actionId),
  );
  const matchingClaims = diagnostics.claims.filter((candidate) =>
    writingActionIds.has(candidate.actionId)
  );
  const matchingClaimKeys = new Set(matchingClaims.map(actionClaimMapKey));
  const matchingActions = diagnostics.actions.filter((candidate) =>
    matchingClaimKeys.has(actionClaimMapKey(candidate.key))
  );
  if (matchingClaims.length !== 1 || matchingActions.length !== 1) {
    throw new Error(
      "expected exactly one actor writing action intersecting scoped claims, " +
        `found ${matchingClaims.length} claims and ${matchingActions.length} actions`,
    );
  }
  const claim = matchingClaims[0];
  const action = matchingActions[0];
  if (actionClaimMapKey(action.key) !== actionClaimMapKey(claim)) {
    throw new Error("the discovered claim and routing action keys differ");
  }
  return { key: action.key, claim };
}

export interface ExactRoutingPhaseExpectation {
  readonly key: ActionClaimKey;
  readonly authoritative: boolean;
  readonly events: number;
}

const addMismatch = (
  issues: string[],
  label: string,
  actual: unknown,
  expected: unknown,
): void => {
  if (!Object.is(actual, expected)) {
    issues.push(
      `${label} was ${JSON.stringify(actual)}, expected ${
        JSON.stringify(expected)
      }`,
    );
  }
};

/**
 * Prove that event 1 produced a successful settlement after the preflight's
 * raw counter reset, under the claim incarnation that is still live now.
 */
export function authoritativePreflightSettlementIssues(
  diagnostics: ExecutionRoutingDiagnostics,
  key: ActionClaimKey,
): string[] {
  const issues: string[] = [];
  addMismatch(issues, "space", diagnostics.space, key.space);
  addMismatch(issues, "branch", diagnostics.branch, key.branch);
  addMismatch(issues, "snapshotRequired", diagnostics.snapshotRequired, false);
  addMismatch(
    issues,
    "truncatedActionRecords",
    diagnostics.truncatedActionRecords,
    0,
  );
  addMismatch(issues, "actions.length", diagnostics.actions.length, 1);
  addMismatch(issues, "claims.length", diagnostics.claims.length, 1);

  const expectedKey = actionClaimMapKey(key);
  const action = diagnostics.actions.find((candidate) =>
    actionClaimMapKey(candidate.key) === expectedKey
  );
  if (!action) {
    issues.push("exact action diagnostics were absent");
    return issues;
  }
  const exactClaim = diagnostics.claims.find((candidate) =>
    actionClaimMapKey(candidate) === expectedKey
  );
  if (!exactClaim) issues.push("exact live claim was absent from claims");
  if (!action.liveClaim) issues.push("exact action liveClaim was absent");
  if (
    exactClaim && action.liveClaim &&
    executionClaimIncarnationKey(exactClaim) !==
      executionClaimIncarnationKey(action.liveClaim)
  ) {
    issues.push("liveClaim incarnation differed from claims");
  }

  addMismatch(issues, "pendingOverlayCount", action.pendingOverlayCount, 0);
  addMismatch(
    issues,
    "unresolvedBasisOverlayCount",
    action.unresolvedBasisOverlayCount,
    0,
  );
  addMismatch(
    issues,
    "pendingSettlementCount",
    action.pendingSettlementCount,
    0,
  );
  addMismatch(
    issues,
    "nonAuthoritativeOverlayDrops",
    action.nonAuthoritativeOverlayDrops,
    0,
  );
  addMismatch(issues, "settlements.failed", action.settlements.failed, 0);
  addMismatch(issues, "settlements.unserved", action.settlements.unserved, 0);
  if (action.settlements.committed + action.settlements.noOp < 1) {
    issues.push("post-reset committed/no-op settlement was absent");
  }

  const lastSettlement = action.lastSettlement;
  if (!lastSettlement) {
    issues.push("last settlement was absent");
  } else {
    if (
      lastSettlement.outcome !== "committed" &&
      lastSettlement.outcome !== "no-op"
    ) {
      issues.push(`last settlement outcome was ${lastSettlement.outcome}`);
    }
    if (
      action.liveClaim &&
      executionClaimIncarnationKey(lastSettlement.claim) !==
        executionClaimIncarnationKey(action.liveClaim)
    ) {
      issues.push("last settlement claim incarnation was not current");
    }
    if (
      lastSettlement.acceptedCommitSeq !== undefined &&
      diagnostics.executionAppliedSeq < lastSettlement.acceptedCommitSeq
    ) {
      issues.push(
        `executionAppliedSeq was ${diagnostics.executionAppliedSeq}, below last acceptedCommitSeq ${lastSettlement.acceptedCommitSeq}`,
      );
    }
  }
  return issues;
}

export function assertAuthoritativePreflightSettlement(
  diagnostics: ExecutionRoutingDiagnostics,
  key: ActionClaimKey,
): void {
  const issues = authoritativePreflightSettlementIssues(diagnostics, key);
  if (issues.length > 0) {
    throw new Error(
      `authoritative preflight did not establish current authority: ${
        issues.join("; ")
      }. Snapshot: ${toCompactDebugString(diagnostics)}`,
    );
  }
}

/** Return every reason an exact-action routing snapshot is not authoritative. */
export function exactRoutingPhaseIssues(
  diagnostics: ExecutionRoutingDiagnostics,
  expectation: ExactRoutingPhaseExpectation,
): string[] {
  const { key, authoritative, events } = expectation;
  const issues: string[] = [];
  addMismatch(issues, "space", diagnostics.space, key.space);
  addMismatch(issues, "branch", diagnostics.branch, key.branch);
  addMismatch(issues, "snapshotRequired", diagnostics.snapshotRequired, false);
  addMismatch(
    issues,
    "truncatedActionRecords",
    diagnostics.truncatedActionRecords,
    0,
  );
  addMismatch(issues, "actions.length", diagnostics.actions.length, 1);

  const expectedKey = actionClaimMapKey(key);
  const action = diagnostics.actions.find((candidate) =>
    actionClaimMapKey(candidate.key) === expectedKey
  );
  if (!action) {
    issues.push("exact action diagnostics were absent");
    return issues;
  }
  if (diagnostics.actions.length === 1) {
    addMismatch(
      issues,
      "actions[0].key",
      actionClaimMapKey(diagnostics.actions[0].key),
      expectedKey,
    );
  }

  addMismatch(issues, "pendingOverlayCount", action.pendingOverlayCount, 0);
  addMismatch(
    issues,
    "unresolvedBasisOverlayCount",
    action.unresolvedBasisOverlayCount,
    0,
  );
  addMismatch(
    issues,
    "pendingSettlementCount",
    action.pendingSettlementCount,
    0,
  );
  addMismatch(
    issues,
    "nonAuthoritativeOverlayDrops",
    action.nonAuthoritativeOverlayDrops,
    0,
  );
  addMismatch(issues, "settlements.failed", action.settlements.failed, 0);
  addMismatch(issues, "settlements.unserved", action.settlements.unserved, 0);
  if (
    action.lastSettlement?.acceptedCommitSeq !== undefined &&
    diagnostics.executionAppliedSeq < action.lastSettlement.acceptedCommitSeq
  ) {
    issues.push(
      `executionAppliedSeq was ${diagnostics.executionAppliedSeq}, below last acceptedCommitSeq ${action.lastSettlement.acceptedCommitSeq}`,
    );
  }

  if (authoritative) {
    addMismatch(issues, "claims.length", diagnostics.claims.length, 1);
    const exactClaim = diagnostics.claims.find((candidate) =>
      actionClaimMapKey(candidate) === expectedKey
    );
    if (!exactClaim) issues.push("exact live claim was absent from claims");
    if (!action.liveClaim) issues.push("exact action liveClaim was absent");
    if (
      action.liveClaim &&
      actionClaimMapKey(action.liveClaim) !== expectedKey
    ) {
      issues.push("exact action liveClaim key differed from the action key");
    }
    if (action.liveClaim && exactClaim) {
      addMismatch(
        issues,
        "liveClaim.leaseGeneration vs claims",
        action.liveClaim.leaseGeneration,
        exactClaim.leaseGeneration,
      );
      addMismatch(
        issues,
        "liveClaim.claimGeneration vs claims",
        action.liveClaim.claimGeneration,
        exactClaim.claimGeneration,
      );
    }
    addMismatch(issues, "upstreamRoutes", action.upstreamRoutes, 0);
    addMismatch(
      issues,
      "claimedOverlayRoutes",
      action.claimedOverlayRoutes,
      events,
    );
    const successfulSettlements = action.settlements.committed +
      action.settlements.noOp;
    // Accepted source commits can arrive before the worker's next pull. One
    // scheduler run may therefore settle every overlay whose basis it covers.
    if (events === 0) {
      addMismatch(
        issues,
        "settlements.committed + settlements.noOp",
        successfulSettlements,
        0,
      );
    } else if (successfulSettlements < 1 || successfulSettlements > events) {
      issues.push(
        "settlements.committed + settlements.noOp was " +
          `${successfulSettlements}, expected between 1 and ${events}`,
      );
    }
    addMismatch(
      issues,
      "basisCoveredOverlayDrops",
      action.basisCoveredOverlayDrops,
      events,
    );
  } else {
    addMismatch(issues, "claims.length", diagnostics.claims.length, 0);
    addMismatch(issues, "liveClaim", action.liveClaim, undefined);
    addMismatch(issues, "lastSettlement", action.lastSettlement, undefined);
    addMismatch(issues, "upstreamRoutes", action.upstreamRoutes, events);
    addMismatch(issues, "claimedOverlayRoutes", action.claimedOverlayRoutes, 0);
    addMismatch(
      issues,
      "settlements.committed",
      action.settlements.committed,
      0,
    );
    addMismatch(issues, "settlements.noOp", action.settlements.noOp, 0);
    addMismatch(
      issues,
      "basisCoveredOverlayDrops",
      action.basisCoveredOverlayDrops,
      0,
    );
  }
  return issues;
}

export function assertExactRoutingPhase(
  diagnostics: ExecutionRoutingDiagnostics,
  expectation: ExactRoutingPhaseExpectation,
): void {
  const issues = exactRoutingPhaseIssues(diagnostics, expectation);
  if (issues.length > 0) {
    throw new Error(
      `exact routing phase was not authoritative: ${issues.join("; ")}. ` +
        `Snapshot: ${toCompactDebugString(diagnostics)}`,
    );
  }
}
