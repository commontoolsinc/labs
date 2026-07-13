import type { ExecutionPoolMetricsSnapshot } from "@commonfabric/runner/executor";

export type ServerExecutionPoolMetricsProvider = () =>
  | ExecutionPoolMetricsSnapshot
  | null;

let metricsProvider: ServerExecutionPoolMetricsProvider = () => null;

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
