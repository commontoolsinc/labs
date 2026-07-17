import type { ExecutionPoolMetricsSnapshot } from "@commonfabric/runner/executor";

export type ServerExecutionPoolMetricsProvider = () =>
  | ExecutionPoolMetricsSnapshot
  | null;
export type ServerExecutionControlMetrics = Readonly<{
  claimsIssued: number;
  claimsReissued: number;
  claimsRevoked: number;
  claimsIssuedByContextKey: Readonly<Record<string, number>>;
  acceptedActionAttempts: number;
  claimedActionConflicts: number;
  settlementsPublished: number;
  settlementsCommitted: number;
  settlementsNoOp: number;
  settlementsFailed: number;
  settlementsUnserved: number;
  leaseFenceRejects: number;
  leaseFenceRejectCauses: Readonly<Record<string, number>>;
  actionFirewallRejects: number;
  acceptedCommitIndexLookups: number;
  acceptedCommitIndexTargetCandidates: number;
  acceptedCommitIndexDemandedPieces: number;
  acceptedCommitIndexMatches: number;
  candidateClaimReadyBySpace: Readonly<Record<string, number>>;
  candidateUnservedBySpace: Readonly<Record<string, number>>;
  candidateUnservedByCode: Readonly<Record<string, number>>;
  candidateUnservedOffendersByCode: Readonly<Record<string, number>>;
}>;
export type ServerExecutionControlMetricsProvider = () =>
  | ServerExecutionControlMetrics
  | null;

/** Traversal work summed per memory-server operation (F1 feed
 * observability): one bucket per operation string, e.g.
 * "session.watch.refresh" and the executor-driven "graph.query". */
export type ServerExecutionFeedTraversalMetrics = Readonly<{
  calls: number;
  managerReads: number;
  coveredSelectorSkips: number;
  schemaTraversals: number;
  pointerTraversals: number;
  arrayTraversals: number;
  objectTraversals: number;
  dagTraversals: number;
  getDocAtPathCalls: number;
  schemaMemoHits: number;
}>;
export type ServerExecutionFeedMetrics = Readonly<{
  refreshWaves: number;
  refreshSessionsTouched: number;
  refreshGraphsRefreshed: number;
  refreshUpsertsPushed: number;
  /** F3 doc-set membership point-read deliveries (zero traversal). */
  docSetMemberDeliveries: number;
  /** F3 live doc-set member-set size gauge (FA8). */
  docSetMembersTracked: number;
  /** F5/FA13: touched sessions the per-space eligibility dial admitted to
   * graph-refresh retirement on a wave. */
  refreshRetirementEligibleSessions: number;
  /** F5/FA13: eligible sessions whose entire watch surface was doc-set (the
   * graph refresh was skipped). */
  refreshFullyDocSetSessions: number;
  /** F5/FA13: residual schema-graph watches still traversed on eligible
   * sessions — the regression signal the OQ4 gate watches (fully-retired
   * space holds this at 0). */
  refreshResidualGraphWatches: number;
  traversalByOperation: Readonly<
    Record<string, ServerExecutionFeedTraversalMetrics>
  >;
}>;
export type ServerExecutionFeedMetricsProvider = () =>
  | ServerExecutionFeedMetrics
  | null;

let metricsProvider: ServerExecutionPoolMetricsProvider = () => null;
let controlMetricsProvider: ServerExecutionControlMetricsProvider = () => null;
let feedMetricsProvider: ServerExecutionFeedMetricsProvider = () => null;

/**
 * Install the process-local pool snapshot provider without making the health
 * route import and initialize the memory server module as a side effect.
 */
export function setServerExecutionPoolMetricsProvider(
  provider: ServerExecutionPoolMetricsProvider,
): void {
  metricsProvider = provider;
}

export function getServerExecutionPoolMetrics():
  | ExecutionPoolMetricsSnapshot
  | null {
  return metricsProvider();
}

export function setServerExecutionControlMetricsProvider(
  provider: ServerExecutionControlMetricsProvider,
): void {
  controlMetricsProvider = provider;
}

export function getServerExecutionControlMetrics():
  | ServerExecutionControlMetrics
  | null {
  return controlMetricsProvider();
}

export function setServerExecutionFeedMetricsProvider(
  provider: ServerExecutionFeedMetricsProvider,
): void {
  feedMetricsProvider = provider;
}

export function getServerExecutionFeedMetrics():
  | ServerExecutionFeedMetrics
  | null {
  return feedMetricsProvider();
}
