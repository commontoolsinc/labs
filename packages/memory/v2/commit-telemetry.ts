import type { ClientCommit } from "../v2.ts";

/** Stable categories used to separate memory transaction traffic in telemetry. */
export type CommitTelemetryKind =
  | "semantic"
  | "scheduler_observation"
  | "sqlite"
  | "mixed"
  | "precondition"
  | "empty";

export interface CommitTelemetryClassification {
  kind: CommitTelemetryKind;
  entityCount: number;
  schedulerObservationCount: number;
  sqliteOperationCount: number;
}

/**
 * Classify the requested commit without changing validation or persistence.
 *
 * This deliberately describes the wire request, so rejected/conflicting
 * attempts carry the same dimensions as successful attempts. `entityCount`
 * retains the existing meaning: non-SQLite entity operations.
 */
export const classifyCommitTelemetry = (
  commit: ClientCommit,
): CommitTelemetryClassification => {
  const entityCount =
    commit.operations.filter((operation) => operation.op !== "sqlite").length;
  const sqliteOperationCount = commit.operations.length - entityCount;
  const schedulerObservationCount =
    (commit.schedulerObservation === undefined ? 0 : 1) +
    (commit.schedulerObservationBatch?.length ?? 0);
  const componentCount = Number(entityCount > 0) +
    Number(sqliteOperationCount > 0) +
    Number(schedulerObservationCount > 0);

  const kind: CommitTelemetryKind = componentCount > 1
    ? "mixed"
    : entityCount > 0
    ? "semantic"
    : schedulerObservationCount > 0
    ? "scheduler_observation"
    : sqliteOperationCount > 0
    ? "sqlite"
    : (commit.preconditions?.length ?? 0) > 0
    ? "precondition"
    : "empty";

  return {
    kind,
    entityCount,
    schedulerObservationCount,
    sqliteOperationCount,
  };
};
