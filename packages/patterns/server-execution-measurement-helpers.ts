import type {
  ExecutionRoutingActionDiagnostics,
  ExecutionRoutingDiagnostics,
} from "@commonfabric/runner/shared";

const routingActionIsPending = (
  action: ExecutionRoutingActionDiagnostics,
): boolean =>
  action.pendingOverlayCount !== 0 ||
  action.unresolvedBasisOverlayCount !== 0 ||
  action.pendingSettlementCount !== 0;

const routingSnapshotIsComplete = (
  diagnostics: ExecutionRoutingDiagnostics,
): boolean => !diagnostics.snapshotRequired;

/** The benchmark counter reset is valid only after boot-era overlays and
 * settlements have drained. Resetting counters does not discard those live
 * objects, so sampling earlier would attribute boot work to the interaction. */
export function isRoutingMeasurementBaselineReady(
  diagnostics: ExecutionRoutingDiagnostics,
): boolean {
  return routingSnapshotIsComplete(diagnostics) &&
    diagnostics.claims.length > 0 &&
    diagnostics.actions.every((action) => !routingActionIsPending(action));
}

/** A broad workload may deliberately fall back for an unsupported action.
 * Completion therefore means that at least one claimed overlay and successful
 * server settlement were observed and that every route has reached a terminal
 * state; fallback outcomes are reported separately instead of blocking the
 * barrier forever. */
export function isRoutingMeasurementResultReady(
  diagnostics: ExecutionRoutingDiagnostics,
): boolean {
  if (!routingSnapshotIsComplete(diagnostics)) return false;
  if (diagnostics.actions.some(routingActionIsPending)) return false;
  return diagnostics.branchTotals.claimedOverlayRoutes > 0 &&
    diagnostics.branchTotals.settlements.committed +
          diagnostics.branchTotals.settlements.noOp > 0;
}

export type RoutingMeasurementProblemAction = Readonly<{
  actionId: string;
  pieceId: string;
  liveClaim: boolean;
  claimedOverlayRoutes: number;
  settlements: ExecutionRoutingActionDiagnostics["settlements"];
  basisCoveredOverlayDrops: number;
  nonAuthoritativeOverlayDrops: number;
  pendingOverlayCount: number;
  unresolvedBasisOverlayCount: number;
  pendingSettlementCount: number;
  lastSettlement?: Readonly<{
    outcome: NonNullable<
      ExecutionRoutingActionDiagnostics["lastSettlement"]
    >["outcome"];
    diagnosticCode?: string;
  }>;
}>;

/** Return a bounded, identity-bearing explanation of every action that did
 * not cleanly finish through the authoritative server path. */
export function routingMeasurementProblemActions(
  diagnostics: ExecutionRoutingDiagnostics,
  limit = 20,
): readonly RoutingMeasurementProblemAction[] {
  return diagnostics.actions.filter((action) =>
    routingActionIsPending(action) ||
    action.settlements.failed !== 0 ||
    action.settlements.unserved !== 0 ||
    action.nonAuthoritativeOverlayDrops !== 0 ||
    action.basisCoveredOverlayDrops < action.claimedOverlayRoutes
  ).slice(0, Math.max(0, limit)).map((action) => ({
    actionId: action.key.actionId,
    pieceId: action.key.pieceId,
    liveClaim: action.liveClaim !== undefined,
    claimedOverlayRoutes: action.claimedOverlayRoutes,
    settlements: action.settlements,
    basisCoveredOverlayDrops: action.basisCoveredOverlayDrops,
    nonAuthoritativeOverlayDrops: action.nonAuthoritativeOverlayDrops,
    pendingOverlayCount: action.pendingOverlayCount,
    unresolvedBasisOverlayCount: action.unresolvedBasisOverlayCount,
    pendingSettlementCount: action.pendingSettlementCount,
    ...(action.lastSettlement === undefined ? {} : {
      lastSettlement: {
        outcome: action.lastSettlement.outcome,
        ...(action.lastSettlement.diagnosticCode === undefined
          ? {}
          : { diagnosticCode: action.lastSettlement.diagnosticCode }),
      },
    }),
  }));
}
