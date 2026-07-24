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
  /** C3.3b: observation mirrors withheld at the acting-principal READ
   * gate (the denial's only footprint). */
  crossSpaceMirrorsWithheld: number;
  /** C3.5 (C3A13): Worker-asserted foreign read stamps dropped at host
   * validation — no matching served point-read record (the strip's only
   * footprint). */
  foreignBasisAssertionsStripped: number;
  /** C3.5: host-validated foreign basis components handed to the engine. */
  foreignBasisComponentsValidated: number;
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
  /** F5/FA13: touched sessions holding a dial-admitted doc-set surface on a
   * wave. */
  refreshRetirementEligibleSessions: number;
  /** F5/FA13: eligible sessions whose entire watch surface was doc-set (no
   * graph refresh had anything to traverse). */
  refreshFullyDocSetSessions: number;
  /** F5/FA3: residual schema-graph watches HELD on eligible sessions this
   * wave, per watch (surface composition — a fully-demoted space holds this
   * at 0). */
  refreshResidualGraphWatches: number;
  /** F5/FB28: residual graph watches whose branch group actually re-traversed
   * — the traversal regression signal the OQ4 gate watches. */
  refreshResidualGraphWatchesTraversed: number;
  /** F5/FB11: residual graph-refresh DAG traversals per space — the
   * mixed-mode residual-traversal budget numerator of the F5 protocol. */
  refreshResidualDagTraversalsBySpace: Readonly<Record<string, number>>;
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
