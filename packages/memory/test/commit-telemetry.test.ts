import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import type {
  ClientCommit,
  Operation,
  SchedulerActionObservation,
} from "../v2.ts";
import { classifyCommitTelemetry } from "../v2/commit-telemetry.ts";

const commit = (
  operations: Operation[] = [],
  extra: Partial<ClientCommit> = {},
): ClientCommit => ({
  localSeq: 1,
  reads: { confirmed: [], pending: [] },
  operations,
  ...extra,
});

const semanticOperation: Operation = {
  op: "set",
  id: "of:telemetry-test",
  value: { value: "hello" },
};

const sqliteOperation: Operation = {
  op: "sqlite",
  db: { id: "of:telemetry-db" },
  sql: "CREATE TABLE example (value TEXT)",
};

const schedulerObservation: SchedulerActionObservation = {
  version: 1,
  branch: "",
  pieceId: "of:telemetry-piece",
  processGeneration: 0,
  actionId: "telemetry-action",
  actionKind: "computation",
  implementationFingerprint: "impl:telemetry",
  runtimeFingerprint: "runtime:telemetry",
  observedAtSeq: 0,
  transactionKind: "action-run",
  reads: [],
  shallowReads: [],
  actualChangedWrites: [],
  currentKnownWrites: [],
  materializerWriteEnvelopes: [],
  status: "success",
};

describe("commit-telemetry", () => {
  it("returns `semantic` for non-SQLite entity operations", () => {
    expect(classifyCommitTelemetry(commit([semanticOperation]))).toEqual({
      kind: "semantic",
      entityCount: 1,
      schedulerObservationCount: 0,
      sqliteOperationCount: 0,
    });
  });

  it("returns `scheduler_observation` for scheduler-only requests", () => {
    expect(
      classifyCommitTelemetry(commit([], { schedulerObservation })),
    ).toEqual({
      kind: "scheduler_observation",
      entityCount: 0,
      schedulerObservationCount: 1,
      sqliteOperationCount: 0,
    });

    expect(classifyCommitTelemetry(commit([], {
      schedulerObservationBatch: [{
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        schedulerObservation,
      }, {
        localSeq: 3,
        reads: { confirmed: [], pending: [] },
        schedulerObservation,
      }],
    }))).toEqual({
      kind: "scheduler_observation",
      entityCount: 0,
      schedulerObservationCount: 2,
      sqliteOperationCount: 0,
    });
  });

  it("returns `sqlite` for SQLite-only requests", () => {
    expect(classifyCommitTelemetry(commit([sqliteOperation]))).toEqual({
      kind: "sqlite",
      entityCount: 0,
      schedulerObservationCount: 0,
      sqliteOperationCount: 1,
    });
  });

  it("returns `mixed` when several operation classes are present", () => {
    expect(classifyCommitTelemetry(
      commit([semanticOperation, sqliteOperation], {
        schedulerObservation,
      }),
    )).toEqual({
      kind: "mixed",
      entityCount: 1,
      schedulerObservationCount: 1,
      sqliteOperationCount: 1,
    });

    expect(classifyCommitTelemetry(
      commit([sqliteOperation], { schedulerObservation }),
    )).toEqual({
      kind: "mixed",
      entityCount: 0,
      schedulerObservationCount: 1,
      sqliteOperationCount: 1,
    });
  });

  it("returns `precondition` for precondition-only requests", () => {
    expect(classifyCommitTelemetry(commit([], {
      preconditions: [{ kind: "entity-absent", id: "of:missing" }],
    }))).toEqual({
      kind: "precondition",
      entityCount: 0,
      schedulerObservationCount: 0,
      sqliteOperationCount: 0,
    });
  });

  it("uses preconditions only as a fallback category", () => {
    expect(classifyCommitTelemetry(commit([semanticOperation], {
      preconditions: [{ kind: "entity-absent", id: "of:missing" }],
    }))).toEqual({
      kind: "semantic",
      entityCount: 1,
      schedulerObservationCount: 0,
      sqliteOperationCount: 0,
    });
  });

  it("returns `empty` for requests without classifiable content", () => {
    expect(classifyCommitTelemetry(commit())).toEqual({
      kind: "empty",
      entityCount: 0,
      schedulerObservationCount: 0,
      sqliteOperationCount: 0,
    });
  });
});
