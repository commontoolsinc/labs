import type { ExecutionPoolMetricsSnapshot } from "@commonfabric/runner/executor";

export type ServerExecutionPoolMetricsProvider = () =>
  | ExecutionPoolMetricsSnapshot
  | null;
export type ServerExecutionControlMetrics = Readonly<{
  policyInactiveClaimAttempts: number;
  claimsIssued: number;
  claimsReissued: number;
  claimsRevoked: number;
  acceptedActionAttempts: number;
  claimedActionConflicts: number;
  settlementsPublished: number;
  settlementsCommitted: number;
  settlementsNoOp: number;
  settlementsFailed: number;
  settlementsUnserved: number;
  leaseFenceRejects: number;
  actionFirewallRejects: number;
}>;
export type ServerExecutionControlMetricsProvider = () =>
  | ServerExecutionControlMetrics
  | null;

let metricsProvider: ServerExecutionPoolMetricsProvider = () => null;
let controlMetricsProvider: ServerExecutionControlMetricsProvider = () => null;

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
